import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';
import {signCommand, signResult} from '../src/channels/groups/contracts.mjs';

const key='g'.repeat(32),keyId='test',instant=new Date('2026-10-22T12:00:00.000Z');
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const baseCommand=(patch={})=>({version:1,kind:'GroupReplyCommand',operationId:'operation-1',sourceId:'source-1',groupId:'123',canonicalTarget:'https://www.facebook.com/groups/123',targetId:'comment:456:789',text:'Exact reply\nบรรทัดสอง',textHash:hash('Exact reply\nบรรทัดสอง'),issuedAt:instant.toISOString(),expiresAt:'2026-10-22T12:05:00.000Z',keyId,...patch});

test('browser delivery revalidates exact destination and content, then visible evidence makes the local operation terminal sent',async()=>{
  const {createGroupDeliveryBoundary}=await import('../src/group-worker/delivery.mjs');
  const directory=await mkdtemp(join(tmpdir(),'group-delivery-'));
  try {
    let sends=0;const controller=new AbortController();
    const boundary=createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:{
      locateExactTarget:async command=>({canonicalTarget:command.canonicalTarget,targetId:'comment:456:789'}),
      identifySender:async()=> 'sender-1',
      sendExact:async(target,text,options)=>{sends++;assert.equal(target.targetId,'comment:456:789');assert.equal(text,'Exact reply\nบรรทัดสอง');assert.equal(options.signal,controller.signal);assert.equal(options.deadline,Date.parse(baseCommand().expiresAt));return {state:'sent',visible:true,remoteId:'remote-1'};},
    }});
    const first=await boundary.deliver(baseCommand(),{signal:controller.signal});
    assert.equal(first.state,'sent');assert.equal(first.remoteId,'remote-1');assert.equal(first.senderId,'sender-1');
    assert.equal(first.textHash,baseCommand().textHash);assert.equal(first.targetId,baseCommand().targetId);
    assert.equal((await boundary.deliver(baseCommand())).state,'sent');assert.equal(sends,1,'durable local ledger prevents a second click');
    const changed=baseCommand({operationId:'operation-2',targetId:'post:wrong'});
    const rejected=await boundary.deliver(changed);
    assert.equal(rejected.state,'failed');assert.equal(rejected.code,'TARGET_MISMATCH');assert.equal(sends,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('browser delivery classifies pre-click rejection as failed and a possible click as terminal unknown across restart',async()=>{
  const {createGroupDeliveryBoundary}=await import('../src/group-worker/delivery.mjs');
  const directory=await mkdtemp(join(tmpdir(),'group-crash-'));
  const driver=phase=>({
    locateExactTarget:async command=>({canonicalTarget:command.canonicalTarget,targetId:command.targetId}),identifySender:async()=> 'sender-1',
    sendExact:async()=>{const error=Error(phase);error.possibleClick=phase==='after-click';throw error;},
  });
  try {
    const before=await createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:driver('before-click')}).deliver(baseCommand({operationId:'before'}));
    assert.equal(before.state,'failed');assert.equal(before.code,'SEND_REJECTED');
    const after=await createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:driver('after-click')}).deliver(baseCommand({operationId:'after'}));
    assert.equal(after.state,'unknown');assert.equal(after.code,'POSSIBLE_SEND');
    let sends=0;
    const restarted=createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:{...driver('unused'),sendExact:async()=>{sends++;}}});
    assert.equal((await restarted.deliver(baseCommand({operationId:'after'}))).state,'unknown');assert.equal(sends,0);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('browser ledger durably records sender and real attempt bounds before a possible click',async()=>{
  const {createGroupDeliveryBoundary}=await import('../src/group-worker/delivery.mjs');
  const directory=await mkdtemp(join(tmpdir(),'group-abrupt-'));let sends=0;
  const command=baseCommand({operationId:'abrupt'});
  try {
    const crashing=createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:{
      locateExactTarget:async()=>({canonicalTarget:command.canonicalTarget,targetId:command.targetId}),identifySender:async()=> 'sender-real',
      sendExact:async()=>{sends++;const [name]=await readdir(directory);const record=JSON.parse(await readFile(join(directory,name),'utf8'));
        assert.equal(record.phase,'possible_send');assert.equal(record.senderId,'sender-real');assert.equal(record.attemptStartedAt,instant.toISOString());
        const error=Error('abrupt process death');error.abrupt=true;throw error;},
    }});
    await assert.rejects(crashing.deliver(command),/abrupt/);
    const restarted=createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>new Date('2026-10-22T12:00:10.000Z'),driver:{sendExact:async()=>{sends++;},findReplyEvidence:async()=>[{canonicalTarget:command.canonicalTarget,targetId:command.targetId,senderId:'sender-real',text:command.text,observedAt:'2026-10-22T12:00:05.000Z',remoteId:'remote-abrupt'}]}});
    const recovered=await restarted.deliver(command);
    assert.equal(recovered.state,'unknown');assert.equal(recovered.senderId,'sender-real');assert.equal(recovered.attemptStartedAt,instant.toISOString());assert.equal(sends,1);
    const reconcile={...baseCommand({kind:'ReconcileCommand',operationId:'reconcile-abrupt',text:undefined}),attemptOperationId:'abrupt',senderId:recovered.senderId,attemptStartedAt:recovered.attemptStartedAt,attemptFinishedAt:recovered.attemptFinishedAt};delete reconcile.text;
    const evidence=await restarted.reconcile(reconcile);
    assert.equal(evidence.state,'sent');assert.equal(evidence.remoteId,'remote-abrupt');assert.equal(evidence.senderId,'sender-real');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('browser reconciliation requires destination, target, sender, attempt time, and exact content',async()=>{
  const {createGroupDeliveryBoundary}=await import('../src/group-worker/delivery.mjs');
  const directory=await mkdtemp(join(tmpdir(),'group-reconcile-'));
  const command={...baseCommand({kind:'ReconcileCommand',operationId:'reconcile-1',text:undefined}),attemptOperationId:'attempt-1',senderId:'sender-1',attemptStartedAt:'2026-10-22T11:59:00.000Z',attemptFinishedAt:'2026-10-22T12:00:00.000Z'};
  delete command.text;
  try {
    let candidates=[];
    const boundary=createGroupDeliveryBoundary({ledgerPath:directory,clock:()=>instant,driver:{findReplyEvidence:async()=>candidates}});
    const candidate={canonicalTarget:command.canonicalTarget,targetId:command.targetId,senderId:command.senderId,text:'Exact reply\nบรรทัดสอง',observedAt:'2026-10-22T11:59:30.000Z',remoteId:'remote-1'};
    for(const changed of [
      {...candidate,canonicalTarget:'https://www.facebook.com/groups/999'},
      {...candidate,targetId:'post:456'},
      {...candidate,senderId:'other'},
      {...candidate,text:'Different'},
      {...candidate,observedAt:'2026-10-22T12:00:01.000Z'},
    ]) {candidates=[changed];assert.equal((await boundary.reconcile(command)).state,'not_found');}
    candidates=[candidate];const found=await boundary.reconcile(command);
    assert.equal(found.state,'sent');assert.equal(found.remoteId,'remote-1');assert.equal(found.textHash,command.textHash);
  } finally {await rm(directory,{recursive:true,force:true});}
});

async function databaseFixture(fn) {
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});const schema=`group_delivery_${randomUUID().replaceAll('-','')}`;let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await pool.query("INSERT INTO users(id,email,password_hash,display_name) VALUES('operator','group@test','x','Operator'); INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','operator','operator')");
    await pool.query(`UPDATE organizations SET automation_policy='{"mode":"approval"}',reply_format_revision=3;
      INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,policy,session_health,selector_health,selector_version)
      VALUES('group-source','org_default','123','https://www.facebook.com/groups/123','approval',true,'{}','healthy','healthy','facebook-dom-v2')`);
    const observationId=randomUUID(),conversationId=randomUUID(),messageId=randomUUID(),workItemId=randomUUID();
    const scanCommand=signCommand({version:1,kind:'ScanCommand',operationId:'scan-op',sourceId:'group-source',groupId:'123',canonicalTarget:'https://www.facebook.com/groups/123',issuedAt:instant.toISOString(),expiresAt:'2026-10-22T12:05:00.000Z',keyId},{key,keyId,now:instant});
    await pool.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES('scan-op','org_default','group-source','ScanCommand',$1)",[scanCommand]);
    await pool.query("INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,response) VALUES('scan-op','org_default','group-source',$1,'facebook-dom-v2','complete','healthy','{}')",['a'.repeat(64)]);
    await pool.query(`INSERT INTO group_observations(id,organization_id,source_id,operation_id,target_id,post_id,comment_id,kind,text,author_label,observed_at,evidence_hash,content_hash,selector_version)
      VALUES($1,'org_default','group-source','scan-op','comment:456:789','456','789','comment','หาห้องใกล้ BTS งบ 15000','Beam',$2,$3,$4,'facebook-dom-v2')`,[observationId,instant,'b'.repeat(64),'c'.repeat(64)]);
    await pool.query("INSERT INTO group_targets(organization_id,source_id,target_id,observation_id,operation_order) VALUES('org_default','group-source','comment:456:789',$1,1)",[observationId]);
    await pool.query("INSERT INTO conversations(id,organization_id,channel,page_id,psid,processing_revision) VALUES($1,'org_default','facebook_group','facebook_group:123','facebook_group_target:456',1)",[conversationId]);
    await pool.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,provider_timestamp_ms,processing_revision,raw_evidence)
      VALUES($1,'org_default',$2,'facebook_group:123','facebook_group_message:comment:456:789:1:c','หาห้องใกล้ BTS งบ 15000',$3,1,$4)`,[messageId,conversationId,instant.valueOf(),JSON.stringify({observationId,evidenceHash:'b'.repeat(64),contentHash:'c'.repeat(64),selectorVersion:'facebook-dom-v2'})]);
    await pool.query("INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES($1,'org_default',$2,$3,1)",[workItemId,conversationId,messageId]);
    await pool.query("INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES('analysis-job','org_default','analyze_group_work_item',$1,true)",[JSON.stringify({workItemId,conversationId,messageId,processingRevision:1})]);
    const actor={id:'operator',role:'operator',organizationId:'org_default'};
    await fn({pool,admin,schema,actor,workItemId,conversationId,observationId});
  } finally {await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
}
const dbtest=(name,fn)=>test(name,{skip:!process.env.TEST_DATABASE_URL},()=>databaseFixture(fn));
const failCommitOnConnection=(pool,target)=>{let connections=0;return {query:(...args)=>pool.query(...args),connect:async()=>{const client=await pool.connect(),number=++connections;return {release:(...args)=>client.release(...args),query:async(...args)=>{const result=await client.query(...args);if(number===target&&args[0]==='COMMIT')throw Error('lost COMMIT acknowledgement');return result;}};}};};
const failSettlementOnConnection=(pool,target)=>{let connections=0;return {query:(...args)=>pool.query(...args),connect:async()=>{const client=await pool.connect(),number=++connections;return {release:(...args)=>client.release(...args),query:async(...args)=>{if(number===target&&String(args[0]).startsWith('INSERT INTO group_send_receipts'))throw Error('settlement write failed');return client.query(...args);}};}};};

dbtest('group analysis uses DB-owned format and source policy, then authorization creates the shared immutable intent ledger',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');
  const {createAutomationWorker}=await import('../src/workers/automation-worker.mjs');
  const fields=Object.fromEntries(['budgetMin','budgetMax','bedrooms','moveInDate','requiredPetPolicy','district'].map(name=>[name,{status:'missing',value:null,evidence:[]} ]));
  const generator={responses:{create:async request=>({status:'completed',output_text:JSON.stringify(request.text.format.name==='rental_requirements'?fields:{units:[],templateId:'clarify'})})}};
  const service=createInboxService({pool,client:generator});const automation=createAutomationWorker({pool,service,workerId:'group-analysis'});
  assert.equal(await automation.runOnce(),'analysis-job');
  const reply=(await pool.query('SELECT * FROM reply_versions WHERE work_item_id=$1',[workItemId])).rows[0];
  assert.equal(reply.context.evidence.formatRevision,3);assert.equal(reply.context.evidence.source.id,'group-source');assert.equal(reply.context.evidence.source.mode,'approval');
  const intent=await service.approveAndQueue(reply.id,1,actor);
  assert.equal(intent.source_id,null);assert.equal(intent.group_source_id,'group-source');
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='deliver_group_reply'")).rows[0].n,1);
  await assert.rejects(pool.query("UPDATE delivery_intents SET content='{}' WHERE id=$1",[intent.id]),/immutable/i);
});

dbtest('an operator may create one audited retry only after an unresolved Group attempt is verified absent',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');
  const service=createInboxService({pool}),reply=await service.prepareReply(workItemId,1,actor),prior=await service.approveAndQueue(reply.id,1,actor);
  await pool.query("INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state,outcome_code,finished_at) VALUES('unknown-attempt','org_default',$1,'unknown','POSSIBLE_SEND',now())",[prior.id]);
  const options={idempotencyKey:'verified-absent-retry'};
  const retry=await service.retryUnknownDelivery(prior.id,1,actor,options),replayed=await service.retryUnknownDelivery(prior.id,1,actor,options);
  assert.equal(retry.retry_of_intent_id,prior.id);assert.equal(replayed.id,retry.id);
  assert.equal((await pool.query("SELECT count(*)::int n FROM delivery_intents WHERE retry_of_intent_id=$1",[prior.id])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='deliver_group_reply' AND payload->>'deliveryIntentId'=$1",[retry.id])).rows[0].n,1);
  const audit=(await pool.query("SELECT details FROM audit_entries WHERE action='delivery.retry_authorized' AND entity_id=$1",[retry.id])).rows[0];
  assert.equal(audit.details.priorIntentId,prior.id);assert.equal(audit.details.verification,'comment_not_present');
});

dbtest('handoff atomically fences pending and running Messenger and Group work with a durable reason',async({pool,actor,workItemId,conversationId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');
  const {createAutomationWorker}=await import('../src/workers/automation-worker.mjs');
  const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});
  const reply=await service.prepareReply(workItemId,1,actor);
  const intent=await service.approveAndQueue(reply.id,1,actor);
  await pool.query("UPDATE jobs SET status='running',lease_owner='analysis-owner',lease_expires_at=now()+interval '1 hour' WHERE id='analysis-job'");
  await pool.query("UPDATE jobs SET status='running',lease_owner='delivery-owner',lease_expires_at=now()+interval '1 hour' WHERE kind='deliver_group_reply'");
  await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES
    ('group-analysis-pending','org_default','analyze_group_work_item',$1,true),
    ('group-delivery-pending','org_default','deliver_group_reply',$2,false),
    ('messenger-analysis-pending','org_default','analyze_work_item',$1,true),
    ('messenger-delivery-running','org_default','deliver_reply',$2,false)`,[
    JSON.stringify({workItemId,conversationId,processingRevision:1}),JSON.stringify({deliveryIntentId:intent.id}),
  ]);
  await pool.query("UPDATE jobs SET status='running',lease_owner='messenger-owner',lease_expires_at=now()+interval '1 hour' WHERE id='messenger-delivery-running'");

  const options={idempotencyKey:'group-handoff-all-jobs',expectedRevision:1};
  const first=await service.requestHandoff(workItemId,'ลูกค้าขอให้เจ้าหน้าที่ดูแล',actor,options);
  const replay=await service.requestHandoff(workItemId,'ลูกค้าขอให้เจ้าหน้าที่ดูแล',actor,options);
  assert.deepEqual(replay,first);
  const jobs=(await pool.query(`SELECT kind,status,lease_owner,lease_expires_at FROM jobs
    WHERE kind IN ('analyze_work_item','deliver_reply','analyze_group_work_item','deliver_group_reply') ORDER BY id`)).rows;
  assert.equal(jobs.length,6);
  assert.ok(jobs.every(job=>job.status==='completed'&&job.lease_owner===null&&job.lease_expires_at===null));
  assert.deepEqual((await pool.query('SELECT reason,actor_id FROM delivery_cancellations WHERE delivery_intent_id=$1',[intent.id])).rows[0],{reason:'ลูกค้าขอให้เจ้าหน้าที่ดูแล',actor_id:'operator'});
  const audits=(await pool.query("SELECT details FROM audit_entries WHERE action='conversation.handoff' AND entity_id=$1",[conversationId])).rows;
  assert.equal(audits.length,1);assert.equal(audits[0].details.reason,'ลูกค้าขอให้เจ้าหน้าที่ดูแล');assert.equal(audits[0].details.workItemId,workItemId);
  assert.equal(await createAutomationWorker({pool,service,workerId:'after-handoff'}).runOnce(),null);
  let sends=0;
  const delivery=createGroupDeliveryWorker({pool,client:{reply:async()=>{sends++;}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  assert.equal((await delivery.deliverGroupIntent(intent.id)).state,'cancelled');assert.equal(sends,0);
});

dbtest('group worker commits attempting before private dispatch and accepts only bound signed visible evidence',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);
  let calls=0,seen;
  const client={reply:async command=>{calls++;seen=command;assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'attempting');
    return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>name!=='signature'&&name!=='text')),kind:'GroupReplyResult',state:'sent',senderId:'sender-1',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'d'.repeat(64),remoteId:'remote-1'},{key,keyId,now:instant});}};
  const worker=createGroupDeliveryWorker({pool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const outcome=await worker.deliverGroupIntent(intent.id);assert.equal(outcome.state,'sent');assert.equal(calls,1);
  assert.equal(seen.targetId,'comment:456:789');assert.equal(seen.text,reply.content.text);assert.equal(seen.textHash,hash(reply.content.text));
  const receipt=(await pool.query('SELECT result FROM group_send_receipts')).rows[0];assert.match(receipt.result.signature,/^[a-f0-9]{64}$/);
  assert.equal((await worker.deliverGroupIntent(intent.id)).state,'sent');assert.equal(calls,1);
});

dbtest('a newer observation of the same stable target does not invalidate an approved reply',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);
  const latestObservationId=randomUUID();
  const nextScan=signCommand({version:1,kind:'ScanCommand',operationId:'scan-op-2',sourceId:'group-source',groupId:'123',canonicalTarget:'https://www.facebook.com/groups/123',issuedAt:instant.toISOString(),expiresAt:'2026-10-22T12:05:00.000Z',keyId},{key,keyId,now:instant});
  await pool.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES('scan-op-2','org_default','group-source','ScanCommand',$1)",[nextScan]);
  await pool.query("INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,response) VALUES('scan-op-2','org_default','group-source',$1,'facebook-dom-v2','complete','healthy','{}')",['f'.repeat(64)]);
  await pool.query(`INSERT INTO group_observations(id,organization_id,source_id,operation_id,target_id,post_id,comment_id,kind,text,author_label,observed_at,evidence_hash,content_hash,selector_version)
    SELECT $1,organization_id,source_id,'scan-op-2',target_id,post_id,comment_id,kind,text,author_label,observed_at + interval '1 minute','d'||substr(evidence_hash,2),content_hash,selector_version
    FROM group_observations WHERE organization_id='org_default' AND source_id='group-source' LIMIT 1`,[latestObservationId]);
  await pool.query("UPDATE group_targets SET observation_id=$1,operation_order=2 WHERE organization_id='org_default' AND source_id='group-source' AND target_id='comment:456:789'",[latestObservationId]);
  let calls=0;
  const worker=createGroupDeliveryWorker({pool,client:{reply:async command=>{calls++;return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'sent',senderId:'sender-1',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'e'.repeat(64),remoteId:'remote-refreshed-target'},{key,keyId,now:instant});}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const result=await worker.deliverGroupIntent(intent.id);
  assert.equal(result.state,'sent');assert.equal(calls,1);
});

dbtest('possible group send is terminal unknown, not_found stays unknown, and reconciliation rejects mismatched evidence',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);
  let replies=0,reconcilePatch={state:'not_found'};
  const client={reply:async command=>{replies++;return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'unknown',senderId:'sender-1',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'e'.repeat(64),remoteId:null},{key,keyId,now:instant});},
    reconcile:async command=>signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>name!=='signature')),kind:'ReconcileResult',remoteId:null,evidenceHash:'f'.repeat(64),...reconcilePatch},{key,keyId,now:instant})};
  const worker=createGroupDeliveryWorker({pool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  assert.equal((await worker.deliverGroupIntent(intent.id)).state,'unknown');assert.equal((await worker.deliverGroupIntent(intent.id)).state,'unknown');assert.equal(replies,1);
  assert.equal((await worker.reconcileGroupIntent(intent.id)).state,'unknown','not_found never permits resend');
  reconcilePatch={state:'sent',remoteId:'remote-wrong',senderId:'wrong'};
  await assert.rejects(worker.reconcileGroupIntent(intent.id),/binding|evidence/i);
  assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'unknown');
  reconcilePatch={state:'sent',remoteId:'remote-verified'};
  assert.equal((await worker.reconcileGroupIntent(intent.id)).state,'sent');
  assert.equal((await pool.query('SELECT provider_message_id FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].provider_message_id,'remote-verified');
});

dbtest('production Group reconciliation stage consumes each unresolved attempt once without resending',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let replies=0,reconciles=0;
  const client={reply:async command=>{replies++;return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'unknown',senderId:'sender-1',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'e'.repeat(64),remoteId:null},{key,keyId,now:instant});},
    reconcile:async command=>{reconciles++;return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>name!=='signature')),kind:'ReconcileResult',state:'sent',remoteId:'remote-reconciled',evidenceHash:'f'.repeat(64)},{key,keyId,now:instant});}};
  const worker=createGroupDeliveryWorker({pool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  assert.equal((await worker.runOnce()).state,'unknown');assert.equal(replies,1);
  assert.equal((await worker.runReconcileOnce()).state,'sent');assert.equal(reconciles,1);assert.equal(replies,1);
  assert.equal(await worker.runReconcileOnce(),null);assert.equal(reconciles,1);
  assert.equal((await pool.query('SELECT provider_message_id FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].provider_message_id,'remote-reconciled');
});

dbtest('source health, target revision, and exact immutable content are rechecked before group dispatch',async({pool,actor,workItemId,observationId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let calls=0;
  const worker=createGroupDeliveryWorker({pool,client:{reply:async()=>{calls++;throw Error('must not dispatch');}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  await pool.query("UPDATE group_sources SET kill_switch=true WHERE id='group-source'");
  assert.equal((await worker.deliverGroupIntent(intent.id)).state,'cancelled');assert.equal(calls,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].n,0);
});

dbtest('production delivery leaves queued work untouched until staging and exact source gates are enabled',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);await service.approveAndQueue(reply.id,1,actor);let calls=0;
  for(const options of [{stagingSendEnabled:false,stagingAllowedGroups:['123']},{stagingSendEnabled:true,stagingAllowedGroups:['other']}]) {
    const worker=createGroupDeliveryWorker({pool,client:{reply:async()=>{calls++;}},keys:{[keyId]:key},signingKey:key,keyId,...options});
    assert.equal(await worker.runOnce(),null);
  }
  assert.equal(calls,0);
  assert.deepEqual((await pool.query("SELECT status,attempts FROM jobs WHERE kind='deliver_group_reply'")).rows[0],{status:'pending',attempts:0});
});

dbtest('group delivery re-evaluates DB policy at the final dispatch instant',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  await pool.query("UPDATE group_sources SET policy=$1 WHERE id='group-source'",[JSON.stringify({businessHours:{timeZone:'UTC',days:[4],start:'00:00',end:'24:00'},rateLimits:{organization:10,source:10,conversation:10}})]);
  const service=createInboxService({pool,clock:()=>instant});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let calls=0;
  const worker=createGroupDeliveryWorker({pool,client:{reply:async()=>{calls++;throw Error('must not dispatch');}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>new Date('2026-10-23T12:00:00.000Z'),policyClock:()=>new Date('2026-10-23T12:00:00.000Z')});
  const result=await worker.deliverGroupIntent(intent.id);assert.equal(result.state,'cancelled');assert.equal(result.code,'FINAL_POLICY_GATE');assert.equal(calls,0);
});

dbtest('aged interrupted attempts become audited terminal unknown without dispatch and direct rerun cannot reclaim them',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);
  const command=signCommand({...baseCommand({operationId:'interrupted',sourceId:'group-source'}),text:reply.content.text,textHash:hash(reply.content.text)},{key,keyId,now:instant});
  await pool.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES('interrupted','org_default','group-source','GroupReplyCommand',$1)",[command]);
  await pool.query("INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state,started_at) VALUES('attempt-interrupted','org_default',$1,'attempting',now()-interval '3 minutes')",[intent.id]);
  await pool.query(`INSERT INTO group_delivery_attempts(organization_id,delivery_intent_id,delivery_attempt_id,operation_id,target_id,text_hash,canonical_target,attempt_started_at,attempt_deadline_at)
    VALUES('org_default',$1,'attempt-interrupted','interrupted','comment:456:789',$2,'https://www.facebook.com/groups/123',now()-interval '3 minutes',now()-interval '2 minutes')`,[intent.id,hash(reply.content.text)]);
  let calls=0;const worker=createGroupDeliveryWorker({pool,client:{reply:async()=>{calls++;}},keys:{[keyId]:key},signingKey:key,keyId});
  assert.equal(await worker.recoverInterruptedAttempts(),1);
  assert.deepEqual((await pool.query("SELECT state,outcome_code FROM delivery_attempts WHERE id='attempt-interrupted'")).rows[0],{state:'unknown',outcome_code:'ATTEMPT_INTERRUPTED'});
  assert.deepEqual((await pool.query("SELECT status,last_error FROM jobs WHERE kind='deliver_group_reply'")).rows[0],{status:'failed',last_error:'ATTEMPT_INTERRUPTED'});
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_entries WHERE action='delivery.unknown' AND entity_id=$1",[intent.id])).rows[0].n,1);
  assert.equal((await worker.deliverGroupIntent(intent.id)).state,'unknown');assert.equal(calls,0);
});

dbtest('lost gate COMMIT acknowledgement is recovered to terminal unknown without dispatch',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let calls=0;
  const failing=createGroupDeliveryWorker({pool:failCommitOnConnection(pool,2),client:{reply:async()=>{calls++;}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const unresolved=await failing.deliverGroupIntent(intent.id);assert.equal(unresolved.state,'unknown');assert.equal(calls,0,'a lost gate commit acknowledgement must never dispatch');
  assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'attempting');
  await pool.query("UPDATE delivery_attempts SET started_at=$2 WHERE delivery_intent_id=$1",[intent.id,new Date(instant-180000)]);
  const recovered=createGroupDeliveryWorker({pool,client:{reply:async()=>{calls++;}},keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const final=await recovered.deliverGroupIntent(intent.id);assert.equal(final.state,'unknown');assert.equal(final.code,'ATTEMPT_INTERRUPTED');assert.equal(calls,0);
});

dbtest('failed outcome settlement leaves an aging attempt that direct rerun safely finalizes',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let calls=0;
  const client={reply:async command=>{calls++;return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'sent',senderId:'sender-1',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'8'.repeat(64),remoteId:'remote-lost-settlement'},{key,keyId,now:instant});}};
  const failing=createGroupDeliveryWorker({pool:failSettlementOnConnection(pool,3),client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const unresolved=await failing.deliverGroupIntent(intent.id);assert.equal(unresolved.state,'unknown');assert.equal(calls,1);
  assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'attempting');
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_send_receipts WHERE delivery_intent_id=$1',[intent.id])).rows[0].n,0,'rolled-back settlement evidence is not trusted');
  await pool.query("UPDATE delivery_attempts SET started_at=$2 WHERE delivery_intent_id=$1",[intent.id,new Date(instant-180000)]);
  const recovered=createGroupDeliveryWorker({pool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
  const final=await recovered.deliverGroupIntent(intent.id);assert.equal(final.state,'unknown');assert.equal(final.code,'ATTEMPT_INTERRUPTED');assert.equal(calls,1,'direct rerun must not redispatch');
});

dbtest('lost or unsigned transport outcome keeps an untrusted reconciliation seed and can reconcile without resend',async({pool,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);let replies=0,now=instant;
  const client={reply:async()=>{replies++;throw Error('lost signed response');},reconcile:async command=>{
    assert.equal(command.senderId,null);assert.equal(typeof command.attemptOperationId,'string');
    return signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>name!=='signature')),kind:'ReconcileResult',state:'sent',senderId:'sender-recovered',attemptStartedAt:command.attemptStartedAt,attemptFinishedAt:command.attemptFinishedAt,evidenceHash:'9'.repeat(64),remoteId:'remote-recovered'},{key,keyId,now});
  }};
  const worker=createGroupDeliveryWorker({pool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>now,policyClock:()=>now});
  assert.equal((await worker.deliverGroupIntent(intent.id)).state,'unknown');
  const seed=(await pool.query('SELECT * FROM group_delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0];
  assert.equal(seed.canonical_target,'https://www.facebook.com/groups/123');assert.equal(seed.sender_id,null);assert.ok(seed.attempt_started_at);assert.ok(seed.attempt_deadline_at);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_send_receipts WHERE delivery_intent_id=$1',[intent.id])).rows[0].n,0,'unsigned failure is not trusted receipt evidence');
  now=new Date('2026-10-22T12:06:00.000Z');
  assert.equal((await worker.reconcileGroupIntent(intent.id)).state,'sent');assert.equal(replies,1);
});

dbtest('only the restricted worker role can write immutable group attempt evidence',async({pool,admin,schema,actor,workItemId})=>{
  const {createInboxService}=await import('../src/inbox/service.mjs');const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');const {provisionRuntime}=await import('./provision-runtime.mjs');
  const service=createInboxService({pool});const reply=await service.prepareReply(workItemId,1,actor);const intent=await service.approveAndQueue(reply.id,1,actor);
  const suffix=randomUUID().replaceAll('-','').slice(0,12),workerRole=`gd_worker_${suffix}`,webRole=`gd_web_${suffix}`,password='runtime-test-password-123';let workerPool,webPool;
  try {
    await provisionRuntime(pool,{role:workerRole,password,profile:'worker'});await provisionRuntime(pool,{role:webRole,password,profile:'web'});
    const runtimeUrl=role=>{const url=new URL(process.env.TEST_DATABASE_URL);url.username=role;url.password=password;url.searchParams.set('options',`-c search_path=${schema}`);return url.href;};
    workerPool=createPool({databaseUrl:runtimeUrl(workerRole)});webPool=createPool({databaseUrl:runtimeUrl(webRole)});
    const client={reply:async command=>signResult({...Object.fromEntries(Object.entries(command).filter(([name])=>!['signature','text'].includes(name))),kind:'GroupReplyResult',state:'sent',senderId:'sender-role',attemptStartedAt:instant.toISOString(),attemptFinishedAt:instant.toISOString(),evidenceHash:'7'.repeat(64),remoteId:'remote-role'},{key,keyId,now:instant})};
    const worker=createGroupDeliveryWorker({pool:workerPool,client,keys:{[keyId]:key},signingKey:key,keyId,clock:()=>instant,policyClock:()=>instant});
    assert.equal((await worker.deliverGroupIntent(intent.id)).state,'sent','worker role writes attempt seed and signed receipt');
    assert.equal((await webPool.query('SELECT count(*)::int n FROM group_delivery_attempts')).rows[0].n,1);assert.equal((await webPool.query('SELECT count(*)::int n FROM group_send_receipts')).rows[0].n,1);
    for(const statement of ['INSERT INTO group_delivery_attempts DEFAULT VALUES','UPDATE group_delivery_attempts SET sender_id=sender_id','DELETE FROM group_delivery_attempts','INSERT INTO group_send_receipts DEFAULT VALUES','UPDATE group_send_receipts SET state=state','DELETE FROM group_send_receipts']) {
      await assert.rejects(webPool.query(statement),error=>error.code==='42501',statement);
    }
  } finally {
    await workerPool?.end();await webPool?.end();
    for(const role of [workerRole,webRole]) {await admin.query(`DROP OWNED BY "${role}"`);await admin.query(`DROP ROLE "${role}"`);}
  }
});
