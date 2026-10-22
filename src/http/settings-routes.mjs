import { Router } from "express";
import { requireRole } from "../auth/authorize.mjs";
import { changeSetting, readAudit, readSetting } from "../auth/settings.mjs";
import { commandFor, sendEntity } from "./boundary.mjs";

export function settingsRoutes({ pool, write, env }) {
  const router = Router();
  router.use("/api/settings", requireRole("admin"));
  for (const [route, kind] of [["users", "users"], ["business-profile", "profile"], ["retention", "retention"]]) {
    router.get(`/api/settings/${route}`, async (request, response) => response.json(await readSetting(pool, request.actor.organizationId, kind)));
    if (kind !== "users") for (const method of ["patch", "put"]) router[method](`/api/settings/${route}`, ...write, async (request, response) => sendEntity(response, await changeSetting(pool, kind, commandFor(request, request.body))));
  }
  router.post("/api/settings/users", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "user", commandFor(request, request.body, true)), 201));
  router.patch("/api/settings/users/:id", ...write, async (request, response) => sendEntity(response, await changeSetting(pool, "role", commandFor(request, { ...request.body, id: request.params.id }))));
  router.get("/api/settings/audit", async (request, response) => response.json(await readAudit(pool, request.actor.organizationId, request.query)));
  router.get("/api/settings/readiness", (_request, response) => {
    const meta = ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN"];
    const required = ["OPENAI_API_KEY", ...meta];
    response.json({ databaseConfigured: true, openaiConfigured: Boolean(env.OPENAI_API_KEY), messengerConfigured: meta.every((name) => Boolean(env[name])), missing: required.filter((name) => !env[name]) });
  });
  return router;
}
