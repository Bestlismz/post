import { randomBytes, randomUUID, createHash } from "node:crypto";
import { httpError } from "../../auth/authorize.mjs";
import { appendAudit, withTransaction } from "../../db/transaction.mjs";
import { createMetaCredentialRepository } from "./credentials.mjs";

const permissions = ["pages_show_list", "pages_manage_metadata", "pages_messaging"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const authorize = (actor) => { if (!actor?.id || !actor.organizationId || actor.role !== "admin") throw httpError(403, "Administrator required"); };
const project = (row) => ({ id: row.id, pageId: row.page_id, name: row.name, health: row.health, expiresAt: row.expires_at?.toISOString() ?? null });

export function metaConnectionConfig(env = process.env) {
  let encoded = {};
  try { encoded = JSON.parse(env.META_TOKEN_KEYS ?? "{}"); } catch { /* Invalid configuration fails closed when credentials are used. */ }
  return { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, redirectUri: env.META_REDIRECT_URI, graphVersion: env.META_GRAPH_VERSION ?? "v24.0", keyVersion: env.META_TOKEN_KEY_VERSION, keys: Object.fromEntries(Object.entries(encoded).map(([version, value]) => [version, Buffer.from(String(value), "base64")])) };
}

export function createMetaConnection({ pool, config, http = fetch, clock = Date.now, env = {} }) {
  const repository = createMetaCredentialRepository({ pool, keys: config.keys, keyVersion: config.keyVersion });
  const version = /^v\d+\.\d+$/.test(config.graphVersion) ? config.graphVersion : "v24.0";
  async function graph(path, { token, method = "GET", body, query = {} } = {}) {
    const url = new URL(`https://graph.facebook.com/${version}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response, data;
    try {
      response = await http(url.href, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body: new URLSearchParams(body).toString() } : {}), signal: AbortSignal.timeout(10_000), redirect: "error" });
      data = await response.json();
    } catch { throw httpError(502, "Meta request failed"); }
    if (!data || !response.ok || data.error) throw httpError(data?.error?.code === 190 ? 410 : 502, data?.error?.code === 190 ? "Meta authorization revoked" : "Meta request failed");
    return data;
  }
  async function getSource(actor, sourceId, db = pool) {
    const { rows: [row] } = await db.query("SELECT id,page_id,name,health,expires_at FROM meta_page_sources WHERE organization_id=$1 AND id=$2", [actor.organizationId, sourceId]);
    if (!row) throw httpError(404, "Connection not found");
    return row;
  }
  async function tokenAuthorization(token, pageId) {
    const { data } = await graph("debug_token", { token: `${config.appId}|${config.appSecret}`, query: { input_token: token } });
    if (!data?.is_valid || data.app_id !== config.appId || (data.profile_id && data.profile_id !== pageId) || !permissions.every((permission) => data.scopes?.includes(permission))) return { health: "revoked", expiresAt: null };
    const expiry = [data.expires_at, data.data_access_expires_at].filter((value) => Number.isFinite(value) && value > 0);
    const expiresAt = expiry.length ? new Date(Math.min(...expiry) * 1000) : null;
    return { health: expiresAt && expiresAt.getTime() <= clock() ? "expired" : "connected", expiresAt };
  }
  async function health(token, pageId, expiresAt, refresh = false) {
    const previousExpiry = expiresAt ? new Date(expiresAt) : null;
    if (!refresh && previousExpiry && previousExpiry.getTime() <= clock()) return { health: "expired", expiresAt: previousExpiry };
    try {
      const authorization = await tokenAuthorization(token, pageId);
      if (!refresh && previousExpiry && (!authorization.expiresAt || previousExpiry < authorization.expiresAt)) authorization.expiresAt = previousExpiry;
      if (authorization.health !== "connected") return authorization;
      const page = await graph("me", { token, query: { fields: "id" } });
      return { ...authorization, health: page.id === pageId ? "connected" : "revoked" };
    }
    catch (error) { return { health: error.status === 410 ? "revoked" : previousExpiry && previousExpiry.getTime() <= clock() ? "expired" : "unavailable", expiresAt: previousExpiry }; }
  }
  const service = {
    resolveEnvironmentSource(pageId) {
      if (!env.META_ORGANIZATION_ID || !env.META_PAGE_ID || env.META_PAGE_ID !== pageId) return null;
      return { organizationId: env.META_ORGANIZATION_ID, pageId };
    },
    async inspectEnvironmentSource(pageId) {
      if (!env.META_ORGANIZATION_ID || !env.META_PAGE_ID || env.META_PAGE_ID !== pageId || !env.META_PAGE_ACCESS_TOKEN) return null;
      const authorization = await health(env.META_PAGE_ACCESS_TOKEN, pageId, env.META_TOKEN_EXPIRES_AT);
      return { id: "environment", organizationId: env.META_ORGANIZATION_ID, pageId, name: "Environment Page", health: authorization.health, expiresAt: authorization.expiresAt?.toISOString() ?? null };
    },
    async beginMetaConnection(actor) {
      authorize(actor);
      if (!config.appId || !config.appSecret || !config.redirectUri || !config.keys?.[config.keyVersion] || config.keys[config.keyVersion].length !== 32) throw httpError(503, "Meta connection is not configured");
      const state = randomBytes(32).toString("base64url");
      await pool.query("INSERT INTO meta_oauth_states(state_hash,organization_id,actor_id,expires_at) VALUES($1,$2,$3,$4)", [digest(state), actor.organizationId, actor.id, new Date(clock() + 600_000)]);
      const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
      for (const [key, value] of Object.entries({ client_id: config.appId, redirect_uri: config.redirectUri, response_type: "code", scope: permissions.join(","), state })) url.searchParams.set(key, value);
      return { authorizationUrl: url.href };
    },
    async completeMetaConnection(actor, { code, state }) {
      authorize(actor);
      if (typeof state !== "string" || !/^[\w-]{43}$/.test(state) || typeof code !== "string" || !code || code.length > 4096) throw httpError(403, "OAuth callback rejected");
      const used = await pool.query("UPDATE meta_oauth_states SET used_at=$4 WHERE state_hash=$1 AND organization_id=$2 AND actor_id=$3 AND used_at IS NULL AND expires_at>$4 RETURNING state_hash", [digest(state), actor.organizationId, actor.id, new Date(clock())]);
      if (!used.rowCount) throw httpError(403, "OAuth callback rejected");
      const access = await graph("oauth/access_token", { method: "POST", body: { client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.redirectUri, code } });
      if (typeof access.access_token !== "string" || !access.access_token) throw httpError(502, "Meta request failed");
      const granted = await graph("me/permissions", { token: access.access_token });
      if (!permissions.every((permission) => granted.data?.some((item) => item.permission === permission && item.status === "granted"))) throw httpError(422, "Required Page permissions were not granted");
      const pages = [];
      let after, batches = 0;
      do {
        const result = await graph("me/accounts", { token: access.access_token, query: { fields: "id,name,access_token,tasks", limit: "100", ...(after ? { after } : {}) } });
        if (!Array.isArray(result.data)) throw httpError(502, "Meta request failed");
        for (const page of result.data) if (typeof page.id === "string" && typeof page.name === "string" && typeof page.access_token === "string" && page.tasks?.includes("MESSAGING")) pages.push({ id: page.id, name: page.name, token: page.access_token });
        const previous = after; after = result.paging?.next ? result.paging?.cursors?.after : undefined;
        if (result.paging?.next && (!after || after === previous || ++batches >= 100)) throw httpError(502, "Meta request failed");
      } while (after);
      const id = randomUUID();
      await repository.store({ organizationId: actor.organizationId, actorId: actor.id, id, kind: "pending", value: { pages }, expiresAt: new Date(clock() + 600_000) });
      return { id, status: "select_page" };
    },
    async listEligiblePages(actor, connectionId) {
      authorize(actor);
      return repository.withCredential(actor.organizationId, connectionId, ({ pages }) => pages.map(({ id, name }) => ({ id, name })), { actorId: actor.id, kind: "pending", now: clock() });
    },
    async selectPage(actor, connectionId, pageId) {
      authorize(actor);
      return withTransaction(pool, async (tx) => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [actor.organizationId]);
        return repository.withCredential(actor.organizationId, connectionId, async ({ pages }) => {
          const page = pages.find((item) => item.id === pageId);
          if (!page) throw httpError(422, "Page is not eligible");
          const authorization = await tokenAuthorization(page.token, page.id);
          if (authorization.health !== "connected") throw httpError(422, "Page authorization is not healthy");
          if ((await health(page.token, page.id)).health !== "connected") throw httpError(422, "Page authorization is not healthy");
          await graph(`${encodeURIComponent(page.id)}/subscribed_apps`, { method: "POST", token: page.token, body: { subscribed_fields: "messages,messaging_postbacks" } });
          const { rows: [row] } = await tx.query("INSERT INTO meta_page_sources(id,organization_id,page_id,name,health,expires_at) VALUES($1,$2,$3,$4,'connected',$5) ON CONFLICT(organization_id,page_id) DO UPDATE SET name=EXCLUDED.name,health='connected',expires_at=EXCLUDED.expires_at,updated_at=now() RETURNING id,page_id,name,health,expires_at", [randomUUID(), actor.organizationId, page.id, page.name, authorization.expiresAt]);
          await repository.store({ organizationId: actor.organizationId, actorId: actor.id, id: row.id, kind: "page", value: { token: page.token }, expiresAt: authorization.expiresAt }, tx);
          await repository.remove(actor.organizationId, connectionId, tx);
          await appendAudit(tx, { organizationId: actor.organizationId, actorId: actor.id, action: "meta.page_connected", entityType: "meta_source", entityId: row.id });
          return project(row);
        }, { db: tx, actorId: actor.id, kind: "pending", now: clock() });
      });
    },
    async inspectPageHealth(actor, sourceId) {
      authorize(actor);
      if (sourceId === "environment" && env.META_ORGANIZATION_ID === actor.organizationId) {
        const source = await service.inspectEnvironmentSource(env.META_PAGE_ID);
        if (!source) throw httpError(404, "Connection not found");
        const { organizationId: _organizationId, ...safe } = source;
        return safe;
      }
      return withTransaction(pool, async (tx) => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [actor.organizationId]);
        const row = await getSource(actor, sourceId, tx);
        if (row.health === "disconnected") return project(row);
        const authorization = await repository.withCredential(actor.organizationId, sourceId, ({ token }) => health(token, row.page_id, row.expires_at, true), { db: tx, kind: "page", now: clock(), allowExpired: true }).catch(() => ({ health: "unavailable", expiresAt: row.expires_at }));
        await repository.updateExpiry(actor.organizationId, sourceId, authorization.expiresAt, tx);
        await tx.query("UPDATE meta_page_sources SET health=$3,expires_at=$4,updated_at=now() WHERE organization_id=$1 AND id=$2", [actor.organizationId, sourceId, authorization.health, authorization.expiresAt]);
        return project({ ...row, health: authorization.health, expires_at: authorization.expiresAt });
      });
    },
    async disconnectPage(actor, sourceId) {
      authorize(actor);
      let token;
      const source = await withTransaction(pool, async (tx) => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [actor.organizationId]);
        const row = await getSource(actor, sourceId, tx);
        if (row.health === "disconnected") return project(row);
        await repository.withCredential(actor.organizationId, sourceId, (value) => { token = value.token; }, { db: tx, kind: "page", now: clock() }).catch(() => {});
        await repository.remove(actor.organizationId, sourceId, tx);
        await tx.query("UPDATE meta_page_sources SET health='disconnected',updated_at=now() WHERE organization_id=$1 AND id=$2", [actor.organizationId, sourceId]);
        await appendAudit(tx, { organizationId: actor.organizationId, actorId: actor.id, action: "meta.page_disconnected", entityType: "meta_source", entityId: sourceId });
        return project({ ...row, health: "disconnected" });
      });
      // Commit local revocation first. Serialize cleanup against reconnection so
      // an old disconnect cannot unsubscribe a newly authorized Page.
      if (token) await withTransaction(pool, async (tx) => {
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [actor.organizationId]);
        const row = await getSource(actor, sourceId, tx);
        if (row.health === "disconnected") await graph(`${encodeURIComponent(row.page_id)}/subscribed_apps`, { method: "DELETE", token }).catch(() => {});
      }).catch(() => {});
      return source;
    },
  };
  return service;
}
