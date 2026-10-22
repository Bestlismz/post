import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.mjs';
import { migrate } from '../src/db/migrate.mjs';

test('Meta client bounds dispatch and classifies outcomes without exposing customer data', async () => {
  const { createMetaSendClient } = await import('../src/channels/meta/client.mjs');
  let calls=0, seen;
  const client=createMetaSendClient({fetchImpl:async(url,init)=>{calls++;seen={url,init};return new Response(JSON.stringify({message_id:'remote-1',recipient_id:'private-psid'}));}});
  const input={pageId:'page/id',recipientId:'private-psid',text:'private-body',token:'private-token',attemptId:'attempt-1'};
  const result=await client.sendText(input);
  assert.equal(result.state,'sent'); assert.equal(result.messageId,'remote-1'); assert.equal(result.dispatched,true);
  assert.match(seen.url,/v24\.0\/page%2Fid\/messages$/);
  assert.equal(JSON.parse(seen.init.body).messaging_type,'RESPONSE');
  assert.equal(JSON.parse(seen.init.body).message.metadata,'attempt-1');
  assert.equal((await client.sendText({...input,text:''})).dispatched,false); assert.equal(calls,1);
  for (const [status,body,state,code] of [[400,{error:{code:100,message:'private-token private-psid private-body'}},'failed','PROVIDER_INVALID_REQUEST'],[401,{error:{code:190}},'failed','PROVIDER_AUTH'],[403,{error:{code:10}},'failed','PROVIDER_PERMISSION'],[429,{error:{code:4}},'failed','PROVIDER_RATE_LIMIT'],[408,{error:{code:1}},'unknown','PROVIDER_UNCERTAIN'],[400,{error:{code:2,is_transient:true}},'unknown','PROVIDER_UNCERTAIN'],[400,{},'unknown','PROVIDER_MALFORMED'],[500,{},'unknown','PROVIDER_UNCERTAIN'],[200,{},'unknown','PROVIDER_MALFORMED']]) {
    const outcome=await createMetaSendClient({fetchImpl:async()=>new Response(JSON.stringify(body),{status})}).sendText(input);
    assert.equal(outcome.state,state); assert.equal(outcome.code,code); assert.equal(outcome.retrySafe,false);
    for(const privateValue of ['private-token','private-psid','private-body']) assert.ok(!JSON.stringify(outcome).includes(privateValue));
  }
  for(const fetchImpl of [async()=>{throw Error('private-token');},async()=>new Promise(()=>{}),async()=>new Response('x'.repeat(100))]) {
    const outcome=await createMetaSendClient({fetchImpl,timeoutMs:20,maxResponseBytes:50}).sendText(input);
    assert.equal(outcome.state,'unknown');assert.equal(outcome.dispatched,true);
  }
  assert.throws(()=>createMetaSendClient({graphVersion:'../../evil'}));
  assert.throws(()=>createMetaSendClient({baseUrl:'http://example.com'}));
});

test('Messenger final delivery gate and durable attempts', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
  const {createMetaDeliveryWorker}=await import('../src/workers/meta-delivery-worker.mjs');
  const {createMetaSendClient}=await import('../src/channels/meta/client.mjs');
  const {createMetaCredentialRepository}=await import('../src/channels/meta/credentials.mjs');
  const {createInboxService}=await import('../src/inbox/service.mjs');
  const admin=createPool({databaseUrl:process.env.TEST_DATABASE_URL});
  const schema=`delivery_${randomUUID().replaceAll('-','')}`;let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
    pool=createPool({databaseUrl:url.href});await migrate(pool);
    await pool.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES('operator','a@b.c','x','Operator'); INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','operator','operator'); INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('source','org_default','page','Page','connected')`);
    const credentials=createMetaCredentialRepository({pool,keys:{one:Buffer.alloc(32,1)},keyVersion:'one'});
    const storeToken=expiresAt=>credentials.store({organizationId:'org_default',actorId:'operator',id:'source',kind:'page',value:{token:'private-token'},expiresAt});
    await storeToken(null);
    const actor={id:'operator',role:'operator',organizationId:'org_default'};
    const fields=Object.fromEntries(['budgetMin','budgetMax','bedrooms','moveInDate','requiredPetPolicy','district'].map(k=>[k,{status:'missing',value:null,evidence:[]}]));
    const generator={responses:{create:async request=>({status:'completed',output_text:JSON.stringify(request.text.format.name==='rental_requirements'?fields:{units:[],templateId:'clarify'})})}};
    const service=createInboxService({pool,client:generator});
    const seed=async(id,revision=1,conversation=id)=>{
      await pool.query(`INSERT INTO conversations(id,organization_id,page_id,psid,processing_revision) VALUES($1,'org_default','page',$1,$2) ON CONFLICT(id) DO UPDATE SET processing_revision=$2`,[conversation,revision]);
      await pool.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence,provider_timestamp_ms) VALUES($1,'org_default',$2,'page',$1,'Hello',$3,'{}',$4)`,[`m-${id}`,conversation,revision,Date.now()]);
      await pool.query(`INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES($1,'org_default',$2,$3,$4)`,[id,conversation,`m-${id}`,revision]);
      const reply=await service.prepareReply(id,revision,actor);return service.approveAndQueue(reply.id,revision,actor);
    };
    let calls=0;
    const client=createMetaSendClient({fetchImpl:async()=>{calls++;return new Response(JSON.stringify({message_id:`remote-${calls}`}));}});
    const worker=createMetaDeliveryWorker({pool,credentials,client});
    await t.test('concurrent workers dispatch once and persist provider evidence and audit atomically',async()=>{
      const intent=await seed('once');
      await Promise.all([worker.deliverMessengerIntent(intent.id),worker.deliverMessengerIntent(intent.id)]);
      assert.equal(calls,1);
      const attempt=(await pool.query('SELECT * FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0];
      assert.equal(attempt.state,'sent');assert.equal(attempt.provider_message_id,'remote-1');assert.ok(attempt.id);
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'sent');assert.equal(calls,1);
      const audits=(await pool.query("SELECT details FROM audit_entries WHERE action LIKE 'delivery.%' AND entity_id=$1",[intent.id])).rows;
      assert.equal(audits.length,2);assert.ok(!JSON.stringify(audits).includes('private-token'));
    });
    for(const [name,change] of [
      ['human takeover',async i=>service.requestHandoff('takeover','Agent required',actor)],
      ['opt-out',async i=>pool.query('UPDATE conversations SET opted_out=true WHERE id=$1',[i.conversation_id])],
      ['reply window',async i=>pool.query('UPDATE messages SET provider_timestamp_ms=$2 WHERE conversation_id=$1',[i.conversation_id,Date.now()-86400001])],
      ['future event',async i=>pool.query('UPDATE messages SET provider_timestamp_ms=$2 WHERE conversation_id=$1',[i.conversation_id,Date.now()+86400000])],
      ['policy',async()=>pool.query('UPDATE organizations SET automation_policy_revision=automation_policy_revision+1')],
      ['profile',async()=>pool.query('UPDATE organizations SET profile_revision=profile_revision+1')],
      ['format',async()=>pool.query('UPDATE organizations SET reply_format_revision=reply_format_revision+1')],
      ['source',async()=>pool.query("UPDATE meta_page_sources SET health='unavailable' WHERE id='source'")],
      ['superseded',async i=>pool.query('UPDATE conversations SET processing_revision=processing_revision+1 WHERE id=$1',[i.conversation_id])],
    ]) await t.test(`${name} immediately before gate prevents dispatch`,async()=>{
      const intent=await seed(name==='human takeover'?'takeover':name);const before=calls;
      await change(intent);assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'cancelled');assert.equal(calls,before);
      await pool.query("UPDATE meta_page_sources SET health='connected' WHERE id='source'");
    });
    await t.test('expired credential remains pre-dispatch retry-safe',async()=>{
      const intent=await seed('credential');await storeToken(new Date(Date.now()-1000));const before=calls;
      const outcome=await worker.deliverMessengerIntent(intent.id);assert.equal(outcome.state,'failed');assert.equal(outcome.retrySafe,true);assert.equal(calls,before);
      assert.equal((await pool.query('SELECT * FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rowCount,0);
      const job=(await pool.query("SELECT attempts,available_at FROM jobs WHERE kind='deliver_reply' AND payload->>'deliveryIntentId'=$1",[intent.id])).rows[0];
      assert.equal(job.attempts,1);assert.ok(job.available_at.valueOf()>Date.now());
      await storeToken(null);assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'sent');
    });
    await t.test('takeover during credential resolution wins before the final transaction',async()=>{
      const intent=await seed('credential-race');const before=calls;
      const racing={withPageToken:async(org,source,callback,options)=>credentials.withPageToken(org,source,async token=>{
        if(!options) await service.requestHandoff('credential-race','Agent required',actor);
        return callback(token);
      },options)};
      assert.equal((await createMetaDeliveryWorker({pool,credentials:racing,client}).deliverMessengerIntent(intent.id)).state,'cancelled');assert.equal(calls,before);
    });
    await t.test('token expiry during credential resolution fails before attempting',async()=>{
      const intent=await seed('token-expiry-race');const before=calls;
      const racing={withPageToken:async(org,source,callback,options)=>credentials.withPageToken(org,source,async token=>{
        if(!options) await storeToken(new Date(Date.now()-1000));
        return callback(token);
      },options)};
      try {
        assert.equal((await createMetaDeliveryWorker({pool,credentials:racing,client}).deliverMessengerIntent(intent.id)).retrySafe,true);
        assert.equal((await pool.query('SELECT * FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rowCount,0);assert.equal(calls,before);
      } finally {await storeToken(null);}
    });
    await t.test('unit and project changes invalidate locked inventory evidence',async()=>{
      await pool.query("INSERT INTO projects(organization_id,id,name,revision) VALUES('org_default','project','Project',1); INSERT INTO units(organization_id,id,project_id,unit_code,status,published_at,revision) VALUES('org_default','unit','project','A1','available',now(),1)");
      for(const table of ['units','projects']) {
        const intent=await seed(`inventory-${table}`);const before=calls;
        await pool.query(`UPDATE ${table} SET revision=revision+1`);
        const result=await worker.deliverMessengerIntent(intent.id);assert.equal(result.state,'cancelled');assert.equal(result.code,'INVENTORY_CHANGED');assert.equal(calls,before);
      }
      await pool.query("UPDATE units SET status='draft'");
    });
    await t.test('source expiry is rechecked even with a non-expiring encrypted token',async()=>{
      const intent=await seed('source-expiry');const before=calls;
      await pool.query("UPDATE meta_page_sources SET expires_at=now()-interval '1 second'");
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'failed');assert.equal(calls,before);
      await pool.query('UPDATE meta_page_sources SET expires_at=NULL');
    });
    await t.test('a provider timeout is durable unknown and never retried',async()=>{
      const intent=await seed('timeout');let remoteCalls=0;
      const uncertain=createMetaDeliveryWorker({pool,credentials,client:createMetaSendClient({timeoutMs:20,fetchImpl:async()=>{remoteCalls++;return new Promise(()=>{});}})});
      assert.equal((await uncertain.deliverMessengerIntent(intent.id)).state,'unknown');
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');assert.equal(remoteCalls,1);
    });
    await t.test('crash after provider dispatch cannot reclaim or text-match and needs human remote evidence',async()=>{
      const intent=await seed('crash');let remoteCalls=0;
      const crashPool={connect:()=>pool.connect(),query:async(...args)=>pool.query(...args)};
      const crashWorker=createMetaDeliveryWorker({pool:crashPool,credentials,client:{sendText:async()=>{remoteCalls++;throw Error('simulated crash after click');}}});
      assert.equal((await crashWorker.deliverMessengerIntent(intent.id)).state,'unknown');
      await pool.query("UPDATE delivery_attempts SET state='attempting' WHERE delivery_intent_id=$1",[intent.id]);
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');assert.equal(remoteCalls,1);
      await assert.rejects(worker.reconcileAttempt(intent.id,{actor,evidence:'same text',text:'Hello'}));
      assert.equal((await worker.reconcileAttempt(intent.id,{actor,evidence:'Verified in Page inbox',providerMessageId:'confirmed-remote'})).state,'sent');
      assert.equal((await pool.query("SELECT status FROM work_items WHERE id='crash'")).rows[0].status,'completed');
    });
    await t.test('lost attempting commit acknowledgement never permits another send',async()=>{
      const intent=await seed('commit-ack');let connections=0;const before=calls;
      const failingPool={query:(...args)=>pool.query(...args),connect:async()=>{
        const connection=await pool.connect(),number=++connections;
        return {release:(...args)=>connection.release(...args),query:async(...args)=>{
          const result=await connection.query(...args);
          if(number===2 && args[0]==='COMMIT') throw Error('Lost commit acknowledgement');
          return result;
        }};
      }};
      assert.equal((await createMetaDeliveryWorker({pool:failingPool,credentials,client}).deliverMessengerIntent(intent.id)).retrySafe,false);
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');assert.equal(calls,before);
    });
    await t.test('lost database connection after acceptance preserves attempting, recovery marks unknown without dispatch',async()=>{
      const intent=await seed('persistence-crash');let connections=0,remoteCalls=0;
      const failingPool={query:(...args)=>pool.query(...args),connect:async()=>{connections++;if(connections===3) throw Error('Lost connection before outcome');return pool.connect();}};
      const crashing=createMetaDeliveryWorker({pool:failingPool,credentials,client:{sendText:async()=>{remoteCalls++;return {state:'sent',code:'PROVIDER_ACCEPTED',messageId:'lost-response'};}}});
      assert.equal((await crashing.deliverMessengerIntent(intent.id)).state,'unknown');
      assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'attempting');
      await pool.query("UPDATE delivery_attempts SET started_at=now()-interval '3 minutes' WHERE delivery_intent_id=$1",[intent.id]);
      await worker.recoverInterruptedAttempts();
      assert.equal((await pool.query('SELECT state FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0].state,'unknown');
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');assert.equal(remoteCalls,1);
      const {claimJobs}=await import('../src/jobs/queue.mjs');
      const jobs=await claimJobs(pool,'reclaimer',1000);assert.ok(!jobs.some(j=>j.payload.deliveryIntentId===intent.id));
    });
    await t.test('sent state, provider ID and sent audit roll back together on audit failure',async()=>{
      const intent=await seed('outcome-audit');const before=calls;
      await pool.query("CREATE FUNCTION fail_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='delivery.sent' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION fail_delivery_audit()");
      try {assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');}
      finally {await pool.query('DROP TRIGGER fail_delivery_audit ON audit_entries');}
      const attempt=(await pool.query('SELECT state,provider_message_id FROM delivery_attempts WHERE delivery_intent_id=$1',[intent.id])).rows[0];
      assert.equal(attempt.state,'attempting');assert.equal(attempt.provider_message_id,null);
      assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'unknown');assert.equal(calls,before+1);
    });
    await t.test('later trigger scoped follow-up in the same thread sends independently',async()=>{
      const first=await seed('followup');assert.equal((await worker.deliverMessengerIntent(first.id)).state,'sent');
      const second=await seed('followup2',2,'followup');assert.equal((await worker.deliverMessengerIntent(second.id)).state,'sent');
    });
    await t.test('final rate gate counts recent dispatch attempts including uncertain outcomes',async()=>{
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"approval","rateLimits":{"organization":1}}'`);
      const now=new Date(Date.now()+2*3600000);
      const futureService=createInboxService({pool,client:generator,clock:()=>now});
      await pool.query("INSERT INTO conversations(id,organization_id,page_id,psid,processing_revision) VALUES('limited','org_default','page','limited',1)");
      await pool.query("INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence,provider_timestamp_ms) VALUES('limited','org_default','limited','page','limited','Hello',1,'{}',$1)",[Date.now()]);
      await pool.query("INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES('limited','org_default','limited','limited',1)");
      const reply=await futureService.prepareReply('limited',1,actor);const intent=await futureService.approveAndQueue(reply.id,1,actor);
      const before=calls;assert.equal((await worker.deliverMessengerIntent(intent.id)).state,'cancelled');assert.equal(calls,before);
    });
  } finally {await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}
});
