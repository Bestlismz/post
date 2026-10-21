import assert from "node:assert/strict";
import test from "node:test";
import { createGroupService } from "../src/groups.mjs";
import { migrateState } from "../src/state.mjs";

function fakeStore(initial = migrateState({}, "2026-10-21T00:00:00.000Z")) {
  let state = structuredClone(initial);
  return {
    read: () => structuredClone(state),
    mutate: async (fn) => {
      const next = structuredClone(state);
      const result = fn(next);
      state = next;
      return structuredClone(result);
    },
  };
}

test("adds URL variants idempotently", async () => {
  const store = fakeStore();
  const service = createGroupService({ store, site: {}, analyze: async () => {}, withBrowserLease: (fn) => fn(), now: () => "2026-10-21T00:00:00.000Z" });
  await service.add("https://facebook.com/groups/100");
  await service.add("https://www.facebook.com/groups/100/?ref=share");
  assert.equal(Object.keys(store.read().groups).length, 1);
});

test("scans enabled groups sequentially and continues after one failure", async () => {
  const state = migrateState({}, "2026-10-21T00:00:00.000Z");
  for (const id of ["100", "200", "300", "400"]) state.groups[id] = { id, url: `https://www.facebook.com/groups/${id}`, name: null, enabled: id !== "400", lastScanAt: null, lastScanState: "never", lastScanDetail: null, createdAt: "2026-10-21T00:00:00.000Z" };
  state.targets["live:100:old:post"] = { key: "live:100:old:post", groupId: "100", kind: "post", fingerprint: "old" };
  const store = fakeStore(state);
  const order = [];
  const site = {
    inspectSession: async () => ({ state: "connected" }),
    scan: async (url) => {
      const id = url.match(/(\d+)$/)[1];
      order.push(`start:${id}`);
      await Promise.resolve();
      if (id === "200") throw new Error("cannot read group");
      order.push(`end:${id}`);
      return { groupId: id, groupName: `Group ${id}`, targets: [{ key: `live:${id}:new:post`, groupId: id, kind: "post", fingerprint: `fp-${id}`, text: "หาห้องเช่า", postText: "หาห้องเช่า", context: [] }] };
    },
  };
  const analyze = async (item) => ({ targetKey: item.key, targetFingerprint: item.fingerprint, businessProfileFingerprint: "profile", score: 80, relevant: true, intent: "tenant_lead", reasons: ["lead"], extracted: {}, source: "deterministic", detail: "test", analyzedAt: "2026-10-21T00:00:00.000Z" });
  const service = createGroupService({ store, site, analyze, withBrowserLease: (fn) => fn(), now: () => "2026-10-21T00:00:00.000Z" });

  const result = await service.scanAll();

  assert.deepEqual(order, ["start:100", "end:100", "start:200", "start:300", "end:300"]);
  assert.equal(result.completed, 2);
  assert.equal(result.failed, 1);
  assert.equal(store.read().groups["200"].lastScanState, "failed");
  assert.equal(store.read().groups["400"].lastScanState, "never");
  assert.equal(store.read().targets["live:100:old:post"], undefined);
  assert.ok(store.read().targets["live:300:new:post"]);
});

test("analyzes only missing or stale targets", async () => {
  const state = migrateState({}, "2026-10-21T00:00:00.000Z");
  state.targets.a = { key: "a", fingerprint: "a1", text: "A", postText: "A", context: [] };
  state.targets.b = { key: "b", fingerprint: "b1", text: "B", postText: "B", context: [] };
  const calls = [];
  const analyze = async (item, profile) => {
    calls.push(item.key);
    return { targetKey: item.key, targetFingerprint: item.fingerprint, businessProfileFingerprint: profile.updatedAt, score: 60, relevant: true, intent: "listing", reasons: [], extracted: {}, source: "deterministic", detail: "", analyzedAt: "2026-10-21T00:00:00.000Z" };
  };
  const fresh = await analyze(state.targets.a, state.businessProfile);
  state.analyses.a = fresh;
  calls.length = 0;
  const store = fakeStore(state);
  const service = createGroupService({ store, site: {}, analyze, isFresh: (analysis, item, profile) => analysis?.targetFingerprint === item.fingerprint && analysis?.businessProfileFingerprint === profile.updatedAt, withBrowserLease: (fn) => fn(), now: () => "2026-10-21T00:00:00.000Z" });

  await service.analyzePending();
  assert.deepEqual(calls, ["b"]);
});
