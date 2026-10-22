import { createHash, randomUUID } from "node:crypto";
import { automationPauseInput, automationPolicy as automationPolicySchema, automationSchedule, policyPreviewInput, sourceUpdatePatch } from "../src/automation/contracts.mjs";
import { evaluatePolicy } from "../src/policy/evaluator.mjs";
import { evaluateSourceDecision } from "../src/policy/source-decision.mjs";
import { readFormat } from "../src/replies/contracts.mjs";
import { evaluateSchedule } from "../src/workers/scheduler.mjs";

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

const defaultSourcePolicy = () => ({
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
    mode: "automatic",
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
    policy: defaultSourcePolicy(),
    health: { session, selector, sessionCircuit, selectorCircuit: false },
    paused: false,
    archived: false,
    revision: 1,
    latestOperation: { operationId, state: "completed", createdAt: seededAt },
    latestReceipt: receipt,
    receiptHistory: [receipt],
    session: { owner: "group-worker", state: session === "healthy" ? "available" : session },
    schedule: schedule(),
  };
}

function failure(status, message, reasonCode) {
  throw Object.assign(new Error(message), { status, reasonCode });
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

export function createSourcesAutomationWorkspaceFixture({
  operationalClock = () => new Date(),
  policyEvaluationClock = () => new Date("2026-10-22T03:00:00.000Z"),
} = {}) {
  let groups = structuredClone(seededSources);
  let globalPaused = false;
  let automationPolicy = structuredClone(policy);
  let policyRevision = 1;
  let format = structuredClone(replyFormat);
  let formatRevision = 1;
  const receipts = [];
  const idempotency = new Map();
  const recoveries = new Map();

  let lastOperationalTime = Date.parse(seededAt);
  const operationalNow = () => {
    const value = +operationalClock();
    if (!Number.isFinite(value)) failure(500, "Invalid fixture operational clock");
    lastOperationalTime = Math.max(value, lastOperationalTime + 1);
    return new Date(lastOperationalTime);
  };
  const now = () => operationalNow().toISOString();
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
  const previewRecords = (entry) => {
    const base = {
      id: `fixture-conversation-${entry.groupId}`,
      label: "บทสนทนา revision 1",
      updatedAt: entry.latestReceipt?.createdAt ?? seededAt,
      counts: { organization: 3, source: 0, conversation: 0 },
    };
    if (entry.mode !== "automatic") return [base];
    return [base, {
      id: `${base.id}-busy`,
      label: "บทสนทนาใกล้ rate limit",
      updatedAt: base.updatedAt,
      counts: { organization: 3, source: entry.policy.rateLimits.source, conversation: entry.policy.rateLimits.conversation },
    }];
  };
  const automationSource = (entry) => ({
    id: entry.id,
    label: entry.canonicalUrl,
    mode: entry.mode,
    policy: structuredClone(entry.policy),
    revision: entry.revision,
    paused: entry.paused,
    health: structuredClone(entry.health),
    previewContexts: previewRecords(entry).map(({ counts: _counts, ...context }) => context),
    schedule: structuredClone(entry.schedule),
  });
  const parse = (schema, value, message = "Invalid automation configuration") => {
    try { return schema.parse(value); } catch { failure(422, message); }
  };
  const productionSource = (entry) => ({
    mode: entry.mode,
    policy: entry.policy,
    kill_switch: entry.paused,
    archived: false,
    allow_listed: entry.allowListed,
    session_health: entry.health.session,
    selector_health: entry.health.selector,
    session_circuit: entry.health.sessionCircuit,
    selector_circuit: entry.health.selectorCircuit,
    archived: entry.archived,
  });
  const requireAutomaticReadiness = (entry) => {
    if (!entry.allowListed) failure(409, "Automatic mode is not ready", "SOURCE_NOT_ALLOWLISTED");
    if (entry.health.session !== "healthy") failure(409, "Automatic mode is not ready", "SESSION_UNHEALTHY");
    if (entry.health.selector !== "healthy") failure(409, "Automatic mode is not ready", "SELECTOR_UNHEALTHY");
    const decision = evaluatePolicy({ ...entry.policy, mode: "automatic" }, {
      grounded: true,
      automaticEligible: true,
      confidence: 1,
      sourceHealth: "connected",
      replyWindowOpen: true,
      counts: { organization: 0, source: 0, conversation: 0 },
    }, operationalNow());
    if (decision.action !== "authorize") failure(409, "Automatic mode is not ready", decision.reasons[0]?.toUpperCase() ?? "AUTOMATIC_NOT_READY");
  };

  return {
    listSources(actorRole = "admin") {
      return {
        actorRole,
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
          policy: defaultSourcePolicy(),
          health: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false },
          paused: false,
          archived: false,
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
        const parsed = parse(sourceUpdatePatch, patch, "Invalid source update");
        const candidate = {
          ...entry,
          ...(Object.hasOwn(parsed, "mode") ? { mode: parsed.mode } : {}),
          ...(Object.hasOwn(parsed, "allowListed") ? { allowListed: parsed.allowListed } : {}),
          ...(Object.hasOwn(parsed, "killSwitch") ? { paused: parsed.killSwitch } : {}),
          ...(Object.hasOwn(parsed, "policy") ? { policy: parsed.policy } : {}),
          ...(Object.hasOwn(parsed, "archived") ? { archived: parsed.archived } : {}),
        };
        const stopping = parsed.mode !== "automatic" && (parsed.killSwitch === true || parsed.archived === true);
        const editingPausedAutomatic = entry.mode === "automatic" && candidate.mode === "automatic" && candidate.paused && parsed.killSwitch !== false;
        if (candidate.mode === "automatic" && !editingPausedAutomatic && !stopping) {
          if (globalPaused) failure(409, "Automatic mode is not ready", "GLOBAL_PAUSED");
          if (candidate.paused) failure(409, "Automatic mode is not ready", "SOURCE_PAUSED");
          if (candidate.health.sessionCircuit) failure(409, "Automatic mode is not ready", "SESSION_CIRCUIT_OPEN");
          if (candidate.health.selectorCircuit) failure(409, "Automatic mode is not ready", "SELECTOR_CIRCUIT_OPEN");
          requireAutomaticReadiness(candidate);
        }
        entry.mode = candidate.mode;
        entry.allowListed = candidate.allowListed;
        entry.paused = candidate.paused;
        entry.policy = structuredClone(candidate.policy);
        entry.archived = candidate.archived;
        entry.revision += 1;
        return publicSource(entry);
      });
    },
    scan(id, input, revision, key) {
      return once(`sources.scan.${id}`, key, { input, revision }, () => {
        const entry = find(id);
        expectRevision(entry, revision);
        if (!input || Object.keys(input).some((name) => name !== "recovery") || (input.recovery !== undefined && typeof input.recovery !== "boolean")) failure(422, "Invalid scan request");
        if (globalPaused) failure(409, "Source automation is paused", "GLOBAL_PAUSED");
        if (entry.paused) failure(409, "Source automation is paused", "SOURCE_PAUSED");
        if (!input.recovery && entry.health.sessionCircuit) failure(409, "Source circuit requires explicit recovery", "SESSION_CIRCUIT_OPEN");
        if (!input.recovery && entry.health.selectorCircuit) failure(409, "Source circuit requires explicit recovery", "SELECTOR_CIRCUIT_OPEN");
        if (entry.mode === "automatic" && !input.recovery) requireAutomaticReadiness(entry);
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
        const expiresAt = new Date(operationalNow().getTime() + ttlSeconds * 1000).toISOString();
        entry.paused = true;
        entry.revision += 1;
        recoveries.set(`${id}:${sessionId}`, { sourceId: id, sessionId, expiresAt });
        return { sourceId: id, sessionId, expiresAt, tunnelUrl: `/api/sources/${encodeURIComponent(id)}/recovery/${sessionId}/novnc/vnc.html` };
      });
    },
    hasRecovery(id, sessionId) {
      const key = `${id}:${sessionId}`;
      const value = recoveries.get(key);
      if (!value) return false;
      if (Date.parse(value.expiresAt) <= operationalNow().getTime()) {
        recoveries.delete(key);
        return false;
      }
      return true;
    },
    closeRecovery(id, sessionId) {
      find(id);
      const key = `${id}:${sessionId}`;
      const value = recoveries.get(key);
      if (!value) failure(404, "Recovery session not found");
      if (Date.parse(value.expiresAt) <= operationalNow().getTime()) {
        recoveries.delete(key);
        failure(404, "Recovery session expired", "RECOVERY_EXPIRED");
      }
      recoveries.delete(key);
    },
    getAutomation(actorRole = "admin") {
      return {
        actorRole,
        paused: globalPaused,
        policy: { value: structuredClone(automationPolicy), revision: policyRevision },
        replyFormat: { value: structuredClone(format), revision: formatRevision },
        sources: groups.map(automationSource),
        receipts: structuredClone(receipts),
      };
    },
    preview(input) {
      const parsed = parse(policyPreviewInput, input, "Invalid policy preview");
      const entry = find(parsed.sourceId);
      const conversation = previewRecords(entry).find((candidate) => candidate.id === parsed.conversationId);
      if (!conversation) failure(404, "Conversation context not found");
      const evaluatedAt = policyEvaluationClock();
      const decision = evaluateSourceDecision({
        organizationPaused: globalPaused,
        organizationPolicy: automationPolicy,
        source: productionSource(entry),
        context: { ...parsed.sample, counts: conversation.counts },
        now: evaluatedAt,
      });
      return {
        source: { id: entry.id, label: entry.canonicalUrl },
        conversation: { id: conversation.id },
        ...decision,
        evaluatedAt: evaluatedAt.toISOString(),
      };
    },
    setGlobalPause(input, key) {
      const parsed = parse(automationPauseInput, input, "Invalid pause state");
      return once("automation.pause", key, parsed, () => {
        globalPaused = parsed.paused;
        const receipt = { id: randomUUID(), scope: "organization", sourceId: null, paused: globalPaused, reasonCode: globalPaused ? "GLOBAL_PAUSED" : "GLOBAL_RESUMED", createdAt: now() };
        receipts.unshift(receipt);
        return { paused: globalPaused, receiptId: receipt.id, reasonCode: receipt.reasonCode };
      });
    },
    savePolicy(input, revision, key) {
      const parsed = parse(automationPolicySchema, input);
      try { evaluatePolicy(parsed, { grounded: true, automaticEligible: true, confidence: 1, sourceHealth: "connected", replyWindowOpen: true, counts: { organization: 0, source: 0, conversation: 0 } }, operationalNow()); } catch { failure(422, "Invalid automation configuration"); }
      return once("automation.policy", key, { input: parsed, revision }, () => {
        if (revision !== policyRevision) failure(409, "Revision conflict");
        automationPolicy = structuredClone(parsed);
        policyRevision += 1;
        return { value: structuredClone(automationPolicy), revision: policyRevision };
      });
    },
    saveReplyFormat(input, revision, key) {
      let parsed;
      try { parsed = readFormat(input); } catch { failure(422, "Invalid automation configuration"); }
      return once("automation.reply-format", key, { input: parsed, revision }, () => {
        if (revision !== formatRevision) failure(409, "Revision conflict");
        format = structuredClone(parsed);
        formatRevision += 1;
        return { value: structuredClone(format), revision: formatRevision };
      });
    },
    setSourcePause(id, input, key) {
      const parsed = parse(automationPauseInput, input, "Invalid pause state");
      return once(`automation.source-pause.${id}`, key, parsed, () => {
        const entry = find(id);
        entry.paused = parsed.paused;
        entry.revision += 1;
        const receipt = { id: randomUUID(), scope: "source", sourceId: id, paused: entry.paused, reasonCode: entry.paused ? "SOURCE_PAUSED" : "SOURCE_RESUMED", createdAt: now() };
        receipts.unshift(receipt);
        return { sourceId: id, paused: entry.paused, revision: entry.revision, updatedAt: now(), receiptId: receipt.id, reasonCode: receipt.reasonCode };
      });
    },
    saveSchedule(id, input, revision, key) {
      const parsed = parse(automationSchedule, input, "Invalid schedule");
      try { evaluateSchedule(parsed, operationalNow(), { completedToday: 0 }); } catch { failure(422, "Invalid schedule"); }
      return once(`automation.schedule.${id}`, key, { input: parsed, revision }, () => {
        const entry = find(id);
        if (entry.schedule.revision !== revision) failure(409, "Revision conflict");
        entry.schedule = { ...structuredClone(parsed), revision: revision + 1 };
        return { sourceId: id, schedule: structuredClone(parsed), revision: entry.schedule.revision };
      });
    },
  };
}
