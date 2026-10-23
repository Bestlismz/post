import assert from "node:assert/strict";
import test from "node:test";
import { createInboxWorkspaceFixture } from "../fixture/inbox-workspace.mjs";
import { createSourcesAutomationWorkspaceFixture } from "../fixture/sources-automation-workspace.mjs";

async function waitForCompleted(workspace, operationId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const source = workspace.listSources().groups.find((entry) => entry.latestOperation?.operationId === operationId);
    if (source?.latestOperation.state === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Scan ${operationId} did not complete`);
}

test("a healthy fixture group scan projects one idempotent post into Inbox", async () => {
  const inbox = createInboxWorkspaceFixture();
  const sources = createSourcesAutomationWorkspaceFixture({
    onObservation: (observation) => inbox.ingestGroupObservation(observation),
  });
  const source = sources.listSources().groups.find((entry) => entry.displayName === "autopost");

  const first = sources.scan(source.id, {}, source.revision, "scan-to-inbox-1");
  await waitForCompleted(sources, first.operationId);

  const projected = inbox.list({ search: "หาห้องถูกๆ" });
  assert.equal(projected.resultCount, 1);
  assert.equal(projected.items[0].participant.label, "B'Best Warut");
  assert.equal(projected.items[0].source.name, "autopost");
  assert.equal(projected.items[0].channel, "facebook_group");

  const second = sources.scan(source.id, {}, source.revision, "scan-to-inbox-2");
  await waitForCompleted(sources, second.operationId);
  assert.equal(inbox.list({ search: "หาห้องถูกๆ" }).resultCount, 1);
});

test("fixture approval is explicitly simulated and never claims external delivery", () => {
  const inbox = createInboxWorkspaceFixture();
  const before = inbox.get("group_1");
  assert.deepEqual(before.deliveryCapability, { mode: "fixture", externalSend: false });

  const receipt = inbox.approve(before.replies[0].id);
  const after = inbox.get("group_1");

  assert.equal(receipt.state, "simulated");
  assert.equal(receipt.simulated, true);
  assert.deepEqual(after.deliveries[0], {
    id: receipt.resourceId,
    replyId: before.replies[0].id,
    state: "simulated",
    simulated: true,
  });
});
