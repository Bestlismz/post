import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const tables = ["audit_entries", "idempotency_keys", "jobs", "memberships", "organizations", "outbox", "sessions", "users"];

async function withDatabase(fn) {
  const admin = createPool({ databaseUrl });
  const schema = `foundation_${randomUUID().replaceAll("-", "")}`;
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href, max: 4 });
    await fn(pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

test("configuration validates required boundaries without exposing secrets", () => {
  const env = {
    DATABASE_URL: "postgres://localhost/rental_radar",
    APP_ORIGIN: "https://radar.example",
    SESSION_SECRET: "a".repeat(32),
    NODE_ENV: "production",
  };
  assert.deepEqual(loadConfig(env), {
    databaseUrl: env.DATABASE_URL,
    appOrigin: env.APP_ORIGIN,
    sessionSecret: env.SESSION_SECRET,
    nodeEnv: "production",
  });
  for (const change of [
    { DATABASE_URL: "malformed" },
    { DATABASE_URL: "https://example.com" },
    { APP_ORIGIN: "malformed" },
    { APP_ORIGIN: "https://radar.example/path" },
    { APP_ORIGIN: "https://user:password@radar.example" },
    { SESSION_SECRET: "too-short" },
    { NODE_ENV: "invalid" },
  ]) {
    assert.throws(() => loadConfig({ ...env, ...change }), /configuration/i);
  }
  assert.throws(() => loadConfig({}), /configuration/i);
  try {
    loadConfig({ ...env, SESSION_SECRET: "secret-invalid" });
    assert.fail("invalid secret accepted");
  } catch (error) {
    assert.equal(error.message.includes("secret-invalid"), false);
  }
});

test("migrations are atomic and concurrency safe", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await Promise.all([migrate(pool), migrate(pool)]);
    await migrate(pool);
    const ledger = await pool.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    assert.deepEqual(ledger.rows.map((row) => row.version), [1]);
    assert.match(ledger.rows[0].checksum, /^[a-f0-9]{64}$/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM organizations WHERE id = 'org_default'")).rows[0].count, 1);
    const actualTables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY tablename");
    assert.deepEqual(actualTables.rows.map((row) => row.tablename), tables);
    const tenantTables = tables.filter((name) => !["organizations", "users"].includes(name));
    for (const table of tenantTables) {
      const result = await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'organization_id'", [table]);
      assert.deepEqual(result.rows, [{ is_nullable: "NO" }]);
    }
  });
});

test("a failed migration rolls back its schema and releases the lock", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await pool.query(`
      CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION reject_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected migration failure'; END $$;
      CREATE TRIGGER reject_migration BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_migration();
    `);
    await assert.rejects(migrate(pool), /injected migration failure/);
    assert.equal((await pool.query("SELECT to_regclass('organizations') AS name")).rows[0].name, null);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count, 0);
    await pool.query("DROP TRIGGER reject_migration ON schema_migrations");
    await migrate(pool);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM organizations")).rows[0].count, 1);
  });
});

test("migration history rejects checksum drift and unknown versions", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    const { rows: [original] } = await pool.query("SELECT checksum FROM schema_migrations WHERE version = 1");
    await pool.query("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1");
    await assert.rejects(migrate(pool), /checksum/i);
    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 1", [original.checksum]);
    await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, 'unknown.sql', 'unknown')");
    await assert.rejects(migrate(pool), /unknown.*999/i);
  });
});
