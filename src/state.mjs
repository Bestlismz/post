import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const defaultBusinessProfile = (now) => ({
  id: "business_default",
  name: "ธุรกิจหาห้องเช่าและคอนโด",
  description: "ช่วยผู้เช่าหาห้องหรือคอนโด และช่วยเจ้าของประกาศปล่อยเช่า",
  relevantIntents: ["tenant_lead", "owner_lead", "listing"],
  relevanceThreshold: 60,
  updatedAt: now,
});

const defaultReplyProfile = (now) => ({
  id: "reply_default",
  language: "th",
  tone: "friendly",
  greeting: "สวัสดีค่ะ",
  closing: "",
  maxLength: 500,
  requiredPhrases: [],
  forbiddenPhrases: [],
  answerUnknownWith: "acknowledge_and_handoff",
  humanHandoffKeywords: ["คุยกับคน", "เจ้าหน้าที่", "แอดมิน"],
  updatedAt: now,
});

const emptyState = (now) => ({
  version: 3,
  config: { groupUrl: null, groupId: null, groupName: null },
  businessProfile: defaultBusinessProfile(now),
  replyProfile: defaultReplyProfile(now),
  messengerConfig: {
    pageId: null,
    pageName: null,
    enabled: false,
    minimumAutoReplyConfidence: 75,
    lastWebhookAt: null,
    lastSendAt: null,
  },
  groups: {},
  targets: {},
  analyses: {},
  drafts: {},
  reviews: {},
  submissions: {},
  messengerThreads: {},
  messengerMessages: {},
  messengerOutbound: {},
  processedWebhookEvents: {},
  fixtureReplies: [],
  fixtureMessengerSends: [],
  events: [],
});

export function createStore(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, "evidence"), { recursive: true });
  const file = path.join(stateDir, "poc-state.json");
  let state = load(file, new Date().toISOString());
  let queue = Promise.resolve();

  let recovered = false;
  for (const submission of Object.values(state.submissions)) {
    if (submission.state === "attempted") {
      submission.state = "unknown";
      submission.detail = "The app restarted after reserving this target. No retry is allowed.";
      recovered = true;
    }
  }
  if (recovered) atomicWrite(file, state);

  return {
    read() {
      return structuredClone(state);
    },
    mutate(mutator) {
      const operation = queue.then(() => {
        const next = structuredClone(state);
        const result = mutator(next);
        next.events = next.events.slice(-99);
        atomicWrite(file, next);
        state = next;
        return structuredClone(result);
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    evidencePath(id) {
      if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error("Invalid evidence ID");
      return path.join(stateDir, "evidence", `${id}.png`);
    },
  };
}

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function publicState(state, runtime) {
  return {
    mode: runtime.mode,
    liveSubmissionEnabled: runtime.liveSubmissionEnabled,
    openAIConfigured: runtime.openAIConfigured,
    model: runtime.model,
    browserBusy: runtime.browserBusy,
    browserOperation: runtime.browserOperation,
    config: state.config,
    businessProfile: state.businessProfile,
    replyProfile: state.replyProfile,
    messenger: {
      ...state.messengerConfig,
      configured: Boolean(runtime.messengerConfigured),
    },
    groups: Object.values(state.groups),
    targets: Object.values(state.targets),
    analyses: Object.values(state.analyses),
    drafts: Object.values(state.drafts),
    submissions: Object.values(state.submissions),
    messengerThreads: Object.values(state.messengerThreads),
    messengerMessages: Object.values(state.messengerMessages),
    messengerOutbound: Object.values(state.messengerOutbound),
    events: state.events.slice(-12).reverse(),
  };
}

export function migrateState(input = {}, now = new Date().toISOString()) {
  const source = input && typeof input === "object" ? structuredClone(input) : {};
  const next = { ...emptyState(now), ...source, version: 3 };
  next.config = { ...emptyState(now).config, ...(source.config ?? {}) };
  next.businessProfile = { ...defaultBusinessProfile(now), ...(source.businessProfile ?? {}) };
  next.replyProfile = { ...defaultReplyProfile(now), ...(source.replyProfile ?? {}) };
  next.messengerConfig = { ...emptyState(now).messengerConfig, ...(source.messengerConfig ?? {}), enabled: source.messengerConfig?.enabled === true };
  for (const field of [
    "groups", "targets", "analyses", "drafts", "reviews", "submissions",
    "messengerThreads", "messengerMessages", "messengerOutbound", "processedWebhookEvents",
  ]) {
    next[field] = source[field] && typeof source[field] === "object" && !Array.isArray(source[field])
      ? source[field]
      : {};
  }
  next.fixtureReplies = Array.isArray(source.fixtureReplies) ? source.fixtureReplies : [];
  next.fixtureMessengerSends = Array.isArray(source.fixtureMessengerSends) ? source.fixtureMessengerSends : [];
  next.events = Array.isArray(source.events) ? source.events : [];

  if (next.config.groupId && next.config.groupUrl && !next.groups[next.config.groupId]) {
    next.groups[next.config.groupId] = {
      id: next.config.groupId,
      url: next.config.groupUrl.replace(/\/$/, ""),
      name: next.config.groupName ?? null,
      enabled: true,
      lastScanAt: null,
      lastScanState: "never",
      lastScanDetail: null,
      createdAt: now,
    };
  }
  for (const [groupId, group] of Object.entries(next.groups)) {
    next.groups[groupId] = {
      id: groupId,
      url: group.url,
      name: group.name ?? null,
      enabled: group.enabled !== false,
      lastScanAt: group.lastScanAt ?? null,
      lastScanState: group.lastScanState ?? "never",
      lastScanDetail: group.lastScanDetail ?? null,
      createdAt: group.createdAt ?? now,
    };
  }
  return next;
}

export function normalizeGroupUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    throw new Error("Enter a numeric Facebook Group URL.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  const match = parsed.pathname.match(/^\/groups\/(\d+)\/?$/);
  if (parsed.protocol !== "https:" || host !== "facebook.com" || !match) {
    throw new Error("Enter a numeric Facebook Group URL.");
  }
  return { id: match[1], url: `https://www.facebook.com/groups/${match[1]}` };
}

export function upsertGroup(state, rawUrl, now = new Date().toISOString()) {
  const canonical = normalizeGroupUrl(rawUrl);
  if (!state.groups) state.groups = {};
  const existing = state.groups[canonical.id];
  state.groups[canonical.id] = existing ?? {
    id: canonical.id,
    url: canonical.url,
    name: null,
    enabled: true,
    lastScanAt: null,
    lastScanState: "never",
    lastScanDetail: null,
    createdAt: now,
  };
  return state.groups[canonical.id];
}

export function preserveSubmittedTargetKeys(scannedTargets, existingTargets, submissions) {
  const consumed = new Set();
  const submittedTargets = Object.entries(existingTargets)
    .filter(([key]) => submissions[key])
    .map(([key, target]) => ({ key, target }));

  return scannedTargets.map((target) => {
    if (submissions[target.key]) return target;
    const legacy = submittedTargets.find(({ key, target: previous }) => (
      !consumed.has(key)
      && previous.groupId === target.groupId
      && previous.kind === target.kind
      && previous.fingerprint === target.fingerprint
      && (!previous.author || !target.author || previous.author === target.author)
    ));
    if (!legacy) return target;
    consumed.add(legacy.key);
    return { ...target, key: legacy.key };
  });
}

function load(file, now) {
  if (!fs.existsSync(file)) return emptyState(now);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return migrateState(parsed, now);
  } catch {
    throw new Error(`State file is unreadable: ${file}`);
  }
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

