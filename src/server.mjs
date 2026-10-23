import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import httpProxy from "http-proxy";
import next from "next";
import { loadConfig } from "./config.mjs";
import { createPool } from "./db/pool.mjs";
import { createApplicationRouter } from "./http/auth-routes.mjs";
import { errorHandler } from "./http/boundary.mjs";
import { createMetaRouter } from "./http/meta-routes.mjs";
import { createMetaConnectionRouter } from "./http/meta-connection-routes.mjs";
import { createMetaConnection, metaConnectionConfig } from "./channels/meta/oauth.mjs";
import { createInboxRouter } from './http/inbox-routes.mjs';
import { createAutomationRouter } from './http/automation-routes.mjs';
import { createSourceRouter,createRecoveryRegistry,authorizeRecoveryUpgrade } from './http/source-routes.mjs';
import { createGroupRecoveryClient } from './channels/groups/recovery-client.mjs';
import { groupCommandKeyConfig } from './channels/groups/keys.mjs';
import { httpError } from './auth/authorize.mjs';
import { createSourceService } from './sources/service.mjs';

const config = loadConfig();
const pool = createPool(config);
await pool.query("SELECT 1");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frontend = next({ dev: false, dir: root });
let frontendReady;
const app = express();
const shutdown=new AbortController();
const metaConnection = createMetaConnection({ pool, config: metaConnectionConfig(), env: process.env });
const groupSigning=groupCommandKeyConfig(process.env,{optional:true});
const groupKeys=groupSigning?.keys??{},groupKeyId=groupSigning?.keyId??'',groupKey=groupSigning?.key;
const sourceService=createSourceService(pool,{signingKey:groupKey,keyId:groupKeyId,supportedSelectorVersions:(process.env.GROUP_SUPPORTED_SELECTOR_VERSIONS??'facebook-dom-v3').split(',').map(value=>value.trim()).filter(Boolean)});
const recoveryClient=groupKey?createGroupRecoveryClient({baseUrl:process.env.GROUP_WORKER_URL??'http://group-worker:3001',keys:groupKeys,keyId:groupKeyId,key:groupKey}):null;
const recovery={
  start:input=>recoveryClient?recoveryClient.start(input):Promise.reject(httpError(503,'Group worker unavailable')),
  stop:input=>recoveryClient?recoveryClient.stop(input):Promise.reject(httpError(503,'Group worker unavailable')),
  async health(){
    if(!recoveryClient)throw httpError(503,'Group worker unavailable');
    try {const response=await fetch(new URL('/health',process.env.GROUP_WORKER_URL??'http://group-worker:3001'),{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();return await response.json();}
    catch {throw httpError(503,'Group worker unavailable');}
  },
};
const recoveryRegistry=createRecoveryRegistry({onExpire:record=>recovery.stop({sourceId:record.sourceId})});
const recoveryProxy=httpProxy.createProxyServer({target:process.env.GROUP_RECOVERY_PROXY_URL??'http://group-worker:6081',ws:true,changeOrigin:false});
recoveryProxy.on('error',(_error,_request,response)=>{if(response?.writeHead&&!response.headersSent)response.writeHead(502).end();else response?.destroy?.();});
app.disable("x-powered-by");
app.use(createMetaRouter({ pool, environmentSource: (pageId) => metaConnection.resolveEnvironmentSource(pageId), appSecret: process.env.META_APP_SECRET, verifyToken: process.env.META_VERIFY_TOKEN }));
app.use(express.json({ limit: "32kb" }));
app.use(createApplicationRouter({ pool, config }));
app.use(createMetaConnectionRouter({ pool, config, connection: metaConnection }));
app.use(createInboxRouter({pool,config,events:{signal:shutdown.signal}}));
app.use(createAutomationRouter({pool,config}));
app.use(createSourceRouter({pool,config,recovery,registry:recoveryRegistry,proxyHttp:(request,response)=>recoveryProxy.web(request,response),sourceService}));
app.get("/health", async (_request, response) => {
  try { await Promise.all([pool.query("SELECT 1"), frontendReady ??= frontend.prepare()]); response.json({ ok: true }); }
  catch { response.status(503).json({ ok: false }); }
});
app.use(["/api", "/fixture", "/novnc"], (_request, response) => response.status(404).json({ error: "Resource not found", fieldErrors: {} }));
app.use(async (request, response) => {
  frontendReady ??= frontend.prepare();
  await frontendReady;
  return frontend.getRequestHandler()(request, response);
});
app.use(errorHandler);
const server = http.createServer(app);
server.on('upgrade',(request,socket,head)=>{
  authorizeRecoveryUpgrade({pool,registry:recoveryRegistry,request}).then(({targetPath,identity})=>{
    if(!recoveryRegistry.attachSocket(identity,socket))throw httpError(404,'Recovery session not found');
    request.url=targetPath;recoveryProxy.ws(request,socket,head);
  }).catch(error=>{
    const status=Number.isInteger(error.status)?error.status:404;
    socket.end(`HTTP/1.1 ${status} ${status===403?'Forbidden':'Not Found'}\r\nConnection: close\r\n\r\n`);
  });
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
  process.stdout.write(`Application listening on http://0.0.0.0:${server.address().port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  shutdown.abort();
  recoveryRegistry.closeAll();
  server.close(() => { void pool.end().then(() => frontendReady ? frontend.close() : undefined); });
  server.closeIdleConnections();
});
