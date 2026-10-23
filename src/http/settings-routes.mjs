import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/authorize.mjs";
import { changeSetting, readAudit, readSetting } from "../auth/settings.mjs";
import { groupCommandKeyConfig } from "../channels/groups/keys.mjs";
import { createMetaCredentialRepository } from "../channels/meta/credentials.mjs";
import { metaConnectionConfig } from "../channels/meta/oauth.mjs";
import { appendAudit, runIdempotent, withTransaction } from "../db/transaction.mjs";
import { commandFor, sendEntity } from "./boundary.mjs";

const missingEnvironment = (env, names) => names.filter((name) => !env[name]);

export const openAIProviderConfigured = (env) =>
  env.OPENAI_PROVIDER_CONFIGURED === "true" || Boolean(env.OPENAI_API_KEY);

const openAIInput = z.strictObject({ apiKey: z.string().trim().min(20).max(512).regex(/^sk-[A-Za-z0-9_-]+$/u) });
const openAICredentialId = (organizationId) => `${organizationId}:provider:openai`;

export async function readOpenAIProvider(pool, organizationId, env) {
  const id = openAICredentialId(organizationId);
  const stored = (await pool.query("SELECT 1 FROM meta_credential_read($1,$2) WHERE kind='openai'", [organizationId, id])).rowCount > 0;
  const environment = openAIProviderConfigured(env);
  return { configured: stored || environment, source: stored ? "secure_store" : environment ? "environment" : "missing", secretReadback: false };
}

async function saveOpenAIProvider({ pool, repository, command }) {
  const input = openAIInput.parse(command.input), id = openAICredentialId(command.organizationId);
  return (await withTransaction(pool, (tx) => runIdempotent(tx, {
    organizationId: command.organizationId, actorId: command.actorId, route: "settings.provider.openai", key: command.idempotencyKey,
    body: input,
  }, async () => {
    await repository.store({ organizationId: command.organizationId, id, actorId: command.actorId, kind: "openai", value: { apiKey: input.apiKey } }, tx);
    await appendAudit(tx, { organizationId: command.organizationId, actorId: command.actorId, action: "provider.openai_configured", entityType: "provider", entityId: "openai", details: { secretReadback: false } });
    return { status: 200, body: { configured: true, source: "secure_store", secretReadback: false } };
  }))).body;
}

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
  const tokenConfig = metaConnectionConfig(env);
  const providerCredentials = createMetaCredentialRepository({ pool, keys: tokenConfig.keys, keyVersion: tokenConfig.keyVersion });
  router.use("/api/settings", requireRole("admin"));
  for (const [route, kind] of [["users", "users"], ["business-profile", "profile"], ["retention", "retention"]]) {
    router.get(`/api/settings/${route}`, async (request, response) => sendEntity(response, await readSetting(pool, request.actor.organizationId, kind)));
    if (kind !== "users") for (const method of ["patch", "put"]) router[method](`/api/settings/${route}`, ...write, async (request, response) => sendEntity(response, await changeSetting(pool, kind, commandFor(request, request.body))));
  }
  router.post("/api/settings/users", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "user", commandFor(request, request.body, true)), 201));
  router.patch("/api/settings/users/:id", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "role", commandFor(request, { ...request.body, id: request.params.id }))));
  router.get("/api/settings/audit", async (request, response) => response.json(await readAudit(pool, request.actor.organizationId, request.query)));
  router.get("/api/settings/providers/openai", async (request, response) => response.json(await readOpenAIProvider(pool, request.actor.organizationId, env)));
  router.put("/api/settings/providers/openai", ...write, async (request, response) => response.json(await saveOpenAIProvider({ pool, repository: providerCredentials, command: commandFor(request, request.body, true) })));
  router.get("/api/settings/readiness", async (request, response) => {
    const metaApp = ["META_APP_ID", "META_APP_SECRET"];
    const metaWebhook = ["META_APP_SECRET", "META_VERIFY_TOKEN"];
    const metaOauth = ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_TOKEN_KEY_VERSION", "META_TOKEN_KEYS"];
    const appMissing = missingEnvironment(env, metaApp);
    const webhookMissing = missingEnvironment(env, metaWebhook);
    const oauthMissing = missingEnvironment(env, metaOauth);
    const openaiProvider = await readOpenAIProvider(pool, request.actor.organizationId, env);
    const openaiConfigured = openaiProvider.configured;
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
      openaiProvider,
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
      metaPoc: {
        mode: env.POC_MODE === "fixture" ? "fixture" : "production",
        callbackPath: "/webhooks/meta",
        callbackUrl: env.META_PUBLIC_WEBHOOK_URL || null,
        tunnelStatus: env.META_PUBLIC_WEBHOOK_URL?.startsWith("https://") ? "connected" : "inactive",
        verifyTokenConfigured: Boolean(env.META_VERIFY_TOKEN),
        appSecretConfigured: Boolean(env.META_APP_SECRET),
        pageAccessTokenConfigured: Boolean(env.META_PAGE_ACCESS_TOKEN) || messengerConfigured,
        externalDeliveryEnabled: env.POC_LIVE_SUBMISSION === "true",
      },
    });
  });
  return router;
}
