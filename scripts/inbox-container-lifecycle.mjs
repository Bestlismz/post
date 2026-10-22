import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPool} from '../src/db/pool.mjs';
import {migrate} from '../src/db/migrate.mjs';
import {createSession} from '../src/auth/session.mjs';
import {provisionRuntime} from './provision-runtime.mjs';

// Explicit invocation after building the image. The regular suite does not
// require a local image or start Docker containers.
const image=process.env.TEST_CONTAINER_IMAGE;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(25);}throw Error('Container lifecycle barrier timed out');}
function stop(name,seconds){const child=spawn('docker',['stop','--time',String(seconds),name],{stdio:'ignore'});return new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Docker stop failed')));});}

test('production containers receive SIGTERM, drain current work, and respect the Compose grace window', {timeout:60000}, async t=>{
  assert.ok(image && process.env.TEST_DATABASE_URL,'Set TEST_CONTAINER_IMAGE and TEST_DATABASE_URL');
  const suffix=randomUUID().replaceAll('-',''),schema=`lifecycle_${suffix}`;
  const webRole=`lifecycle_web_${suffix}`,workerRole=`lifecycle_worker_${suffix}`,names=[];
  const owner=createPool({databaseUrl:process.env.TEST_DATABASE_URL});let pool,tx;
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    for(const [role,profile] of [[webRole,'web'],[workerRole,'worker']])await provisionRuntime(pool,{role,profile,password:'lifecycle-password-123'});
    await pool.query("INSERT INTO users(id,email,password_hash,display_name) VALUES('admin','lifecycle@example.com','unused','Admin'); INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','admin','admin'); INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('source','org_default','page','Page','connected')");
    const actor={id:'admin',organizationId:'org_default',role:'admin'},session=await createSession(pool,actor);
    const runtimeUrl=role=>{const runtime=new URL(url);runtime.hostname='host.docker.internal';runtime.username=role;runtime.password='lifecycle-password-123';return runtime.href;};
    const compose=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{encoding:'utf8',env:{...process.env,
      POSTGRES_PASSWORD:'lifecycle-owner-unused',RUNTIME_DATABASE_URL:'postgres://rental_radar_web:unused@postgres/postgres',
      WORKER_DATABASE_URL:'postgres://rental_radar_worker:unused@postgres/postgres',SESSION_SECRET:'x'.repeat(32)}}));
    const grace=compose.services.worker.stop_grace_period;
    assert.equal(grace,'2m0s');assert.equal(compose.services.web.stop_grace_period,grace);
    const start=(name,role,args=[])=>{
      docker(['run','--init','-d','--name',name,'--stop-timeout','120','-p','127.0.0.1::3000','-e',`DATABASE_URL=${runtimeUrl(role)}`,
        '-e','APP_ORIGIN=http://localhost:3000','-e','SESSION_SECRET=lifecycle-session-secret-over-32-characters',...args]);names.push(name);
    };
    await t.test('web closes authenticated SSE and drains a blocked accepted mutation before exit zero',async()=>{
      const name=`lifecycle-web-${suffix}`;start(name,webRole,[image]);
      await until(()=>docker(['logs',name]).includes('Application listening'));
      const port=docker(['port',name,'3000/tcp']).split(':').at(-1),base=`http://127.0.0.1:${port}`;
      const cookie=`rental_session=${session.token}`;
      const stream=await fetch(base+'/api/inbox/events',{headers:{Cookie:cookie}}),reader=stream.body.getReader();
      assert.match(Buffer.from((await reader.read()).value).toString(),/: heartbeat/);
      await pool.query("INSERT INTO conversations(id,organization_id,page_id,psid,processing_revision) VALUES('web-conv','org_default','page','web-person',1); INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence,provider_timestamp_ms) VALUES('web-msg','org_default','web-conv','page','web-mid','Hello',1,'{}',1); INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES('web-item','org_default','web-conv','web-msg',1)");
      tx=await pool.connect();await tx.query('BEGIN');await tx.query("SELECT id FROM organizations WHERE id='org_default' FOR UPDATE");
      const pending=fetch(base+'/api/inbox/web-item/prepare',{method:'POST',headers:{Cookie:cookie,Origin:'http://localhost:3000','X-CSRF-Token':session.csrfToken,'Idempotency-Key':'web-drain','If-Match':'"1"','Content-Type':'application/json'},body:'{}'}).then(response=>({response}),error=>({error}));
      try {
        await until(async()=>Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO idempotency_keys%'")).rows[0].count)>0);
        let exited=false;const stopping=stop(name,120).then(()=>exited=true);
        await until(async()=>{const chunk=await reader.read();return chunk.done;});
        await sleep(100);assert.equal(exited,false,'Active accepted mutation must drain');
        await tx.query('COMMIT');tx.release();tx=null;
        assert.equal((await pending).response?.status,202);await stopping;
        assert.equal(docker(['inspect','--format','{{.State.ExitCode}}',name]),'0');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key='web-drain' AND response_status=202")).rows[0].n,1);
      } finally {
        if(tx){await tx.query('ROLLBACK');tx.release();tx=null;}
        await pending;
        // Keep this test's queued work out of the provider barrier test.
        await pool.query("UPDATE jobs SET status='completed' WHERE payload->>'workItemId'='web-item'");
      }
    });
    await t.test('an eleven-second provider call settles after SIGTERM without claiming another stage or job',async()=>{
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"automatic","minimumConfidence":0}';
        INSERT INTO conversations(id,organization_id,page_id,psid,processing_revision) VALUES('worker-conv','org_default','page','worker-person',1),('next-conv','org_default','page','next-person',1);
        INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence,provider_timestamp_ms) VALUES('worker-msg','org_default','worker-conv','page','worker-mid','Hello',1,'{}',extract(epoch FROM now())*1000),('next-msg','org_default','next-conv','page','next-mid','Next',1,'{}',extract(epoch FROM now())*1000);
        INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES('worker-item','org_default','worker-conv','worker-msg',1),('next-item','org_default','next-conv','next-msg',1);
        INSERT INTO jobs(id,organization_id,kind,retry_safe,payload,created_at) VALUES('worker-job','org_default','analyze_work_item',true,'{"workItemId":"worker-item","conversationId":"worker-conv","processingRevision":1}',now()-interval '1 second'),('next-job','org_default','analyze_work_item',true,'{"workItemId":"next-item","conversationId":"next-conv","processingRevision":1}',now())`);
      const name=`lifecycle-worker-${suffix}`;
      start(name,workerRole,['-e','OPENAI_API_KEY=fake-no-live-calls','-e','META_TOKEN_KEY_VERSION=one','-e',`META_TOKEN_KEYS=${JSON.stringify({one:Buffer.alloc(32,1).toString('base64')})}`,
        '-v',`${fileURLToPath(new URL('./fixtures/delayed-openai.mjs',import.meta.url))}:/lifecycle/delayed-openai.mjs:ro`,image,'node','--import','/lifecycle/delayed-openai.mjs','src/worker.mjs']);
      await until(()=>docker(['logs',name]).includes('DELAYED_PROVIDER_ENTERED'));
      const before=Date.now();await stop(name,120);
      assert.ok(Date.now()-before>10000,'Current invocation must finish beyond Docker default ten-second grace');
      assert.equal(docker(['inspect','--format','{{.State.ExitCode}}',name]),'0');
      assert.equal((await pool.query("SELECT status FROM jobs WHERE id='worker-job'")).rows[0].status,'completed');
      assert.equal((await pool.query("SELECT status FROM jobs WHERE id='next-job'")).rows[0].status,'pending');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reply_versions')).rows[0].n,1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_attempts')).rows[0].n,0);
      assert.equal((await pool.query("SELECT status FROM jobs WHERE kind='deliver_reply'")).rows[0].status,'pending');
      assert.equal((await pool.query("SELECT attempts FROM jobs WHERE kind='deliver_reply'")).rows[0].attempts,0);
    });
  } finally {
    if(tx){await tx.query('ROLLBACK');tx.release();}
    for(const name of names)docker(['rm','-f',name]);
    await pool?.end();await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for(const role of [webRole,workerRole])if((await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount){await owner.query(`DROP OWNED BY "${role}"`);await owner.query(`DROP ROLE "${role}"`);}
    await owner.end();
  }
});
