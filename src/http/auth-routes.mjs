import { Router } from "express";
import { z } from "zod";
import { verifyPassword, hashPassword } from "../auth/password.mjs";
import { authenticate, checkCsrf, checkOrigin, createSession, readSessionToken, rotateCsrfToken, sessionCookie } from "../auth/session.mjs";
import { reserveLoginAttempt, resetAccountAttempts } from "../auth/login-throttle.mjs";
import { httpError } from "../auth/authorize.mjs";
import { withTransaction } from "../db/transaction.mjs";
import { inventoryRoutes } from "./inventory-routes.mjs";
import { settingsRoutes } from "./settings-routes.mjs";
import { errorHandler } from "./boundary.mjs";

const loginInput = z.strictObject({ email: z.email().transform((email) => email.toLowerCase()), password: z.string().min(1).max(1024) });
const dummyHash = hashPassword("unusable-placeholder");
export function createApplicationRouter({ pool, config, env = process.env }) {
  const router = Router();
  const origin = checkOrigin(config), write = [origin, checkCsrf];
  router.post("/api/auth/login", origin, async (request, response) => {
    const input = loginInput.parse(request.body);
    const { retryAfter } = await reserveLoginAttempt(pool, { email: input.email, ip: request.ip });
    if (retryAfter) throw Object.assign(httpError(429, "Too many login attempts"), { retryAfter });
    const { rows: [row] } = await pool.query("SELECT u.id,u.email,u.display_name,u.password_hash,m.organization_id,m.role FROM users u JOIN memberships m ON u.id=m.user_id WHERE lower(u.email)=$1 AND m.organization_id='org_default'", [input.email]);
    const valid = await verifyPassword(input.password, row?.password_hash ?? await dummyHash);
    if (!row || !valid) throw httpError(401, "Invalid email or password");
    const actor = { id: row.id, organizationId: row.organization_id, role: row.role, email: row.email, displayName: row.display_name };
    const session = await withTransaction(pool, async (tx) => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [actor.organizationId]);
      await resetAccountAttempts(tx, input.email);
      return createSession(tx, actor, readSessionToken(request));
    });
    response.set("Set-Cookie", sessionCookie(session.token, config)).json({ user: actor, csrfToken: session.csrfToken });
  });
  // Only these namespaces belong to the PostgreSQL application boundary.
  router.use(["/api/auth", "/api/me", "/api/projects", "/api/units", "/api/settings"], authenticate(pool));
  router.get("/api/me", (request, response) => response.json({ user: request.actor }));
  router.post("/api/auth/csrf", origin, async (request, response) => response.json({ csrfToken: await rotateCsrfToken(pool, request.session.id, request.actor.organizationId) }));
  router.post("/api/auth/logout", ...write, async (request, response) => {
    await pool.query("UPDATE sessions SET expires_at=now() WHERE id=$1 AND organization_id=$2", [request.session.id, request.actor.organizationId]);
    response.set("Set-Cookie", sessionCookie("", config, true)).json({ ok: true });
  });
  router.use(inventoryRoutes({ pool, write }));
  router.use(settingsRoutes({ pool, write, env }));
  router.use(["/api/auth", "/api/me", "/api/projects", "/api/units", "/api/settings"], (_request, _response, next) => next(httpError(404, "Resource not found")));
  router.use(errorHandler);
  return router;
}
