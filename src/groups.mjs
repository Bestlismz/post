import { isAnalysisFresh } from "./relevance.mjs";
import { normalizeGroupUrl, preserveSubmittedTargetKeys, upsertGroup } from "./state.mjs";

export function createGroupService({ store, site, analyze, isFresh = isAnalysisFresh, withBrowserLease, now = () => new Date().toISOString() }) {
  async function add(rawUrl) {
    return store.mutate((state) => {
      try {
        return upsertGroup(state, rawUrl, now());
      } catch (error) {
        const canonical = site.normalizeGroupUrl?.(rawUrl);
        const match = canonical && new URL(canonical).pathname.match(/^\/fixture\/groups\/(\d+)$/);
        if (!match) throw error;
        return state.groups[match[1]] ?? (state.groups[match[1]] = {
          id: match[1], url: canonical, name: null, enabled: true,
          lastScanAt: null, lastScanState: "never", lastScanDetail: null, createdAt: now(),
        });
      }
    });
  }

  async function setEnabled(groupId, enabled) {
    return store.mutate((state) => {
      const group = state.groups[groupId];
      if (!group) throw statusError(404, "Group not found.");
      group.enabled = enabled === true;
      return group;
    });
  }

  async function scanOne(groupId) {
    const snapshot = store.read();
    const group = snapshot.groups[groupId];
    if (!group) throw statusError(404, "Group not found.");
    if (!group.enabled) throw statusError(409, "Group monitoring is disabled.");
    await store.mutate((state) => {
      state.groups[groupId].lastScanState = "scanning";
      state.groups[groupId].lastScanDetail = null;
    });
    try {
      const scan = await withBrowserLease(async () => {
        const session = await site.inspectSession(group.url);
        if (session.state !== "connected") throw statusError(409, "Use the browser panel to sign in before scanning.");
        return site.scan(group.url);
      });
      const result = await store.mutate((state) => {
        const stableTargets = preserveSubmittedTargetKeys(scan.targets, state.targets, state.submissions);
        const scannedKeys = new Set(stableTargets.map((target) => target.key));
        for (const [key, target] of Object.entries(state.targets)) {
          if (target.groupId === groupId && !scannedKeys.has(key) && !state.submissions[key]) {
            delete state.targets[key];
            delete state.analyses[key];
          }
        }
        for (const target of stableTargets) {
          const previous = state.targets[target.key];
          state.targets[target.key] = {
            ...target,
            discoveredAt: previous?.discoveredAt ?? now(),
            lastSeenAt: now(),
          };
        }
        const current = state.groups[groupId];
        current.name = scan.groupName ?? current.name;
        current.lastScanAt = now();
        current.lastScanState = "completed";
        current.lastScanDetail = `${stableTargets.length} targets`;
        if (!state.config.groupId) {
          state.config = { groupId, groupUrl: current.url, groupName: current.name };
        }
        return { groupId, count: stableTargets.length, targets: stableTargets };
      });
      await analyzePending(result.targets.map((target) => target.key));
      return result;
    } catch (error) {
      await store.mutate((state) => {
        const current = state.groups[groupId];
        current.lastScanAt = now();
        current.lastScanState = "failed";
        current.lastScanDetail = safeMessage(error);
      });
      throw error;
    }
  }

  async function scanAll() {
    const enabled = Object.values(store.read().groups).filter((group) => group.enabled);
    const outcomes = [];
    for (const group of enabled) {
      try {
        const result = await scanOne(group.id);
        outcomes.push({ groupId: group.id, state: "completed", count: result.count });
      } catch (error) {
        outcomes.push({ groupId: group.id, state: "failed", detail: safeMessage(error) });
      }
    }
    const state = store.read();
    return {
      completed: outcomes.filter((item) => item.state === "completed").length,
      failed: outcomes.filter((item) => item.state === "failed").length,
      targets: Object.keys(state.targets).length,
      relevant: Object.values(state.analyses).filter((item) => item.relevant).length,
      fallback: Object.values(state.analyses).filter((item) => item.source === "deterministic_fallback").length,
      outcomes,
    };
  }

  async function analyzePending(targetKeys = null) {
    const snapshot = store.read();
    const allowed = targetKeys ? new Set(targetKeys) : null;
    const pending = Object.values(snapshot.targets).filter((target) => (
      (!allowed || allowed.has(target.key))
      && !isFresh(snapshot.analyses[target.key], target, snapshot.businessProfile)
    ));
    const results = [];
    for (const target of pending) {
      const result = await analyze(target, snapshot.businessProfile);
      await store.mutate((state) => {
        const current = state.targets[target.key];
        if (current?.fingerprint === target.fingerprint) state.analyses[target.key] = result;
      });
      results.push(result);
    }
    return { count: results.length, analyses: results };
  }

  return { add, setEnabled, scanOne, scanAll, analyzePending };
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : "Group operation failed").slice(0, 240);
}
