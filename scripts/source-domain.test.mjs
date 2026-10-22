import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '../src/db/pool.mjs';
import { migrate } from '../src/db/migrate.mjs';
import { canonicalizeGroupUrl, createSourceService } from '../src/sources/service.mjs';

test('group URLs canonicalize exact HTTPS Facebook hosts and reject target ambiguity', () => {
  for (const host of ['www.facebook.com','facebook.com','m.facebook.com']) {
    assert.deepEqual(canonicalizeGroupUrl(`https://${host}/groups/123/?ref=share#top`), { groupId:'123', canonicalUrl:'https://www.facebook.com/groups/123' });
  }
  for (const url of ['http://www.facebook.com/groups/123','https://evilfacebook.com/groups/123','https://www.facebook.com.evil.test/groups/123','https://user@www.facebook.com/groups/123','https://www.facebook.com:443/groups/123','https://www.facebook.com/groups/name','https://www.facebook.com/groups/123/posts/456','https://www.facebook.com/groups/%31%32%33','https://www.facebook.com/a/../groups/123','https://www.facebook.com/groups/123\\foo','https://www.facebook.com/groups/123//',' https://www.facebook.com/groups/123']) assert.throws(() => canonicalizeGroupUrl(url), /group URL/i, url);
});

test('group URL IDs preserve leading zeros and accept at most 100 digits', () => {
  for (const groupId of ['1'.repeat(100), '0'.repeat(99)+'1', '000123']) {
    assert.deepEqual(canonicalizeGroupUrl(`https://m.facebook.com/groups/${groupId}`), {groupId,canonicalUrl:`https://www.facebook.com/groups/${groupId}`});
  }
  for (const groupId of ['1'.repeat(101), '0'.repeat(100)+'1']) {
    assert.throws(()=>canonicalizeGroupUrl(`https://www.facebook.com/groups/${groupId}`),/group URL/i);
  }
});

async function sourceFixture(fn) {
  const admin = createPool({ databaseUrl:process.env.TEST_DATABASE_URL });
  const schema = `source_${randomUUID().replaceAll('-','')}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options',`-c search_path=${schema}`);
    pool = createPool({ databaseUrl:url.href }); await migrate(pool);
    await pool.query("INSERT INTO users(id,email,password_hash,display_name) VALUES('admin','admin@test','x','Admin'),('viewer','viewer@test','x','Viewer'),('operator','operator@test','x','Operator')");
    await pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','admin','admin'),('org_default','viewer','viewer'),('org_default','operator','operator')");
    await pool.query("INSERT INTO organizations(id,name) VALUES('other','Other')");
    await pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES('other','admin','admin')");
    const service=createSourceService(pool,{signingKey:'a'.repeat(32),keyId:'test',clock:()=>new Date('2026-10-22T12:00:00Z'),supportedSelectorVersions:['v1']});
    const command=(input,expectedRevision,extra={})=>({organizationId:'org_default',actorId:'admin',idempotencyKey:randomUUID(),input,...(expectedRevision ? {expectedRevision}:{}),...extra});
    await fn({pool,service,command,schema,admin});
  } finally { await pool?.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}
const integration=(name,fn)=>test(name,{skip:!process.env.TEST_DATABASE_URL},()=>sourceFixture(fn));

integration('oversized group IDs fail before source persistence and accepted boundary IDs remain scannable',async({pool,service,command})=>{
  for(const groupId of ['1'.repeat(101),'0'.repeat(100)+'1']) {
    await assert.rejects(service.addGroupSource(command({url:`https://facebook.com/groups/${groupId}`})),/group URL/i);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM group_sources')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_entries')).rows[0].n,0);
  for(const groupId of ['1'.repeat(100),'0'.repeat(99)+'1']) {
    const source=await service.addGroupSource(command({url:`https://facebook.com/groups/${groupId}`}));
    const scan=await service.requestGroupScan(command({id:source.id},1));
    assert.equal(scan.command.groupId,groupId);
  }
});

integration('concurrent source adds deduplicate targets and idempotency with one audit',async({pool,service,command})=>{
  const c=command({url:'https://m.facebook.com/groups/123/?ref=share'});
  const [a,b]=await Promise.all([service.addGroupSource(c),service.addGroupSource(c)]);
  assert.deepEqual(a,b); assert.equal(a.mode,'observe'); assert.equal(a.revision,1);
  const duplicate=await service.addGroupSource(command({url:'https://www.facebook.com/groups/123'}));
  assert.equal(duplicate.id,a.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_entries')).rows[0].n,1);
  await assert.rejects(service.addGroupSource({...c,input:{url:'https://www.facebook.com/groups/456'}}),e=>e.status===409);
  const raced=await Promise.all([service.addGroupSource(command({url:'https://facebook.com/groups/456'})),service.addGroupSource(command({url:'https://m.facebook.com/groups/456'}))]);
  assert.equal(raced[0].id,raced[1].id);
});

integration('source mutations enforce tenant membership roles revision races and archive retention',async({pool,service,command})=>{
  await assert.rejects(service.addGroupSource(command({url:'https://facebook.com/groups/123'},undefined,{actorId:'viewer'})),e=>e.status===403);
  const source=await service.addGroupSource(command({url:'https://facebook.com/groups/123'}));
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'approval'},1,{organizationId:'other'})),e=>e.status===404);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'approval'},1,{actorId:'operator'})),e=>e.status===403);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'approval'})),/expectedRevision/);
  const race=await Promise.allSettled(['approval','observe'].map(mode=>service.updateGroupSource(command({id:source.id,mode},1))));
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1); assert.equal(race.find(x=>x.status==='rejected').reason.status,409);
  const archived=await service.updateGroupSource(command({id:source.id,archived:true},2)); assert.equal(archived.archived,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM group_sources')).rows[0].n,1);
  await assert.rejects(service.requestGroupScan(command({id:source.id},3)),/archived/);
});

integration('automatic mode fails closed until every stored readiness gate passes',async({pool,service,command})=>{
  const source=await service.addGroupSource(command({url:'https://facebook.com/groups/123'}));
  const policy={rateLimits:{organization:10,source:5,conversation:1},businessHours:{timeZone:'UTC',days:[4],start:'00:00',end:'24:00'}};
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},1)),/not ready/i);
  await service.updateGroupSource(command({id:source.id,allowListed:true,policy},1));
  for(const [field,value] of [['session_health','healthy'],['selector_version','v1'],['selector_health','healthy']]) {
    await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
    await pool.query(`UPDATE group_sources SET ${field}=$1 WHERE id=$2`,[value,source.id]);
  }
  await pool.query('UPDATE group_sources SET kill_switch=true WHERE id=$1',[source.id]);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
  await pool.query('UPDATE group_sources SET kill_switch=false WHERE id=$1',[source.id]);
  await pool.query("UPDATE group_sources SET selector_version='unsupported' WHERE id=$1",[source.id]);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
  await pool.query("UPDATE group_sources SET selector_version='v1' WHERE id=$1",[source.id]);
  await pool.query("UPDATE group_sources SET policy='{}' WHERE id=$1",[source.id]);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
  await pool.query('UPDATE group_sources SET policy=$1 WHERE id=$2',[JSON.stringify(policy),source.id]);
  await pool.query("UPDATE organizations SET group_automation_paused=true WHERE id='org_default'");
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
  await assert.rejects(service.requestGroupScan(command({id:source.id},2)),/paused/i);
  await pool.query("UPDATE organizations SET group_automation_paused=false WHERE id='org_default'");
  await pool.query('UPDATE group_sources SET policy=$1 WHERE id=$2',[JSON.stringify({...policy,businessHours:{...policy.businessHours,start:'13:00',end:'14:00'}}),source.id]);
  await assert.rejects(service.updateGroupSource(command({id:source.id,mode:'automatic'},2)),/not ready/i);
  await pool.query('UPDATE group_sources SET policy=$1 WHERE id=$2',[JSON.stringify(policy),source.id]);
  const ready=await service.updateGroupSource(command({id:source.id,mode:'automatic'},2)); assert.equal(ready.mode,'automatic');
  await assert.rejects(service.updateGroupSource(command({id:source.id,sessionHealth:'healthy'},3)),/Unrecognized/);
  await pool.query("UPDATE group_sources SET session_health='failed' WHERE id=$1",[source.id]);
  await assert.rejects(service.requestGroupScan(command({id:source.id},3)),/not ready/i);
  const paused=await service.updateGroupSource(command({id:source.id,killSwitch:true},3));
  assert.equal(paused.killSwitch,true);
  await assert.rejects(service.requestGroupScan(command({id:source.id},4)),/paused/i);
  const archived=await service.updateGroupSource(command({id:source.id,archived:true},4));
  assert.equal(archived.archived,true);
});

integration('scan commands audit and jobs commit atomically and retry returns one operation',async({pool,service,command})=>{
  const source=await service.addGroupSource(command({url:'https://facebook.com/groups/123'}));
  const c=command({id:source.id},1,{actorId:'operator'});
  const [a,b]=await Promise.all([service.requestGroupScan(c),service.requestGroupScan(c)]); assert.deepEqual(a,b);
  assert.equal(a.command.kind,'ScanCommand'); assert.equal(a.command.canonicalTarget,'https://www.facebook.com/groups/123');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM group_operations')).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind='group.scan'")).rows[0].n,1);
  await pool.query("CREATE FUNCTION reject_group_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job refused'; END $$");
  await pool.query('CREATE TRIGGER reject_group_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_group_job()');
  await assert.rejects(service.requestGroupScan(command({id:source.id},1)),/job refused/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM group_operations')).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_entries WHERE action='group.scan_requested'")).rows[0].n,1);
  await assert.rejects(pool.query("UPDATE group_operations SET command='{}'"),/append-only/i);
  await assert.rejects(pool.query('DELETE FROM group_operations'),/append-only/i);
  for (const channel of ['messenger','facebook_group']) await pool.query('INSERT INTO conversations(id,organization_id,channel,page_id,psid) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'org_default',channel,channel,'target']);
  await assert.rejects(pool.query("INSERT INTO conversations(id,organization_id,channel,page_id,psid) VALUES('bad','org_default','other','bad','bad')"),/check constraint/);
});

integration('runtime web can manage sources while application worker can only read immutable commands',async({pool,command,schema,admin})=>{
  const {provisionRuntime}=await import('./provision-runtime.mjs');
  const suffix=randomUUID().replaceAll('-','');
  for(const profile of ['web','worker']) {
    const role=`group_${profile}_${suffix}`;
    let runtime;
    try {
      await provisionRuntime(pool,{role,profile,password:'group-test-password-12345'});
      const url=new URL(process.env.TEST_DATABASE_URL);url.username=role;url.password='group-test-password-12345';url.searchParams.set('options',`-c search_path=${schema}`);
      runtime=createPool({databaseUrl:url.href});
      if(profile==='web') {
        const service=createSourceService(runtime,{signingKey:'a'.repeat(32),keyId:'test'});
        const source=await service.addGroupSource(command({url:'https://facebook.com/groups/999'}));
        await service.updateGroupSource(command({id:source.id,mode:'approval'},1));
        await service.requestGroupScan(command({id:source.id},2));
      } else {
        assert.equal((await runtime.query('SELECT count(*)::int AS n FROM group_operations')).rows[0].n,1);
        await runtime.query('SELECT * FROM group_sources');
        await assert.rejects(runtime.query("UPDATE group_sources SET allow_listed=true"),e=>e.code==='42501');
        await assert.rejects(runtime.query("INSERT INTO group_operations(id,organization_id,source_id,kind,command) SELECT 'forged',organization_id,source_id,kind,command FROM group_operations"),e=>e.code==='42501');
      }
      for(const table of ['group_sources','group_operations']) {
        await assert.rejects(runtime.query(`DELETE FROM ${table}`),e=>e.code==='42501');
        await assert.rejects(runtime.query(`UPDATE ${table} SET organization_id='other'`),e=>e.code==='42501');
      }
    } finally {
      await runtime?.end();
      const client=await admin.connect();
      try { await client.query(`DROP OWNED BY "${role}"`);await client.query(`DROP ROLE "${role}"`); } finally {client.release();}
    }
  }
});
