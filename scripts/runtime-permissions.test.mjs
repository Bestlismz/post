import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { bootstrapAdmin } from "../src/auth/bootstrap.mjs";
import { createApplicationRouter } from "../src/http/auth-routes.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("runtime role supports authenticated API writes but cannot administer schema or mutate immutable data", { skip: !databaseUrl }, async () => {
  const { provisionRuntime } = await import("./provision-runtime.mjs");
  const admin = createPool({ databaseUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `permissions_${suffix}`, role = `web_${suffix}`;
  let owner, runtime, server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const ownerUrl = new URL(databaseUrl);
    ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
    owner = createPool({ databaseUrl: ownerUrl.href });
    await migrate(owner);
    const password = "runtime-test'password-123";
    await provisionRuntime(owner, { role, password });
    await provisionRuntime(owner, { role, password });
    await bootstrapAdmin(owner, { email: "runtime@example.com", password: "long-password-123", displayName: "Runtime test" });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = createPool({ databaseUrl: runtimeUrl.href });
    const attrs = (await runtime.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.deepEqual(Object.values(attrs), [false, false, false, false, false]);
    for (const table of ["audit_entries", "unit_fact_revisions", "match_snapshots", "legacy_state_imports"]) {
      for (const sql of [`ALTER TABLE ${table} DISABLE TRIGGER ALL`, `DROP TABLE ${table}`, `TRUNCATE ${table}`, `DELETE FROM ${table}`, `UPDATE ${table} SET organization_id='other'`]) {
        await assert.rejects(runtime.query(sql), (error) => error.code === "42501");
      }
    }
    await assert.rejects(runtime.query("CREATE TABLE forbidden (id int)"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("UPDATE schema_migrations SET checksum='changed'"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("SET session_replication_role='replica'"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("SELECT envelope FROM meta_credentials"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("DELETE FROM meta_credentials"), (error) => error.code === "42501");
    const app = express();
    app.use(express.json());
    app.use(createApplicationRouter({ pool: runtime, config: { appOrigin: "https://radar.example", nodeEnv: "production" } }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: "https://radar.example", "Content-Type": "application/json" }, body: JSON.stringify({ email: "runtime@example.com", password: "long-password-123" }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const { createMetaConnection } = await import("../src/channels/meta/oauth.mjs");
    const meta = createMetaConnection({ pool: runtime, config: { appId: "app", appSecret: "private", redirectUri: "https://radar.example/settings/meta/callback", graphVersion: "v24.0", keyVersion: "one", keys: { one: Buffer.alloc(32, 1) } } });
    const begun = await meta.beginMetaConnection(session.user);
    assert.equal(new URL(begun.authorizationUrl).hostname, "www.facebook.com");
    const { createMetaCredentialRepository } = await import("../src/channels/meta/credentials.mjs");
    const credentials = createMetaCredentialRepository({ pool: runtime, keys: { one: Buffer.alloc(32, 1) }, keyVersion: "one" });
    await credentials.store({ organizationId: "org_default", actorId: session.user.id, id: "runtime-credential", kind: "pending", value: { pages: [] } });
    await credentials.withCredential("org_default", "runtime-credential", (value) => assert.deepEqual(value.pages, []));
    await credentials.remove("org_default", "runtime-credential");
    const created = await fetch(base + "/api/projects", { method: "POST", headers: { Origin: "https://radar.example", "Content-Type": "application/json", Cookie: login.headers.get("set-cookie").split(";")[0], "X-CSRF-Token": session.csrfToken, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "Runtime project" }) });
    assert.equal(created.status, 201);
    const project = await created.json();
    assert.equal(project.name, "Runtime project");
    assert.equal((await runtime.query("SELECT count(*)::int AS count FROM audit_entries WHERE action='project.created'")).rows[0].count, 1);
    const { createCatalog } = await import("../src/inventory/catalog.mjs");
    const catalog = createCatalog(runtime);
    const command = (input) => ({ organizationId: "org_default", actorId: session.user.id, idempotencyKey: randomUUID(), input });
    const unit = await catalog.createUnit(command({ projectId: project.id, unitCode: "A1" }));
    assert.equal(unit.revision, 1);
    await catalog.saveMatchSnapshot(command({ requirementsRevision: 1, requirements: {}, expectedInventory: [] }));
    assert.equal((await runtime.query("SELECT count(*)::int AS count FROM match_snapshots")).rows[0].count, 1);
    assert.equal((await runtime.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count, 1);
    const { acceptMetaWebhook } = await import("../src/channels/meta/ingress.mjs");
    const { createHmac } = await import("node:crypto");
    const rawBody = Buffer.from(JSON.stringify({ object: "page", entry: [{ id: "page", messaging: [{ sender: { id: "psid" }, recipient: { id: "page" }, message: { mid: "mid", text: "hello" } }] }] }));
    await runtime.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health) VALUES('runtime-source','org_default','page','Runtime Page','connected')");
    const accepted = await acceptMetaWebhook({ pool: runtime, appSecret: "secret", rawBody, signature: `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}` });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.acceptedEventIds.length, 1);
    for (const table of ["conversations", "messages", "work_items"]) {
      await assert.rejects(runtime.query(`DELETE FROM ${table}`), (error) => error.code === "42501");
      await assert.rejects(runtime.query(`ALTER TABLE ${table} ADD COLUMN forbidden text`), (error) => error.code === "42501");
    }
    await assert.rejects(runtime.query("UPDATE messages SET text='tampered'"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("UPDATE conversations SET psid='tampered'"), (error) => error.code === "42501");
    await assert.rejects(runtime.query("UPDATE work_items SET status='completed'"), (error) => error.code === "42501");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await runtime?.end();
    await owner?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount;
    if (exists) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
    await admin.end();
  }
});
