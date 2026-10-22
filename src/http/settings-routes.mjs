import { Router } from "express";
import { requireRole } from "../auth/authorize.mjs";
import { changeSetting, readAudit, readSetting } from "../auth/settings.mjs";
import { groupCommandKeyConfig } from "../channels/groups/keys.mjs";
import { commandFor, sendEntity } from "./boundary.mjs";

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
  router.get("/api/settings/readiness", (_request, response) => {
    const meta = ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN"];
    const required = ["OPENAI_API_KEY", ...meta];
    const openaiConfigured = Boolean(env.OPENAI_API_KEY);
    const messengerConfigured = meta.every((name) => Boolean(env[name]));
    let groupWorkerConfigured = false;
    try { groupWorkerConfigured = Boolean(env.GROUP_WORKER_URL && groupCommandKeyConfig(env, { optional: true })); } catch { /* readiness stays redacted and fail-closed */ }
    const groupWorkerMissing = ["GROUP_WORKER_URL", "GROUP_COMMAND_KEY_ID", "GROUP_COMMAND_KEYS"].filter((name) => !env[name]);
    response.json({
      databaseConfigured: true,
      openaiConfigured,
      messengerConfigured,
      groupWorkerConfigured,
      missing: required.filter((name) => !env[name]),
      integrations: [
        { id: "database", label: "Database", status: "configured" },
        { id: "openai", label: "OpenAI", status: openaiConfigured ? "configured" : "missing", ...(!openaiConfigured ? { missing: ["OPENAI_API_KEY"] } : {}) },
        { id: "messenger", label: "Messenger", status: messengerConfigured ? "configured" : "missing", ...(!messengerConfigured ? { missing: meta.filter((name) => !env[name]) } : {}) },
        { id: "group-worker", label: "Group worker", status: groupWorkerConfigured ? "configured" : "missing", ...(!groupWorkerConfigured ? { missing: groupWorkerMissing.length ? groupWorkerMissing : ["GROUP_COMMAND_KEYS"] } : {}) },
      ],
      configuration: { method: "deployment_environment", secretReadback: false },
    });
  });
  return router;
}
