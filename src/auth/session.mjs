import { createHash, randomBytes, randomUUID } from "node:crypto";
import { httpError } from "./authorize.mjs";

export const tokenHash = (value) => createHash("sha256").update(value).digest("hex");
const cookieName = "rental_session";
export function sessionCookie(token, config, clear = false) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${config.nodeEnv === "production" || config.appOrigin.startsWith("https:") ? "; Secure" : ""}`;
}
export async function createSession(tx, actor) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await tx.query("INSERT INTO sessions (id,organization_id,user_id,token_hash,csrf_token_hash,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '12 hours')", [randomUUID(), actor.organizationId, actor.id, tokenHash(token), tokenHash(csrfToken)]);
  return { token, csrfToken };
}
export function authenticate(pool) {
  return async (request, _response, next) => {
    try {
      const token = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!token || !/^[\w-]{43}$/.test(token)) throw httpError(401, "Authentication required");
      const { rows: [row] } = await pool.query(`SELECT s.id AS session_id,s.csrf_token_hash,u.id,u.email,u.display_name,m.organization_id,m.role
        FROM sessions s JOIN memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id JOIN users u ON u.id=m.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now()`, [tokenHash(token)]);
      if (!row) throw httpError(401, "Authentication required");
      request.actor = { id: row.id, email: row.email, displayName: row.display_name, organizationId: row.organization_id, role: row.role };
      request.session = { id: row.session_id, csrfTokenHash: row.csrf_token_hash };
      next();
    } catch (error) { next(error); }
  };
}
export function checkOrigin(config) {
  return (request, _response, next) => request.get("Origin") === config.appOrigin ? next() : next(httpError(403, "Origin rejected"));
}
export function checkCsrf(request, _response, next) {
  const token = request.get("X-CSRF-Token");
  if (!token || tokenHash(token) !== request.session.csrfTokenHash) return next(httpError(403, "CSRF token rejected"));
  next();
}
