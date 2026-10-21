import assert from "node:assert/strict";
import test from "node:test";
import { migrateState, normalizeGroupUrl, upsertGroup } from "../src/state.mjs";

const now = "2026-10-21T07:00:00.000Z";

test("migrates version 1 without unlocking submissions", () => {
  const submission = {
    id: "attempt_1",
    targetKey: "live:1742522453522327:post-1:post",
    state: "verified",
    exactText: "ส่งแล้ว",
    evidenceId: "proof_1",
  };
  const migrated = migrateState({
    version: 1,
    config: {
      groupUrl: "https://www.facebook.com/groups/1742522453522327",
      groupId: "1742522453522327",
      groupName: "Condo Leads",
    },
    targets: { [submission.targetKey]: { key: submission.targetKey, groupId: "1742522453522327" } },
    drafts: {},
    reviews: {},
    submissions: { [submission.targetKey]: submission },
    fixtureReplies: [],
    events: [],
  }, now);

  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.submissions[submission.targetKey], submission);
  assert.deepEqual(migrated.groups["1742522453522327"], {
    id: "1742522453522327",
    url: "https://www.facebook.com/groups/1742522453522327",
    name: "Condo Leads",
    enabled: true,
    lastScanAt: null,
    lastScanState: "never",
    lastScanDetail: null,
    createdAt: now,
  });
  assert.equal(migrated.messengerConfig.enabled, false);
});

test("accepts version 2 draft state", () => {
  const migrated = migrateState({
    version: 2,
    groups: {
      "100": { id: "100", url: "https://www.facebook.com/groups/100", name: "Saved", enabled: false },
    },
    targets: {}, drafts: {}, reviews: {}, submissions: {}, analyses: {}, fixtureReplies: [], events: [],
  }, now);

  assert.equal(migrated.version, 3);
  assert.equal(migrated.groups["100"].name, "Saved");
  assert.equal(migrated.groups["100"].enabled, false);
  assert.deepEqual(migrated.messengerThreads, {});
});

test("canonicalizes numeric Facebook group URLs", () => {
  assert.deepEqual(
    normalizeGroupUrl(" https://m.facebook.com/groups/1742522453522327/?ref=share "),
    { id: "1742522453522327", url: "https://www.facebook.com/groups/1742522453522327" },
  );
  assert.throws(() => normalizeGroupUrl("https://www.facebook.com/groups/condo-bangkok"), /numeric Facebook Group/);
  assert.throws(() => normalizeGroupUrl("https://example.com/groups/1742522453522327"), /numeric Facebook Group/);
});

test("upserts URL variants as one group", () => {
  const state = migrateState({}, now);
  const first = upsertGroup(state, "https://facebook.com/groups/1742522453522327", now);
  const second = upsertGroup(state, "https://www.facebook.com/groups/1742522453522327/?ref=bookmarks", "2026-10-22T07:00:00.000Z");

  assert.equal(first.id, second.id);
  assert.equal(Object.keys(state.groups).length, 1);
  assert.equal(state.groups[first.id].createdAt, now);
});
