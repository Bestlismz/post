import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.mjs';
import { migrate } from '../src/db/migrate.mjs';

test('policy gates fail closed and use local IANA hours across DST', async () => {
  const { evaluatePolicy } = await import('../src/policy/evaluator.mjs');
  const policy = { mode: 'automatic', minimumConfidence: 0.8, businessHours: { timeZone: 'America/New_York', days: [0,1,2,3,4,5,6], start: '09:00', end: '17:00' }, rateLimits: { organization: 2, source: 2, conversation: 1 } };
  const context = { confidence: 1, grounded: true, automaticEligible: true, sourceHealth: 'connected', replyWindowOpen: true, counts: { organization: 0, source: 0, conversation: 0 } };
  assert.equal(evaluatePolicy(policy, context, new Date('2026-03-08T13:00:00Z')).action, 'authorize');
  assert.equal(evaluatePolicy(policy, context, new Date('2026-01-08T13:00:00Z')).action, 'review');
  for (const patch of [{ confidence: 0.2 }, { grounded: false }, { automaticEligible: false }, { sourceHealth: 'expired' }, { replyWindowOpen: false }, { optOut: true }, { humanTakeover: true }, { counts: { conversation: 1 } }]) assert.equal(evaluatePolicy(policy, { ...context, ...patch }, new Date('2026-03-08T13:00:00Z')).action, 'review');
  assert.equal(evaluatePolicy({ mode: 'observe' }, context).action, 'observe');
  assert.equal(evaluatePolicy({ mode: 'approval' }, context).action, 'review');
  assert.equal(evaluatePolicy({ ...policy, businessHours: { ...policy.businessHours, timeZone: 'bad' } }, context).action, 'review');
  for (const minimumConfidence of [-1,2,'0',null]) assert.equal(evaluatePolicy({...policy,minimumConfidence},context,new Date('2026-03-08T13:00:00Z')).action,'review');
  for (const hours of [{start:'09:99'}, {end:'17:99'}, {days:[9]}, {timeZone:null}]) assert.equal(evaluatePolicy({...policy,businessHours:{...policy.businessHours,...hours}},context,new Date('2026-03-08T13:00:00Z')).action,'review');
});

test('reply preparation, immutable authorization, takeover and leased retry use real database', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const { createInboxService } = await import('../src/inbox/service.mjs');
  const { createAutomationWorker } = await import('../src/workers/automation-worker.mjs');
  const admin = createPool({ databaseUrl: process.env.TEST_DATABASE_URL });
  const schema = `reply_${randomUUID().replaceAll('-', '')}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href }); await migrate(pool);
    await pool.query(`INSERT INTO users(id,email,password_hash,display_name) VALUES('operator','a@b.c','x','Operator'); INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','operator','operator'); INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('source','org_default','page','Page','connected')`);
    const actor = { id: 'operator', role: 'operator', organizationId: 'org_default' };
    const seed = async (id, revision = 1, conversation = id) => {
      await pool.query(`INSERT INTO conversations(id,organization_id,page_id,psid,processing_revision) VALUES($1,'org_default','page',$1,$2) ON CONFLICT(id) DO UPDATE SET processing_revision=$2`, [conversation,revision]);
      await pool.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence,provider_timestamp_ms) VALUES($1,'org_default',$2,'page',$1,'Hello',$3,'{}',$4)`, [`m-${id}`,conversation,revision,Date.now()]);
      await pool.query(`INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES($1,'org_default',$2,$3,$4)`, [id,conversation,`m-${id}`,revision]);
    };
    const fields = Object.fromEntries(['budgetMin','budgetMax','bedrooms','moveInDate','requiredPetPolicy','district'].map(k => [k,{ status: 'missing', value: null, evidence: [] }]));
    const client = { responses: { create: async request => ({ status: 'completed', output_text: JSON.stringify(request.text.format.name === 'rental_requirements' ? fields : { units: [], templateId: 'clarify' }) }) } };
    const service = createInboxService({ pool, client });
    await seed('one');
    await t.test('request body cannot inject trusted snapshot or format', async () => {
      await assert.rejects(service.prepareReply('one',1,actor,{ snapshot: { id: 'evil' } }), /input|trusted|unexpected/i);
    });
    let reply;
    await t.test('preparation retries persist a single server-owned grounded version', async () => {
      reply = await service.prepareReply('one',1,actor);
      assert.equal(reply.content.grounded,true);
      assert.equal(reply.conversation_revision,1);
      assert.equal((await service.prepareReply('one',1,actor)).id,reply.id);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reply_versions')).rows[0].n,1);
    });
    await t.test('business profile reaches extraction from the organization only', async () => {
      await pool.query(`UPDATE organizations SET business_profile='{"name":"Trusted Agency"}'`);
      await seed('profile');
      const inspecting = { responses: { create: async request => {
        if (request.text.format.name === 'rental_requirements') assert.equal(JSON.parse(request.input).businessProfile.name,'Trusted Agency');
        return client.responses.create(request);
      } } };
      const draft=await createInboxService({pool,client:inspecting}).prepareReply('profile',1,actor);
      assert.equal(draft.content.grounded,true);
      await pool.query(`UPDATE organizations SET business_profile='{"description":"","relevanceThreshold":60}'`);
    });
    await t.test('edits create a superseding version and approved content stays immutable', async () => {
      const edited = await service.editReply(reply.id,1,reply.content.text,actor);
      assert.notEqual(edited.id,reply.id);
      await assert.rejects(service.approveAndQueue(reply.id,1,actor),/superseded/i);
      reply = edited;
      const results = await Promise.all([service.approveAndQueue(reply.id,1,actor),service.approveAndQueue(reply.id,1,actor)]);
      assert.equal(results[0].id,results[1].id);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_intents')).rows[0].n,1);
      await assert.rejects(service.editReply(reply.id,1,reply.content.text,actor),/immutable/i);
      for (const table of ['reply_versions','reply_authorizations','delivery_intents']) await assert.rejects(pool.query(`UPDATE ${table} SET id=id`),/immutable/i);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind='deliver_reply'")).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_entries WHERE action='reply.authorized'")).rows[0].n,1);
    });
    await t.test('later triggers in the same conversation can authorize another reply', async () => {
      await seed('two',2,'one');
      const next = await service.prepareReply('two',2,actor);
      await service.approveAndQueue(next.id,2,actor);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_intents')).rows[0].n,2);
    });
    await t.test('policy and conversation changes invalidate pending approval', async () => {
      await seed('stale'); const draft = await service.prepareReply('stale',1,actor);
      await pool.query('UPDATE organizations SET automation_policy_revision=automation_policy_revision+1');
      await assert.rejects(service.approveAndQueue(draft.id,1,actor),/policy|evidence/i);
      await seed('old'); await seed('new',2,'old');
      await assert.rejects(service.prepareReply('old',1,actor),/superseded/i);
    });
    await t.test('handoff cancels pending delivery and generation atomically', async () => {
      await service.requestHandoff('two','Customer requested agent',actor);
      assert.equal((await pool.query("SELECT status FROM work_items WHERE id='two'")).rows[0].status,'handoff');
      assert.equal((await pool.query("SELECT human_takeover FROM conversations WHERE id='one'")).rows[0].human_takeover,true);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM delivery_cancellations")).rows[0].n,2);
    });
    await t.test('automatic authorization uses the same ledger and failure falls to review', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"automatic","minimumConfidence":0}'`);
      await seed('auto'); const automatic = await service.prepareReply('auto',1,actor);
      assert.equal((await pool.query('SELECT actor_kind FROM reply_authorizations WHERE reply_version_id=$1',[automatic.id])).rows[0].actor_kind,'policy');
      await seed('failed');
      const failing = createInboxService({ pool, client: { responses: { create: async () => { throw new Error('offline'); } } } });
      const fallback = await failing.prepareReply('failed',1,actor);
      assert.equal(fallback.content.automaticEligible,false);
      assert.equal((await pool.query("SELECT status FROM work_items WHERE id='failed'")).rows[0].status,'needs_review');
    });
    await t.test('worker recovers leases and idempotently finishes without remote send', async () => {
      await seed('worker');
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe,status,lease_expires_at) VALUES('analyze','org_default','analyze_work_item','{"workItemId":"worker","conversationId":"worker","processingRevision":1}',true,'running',now()-interval '1 second')`);
      const worker = createAutomationWorker({ pool, service, workerId: 'test-worker' });
      await Promise.all([worker.runOnce(),worker.runOnce()]);
      assert.equal((await pool.query("SELECT status FROM jobs WHERE id='analyze'")).rows[0].status,'completed');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM reply_versions WHERE work_item_id='worker'")).rows[0].n,1);
    });
    await t.test('inbound during generation rejects the stale result', async () => {
      await seed('racing');
      let entered,release;
      const waiting=new Promise(resolve=>{entered=resolve;}); const gate=new Promise(resolve=>{release=resolve;});
      const slow={responses:{create:async request=>{if(request.text.format.name==='rental_requirements'){entered();await gate;}return client.responses.create(request);}}};
      const pending=createInboxService({pool,client:slow}).prepareReply('racing',1,actor);
      await waiting;
      await seed('racing-new',2,'racing'); release();
      await assert.rejects(pending,/superseded/i);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM reply_versions WHERE work_item_id='racing'")).rows[0].n,0);
    });
    await t.test('expired provider event time cannot be refreshed by webhook receipt time', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"approval"}'`);
      await seed('expired');
      await pool.query("UPDATE messages SET provider_timestamp_ms=$1 WHERE id='m-expired'",[Date.now()-25*60*60*1000]);
      const draft=await service.prepareReply('expired',1,actor);
      await assert.rejects(service.approveAndQueue(draft.id,1,actor),/reply_window/i);
    });
    await t.test('observe mode cannot authorize a human send', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"observe"}'`);
      await seed('observe'); const draft=await service.prepareReply('observe',1,actor);
      await assert.rejects(service.approveAndQueue(draft.id,1,actor),/observe/i);
      assert.equal((await pool.query("SELECT status FROM work_items WHERE id='observe'")).rows[0].status,'completed');
    });
    await t.test('concurrent automatic rate limit allows one authorization and reviews the other', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"automatic","minimumConfidence":0,"rateLimits":{"source":1}}'`);
      // A new source gives this case an empty rate window.
      await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('limited','org_default','page-limited','Limited','connected')");
      const limited=createInboxService({pool,client});
      await seed('limit-a'); await seed('limit-b');
      await pool.query("UPDATE conversations SET page_id='page-limited' WHERE id IN ('limit-a','limit-b')");
      await Promise.all([limited.prepareReply('limit-a',1,actor),limited.prepareReply('limit-b',1,actor)]);
      const rows=(await pool.query("SELECT status FROM work_items WHERE id IN ('limit-a','limit-b') ORDER BY status")).rows;
      assert.deepEqual(rows.map(r=>r.status),['needs_review','ready']);
    });
    await t.test('downstream audit failure rolls authorization intent and job back together', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"approval"}'`);
      await seed('atomic'); const draft=await service.prepareReply('atomic',1,actor);
      await pool.query(`CREATE FUNCTION fail_authorization_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='reply.authorized' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_authorization BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION fail_authorization_audit()`);
      try { await assert.rejects(service.approveAndQueue(draft.id,1,actor),/audit unavailable/); }
      finally {await pool.query('DROP TRIGGER fail_authorization ON audit_entries');}
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reply_authorizations WHERE reply_version_id=$1',[draft.id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_intents WHERE reply_version_id=$1',[draft.id])).rows[0].n,0);
    });
    await t.test('crash after preparation commit reuses the existing version without another model call', async () => {
      await seed('crash'); const first=await service.prepareReply('crash',1,actor);
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe,status,lease_expires_at) VALUES('crash-job','org_default','analyze_work_item','{"workItemId":"crash","conversationId":"crash","processingRevision":1}',true,'running',now()-interval '1 second')`);
      const noCalls=createInboxService({pool,client:{responses:{create:async()=>{assert.fail('committed preparation must not call provider again');}}}});
      await createAutomationWorker({pool,service:noCalls,workerId:'recovery'}).runOnce();
      assert.equal((await noCalls.prepareReply('crash',1,actor)).id,first.id);
      assert.equal((await pool.query("SELECT status FROM jobs WHERE id='crash-job'")).rows[0].status,'completed');
    });
    await t.test('explicit idempotency keys replay edits and reject changed approval requests', async () => {
      await seed('keys'); const draft=await service.prepareReply('keys',1,actor);
      const edit=await service.editReply(draft.id,1,draft.content.text,actor,{idempotencyKey:'edit-once'});
      assert.equal((await service.editReply(draft.id,1,draft.content.text,actor,{idempotencyKey:'edit-once'})).id,edit.id);
      await assert.rejects(service.editReply(draft.id,1,draft.content.text+'x',actor,{idempotencyKey:'edit-once'}),/different request/i);
      const approved=await service.approveAndQueue(edit.id,1,actor,{idempotencyKey:'approve-once'});
      assert.equal((await service.approveAndQueue(edit.id,1,actor,{idempotencyKey:'approve-once'})).id,approved.id);
      await assert.rejects(service.approveAndQueue(draft.id,1,actor,{idempotencyKey:'approve-once'}),/different request/i);
    });
    await t.test('inventory version changes and foreign actors cannot authorize', async () => {
      const {createCatalog}=await import('../src/inventory/catalog.mjs');
      const catalog=createCatalog(pool);
      const command=input=>({organizationId:'org_default',actorId:actor.id,idempotencyKey:randomUUID(),input});
      const project=await catalog.createProject(command({name:'Trusted condo'}));
      let unit=await catalog.createUnit(command({projectId:project.id,unitCode:'A1',roomType:'condo',monthlyRentThb:18000,availableFrom:'2026-11-01',description:'Nice room',petPolicy:'unknown'}));
      unit=await catalog.changeAvailability({...command({id:unit.id,status:'available'}),expectedRevision:unit.revision});
      unit=await catalog.publishUnit({...command({id:unit.id}),expectedRevision:unit.revision});
      await seed('inventory'); const draft=await service.prepareReply('inventory',1,actor);
      await catalog.updateUnit({...command({id:unit.id,monthlyRentThb:19000}),expectedRevision:unit.revision});
      await assert.rejects(service.approveAndQueue(draft.id,1,actor),/inventory/i);
      await assert.rejects(service.approveAndQueue(draft.id,1,{...actor,organizationId:'outside'}),{status:404});
      await assert.rejects(service.approveAndQueue(draft.id,1,{...actor,role:'viewer'}),{status:403});
    });
    await t.test('worker preserves revision order while another claim holds an earlier lease', async () => {
      await seed('ordered'); await seed('ordered-new',2,'ordered');
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe,status,lease_owner,lease_expires_at) VALUES
        ('order-1','org_default','analyze_work_item','{"workItemId":"ordered","conversationId":"ordered","processingRevision":1}',true,'running','other',now()+interval '1 minute'),
        ('order-2','org_default','analyze_work_item','{"workItemId":"ordered-new","conversationId":"ordered","processingRevision":2}',true,'pending',NULL,NULL)`);
      const worker=createAutomationWorker({pool,service,workerId:'ordering'});
      assert.equal(await worker.runOnce(),null);
      await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id='order-1'");
      assert.equal(await worker.runOnce(),'order-1');
      assert.equal(await worker.runOnce(),'order-2');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM reply_versions WHERE work_item_id='ordered'")).rows[0].n,0);
      assert.equal((await pool.query("SELECT status FROM work_items WHERE id='ordered'")).rows[0].status,'superseded');
      assert.equal((await pool.query("SELECT last_error FROM jobs WHERE id='order-1'")).rows[0].last_error,'CONVERSATION_SUPERSEDED');
    });
    await t.test('one authorization decision uses one clock instant at the hours boundary', async () => {
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"automatic","minimumConfidence":0,"businessHours":{"timeZone":"UTC","days":[0,1,2,3,4,5,6],"start":"09:00","end":"17:00"}}'`);
      await seed('boundary');
      const first=new Date('2026-10-22T16:59:59Z');
      await pool.query("UPDATE messages SET provider_timestamp_ms=$1 WHERE id='m-boundary'",[first.valueOf()-1000]);
      let calls=0;
      const timed=createInboxService({pool,client,clock:()=>calls++===0?first:new Date('2026-10-22T17:00:00Z')});
      const draft=await timed.prepareReply('boundary',1,actor);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM reply_authorizations WHERE reply_version_id=$1',[draft.id])).rows[0].n,1);
      await pool.query(`UPDATE organizations SET automation_policy='{"mode":"approval"}'`);
    });
    await t.test('an old lease cannot finish a replacement claim with the same worker name', async () => {
      await seed('fenced');
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES('fenced-job','org_default','analyze_work_item','{"workItemId":"fenced","conversationId":"fenced","processingRevision":1}',true)`);
      let entered,release;
      const ready=new Promise(resolve=>{entered=resolve;}); const gate=new Promise(resolve=>{release=resolve;});
      const slow={prepareReply:async()=>{entered();await gate;}};
      const first=createAutomationWorker({pool,service:slow,workerId:'restarted'}).runOnce();
      await ready;
      const oldOwner=(await pool.query("SELECT lease_owner FROM jobs WHERE id='fenced-job'")).rows[0].lease_owner;
      await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id='fenced-job'");
      let enteredAgain,releaseAgain;
      const secondReady=new Promise(resolve=>{enteredAgain=resolve;}); const secondGate=new Promise(resolve=>{releaseAgain=resolve;});
      const second=createAutomationWorker({pool,service:{prepareReply:async()=>{enteredAgain();await secondGate;}},workerId:'restarted'}).runOnce();
      await secondReady;
      try {
        release(); await first;
        const current=(await pool.query("SELECT status,lease_owner FROM jobs WHERE id='fenced-job'")).rows[0];
        assert.equal(current.status,'running'); assert.notEqual(current.lease_owner,oldOwner);
      } finally {releaseAgain();await second;}
    });
    await t.test('policy changes replace an unapproved stale draft once under concurrency', async () => {
      await seed('refresh-policy');
      const old=await service.prepareReply('refresh-policy',1,actor);
      await pool.query('UPDATE organizations SET automation_policy_revision=automation_policy_revision+1');
      await assert.rejects(service.editReply(old.id,1,old.content.text,actor),{code:'POLICY_CHANGED'});
      const [first,second]=await Promise.all([service.prepareReply('refresh-policy',1,actor),service.prepareReply('refresh-policy',1,actor)]);
      assert.notEqual(first.id,old.id); assert.equal(first.id,second.id); assert.equal(first.version,2);
      assert.equal((await pool.query('SELECT replacement_id FROM reply_supersessions WHERE reply_version_id=$1',[old.id])).rows[0].replacement_id,first.id);
      await assert.rejects(service.approveAndQueue(old.id,1,actor),/superseded/i);
      await service.approveAndQueue(first.id,1,actor);
      await pool.query('UPDATE organizations SET automation_policy_revision=automation_policy_revision+1');
      assert.equal((await service.prepareReply('refresh-policy',1,actor)).id,first.id,'approved history must not be replaced');
    });
    await t.test('inventory and project revisions refresh stale drafts into usable immutable versions', async () => {
      await seed('refresh-inventory');
      let draft=await service.prepareReply('refresh-inventory',1,actor);
      const oldId=draft.id;
      await pool.query('UPDATE units SET revision=revision+1,monthly_rent_thb=19001');
      const [first,second]=await Promise.all([service.prepareReply('refresh-inventory',1,actor),service.prepareReply('refresh-inventory',1,actor)]);
      assert.notEqual(first.id,oldId); assert.equal(first.id,second.id); assert.equal(first.version,2);
      await pool.query('UPDATE projects SET revision=revision+1');
      draft=await service.prepareReply('refresh-inventory',1,actor);
      assert.equal(draft.version,3); assert.notEqual(draft.id,first.id);
      await service.approveAndQueue(draft.id,1,actor);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM reply_versions WHERE work_item_id='refresh-inventory'")).rows[0].n,3);
    });
    await t.test('source, profile and format evidence refresh drafts instead of copying stale context', async () => {
      await seed('refresh-settings'); let draft=await service.prepareReply('refresh-settings',1,actor);
      for (const sql of ["UPDATE meta_page_sources SET health='expired' WHERE id='source'", "UPDATE organizations SET profile_revision=profile_revision+1", "UPDATE organizations SET reply_format_revision=reply_format_revision+1"]) {
        const previous=draft;
        await pool.query(sql);
        draft=await service.prepareReply('refresh-settings',1,actor);
        assert.notEqual(draft.id,previous.id); assert.equal(draft.version,previous.version+1);
        assert.equal((await service.prepareReply('refresh-settings',1,actor)).id,draft.id);
      }
      await pool.query("UPDATE meta_page_sources SET health='connected' WHERE id='source'");
      draft=await service.prepareReply('refresh-settings',1,actor);
      await service.approveAndQueue(draft.id,1,actor);
    });
    for (const [kind,phase,sql,code] of [
      ['policy','rental_requirements','UPDATE organizations SET automation_policy_revision=automation_policy_revision+1','POLICY_CHANGED'],
      ['inventory','grounded_reply_selections','UPDATE units SET revision=revision+1','INVENTORY_CHANGED'],
    ]) await t.test(`worker retries a ${kind} freshness race and reclaims its crashed retry`, async () => {
      const id=`retry-${kind}`; await seed(id);
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES($1,'org_default','analyze_work_item',$2,true)`,[id,JSON.stringify({workItemId:id,conversationId:id,processingRevision:1})]);
      let changed=false;
      const racingClient={responses:{create:async request=>{
        if (!changed && request.text.format.name===phase) {changed=true;await pool.query(sql);}
        return client.responses.create(request);
      }}};
      const worker=createAutomationWorker({pool,service:createInboxService({pool,client:racingClient}),workerId:`retry-${kind}`});
      try {
        assert.equal(await worker.runOnce(),id);
        const row=(await pool.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
        assert.equal(row.status,'pending'); assert.equal(row.last_error,code);
        assert.equal(row.attempts,1); assert.equal(row.lease_owner,null);
        assert.ok(row.available_at>new Date());
        assert.equal(await worker.runOnce(),null,'backoff must prevent immediate retry');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM reply_versions WHERE work_item_id=$1',[id])).rows[0].n,0);
        await pool.query("UPDATE jobs SET status='running',lease_owner='crashed',lease_expires_at=now()-interval '1 second' WHERE id=$1",[id]);
        await worker.runOnce();
        assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[id])).rows[0].status,'completed');
        assert.equal((await pool.query('SELECT status FROM work_items WHERE id=$1',[id])).rows[0].status,'needs_review');
      } finally {await pool.query("UPDATE jobs SET status='completed' WHERE id=$1",[id]);}
    });
    await t.test('repeated freshness races exhaust retries into an atomic failure receipt', async () => {
      const id='retry-exhausted';await seed(id);
      await pool.query(`INSERT INTO jobs(id,organization_id,kind,payload,retry_safe) VALUES($1,'org_default','analyze_work_item',$2,true)`,[id,JSON.stringify({workItemId:id,conversationId:id,processingRevision:1})]);
      const racingClient={responses:{create:async request=>{
        if(request.text.format.name==='rental_requirements') await pool.query('UPDATE organizations SET profile_revision=profile_revision+1');
        return client.responses.create(request);
      }}};
      const worker=createAutomationWorker({pool,service:createInboxService({pool,client:racingClient}),workerId:'exhaustion',maxAttempts:2,retryBaseSeconds:1,maxRetrySeconds:2});
      try {
        await worker.runOnce();
        assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[id])).rows[0].status,'pending');
        await pool.query('UPDATE jobs SET available_at=now() WHERE id=$1',[id]);
        await worker.runOnce();
        const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[id])).rows[0];
        assert.equal(job.status,'failed');assert.equal(job.attempts,2);assert.equal(job.last_error,'PROFILE_CHANGED');
        assert.equal((await pool.query('SELECT status FROM work_items WHERE id=$1',[id])).rows[0].status,'failed');
        const receipts=(await pool.query("SELECT details FROM audit_entries WHERE action='reply.preparation_failed' AND entity_id=$1",[id])).rows;
        assert.equal(receipts.length,1);assert.equal(receipts[0].details.errorCode,'PROFILE_CHANGED');assert.equal(receipts[0].details.attempts,2);
      } finally {await pool.query("UPDATE jobs SET status='completed' WHERE id=$1",[id]);}
    });
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
