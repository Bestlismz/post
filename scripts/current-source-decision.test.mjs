import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCurrentSourceDecision } from "../src/policy/current-source-decision.mjs";

const source = { id: "source-1", mode: "automatic", allow_listed: true, archived: false, kill_switch: false, session_health: "healthy", selector_health: "healthy", session_circuit: false, selector_circuit: false, policy: {} };
const policy = { mode: "automatic", minimumConfidence: 0.8, rateLimits: { organization: 10, source: 5, conversation: 1 }, businessHours: { timeZone: "UTC", days: [4], start: "09:00", end: "10:00" } };
const context = { grounded: true, automaticEligible: true, confidence: 0.9, replyWindowOpen: true };

function databaseAt(now, counts) {
  const queries = [];
  return {
    queries,
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes("clock_timestamp")) return { rows: [{ now }] };
      if (sql.includes("delivery_attempts")) {
        assert.equal(values[3], now, "the count window must use the exact database instant");
        return { rows: [counts] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test("preview and final gate share one database instant at hour and business-hour boundaries", async () => {
  const now = new Date("2026-10-22T10:00:00.000Z");
  const input = { organizationId: "org-1", sourceId: source.id, conversationId: "conversation-1", organizationPaused: false, organizationPolicy: policy, source, context };
  const previewDb = databaseAt(now, { organization: 1, source: 1, conversation: 1 });
  const finalDb = databaseAt(now, { organization: 1, source: 1, conversation: 1 });
  const preview = await evaluateCurrentSourceDecision(previewDb, input);
  const final = await evaluateCurrentSourceDecision(finalDb, input);
  assert.deepEqual(preview.decision, final.decision);
  assert.deepEqual(preview.decision.reasons, ["conversation_rate_limit", "business_hours"]);
  assert.equal(preview.evaluatedAt, now);
  assert.equal(final.evaluatedAt, now);
  assert.equal(previewDb.queries.filter(({ sql }) => sql.includes("clock_timestamp")).length, 1);
  assert.equal(finalDb.queries.filter(({ sql }) => sql.includes("clock_timestamp")).length, 1);
});

test("the explicit deterministic clock seam feeds both the rate window and business-hours evaluator", async () => {
  const injected = new Date("2026-10-22T09:59:59.999Z");
  const database = databaseAt(injected, { organization: 0, source: 0, conversation: 0 });
  const result = await evaluateCurrentSourceDecision(database, { organizationId: "org-1", sourceId: source.id, conversationId: "conversation-1", organizationPaused: false, organizationPolicy: policy, source, context }, { clock: () => injected });
  assert.deepEqual(result.decision, { action: "authorize", reasons: [], effectivePolicy: policy });
  assert.equal(database.queries.some(({ sql }) => sql.includes("clock_timestamp")), false);
  assert.equal(database.queries.find(({ sql }) => sql.includes("delivery_attempts")).values[3], injected);
});
