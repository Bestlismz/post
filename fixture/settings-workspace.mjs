import { createHash, randomUUID } from "node:crypto";

const seededAt = "2026-10-22T08:30:00.000Z";
const roles = new Set(["admin", "operator", "inventory_manager", "viewer"]);

function failure(status, message) { throw Object.assign(new Error(message), { status }); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function positiveDays(value) { return Number.isInteger(value) && value >= 1 && value <= 3650; }

export function createSettingsWorkspaceFixture() {
  let users = [
    { id: "fixture-admin", email: "admin@rentalradar.test", displayName: "ณัฐวุฒิ", role: "admin", revision: 1 },
    { id: "fixture-operator", email: "ops@rentalradar.test", displayName: "พิมพ์ชนก", role: "operator", revision: 1 },
    { id: "fixture-inventory", email: "rooms@rentalradar.test", displayName: "กมล", role: "inventory_manager", revision: 1 },
  ];
  let profile = { name: "Rental Radar Thailand", description: "บริการหาคอนโดเช่าในกรุงเทพฯ เน้นห้องพร้อมอยู่ใกล้รถไฟฟ้า", relevanceThreshold: 72, revision: 1 };
  let retention = { rawPayloadDays: 30, screenshotDays: 7, revision: 1 };
  let audits = [
    audit("fixture-audit-profile", "fixture-admin", "ณัฐวุฒิ", "settings.profile_changed", "organization", "org_default", { revision: 1, correlationId: "corr-profile-01" }, "2026-10-22T08:30:00.000Z"),
    audit("fixture-audit-sent", "fixture-operator", "พิมพ์ชนก", "delivery.sent", "delivery_intent", "delivery-fixture-18", { attemptId: "corr-send-18" }, "2026-10-22T08:20:00.000Z"),
    audit("fixture-audit-role", "fixture-admin", "ณัฐวุฒิ", "user.role_changed", "user", "fixture-inventory", { role: "inventory_manager" }, "2026-10-22T08:10:00.000Z"),
  ];
  const replays = new Map();
  let sequence = 0;
  const now = () => new Date(Date.parse(seededAt) + (++sequence * 1000)).toISOString();
  const once = (route, key, input, fn) => {
    if (typeof key !== "string" || !key.trim()) failure(422, "Idempotency-Key is required");
    const identity = `${route}:${key}`, requestDigest = digest(input), previous = replays.get(identity);
    if (previous) {
      if (previous.digest !== requestDigest) failure(409, "Idempotency key reused with different request");
      return structuredClone(previous.value);
    }
    const value = fn(); replays.set(identity, { digest: requestDigest, value: structuredClone(value) }); return structuredClone(value);
  };
  const append = (actor, action, entityType, entityId, details) => audits.unshift(audit(randomUUID(), actor.id, actor.displayName, action, entityType, entityId, details, now()));

  return {
    users: () => ({ users: structuredClone(users) }),
    profile: () => structuredClone(profile),
    retention: () => structuredClone(retention),
    readiness: () => ({
      databaseConfigured: true, openaiConfigured: true, messengerConfigured: false, groupWorkerConfigured: true,
      metaInfrastructure: { appConfigured: false, webhookConfigured: false, oauthConfigured: false },
      pageConnections: [],
      missing: ["META_APP_ID", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_REDIRECT_URI", "META_TOKEN_KEY_VERSION", "META_TOKEN_KEYS"],
      integrations: [
        { id: "database", label: "Database", status: "configured" },
        { id: "openai", label: "OpenAI", status: "configured" },
        { id: "meta-app", label: "Meta app", status: "missing", missing: ["META_APP_ID", "META_APP_SECRET"] },
        { id: "meta-webhook", label: "Meta webhook", status: "missing", missing: ["META_APP_SECRET", "META_VERIFY_TOKEN"] },
        { id: "meta-oauth", label: "Meta OAuth", status: "missing", missing: ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_TOKEN_KEY_VERSION", "META_TOKEN_KEYS"] },
        { id: "messenger", label: "Messenger", status: "missing", missing: ["เชื่อมต่อ Facebook Page ขององค์กร"] },
        { id: "group-worker", label: "Group worker", status: "configured" },
      ],
      configuration: { method: "deployment_environment", secretReadback: false },
    }),
    changeRole(id, input, revision, key, actor) {
      return once(`settings.role.${id}`, key, { input, revision }, () => {
        const user = users.find((entry) => entry.id === id);
        if (!user) failure(404, "User not found");
        if (user.revision !== revision) failure(409, "Revision conflict");
        if (!roles.has(input?.role)) failure(422, "Invalid role");
        if (user.role === "admin" && input.role !== "admin" && users.filter((entry) => entry.role === "admin").length === 1) failure(409, "The last admin cannot be demoted");
        user.role = input.role; user.revision += 1;
        append(actor, "user.role_changed", "user", user.id, { revision: user.revision, role: user.role });
        return user;
      });
    },
    saveProfile(input, revision, key, actor) {
      return once("settings.profile", key, { input, revision }, () => {
        if (profile.revision !== revision) failure(409, "Revision conflict");
        if (typeof input?.name !== "string" || !input.name.trim() || typeof input?.description !== "string" || !input.description.trim() || !Number.isInteger(input.relevanceThreshold) || input.relevanceThreshold < 0 || input.relevanceThreshold > 100) failure(422, "Invalid business profile");
        profile = { name: input.name.trim(), description: input.description.trim(), relevanceThreshold: input.relevanceThreshold, revision: profile.revision + 1 };
        append(actor, "settings.profile_changed", "organization", "org_default", { revision: profile.revision, correlationId: `corr-profile-${profile.revision}` });
        return profile;
      });
    },
    saveRetention(input, revision, key, actor) {
      return once("settings.retention", key, { input, revision }, () => {
        if (retention.revision !== revision) failure(409, "Revision conflict");
        if (!positiveDays(input?.rawPayloadDays) || !positiveDays(input?.screenshotDays)) failure(422, "Invalid retention period");
        retention = { rawPayloadDays: input.rawPayloadDays, screenshotDays: input.screenshotDays, revision: retention.revision + 1 };
        append(actor, "settings.retention_changed", "organization", "org_default", { revision: retention.revision });
        return retention;
      });
    },
    audit(input = {}) {
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
      let entries = [...audits].sort(compareAudit).filter((entry) => !input.action || entry.action === input.action);
      if (input.correlationId) entries = entries.filter((entry) => correlations(entry).includes(input.correlationId));
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (cursor) entries = entries.filter((entry) => entry.created_at < cursor.createdAt || (entry.created_at === cursor.createdAt && entry.id < cursor.id));
      const window = entries.slice(0, limit + 1), page = window.slice(0, limit);
      return { entries: structuredClone(page), nextCursor: window.length > limit ? encodeCursor(page.at(-1)) : null };
    },
  };
}

function audit(id, actorId, actorName, action, entityType, entityId, details, createdAt) {
  return { id, organization_id: "org_default", actor_id: actorId, actor_name: actorName, action, entity_type: entityType, entity_id: entityId, details, created_at: createdAt };
}
function correlations(entry) {
  return [entry.id, entry.entity_id, entry.details?.correlationId, entry.details?.attemptId, entry.details?.operationId, entry.details?.jobId, entry.details?.receiptId, entry.details?.replyVersionId].filter(Boolean);
}
function compareAudit(left, right) { return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id); }
function encodeCursor(entry) { return Buffer.from(`${entry.created_at}\0${entry.id}`, "utf8").toString("base64url"); }
function decodeCursor(value) {
  try {
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error();
    const [createdAt, id, ...rest] = decoded.toString("utf8").split("\0");
    if (rest.length || !id || id.length > 200 || new Date(createdAt).toISOString() !== createdAt) throw new Error();
    return { createdAt, id };
  }
  catch { failure(422, "Invalid audit cursor"); }
}
