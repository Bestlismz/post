import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';

const key='s'.repeat(32),keyId='schedule-test';

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

test('schedule decisions use IANA local time across DST and reject maintenance windows and daily limits',async()=>{
  const {evaluateSchedule}=await import('../src/workers/scheduler.mjs');
  const schedule={enabled:true,cadenceMinutes:15,timeZone:'America/New_York',days:[0],start:'01:00',end:'04:00',dailyLimit:8,maintenanceWindows:[]};
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T06:30:00Z'),{completedToday:0}),{eligible:true,reasons:[],localDay:'2026-03-08',slot:'2026-03-08T06:30:00.000Z'});
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T08:00:00Z'),{completedToday:0}).reasons,['OUTSIDE_SCHEDULE_WINDOW']);
  assert.deepEqual(evaluateSchedule({...schedule,maintenanceWindows:[{startsAt:'2026-03-08T06:00:00Z',endsAt:'2026-03-08T07:00:00Z'}]},new Date('2026-03-08T06:30:00Z'),{completedToday:0}).reasons,['MAINTENANCE_WINDOW']);
  assert.deepEqual(evaluateSchedule(schedule,new Date('2026-03-08T06:30:00Z'),{completedToday:8}).reasons,['DAILY_LIMIT_REACHED']);
});

integration('concurrent scheduler ticks create one signed scan operation and one job per source slot',async({pool})=>{
  await pool.query(`INSERT INTO group_source_schedules(organization_id,source_id,enabled,cadence_minutes,time_zone,days,start_local,end_local,daily_limit)
    VALUES('org_default','source-1',true,15,'UTC','{0,1,2,3,4,5,6}','00:00','24:00',20)`);
  const {createGroupScheduler}=await import('../src/workers/scheduler.mjs');
  const scheduler=createGroupScheduler({pool,signingKey:key,keyId,supportedSelectorVersions:['facebook-dom-v2']});
  const [a,b]=await Promise.all([scheduler.tick(),scheduler.tick()]);
  assert.equal(a.scheduled+b.scheduled,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE kind='group.scan'")).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_operations WHERE kind='ScanCommand'")).rows[0].n,1);
  const {rows:[receipt]}=await pool.query('SELECT state,reason_codes,operation_id,job_id FROM group_schedule_receipts');
  assert.equal(receipt.state,'scheduled');assert.deepEqual(receipt.reason_codes,[]);assert.ok(receipt.operation_id);assert.ok(receipt.job_id);
  await assert.rejects(pool.query("UPDATE group_schedule_receipts SET state='skipped'"),/append-only/i);
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
    await assert.rejects(runtime.query("UPDATE group_source_schedules SET enabled=false"),error=>error.code==='42501');
    await assert.rejects(runtime.query("UPDATE group_schedule_receipts SET state='skipped'"),error=>error.code==='42501');
    await assert.rejects(runtime.query('SELECT * FROM automation_control_receipts'),error=>error.code==='42501');
  } finally {
    await runtime?.end();const client=await admin.connect();try {await client.query(`DROP OWNED BY "${role}"`);await client.query(`DROP ROLE "${role}"`);}finally{client.release();}
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
