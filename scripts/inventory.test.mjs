import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
async function fixture(fn) {
  const admin = createPool({ databaseUrl });
  const schema = `inventory_${randomUUID().replaceAll("-", "")}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    await pool.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ('actor','actor@example.com','unused','Actor')");
    await pool.query("INSERT INTO organizations (id,name) VALUES ('other','Other')");
    await pool.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ('org_default','actor','admin'),('other','actor','admin')");
    const { createCatalog } = await import("../src/inventory/catalog.mjs");
    const catalog = createCatalog(pool);
    const command = (input, expectedRevision, idempotencyKey = randomUUID(), organizationId = "org_default") => ({ organizationId, actorId: "actor", idempotencyKey, expectedRevision, input });
    const project = await catalog.createProject(command({ name: "  บ้าน   สุขใจ  ", address: " กรุงเทพฯ ", district: "วัฒนา", province: "กรุงเทพมหานคร", transit: [{ station: " BTS   อโศก ", walkingDistanceM: 300 }], amenities: [" สระว่ายน้ำ "] }));
    const makeUnit = (patch = {}) => catalog.createUnit(command({ projectId: project.id, unitCode: "  A   ๑๐๑  ", ...patch }));
    const complete = { roomType: "studio", bedrooms: 0, monthlyRentThb: 15000, availableFrom: "2026-11-01", description: "ห้องสวย ใกล้รถไฟฟ้า", petPolicy: "unknown" };
    await fn({ pool, catalog, command, project, makeUnit, complete });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
const integration = (name, fn) => test(name, { skip: !databaseUrl }, () => fixture(fn));

integration("projects normalize Thai whitespace, keep normalized transit and amenities, and enforce revisions", async ({ pool, catalog, command, project }) => {
  assert.equal(project.name, "บ้าน สุขใจ");
  assert.equal(project.revision, 1);
  assert.deepEqual(project.transit, [{ station: "BTS อโศก", walkingDistanceM: 300 }]);
  assert.deepEqual(project.amenities, ["สระว่ายน้ำ"]);
  assert.equal((await pool.query("SELECT station FROM project_transit")).rows[0].station, "BTS อโศก");
  const updated = await catalog.updateProject(command({ id: project.id, name: "บ้าน ใหม่", amenities: ["ฟิตเนส"], transit: [] }, 1));
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.transit, []);
  assert.deepEqual(updated.amenities, ["ฟิตเนส"]);
  await assert.rejects(catalog.updateProject(command({ id: project.id, name: "Lost" }, 1)), (e) => e.status === 409);
  await assert.rejects(catalog.updateProject(command({ id: project.id, name: "Lost" })), /expectedRevision/);
});

integration("units preserve immutable facts at each revision including explicit unknown pet policy", async ({ pool, catalog, command, makeUnit, complete }) => {
  const unit = await makeUnit(complete);
  assert.equal(unit.unitCode, "A ๑๐๑");
  assert.equal(unit.status, "draft");
  assert.equal(unit.petPolicy, "unknown");
  assert.equal(unit.availableFrom, "2026-11-01");
  const changed = await catalog.updateUnit(command({ id: unit.id, monthlyRentThb: 16000 }, 1));
  assert.equal(changed.revision, 2);
  const facts = await pool.query("SELECT revision, facts FROM unit_fact_revisions WHERE unit_id=$1 ORDER BY revision", [unit.id]);
  assert.deepEqual(facts.rows.map((r) => [r.revision, r.facts.monthlyRentThb]), [[1,15000],[2,16000]]);
  const projectId = unit.projectId;
  await catalog.updateProject(command({ id: projectId, name: "ชื่อใหม่" }, 1));
  assert.equal((await pool.query("SELECT facts->'project'->>'name' AS name FROM unit_fact_revisions WHERE unit_id=$1 AND revision=1", [unit.id])).rows[0].name, "บ้าน สุขใจ");
  for (const sql of ["UPDATE unit_fact_revisions SET facts='{}'", "DELETE FROM unit_fact_revisions", "TRUNCATE unit_fact_revisions"]) await assert.rejects(pool.query(sql), /immutable/i);
});

integration("only complete available units publish, with explicit unknown pets accepted", async ({ catalog, command, makeUnit, complete }) => {
  let unit = await makeUnit();
  await assert.rejects(catalog.publishUnit(command({ id: unit.id }, 1)), /monthlyRentThb|availableFrom/);
  unit = await catalog.updateUnit(command({ id: unit.id, ...complete }, 1));
  await assert.rejects(catalog.publishUnit(command({ id: unit.id }, 2)), /available/);
  unit = await catalog.changeAvailability(command({ id: unit.id, status: "available" }, 2));
  unit = await catalog.publishUnit(command({ id: unit.id }, 3));
  assert.equal(unit.revision, 4);
  assert.ok(unit.publishedAt);
  assert.equal(unit.petPolicy, "unknown");
  await assert.rejects(catalog.updateUnit(command({ id: unit.id, monthlyRentThb: null }, 4)), /monthlyRentThb/);
});

integration("publication requires each field and rejects contact-bearing descriptions", async ({ catalog, command, makeUnit, complete }) => {
  for (const field of ["roomType", "monthlyRentThb", "availableFrom", "description", "petPolicy"]) {
    let unit = await makeUnit({ ...complete, unitCode: randomUUID(), [field]: null });
    unit = await catalog.changeAvailability(command({ id: unit.id, status: "available" }, 1));
    await assert.rejects(catalog.publishUnit(command({ id: unit.id }, 2)), new RegExp(field));
  }
  await assert.rejects(makeUnit({ ...complete, description: "โทร 0812345678" }), /description/);
  await assert.rejects(makeUnit({ ...complete, availableFrom: "2026-02-30" }), /availableFrom/);
  await assert.rejects(makeUnit({ ...complete, monthlyRentThb: -1 }), /monthlyRentThb/);
});

integration("availability commands enforce legal transitions and cannot bypass lifecycle via generic updates", async ({ catalog, command, makeUnit, complete }) => {
  let unit = await makeUnit(complete);
  await assert.rejects(catalog.changeAvailability(command({ id: unit.id, status: "rented" }, 1)), /transition/);
  await assert.rejects(catalog.updateUnit(command({ id: unit.id, status: "available" }, 1)), /status|Unrecognized/);
  for (const status of ["available", "held", "rented", "available", "unknown"]) unit = await catalog.changeAvailability(command({ id: unit.id, status }, unit.revision));
  await assert.rejects(catalog.publishUnit(command({ id: unit.id }, unit.revision)), /available/);
  assert.equal(unit.status, "unknown");
});

integration("archive preserves facts and citations and blocks future mutation", async ({ pool, catalog, command, makeUnit, complete }) => {
  const unit = await makeUnit(complete);
  const archived = await catalog.archiveUnit(command({ id: unit.id }, 1));
  assert.equal(archived.status, "archived");
  assert.equal(archived.revision, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM units")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM unit_fact_revisions")).rows[0].n, 2);
  for (const method of ["updateUnit", "publishUnit", "changeAvailability", "archiveUnit"]) await assert.rejects(catalog[method](command({ id: unit.id, ...(method === "changeAvailability" ? { status: "available" } : {}) }, 2)), /archived/);
});

integration("tenant scope protects mutations, references and every inventory table", async ({ pool, catalog, command, project, makeUnit }) => {
  const unit = await makeUnit();
  await assert.rejects(catalog.updateProject(command({ id: project.id, name: "Stolen" }, 1, randomUUID(), "other")), (e) => e.status === 404);
  for (const method of ["updateUnit", "publishUnit", "changeAvailability", "archiveUnit"]) await assert.rejects(catalog[method](command({ id: unit.id, ...(method === "changeAvailability" ? { status: "available" } : {}) }, 1, randomUUID(), "other")), (e) => e.status === 404);
  await assert.rejects(catalog.createUnit(command({ projectId: project.id, unitCode: "x" }, undefined, randomUUID(), "other")), /project/i);
  for (const table of ["projects", "project_transit", "project_amenities", "units", "unit_fact_revisions"]) {
    assert.deepEqual((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name='organization_id'", [table])).rows, [{ is_nullable: "NO" }]);
  }
});

integration("idempotent mutations replay once, include resource and expected revision in hashes, and audit exact revisions", async ({ pool, catalog, command, makeUnit }) => {
  const create = command({ projectId: (await pool.query("SELECT id FROM projects")).rows[0].id, unitCode: "B" });
  const [unit, replay] = await Promise.all([catalog.createUnit(create), catalog.createUnit(create)]);
  assert.deepEqual(unit, replay);
  const other = await makeUnit();
  const update = command({ id: unit.id, unitCode: "C" }, 1);
  assert.deepEqual(await catalog.updateUnit(update), await catalog.updateUnit(update));
  await assert.rejects(catalog.updateUnit({ ...update, expectedRevision: 2 }), (e) => e.status === 409 && /idempotency/i.test(e.message));
  await assert.rejects(catalog.updateUnit({ ...update, input: { ...update.input, id: other.id } }), (e) => e.status === 409 && /idempotency/i.test(e.message));
  const results = await Promise.allSettled([catalog.updateUnit(command({ id: unit.id, unitCode: "D" }, 2)),catalog.updateUnit(command({ id: unit.id, unitCode: "E" }, 2))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  const audit = await pool.query("SELECT action,details,actor_id FROM audit_entries WHERE entity_id=$1 ORDER BY created_at", [unit.id]);
  assert.deepEqual(audit.rows.map((r) => [r.action,r.details.revision,r.actor_id]), [["unit.created",1,"actor"],["unit.updated",2,"actor"],["unit.updated",3,"actor"]]);
});

integration("audit failure rolls back inventory, facts, and replay key so retry can succeed", async ({ pool, catalog, command, makeUnit }) => {
  const unit = await makeUnit();
  const update = command({ id: unit.id, unitCode: "retry" }, 1);
  await pool.query("CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION fail_audit()");
  await assert.rejects(catalog.updateUnit(update), /audit unavailable/);
  assert.equal((await pool.query("SELECT revision FROM units WHERE id=$1", [unit.id])).rows[0].revision, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM unit_fact_revisions WHERE unit_id=$1", [unit.id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key=$1", [update.idempotencyKey])).rows[0].n, 0);
  await pool.query("DROP TRIGGER fail_audit ON audit_entries");
  assert.equal((await catalog.updateUnit(update)).revision, 2);
});

integration("lifecycle retries emit exactly one matching audit and fact revision per command", async ({ pool, catalog, command, makeUnit, complete }) => {
  let unit = await makeUnit(complete);
  for (const [method, patch] of [["changeAvailability", { status: "available" }], ["publishUnit", {}], ["archiveUnit", {}]]) {
    const request = command({ id: unit.id, ...patch }, unit.revision);
    const result = await catalog[method](request);
    assert.deepEqual(await catalog[method](request), result);
    await assert.rejects(catalog[method]({ ...request, expectedRevision: result.revision }), (e) => e.status === 409 && /idempotency/i.test(e.message));
    unit = result;
  }
  assert.ok(unit.publishedAt);
  assert.equal(unit.status, "archived");
  const audit = await pool.query("SELECT action,details FROM audit_entries WHERE entity_id=$1 ORDER BY created_at", [unit.id]);
  assert.deepEqual(audit.rows.map((r) => [r.action,r.details.revision,r.details.previousRevision,r.details.status]), [["unit.created",1,null,"draft"],["unit.availability_changed",2,1,"available"],["unit.published",3,2,"available"],["unit.archived",4,3,"archived"]]);
  const facts = await pool.query("SELECT facts FROM unit_fact_revisions WHERE unit_id=$1 ORDER BY revision", [unit.id]);
  assert.deepEqual(facts.rows.map((r) => [r.facts.revision, r.facts.status]), [[1,"draft"],[2,"available"],[3,"available"],[4,"archived"]]);
});
