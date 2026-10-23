import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { matchInventory } from "../src/inventory/matcher.mjs";
import { createCatalog } from "../src/inventory/catalog.mjs";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { sampleInventory } from "./seed-sample-inventory.mjs";

const requirements = { budgetMin: 10000, budgetMax: 20000, bedrooms: 1, roomType: "1_bedroom", moveInDate: "2026-11-01", requiredPetPolicy: "allowed", geography: { districts: ["วัฒนา"] } };
const project = { id: "project", revision: 1, name: "บ้าน", district: "วัฒนา", province: "กรุงเทพมหานคร", transit: [{ station: "อโศก", walkingDistanceM: 300 }], amenities: ["สระว่ายน้ำ"] };
const unit = { id: "a", organizationId: "org_default", projectId: "project", revision: 3, unitCode: "101", status: "available", publishedAt: "2026-10-22T00:00:00Z", availableFrom: "2026-11-01", monthlyRentThb: 15000, bedrooms: 1, roomType: "1 bedroom", petPolicy: "allowed", project };

test("customer sample inventory contains ten publishable room variants", () => {
  assert.equal(sampleInventory.flatMap((entry) => entry.units).length, 10);
  assert.deepEqual(new Set(sampleInventory.flatMap((entry) => entry.units).map((entry) => entry.roomType)), new Set(["studio", "1 bedroom", "2 bedroom"]));
});

test("hard filters exclude unpublished, unavailable, late, over/under budget, wrong bedrooms, unknown pets and geography", () => {
  const patches = [{ publishedAt: null }, ...["draft", "unknown", "held", "rented", "archived"].map(status => ({ status })), { availableFrom: "2026-11-02" }, { availableFrom: null }, { monthlyRentThb: 20001 }, { monthlyRentThb: 9999 }, { bedrooms: 0 }, { bedrooms: null }, { roomType: "studio" }, { petPolicy: "unknown" }, { petPolicy: "case_by_case" }, { project: { ...project, district: "บางรัก" } }];
  const units = [unit, ...patches.map((patch, i) => ({ ...unit, id: `bad-${i}`, ...patch }))];
  assert.deepEqual(matchInventory(requirements, units).candidates.map(x => x.unitId), ["a"]);
});

test("matching is deterministic with stable scores, revision evidence and explanations, without changing inputs", () => {
  const units = [{ ...unit, id: "b" }, unit];
  const before = JSON.stringify(units);
  const result = matchInventory(requirements, units, { minimumScore: 90, limit: 2 });
  assert.deepEqual(result, { matcherVersion: "inventory-v1", candidates: ["a", "b"].map(unitId => ({ unitId, unitRevision: 3, projectId: "project", projectRevision: 1, score: 120, explanations: ["published_available", "available_by_move_in", "within_budget", "bedrooms_match", "room_type_match", "geography_match", "pet_policy_match"] })) });
  assert.deepEqual(matchInventory(requirements, [...units].reverse(), { minimumScore: 90, limit: 2 }), result);
  assert.equal(JSON.stringify(units), before);
  assert.equal(matchInventory({}, [unit], { minimumScore: 1 }).candidates.length, 0);
});

test("geography uses exact project, province and station evidence and rejects malformed or unknown requirements", () => {
  for (const geography of [{ projectIds: ["elsewhere"] }, { provinces: ["เชียงใหม่"] }, { stations: ["พร้อมพงษ์"] }]) assert.equal(matchInventory({ ...requirements, geography }, [unit]).candidates.length, 0);
  assert.equal(matchInventory({ ...requirements, geography: { projectIds: ["project"], provinces: ["กรุงเทพมหานคร"], stations: ["อโศก"] } }, [unit]).candidates.length, 1);
  for (const input of [{ budgetMax: -1 }, { bedrooms: "1" }, { moveInDate: "2026-02-30" }, { petFriendly: true }, { moveInDate: "2026-10-31T18:00:00Z" }]) assert.throws(() => matchInventory(input, [unit]));
});

test("date-only availability compares Thai calendar dates independently of host timezone", () => {
  assert.equal(matchInventory(requirements, [{ ...unit, availableFrom: "2026-11-01" }]).candidates.length, 1);
  assert.equal(matchInventory(requirements, [{ ...unit, availableFrom: "2026-11-02" }]).candidates.length, 0);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
async function fixture(fn) {
  const admin = createPool({ databaseUrl });
  const schema = `matcher_${randomUUID().replaceAll("-", "")}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    await pool.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ('actor','matcher@example.com','unused','Actor')");
    await pool.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ('org_default','actor','admin')");
    const catalog = createCatalog(pool);
    const command = (input, expectedRevision) => ({ organizationId: "org_default", actorId: "actor", idempotencyKey: randomUUID(), input, expectedRevision });
    const p = await catalog.createProject(command({ name: "บ้าน", district: "วัฒนา" }));
    let u = await catalog.createUnit(command({ projectId: p.id, unitCode: "101", roomType: "1 bedroom", bedrooms: 1, monthlyRentThb: 15000, availableFrom: "2026-11-01", petPolicy: "allowed", description: "ห้องสวย" }));
    u = await catalog.changeAvailability(command({ id: u.id, status: "available" }, u.revision));
    u = await catalog.publishUnit(command({ id: u.id }, u.revision));
    const snapshotCommand = () => command({ requirementsRevision: 1, requirements, policy: {}, expectedInventory: [{ unitId: u.id, unitRevision: u.revision, projectId: p.id, projectRevision: p.revision }] });
    await fn({ pool, catalog, command, p, u, snapshotCommand });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
const integration = (name, fn) => test(name, { skip: !databaseUrl }, () => fixture(fn));

integration("snapshot persists immutable typed facts and exactly one atomic audit/job across retries", async ({ pool, catalog, snapshotCommand, u, p }) => {
  const command = snapshotCommand();
  const [snapshot, replay] = await Promise.all([catalog.saveMatchSnapshot(command), catalog.saveMatchSnapshot(command)]);
  assert.deepEqual(snapshot, replay);
  assert.equal(snapshot.matcherVersion, "inventory-v1");
  assert.equal(snapshot.requirementsRevision, 1);
  assert.equal(snapshot.factSnapshot[0].kind, "rental_unit");
  assert.equal(snapshot.factSnapshot[0].unitId, u.id);
  assert.equal(snapshot.factSnapshot[0].projectName, "บ้าน");
  assert.equal(snapshot.factSnapshot[0].monthlyRentThb, 15000);
  assert.equal(snapshot.factSnapshot[0].availableFrom, "2026-11-01");
  assert.equal(snapshot.factSnapshot[0].projectRevision, p.revision);
  await catalog.updateProject({ ...command, input: { id: p.id, name: "ใหม่" }, expectedRevision: 1, idempotencyKey: randomUUID() });
  assert.deepEqual((await pool.query("SELECT fact_snapshot FROM match_snapshots WHERE id=$1", [snapshot.id])).rows[0].fact_snapshot, snapshot.factSnapshot);
  for (const sql of ["UPDATE match_snapshots SET fact_snapshot='[]'", "DELETE FROM match_snapshots", "TRUNCATE match_snapshots"]) await assert.rejects(pool.query(sql), /immutable/i);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_entries WHERE action='match.snapshot_created'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind='match.snapshot_created'")).rows[0].n, 1);
  for (const input of [{ ...command.input, requirementsRevision: 2 }, { ...command.input, requirements: { ...requirements, budgetMax: 18000 } }, { ...command.input, policy: { limit: 2 } }, { ...command.input, expectedInventory: [{ ...command.input.expectedInventory[0], unitRevision: 99 }] }]) await assert.rejects(catalog.saveMatchSnapshot({ ...command, input }), /idempotency/i);
});

for (const drift of ["unit", "project", "held", "unpublished"]) integration(`snapshot rejects ${drift} drift and writes no state/audit/job`, async ({ pool, catalog, command, snapshotCommand, u, p }) => {
  const request = snapshotCommand();
  if (drift === "unit") await catalog.updateUnit(command({ id: u.id, monthlyRentThb: 16000 }, u.revision));
  if (drift === "project") await catalog.updateProject(command({ id: p.id, name: "ใหม่" }, p.revision));
  if (drift === "held") await pool.query("UPDATE units SET status='held' WHERE id=$1", [u.id]);
  if (drift === "unpublished") await pool.query("UPDATE units SET published_at=NULL WHERE id=$1", [u.id]);
  await assert.rejects(catalog.saveMatchSnapshot(request), /inventory changed/i);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM match_snapshots")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [request.idempotencyKey])).rows[0].n, 0);
});

integration("snapshot rejects foreign inventory and rolls back snapshot on downstream job failure", async ({ pool, catalog, snapshotCommand }) => {
  const request = snapshotCommand();
  await pool.query("INSERT INTO organizations (id,name) VALUES ('other','Other'); INSERT INTO memberships (organization_id,user_id,role) VALUES ('other','actor','admin')");
  await assert.rejects(catalog.saveMatchSnapshot({ ...request, organizationId: "other" }), /inventory changed/i);
  await pool.query("CREATE FUNCTION fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job unavailable'; END $$; CREATE TRIGGER fail_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_job()");
  await assert.rejects(catalog.saveMatchSnapshot(request), /job unavailable/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM match_snapshots")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_entries WHERE action='match.snapshot_created'")).rows[0].n, 0);
  await pool.query("DROP TRIGGER fail_job ON jobs");
  assert.equal((await catalog.saveMatchSnapshot(request)).factSnapshot.length, 1);
});
