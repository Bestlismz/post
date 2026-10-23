import assert from "node:assert/strict";
import test from "node:test";
import { pickGroupPost } from "../app/inbox/timeline.mjs";

test("group conversation renders the current target revision instead of stale post history", () => {
  const stale = { id: "old", uiId: "old-message", kind: "post", text: "corrupt old text" };
  const current = { id: "new", uiId: "new-message", kind: "post", text: "หาห้องย่านพระราม 9", isTarget: true };
  assert.equal(pickGroupPost([stale, current], "new-message"), current);
  assert.equal(pickGroupPost([stale, current], null), current);
});
