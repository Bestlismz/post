import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { httpError } from "../../auth/authorize.mjs";

export function createMetaCredentialRepository({ pool, keys, keyVersion }) {
  const unavailable = () => httpError(503, "Credential unavailable");
  const aad = (organizationId, id) => Buffer.from(JSON.stringify([organizationId, id]));
  function seal(organizationId, id, value) {
    const key = keys?.[keyVersion];
    if (!Buffer.isBuffer(key) || key.length !== 32) throw unavailable();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(organizationId, id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { version: keyVersion, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  async function withCredential(organizationId, id, callback, { db = pool, actorId, kind, now = Date.now(), allowExpired = false } = {}) {
    const { rows: [row] } = await db.query("SELECT * FROM meta_credential_read($1,$2)", [organizationId, id]);
    if (!row || (actorId && row.actor_id !== actorId) || (kind && row.kind !== kind)) throw httpError(404, "Connection not found");
    if (!allowExpired && row.expires_at && row.expires_at.getTime() <= now) throw httpError(410, "Connection expired");
    let value;
    try {
      const envelope = row.envelope, key = keys?.[envelope.version];
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
      decipher.setAAD(aad(organizationId, id)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
    } catch { throw unavailable(); }
    return callback(value);
  }
  return {
    withCredential,
    async store({ organizationId, id, actorId, kind, value, expiresAt = null }, db = pool) {
      const envelope = seal(organizationId, id, value);
      await db.query("SELECT meta_credential_write($1,$2,$3,$4,$5,$6)", [organizationId, id, actorId, kind, envelope, expiresAt]);
    },
    async remove(organizationId, id, db = pool) { await db.query("SELECT meta_credential_delete($1,$2)", [organizationId, id]); },
    async updateExpiry(organizationId, id, expiresAt, db = pool) {
      const { rows: [row] } = await db.query("SELECT * FROM meta_credential_read($1,$2)", [organizationId, id]);
      if (!row || row.kind !== "page") return;
      await db.query("SELECT meta_credential_write($1,$2,$3,$4,$5,$6)", [organizationId, id, row.actor_id, row.kind, row.envelope, expiresAt]);
    },
    async withPageToken(organizationId, sourceId, callback, { db = pool, now = Date.now() } = {}) {
      const { rows: [source] } = await db.query("SELECT health,expires_at FROM meta_page_sources WHERE organization_id=$1 AND id=$2", [organizationId, sourceId]);
      if (!source || source.health === "disconnected") throw httpError(404, "Connection not found");
      if (["revoked", "expired"].includes(source.health)) throw httpError(410, "Connection authorization expired");
      if (source.health !== 'connected') throw httpError(503, 'Connection unavailable');
      if (source.expires_at && source.expires_at.getTime() <= now) throw httpError(410, 'Connection authorization expired');
      return withCredential(organizationId, sourceId, ({ token }) => callback(token), { kind: "page", db, now });
    },
  };
}
