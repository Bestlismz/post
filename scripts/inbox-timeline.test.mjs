import assert from "node:assert/strict";
import test from "node:test";
import { groupTargetBadge, pickGroupPost, visibleGroupComments } from "../app/inbox/timeline.mjs";

test("group conversation renders the current target revision instead of stale post history", () => {
  const stale = { id: "old", uiId: "old-message", kind: "post", text: "corrupt old text" };
  const current = { id: "new", uiId: "new-message", kind: "post", text: "หาห้องย่านพระราม 9", isTarget: true };
  assert.equal(pickGroupPost([stale, current], "new-message"), current);
  assert.equal(pickGroupPost([stale, current], null), current);
});

test("Facebook thread hides the scanned copy of a delivered Rendar comment", () => {
  const thread = [
    { kind: "comment", commentId: "external-1", text: "สนใจค่ะ" },
    { kind: "comment", commentId: "owned-1", text: "ตอบจาก Rendar" },
  ];
  const deliveries = [{ state: "sent", providerMessageId: "owned-1" }];
  assert.deepEqual(visibleGroupComments(thread, deliveries).map((entry) => entry.commentId), ["external-1"]);
});

test("Facebook target badge follows the durable delivery workflow", () => {
  assert.deepEqual(groupTargetBadge({ target: { kind: "post" }, workflow: { phase: "sent" } }), { label: "ตอบแล้ว", tone: "sent" });
  assert.deepEqual(groupTargetBadge({ target: { kind: "comment" }, workflow: { phase: "sending" } }), { label: "กำลังส่ง", tone: "pending" });
  assert.deepEqual(groupTargetBadge({ target: { kind: "post" }, workflow: { phase: "review_required" } }), { label: "โพสต์เป้าหมาย", tone: "target" });
});
