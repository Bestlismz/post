import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const emptyState = () => ({
  version: 1,
  config: { groupUrl: null, groupId: null, groupName: null },
  targets: {},
  drafts: {},
  reviews: {},
  submissions: {},
  fixtureReplies: [],
  events: [],
});

export function createStore(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, "evidence"), { recursive: true });
  const file = path.join(stateDir, "poc-state.json");
  let state = load(file);
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
    config: state.config,
    targets: Object.values(state.targets),
    drafts: Object.values(state.drafts),
    submissions: Object.values(state.submissions),
    events: state.events.slice(-12).reverse(),
  };
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

function load(file) {
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyState(), ...parsed };
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

