import { createHash, randomUUID } from "node:crypto";

export async function withTransaction(pool, fn) {
  const tx = await pool.connect();
  let releaseError;
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    tx.release(releaseError);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function runIdempotent(tx, command, fn) {
  const { organizationId, actorId, route, key, body } = command;
  if (typeof key !== "string" || key.trim().length === 0) throw new Error("Idempotency key must be a non-empty string");
  const requestHash = createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(body)))).digest("hex");
  const scope = [organizationId, actorId, route, key];
  const inserted = await tx.query(`
    INSERT INTO idempotency_keys (organization_id, actor_id, route, key, request_hash)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (organization_id, actor_id, route, key) DO NOTHING
    RETURNING key
  `, [...scope, requestHash]);
  if (inserted.rowCount === 0) {
    const { rows: [existing] } = await tx.query(`
      SELECT request_hash, response_status, response_body FROM idempotency_keys
      WHERE organization_id = $1 AND actor_id = $2 AND route = $3 AND key = $4
      FOR UPDATE
    `, scope);
    if (existing.request_hash !== requestHash) {
      const error = new Error("Idempotency key was already used with a different request body");
      error.status = 409;
      throw error;
    }
    if (existing.response_status === null) throw new Error("Idempotency response is incomplete");
    return { status: existing.response_status, body: existing.response_body };
  }
  const response = await fn(tx);
  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599 || response.body === undefined) {
    throw new Error("Idempotency response requires an HTTP status and JSON body");
  }
  const { rows: [saved] } = await tx.query(`
    UPDATE idempotency_keys SET response_status = $5, response_body = $6::jsonb
    WHERE organization_id = $1 AND actor_id = $2 AND route = $3 AND key = $4
    RETURNING response_status, response_body
  `, [...scope, response.status, JSON.stringify(response.body)]);
  return { status: saved.response_status, body: saved.response_body };
}

export async function appendAudit(tx, entry) {
  const { organizationId, actorId = null, action, entityType, entityId, details = {} } = entry;
  const { rows: [row] } = await tx.query(`
    INSERT INTO audit_entries (id, organization_id, actor_id, action, entity_type, entity_id, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *
  `, [randomUUID(), organizationId, actorId, action, entityType, entityId, JSON.stringify(details)]);
  return row;
}
