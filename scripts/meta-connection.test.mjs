import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { bootstrapAdmin } from "../src/auth/bootstrap.mjs";
import { createApplicationRouter } from "../src/http/auth-routes.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("official Meta connection protects state, Page selection, credentials and tenant authorization", { skip: !databaseUrl }, async (t) => {
  const module = await import("../src/channels/meta/oauth.mjs").catch(() => ({}));
  assert.equal(typeof module.createMetaConnection, "function", "Meta OAuth boundary is required");
  const admin = createPool({ databaseUrl });
  const schema = `connection_${randomUUID().replaceAll("-", "")}`;
  let pool, server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href }); await migrate(pool);
    await bootstrapAdmin(pool, { email: "meta@example.com", password: "long-password-123", displayName: "Meta admin" });
    const userId = (await pool.query("SELECT id FROM users")).rows[0].id;
    const actor = { id: userId, organizationId: "org_default", role: "admin" };
    const config = { appId: "app", appSecret: "app-private", redirectUri: "https://radar.example/settings/meta/callback", graphVersion: "v24.0", keyVersion: "k1", keys: { k1: Buffer.alloc(32, 7) } };
    let permissions = ["pages_show_list", "pages_manage_metadata", "pages_messaging"], revoked = false, failCleanup = false, cleanupSawLocalRevocation = false, pageToken = "private-page-one", now = Date.now(), tokenExpires = 0;
    const http = async (input, options = {}) => {
      const url = new URL(input), token = options.headers?.Authorization;
      assert.equal(url.origin, "https://graph.facebook.com");
      if (url.pathname.endsWith("/oauth/access_token")) {
        assert.equal(options.method, "POST");
        assert.equal(new URLSearchParams(options.body).get("client_secret"), "app-private");
        return Response.json({ access_token: "private-user", token_type: "bearer", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/me/permissions")) {
        assert.equal(token, "Bearer private-user");
        return Response.json({ data: permissions.map((permission) => ({ permission, status: "granted" })) });
      }
      if (url.pathname.endsWith("/me/accounts")) return Response.json({ data: [{ id: "page1", name: "Rental Page", access_token: pageToken, tasks: ["MESSAGING", "MANAGE"] }, { id: "ineligible", name: "No messaging", access_token: "private-ineligible", tasks: ["ANALYZE"] }] });
      if (url.pathname.endsWith("/debug_token")) return Response.json({ data: { app_id: "app", is_valid: !revoked, profile_id: "page1", scopes: permissions, expires_at: tokenExpires } });
      if (url.pathname.endsWith("/subscribed_apps")) {
        if (options.method === "DELETE") cleanupSawLocalRevocation = (await pool.query("SELECT health FROM meta_page_sources WHERE page_id='page1'")).rows[0]?.health === "disconnected";
        if (failCleanup && options.method === "DELETE") throw new Error(pageToken);
        return Response.json({ success: true });
      }
      if (url.pathname.endsWith("/me")) return revoked ? Response.json({ error: { code: 190, message: pageToken } }, { status: 400 }) : Response.json({ id: "page1", name: "Rental Page" });
      throw new Error("Unexpected provider request");
    };
    const service = module.createMetaConnection({ pool, config, http, clock: () => now });
    const complete = async () => { const begun = await service.beginMetaConnection(actor); const state = new URL(begun.authorizationUrl).searchParams.get("state"); return service.completeMetaConnection(actor, { code: "official-code", state }); };
    let connection, source;
    await t.test("random single-use expiring state is bound to the initiating administrator and organization", async () => {
      const begun = await service.beginMetaConnection(actor), second = await service.beginMetaConnection(actor);
      const state = new URL(begun.authorizationUrl).searchParams.get("state");
      assert.notEqual(state, new URL(second.authorizationUrl).searchParams.get("state"));
      assert.equal(new URL(begun.authorizationUrl).hostname, "www.facebook.com");
      await assert.rejects(service.completeMetaConnection({ ...actor, id: "other-admin" }, { code: "x", state }), { status: 403 });
      await assert.rejects(service.completeMetaConnection({ ...actor, organizationId: "other" }, { code: "x", state }), { status: 403 });
      await assert.rejects(service.completeMetaConnection(actor, { code: "x", state: state + "x" }), { status: 403 });
      connection = await service.completeMetaConnection(actor, { code: "official-code", state });
      await assert.rejects(service.completeMetaConnection(actor, { code: "x", state }), { status: 403 });
      const expired = new URL(second.authorizationUrl).searchParams.get("state"); now += 601_000;
      await assert.rejects(service.completeMetaConnection(actor, { code: "x", state: expired }), { status: 403 });
      now -= 601_000;
    });
    await t.test("missing permissions and unlisted Pages cannot connect", async () => {
      permissions = ["pages_show_list"];
      await assert.rejects(complete(), { status: 422 }); permissions.push("pages_manage_metadata", "pages_messaging");
      assert.deepEqual(await service.listEligiblePages(actor, connection.id), [{ id: "page1", name: "Rental Page" }]);
      await assert.rejects(service.selectPage(actor, connection.id, "ineligible"), { status: 422 });
      source = await service.selectPage(actor, connection.id, "page1");
      assert.equal(source.health, "connected"); assert.equal(source.pageId, "page1");
      await assert.rejects(service.selectPage(actor, connection.id, "page1"), { status: 404 });
    });
    await t.test("stored secrets are authenticated ciphertext and public health and audit are redacted", async () => {
      const stored = (await pool.query("SELECT envelope FROM meta_credentials")).rows;
      assert.equal(JSON.stringify(stored).includes(pageToken), false);
      assert.ok(stored.every(({ envelope }) => envelope.version === "k1"));
      const publicData = JSON.stringify(source) + JSON.stringify(await service.inspectPageHealth(actor, source.id)) + JSON.stringify((await pool.query("SELECT details FROM audit_entries")).rows);
      for (const secret of [pageToken, "private-user", "app-private", ...stored.map(({ envelope }) => envelope.ciphertext)]) assert.equal(publicData.includes(secret), false);
      const { createMetaCredentialRepository } = await import("../src/channels/meta/credentials.mjs");
      const repository = createMetaCredentialRepository({ pool, keys: config.keys, keyVersion: "k1" });
      await repository.withPageToken(actor.organizationId, source.id, async (token) => assert.equal(token, pageToken));
      await assert.rejects(repository.withPageToken("other", source.id, async () => assert.fail("cross-tenant token")), { status: 404 });
      const saved = (await pool.query("SELECT envelope FROM meta_credentials WHERE id=$1", [source.id])).rows[0].envelope;
      await pool.query("UPDATE meta_credentials SET envelope=jsonb_set(envelope,'{ciphertext}',to_jsonb('tampered'::text)) WHERE id=$1", [source.id]);
      await assert.rejects(repository.withPageToken(actor.organizationId, source.id, async () => assert.fail("tampered token")), /Credential unavailable/);
      await pool.query("UPDATE meta_credentials SET envelope=$2 WHERE id=$1", [source.id, saved]);
    });
    await t.test("rotation is atomic, health reflects revocation and disconnect removes local authorization despite cleanup failure", async () => {
      pageToken = "private-page-two";
      const next = await complete();
      await pool.query("CREATE FUNCTION reject_meta_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER reject_meta_update BEFORE UPDATE ON meta_page_sources FOR EACH ROW EXECUTE FUNCTION reject_meta_update()");
      await assert.rejects(service.selectPage(actor, next.id, "page1"));
      const { createMetaCredentialRepository } = await import("../src/channels/meta/credentials.mjs");
      const repository = createMetaCredentialRepository({ pool, keys: config.keys, keyVersion: "k1" });
      await repository.withPageToken(actor.organizationId, source.id, async (token) => assert.equal(token, "private-page-one"));
      await pool.query("DROP TRIGGER reject_meta_update ON meta_page_sources");
      const rotated = await service.selectPage(actor, next.id, "page1"); assert.equal(rotated.id, source.id);
      await repository.withPageToken(actor.organizationId, source.id, async (token) => assert.equal(token, pageToken));
      revoked = true; assert.equal((await service.inspectPageHealth(actor, source.id)).health, "revoked");
      failCleanup = true; assert.equal((await service.disconnectPage(actor, source.id)).health, "disconnected");
      assert.equal(cleanupSawLocalRevocation, true, "local authorization must commit before remote cleanup");
      await assert.rejects(repository.withPageToken(actor.organizationId, source.id, async () => assert.fail("disconnected token")), { status: 404 });
    });
    await t.test("environment fallback uses redacted health without persisting credentials", async () => {
      const before = (await pool.query("SELECT count(*)::int AS n FROM meta_credentials")).rows[0].n;
      const fallback = module.createMetaConnection({ pool, config, http, env: { META_ORGANIZATION_ID: "org_default", META_PAGE_ID: "page1", META_PAGE_ACCESS_TOKEN: "environment-private" } });
      const health = await fallback.inspectPageHealth(actor, "environment"); assert.equal(health.health, "revoked");
      assert.equal(JSON.stringify(health).includes("environment-private"), false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM meta_credentials")).rows[0].n, before);
    });
    await t.test("Page token expiry and scopes are checked before connecting and persisted for health", async () => {
      revoked = false;
      const next = await complete();
      tokenExpires = Math.floor(now / 1000) - 1;
      await assert.rejects(service.selectPage(actor, next.id, "page1"), { status: 422 });
      tokenExpires = Math.floor(now / 1000) + 60;
      const rotated = await service.selectPage(actor, next.id, "page1");
      assert.equal(rotated.expiresAt, new Date(tokenExpires * 1000).toISOString());
      now += 61_000;
      assert.equal((await service.inspectPageHealth(actor, rotated.id)).health, "expired");
      now -= 61_000; tokenExpires = 0;
    });
    await t.test("transport exceptions cannot inject credentials into application errors", async () => {
      const unsafe = module.createMetaConnection({ pool, config, http: async () => { throw Object.assign(new Error("private-user"), { status: 502 }); } });
      const begun = await unsafe.beginMetaConnection(actor);
      await assert.rejects(unsafe.completeMetaConnection(actor, { code: "code", state: new URL(begun.authorizationUrl).searchParams.get("state") }), (error) => error.message === "Meta request failed");
    });
    await t.test("an old health check cannot revoke a newly rotated credential", async () => {
      let release, started;
      const gate = new Promise((resolve) => { release = resolve; });
      const entered = new Promise((resolve) => { started = resolve; });
      const delayed = module.createMetaConnection({ pool, config, clock: () => now, http: async (url, options) => {
        if (new URL(url).pathname.endsWith("/me")) { started(); await gate; return Response.json({ error: { code: 190 } }, { status: 400 }); }
        return http(url, options);
      } });
      const next = await complete();
      const pendingHealth = delayed.inspectPageHealth(actor, source.id);
      await entered;
      const rotation = service.selectPage(actor, next.id, "page1");
      // Rotation may wait for the health lock; release the check independently.
      setTimeout(release, 20);
      await rotation; await pendingHealth;
      assert.equal((await pool.query("SELECT health FROM meta_page_sources WHERE id=$1", [source.id])).rows[0].health, "connected");
    });
    await t.test("HTTP requires authentication, admin role, Origin and CSRF; source access is tenant-scoped", async () => {
      const { createMetaConnectionRouter } = await import("../src/http/meta-connection-routes.mjs");
      const app = express(); app.use(express.json());
      const authConfig = { appOrigin: "https://radar.example", nodeEnv: "production" };
      app.use(createApplicationRouter({ pool, config: authConfig })); app.use(createMetaConnectionRouter({ pool, config: authConfig, connection: service }));
      server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await fetch(base + "/api/meta/connection/begin", { method: "POST" })).status, 401);
      const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { Origin: authConfig.appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "meta@example.com", password: "long-password-123" }) });
      const session = await login.json(), cookie = login.headers.get("set-cookie").split(";")[0];
      const headers = { Cookie: cookie, Origin: authConfig.appOrigin, "X-CSRF-Token": session.csrfToken };
      for (const invalid of [{ ...headers, Origin: "https://evil.example" }, { ...headers, "X-CSRF-Token": "wrong" }]) assert.equal((await fetch(base + "/api/meta/connection/begin", { method: "POST", headers: invalid })).status, 403);
      assert.equal((await fetch(base + "/api/meta/connection/begin", { method: "POST", headers })).status, 200);
      await pool.query("UPDATE memberships SET role='operator' WHERE user_id=$1", [userId]);
      assert.equal((await fetch(base + "/api/meta/connection/begin", { method: "POST", headers })).status, 403);
      await assert.rejects(service.beginMetaConnection({ ...actor, role: "operator" }), { status: 403 });
      await assert.rejects(service.inspectPageHealth({ ...actor, organizationId: "other" }, source.id), { status: 404 });
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
});
