import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createConnection,createServer as createNetServer} from 'node:net';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';
import {createSession} from '../src/auth/session.mjs';

const key=Buffer.alloc(32,115),keys={staging:key},encodedKeys=JSON.stringify({staging:key.toString('base64')});
const common=(kind)=>({version:1,kind,operationId:`op-${kind}`,sourceId:'source-1',groupId:'100',canonicalTarget:'https://www.facebook.com/groups/100',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),keyId:'staging'});

test('browser recovery locks automation until its bounded lease expires', async () => {
  const {createRecoveryGate}=await import('../src/group-worker/recovery.mjs');
  let now=Date.parse('2026-10-22T00:00:00.000Z');
  const gate=createRecoveryGate({clock:()=>now,maxTtlMs:60_000});
  const started=gate.start({sourceId:'source-1',groupId:'100',ttlMs:30_000});
  assert.equal(gate.status().state,'recovery');
  assert.equal(gate.permitsAutomation(),false);
  assert.deepEqual(Object.keys(gate.status()).sort(),['expiresAt','sourceId','state']);
  assert.equal(started.expiresAt,'2026-10-22T00:00:30.000Z');
  now+=30_001;
  assert.deepEqual(gate.status(),{state:'available'});
  assert.equal(gate.permitsAutomation(),true);
});

test('recovery accepts the same bounded Group identity as the source contract',async()=>{
  const {createRecoveryGate}=await import('../src/group-worker/recovery.mjs');
  const gate=createRecoveryGate();
  assert.equal(gate.start({sourceId:'source-1',groupId:'1'.repeat(100),ttlMs:1000}).state,'recovery');
  assert.throws(()=>gate.stop({sourceId:null}),/Invalid recovery request/);gate.stop({sourceId:'source-1'});
  assert.throws(()=>gate.start({sourceId:'source-1',groupId:'1'.repeat(101),ttlMs:1000}),/Invalid recovery request/);
});

test('application recovery tunnel expires closed and invokes private worker cleanup',async()=>{
  const {createRecoveryRegistry}=await import('../src/http/source-routes.mjs');
  let now=Date.parse('2026-10-22T00:00:00.000Z'),timer,expired;
  const registry=createRecoveryRegistry({clock:()=>now,setTimer:callback=>{timer=callback;return 1;},clearTimer:()=>{},onExpire:record=>{expired=record;}});
  const lease=registry.start({organizationId:'org-1',sourceId:'source-1',expiresAt:'2026-10-22T00:01:00.000Z'});
  assert.ok(registry.get({organizationId:'org-1',sourceId:'source-1',sessionId:lease.sessionId}));
  assert.equal(registry.get({organizationId:'other',sourceId:'source-1',sessionId:lease.sessionId}),null);
  now+=60_001;timer();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(registry.get({organizationId:'org-1',sourceId:'source-1',sessionId:lease.sessionId}),null);
  assert.equal(expired.sourceId,'source-1');assert.equal(Object.hasOwn(expired,'timer'),false);
});

test('recovery expiry and revoke close every accepted WebSocket before worker cleanup',async()=>{
  const {createRecoveryRegistry}=await import('../src/http/source-routes.mjs');
  let timer;const order=[];
  const socket=()=>Object.assign(new EventEmitter(),{destroyed:false,destroy(){this.destroyed=true;order.push('socket');this.emit('close');}});
  const registry=createRecoveryRegistry({clock:()=>Date.parse('2026-10-22T00:00:00Z'),setTimer:callback=>{timer=callback;return 1;},clearTimer:()=>{},onExpire:async()=>order.push('cleanup')});
  const lease=registry.start({organizationId:'org',sourceId:'source',expiresAt:'2026-10-22T00:01:00Z'}),identity={organizationId:'org',sourceId:'source',sessionId:lease.sessionId};
  const first=socket(),second=socket();assert.equal(registry.attachSocket(identity,first),true);assert.equal(registry.attachSocket(identity,second),true);
  timer();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['socket','socket','cleanup']);
  const next=registry.start({organizationId:'org',sourceId:'source',expiresAt:'2026-10-22T00:01:00Z'}),third=socket();
  assert.equal(registry.attachSocket({...identity,sessionId:next.sessionId},third),true);assert.equal(registry.close({...identity,sessionId:next.sessionId}),true);assert.equal(third.destroyed,true);
  const disconnected=registry.start({organizationId:'org',sourceId:'source',expiresAt:'2026-10-22T00:01:00Z'}),fourth=socket(),disconnectedIdentity={...identity,sessionId:disconnected.sessionId};
  assert.equal(registry.attachSocket(disconnectedIdentity,fourth),true);fourth.emit('close');await new Promise(resolve=>setImmediate(resolve));assert.equal(registry.get(disconnectedIdentity),null);assert.equal(order.at(-1),'cleanup');
});

test('an established recovery socket is destroyed before expiry cleanup unlocks the worker',async t=>{
  let accept;const accepted=new Promise(resolve=>accept=resolve),network=createNetServer(socket=>accept(socket));
  await new Promise(resolve=>network.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>network.close(resolve)));
  const client=createConnection(network.address().port,'127.0.0.1');t.after(()=>client.destroy());const socket=await accepted,order=[],destroy=socket.destroy.bind(socket);socket.destroy=(...args)=>{order.push('socket');return destroy(...args);};
  const {createRecoveryRegistry}=await import('../src/http/source-routes.mjs');let timer;
  const registry=createRecoveryRegistry({setTimer:callback=>{timer=callback;return 1;},clearTimer:()=>{},onExpire:()=>order.push('cleanup')});
  const lease=registry.start({organizationId:'org',sourceId:'source',expiresAt:new Date(Date.now()+60000).toISOString()}),identity={organizationId:'org',sourceId:'source',sessionId:lease.sessionId};
  assert.equal(registry.attachSocket(identity,socket),true);timer();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['socket','cleanup']);assert.equal(socket.destroyed,true);
});

test('worker blocks recovery automation and requires both staging send gates',async t=>{
  const [{createRecoveryGate},{createGroupWorkerServer},{createGroupWorkerClient},{signCommand}]=await Promise.all([
    import('../src/group-worker/recovery.mjs'),import('../src/group-worker/server.mjs'),import('../src/channels/groups/client.mjs'),import('../src/channels/groups/contracts.mjs')]);
  const gate=createRecoveryGate(),replyText='Exact staging reply';
  const scan=signCommand(common('ScanCommand'),{key,keyId:'staging'});
  const reply=signCommand({...common('GroupReplyCommand'),targetId:'comment:90:91',text:replyText,textHash:createHash('sha256').update(replyText).digest('hex')},{key,keyId:'staging'});
  let scans=0,sends=0;
  async function start(options={}) {
    const server=createGroupWorkerServer({keys,keyId:'staging',key,allowedGroups:['100'],recoveryGate:gate,...options,
      scan:async()=>{scans++;return {selectorVersion:'fixture-v1',coverage:'complete',health:'healthy',observations:[]};},
      reply:async command=>{sends++;return {state:'sent',senderId:'sender',attemptStartedAt:command.issuedAt,attemptFinishedAt:command.issuedAt,evidenceHash:'e'.repeat(64),remoteId:'remote'};},reconcile:async()=>assert.fail('reconcile ran')});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    return createGroupWorkerClient({baseUrl:`http://127.0.0.1:${server.address().port}`,keys,keyId:'staging',key});
  }
  const disabled=await start({stagingSendEnabled:false,stagingAllowedGroups:['100']});
  assert.equal((await disabled.scan(scan)).coverage,'complete');
  await assert.rejects(disabled.reply(reply),/Worker request failed/);
  const notAllowlisted=await start({stagingSendEnabled:true,stagingAllowedGroups:[]});
  await assert.rejects(notAllowlisted.reply(reply),/Worker request failed/);
  gate.start({sourceId:'source-1',groupId:'100',ttlMs:30_000});
  const enabled=await start({stagingSendEnabled:true,stagingAllowedGroups:['100']});
  await assert.rejects(enabled.scan(scan),/Worker request failed/);
  gate.stop({sourceId:'source-1'});
  assert.equal((await enabled.reply(reply)).state,'sent');
  assert.equal(scans,1);assert.equal(sends,1);
});

test('signed recovery control is source-bound and health exposes no profile or credential data',async t=>{
  const [{createRecoveryGate},{createGroupWorkerServer},{createGroupRecoveryClient}]=await Promise.all([
    import('../src/group-worker/recovery.mjs'),import('../src/group-worker/server.mjs'),import('../src/channels/groups/recovery-client.mjs')]);
  const gate=createRecoveryGate();
  const server=createGroupWorkerServer({keys,keyId:'staging',key,allowedGroups:['100'],recoveryGate:gate,sessionHealth:()=>({state:'healthy'}),scan:async()=>assert.fail('scan ran'),reply:async()=>assert.fail('reply ran'),reconcile:async()=>assert.fail('reconcile ran')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  const client=createGroupRecoveryClient({baseUrl,keys,keyId:'staging',key});
  await assert.rejects(client.start({sourceId:'source-1',groupId:'999',ttlSeconds:60}),/Recovery request failed/);
  const started=await client.start({sourceId:'source-1',groupId:'100',ttlSeconds:60});
  assert.equal(started.state,'recovery');assert.equal(started.sourceId,'source-1');
  const health=await (await fetch(`${baseUrl}/health`)).json();
  assert.deepEqual(Object.keys(health).sort(),['ok','recovery','session']);assert.deepEqual(health.session,{state:'healthy'});
  assert.equal(JSON.stringify(health).includes('/data/chromium'),false);
  assert.deepEqual(await client.stop({sourceId:'source-1'}),{state:'available'});
});

test('worker health is non-ready when the active Chromium probe is unavailable or stale',async t=>{
  const {createGroupWorkerServer}=await import('../src/group-worker/server.mjs');
  for(const [state,status] of [['unavailable',503],['auth_required',503],['healthy',200]]) {
    const server=createGroupWorkerServer({keys,keyId:'staging',key,allowedGroups:['100'],sessionHealth:async()=>({state}),scan:async()=>{},reply:async()=>{},reconcile:async()=>{}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/health`);assert.equal(response.status,status);assert.equal((await response.json()).ok,status===200);
    await new Promise(resolve=>server.close(resolve));
  }
});

test('recovery HTTP boundary is tenant scoped, admin only, audited, and never exposes public noVNC',{skip:!process.env.TEST_DATABASE_URL},async()=>{
  const adminPool=createPool({databaseUrl:process.env.TEST_DATABASE_URL}),schema=`source_recovery_${randomUUID().replaceAll('-','')}`;let pool,server;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await pool.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES('admin','admin@test','x','Admin'),('viewer','viewer@test','x','Viewer');
      INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','admin','admin'),('org_default','viewer','viewer');
      INSERT INTO group_sources(id,organization_id,group_id,canonical_url) VALUES('source-1','org_default','100','https://www.facebook.com/groups/100')`);
    const adminSession=await createSession(pool,{id:'admin',organizationId:'org_default'}),viewerSession=await createSession(pool,{id:'viewer',organizationId:'org_default'});
    const calls=[];
    const recovery={start:async input=>{calls.push(['start',input]);return {state:'recovery',sourceId:input.sourceId,expiresAt:new Date(Date.now()+input.ttlSeconds*1000).toISOString()};},stop:async input=>{calls.push(['stop',input]);return {state:'available'};},health:async()=>({ok:true,recovery:{state:'available'}})};
    const {createSourceRouter,createRecoveryRegistry,authorizeRecoveryUpgrade}=await import('../src/http/source-routes.mjs');
    const registry=createRecoveryRegistry();
    const app=express();app.use(express.json());app.use(createSourceRouter({pool,config:{appOrigin:'https://radar.example'},recovery,registry,proxyHttp:(_req,res)=>res.json({proxied:true})}));app.use(['/api','/novnc'],(_req,res)=>res.status(404).json({error:'Resource not found'}));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    const headers=session=>({Origin:'https://radar.example','Content-Type':'application/json',Cookie:`rental_session=${session.token}`,'X-CSRF-Token':session.csrfToken});
    assert.equal((await fetch(`${base}/api/sources/source-1/recovery`,{method:'POST',headers:headers(viewerSession),body:JSON.stringify({ttlSeconds:60})})).status,403);
    const opened=await fetch(`${base}/api/sources/source-1/recovery`,{method:'POST',headers:headers(adminSession),body:JSON.stringify({ttlSeconds:60})});
    assert.equal(opened.status,201);const body=await opened.json();assert.match(body.tunnelUrl,new RegExp(`^/api/sources/source-1/recovery/${body.sessionId}/novnc/vnc\\.html`));
    assert.equal((await pool.query("SELECT kill_switch FROM group_sources WHERE id='source-1'")).rows[0].kill_switch,true);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_entries WHERE action='group.recovery_started'")).rows[0].n,1);
    const upgradeUrl=`/api/sources/source-1/recovery/${body.sessionId}/novnc/websockify`;
    assert.deepEqual(await authorizeRecoveryUpgrade({pool,registry,request:{url:upgradeUrl,headers:{cookie:`rental_session=${adminSession.token}`}}}),{targetPath:'/websockify',identity:{organizationId:'org_default',sourceId:'source-1',sessionId:body.sessionId}});
    await assert.rejects(authorizeRecoveryUpgrade({pool,registry,request:{url:upgradeUrl,headers:{cookie:`rental_session=${viewerSession.token}`}}}),error=>error.status===403);
    assert.equal((await fetch(base+body.tunnelUrl,{headers:{Cookie:`rental_session=${viewerSession.token}`}})).status,403);
    assert.deepEqual(await (await fetch(base+body.tunnelUrl,{headers:{Cookie:`rental_session=${adminSession.token}`}})).json(),{proxied:true});
    assert.equal((await fetch(`${base}/novnc/`)).status,404);assert.equal(calls.length,1);
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await pool?.end();await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await adminPool.end();}
});

test('compose keeps the browser worker private and credential-minimal',()=>{
  const env={...process.env,POSTGRES_PASSWORD:'owner-password',RUNTIME_DATABASE_URL:'postgres://web:password@postgres/db',WORKER_DATABASE_URL:'postgres://worker:password@postgres/db',SESSION_SECRET:'x'.repeat(32),OPENAI_API_KEY:'must-not-enter-browser',META_APP_SECRET:'must-not-enter-browser',META_TOKEN_KEYS:'{"one":"must-not-enter-browser"}',GROUP_COMMAND_KEY_ID:'staging',GROUP_COMMAND_KEYS:encodedKeys,GROUP_SOURCE_ALLOWLIST:'100',STAGING_FACEBOOK_SEND:'false',STAGING_FACEBOOK_SOURCE_ALLOWLIST:'100'};
  const config=JSON.parse(execFileSync('docker',['compose','--profile','tools','config','--format','json'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'}));
  const service=config.services['group-worker'];assert.ok(service);
  assert.equal(service.ports,undefined);assert.deepEqual(Object.keys(service.networks),['browser']);
  assert.ok(service.volumes.some(item=>item.source==='browser-profile'&&item.target==='/data/chromium'));assert.equal(config.volumes['browser-profile'].name,'rental-radar-browser-profile');
  assert.ok(service.volumes.some(item=>item.source==='group-operations'&&item.target==='/data/group-operations'));assert.equal(config.volumes['group-operations'].name,'rental-radar-group-operations');
  for(const name of ['DATABASE_URL','OPENAI_API_KEY','META_APP_ID','META_APP_SECRET','META_PAGE_ACCESS_TOKEN','META_TOKEN_KEYS','POSTGRES_PASSWORD'])assert.equal(Object.hasOwn(service.environment,name),false,name);
  assert.ok(service.healthcheck);assert.ok(Object.hasOwn(config.services.web.networks,'browser'));assert.ok(Object.hasOwn(config.services.worker.networks,'browser'));
  const staging=config.services['staging-check'];assert.deepEqual(staging.profiles,['tools']);assert.deepEqual(Object.keys(staging.networks),['browser']);assert.deepEqual(staging.entrypoint,['node','scripts/staging-facebook-check.mjs']);assert.equal(staging.ports,undefined);
  for(const name of ['DATABASE_URL','OPENAI_API_KEY','META_APP_SECRET','META_TOKEN_KEYS','POSTGRES_PASSWORD'])assert.equal(Object.hasOwn(staging.environment,name),false,name);
});

test('staging check is no-send by default and requires both exact live-send gates',async()=>{
  const {runStagingCheck}=await import('./staging-facebook-check.mjs');
  let healthCalls=0;const fetchImpl=async()=>{healthCalls++;return new Response(JSON.stringify({ok:true,recovery:{state:'available'},session:{state:'healthy'}}),{status:200,headers:{'content-type':'application/json'}});};
  const safe=await runStagingCheck({args:['--no-send'],env:{GROUP_WORKER_URL:'http://group-worker:3001'},fetchImpl});
  assert.deepEqual(safe,{ok:true,mode:'no-send',worker:{ok:true,recovery:{state:'available'},session:{state:'healthy'}},scanEvidence:{performed:false},sendEligible:false});
  const scanned=await runStagingCheck({args:['--no-send','--source','100'],env:{GROUP_WORKER_URL:'http://group-worker:3001',GROUP_COMMAND_KEY_ID:'staging',GROUP_COMMAND_KEYS:encodedKeys,GROUP_SOURCE_ALLOWLIST:'100'},fetchImpl,scanClient:{scan:async()=>({coverage:'partial',health:'healthy',selectorVersion:'facebook-dom-v2',observations:[{evidenceHash:'a'.repeat(64)},{evidenceHash:'b'.repeat(64)}]})}});
  assert.deepEqual(scanned.scanEvidence,{performed:true,coverage:'partial',health:'healthy',selectorVersion:'facebook-dom-v2',observationCount:2,evidenceHashes:['a'.repeat(64),'b'.repeat(64)]});
  const longestId='1'.repeat(100);
  assert.equal((await runStagingCheck({args:['--no-send','--source',longestId],env:{GROUP_WORKER_URL:'http://group-worker:3001',GROUP_COMMAND_KEY_ID:'staging',GROUP_COMMAND_KEYS:encodedKeys,GROUP_SOURCE_ALLOWLIST:longestId},fetchImpl,scanClient:{scan:async()=>({coverage:'none',health:'healthy',selectorVersion:'facebook-dom-v2',observations:[]})}})).scanEvidence.performed,true);
  await assert.rejects(runStagingCheck({args:['--send','--source','100'],env:{GROUP_WORKER_URL:'http://group-worker:3001',STAGING_FACEBOOK_SEND:'false',STAGING_FACEBOOK_SOURCE_ALLOWLIST:'100'},fetchImpl}),/both staging send gates/i);
  await assert.rejects(runStagingCheck({args:['--send','--source','100'],env:{GROUP_WORKER_URL:'http://group-worker:3001',STAGING_FACEBOOK_SEND:'true',STAGING_FACEBOOK_SOURCE_ALLOWLIST:'101'},fetchImpl}),/both staging send gates/i);
  const quarantined=async()=>new Response(JSON.stringify({ok:true,recovery:{state:'available'},session:{state:'quarantined'}}),{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(runStagingCheck({args:['--send','--source','100'],env:{GROUP_WORKER_URL:'http://group-worker:3001',STAGING_FACEBOOK_SEND:'true',STAGING_FACEBOOK_SOURCE_ALLOWLIST:'100'},fetchImpl:quarantined}),/browser session/i);
  const ready=await runStagingCheck({args:['--send','--source','100'],env:{GROUP_WORKER_URL:'http://group-worker:3001',STAGING_FACEBOOK_SEND:'true',STAGING_FACEBOOK_SOURCE_ALLOWLIST:'100'},fetchImpl});
  assert.equal(ready.sendEligible,true);assert.equal(ready.actionPerformed,false);assert.equal(healthCalls,6);
});
