import assert from "node:assert/strict";
import test from "node:test";
import { buildFixtureTargets, createSiteBrowser } from "../src/browser.mjs";

test("fixture browser accepts both built-in group URLs", () => {
  const site = createSiteBrowser({ cdpUrl: "unused", mode: "fixture", liveSubmissionEnabled: false, evidencePath: () => "unused" });
  assert.equal(site.normalizeGroupUrl("http://localhost:3000/fixture/groups/1001"), "http://127.0.0.1:3000/fixture/groups/1001");
  assert.equal(site.normalizeGroupUrl("http://127.0.0.1:3000/fixture/groups/1002?ref=test"), "http://127.0.0.1:3000/fixture/groups/1002");
});

test("fixture target keys remain collision-free across groups", () => {
  const posts = [{ postId: "p1", author: "Mali", text: "หาห้องเช่า", comments: [{ commentId: "c1", author: "Nok", text: "สนใจ" }] }];
  const first = buildFixtureTargets("1001", "http://127.0.0.1:3000/fixture/groups/1001", posts, "Tenant group");
  const second = buildFixtureTargets("1002", "http://127.0.0.1:3000/fixture/groups/1002", posts, "Owner group");
  assert.equal(first.groupId, "1001");
  assert.equal(second.groupId, "1002");
  assert.notEqual(first.targets[0].key, second.targets[0].key);
  assert.equal(second.targets[1].key, "fixture:1002:p1:c1");
});
