import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, httpFixture } from "./http-test-helpers.mjs";

test("settings GET ETags round trip through If-Match and reject reuse after a change", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, login, request, mutate }) => {
  await bootstrap();
  const admin = await login();
  for (const [resource, body] of [["retention", { rawPayloadDays: 14, screenshotDays: 7 }], ["business-profile", { name: "Updated", description: "Rentals", relevanceThreshold: 70 }]]) {
    const route = `/api/settings/${resource}`;
    const before = await request(route, admin);
    const etag = before.headers.get("etag");
    const changed = await mutate(admin, route, body, etag);
    assert.equal(changed.status, 200);
    assert.equal(changed.body.revision, before.body.revision + 1);
    assert.equal(changed.headers.get("etag"), `"${changed.body.revision}"`);
    assert.equal((await mutate(admin, route, body, etag)).status, 409);
    assert.equal((await request(route, admin)).headers.get("etag"), changed.headers.get("etag"));
  }
}));

test("admin settings persist revisions, enforce roles, filter audit, and redact readiness", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, login, request, mutate, addUser }) => {
  await bootstrap();
  const admin = await login();
  const viewer = await addUser("viewer");
  for (const resource of ["users", "business-profile", "retention", "readiness", "audit"]) assert.equal((await request(`/api/settings/${resource}`, viewer)).status, 403);
  const list = await request("/api/settings/users", admin);
  assert.equal(JSON.stringify(list.body).includes("password"), false);
  assert.equal((await mutate(admin, `/api/settings/users/${viewer.id}`, { role: "inventory_manager" })).status, 200);
  assert.equal((await request("/api/me", viewer)).body.user.role, "inventory_manager");
  assert.equal((await mutate(admin, `/api/settings/users/${viewer.id}`, { role: "viewer" })).status, 409);
  const profile = await mutate(admin, "/api/settings/business-profile", { name: "บ้าน", description: "Rentals", relevanceThreshold: 60 });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.revision, 2);
  assert.equal((await request("/api/settings/business-profile", admin)).body.name, "บ้าน");
  const invalid = await mutate(admin, "/api/settings/retention", { rawPayloadDays: -1, screenshotDays: 10 });
  assert.equal(invalid.status, 422);
  assert.deepEqual(Object.keys(invalid.body).sort(), ["error", "fieldErrors"]);
  assert.ok(invalid.body.fieldErrors.rawPayloadDays);
  assert.equal((await mutate(admin, "/api/settings/retention", { rawPayloadDays: 14, screenshotDays: 7 })).status, 200);
  assert.equal((await request("/api/settings/retention", admin)).body.rawPayloadDays, 14);
  const audit = await request("/api/settings/audit?action=user.role_changed", admin);
  assert.equal(audit.body.entries.length, 1);
  assert.equal(audit.body.entries[0].entity_id, viewer.id);
  const ready = await request("/api/settings/readiness", admin);
  assert.equal(ready.status, 200);
  assert.equal(JSON.stringify(ready.body).includes("private-api-key"), false);
  assert.equal(ready.body.openaiConfigured, true);
  assert.ok(ready.body.missing.includes("META_APP_SECRET"));
  await pool.query("INSERT INTO organizations (id,name) VALUES ('foreign','Foreign')");
  await pool.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ('foreign',$1,'viewer')", [viewer.id]);
}));

test("user administration is idempotent, tenant scoped, audited atomically and preserves the last admin", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, login, request, mutate }) => {
  await bootstrap();
  const admin = await login();
  const me = (await request("/api/me", admin)).body.user;
  assert.equal((await mutate(admin, `/api/settings/users/${me.id}`, { role: "viewer" })).status, 409);
  const headers = { "Idempotency-Key": "new-user" };
  const input = { email: "new@example.com", displayName: "New", password: "long-password-123", role: "operator" };
  const create = (body) => request("/api/settings/users", { ...admin, method: "POST", body, headers });
  const added = await create(input);
  assert.equal(added.status, 201);
  assert.deepEqual((await create(input)).body, added.body);
  assert.equal((await create({ ...input, role: "admin" })).status, 409);
  const session = await login(input.email);
  assert.equal((await request("/api/settings/users", session)).status, 403);
  const audit = await request(`/api/settings/audit?entityId=${added.body.id}&actorId=${me.id}`, admin);
  assert.equal(audit.body.entries.length, 1);
  assert.equal(JSON.stringify(audit.body).includes(input.password), false);
  await pool.query("INSERT INTO organizations (id,name) VALUES ('foreign','Foreign')");
  await pool.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ('foreign-user','foreign@example.com','unused','Foreign')");
  await pool.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ('foreign','foreign-user','viewer')");
  assert.equal((await mutate(admin, "/api/settings/users/foreign-user", { role: "admin" })).status, 404);
  await pool.query("CREATE FUNCTION fail_settings_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job failure'; END $$");
  await pool.query("CREATE TRIGGER fail_settings_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_settings_job()");
  const failure = await mutate(admin, "/api/settings/retention", { rawPayloadDays: 12, screenshotDays: 10 });
  assert.equal(failure.status, 500);
  assert.equal((await request("/api/settings/retention", admin)).body.revision, 1);
  assert.equal((await request("/api/settings/audit?action=settings.retention_changed", admin)).body.entries.length, 0);
}));

test("audit search uses an exact correlation across durable identifiers and paginates without gaps", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, login, request }) => {
  await bootstrap();
  const admin = await login();
  const actorId = (await request("/api/me", admin)).body.user.id;
  const createdAt = "2026-10-22T10:00:00.000Z";
  const rows = [
    ["audit-a", "delivery.attempting", "intent-a", { attemptId: "corr-attempt" }],
    ["audit-b", "group.scan_received", "operation-b", { operationId: "corr-operation" }],
    ["audit-c", "reply.prepared", "reply-c", { jobId: "corr-job" }],
  ];
  for (const [id, action, entityId, details] of rows) {
    await pool.query("INSERT INTO audit_entries(id,organization_id,actor_id,action,entity_type,entity_id,details,created_at) VALUES($1,'org_default',$2,$3,'fixture',$4,$5::jsonb,$6)", [id, actorId, action, entityId, JSON.stringify(details), createdAt]);
  }

  for (const correlationId of ["audit-a", "intent-a", "corr-attempt", "corr-operation", "corr-job"]) {
    const result = await request(`/api/settings/audit?correlationId=${encodeURIComponent(correlationId)}`, admin);
    assert.equal(result.status, 200);
    assert.equal(result.body.entries.length, 1, correlationId);
  }
  assert.equal((await request("/api/settings/audit?correlationId=corr", admin)).body.entries.length, 0);

  const first = await request("/api/settings/audit?limit=2", admin);
  assert.equal(first.status, 200);
  assert.equal(first.body.entries.length, 2);
  assert.equal(typeof first.body.nextCursor, "string");
  assert.ok(first.body.nextCursor.length > 10);
  const second = await request(`/api/settings/audit?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`, admin);
  assert.equal(second.status, 200);
  assert.equal(new Set([...first.body.entries, ...second.body.entries].map((entry) => entry.id)).size, 4);
}));

test("readiness separates Meta infrastructure from a current tenant-owned Page connection", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, login, request, addUser }) => {
  await bootstrap();
  const admin = await login();
  const actorId = (await request("/api/me", admin)).body.user.id;
  const foreign = await addUser("admin", "org_default");
  await pool.query("INSERT INTO organizations(id,name) VALUES('foreign-ready','Foreign ready')");
  await pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES('foreign-ready',$1,'admin')", [foreign.id]);

  const legacyOnly = await request("/api/settings/readiness", admin);
  assert.equal(legacyOnly.status, 200);
  assert.equal(legacyOnly.body.metaInfrastructure.appConfigured, true);
  assert.equal(legacyOnly.body.metaInfrastructure.webhookConfigured, true);
  assert.equal(legacyOnly.body.metaInfrastructure.oauthConfigured, true);
  assert.equal(legacyOnly.body.messengerConfigured, false, "legacy environment token cannot claim this organization is connected");
  assert.equal(JSON.stringify(legacyOnly.body).includes("legacy-page-token"), false);

  await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health,expires_at) VALUES('foreign-source','foreign-ready','foreign-page','Foreign Page','connected',now()+interval '1 day')");
  await pool.query("SELECT meta_credential_write('foreign-ready','foreign-source',$1,'page','{}'::jsonb,now()+interval '1 day')", [foreign.id]);
  assert.equal((await request("/api/settings/readiness", admin)).body.messengerConfigured, false, "another tenant connection is never inherited");

  await pool.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health,expires_at) VALUES('local-source','org_default','local-page','Local Page','connected',now()+interval '1 day')");
  let readiness = await request("/api/settings/readiness", admin);
  assert.equal(readiness.body.messengerConfigured, false, "source without its OAuth credential is incomplete");
  assert.deepEqual(readiness.body.pageConnections, [{ id: "local-source", name: "Local Page", health: "connected", expiresAt: readiness.body.pageConnections[0].expiresAt, connected: false }]);

  await pool.query("SELECT meta_credential_write('org_default','local-source',$1,'page','{}'::jsonb,now()-interval '1 minute')", [actorId]);
  assert.equal((await request("/api/settings/readiness", admin)).body.messengerConfigured, false, "expired OAuth state is not current");
  await pool.query("SELECT meta_credential_write('org_default','local-source',$1,'page','{}'::jsonb,now()+interval '1 day')", [actorId]);
  readiness = await request("/api/settings/readiness", admin);
  assert.equal(readiness.body.messengerConfigured, true);
  assert.equal(readiness.body.pageConnections[0].connected, true);
  assert.equal(JSON.stringify(readiness.body).includes("envelope"), false);

  await pool.query("UPDATE meta_page_sources SET health='disconnected' WHERE id='local-source'");
  readiness = await request("/api/settings/readiness", admin);
  assert.equal(readiness.body.messengerConfigured, false);
  assert.equal(readiness.body.pageConnections[0].connected, false);
  await pool.query("UPDATE meta_page_sources SET health='connected',expires_at=now()-interval '1 minute' WHERE id='local-source'");
  readiness = await request("/api/settings/readiness", admin);
  assert.equal(readiness.body.messengerConfigured, false, "expired Page authorization is not current");
  assert.equal(readiness.body.pageConnections[0].connected, false);
}, { environment: {
  OPENAI_API_KEY: "private-api-key",
  META_APP_ID: "meta-app",
  META_APP_SECRET: "meta-app-secret",
  META_VERIFY_TOKEN: "verify-secret",
  META_REDIRECT_URI: "https://radar.example/api/meta/callback",
  META_TOKEN_KEY_VERSION: "one",
  META_TOKEN_KEYS: JSON.stringify({ one: Buffer.alloc(32, 7).toString("base64") }),
  META_PAGE_ID: "legacy-page",
  META_PAGE_ACCESS_TOKEN: "legacy-page-token",
} }));
