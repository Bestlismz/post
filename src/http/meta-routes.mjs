import express from "express";
import { verifyChallenge } from "../meta-webhook.mjs";
import { acceptMetaWebhook } from "../channels/meta/ingress.mjs";

export function createMetaRouter(options) {
  const router = express.Router();
  router.get("/webhooks/meta", (request, response) => {
    const challenge = verifyChallenge(request.query, options.verifyToken);
    if (challenge === null) return response.sendStatus(403);
    return response.type("text/plain").send(challenge);
  });
  router.post("/webhooks/meta", express.raw({ type: () => true, limit: "256kb", inflate: false }), async (request, response) => {
    const result = await acceptMetaWebhook({ ...options, rawBody: request.body, signature: request.get("x-hub-signature-256") });
    return response.status(result.status).json({ ok: result.status === 200 });
  });
  return router;
}
