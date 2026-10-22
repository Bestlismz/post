import { createServer } from 'node:http';
import { verifyCommand, signResult } from '../channels/groups/contracts.mjs';
import { readBounded, verifyTransport } from '../channels/groups/transport.mjs';
import { abortable, settleWithin } from './cancellation.mjs';
import { SELECTOR_VERSION } from './observer.mjs';

export function createGroupWorkerServer({keys,keyId,key,allowedGroups,scan,reply,reconcile,commandTimeoutMs=30000,cleanupTimeoutMs=600}) {
  const allowed=new Set(allowedGroups);
  const server=createServer(async(req,res)=>{
    const controller=new AbortController();let timer;
    const disconnect=()=>{if(!res.writableEnded)controller.abort(new Error('Client disconnected'));};
    res.once('close',disconnect);
    try {
      if(req.method!=='POST'||req.url!=='/commands') { res.writeHead(404).end(); return; }
      const raw=await readBounded(req);
      let command;
      try { verifyTransport(raw,req.headers,{keys}); command=verifyCommand(raw.toString('utf8'),{keys}); }
      catch { res.writeHead(401).end('Untrusted command'); return; }
      if(!allowed.has(command.groupId)||!{ScanCommand:scan,GroupReplyCommand:reply,ReconcileCommand:reconcile}[command.kind]) { res.writeHead(403).end('Command refused'); return; }
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
        senderId:batch.senderId,attemptStartedAt:batch.attemptStartedAt,attemptFinishedAt:batch.attemptFinishedAt,evidenceHash:batch.evidenceHash,remoteId:batch.remoteId,state:batch.state};
      const result=signResult(body,{key,keyId});
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    } catch(error) { if(!res.destroyed) {if(!res.headersSent) res.writeHead(error.status===413?413:503).end('Worker unavailable'); else res.end();} }
    finally {clearTimeout(timer);res.removeListener('close',disconnect);}
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  return server;
}
