import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import {spawn} from 'node:child_process';
import express from 'express';
import OpenAI from 'openai';
import { createPool } from '../src/db/pool.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { bootstrapAdmin } from '../src/auth/bootstrap.mjs';
import { createApplicationRouter } from '../src/http/auth-routes.mjs';
import { createMetaRouter } from '../src/http/meta-routes.mjs';
import { errorHandler } from '../src/http/boundary.mjs';

test('signed inquiry becomes exactly one grounded sent reply through authenticated Inbox and real workers', {skip:!process.env.TEST_DATABASE_URL}, async t => {
  const boundary=await import('../src/http/inbox-routes.mjs').catch(()=>null);
  assert.equal(typeof boundary?.createInboxRouter,'function','Inbox HTTP boundary must exist');
  const {createInboxService}=await import('../src/inbox/service.mjs');
  const {createAutomationWorker}=await import('../src/workers/automation-worker.mjs');
  const {createMetaDeliveryWorker}=await import('../src/workers/meta-delivery-worker.mjs');
  const {createMetaSendClient}=await import('../src/channels/meta/client.mjs');
  const {createMetaCredentialRepository}=await import('../src/channels/meta/credentials.mjs');
  const {startFakeMetaProvider}=await import('./fake-meta-provider.mjs');
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});
  const schema=`inbox_http_${randomUUID().replaceAll('-','')}`;
  const workerRole=`inbox_worker_${randomUUID().replaceAll('-','')}`;
  let pool,workerPool,server,provider;
  const streams=[];
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    const {provisionRuntime}=await import('./provision-runtime.mjs');
    await provisionRuntime(pool,{role:workerRole,password:'worker-password-123',profile:'worker'});
    const workerUrl=new URL(url);workerUrl.username=workerRole;workerUrl.password='worker-password-123';
    workerPool=createPool({databaseUrl:workerUrl.href});
    await assert.rejects(workerPool.query('SELECT * FROM sessions'),error=>error.code==='42501');
    await assert.rejects(workerPool.query("SELECT meta_credential_delete('org_default','page-source')"),error=>error.code==='42501');
    await assert.rejects(workerPool.query('CREATE TABLE forbidden(id int)'),error=>error.code==='42501');
    await t.test('production worker entrypoint starts with restricted credentials and exits on SIGTERM',async()=>{
      const child=spawn(process.execPath,['src/worker.mjs'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,
        DATABASE_URL:workerUrl.href,OPENAI_API_KEY:'fake-test-only',META_TOKEN_KEY_VERSION:'one',META_TOKEN_KEYS:JSON.stringify({one:Buffer.alloc(32,1).toString('base64')}),GROUP_COMMAND_KEY_ID:'group',GROUP_COMMAND_KEYS:JSON.stringify({group:Buffer.alloc(32,2).toString('base64')})},stdio:['ignore','pipe','pipe']});
      let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);
      const exit=new Promise(resolve=>child.once('exit',code=>resolve(code)));
      let timer;
      try {
        await Promise.race([new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('Messenger worker started.')&&output.includes('Group scheduler started.'))resolve();});child.once('exit',code=>reject(Error('Worker exited before startup: '+code)));}),
          new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Worker startup timed out')),3000))]);
        child.kill('SIGTERM');assert.equal(await exit,0);assert.equal(errors,'');
      } finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
    });
    await bootstrapAdmin(pool,{email:'inbox@example.com',password:'inbox-password-123',displayName:'Inbox admin'});
    await pool.query(`INSERT INTO projects(organization_id,id,name,district,revision) VALUES('org_default','life','Life Asoke','Asoke',1);
      INSERT INTO units(organization_id,id,project_id,unit_code,room_type,status,published_at,bedrooms,monthly_rent_thb,available_from,pet_policy,revision)
      VALUES('org_default','life-1','life','A1','1 bedroom','available',now(),1,18000,'2026-10-01','allowed',1);
      INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('page-source','org_default','page','Our Page','connected');
      UPDATE organizations SET reply_format='{"locale":"en","tone":"friendly","greetingId":"hello","closingId":"thanks","ctaId":"requirements","emojiPolicy":"none","maxLength":1800,"numberFormat":"grouped","dateFormat":"iso","requiredDisclosureId":"snapshot","forbiddenPhrases":[]}'`);
    const config={appOrigin:'https://radar.example',nodeEnv:'test'};
    const app=express();
    app.use(createMetaRouter({pool,appSecret:'webhook-secret',verifyToken:'verify'}));
    app.use(express.json({limit:'32kb'}));
    app.use(createApplicationRouter({pool,config}));
    app.use(boundary.createInboxRouter({pool,config,events:{pollMs:10,heartbeatMs:40,maxConnections:2,maxConnectionsPerSession:1}}));
    app.use(errorHandler);
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{Origin:config.appOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:'inbox@example.com',password:'inbox-password-123'})});
    assert.equal(login.status,200);const session=await login.json();
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const csrf=await fetch(`${base}/api/auth/csrf`,{method:'POST',headers:{Cookie:cookie,Origin:config.appOrigin}});assert.equal(csrf.status,200);session.csrfToken=(await csrf.json()).csrfToken;
    const headers={Cookie:cookie,Origin:config.appOrigin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'};
    const get=(path,extra={})=>fetch(base+path,{headers:{Cookie:cookie,...extra},signal:AbortSignal.timeout(3000)});
    const post=(path,key,revision,body={},extra={})=>fetch(base+path,{method:'POST',headers:{...headers,'Idempotency-Key':key,'If-Match':`"${revision}"`,...extra},body:JSON.stringify(body)});
    const webhook=async(mid,psid='private-psid',text='Hello',timestamp=Date.now())=>{
      const body=JSON.stringify({object:'page',entry:[{id:'page',messaging:[{sender:{id:psid},recipient:{id:'page'},timestamp,message:{mid,text}}]}]});
      return fetch(`${base}/webhooks/meta`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':`sha256=${createHmac('sha256','webhook-secret').update(body).digest('hex')}`},body});
    };
    const fields=Object.fromEntries(['budgetMin','budgetMax','bedrooms','moveInDate','requiredPetPolicy','district','roomType'].map(k=>[k,{status:'missing',value:null,evidence:[]}]));
    const generator=new OpenAI({apiKey:'fake-test-only',maxRetries:0,fetch:async(url,init)=>{
      assert.equal(String(url),'https://api.openai.com/v1/responses');
      const request=JSON.parse(init.body);assert.equal(request.text.format.type,'json_schema');assert.equal(request.text.format.strict,true);
      const answer=request.text.format.name==='rental_requirements'?fields:{units:[{unitId:'life-1',factIds:['identity','price','bedrooms','availableFrom','petPolicy']}],templateId:'options'};
      return Response.json({id:'resp_fake',object:'response',created_at:0,status:'completed',error:null,incomplete_details:null,
        model:request.model,output:[{id:'msg_fake',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(answer),annotations:[]}]}],
        parallel_tool_calls:false,tools:[],tool_choice:'auto',metadata:{}});
    }});
    const service=createInboxService({pool:workerPool,client:generator});
    const automation=createAutomationWorker({pool:workerPool,service,workerId:'e2e'});
    const credentials=createMetaCredentialRepository({pool,keys:{one:Buffer.alloc(32,1)},keyVersion:'one'});
    await credentials.store({organizationId:'org_default',actorId:session.user.id,id:'page-source',kind:'page',value:{token:'secret-page-token'}});
    provider=await startFakeMetaProvider();
    const workerCredentials=createMetaCredentialRepository({pool:workerPool,keys:{one:Buffer.alloc(32,1)},keyVersion:'one'});
    const delivery=createMetaDeliveryWorker({pool:workerPool,credentials:workerCredentials,client:createMetaSendClient({fetchImpl:provider.fetch,timeoutMs:1000})});
    await t.test('authentication and query bounds',async()=>{
      assert.equal((await fetch(`${base}/api/inbox`)).status,401);
      assert.equal((await fetch(`${base}/api/inbox/events`)).status,401);
      for(const query of ['limit=101','limit=0','limit=1&limit=2','search='+ 'x'.repeat(501),'unknown=x']) assert.ok([400,422].includes((await get('/api/inbox?'+query)).status));
    });
    assert.equal((await webhook('mid-1')).status,200);assert.equal((await webhook('mid-1')).status,200);
    let list=await (await get('/api/inbox')).json();assert.equal(list.items.length,1);
    const item=list.items[0],path=`/api/inbox/${item.id}`;
    assert.deepEqual(item.summary,{location:null,budgetMax:null,assignee:null});
    await t.test('new inbound produces a durable resource receipt before any worker runs',async()=>{
      const received=await (await get(path)).json();
      assert.ok(received.events.some(event=>event.resourceId===item.id && event.state==='pending'));
    });
    await t.test('writes reject missing guards and trusted contexts',async()=>{
      assert.equal((await post(path+'/prepare','guard',1,{}, {Origin:'https://evil.example'})).status,403);
      assert.equal((await post(path+'/prepare','guard',1,{}, {'X-CSRF-Token':''})).status,403);
      assert.equal((await post(path+'/prepare','',1)).status,422);
      assert.equal((await post(path+'/prepare','guard',1,{}, {'If-Match':''})).status,409);
      assert.equal((await post(path+'/prepare','guard',1,{context:{organizationId:'other'}})).status,422);
    });
    const prepared=await post(path+'/prepare','prepare-1',1);assert.equal(prepared.status,202);
    const prepareReceipt=await prepared.json();assert.equal(prepareReceipt.operation.state,'queued');
    assert.deepEqual(await (await post(path+'/prepare','prepare-1',1)).json(),prepareReceipt);
    await automation.runOnce();await automation.runOnce();
    let detail=await (await get(path)).json();
    assert.equal(detail.status,'needs_review');
    assert.equal(detail.replies.length,1);assert.match(detail.replies[0].text,/Life Asoke · A1\nRent: 18,000 THB\/month\n1 bedroom\nAvailable from: 2026-10-01\nPets allowed/);
    const exactText=detail.replies[0].text+'\nExact operator note.';
    const edited=await post(`/api/replies/${detail.replies[0].id}/edit`,'edit-1',1,{text:exactText});assert.equal(edited.status,200);
    const editedReply=(await edited.json()).reply;assert.notEqual(editedReply.id,detail.replies[0].id);assert.equal(editedReply.text,exactText);
    detail=await (await get(path)).json();assert.equal(detail.replies[0].text,exactText);
    const approvalPath=`/api/replies/${editedReply.id}/approve`;
    const approved=await post(approvalPath,'approve-1',1);assert.equal(approved.status,202);
    const approval=await approved.json();assert.equal(approval.operation.state,'queued');
    assert.deepEqual(await (await post(approvalPath,'approve-1',1)).json(),approval);
    const {enqueueJob}=await import('../src/jobs/queue.mjs');
    await enqueueJob(pool,{organizationId:'org_default',kind:'deliver_reply',retrySafe:false,payload:{deliveryIntentId:approval.operation.resourceId}});
    await Promise.all([delivery.runOnce(),delivery.runOnce()]);await delivery.runOnce();
    assert.equal(provider.sends.length,1);assert.equal(provider.sends[0].message.text,detail.replies[0].text);
    detail=await (await get(path)).json();assert.equal(detail.status,'completed');
    assert.equal(detail.deliveries[0].state,'sent');assert.equal(detail.deliveries[0].providerMessageId,'fake-meta-1');
    assert.equal(detail.events.filter(e=>e.state==='sent').length,1);
    for(const secret of ['secret-page-token','private-psid','raw_evidence','psid']) assert.ok(!JSON.stringify(detail).includes(secret));
    await t.test('oversized bodies use the stable Inbox error envelope',async()=>{
      const response=await post(path+'/handoff','oversized',1,{reason:'x'.repeat(40000)});
      assert.equal(response.status,413);assert.equal((await response.json()).code,'PAYLOAD_TOO_LARGE');
    });
    await t.test('detail receipt DTOs never project extra stored provider fields',async()=>{
      await pool.query(`INSERT INTO outbox(id,organization_id,kind,payload) VALUES('projection-test','org_default','inbox.operation',$1)`,
        [{receiptId:'projection-test',resourceId:item.id,resourceType:'work_item',state:'queued',token:'extra-secret',providerBody:{psid:'hidden'}}]);
      const resource=await (await get(path)).json();
      for(const event of resource.events)assert.deepEqual(Object.keys(event).sort(),['receiptId','resourceId','resourceType','state']);
      assert.ok(!JSON.stringify(resource).includes('extra-secret'));
    });
    await t.test('tenant sessions cannot read, approve, handoff or stream foreign resources and viewers cannot write',async()=>{
      const {createSession}=await import('../src/auth/session.mjs');
      await pool.query("INSERT INTO organizations(id,name) VALUES('foreign','Foreign')");
      await pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES('foreign',$1,'admin')",[session.user.id]);
      const foreign=await createSession(pool,{organizationId:'foreign',id:session.user.id});
      const foreignCookie=`rental_session=${foreign.token}`;
      assert.deepEqual((await (await get('/api/inbox',{Cookie:foreignCookie})).json()).items,[]);
      assert.equal((await get(path,{Cookie:foreignCookie})).status,404);
      for(const route of [approvalPath,path+'/prepare',path+'/handoff']) {
        const response=await post(route,'foreign-'+route,1,route.endsWith('handoff')?{reason:'Foreign'}:{},{Cookie:foreignCookie,'X-CSRF-Token':foreign.csrfToken});
        assert.equal(response.status,404);
      }
      const stream=await get('/api/inbox/events',{Cookie:foreignCookie,'Last-Event-ID':'0'});
      const reader=stream.body.getReader();assert.equal(Buffer.from((await reader.read()).value).toString(),': heartbeat\n\n');await reader.cancel();
      await pool.query("UPDATE memberships SET role='viewer' WHERE organization_id='org_default' AND user_id=$1",[session.user.id]);
      assert.equal((await get(path)).status,200);assert.equal((await post(path+'/prepare','viewer',1)).status,403);
      await pool.query("UPDATE memberships SET role='admin' WHERE organization_id='org_default' AND user_id=$1",[session.user.id]);
    });
    await t.test('receipt stream replays after restart, is bounded and contains only IDs and state',async()=>{
      const controller=new AbortController();streams.push(controller);
      const stream=await get('/api/inbox/events',{'Last-Event-ID':'0'});assert.equal(stream.status,200);
      const reader=stream.body.getReader();let text='';
      while(!text.includes('"state":"sent"')) {const chunk=await reader.read();text+=Buffer.from(chunk.value).toString();}
      assert.ok(text.includes('event: inbox'));assert.ok(text.includes('id: '));
      for(const secret of ['Life Asoke','Hello','secret-page-token','private-psid','psid','providerMessageId']) assert.ok(!text.includes(secret));
      const frames=text.split('\n\n').filter(frame=>frame.includes('data: '));
      for(const frame of frames) {const value=JSON.parse(frame.split('data: ')[1]);assert.deepEqual(Object.keys(value).sort(),['receiptId','resourceId','resourceType','state','workItemId']);assert.equal(typeof value.workItemId,'string');}
      assert.equal((await get('/api/inbox/events')).status,429);
      const last=frames.at(-1).split('\n').find(line=>line.startsWith('id: ')).slice(4);
      await reader.cancel();
      await new Promise(resolve=>setTimeout(resolve,30));
      const restarted=express();restarted.use(boundary.createInboxRouter({pool,config}));
      const restartedServer=restarted.listen(0,'127.0.0.1');await new Promise(resolve=>restartedServer.once('listening',resolve));
      try {
        const replayed=await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/inbox/events`,{headers:{Cookie:cookie,'Last-Event-ID':'0'},signal:AbortSignal.timeout(3000)});
        const replayReader=replayed.body.getReader();let replayText='';
        while(!replayText.includes('"state":"sent"'))replayText+=Buffer.from((await replayReader.read()).value).toString();
        assert.match(replayText,/"state":"sent"/);await replayReader.cancel();
      } finally {restartedServer.closeAllConnections();await new Promise(resolve=>restartedServer.close(resolve));}
      const resumed=await get('/api/inbox/events',{'Last-Event-ID':last});const resumedReader=resumed.body.getReader();
      const heartbeat=Buffer.from((await resumedReader.read()).value).toString();assert.match(heartbeat,/: heartbeat/);await resumedReader.cancel();
      assert.equal((await get('/api/inbox/events',{'Last-Event-ID':'bad'})).status,400);
    });
    await t.test('new inbound invalidates revisions and takeover cancels queued sends',async()=>{
      await webhook('mid-2','private-psid','New request');
      assert.equal((await post(path+'/prepare','stale-prepare',1)).status,409);
      assert.equal((await post(approvalPath,'stale-approval',1)).status,409);
      const newest=(await (await get('/api/inbox')).json()).items[0];
      await automation.runOnce();
      const newestDetail=await (await get(`/api/inbox/${newest.id}`)).json();
      assert.equal((await post(`/api/replies/${newestDetail.replies[0].id}/approve`,'before-takeover',2)).status,202);
      assert.equal((await post(`/api/inbox/${newest.id}/handoff`,'wrong',1,{reason:'Agent'})).status,409);
      const takeover=await post(`/api/inbox/${newest.id}/handoff`,'handoff',2,{reason:'Agent required'});assert.equal(takeover.status,202);
      assert.deepEqual(await (await post(`/api/inbox/${newest.id}/handoff`,'handoff',2,{reason:'Agent required'})).json(),await takeover.json());
      assert.equal((await post(`/api/inbox/${newest.id}/handoff`,'handoff',2,{reason:'Changed reason'})).status,409);
      await automation.runOnce();await delivery.runOnce();assert.equal(provider.sends.length,1);
    });
    await t.test('automatic policy uses same workers and terminal failed and unknown outcomes never resend',async()=>{
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"automatic","minimumConfidence":0}',automation_policy_revision=automation_policy_revision+1`);
      for(const [name,state] of [['automatic','sent'],['rejected','failed'],['uncertain','unknown']]) {
        provider.setMode(name);await webhook('mid-'+name,name);await automation.runOnce();
        await delivery.runOnce();await delivery.runOnce();
        const row=(await (await get('/api/inbox')).json()).items.find(i=>i.id!==item.id && i.status!=='handoff' && i.id!==undefined && i.message.id);
        const attempts=(await pool.query(`SELECT a.state FROM delivery_attempts a JOIN delivery_intents d ON d.id=a.delivery_intent_id JOIN conversations c ON c.id=d.conversation_id WHERE c.psid=$1`,[name])).rows;
        assert.deepEqual(attempts.map(a=>a.state),[state]);assert.ok(row);
      }
      assert.equal(provider.sends.length,4);
    });
    await t.test('Inbox HTTP summary returns normalized durable facts and no provider identities',async()=>{
      await pool.query(`INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context)
        SELECT 'http-summary',organization_id,id,conversation_id,processing_revision,99,'{"text":"safe"}',
          '{"snapshot":{"requirements":{"geography":{"districts":["  Asoke  "]},"budgetMax":20000}},"providerId":"private-psid"}'::jsonb
        FROM work_items WHERE id=$1`,[item.id]);
      const summarized=(await (await get('/api/inbox?limit=100')).json()).items.find(candidate=>candidate.id===item.id);
      assert.deepEqual(summarized.summary,{location:'Asoke',budgetMax:20000,assignee:null});
      assert.equal(JSON.stringify(summarized).includes('private-psid'),false);
    });
  } finally {
    streams.forEach(stream=>stream.abort());
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await provider?.close();await workerPool?.end();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[workerRole])).rowCount){await admin.query(`DROP OWNED BY "${workerRole}"`);await admin.query(`DROP ROLE "${workerRole}"`);}
    await admin.end();
  }
});
