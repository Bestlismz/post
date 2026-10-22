import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { appendAudit, runIdempotent, withTransaction } from "../src/db/transaction.mjs";
import { claimJobs, enqueueJob } from "../src/jobs/queue.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const tables = ["audit_entries", "conversations", "idempotency_keys", "jobs", "legacy_state_imports", "login_attempts", "match_snapshots", "memberships", "messages", "organizations", "outbox", "project_amenities", "project_transit", "projects", "sessions", "unit_fact_revisions", "units", "users", "work_items"];

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
    assert.deepEqual(ledger.rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7]);
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

async function seedActor(pool) {
  await pool.query("INSERT INTO users (id, email, password_hash, display_name) VALUES ('actor', 'actor@example.com', 'unused', 'Actor')");
  await pool.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ('org_default', 'actor', 'admin')");
}

test("idempotency replays canonical bodies once under concurrency and rejects changed bodies", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await seedActor(pool);
    const command = { organizationId: "org_default", actorId: "actor", route: "POST /projects", key: "command-1", body: { name: "บ้าน", facts: { b: 2, a: 1 } } };
    let executions = 0;
    const run = (input) => withTransaction(pool, (tx) => runIdempotent(tx, input, async () => {
      executions += 1;
      await appendAudit(tx, { organizationId: "org_default", actorId: "actor", action: "project.created", entityType: "project", entityId: "p1", details: { name: "บ้าน" } });
      return { status: 201, body: { id: "p1", name: "บ้าน" } };
    }));
    const reordered = { ...command, body: { facts: { a: 1, b: 2 }, name: "บ้าน" } };
    assert.deepEqual(await Promise.all([run(command), run(reordered)]), [
      { status: 201, body: { id: "p1", name: "บ้าน" } },
      { status: 201, body: { id: "p1", name: "บ้าน" } },
    ]);
    assert.equal(executions, 1);
    await assert.rejects(run({ ...command, body: { changed: true } }), (error) => error.status === 409 && /idempotency/i.test(error.message));
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_entries")).rows[0].count, 1);
  });
});

test("failed commands roll back business state, audit, jobs and idempotency before retry", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await seedActor(pool);
    const command = { organizationId: "org_default", actorId: "actor", route: "PATCH /organization", key: "rollback", body: { name: "Changed" } };
    const run = (fail) => withTransaction(pool, (tx) => runIdempotent(tx, command, async () => {
      await tx.query("UPDATE organizations SET name = 'Changed' WHERE id = 'org_default'");
      await appendAudit(tx, { organizationId: "org_default", actorId: "actor", action: "organization.updated", entityType: "organization", entityId: "org_default" });
      await enqueueJob(tx, { organizationId: "org_default", kind: "analyze", payload: { source: "test" }, retrySafe: true });
      if (fail) throw new Error("injected command failure");
      return { status: 200, body: { name: "Changed" } };
    }));
    await assert.rejects(run(true), /injected command failure/);
    assert.equal((await pool.query("SELECT name FROM organizations WHERE id = 'org_default'")).rows[0].name, "Rental Radar");
    for (const table of ["audit_entries", "jobs", "idempotency_keys"]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    }
    assert.deepEqual(await run(false), { status: 200, body: { name: "Changed" } });
    for (const table of ["audit_entries", "jobs", "idempotency_keys"]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 1);
    }
  });
});

test("audit rows reject update, delete and truncate while preserving original details", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await withTransaction(pool, (tx) => appendAudit(tx, { organizationId: "org_default", action: "system.started", entityType: "system", entityId: "server", details: { version: 1 } }));
    for (const sql of ["UPDATE audit_entries SET details = '{}'", "DELETE FROM audit_entries", "TRUNCATE audit_entries"]) {
      await assert.rejects(pool.query(sql), /append.only/i);
    }
    assert.deepEqual((await pool.query("SELECT actor_id, details FROM audit_entries")).rows, [{ actor_id: null, details: { version: 1 } }]);
  });
});

test("job claims reclaim expired safe work but preserve attempting and unsafe jobs", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    const add = (kind, retrySafe = false, availableAt) => withTransaction(pool, (tx) => enqueueJob(tx, { organizationId: "org_default", kind, retrySafe, availableAt }));
    const pending = await add("pending");
    const expired = await add("safe", true);
    const unsafe = await add("unsafe");
    const attempting = await add("delivery", true);
    const active = await add("active", true);
    await add("future", true, "2100-01-01T00:00:00Z");
    const completed = await add("completed", true);
    await pool.query("UPDATE jobs SET status = 'running', lease_owner = 'old', lease_expires_at = now() - interval '1 minute', attempts = 1 WHERE id = ANY($1)", [[expired.id, unsafe.id, active.id]]);
    await pool.query("UPDATE jobs SET lease_expires_at = now() + interval '1 hour' WHERE id = $1", [active.id]);
    await pool.query("UPDATE jobs SET status = 'attempting', lease_owner = 'sender', lease_expires_at = now() - interval '1 minute' WHERE id = $1", [attempting.id]);
    await pool.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [completed.id]);
    const claimed = await claimJobs(pool, "new-worker", 10);
    assert.deepEqual(claimed.map((job) => job.id).sort(), [pending.id, expired.id].sort());
    for (const job of claimed) {
      assert.equal(job.status, "running");
      assert.equal(job.lease_owner, "new-worker");
      assert.ok(job.lease_expires_at > job.updated_at);
      assert.equal(job.attempts, job.id === expired.id ? 2 : 1);
    }
    assert.deepEqual(await claimJobs(pool, "other-worker", 10), []);
    assert.deepEqual((await pool.query("SELECT status, lease_owner FROM jobs WHERE id = $1", [attempting.id])).rows, [{ status: "attempting", lease_owner: "sender" }]);
  });
});

test("concurrent claimers skip locked work and never share a lease", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    const jobs = [];
    for (let index = 0; index < 5; index += 1) {
      jobs.push(await withTransaction(pool, (tx) => enqueueJob(tx, { organizationId: "org_default", kind: "analyze", retrySafe: true })));
    }
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [jobs[0].id]);
      const batches = await Promise.all([claimJobs(pool, "worker-a", 2), claimJobs(pool, "worker-b", 2)]);
      assert.deepEqual(batches.map((batch) => batch.length), [2, 2]);
      const ids = batches.flat().map((job) => job.id);
      assert.equal(new Set(ids).size, 4);
      assert.equal(ids.includes(jobs[0].id), false);
      await lock.query("ROLLBACK");
      assert.deepEqual((await claimJobs(pool, "worker-c", 2)).map((job) => job.id), [jobs[0].id]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
  });
});

test("idempotency scopes keys by tenant, actor and route and preserves array order", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await seedActor(pool);
    await pool.query("INSERT INTO organizations (id, name) VALUES ('org_second', 'Second')");
    await pool.query("INSERT INTO users (id, email, password_hash, display_name) VALUES ('other', 'other@example.com', 'unused', 'Other')");
    await pool.query("INSERT INTO memberships (organization_id, user_id, role) VALUES ('org_default', 'other', 'viewer'), ('org_second', 'actor', 'admin')");
    const base = { organizationId: "org_default", actorId: "actor", route: "POST /projects", key: "shared-key", body: { list: [1, 2] } };
    const run = (command) => withTransaction(pool, (tx) => runIdempotent(tx, command, async () => ({ status: 200, body: null })));
    for (const command of [base, { ...base, organizationId: "org_second" }, { ...base, actorId: "other" }, { ...base, route: "POST /units" }]) {
      assert.deepEqual(await run(command), { status: 200, body: null });
    }
    await assert.rejects(run({ ...base, body: { list: [2, 1] } }), /idempotency/i);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM idempotency_keys")).rows[0].count, 4);
  });
});

test("invalid command keys and responses cannot commit business changes or replay records", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await seedActor(pool);
    const base = { organizationId: "org_default", actorId: "actor", route: "PATCH /organization", key: "valid", body: {} };
    const run = (command, response) => withTransaction(pool, (tx) => runIdempotent(tx, command, async () => {
      await tx.query("UPDATE organizations SET name = 'Invalid' WHERE id = 'org_default'");
      return response;
    }));
    for (const key of ["", "   ", null, undefined, 123]) {
      await assert.rejects(run({ ...base, key }, { status: 200, body: {} }), /idempotency.*key/i);
    }
    for (const response of [{ status: 200 }, { status: null, body: {} }, { status: 999, body: {} }]) {
      await assert.rejects(run(base, response), /response/i);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM idempotency_keys")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT name FROM organizations WHERE id = 'org_default'")).rows[0].name, "Rental Radar");
  });
});

test("job claims reject invalid workers and unbounded limits before leasing work", { skip: !databaseUrl }, async () => {
  await withDatabase(async (pool) => {
    await migrate(pool);
    await withTransaction(pool, (tx) => enqueueJob(tx, { organizationId: "org_default", kind: "delivery" }));
    for (const worker of ["", " ", null, undefined]) {
      await assert.rejects(claimJobs(pool, worker, 1), /worker/i);
    }
    for (const limit of [null, undefined, -1, 0, 1.5, "1"]) {
      await assert.rejects(claimJobs(pool, "worker", limit), /limit/i);
    }
    assert.deepEqual((await pool.query("SELECT status, attempts, retry_safe FROM jobs")).rows, [{ status: "pending", attempts: 0, retry_safe: false }]);
  });
});
