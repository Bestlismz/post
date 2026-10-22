import { createHash, randomUUID } from "node:crypto";

const policy = {
  mode: "automatic",
  minimumConfidence: 0.82,
  rateLimits: { organization: 100, source: 20, conversation: 2 },
  businessHours: { timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "19:00" },
};

const replyFormat = {
  locale: "th",
  tone: "friendly",
  greetingId: "hello",
  closingId: "thanks",
  ctaId: "requirements",
  emojiPolicy: "none",
  maxLength: 900,
  numberFormat: "grouped",
  dateFormat: "dmy",
  requiredDisclosureId: "snapshot",
  forbiddenPhrases: [],
};

const sourcePolicy = () => ({
  rateLimits: structuredClone(policy.rateLimits),
  businessHours: structuredClone(policy.businessHours),
});

const schedule = () => ({
  enabled: true,
  cadenceMinutes: 15,
  timeZone: "Asia/Bangkok",
  days: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "20:00",
  dailyLimit: 48,
  maintenanceWindows: [],
  revision: 1,
});

const seededAt = "2026-10-22T08:30:00.000Z";
const seededSources = [
  source({
    id: "fixture-group-on-nut",
    groupId: "1742522453522327",
    mode: "approval",
    session: "healthy",
    selector: "healthy",
    coverage: "complete",
    receiptHealth: "healthy",
  }),
  source({
    id: "fixture-group-ari",
    groupId: "100200300400500",
    mode: "observe",
    session: "auth_required",
    selector: "healthy",
    sessionCircuit: true,
    coverage: "partial",
    receiptHealth: "auth_required",
    reason: "session_unavailable",
  }),
];

function source({ id, groupId, mode, session, selector, sessionCircuit = false, coverage, receiptHealth, reason = null }) {
  const operationId = `fixture-scan-${groupId}`;
  const receipt = { operationId, coverage, health: receiptHealth, reason, createdAt: seededAt };
  return {
    id,
    groupId,
    canonicalUrl: `https://www.facebook.com/groups/${groupId}`,
    mode,
    allowListed: true,
    policy: sourcePolicy(),
    health: { session, selector, sessionCircuit, selectorCircuit: false },
    paused: false,
    revision: 1,
    latestOperation: { operationId, state: "completed", createdAt: seededAt },
    latestReceipt: receipt,
    receiptHistory: [receipt],
    session: { owner: "group-worker", state: session === "healthy" ? "available" : session },
    schedule: schedule(),
  };
}

function failure(status, message) {
  throw Object.assign(new Error(message), { status });
}

function canonicalGroupUrl(value) {
  if (typeof value !== "string") failure(422, "Invalid group URL");
  const match = /^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/(\d+)\/?(?:\?[^#]*)?$/.exec(value.trim());
  if (!match) failure(422, "Invalid group URL");
  return { groupId: match[1], canonicalUrl: `https://www.facebook.com/groups/${match[1]}` };
}

function bodyDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSourcesAutomationWorkspaceFixture({ clock = () => new Date() } = {}) {
  let groups = structuredClone(seededSources);
  let globalPaused = false;
  let automationPolicy = structuredClone(policy);
  let policyRevision = 1;
  let format = structuredClone(replyFormat);
  let formatRevision = 1;
  const receipts = [];
  const idempotency = new Map();
  const recoveries = new Map();

  const now = () => clock().toISOString();
  const find = (id) => {
    const entry = groups.find((candidate) => candidate.id === id);
    if (!entry) failure(404, "Source not found");
    return entry;
  };
  const expectRevision = (entry, revision) => {
    if (!Number.isSafeInteger(revision) || entry.revision !== revision) failure(409, "Revision conflict");
  };
  const once = (route, key, input, operation) => {
    if (typeof key !== "string" || !key.trim() || key.length > 200) failure(422, "Invalid idempotency key");
    const identity = `${route}:${key}`;
    const digest = bodyDigest(input);
    const prior = idempotency.get(identity);
    if (prior) {
      if (prior.digest !== digest) failure(409, "Idempotency key reused with different request");
      return structuredClone(prior.result);
    }
    const result = operation();
    idempotency.set(identity, { digest, result: structuredClone(result) });
    return structuredClone(result);
  };
  const publicSource = (entry) => {
    const { groupId: _groupId, schedule: _schedule, ...value } = entry;
    return structuredClone(value);
  };
  const automationSource = (entry) => ({
    id: entry.id,
    label: entry.canonicalUrl,
    mode: entry.mode,
    policy: structuredClone(entry.policy),
    revision: entry.revision,
    paused: entry.paused,
    health: structuredClone(entry.health),
    previewContexts: [{
      id: `fixture-conversation-${entry.groupId}`,
      label: "บทสนทนา revision 1",
      updatedAt: entry.latestReceipt?.createdAt ?? seededAt,
    }],
    schedule: structuredClone(entry.schedule),
  });

  return {
    listSources() {
      return {
        actorRole: "admin",
        pages: [{ id: "fixture-page", name: "Rental Radar Thailand", health: "connected", expiresAt: "2026-12-01T00:00:00.000Z", updatedAt: seededAt }],
        groups: groups.map(publicSource),
      };
    },
    addGroup(input, key) {
      return once("sources.add", key, input, () => {
        const identity = canonicalGroupUrl(input?.url);
        const existing = groups.find((entry) => entry.groupId === identity.groupId);
        if (existing) return publicSource(existing);
        const entry = {
          id: randomUUID(),
          ...identity,
          mode: "observe",
          allowListed: false,
          policy: sourcePolicy(),
          health: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false },
          paused: false,
          revision: 1,
          latestOperation: null,
          latestReceipt: null,
          receiptHistory: [],
          session: { owner: "group-worker", state: "available" },
          schedule: schedule(),
        };
        groups.push(entry);
        return publicSource(entry);
      });
    },
    updateGroup(id, patch, revision, key) {
      return once(`sources.update.${id}`, key, { patch, revision }, () => {
        const entry = find(id);
        expectRevision(entry, revision);
        if (!patch || Object.keys(patch).some((name) => !["mode", "allowListed", "policy", "killSwitch"].includes(name))) failure(422, "Invalid source update");
        if (patch.mode && !["observe", "approval", "automatic"].includes(patch.mode)) failure(422, "Invalid source mode");
        if (patch.mode === "automatic" && (entry.health.session !== "healthy" || entry.health.selector !== "healthy" || entry.health.sessionCircuit || entry.health.selectorCircuit || !entry.allowListed || entry.paused || globalPaused)) failure(409, "Automatic mode is not ready");
        if (patch.mode) entry.mode = patch.mode;
        if (typeof patch.allowListed === "boolean") entry.allowListed = patch.allowListed;
        if (patch.policy) entry.policy = structuredClone(patch.policy);
        if (typeof patch.killSwitch === "boolean") entry.paused = patch.killSwitch;
        entry.revision += 1;
        return publicSource(entry);
      });
    },
    scan(id, input, revision, key) {
      return once(`sources.scan.${id}`, key, { input, revision }, () => {
        const entry = find(id);
        expectRevision(entry, revision);
        const operationId = randomUUID();
        entry.latestOperation = { operationId, state: "queued", createdAt: now() };
        const finish = () => {
          if (entry.latestOperation?.operationId !== operationId) return;
          const healthy = entry.health.session === "healthy" && entry.health.selector === "healthy";
          const receipt = {
            operationId,
            coverage: healthy ? "complete" : "partial",
            health: healthy ? "healthy" : entry.health.session,
            reason: healthy ? null : "session_unavailable",
            createdAt: now(),
          };
          entry.latestOperation = { ...entry.latestOperation, state: "completed" };
          entry.latestReceipt = receipt;
          entry.receiptHistory = [receipt, ...entry.receiptHistory].slice(0, 5);
        };
        const timer = setTimeout(finish, 75);
        timer.unref?.();
        return { operationId, state: "queued" };
      });
    },
    browserHealth(id) {
      const entry = find(id);
      const ok = entry.health.session === "healthy" && entry.health.selector === "healthy";
      return {
        sourceId: entry.id,
        sourceHealth: { ...structuredClone(entry.health), paused: entry.paused },
        browser: { ok, session: { state: entry.health.session }, recovery: { state: "available" } },
      };
    },
    beginRecovery(id, input, key) {
      return once(`sources.recovery.${id}`, key, input, () => {
        const entry = find(id);
        const ttlSeconds = Number(input?.ttlSeconds);
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) failure(422, "Invalid recovery duration");
        const sessionId = randomUUID();
        const expiresAt = new Date(clock().getTime() + ttlSeconds * 1000).toISOString();
        entry.paused = true;
        entry.revision += 1;
        recoveries.set(`${id}:${sessionId}`, { sourceId: id, sessionId, expiresAt });
        return { sourceId: id, sessionId, expiresAt, tunnelUrl: `/api/sources/${encodeURIComponent(id)}/recovery/${sessionId}/novnc/vnc.html` };
      });
    },
    hasRecovery(id, sessionId) {
      const value = recoveries.get(`${id}:${sessionId}`);
      return Boolean(value && Date.parse(value.expiresAt) > clock().getTime());
    },
    closeRecovery(id, sessionId) {
      find(id);
      if (!recoveries.delete(`${id}:${sessionId}`)) failure(404, "Recovery session not found");
    },
    getAutomation() {
      return {
        actorRole: "admin",
        paused: globalPaused,
        policy: { value: structuredClone(automationPolicy), revision: policyRevision },
        replyFormat: { value: structuredClone(format), revision: formatRevision },
        sources: groups.map(automationSource),
        receipts: structuredClone(receipts),
      };
    },
    preview(input) {
      const entry = find(input?.sourceId);
      const conversation = automationSource(entry).previewContexts.find((candidate) => candidate.id === input?.conversationId);
      if (!conversation) failure(404, "Conversation context not found");
      const sample = input?.sample ?? {};
      const reasons = [];
      if (globalPaused) reasons.push("global_pause");
      if (entry.paused) reasons.push("source_pause");
      if (entry.mode === "observe") reasons.push("observe_mode");
      if (entry.mode === "approval") reasons.push("approval_required");
      if (!sample.grounded || !sample.automaticEligible) reasons.push("ungrounded");
      if (Number(sample.confidence) < automationPolicy.minimumConfidence) reasons.push("confidence");
      if (!sample.replyWindowOpen) reasons.push("reply_window");
      if (entry.health.session !== "healthy") reasons.push("source_session_unhealthy");
      if (entry.health.selector !== "healthy") reasons.push("source_selector_unhealthy");
      if (entry.health.sessionCircuit) reasons.push("session_circuit_open");
      if (entry.health.selectorCircuit) reasons.push("selector_circuit_open");
      return {
        source: { id: entry.id, label: entry.canonicalUrl },
        conversation: { id: conversation.id },
        effectivePolicy: { ...structuredClone(automationPolicy), mode: entry.mode },
        action: reasons.length ? (entry.mode === "observe" ? "observe" : "review") : "authorize",
        reasons,
        evaluatedAt: now(),
      };
    },
    setGlobalPause(input, key) {
      return once("automation.pause", key, input, () => {
        if (typeof input?.paused !== "boolean") failure(422, "Invalid pause state");
        globalPaused = input.paused;
        const receipt = { id: randomUUID(), scope: "organization", sourceId: null, paused: globalPaused, reasonCode: globalPaused ? "GLOBAL_PAUSED" : "GLOBAL_RESUMED", createdAt: now() };
        receipts.unshift(receipt);
        return { paused: globalPaused, receiptId: receipt.id, reasonCode: receipt.reasonCode };
      });
    },
    savePolicy(input, revision, key) {
      return once("automation.policy", key, { input, revision }, () => {
        if (revision !== policyRevision) failure(409, "Revision conflict");
        automationPolicy = structuredClone(input);
        policyRevision += 1;
        return { value: structuredClone(automationPolicy), revision: policyRevision };
      });
    },
    saveReplyFormat(input, revision, key) {
      return once("automation.reply-format", key, { input, revision }, () => {
        if (revision !== formatRevision) failure(409, "Revision conflict");
        format = structuredClone(input);
        formatRevision += 1;
        return { value: structuredClone(format), revision: formatRevision };
      });
    },
    setSourcePause(id, input, key) {
      return once(`automation.source-pause.${id}`, key, input, () => {
        const entry = find(id);
        if (typeof input?.paused !== "boolean") failure(422, "Invalid pause state");
        entry.paused = input.paused;
        entry.revision += 1;
        const receipt = { id: randomUUID(), scope: "source", sourceId: id, paused: entry.paused, reasonCode: entry.paused ? "SOURCE_PAUSED" : "SOURCE_RESUMED", createdAt: now() };
        receipts.unshift(receipt);
        return { sourceId: id, paused: entry.paused, revision: entry.revision, updatedAt: now(), receiptId: receipt.id, reasonCode: receipt.reasonCode };
      });
    },
    saveSchedule(id, input, revision, key) {
      return once(`automation.schedule.${id}`, key, { input, revision }, () => {
        const entry = find(id);
        if (entry.schedule.revision !== revision) failure(409, "Revision conflict");
        entry.schedule = { ...structuredClone(input), revision: revision + 1 };
        return { sourceId: id, schedule: structuredClone(input), revision: entry.schedule.revision };
      });
    },
  };
}
