import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';
import {bootstrapAdmin} from '../src/auth/bootstrap.mjs';
import {createApplicationRouter} from '../src/http/auth-routes.mjs';
import {evaluatePolicy} from '../src/policy/evaluator.mjs';

async function startServer(app) {const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));return {server};}
async function loginRequest(base,{email,password,origin}) {
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]};
}

test('policy preview is the production evaluator for authorization and refusal paths',async()=>{
  const {previewPolicy}=await import('../src/policy/preview.mjs');
  const policy={mode:'automatic',minimumConfidence:.8,rateLimits:{organization:10,source:5,conversation:2},businessHours:{timeZone:'Asia/Bangkok',days:[4],start:'08:00',end:'18:00'}};
  const now=new Date('2026-10-22T03:00:00Z');
  const eligible={grounded:true,automaticEligible:true,confidence:.9,sourceHealth:'connected',replyWindowOpen:true,optOut:false,humanTakeover:false,counts:{organization:0,source:0,conversation:0}};
  assert.deepEqual(previewPolicy(eligible,policy,now),evaluatePolicy(policy,eligible,now));
  const refused={...eligible,confidence:.2,optOut:true};
  assert.deepEqual(previewPolicy(refused,policy,now),{action:'review',reasons:['confidence','opt_out']});
});

test('automation control routes are admin-only idempotent and persist audited receipts without touching jobs', {skip:!process.env.TEST_DATABASE_URL},async()=>{
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});const schema=`automation_http_${randomUUID().replaceAll('-','')}`;let pool,server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await bootstrapAdmin(pool,{email:'admin@test.local',password:'long-password-123',displayName:'Admin'});
    await pool.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES('operator','operator@test.local','x','Operator');
      INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','operator','operator');
      INSERT INTO group_sources(id,organization_id,group_id,canonical_url) VALUES('source-1','org_default','123','https://www.facebook.com/groups/123');
      INSERT INTO jobs(id,organization_id,kind,payload,status,lease_owner,lease_expires_at,attempts) VALUES('running-job','org_default','group.scan','{}','running','owner',now()+interval '1 minute',1)`);
    const {createAutomationRouter}=await import('../src/http/automation-routes.mjs');
    const app=express();app.use(express.json());app.use(createApplicationRouter({pool,config:{appOrigin:'https://radar.example',nodeEnv:'test'}}));app.use(createAutomationRouter({pool,config:{appOrigin:'https://radar.example'}}));
    ({server}=await startServer(app));const base=`http://127.0.0.1:${server.address().port}`;
    const login=await loginRequest(base,{email:'admin@test.local',password:'long-password-123',origin:'https://radar.example'});
    const headers={Origin:'https://radar.example','Content-Type':'application/json',Cookie:login.cookie,'X-CSRF-Token':login.body.csrfToken,'Idempotency-Key':'pause-global'};
    const first=await fetch(base+'/api/automation/pause',{method:'POST',headers,body:JSON.stringify({paused:true})});assert.equal(first.status,200);const firstBody=await first.json();
    const second=await fetch(base+'/api/automation/pause',{method:'POST',headers,body:JSON.stringify({paused:true})});assert.equal(second.status,200);assert.deepEqual(await second.json(),firstBody);
    assert.equal((await pool.query("SELECT group_automation_paused FROM organizations WHERE id='org_default'")).rows[0].group_automation_paused,true);
    assert.deepEqual((await pool.query("SELECT status,lease_owner,attempts FROM jobs WHERE id='running-job'")).rows[0],{status:'running',lease_owner:'owner',attempts:1});
    assert.equal((await pool.query("SELECT count(*)::int n FROM automation_control_receipts WHERE scope='organization'")).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_entries WHERE action='automation.pause_changed'")).rows[0].n,1);
    const schedule={enabled:true,cadenceMinutes:10,timeZone:'Asia/Bangkok',days:[1,2,3,4,5],start:'08:30',end:'18:00',dailyLimit:24,maintenanceWindows:[{startsAt:'2026-10-23T00:00:00.000Z',endsAt:'2026-10-23T01:00:00.000Z'}]};
    const scheduleHeaders={...headers,'Idempotency-Key':'schedule-create','If-Match':'"0"'};
    const created=await fetch(base+'/api/automation/sources/source-1/schedule',{method:'PUT',headers:scheduleHeaders,body:JSON.stringify(schedule)});
    assert.equal(created.status,200);assert.equal(created.headers.get('etag'),'"1"');assert.deepEqual((await created.json()).schedule,schedule);
    const stale=await fetch(base+'/api/automation/sources/source-1/schedule',{method:'PUT',headers:{...scheduleHeaders,'Idempotency-Key':'schedule-stale'},body:JSON.stringify({...schedule,dailyLimit:10})});assert.equal(stale.status,409);
    const invalid=await fetch(base+'/api/automation/sources/source-1/schedule',{method:'PUT',headers:{...scheduleHeaders,'Idempotency-Key':'schedule-invalid','If-Match':'"1"'},body:JSON.stringify({...schedule,timeZone:'Mars/Olympus'})});assert.equal(invalid.status,422);
    assert.equal((await pool.query("SELECT daily_limit FROM group_source_schedules WHERE source_id='source-1'")).rows[0].daily_limit,24);
  } finally {if(server)await new Promise(resolve=>server.close(resolve));await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
