import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { bootstrapAdmin } from "../src/auth/bootstrap.mjs";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { createApplicationRouter } from "../src/http/auth-routes.mjs";
import { createAutomationRouter } from "../src/http/automation-routes.mjs";
import { createRecoveryRegistry, createSourceRouter } from "../src/http/source-routes.mjs";
import { createSourceService } from "../src/sources/service.mjs";

const dbtest = (name, fn) => test(name, { skip: !process.env.TEST_DATABASE_URL }, fn);
const origin = "https://radar.example";

async function fixture(run) {
  const owner = createPool({ databaseUrl: process.env.TEST_DATABASE_URL });
  const schema = `source_ui_${randomUUID().replaceAll("-", "")}`;
  let pool;
  let server;
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    await bootstrapAdmin(pool, { email: "admin@radar.test", password: "long-password-123", displayName: "Admin" });
    await pool.query(`
      INSERT INTO users(id,email,password_hash,display_name) VALUES('viewer','viewer@radar.test','x','Viewer');
      INSERT INTO memberships(organization_id,user_id,role) VALUES('org_default','viewer','viewer');
      INSERT INTO meta_page_sources(id,organization_id,page_id,name,health,expires_at)
      VALUES('page-source','org_default','page-private-id','Rental Radar Page','connected','2026-12-01T00:00:00Z');
    `);
    const sourceService = createSourceService(pool, {
      signingKey: Buffer.alloc(32, 7),
      keyId: "test",
      supportedSelectorVersions: ["facebook-dom-v2"],
    });
    const app = express();
    app.use(express.json());
    app.use(createApplicationRouter({ pool, config: { appOrigin: origin, nodeEnv: "test" } }));
    app.use(createAutomationRouter({ pool, config: { appOrigin: origin } }));
    app.use(createSourceRouter({
      pool,
      config: { appOrigin: origin },
      sourceService,
      recovery: { health: async () => ({ ok: true, session: { state: "healthy" }, recovery: { state: "available" } }), start: async () => assert.fail("recovery called"), stop: async () => assert.fail("recovery called") },
      registry: createRecoveryRegistry(),
      proxyHttp: () => assert.fail("proxy called"),
    }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const loginResponse = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@radar.test", password: "long-password-123" }) });
    const login = await loginResponse.json();
    const session = { cookie: loginResponse.headers.get("set-cookie").split(";")[0], csrf: login.csrfToken };
    const request = async (path, { method = "GET", body, revision, key = randomUUID(), as = session } = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: as.cookie,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET" ? {} : { "X-CSRF-Token": as.csrf, "Idempotency-Key": key }),
          ...(revision === undefined ? {} : { "If-Match": `"${revision}"` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json().catch(() => null);
      return { status: response.status, body: result, headers: response.headers };
    };
    await run({ pool, request });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.end();
  }
}

dbtest("Sources API is tenant scoped, canonical, revisioned, and returns durable scan evidence", async () => fixture(async ({ pool, request }) => {
  const initial = await request("/api/sources");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.pages.map(({ name, health }) => ({ name, health })), [{ name: "Rental Radar Page", health: "connected" }]);
  assert.equal(JSON.stringify(initial.body).includes("page-private-id"), false, "provider page ids stay private");

  const invalid = await request("/api/sources/groups", { method: "POST", body: { url: "https://facebook.com/groups/not-a-number" } });
  assert.equal(invalid.status, 422);
  const added = await request("/api/sources/groups", { method: "POST", body: { url: "https://m.facebook.com/groups/1742522453522327/?ref=share" } });
  assert.equal(added.status, 201);
  assert.equal(added.body.canonicalUrl, "https://www.facebook.com/groups/1742522453522327");
  assert.equal(added.body.groupId, undefined, "provider ids stay server-side");

  const mode = await request(`/api/sources/groups/${added.body.id}`, { method: "PATCH", revision: 1, body: { mode: "approval" } });
  assert.equal(mode.status, 200);
  assert.equal(mode.body.mode, "approval");
  const scan = await request(`/api/sources/groups/${added.body.id}/scans`, { method: "POST", revision: 2, body: {} });
  assert.equal(scan.status, 202);
  assert.deepEqual(Object.keys(scan.body).sort(), ["operationId", "state"]);

  await pool.query(`UPDATE group_sources SET session_health='auth_required',session_circuit=true WHERE id=$1`, [added.body.id]);
  await pool.query(`INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,reason,response)
    VALUES($1,'org_default',$2,$3,'facebook-dom-v2','partial','auth_required','login_required','{}')`, [scan.body.operationId, added.body.id, "a".repeat(64)]);
  const list = await request("/api/sources");
  assert.equal(list.body.groups[0].latestScan.coverage, "partial");
  assert.equal(list.body.groups[0].latestScan.health, "auth_required");
  assert.equal(list.body.groups[0].session.owner, "group-worker");
  assert.equal(JSON.stringify(list.body).includes("signature"), false);
}));

dbtest("Automations API persists exact format and policy revisions and exposes immutable receipts", async () => fixture(async ({ pool, request }) => {
  await pool.query(`INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
    VALUES('source-1','org_default','123','https://www.facebook.com/groups/123','approval',true,'healthy','healthy','facebook-dom-v2')`);
  const initial = await request("/api/automation");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.policy.revision, 1);
  assert.equal(initial.body.replyFormat.value.locale, "th");

  const policy = { mode: "automatic", minimumConfidence: 0.82, rateLimits: { organization: 100, source: 20, conversation: 2 }, businessHours: { timeZone: "Asia/Bangkok", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00" } };
  const savedPolicy = await request("/api/automation/policy", { method: "PUT", revision: 1, body: policy });
  assert.equal(savedPolicy.status, 200);
  assert.deepEqual(savedPolicy.body.value, policy);
  assert.equal(savedPolicy.body.revision, 2);

  const format = { locale: "th", tone: "formal", greetingId: "hello", closingId: "thanks", ctaId: "follow_up", emojiPolicy: "none", maxLength: 700, numberFormat: "grouped", dateFormat: "dmy", requiredDisclosureId: "confirm", forbiddenPhrases: ["รับประกันห้องว่าง"] };
  const savedFormat = await request("/api/automation/reply-format", { method: "PUT", revision: 1, body: format });
  assert.equal(savedFormat.status, 200);
  assert.deepEqual(savedFormat.body.value, format);
  assert.equal(savedFormat.body.revision, 2);

  const preview = await request("/api/automation/policy-preview", { method: "POST", body: { sample: { grounded: true, automaticEligible: true, confidence: 0.9, sourceHealth: "connected", replyWindowOpen: true, counts: { organization: 0, source: 0, conversation: 0 } }, policy } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, { action: "authorize", reasons: [] });

  const paused = await request("/api/automation/pause", { method: "POST", body: { paused: true }, key: "global-pause" });
  assert.equal(paused.status, 200);
  const state = await request("/api/automation");
  assert.equal(state.body.paused, true);
  assert.equal(state.body.receipts[0].reasonCode, "GLOBAL_PAUSED");
  assert.equal(state.body.receipts[0].actorId, undefined);
  assert.equal(JSON.stringify(state.body).includes("admin@radar.test"), false);
}));
