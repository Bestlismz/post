import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';
import {signCommand,verifyCommand} from '../src/channels/groups/contracts.mjs';

const key='s'.repeat(32),keyId='schedule-test';
async function dropConcurrentTestRole(client,role) {
  for(let attempt=0;attempt<10;attempt++) {
    try {await client.query(`DROP OWNED BY "${role}"`);await client.query(`DROP ROLE "${role}"`);return;}
    catch(error) {if(error.code!=='XX000'||!/tuple concurrently updated/i.test(error.message)||attempt===9)throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
  }
}

async function fixture(fn) {
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});
  const schema=`scheduler_${randomUUID().replaceAll('-','')}`;let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await pool.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES('admin','scheduler@test','x','Admin');
      INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','admin','admin');
      INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
      VALUES('source-1','org_default','123','https://www.facebook.com/groups/123','approval',true,'healthy','healthy','facebook-dom-v2')`);
    await fn({pool,admin,schema});
  } finally {await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
}
const integration=(name,fn)=>test(name,{skip:!process.env.TEST_DATABASE_URL},()=>fixture(fn));

test('group scheduler signing configuration is explicit bounded and supports key rotation',async()=>{
  const {groupSchedulerConfig}=await import('../src/workers/scheduler.mjs');
  assert.equal(groupSchedulerConfig({}),null);
  const encoded=Buffer.alloc(32,7).toString('base64'),config=groupSchedulerConfig({GROUP_COMMAND_KEY_ID:'current',GROUP_COMMAND_KEYS:JSON.stringify({old:Buffer.alloc(32,6).toString('base64'),current:encoded})});
  assert.equal(config.keyId,'current');assert.deepEqual(config.key,Buffer.alloc(32,7));assert.deepEqual(config.keys.old,Buffer.alloc(32,6));
  for(const env of [{GROUP_COMMAND_KEY_ID:'current'},{GROUP_COMMAND_KEYS:'{}'},{GROUP_COMMAND_KEY_ID:'current',GROUP_COMMAND_KEYS:'bad'},{GROUP_COMMAND_KEY_ID:'current',GROUP_COMMAND_KEYS:JSON.stringify({current:'c2hvcnQ='})}])assert.throws(()=>groupSchedulerConfig(env),/scheduler signing/i);
});

test('schedule decisions use IANA local time across DST and reject maintenance windows and daily limits',async()=>{
  const {evaluateSchedule}=await import('../src/workers/scheduler.mjs');
  const schedule={enabled:true,cadenceMinutes:15,timeZone:'America/New_York',days:[0],start:'01:00',end:'04:00',dailyLimit:8,maintenanceWindows:[]};
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T06:30:00Z'),{completedToday:0}),{eligible:true,reasons:[],localDay:'2026-03-08',slot:'2026-03-08T06:30:00.000Z'});
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T08:00:00Z'),{completedToday:0}).reasons,['OUTSIDE_SCHEDULE_WINDOW']);
  assert.deepEqual(evaluateSchedule({...schedule,maintenanceWindows:[{startsAt:'2026-03-08T06:00:00Z',endsAt:'2026-03-08T07:00:00Z'}]},new Date('2026-03-08T06:30:00Z'),{completedToday:0}).reasons,['MAINTENANCE_WINDOW']);
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T06:30:00Z'),{completedToday:8}).reasons,['DAILY_LIMIT_REACHED']);
  assert.equal(evaluateSchedule(schedule,new Date('2026-03-08T06:30:19Z'),{completedToday:0},{cadenceOverrideMs:10000}).slot,'2026-03-08T06:30:10.000Z');
  assert.throws(()=>evaluateSchedule(schedule,new Date(),{},{cadenceOverrideMs:999}),/cadence override/i);
});

integration('ten-second test cadence creates one job per slot without overlap',async({pool})=>{
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',1440)`);
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  const scheduler=createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2'],cadenceOverrideMs:10000});
  const [a,b]=await Promise.all([scheduler.tick(),scheduler.tick()]);
  assert.equal(a.scheduled+b.scheduled,1);
  const {rows:[receipt]}=await pool.query('SELECT schedule_slot,schedule_snapshot FROM group_schedule_receipts');
  assert.equal(receipt.schedule_snapshot.testCadenceMs,10000);
  assert.equal(+new Date(receipt.schedule_slot)%10000,0);
});

test('scheduler deadline releases a database client acquired after the tick already timed out',async()=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');let released=0;
  const pool={connect:()=>new Promise(resolve=>setTimeout(()=>resolve({release(){released++;}}),30))};
  const scheduler=createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2'],tickTimeoutMs:10});
  await assert.rejects(scheduler.tick(),error=>error.code==='SCHEDULER_TICK_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(released,1);
});

test('a blocked rollback is bounded and destroyed without masking the operational error',async()=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs'),primary=Object.assign(Error('primary sql failure'),{code:'XX001'});const queries=[],releases=[];
  const client={query(query){const text=typeof query==='string'?query:query.text;queries.push(text);if(text.includes('clock_timestamp'))return new Promise((_,reject)=>setTimeout(()=>reject(primary),60));if(text==='ROLLBACK')return new Promise(()=>{});return Promise.resolve({rows:[]});},release(error){releases.push(error);}};
  const scheduler=createGroupScheduler({pool:{connect:async()=>client},supportedSelectorVersions:['facebook-dom-v2'],tickTimeoutMs:100});const started=performance.now();
  const outcome=await Promise.race([scheduler.tick().then(()=>({resolved:true}),error=>({error})),new Promise(resolve=>setTimeout(()=>resolve({hung:true}),250))]);
  assert.equal(outcome.error,primary);assert.ok(performance.now()-started<180);assert.deepEqual(releases,[true]);assert.equal(queries.some(query=>/INSERT/u.test(query)),false);
});

test('signal during rollback wins promptly and destroys the connection without an orphan query',async()=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs'),primary=Object.assign(Error('primary sql failure'),{code:'XX001'}),signalError=Error('shutdown');let rollbackStarted;const rollback=new Promise(resolve=>rollbackStarted=resolve),queries=[],releases=[];
  const client={query(query){const text=typeof query==='string'?query:query.text;queries.push(text);if(text.includes('clock_timestamp'))return Promise.reject(primary);if(text==='ROLLBACK'){rollbackStarted();return new Promise(()=>{});}return Promise.resolve({rows:[]});},release(error){releases.push(error);}};
  const scheduler=createGroupScheduler({pool:{connect:async()=>client},supportedSelectorVersions:['facebook-dom-v2'],tickTimeoutMs:1000}),controller=new AbortController(),started=performance.now();
  const tick=scheduler.tick({signal:controller.signal});await rollback;controller.abort(signalError);
  const outcome=await Promise.race([tick.then(()=>({resolved:true}),error=>({error})),new Promise(resolve=>setTimeout(()=>resolve({hung:true}),200))]);
  assert.equal(outcome.error,signalError);assert.ok(performance.now()-started<150);assert.deepEqual(releases,[true]);assert.equal(queries.some(query=>/INSERT/u.test(query)),false);
});

integration('concurrent scheduler ticks create one durable unsigned job per source slot',async({pool})=>{
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  const scheduler=createGroupScheduler({pool,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']});
  const [a,b]=await Promise.all([scheduler.tick(),scheduler.tick()]);
  assert.equal(a.scheduled+b.scheduled,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan'")).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_operations WHERE kind='ScanCommand'")).rows[0].n,0,'commands are signed only at dispatch');
  const {rows:[receipt]}=await pool.query('SELECT id,state,reason_codes,operation_id,job_id FROM group_schedule_receipts');
  assert.equal(receipt.state,'scheduled');assert.deepEqual(receipt.reason_codes,[]);assert.equal(receipt.operation_id,null);assert.ok(receipt.job_id);
  const payload=(await pool.query('SELECT payload FROM jobs WHERE id=$1',[receipt.job_id])).rows[0].payload;
  assert.deepEqual(Object.keys(payload).sort(),['scheduleReceiptId','scheduleSlot','sourceId']);assert.equal(payload.sourceId,'source-1');assert.equal(payload.scheduleReceiptId,receipt.id);assert.match(payload.scheduleSlot,/Z$/);assert.equal(Object.hasOwn(payload,'operationId'),false);
  await assert.rejects(pool.query("UPDATE group_schedule_receipts SET state='skipped'"),/append-only/i);
});

integration('production Group scan worker consumes a scheduled job and persists its signed result',async({pool})=>{
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,1,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',1440)`);
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  await createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2']}).tick();
  const [{createGroupScanWorker},{createGroupResultService},{signResult}]=await Promise.all([import('../src/workers/group-scan-worker.mjs'),import('../src/workers/group-results.mjs'),import('../src/channels/groups/contracts.mjs')]);
  const keys={[keyId]:Buffer.from(key)},results=createGroupResultService(pool,{keys,signingKey:Buffer.from(key),keyId,supportedSelectorVersions:['facebook-dom-v2']});let scanned=0;
  const worker=createGroupScanWorker({pool,workerId:'scheduled-test',keys,keyId,signingKey:Buffer.from(key),results,client:{async scan(command){scanned++;const {signature,...body}=command,now=new Date();return signResult({...body,kind:'ScanResult',issuedAt:now.toISOString(),expiresAt:new Date(+now+60000).toISOString(),selectorVersion:'facebook-dom-v2',coverage:'partial',health:'healthy',reason:'scan_limit',cursor:null,observations:[]},{key:Buffer.from(key),keyId,now});}}});
  assert.equal(typeof await worker.runOnce(),'string');assert.equal(scanned,1);
  assert.equal((await pool.query("SELECT status FROM jobs WHERE kind='group.scan'")).rows[0].status,'completed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_scan_receipts')).rows[0].n,1);
});

integration('scheduler persists explicit refusal reasons for pauses health circuits maintenance and daily limit',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  const scheduler=createGroupScheduler({pool,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']});
  await pool.query(`INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
      VALUES('source-2','org_default','124','https://www.facebook.com/groups/124','approval',true,'healthy','healthy','facebook-dom-v2'),
            ('source-3','org_default','125','https://www.facebook.com/groups/125','approval',true,'failed','failed','facebook-dom-v2');
    INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit,maintenance_windows)
      VALUES('org_default','source-1',true,1,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20,'[]')`);
  await pool.query("UPDATE organizations SET group_automation_paused=true WHERE id='org_default'");
  assert.equal((await scheduler.tick()).scheduled,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_schedule_receipts WHERE reason_codes='{GLOBAL_PAUSED}'")).rows[0].n,1);
  await pool.query("INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit,maintenance_windows) VALUES('org_default','source-2',true,1,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20,'[]'); UPDATE organizations SET group_automation_paused=false; UPDATE group_sources SET kill_switch=true WHERE id='source-2'");
  assert.equal((await scheduler.tick()).scheduled,0);
  assert.deepEqual((await pool.query("SELECT reason_codes FROM group_schedule_receipts WHERE source_id='source-2' ORDER BY created_at DESC LIMIT 1")).rows[0].reason_codes,['SOURCE_PAUSED']);
  await pool.query("INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit,maintenance_windows) VALUES('org_default','source-3',true,2,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20,'[]'); UPDATE group_sources SET session_circuit=true,selector_circuit=true WHERE id='source-3'");
  assert.equal((await scheduler.tick()).scheduled,0);
  assert.deepEqual((await pool.query("SELECT reason_codes FROM group_schedule_receipts WHERE source_id='source-3' ORDER BY created_at DESC LIMIT 1")).rows[0].reason_codes,['SESSION_UNHEALTHY','SESSION_CIRCUIT_OPEN','SELECTOR_UNHEALTHY','SELECTOR_CIRCUIT_OPEN']);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan'")).rows[0].n,0);
});

integration('global and source pause prevent new group delivery leases without changing attempts already in flight',async({pool})=>{
  const {createGroupDeliveryWorker}=await import('../src/workers/group-delivery-worker.mjs');
  await pool.query(`INSERT INTO conversations(id,organization_id,channel,page_id,psid,processing_revision) VALUES('conversation','org_default','facebook_group','facebook_group:123','facebook_group_target:456',1);
    INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence) VALUES('message','org_default','conversation','facebook_group:123','facebook_group_message:post:456:1:a','x',1,'{}');
    INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision,status) VALUES('work','org_default','conversation','message',1,'ready');
    INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context) VALUES('reply','org_default','work','conversation',1,1,'{"text":"x"}','{}');
    INSERT INTO reply_authorizations(id,organization_id,reply_version_id,work_item_id,actor_kind,evidence) VALUES('authorization','org_default','reply','work','human','{}');
    INSERT INTO delivery_intents(id,organization_id,source_id,group_source_id,conversation_id,reply_version_id,authorization_id,content)
      VALUES('intent','org_default',NULL,'source-1','conversation','reply','authorization','{"text":"x"}');
    INSERT INTO jobs(id,organization_id,kind,payload) VALUES('delivery-job','org_default','deliver_group_reply','{"deliveryIntentId":"intent"}');
    INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES('evidence-op','org_default','source-1','ScanCommand','{}');
    INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,response) VALUES('evidence-op','org_default','source-1','${'a'.repeat(64)}','facebook-dom-v2','complete','healthy','{}')`);
  await pool.query("UPDATE organizations SET group_automation_paused=true WHERE id='org_default'");
  const worker=createGroupDeliveryWorker({pool,client:{},keys:{[keyId]:key},signingKey:key,keyId});
  assert.equal(await worker.runOnce(),null);
  assert.deepEqual((await pool.query("SELECT status,attempts FROM jobs WHERE id='delivery-job'")).rows[0],{status:'pending',attempts:0});
  assert.equal((await pool.query("SELECT count(*)::int n FROM delivery_attempts")).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_scan_receipts WHERE operation_id='evidence-op'")).rows[0].n,1);
  await pool.query("UPDATE organizations SET group_automation_paused=false; UPDATE group_sources SET kill_switch=true WHERE id='source-1'");
  assert.equal(await worker.runOnce(),null);
  assert.deepEqual((await pool.query("SELECT status,attempts FROM jobs WHERE id='delivery-job'")).rows[0],{status:'pending',attempts:0});
});

integration('generic scan leasing leaves paused or unhealthy group jobs pending until every gate recovers',async({pool})=>{
  const {claimJobs}=await import('../src/jobs/queue.mjs');
  await pool.query("INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES('scan-pending','org_default','group.scan','{\"sourceId\":\"source-1\",\"scheduleSlot\":\"2026-10-22T00:00:00.000Z\"}',true); UPDATE organizations SET group_automation_paused=true WHERE id='org_default'");
  assert.deepEqual(await claimJobs(pool,'scan-worker',1),[]);
  assert.deepEqual((await pool.query("SELECT status,attempts FROM jobs WHERE id='scan-pending'")).rows[0],{status:'pending',attempts:0});
  await pool.query("UPDATE organizations SET group_automation_paused=false; UPDATE group_sources SET session_health='failed' WHERE id='source-1'");
  assert.deepEqual(await claimJobs(pool,'scan-worker',1),[]);
  await pool.query("UPDATE group_sources SET session_health='healthy' WHERE id='source-1'");
  const [claimed]=await claimJobs(pool,'scan-worker',1);assert.equal(claimed.id,'scan-pending');assert.equal(claimed.attempts,1);
});

integration('restricted worker can schedule but cannot administer schedules controls or receipts',async({pool,admin,schema})=>{
  const {provisionRuntime}=await import('./provision-runtime.mjs');const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  const role=`scheduler_worker_${randomUUID().replaceAll('-','').slice(0,12)}`,password='scheduler-password-12345';let runtime;
  try {
    await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
      VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
    await provisionRuntime(pool,{role,password,profile:'worker'});
    const url=new URL(process.env.TEST_DATABASE_URL);url.username=role;url.password=password;url.searchParams.set('options',`-c search_path=${schema}`);runtime=createPool({databaseUrl:url.href});
    assert.equal((await createGroupScheduler({pool:runtime,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']}).tick()).scheduled,1);
    const {claimJobs}=await import('../src/jobs/queue.mjs');const [job]=await claimJobs(runtime,'restricted-scan',1);
    const {prepareGroupScanDispatch}=await import('../src/workers/group-scan-dispatch.mjs');
    const dispatched=await prepareGroupScanDispatch({pool:runtime,jobId:job.id,leaseOwner:job.lease_owner,signingKey:key,keyId,keys:{[keyId]:key}});
    assert.ok(dispatched.operationId);assert.equal((await pool.query("SELECT operation_id FROM group_schedule_receipts")).rows[0].operation_id,null);
    assert.deepEqual((await pool.query('SELECT operation_id,reason_code FROM group_scan_dispatches')).rows,[{operation_id:dispatched.operationId,reason_code:'COMMAND_FRESH'}]);
    await assert.rejects(runtime.query("UPDATE group_source_schedules SET enabled=false"),error=>error.code==='42501');
    await assert.rejects(runtime.query("UPDATE group_schedule_receipts SET state='skipped'"),error=>error.code==='42501');
    await assert.rejects(runtime.query('SELECT * FROM automation_control_receipts'),error=>error.code==='42501');
    await assert.rejects(runtime.query("UPDATE group_scan_dispatches SET reason_code='COMMAND_REFRESHED'"),error=>error.code==='42501');
  } finally {
    await runtime?.end();const client=await admin.connect();try {await dropConcurrentTestRole(client,role);}finally{client.release();}
  }
});

integration('one invalid persisted timezone fails closed with a receipt and does not block another due source',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  await pool.query(`INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
      VALUES('source-2','org_default','124','https://www.facebook.com/groups/124','approval',true,'healthy','healthy','facebook-dom-v2');
    INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
      VALUES('org_default','source-1',true,15,'Mars/Olympus','{0,1,2,3,4,5,6}','00:00','24:00',20),
            ('org_default','source-2',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const result=await createGroupScheduler({pool,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']}).tick();
  assert.deepEqual(result,{considered:2,scheduled:1,skipped:1});
  assert.deepEqual((await pool.query("SELECT state,reason_codes FROM group_schedule_receipts WHERE source_id='source-1'")).rows[0],{state:'skipped',reason_codes:['INVALID_SCHEDULE']});
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan' AND payload->>'sourceId'='source-2'")).rows[0].n,1);
});

integration('production scheduler loop turns stored API schedule state into a job and shutdown stops polling',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');const {runScheduler}=await import('../src/workers/runner.mjs');
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const scheduler=createGroupScheduler({pool,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']}),controller=new AbortController();let ticks=0;
  await runScheduler({scheduler:{async tick(){ticks++;const result=await scheduler.tick();if(result.scheduled)controller.abort();return result;}},signal:controller.signal,pollMs:1});
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan'")).rows[0].n,1);const stopped=ticks;
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(ticks,stopped);
});

integration('large source sets are processed in bounded batches without duplicate jobs',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  for(let index=2;index<=5;index++)await pool.query(`INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
    VALUES($1,'org_default',$2,$3,'approval',true,'healthy','healthy','facebook-dom-v2')`,[`source-${index}`,String(200+index),`https://www.facebook.com/groups/${200+index}`]);
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    SELECT organization_id,id,true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20 FROM group_sources`);
  const scheduler=createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2'],batchSize:2,tickTimeoutMs:1000});
  assert.deepEqual((await scheduler.tick()).scheduled,2);assert.deepEqual((await scheduler.tick()).scheduled,2);assert.deepEqual((await scheduler.tick()).scheduled,1);
  await scheduler.tick();
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan'")).rows[0].n,5);
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_schedule_receipts WHERE state='scheduled'")).rows[0].n,5);
});

integration('a blocked scheduler query is server-cancelled and SIGTERM-like abort drains the active tick',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');const {runScheduler}=await import('../src/workers/runner.mjs');
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const blocker=await pool.connect(),controller=new AbortController(),events=[];await blocker.query('BEGIN');await blocker.query("SELECT id FROM organizations WHERE id='org_default' FOR UPDATE");
  const scheduler=createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2'],batchSize:5,tickTimeoutMs:100});const started=Date.now();
  const running=runScheduler({scheduler,signal:controller.signal,pollMs:1,onEvent:event=>events.push(event)});setTimeout(()=>controller.abort(),20);
  try {await running;} finally {await blocker.query('ROLLBACK');blocker.release();}
  assert.ok(Date.now()-started<1000,'server statement timeout must bound the active query inside shutdown grace');
  assert.deepEqual(events,[],'shutdown cancellation is not reported as an operational tick failure');
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_schedule_receipts')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n,0);
});

integration('one tick deadline spans sequential statements and rolls back before any late write',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const organizationBlocker=await pool.connect(),sourceBlocker=await pool.connect();
  await organizationBlocker.query('BEGIN');await organizationBlocker.query("SELECT id FROM organizations WHERE id='org_default' FOR UPDATE");
  await sourceBlocker.query('BEGIN');await sourceBlocker.query("SELECT id FROM group_sources WHERE id='source-1' FOR UPDATE");
  const started=performance.now(),scheduler=createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2'],batchSize:5,tickTimeoutMs:100});let elapsed;
  const releaseOrganization=setTimeout(()=>organizationBlocker.query('ROLLBACK'),75),releaseSource=setTimeout(()=>sourceBlocker.query('ROLLBACK'),150);
  try {await assert.rejects(scheduler.tick(),error=>error.code==='57014'||error.code==='SCHEDULER_TICK_TIMEOUT');elapsed=performance.now()-started;}
  finally {clearTimeout(releaseOrganization);clearTimeout(releaseSource);await organizationBlocker.query('ROLLBACK').catch(()=>{});await sourceBlocker.query('ROLLBACK').catch(()=>{});organizationBlocker.release();sourceBlocker.release();}
  assert.ok(elapsed<135,`two individually sub-budget waits must not reset the total tick deadline (${elapsed}ms)`);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_schedule_receipts')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM jobs')).rows[0].n,0);
});

integration('a source paused after claim is released without signing or dispatching a scan',async({pool})=>{
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  await createGroupScheduler({pool,supportedSelectorVersions:['facebook-dom-v2']}).tick();
  const {claimJobs}=await import('../src/jobs/queue.mjs');const [job]=await claimJobs(pool,'scan-runtime',1);
  await pool.query("UPDATE group_sources SET kill_switch=true WHERE id='source-1'");
  const {prepareGroupScanDispatch}=await import('../src/workers/group-scan-dispatch.mjs');
  await assert.rejects(prepareGroupScanDispatch({pool,jobId:job.id,leaseOwner:job.lease_owner,signingKey:key,keyId,keys:{[keyId]:key}}),error=>error.code==='SOURCE_UNAVAILABLE');
  assert.deepEqual((await pool.query('SELECT status,lease_owner,attempts FROM jobs WHERE id=$1',[job.id])).rows[0],{status:'pending',lease_owner:null,attempts:1});
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_operations WHERE kind='ScanCommand'")).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM group_scan_dispatches')).rows[0].n,0);
});

integration('a scheduled scan delayed beyond signature expiry gets one fresh dispatch command without changing slot identity',async({pool})=>{
  const old=new Date('2026-10-22T12:00:00.000Z'),now=new Date('2026-10-22T12:06:00.000Z');
  const original=signCommand({version:1,kind:'ScanCommand',operationId:'scheduled-op',sourceId:'source-1',groupId:'123',canonicalTarget:'https://www.facebook.com/groups/123',issuedAt:old.toISOString(),expiresAt:new Date(+old+300000).toISOString(),keyId},{key,keyId,now:old});
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit) VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  await pool.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) VALUES('scheduled-op','org_default','source-1','ScanCommand',$1)",[original]);
  await pool.query("INSERT INTO jobs(id,organization_id,kind,payload,retry_safe,available_at) VALUES('scheduled-job','org_default','group.scan','{\"operationId\":\"scheduled-op\",\"sourceId\":\"source-1\",\"scheduleSlot\":\"2026-10-22T12:00:00.000Z\",\"scheduleReceiptId\":\"schedule-receipt\"}',true,$1)",[old]);
  await pool.query("INSERT INTO group_schedule_receipts(id,organization_id,source_id,schedule_slot,local_day,state,reason_codes,operation_id,job_id,schedule_snapshot) VALUES('schedule-receipt','org_default','source-1',$1,'2026-10-22','scheduled','{}','scheduled-op','scheduled-job','{}')",[old]);
  await pool.query("UPDATE group_sources SET kill_switch=true WHERE id='source-1'");
  const {claimJobs}=await import('../src/jobs/queue.mjs');assert.deepEqual(await claimJobs(pool,'scan-runtime',1),[]);
  await pool.query("UPDATE group_sources SET kill_switch=false WHERE id='source-1'");
  const [job]=await claimJobs(pool,'scan-runtime',1);assert.equal(job.id,'scheduled-job');
  const {prepareGroupScanDispatch}=await import('../src/workers/group-scan-dispatch.mjs');
  const [first,second]=await Promise.all([prepareGroupScanDispatch({pool,jobId:job.id,leaseOwner:job.lease_owner,signingKey:key,keyId,keys:{[keyId]:key},clock:()=>now}),prepareGroupScanDispatch({pool,jobId:job.id,leaseOwner:job.lease_owner,signingKey:key,keyId,keys:{[keyId]:key},clock:()=>now})]);
  assert.deepEqual(first,second);assert.notEqual(first.operationId,'scheduled-op');assert.doesNotThrow(()=>verifyCommand(first,{keys:{[keyId]:key},now}));
  assert.throws(()=>verifyCommand(original,{keys:{[keyId]:key},now}),/expired/i);
  assert.deepEqual((await pool.query("SELECT operation_id,job_id FROM group_schedule_receipts WHERE id='schedule-receipt'")).rows[0],{operation_id:'scheduled-op',job_id:'scheduled-job'});
  assert.deepEqual((await pool.query("SELECT predecessor_operation_id,operation_id,reason_code FROM group_scan_dispatches")).rows,[{predecessor_operation_id:'scheduled-op',operation_id:first.operationId,reason_code:'COMMAND_REFRESHED'}]);
});
