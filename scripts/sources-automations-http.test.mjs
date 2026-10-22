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
import { signResult } from "../src/channels/groups/contracts.mjs";
import { createGroupResultService } from "../src/workers/group-results.mjs";

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
    const signingKey = Buffer.alloc(32, 7);
    const sourceService = createSourceService(pool, {
      signingKey,
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
    const acceptScanResult = createGroupResultService(pool, { keys: { test: signingKey }, signingKey, keyId: "test", supportedSelectorVersions: ["facebook-dom-v2"] }).acceptScanResult;
    await run({ pool, request, acceptScanResult, signingKey });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool?.end();
    await owner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.end();
  }
}

dbtest("Sources API keeps pending operations separate from immutable scan evidence and observes worker completion", async () => fixture(async ({ pool, request, acceptScanResult, signingKey }) => {
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
  const completed = await request(`/api/sources/groups/${added.body.id}/scans`, { method: "POST", revision: 2, body: {} });
  assert.equal(completed.status, 202);
  await pool.query(`INSERT INTO group_scan_receipts(operation_id,organization_id,source_id,digest,selector_version,coverage,health,reason,response)
    VALUES($1,'org_default',$2,$3,'facebook-dom-v2','complete','healthy',NULL,'{}')`, [completed.body.operationId, added.body.id, "a".repeat(64)]);
  const pending = await request(`/api/sources/groups/${added.body.id}/scans`, { method: "POST", revision: 2, body: {} });
  assert.equal(pending.status, 202);
  assert.deepEqual(Object.keys(pending.body).sort(), ["operationId", "state"]);

  const whilePending = await request("/api/sources");
  assert.equal(whilePending.body.groups[0].latestOperation.operationId, pending.body.operationId);
  assert.equal(whilePending.body.groups[0].latestOperation.state, "queued");
  assert.equal(whilePending.body.groups[0].latestReceipt.operationId, completed.body.operationId, "new work must not hide prior evidence");
  assert.equal(whilePending.body.groups[0].latestReceipt.coverage, "complete");
  assert.equal(whilePending.body.groups[0].receiptHistory.length, 1);

  const { rows: [operation] } = await pool.query("SELECT command FROM group_operations WHERE id=$1", [pending.body.operationId]);
  const { signature: _signature, ...command } = operation.command;
  const now = new Date();
  const result = signResult({ ...command, kind: "ScanResult", issuedAt: now.toISOString(), selectorVersion: "facebook-dom-v2", coverage: "partial", health: "auth_required", reason: "session_unavailable", observations: [] }, { key: signingKey, keyId: "test", now });
  await acceptScanResult(result);

  const deadline = Date.now() + 1500;
  let afterWorker;
  do { afterWorker = await request("/api/sources"); if (afterWorker.body.groups[0].latestOperation.state === "completed") break; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.equal(afterWorker.body.groups[0].latestOperation.state, "completed");
  assert.equal(afterWorker.body.groups[0].latestReceipt.operationId, pending.body.operationId);
  assert.equal(afterWorker.body.groups[0].latestReceipt.coverage, "partial");
  assert.equal(afterWorker.body.groups[0].latestReceipt.health, "auth_required");
  assert.equal(afterWorker.body.groups[0].receiptHistory.length, 2);
  assert.equal(afterWorker.body.groups[0].session.owner, "group-worker");
  assert.equal(JSON.stringify(afterWorker.body).includes("signature"), false);
  const changedMode = await request(`/api/sources/groups/${added.body.id}`, { method: "PATCH", revision: 2, body: { mode: "observe" } });
  assert.equal(changedMode.status, 200);
  const afterMode = await request("/api/sources");
  assert.equal(afterMode.body.groups[0].mode, "observe");
  assert.equal(afterMode.body.groups[0].latestReceipt.operationId, pending.body.operationId, "mode mutation cannot erase immutable scan evidence");
}));

dbtest("Automations API persists exact format and policy revisions and exposes immutable receipts", async () => fixture(async ({ pool, request }) => {
  await pool.query(`INSERT INTO group_sources(id,organization_id,group_id,canonical_url,mode,allow_listed,session_health,selector_health,selector_version)
    VALUES('source-1','org_default','123','https://www.facebook.com/groups/123','approval',true,'healthy','healthy','facebook-dom-v2');
    INSERT INTO conversations(id,organization_id,channel,page_id,psid,processing_revision)
    VALUES('conversation-1','org_default','facebook_group','facebook_group:123','facebook_group_target:456',1)`);
  const initial = await request("/api/automation");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.policy.revision, 1);
  assert.equal(initial.body.replyFormat.value.locale, "th");
  assert.deepEqual(initial.body.sources[0].previewContexts.map(({ id }) => id), ["conversation-1"]);

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

  const preview = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.source.id, "source-1");
  assert.equal(preview.body.action, "review");
  assert.deepEqual(preview.body.reasons, ["approval_required"]);

  await pool.query("UPDATE group_sources SET mode='automatic',policy=$2 WHERE id=$1", ["source-1", JSON.stringify({ rateLimits: { organization: 100, source: 1, conversation: 2 }, businessHours: policy.businessHours })]);
  const automatic = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert.equal(automatic.body.action, "authorize");
  assert.equal(automatic.body.effectivePolicy.rateLimits.source, 1, "source override is authoritative");

  await pool.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,processing_revision,raw_evidence)
    VALUES('message-1','org_default','conversation-1','facebook_group:123','message-1','lead',1,'{}');
    INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision,status)
    VALUES('work-1','org_default','conversation-1','message-1',1,'ready');
    INSERT INTO reply_versions(id,organization_id,work_item_id,conversation_id,conversation_revision,version,content,context)
    VALUES('reply-1','org_default','work-1','conversation-1',1,1,'{}','{}');
    INSERT INTO reply_authorizations(id,organization_id,work_item_id,reply_version_id,actor_kind,evidence)
    VALUES('authorization-1','org_default','work-1','reply-1','policy','{}');
    INSERT INTO delivery_intents(id,organization_id,authorization_id,reply_version_id,conversation_id,group_source_id,content)
    VALUES('intent-1','org_default','authorization-1','reply-1','conversation-1','source-1','{}');
    INSERT INTO delivery_attempts(id,organization_id,delivery_intent_id,state)
    VALUES('attempt-1','org_default','intent-1','sent')`);
  await pool.query("UPDATE organizations SET automation_policy=jsonb_set(automation_policy,'{rateLimits}','{\"organization\":1,\"source\":20,\"conversation\":1}'); UPDATE group_sources SET policy='{}' WHERE id='source-1'");
  const limited = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert(limited.body.reasons.includes("conversation_rate_limit"), "preview uses the selected conversation attempt ledger");
  assert(limited.body.reasons.includes("organization_rate_limit"), "preview uses the same organization window as the final gate");

  const paused = await request("/api/automation/pause", { method: "POST", body: { paused: true }, key: "global-pause" });
  assert.equal(paused.status, 200);
  const globalPaused = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert(globalPaused.body.reasons.includes("global_pause"));
  const sourcePaused = await request("/api/automation/sources/source-1/pause", { method: "POST", body: { paused: true }, key: "source-pause" });
  assert.equal(sourcePaused.body.revision, 2);
  assert.equal(typeof sourcePaused.body.updatedAt, "string");
  const pausedSourceDecision = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert(pausedSourceDecision.body.reasons.includes("source_pause"));
  const stalePolicy = await request("/api/sources/groups/source-1", { method: "PATCH", revision: 1, body: { policy: { rateLimits: policy.rateLimits, businessHours: policy.businessHours } } });
  assert.equal(stalePolicy.status, 409);
  const freshPolicy = await request("/api/sources/groups/source-1", { method: "PATCH", revision: sourcePaused.body.revision, body: { policy: { rateLimits: policy.rateLimits, businessHours: policy.businessHours } } });
  assert.equal(freshPolicy.status, 200);
  await pool.query("UPDATE organizations SET group_automation_paused=false; UPDATE group_sources SET kill_switch=false,session_health='failed',selector_health='failed',session_circuit=true,selector_circuit=true WHERE id='source-1'");
  const unhealthy = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert(unhealthy.body.reasons.includes("source_session_unhealthy"));
  assert(unhealthy.body.reasons.includes("source_selector_unhealthy"));
  assert(unhealthy.body.reasons.includes("session_circuit_open"));
  assert(unhealthy.body.reasons.includes("selector_circuit_open"));
  await pool.query("UPDATE group_sources SET mode='observe',session_health='healthy',selector_health='healthy',session_circuit=false,selector_circuit=false WHERE id='source-1'");
  const observe = await request("/api/automation/policy-preview", { method: "POST", body: { sourceId: "source-1", conversationId: "conversation-1", sample: { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true } } });
  assert.equal(observe.body.action, "observe");
  assert(observe.body.reasons.includes("observe_mode"));
  const state = await request("/api/automation");
  assert.equal(state.body.receipts.some(receipt => receipt.reasonCode === "GLOBAL_PAUSED"), true);
  assert.equal(state.body.receipts[0].actorId, undefined);
  assert.equal(JSON.stringify(state.body).includes("admin@radar.test"), false);
}));
