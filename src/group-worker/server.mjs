import { createServer } from 'node:http';
import { verifyCommand, signResult } from '../channels/groups/contracts.mjs';
import { readBounded, verifyTransport } from '../channels/groups/transport.mjs';
import { abortable, settleWithin } from './cancellation.mjs';
import { SELECTOR_VERSION } from './observer.mjs';

export function createGroupWorkerServer({keys,keyId,key,allowedGroups,scan,reply,reconcile,recoveryGate=null,sessionHealth=null,stagingSendEnabled=false,stagingAllowedGroups=[],commandTimeoutMs=30000,cleanupTimeoutMs=600}) {
  const allowed=new Set(allowedGroups),sendAllowed=new Set(stagingAllowedGroups);
  const server=createServer(async(req,res)=>{
    const controller=new AbortController();let timer;
    const disconnect=()=>{if(!res.writableEnded)controller.abort(new Error('Client disconnected'));};
    res.once('close',disconnect);
    try {
      if(req.method==='GET'&&req.url==='/health') {
        const recovery=recoveryGate?.status?.()??{state:'available'};
        const raw=sessionHealth?.(),allowedState=new Set(['healthy','busy','quarantined']);
        const session=raw?{state:allowedState.has(raw.state)?raw.state:'unavailable'}:undefined;
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,recovery,...(session?{session}:{})}));return;
      }
      if(req.method==='POST'&&['/recovery/start','/recovery/stop'].includes(req.url)) {
        if(!recoveryGate){res.writeHead(404).end();return;}
        const raw=await readBounded(req);
        try {verifyTransport(raw,req.headers,{keys});} catch {res.writeHead(401).end('Untrusted recovery request');return;}
        let input;
        try {input=JSON.parse(raw.toString('utf8'));} catch {res.writeHead(422).end('Invalid recovery request');return;}
        const exactKeys=req.url.endsWith('/start')?['groupId','sourceId','ttlSeconds']:['sourceId'];
        if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).sort().join(',')!==exactKeys.sort().join(',')) {res.writeHead(422).end('Invalid recovery request');return;}
        try {
          let result;
          if(req.url.endsWith('/start')) {
            if(!allowed.has(input.groupId)||!Number.isSafeInteger(input.ttlSeconds)||input.ttlSeconds<30||input.ttlSeconds>600)throw Object.assign(new Error(),{status:403});
            result=recoveryGate.start({sourceId:input.sourceId,groupId:input.groupId,ttlMs:input.ttlSeconds*1000});
          } else result=recoveryGate.stop({sourceId:input.sourceId});
          res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
        } catch(error) {res.writeHead(error.status??422).end('Recovery request refused');}
        return;
      }
      if(req.method!=='POST'||req.url!=='/commands') { res.writeHead(404).end(); return; }
      const raw=await readBounded(req);
      let command;
      try { verifyTransport(raw,req.headers,{keys}); command=verifyCommand(raw.toString('utf8'),{keys}); }
      catch { res.writeHead(401).end('Untrusted command'); return; }
      if(!allowed.has(command.groupId)||!{ScanCommand:scan,GroupReplyCommand:reply,ReconcileCommand:reconcile}[command.kind]) { res.writeHead(403).end('Command refused'); return; }
      if(recoveryGate&&!recoveryGate.permitsAutomation()) {res.writeHead(423).end('Recovery active');return;}
      if(command.kind==='GroupReplyCommand'&&(!stagingSendEnabled||!sendAllowed.has(command.groupId))) {res.writeHead(403).end('Staging send disabled');return;}
      let timedOut=false;
      timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('Command deadline exceeded'));},Math.max(0,Math.min(commandTimeoutMs,Date.parse(command.expiresAt)-Date.now())));
      const handler={ScanCommand:scan,GroupReplyCommand:reply,ReconcileCommand:reconcile}[command.kind];
      const pending=Promise.resolve().then(()=>handler(command,{signal:controller.signal}));
      let batch;
      try {batch=await abortable(()=>pending,controller.signal);}
      catch(error) {
        if(!controller.signal.aborted)throw error;
        await settleWithin(pending,cleanupTimeoutMs);
        if(!timedOut||res.destroyed)return;
        if(command.kind!=='ScanCommand')throw error;
        batch={selectorVersion:SELECTOR_VERSION,coverage:'none',health:'failed',reason:'scan_timeout',cursor:null,observations:[]};
      }
      if(res.destroyed)return;
      const now=new Date();
      const common={version:1,operationId:command.operationId,sourceId:command.sourceId,groupId:command.groupId,canonicalTarget:command.canonicalTarget,issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),keyId};
      let body;
      if(command.kind==='ScanCommand') body={...common,...batch,kind:'ScanResult'};
      else body={...common,kind:command.kind==='GroupReplyCommand'?'GroupReplyResult':'ReconcileResult',targetId:command.targetId,textHash:command.textHash,
        ...(command.kind==='ReconcileCommand'?{attemptOperationId:command.attemptOperationId}:{}),senderId:batch.senderId,attemptStartedAt:batch.attemptStartedAt,attemptFinishedAt:batch.attemptFinishedAt,evidenceHash:batch.evidenceHash,remoteId:batch.remoteId,state:batch.state};
      const result=signResult(body,{key,keyId});
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    } catch(error) { if(!res.destroyed) {if(!res.headersSent) res.writeHead(error.status===413?413:503).end('Worker unavailable'); else res.end();} }
    finally {clearTimeout(timer);res.removeListener('close',disconnect);}
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  return server;
}
