import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '../src/db/pool.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { createSourceService } from '../src/sources/service.mjs';
import { signResult } from '../src/channels/groups/contracts.mjs';

const key='a'.repeat(32), keyId='test', instant=new Date('2026-10-22T12:00:00Z');
async function fixture(fn) {
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});
  const schema=`scan_${randomUUID().replaceAll('-','')}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await pool.query("INSERT INTO users(id,email,password_hash,display_name) VALUES('admin','scan@test','x','Admin')");
    await pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','admin','admin')");
    let now=instant;
    const service=createSourceService(pool,{signingKey:key,keyId,clock:()=>now,supportedSelectorVersions:['v1']});
    const command=(input,expectedRevision=1)=>({organizationId:'org_default',actorId:'admin',idempotencyKey:randomUUID(),input,expectedRevision});
    const source=await service.addGroupSource(command({url:'https://facebook.com/groups/123'}));
    const scan=(input={})=>service.requestGroupScan(command({id:source.id,...input}));
    const result=(scan,patch={})=>{
      const {signature,...body}=scan.command;
      return signResult({...body,kind:'ScanResult',selectorVersion:'v1',coverage:'complete',health:'healthy',observations:[],...patch},{key,keyId,now});
    };
    const module=await import('../src/workers/group-results.mjs').catch(()=>({}));
    assert.equal(typeof module.createGroupResultService,'function','durable result acceptance boundary must exist');
    const accept=module.createGroupResultService(pool,{keys:{[keyId]:key},signingKey:key,keyId,clock:()=>now,supportedSelectorVersions:['v1']}).acceptScanResult;
    const observation=(postId,text='ห้อง 🏠',commentId=null)=>({targetId:commentId?`comment:${postId}:${commentId}`:`post:${postId}`,postId,commentId,kind:commentId?'comment':'post',text,observedAt:now.toISOString(),evidenceHash:createHash('sha256').update(text).digest('hex')});
    await fn({pool,admin,schema,source,service,command,scan,result,accept,observation,setTime:value=>{now=new Date(value);},module});
  } finally {await pool?.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}
const integration=(name,fn)=>test(name,{skip:!process.env.TEST_DATABASE_URL},()=>fixture(fn));

integration('signed scan replay and concurrent repeats return one immutable receipt and one Inbox discovery',async({pool,scan,result,accept,observation,setTime})=>{
  const signed=result(await scan(),{observations:[observation('456')]});
  const [first,second]=await Promise.all([accept(signed),accept(signed)]);
  assert.deepEqual(first,second);
  assert.equal(first.acceptedCount,1);
  for(const table of ['group_scan_receipts','group_observations','group_targets','conversations','messages','work_items']) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,1,table);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='analyze_group_work_item'")).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT channel,page_id,psid FROM conversations')).rows[0],{channel:'facebook_group',page_id:'facebook_group:123',psid:'facebook_group_target:456'});
  setTime('2026-10-22T12:10:00Z');
  assert.deepEqual(await accept(signed),first,'already accepted authentic replays survive expiry');
  await assert.rejects(pool.query("UPDATE group_scan_receipts SET coverage='none'"),/append-only/i);
  await assert.rejects(pool.query("DELETE FROM group_observations"),/append-only/i);
});

integration('partial scans retain old targets and changed content creates one new work revision',async({pool,scan,result,accept,observation})=>{
  await accept(result(await scan(),{observations:[observation('456','old'),observation('456','comment','789')]}));
  await accept(result(await scan(),{coverage:'partial',reason:'scan_limit',observations:[observation('456','new')]}));
  await accept(result(await scan(),{observations:[observation('456','new')]}));
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_observations')).rows[0].n,4);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_targets')).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n,3);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n,3);
  assert.equal((await pool.query("SELECT text FROM group_observations ORDER BY text")).rows.some(row=>row.text==='old'),true);
  assert.equal((await pool.query("SELECT o.text FROM group_targets t JOIN group_observations o ON o.id=t.observation_id WHERE t.target_id='post:456'")).rows[0].text,'new');
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_scan_receipts WHERE coverage='partial'")).rows[0].n,1);
});

integration('a delivered Rendar comment is retained in the thread without creating an auto-reply loop',async({pool,source,scan,result,accept,observation})=>{
  await accept(result(await scan(),{observations:[observation('456','Looking for a rental')]}));
  const {rows:[work]}=await pool.query('SELECT id,conversation_id,processing_revision FROM work_items LIMIT 1');
  await pool.query(`INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context)
    VALUES('reply-owned','org_default',$1,$2,$3,1,'{"text":"Our reply"}','{}')`,[work.id,work.conversation_id,work.processing_revision]);
  await pool.query(`INSERT INTO reply_authorizations(id,organization_id,work_item_id,reply_version_id,actor_kind,evidence)
    VALUES('auth-owned','org_default',$1,'reply-owned','policy','{}')`,[work.id]);
  await pool.query(`INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,source_id,group_source_id,content)
    VALUES('intent-owned','org_default','auth-owned','reply-owned',$1,NULL,$2,'{"text":"Our reply"}')`,[work.conversation_id,source.id]);
  await pool.query(`INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state,provider_message_id,finished_at)
    VALUES('attempt-owned','org_default','intent-owned','sent','901',now())`);
  await accept(result(await scan(),{observations:[observation('456','Our reply','901')]}));
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_observations')).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n,1);
  const {createInboxQueries}=await import('../src/inbox/queries.mjs');
  const detail=await createInboxQueries({pool}).getInboxItem(work.id,{id:'admin',organizationId:'org_default',role:'admin'});
  assert.deepEqual(detail.facebook.thread.map(item=>[item.kind,item.commentId,item.text]),[['post',null,'Looking for a rental'],['comment','901','Our reply']]);
});

integration('newest authentic scan persists a safe Facebook group name and access level',async({pool,scan,result,accept})=>{
  await accept(result(await scan(),{groupName:'<b>autopost</b>\u0000',accessLevel:'admin'}));
  assert.deepEqual((await pool.query('SELECT display_name,access_level FROM group_sources')).rows[0],{display_name:'autopost',access_level:'admin'});
  await accept(result(await scan(),{groupName:null,accessLevel:'unknown'}));
  assert.deepEqual((await pool.query('SELECT display_name,access_level FROM group_sources')).rows[0],{display_name:'autopost',access_level:'admin'});
});

integration('semantic edits preserve history and supersede actionable work once under concurrent repeats',async({pool,source,scan,result,accept,observation})=>{
  await accept(result(await scan(),{observations:[observation('456','Looking for a rental')]}));
  await pool.query("UPDATE work_items SET status='needs_review'");
  const edited=result(await scan(),{observations:[observation('456','Already found a room, thank you')]}),repeat=result(await scan(),{observations:[observation('456','Already found a room, thank you')]});
  await Promise.all([accept(edited),accept(edited),accept(repeat)]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM conversations')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_targets')).rows[0].n,1);
  assert.equal((await pool.query('SELECT processing_revision FROM conversations')).rows[0].processing_revision,2);
  assert.deepEqual((await pool.query('SELECT text,processing_revision FROM messages ORDER BY processing_revision')).rows,[{text:'Looking for a rental',processing_revision:1},{text:'Already found a room, thank you',processing_revision:2}]);
  assert.deepEqual((await pool.query('SELECT status,processing_revision FROM work_items ORDER BY processing_revision')).rows,[{status:'superseded',processing_revision:1},{status:'pending',processing_revision:2}]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='analyze_group_work_item'")).rows[0].n,2);
  const {createInboxQueries}=await import('../src/inbox/queries.mjs');
  const inbox=createInboxQueries({pool}),actor={id:'admin',organizationId:'org_default',role:'admin'};
  const current=(await inbox.listInbox({sourceId:source.id},actor)).items.find(item=>item.processingRevision===2);
  assert.equal(current.message.text,'Already found a room, thank you');
  const detail=await inbox.getInboxItem(current.id,actor);
  assert.deepEqual(detail.timeline.map(item=>item.text),['Looking for a rental','Already found a room, thank you']);
});

integration('out-of-order edited results retain evidence without reverting text or enqueueing stale analysis',async({pool,scan,result,accept,observation})=>{
  const old=await scan(),current=await scan();
  await accept(result(current,{observations:[observation('456','Already found a room')]}));
  await accept(result(old,{observations:[observation('456','Looking for a rental')]}));
  assert.deepEqual((await pool.query('SELECT text,processing_revision FROM messages')).rows,[{text:'Already found a room',processing_revision:1}]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_observations')).rows[0].n,2);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='analyze_group_work_item'")).rows[0].n,1);
});

integration('a newer return to earlier content creates a fresh revision while identical content does not',async({pool,scan,result,accept,observation})=>{
  for(const text of ['Looking for a rental','Already found a room','Looking for a rental','Looking for a rental']) await accept(result(await scan(),{observations:[observation('456',text)]}));
  assert.deepEqual((await pool.query('SELECT text,processing_revision FROM messages ORDER BY processing_revision')).rows,[{text:'Looking for a rental',processing_revision:1},{text:'Already found a room',processing_revision:2},{text:'Looking for a rental',processing_revision:3}]);
  assert.equal((await pool.query('SELECT count(DISTINCT mid)::int n FROM messages')).rows[0].n,3);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='analyze_group_work_item'")).rows[0].n,3);
});

for(const first of ['messenger','facebook_group']) integration(`${first}-first provider IDs cannot collide with the other channel`,async({pool,source,scan,result,accept,observation})=>{
  const {acceptMetaWebhook}=await import('../src/channels/meta/ingress.mjs');
  await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('meta-source','org_default','123','Messenger Page','connected')");
  const messenger=async()=>{
    const rawBody=Buffer.from(JSON.stringify({object:'page',entry:[{id:'123',messaging:[{sender:{id:'456'},recipient:{id:'123'},timestamp:1000,message:{mid:'post:456',text:'Messenger demand'}}]}]}));
    assert.equal((await acceptMetaWebhook({pool,rawBody,appSecret:'secret',signature:`sha256=${createHmac('sha256','secret').update(rawBody).digest('hex')}`})).status,200);
  };
  const group=async()=>accept(result(await scan(),{observations:[observation('456','Group demand')]}));
  if(first==='messenger') {await messenger();await group();} else {await group();await messenger();}
  await messenger();await group();
  assert.deepEqual((await pool.query('SELECT channel,processing_revision FROM conversations ORDER BY channel')).rows,[{channel:'facebook_group',processing_revision:1},{channel:'messenger',processing_revision:1}]);
  assert.deepEqual((await pool.query('SELECT c.channel,m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id ORDER BY c.channel')).rows,[{channel:'facebook_group',text:'Group demand'},{channel:'messenger',text:'Messenger demand'}]);
  assert.deepEqual((await pool.query("SELECT kind,count(*)::int n FROM jobs WHERE kind IN ('analyze_group_work_item','analyze_work_item') GROUP BY kind ORDER BY kind")).rows,[{kind:'analyze_group_work_item',n:1},{kind:'analyze_work_item',n:1}]);
  const {createInboxQueries}=await import('../src/inbox/queries.mjs');
  const inbox=createInboxQueries({pool}),actor={id:'admin',organizationId:'org_default',role:'admin'};
  assert.equal((await inbox.listInbox({channel:'facebook_group',sourceId:source.id},actor)).items[0].message.text,'Group demand');
  assert.equal((await inbox.listInbox({channel:'messenger',sourceId:'meta-source'},actor)).items[0].message.text,'Messenger demand');
});

integration('Meta ingress refuses an existing legacy Group identity instead of appending Messenger work to it',async({pool})=>{
  const {acceptMetaWebhook}=await import('../src/channels/meta/ingress.mjs');
  await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('meta-source','org_default','777','Messenger Page','connected')");
  await pool.query("INSERT INTO conversations(id,organization_id,channel,page_id,psid) VALUES('legacy-group','org_default','facebook_group','777','888')");
  const rawBody=Buffer.from(JSON.stringify({object:'page',entry:[{id:'777',messaging:[{sender:{id:'888'},recipient:{id:'777'},message:{mid:'messenger-message',text:'Messenger demand'}}]}]}));
  const response=await acceptMetaWebhook({pool,rawBody,appSecret:'secret',signature:`sha256=${createHmac('sha256','secret').update(rawBody).digest('hex')}`});
  assert.equal(response.status,503);
  assert.equal((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n,0);
  assert.equal((await pool.query("SELECT processing_revision FROM conversations WHERE id='legacy-group'")).rows[0].processing_revision,0);
});

integration('invalid signatures routing identities and expired first results never write',async({pool,scan,result,accept,observation,setTime})=>{
  const op=await scan();
  const signed=result(op,{observations:[observation('456')]});
  await assert.rejects(accept({...signed,health:'auth_required'}),/signature/i);
  for(const patch of [{sourceId:'forged'},{groupId:'999',canonicalTarget:'https://www.facebook.com/groups/999'}]) {
    await assert.rejects(accept(result(op,patch)),/match|binding/i);
  }
  await assert.rejects(accept(result(op,{observations:[{...observation('456'),targetId:'999'}]})),/identity/i);
  setTime('2026-10-22T12:06:00Z');
  await assert.rejects(accept(signed),/expired/i);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_scan_receipts')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n,0);
});

integration('group Inbox filters and DTOs keep provider identities and unrelated Meta sources private',async({pool,source,scan,result,accept,observation})=>{
  await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('collision','org_default','123','Unrelated Page','connected')");
  await accept(result(await scan(),{observations:[observation('456','ห้อง 🏠')]}));
  const {createInboxQueries}=await import('../src/inbox/queries.mjs');
  const inbox=createInboxQueries({pool}),actor={id:'admin',organizationId:'org_default',role:'admin'};
  const list=await inbox.listInbox({channel:'facebook_group',sourceId:source.id},actor);
  assert.equal(list.items.length,1);
  assert.equal(list.items[0].source.id,source.id);
  assert.equal(list.items[0].participant.label,'Group participant');
  assert.equal((await inbox.listInbox({sourceId:'collision'},actor)).items.length,0);
  const detail=await inbox.getInboxItem(list.items[0].id,actor);
  assert.deepEqual(detail.target,{kind:'post',uiId:detail.message.id});
  assert.equal(detail.timeline.find(message=>message.uiId===detail.target.uiId)?.isTarget,true);
  for(const forbidden of ['post:456','"page_id"','"psid"','raw_evidence','Unrelated Page']) assert.equal(JSON.stringify(detail).includes(forbidden),false,forbidden);
});

integration('application worker accepts results and retries with minimal grants while evidence remains append-only',async({pool,admin,schema,scan,result,observation,module})=>{
  const {provisionRuntime}=await import('./provision-runtime.mjs');
  const role=`scan_worker_${randomUUID().replaceAll('-','')}`;
  let runtime;
  try {
    await provisionRuntime(pool,{role,profile:'worker',password:'scan-test-password-12345'});
    const url=new URL(process.env.TEST_DATABASE_URL);url.username=role;url.password='scan-test-password-12345';url.searchParams.set('options',`-c search_path=${schema}`);
    runtime=createPool({databaseUrl:url.href});
    const handler=module.createGroupResultService(runtime,{keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,supportedSelectorVersions:['v1']});
    await handler.acceptScanResult(result(await scan(),{observations:[observation('456')]}));
    await handler.acceptScanResult(result(await scan(),{health:'failed',coverage:'none',reason:'scan_timeout'}));
    for(const table of ['group_scan_receipts','group_observations','group_operations']) {
      await assert.rejects(runtime.query(`DELETE FROM ${table}`),e=>e.code==='42501');
    }
    await assert.rejects(runtime.query("UPDATE group_sources SET allow_listed=true"),e=>e.code==='42501');
    await assert.rejects(runtime.query("UPDATE group_observations SET text='forged'"),e=>e.code==='42501');
    await assert.rejects(runtime.query("UPDATE group_operations SET command='{}'"),e=>e.code==='42501');
  } finally {
    await runtime?.end();
    const client=await admin.connect();try {await client.query(`DROP OWNED BY "${role}"`);await client.query(`DROP ROLE "${role}"`);}finally{client.release();}
  }
});

integration('normalization persists bounded Unicode text and no HTML markup or raw envelope',async({pool,scan,result,accept,observation})=>{
  await accept(result(await scan(),{observations:[observation('456','<b>ห้อง</b> e\u0301\u0000\u202e 🏠')]}));
  assert.equal((await pool.query('SELECT text FROM messages')).rows[0].text,'ห้อง é 🏠');
  const raw=(await pool.query('SELECT raw_evidence FROM messages')).rows[0].raw_evidence;
  assert.deepEqual(Object.keys(raw).sort(),['contentHash','evidenceHash','observationId','selectorVersion']);
});

integration('different authentic results conflict and commit a security audit without overwriting receipt',async({pool,scan,result,accept,observation})=>{
  const op=await scan(),signed=result(op,{observations:[observation('456')]});
  const receipt=await accept(signed);
  await assert.rejects(accept(result(op,{coverage:'partial'})),e=>e.status===409);
  assert.deepEqual(await accept(signed),receipt);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_entries WHERE action='group.result_conflict'")).rows[0].n,1);
});

integration('failed Inbox job rolls back the entire receipt observations and source health',async({pool,scan,result,accept,observation})=>{
  const signed=result(await scan(),{observations:[observation('456')]});
  await pool.query("CREATE FUNCTION refuse_analysis() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='analyze_group_work_item' THEN RAISE EXCEPTION 'analysis refused'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER refuse_analysis BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_analysis()');
  await assert.rejects(accept(signed),/analysis refused/);
  for(const table of ['group_scan_receipts','group_observations','group_targets','messages','work_items','conversations']) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table);
  assert.equal((await pool.query('SELECT session_health FROM group_sources')).rows[0].session_health,'unknown');
});

integration('automation claims the distinct durable group analysis job through trusted preparation',async({pool,scan,result,accept,observation})=>{
  await accept(result(await scan(),{observations:[observation('456')]}));
  const {createAutomationWorker}=await import('../src/workers/automation-worker.mjs');
  let prepared=0;
  const worker=createAutomationWorker({pool,service:{prepareReply:async()=>{prepared++;}},workerId:'analysis'});
  assert.equal(typeof await worker.runOnce(),'string');assert.equal(prepared,1);
  assert.deepEqual((await pool.query("SELECT status,attempts FROM jobs WHERE kind='analyze_group_work_item'")).rows[0],{status:'completed',attempts:1});
});

integration('source request waits for the organization before locking source rows',async({pool,source,scan})=>{
  const blocker=await pool.connect();let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT id FROM organizations WHERE id='org_default' FOR NO KEY UPDATE");
    pending=scan();
    let waiting=false;
    for(let i=0;i<200&&!waiting;i++) {
      const {rows:[row]}=await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%organizations%'");
      waiting=row.n>0;
      if(!waiting) await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true,'source request should be waiting for the organization');
    await blocker.query('SELECT id FROM group_sources WHERE id=$1 FOR UPDATE NOWAIT',[source.id]);
  } finally {
    await blocker.query('ROLLBACK');blocker.release();await pending;
  }
});

integration('session failure opens a circuit until a newer explicit healthy recovery scan',async({pool,scan,result,accept})=>{
  const old=await scan(),failure=await scan();
  await accept(result(failure,{health:'auth_required',coverage:'none',reason:'session_unavailable'}));
  assert.equal((await pool.query('SELECT session_circuit FROM group_sources')).rows[0].session_circuit,true);
  await assert.rejects(scan(),/circuit/i);
  await accept(result(old));
  assert.equal((await pool.query('SELECT session_circuit FROM group_sources')).rows[0].session_circuit,true,'old successful scans cannot recover');
  const recovery=await scan({recovery:true});
  await accept(result(recovery));
  assert.deepEqual((await pool.query('SELECT session_circuit,selector_circuit,selector_failures,session_health FROM group_sources')).rows[0],{session_circuit:false,selector_circuit:false,selector_failures:0,session_health:'healthy'});
  await scan();
});

integration('all session blockers require recovery and generic failures cannot count as selector failures',async({pool,scan,result,accept})=>{
  for(const health of ['checkpoint','expired','quarantined']) {
    await accept(result(await scan(),{health,coverage:'none',reason:'session_unavailable'}));
    await assert.rejects(scan(),/circuit/i);
    assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan' AND payload->>'retryRootId' IS NOT NULL")).rows[0].n,0);
    await accept(result(await scan({recovery:true})));
  }
  await accept(result(await scan(),{health:'failed',coverage:'none',reason:'page_changed'}));
  assert.equal((await pool.query('SELECT selector_failures FROM group_sources')).rows[0].selector_failures,0);
});

integration('three ordered genuine selector failures open circuit and unsupported recovery cannot heal it',async({pool,scan,result,accept})=>{
  for(let i=0;i<3;i++) await accept(result(await scan(),{health:'selector_failure',coverage:'partial',reason:'identity_missing'}));
  assert.deepEqual((await pool.query('SELECT selector_failures,selector_circuit FROM group_sources')).rows[0],{selector_failures:3,selector_circuit:true});
  await assert.rejects(scan(),/circuit/i);
  await accept(result(await scan({recovery:true}),{selectorVersion:'unsupported'}));
  assert.equal((await pool.query('SELECT selector_circuit FROM group_sources')).rows[0].selector_circuit,true);
  assert.equal((await pool.query('SELECT selector_failures FROM group_sources')).rows[0].selector_failures,3,'unsupported selectors cannot reset evidence of selector failures');
  await accept(result(await scan({recovery:true})));
  assert.equal((await pool.query('SELECT selector_circuit FROM group_sources')).rows[0].selector_circuit,false);
});

integration('newer failure fences old health and projection while preserving late observations',async({pool,scan,result,accept,observation})=>{
  const old=await scan(),newer=await scan();
  await accept(result(newer,{health:'checkpoint',coverage:'partial',observations:[observation('456','new')]}));
  await accept(result(old,{observations:[observation('456','old')]}));
  assert.equal((await pool.query('SELECT session_health,session_circuit FROM group_sources')).rows[0].session_health,'auth_required');
  assert.equal((await pool.query('SELECT session_circuit FROM group_sources')).rows[0].session_circuit,true);
  assert.equal((await pool.query('SELECT o.text FROM group_targets t JOIN group_observations o ON o.id=t.observation_id')).rows[0].text,'new');
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_observations')).rows[0].n,2);
});

integration('read retries link fresh signed operations with bounded backoff and stop after two retries',async({pool,scan,result,accept})=>{
  const root=await scan();let op=root;
  for(let attempt=0;attempt<3;attempt++) {
    const receipt=await accept(result(op,{health:'failed',coverage:'none',reason:'scan_timeout'}));
    assert.deepEqual(await accept(result(op,{health:'failed',coverage:'none',reason:'scan_timeout'})),receipt);
    const {rows}=await pool.query("SELECT j.payload,j.available_at,j.created_at,o.command FROM jobs j JOIN group_operations o ON o.id=j.payload->>'operationId' WHERE j.kind='group.scan' AND j.payload->>'retryRootId'=$1 ORDER BY o.operation_order",[root.operationId]);
    assert.equal(rows.length,Math.min(attempt+1,2));
    if(attempt<2) {
      assert.equal(rows.at(-1).payload.retryAttempt,attempt+1);
      assert.equal(rows.at(-1).payload.retryRootId,root.operationId);
      assert.ok(+rows.at(-1).available_at-+instant>=(attempt?10000:5000));
      op={command:rows.at(-1).command};
    }
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_operations')).rows[0].n,3);
});
