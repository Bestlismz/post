import { createServer } from 'node:http';
import { verifyCommand, signResult } from '../channels/groups/contracts.mjs';
import { readBounded, verifyTransport } from '../channels/groups/transport.mjs';

export function createGroupWorkerServer({keys,keyId,key,allowedGroups,scan}) {
  const allowed=new Set(allowedGroups);
  const server=createServer(async(req,res)=>{
    try {
      if(req.method!=='POST'||req.url!=='/commands') { res.writeHead(404).end(); return; }
      const raw=await readBounded(req);
      let command;
      try { verifyTransport(raw,req.headers,{keys}); command=verifyCommand(raw.toString('utf8'),{keys}); }
      catch { res.writeHead(401).end('Untrusted command'); return; }
      if(command.kind!=='ScanCommand'||!allowed.has(command.groupId)) { res.writeHead(403).end('Command refused'); return; }
      const batch=await scan(command);
      const now=new Date();
      const result=signResult({...batch,version:1,kind:'ScanResult',operationId:command.operationId,sourceId:command.sourceId,groupId:command.groupId,canonicalTarget:command.canonicalTarget,issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),keyId},{key,keyId});
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
    } catch(error) { if(!res.headersSent) res.writeHead(error.status===413?413:503).end('Worker unavailable'); else res.end(); }
  });
  server.requestTimeout=15000; server.headersTimeout=10000;
  return server;
}
