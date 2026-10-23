import assert from "node:assert/strict";
import test from "node:test";
import { projectWorkItemWorkflow } from "../src/inbox/workflow.mjs";

const facts = (overrides = {}) => ({
  channel: "facebook_group",
  status: "pending",
  humanTakeover: false,
  successorId: null,
  sourceMode: "approval",
  latestReply: null,
  latestDelivery: null,
  activeAnalysis: false,
  failedAnalysis: false,
  authorizationActorKind: null,
  ...overrides,
});

test("work-item workflow projector has one phase and a safe action set", () => {
  const cases = [
    ["observed", {}, ["prepare", "handoff"]],
    ["analyzing", { activeAnalysis: true }, ["handoff"]],
    ["review_required", { status: "needs_review", latestReply: { id: "r1" } }, ["approve", "handoff"]],
    ["queued", { status: "ready", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "queued" } }, ["handoff"]],
    ["sending", { status: "ready", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "attempting" } }, []],
    ["reconciling", { status: "ready", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "unknown" } }, ["verify_absent_and_retry"]],
    ["send_failed", { status: "failed", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "failed" } }, ["retry_failed_delivery", "handoff"]],
    ["sent", { status: "completed", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "sent" } }, ["edit_sent_comment"]],
    ["handed_off", { status: "handoff", humanTakeover: true }, ["resume"]],
    ["superseded", { status: "superseded", successorId: "next" }, ["open_successor"]],
  ];

  for (const [phase, overrides, actions] of cases) {
    const workflow = projectWorkItemWorkflow(facts(overrides));
    assert.equal(workflow.phase, phase);
    assert.deepEqual(workflow.actions, actions);
  }
});

test("verified send wins over mutable handoff and failed edit facts", () => {
  const workflow = projectWorkItemWorkflow(facts({
    status: "handoff",
    humanTakeover: true,
    latestReply: { id: "r1" },
    latestDelivery: { id: "d1", state: "sent", editState: "failed" },
  }));
  assert.equal(workflow.phase, "sent");
  assert.equal(workflow.reason, "EDIT_FAILED");
  assert.deepEqual(workflow.actions, ["edit_sent_comment"]);
});

test("unknown provider result never exposes prepare or ordinary approve", () => {
  const workflow = projectWorkItemWorkflow(facts({
    status: "ready",
    latestReply: { id: "r1" },
    latestDelivery: { id: "d1", state: "unknown" },
  }));
  assert.equal(workflow.phase, "reconciling");
  assert.deepEqual(workflow.actions, ["verify_absent_and_retry"]);
  assert.equal(workflow.actions.includes("prepare"), false);
  assert.equal(workflow.actions.includes("approve"), false);
});

test("observe mode and Messenger uncertainty never expose commands their APIs reject", () => {
  const observing = projectWorkItemWorkflow(facts({ status: "completed", sourceMode: "observe", latestReply: { id: "r1" } }));
  assert.equal(observing.phase, "observing");
  assert.deepEqual(observing.actions, []);

  const messenger = projectWorkItemWorkflow(facts({
    channel: "messenger",
    status: "ready",
    latestReply: { id: "r1" },
    latestDelivery: { id: "d1", state: "unknown" },
  }));
  assert.equal(messenger.phase, "reconciling");
  assert.deepEqual(messenger.actions, []);
});

test("a fresh active analysis wins over historical failed analysis", () => {
  const workflow = projectWorkItemWorkflow(facts({ status: "preparing", activeAnalysis: true, failedAnalysis: true }));
  assert.equal(workflow.phase, "analyzing");
  assert.deepEqual(workflow.actions, ["handoff"]);
});

test("cancelled delivery has a distinct recovery action from a definitely failed attempt", () => {
  const workflow = projectWorkItemWorkflow(facts({
    status: "ready",
    latestReply: { id: "r1" },
    latestDelivery: { id: "d1", state: "cancelled" },
  }));
  assert.equal(workflow.phase, "send_failed");
  assert.equal(workflow.reason, "DELIVERY_CANCELLED");
  assert.deepEqual(workflow.actions, ["retry_cancelled_delivery", "handoff"]);
});

test("automation reports configuration separately from the actual authorization actor", () => {
  const configuredOnly = projectWorkItemWorkflow(facts({ sourceMode: "automatic", status: "needs_review", latestReply: { id: "r1" } }));
  assert.deepEqual(configuredOnly.automation, { configured: true, outcome: "review" });
  const authorized = projectWorkItemWorkflow(facts({ sourceMode: "automatic", status: "ready", latestReply: { id: "r1" }, latestDelivery: { id: "d1", state: "queued" }, authorizationActorKind: "policy" }));
  assert.deepEqual(authorized.automation, { configured: true, outcome: "authorized" });
});
