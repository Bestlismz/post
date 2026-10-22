import { Router } from "express";
import { requireRole } from "../auth/authorize.mjs";
import { changeSetting, readAudit, readSetting } from "../auth/settings.mjs";
import { groupCommandKeyConfig } from "../channels/groups/keys.mjs";
import { commandFor, sendEntity } from "./boundary.mjs";

const missingEnvironment = (env, names) => names.filter((name) => !env[name]);

function metaOauthConfigurationIsValid(env) {
  try {
    const keys = JSON.parse(env.META_TOKEN_KEYS ?? "{}");
    const encoded = keys?.[env.META_TOKEN_KEY_VERSION];
    if (typeof encoded !== "string") return false;
    const key = Buffer.from(encoded, "base64");
    return key.length === 32 && key.toString("base64") === encoded;
  } catch { return false; }
}

export async function readPageConnections(pool, organizationId) {
  const { rows } = await pool.query(`
    SELECT s.id,s.name,s.health,s.expires_at,
      (s.health='connected' AND (s.expires_at IS NULL OR s.expires_at>now()) AND EXISTS (
        SELECT 1 FROM meta_credential_read($1,s.id) credential
        WHERE credential.kind='page' AND (credential.expires_at IS NULL OR credential.expires_at>now())
      )) AS connected
    FROM meta_page_sources s
    WHERE s.organization_id=$1
    ORDER BY s.name,s.id`, [organizationId]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    health: row.health,
    expiresAt: row.expires_at?.toISOString() ?? null,
    connected: row.connected,
  }));
}

export function settingsRoutes({ pool, write, env }) {
  const router = Router();
  router.use("/api/settings", requireRole("admin"));
  for (const [route, kind] of [["users", "users"], ["business-profile", "profile"], ["retention", "retention"]]) {
    router.get(`/api/settings/${route}`, async (request, response) => sendEntity(response, await readSetting(pool, request.actor.organizationId, kind)));
    if (kind !== "users") for (const method of ["patch", "put"]) router[method](`/api/settings/${route}`, ...write, async (request, response) => sendEntity(response, await changeSetting(pool, kind, commandFor(request, request.body))));
  }
  router.post("/api/settings/users", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "user", commandFor(request, request.body, true)), 201));
  router.patch("/api/settings/users/:id", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "role", commandFor(request, { ...request.body, id: request.params.id }))));
  router.get("/api/settings/audit", async (request, response) => response.json(await readAudit(pool, request.actor.organizationId, request.query)));
  router.get("/api/settings/readiness", async (request, response) => {
    const metaApp = ["META_APP_ID", "META_APP_SECRET"];
    const metaWebhook = ["META_APP_SECRET", "META_VERIFY_TOKEN"];
    const metaOauth = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_TOKEN_KEY_VERSION", "META_TOKEN_KEYS"];
    const appMissing = missingEnvironment(env, metaApp);
    const webhookMissing = missingEnvironment(env, metaWebhook);
    const oauthMissing = missingEnvironment(env, metaOauth);
    const openaiConfigured = Boolean(env.OPENAI_API_KEY);
    const metaInfrastructure = {
      appConfigured: appMissing.length === 0,
      webhookConfigured: webhookMissing.length === 0,
      oauthConfigured: oauthMissing.length === 0 && metaOauthConfigurationIsValid(env),
    };
    if (oauthMissing.length === 0 && !metaInfrastructure.oauthConfigured) oauthMissing.push("META_TOKEN_KEYS");
    const pageConnections = await readPageConnections(pool, request.actor.organizationId);
    const messengerConfigured = pageConnections.some((source) => source.connected);
    let groupWorkerConfigured = false;
    try { groupWorkerConfigured = Boolean(env.GROUP_WORKER_URL && groupCommandKeyConfig(env, { optional: true })); } catch { /* readiness stays redacted and fail-closed */ }
    const groupWorkerMissing = ["GROUP_WORKER_URL", "GROUP_COMMAND_KEY_ID", "GROUP_COMMAND_KEYS"].filter((name) => !env[name]);
    const missing = [...new Set([
      ...(!openaiConfigured ? ["OPENAI_API_KEY"] : []),
      ...appMissing,
      ...webhookMissing,
      ...oauthMissing,
    ])];
    response.json({
      databaseConfigured: true,
      openaiConfigured,
      messengerConfigured,
      groupWorkerConfigured,
      metaInfrastructure,
      pageConnections,
      missing,
      integrations: [
        { id: "database", label: "Database", status: "configured" },
        { id: "openai", label: "OpenAI", status: openaiConfigured ? "configured" : "missing", ...(!openaiConfigured ? { missing: ["OPENAI_API_KEY"] } : {}) },
        { id: "meta-app", label: "Meta app", status: metaInfrastructure.appConfigured ? "configured" : "missing", ...(!metaInfrastructure.appConfigured ? { missing: appMissing } : {}) },
        { id: "meta-webhook", label: "Meta webhook", status: metaInfrastructure.webhookConfigured ? "configured" : "missing", ...(!metaInfrastructure.webhookConfigured ? { missing: webhookMissing } : {}) },
        { id: "meta-oauth", label: "Meta OAuth", status: metaInfrastructure.oauthConfigured ? "configured" : "missing", ...(!metaInfrastructure.oauthConfigured ? { missing: oauthMissing } : {}) },
        { id: "messenger", label: "Messenger", status: messengerConfigured ? "configured" : "missing", ...(!messengerConfigured ? { missing: ["เชื่อมต่อ Facebook Page ขององค์กร"] } : {}) },
        { id: "group-worker", label: "Group worker", status: groupWorkerConfigured ? "configured" : "missing", ...(!groupWorkerConfigured ? { missing: groupWorkerMissing.length ? groupWorkerMissing : ["GROUP_COMMAND_KEYS"] } : {}) },
      ],
      configuration: { method: "deployment_environment", secretReadback: false },
    });
  });
  return router;
}
