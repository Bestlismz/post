import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

const execute = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
const source = {
  version: 3, businessProfile: { description: "หาห้อง" },
  groups: { g1: { id: "g1" } }, targets: { t1: { key: "t1" } },
  submissions: { t1: { state: "submitted" }, t2: { state: "unknown" }, t3: { state: "attempted" } },
  messengerOutbound: { m1: { state: "sent" }, m2: { state: "reserved" } },
};

async function fixture(fn) {
  const admin = createPool({ databaseUrl });
  const schema = `legacy_${randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(path.join(tmpdir(), "radar-legacy-"));
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    const file = path.join(directory, "state.json");
    await writeFile(file, JSON.stringify(source));
    await fn({ pool, file, url: url.href });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

test("legacy importer is available only as an explicit CLI module", async () => {
  const importer = await import("./import-json-state.mjs");
  assert.equal(typeof importer.importLegacy, "function");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.scripts["import:legacy"], "node scripts/import-json-state.mjs");
  assert.equal(pkg.scripts.migrate, "node scripts/migrate.mjs");
});

test("legacy dry run counts records without writing; import read-compares and preserves terminal outcomes", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file }) => {
    const dry = await importLegacy(file, { pool, dryRun: true });
    assert.equal(dry.writes, 0);
    assert.deepEqual(dry.counts, { groups: 1, targets: 1, submissions: 3, messengerOutbound: 2 });
    assert.equal(dry.unknownDeliveries, 3);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM legacy_state_imports")).rows[0].count, 0);
    const imported = await importLegacy(file, { pool });
    assert.equal(imported.writes, 1);
    assert.equal(imported.verified, true);
    assert.deepEqual(imported.counts, dry.counts);
    const { rows: [row] } = await pool.query("SELECT snapshot, delivery_outcomes FROM legacy_state_imports");
    assert.deepEqual(row.snapshot, source);
    assert.deepEqual(row.delivery_outcomes, {
      submissions: { t1: "submitted", t2: "unknown", t3: "unknown" },
      messengerOutbound: { m1: "sent", m2: "unknown" },
    });
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 0);
    await assert.rejects(importLegacy(file, { pool }), /already populated/i);
    await assert.rejects(importLegacy(file, { pool, dryRun: true }), /already populated/i);
  });
});

test("legacy import refuses existing business data and concurrent imports", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file }) => {
    await pool.query("INSERT INTO projects (organization_id,id,name,revision) VALUES ('org_default','p1','Existing',1)");
    await assert.rejects(importLegacy(file, { pool }), /already populated/i);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM legacy_state_imports")).rows[0].count, 0);
  });
  await fixture(async ({ pool, file }) => {
    const results = await Promise.allSettled([importLegacy(file, { pool }), importLegacy(file, { pool })]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.match(results.find((item) => item.status === "rejected").reason.message, /already populated/i);
  });
});

test("legacy archive redacts credential fields recursively and CLI never logs source values or database secrets", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file, url }) => {
    const secret = "PRIVATE_SECRET_SENTINEL";
    await writeFile(file, JSON.stringify({ ...source, OPENAI_API_KEY: secret, browserProfile: { cookies: [secret] }, config: { connectionString: secret, storageState: { origins: [secret] }, localStorage: { login: secret } }, messengerConfig: { pageAccessToken: secret }, targets: { t1: { key: "t1", authorization: secret, nested: { sessionSecret: secret } } } }));
    const result = await execute(process.execPath, ["scripts/import-json-state.mjs", file], { env: { ...process.env, DATABASE_URL: url } });
    assert.equal(JSON.parse(result.stdout).verified, true);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    const saved = (await pool.query("SELECT snapshot FROM legacy_state_imports")).rows[0].snapshot;
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(saved.targets.t1.key, "t1");
    await assert.rejects(execute(process.execPath, ["scripts/import-json-state.mjs", file], { env: { ...process.env, DATABASE_URL: `postgres://user:${secret}@127.0.0.1:1/db` } }), (error) => {
      assert.equal((error.stdout + error.stderr).includes(secret), false);
      return true;
    });
    await assert.rejects(importLegacy(file, { pool }), /already populated/i);
  });
});

test("legacy importer rolls back if persisted values fail read-compare verification", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file }) => {
    await pool.query(`CREATE FUNCTION corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.snapshot = '{}'::jsonb; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_import BEFORE INSERT ON legacy_state_imports FOR EACH ROW EXECUTE FUNCTION corrupt_import()`);
    await assert.rejects(importLegacy(file, { pool }), /verification failed/i);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM legacy_state_imports")).rows[0].count, 0);
  });
});

test("legacy import preserves delivery identities containing credential words", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file }) => {
    await writeFile(file, JSON.stringify({ version: 3, submissions: { "group:token-discussion": { state: "submitted" } } }));
    const result = await importLegacy(file, { pool });
    assert.equal(result.counts.submissions, 1);
    const row = (await pool.query("SELECT delivery_outcomes FROM legacy_state_imports")).rows[0];
    assert.equal(row.delivery_outcomes.submissions["group:token-discussion"], "submitted");
  });
});

test("legacy import refuses modified default organization settings even without revision changes", { skip: !databaseUrl }, async () => {
  const { importLegacy } = await import("./import-json-state.mjs");
  await fixture(async ({ pool, file }) => {
    await pool.query(`UPDATE organizations SET business_profile = '{"description":"Existing business"}'`);
    await assert.rejects(importLegacy(file, { pool }), /already populated/i);
  });
});

test("migration CLI is repeatable against the same database", { skip: !databaseUrl }, async () => {
  await fixture(async ({ pool, url }) => {
    const before = (await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    for (let index = 0; index < 2; index += 1) {
      const result = await execute(process.execPath, ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: url } });
      assert.match(result.stdout, /migrations applied/i);
    }
    assert.deepEqual((await pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows, before);
  });
});
