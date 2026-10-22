import { Router } from "express";
import { z } from "zod";
import { authenticate, checkCsrf, checkOrigin } from "../auth/session.mjs";
import { requireRole } from "../auth/authorize.mjs";
import { errorHandler } from "./boundary.mjs";

export function createMetaConnectionRouter({ pool, config, connection }) {
  const router = Router();
  router.use("/api/meta", authenticate(pool), requireRole("admin"));
  const write = [checkOrigin(config), checkCsrf];
  router.post("/api/meta/connection/begin", ...write, async (req, res) => res.json(await connection.beginMetaConnection(req.actor)));
  router.post("/api/meta/connection/callback", ...write, async (req, res) => res.json(await connection.completeMetaConnection(req.actor, z.strictObject({ code: z.string().min(1).max(4096), state: z.string().length(43) }).parse(req.body))));
  router.get("/api/meta/connection/:connectionId/pages", async (req, res) => res.json(await connection.listEligiblePages(req.actor, req.params.connectionId)));
  router.post("/api/meta/connection/:connectionId/select", ...write, async (req, res) => { const { pageId } = z.strictObject({ pageId: z.string().min(1).max(256) }).parse(req.body); res.json(await connection.selectPage(req.actor, req.params.connectionId, pageId)); });
  router.get("/api/meta/sources/:sourceId/health", async (req, res) => res.json(await connection.inspectPageHealth(req.actor, req.params.sourceId)));
  router.post("/api/meta/sources/:sourceId/disconnect", ...write, async (req, res) => res.json(await connection.disconnectPage(req.actor, req.params.sourceId)));
  router.use(errorHandler);
  return router;
}
