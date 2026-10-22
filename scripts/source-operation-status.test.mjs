import assert from "node:assert/strict";
import test from "node:test";
import { operationStatusReducer } from "../app/sources/operation-status.mjs";

test("retry-required state is operation scoped and survives unrelated group activity", () => {
  const sourceA = { id: "source-a", latestOperation: { operationId: "scan-a", state: "queued" } };
  const sourceB = { id: "source-b", latestOperation: { operationId: "scan-b", state: "queued" } };
  let state = operationStatusReducer({}, { type: "retry_required", sourceId: sourceA.id, operationId: "scan-a" });
  assert.deepEqual(state, { "scan-a": { sourceId: "source-a", state: "retry_required" } });

  state = operationStatusReducer(state, { type: "reconcile", groups: [sourceA, { ...sourceB, latestOperation: { operationId: "scan-b-2", state: "completed" } }] });
  assert.equal(state["scan-a"].state, "retry_required", "B scan and unrelated reload cannot clear A");

  const unchanged = operationStatusReducer(state, { type: "reconcile", groups: [sourceA, sourceB] });
  assert.equal(unchanged, state, "ordinary loads retain durable keyed state");

  state = operationStatusReducer(state, { type: "retry_started", operationId: "scan-a" });
  assert.deepEqual(state, { "scan-a": { sourceId: "source-a", state: "retrying" } }, "A remains scoped while its explicit retry is in flight");
  state = operationStatusReducer(state, { type: "retry_succeeded", operationId: "scan-a" });
  assert.deepEqual(state, {}, "a successful explicit retry clears only A's operation key");
});

test("terminal projection or superseding operation clears only its matching retry state", () => {
  let state = {
    "scan-a": { sourceId: "source-a", state: "retry_required" },
    "scan-b": { sourceId: "source-b", state: "retry_required" },
  };
  state = operationStatusReducer(state, { type: "reconcile", groups: [
    { id: "source-a", latestOperation: { operationId: "scan-a", state: "completed" } },
    { id: "source-b", latestOperation: { operationId: "scan-b", state: "queued" } },
  ] });
  assert.deepEqual(state, { "scan-b": { sourceId: "source-b", state: "retry_required" } });
  state = operationStatusReducer(state, { type: "reconcile", groups: [
    { id: "source-a", latestOperation: { operationId: "scan-a-2", state: "queued" } },
    { id: "source-b", latestOperation: { operationId: "scan-b-2", state: "queued" } },
  ] });
  assert.deepEqual(state, {});
});
