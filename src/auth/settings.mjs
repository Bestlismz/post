import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newUserInput } from "./bootstrap.mjs";
import { hashPassword } from "./password.mjs";
import { httpError } from "./authorize.mjs";
import { appendAudit, runIdempotent, withTransaction } from "../db/transaction.mjs";
import { enqueueJob } from "../jobs/queue.mjs";

const role = z.enum(["admin", "operator", "inventory_manager", "viewer"]);
const schemas = {
  user: newUserInput.extend({ role }),
  role: z.strictObject({ id: z.string().min(1), role }),
  profile: z.strictObject({ name: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(10000), relevanceThreshold: z.number().int().min(0).max(100) }),
  retention: z.strictObject({ rawPayloadDays: z.number().int().min(1).max(3650), screenshotDays: z.number().int().min(1).max(3650) }),
};
export async function readSetting(pool, organizationId, kind) {
  if (kind === "users") return { users: (await pool.query("SELECT u.id,u.email,u.display_name AS \"displayName\",m.role,m.revision FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.email", [organizationId])).rows };
  const { rows: [org] } = await pool.query("SELECT name,business_profile,profile_revision,retention,retention_revision FROM organizations WHERE id=$1", [organizationId]);
  return kind === "profile" ? { ...org.business_profile, name: org.name, revision: org.profile_revision } : { ...org.retention, revision: org.retention_revision };
}
export async function changeSetting(pool, kind, command) {
  const input = schemas[kind].parse(command.input);
  const passwordHash = kind === "user" ? await hashPassword(input.password) : null;
  const { organizationId, actorId, idempotencyKey, expectedRevision } = command;
  return (await withTransaction(pool, (tx) => runIdempotent(tx, {
    organizationId, actorId, route: `settings.${kind}`, key: idempotencyKey,
    // Store only the request digest, never plaintext passwords, in the idempotency ledger.
    body: { input: command.input, expectedRevision: expectedRevision ?? null },
  }, async () => {
    const { rows: [org] } = await tx.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
    let entity, entityId = organizationId, action;
    if (kind === "user") {
      entityId = randomUUID();
      await tx.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)", [entityId, input.email, passwordHash, input.displayName]);
      await tx.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,$3)", [organizationId, entityId, input.role]);
      entity = { id: entityId, email: input.email, displayName: input.displayName, role: input.role, revision: 1 };
      action = "user.created";
    } else if (kind === "role") {
      entityId = input.id;
      const { rows: [member] } = await tx.query("SELECT role,revision FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE", [organizationId, entityId]);
      if (!member) throw httpError(404, "User not found");
      if (member.revision !== expectedRevision) throw httpError(409, "Revision conflict");
      if (member.role === "admin" && input.role !== "admin") {
        const count = await tx.query("SELECT count(*)::int AS count FROM memberships WHERE organization_id=$1 AND role='admin'", [organizationId]);
        if (count.rows[0].count === 1) throw httpError(409, "The last admin cannot be demoted");
      }
      await tx.query("UPDATE memberships SET role=$3,revision=revision+1 WHERE organization_id=$1 AND user_id=$2", [organizationId, entityId, input.role]);
      entity = { id: entityId, role: input.role, revision: member.revision + 1 };
      action = "user.role_changed";
    } else {
      const previous = kind === "profile" ? org.profile_revision : org.retention_revision;
      if (previous !== expectedRevision) throw httpError(409, "Revision conflict");
      if (kind === "profile") {
        const { name, ...profile } = input;
        await tx.query("UPDATE organizations SET name=$2,business_profile=$3::jsonb,profile_revision=profile_revision+1 WHERE id=$1", [organizationId, name, JSON.stringify(profile)]);
      } else await tx.query("UPDATE organizations SET retention=$2::jsonb,retention_revision=retention_revision+1 WHERE id=$1", [organizationId, JSON.stringify(input)]);
      entity = { ...input, revision: previous + 1 };
      action = `settings.${kind}_changed`;
    }
    await appendAudit(tx, { organizationId, actorId, action, entityType: kind === "role" || kind === "user" ? "user" : "organization", entityId, details: { revision: entity.revision, ...(entity.role ? { role: entity.role } : {}) } });
    await enqueueJob(tx, { organizationId, kind: "settings.changed", payload: { action, entityId, revision: entity.revision }, retrySafe: true });
    return { status: kind === "user" ? 201 : 200, body: entity };
  }))).body;
}
export async function readAudit(pool, organizationId, input) {
  const filters = z.strictObject({
    action: z.string().trim().min(1).max(100).optional(),
    actorId: z.string().trim().min(1).max(200).optional(),
    entityId: z.string().trim().min(1).max(200).optional(),
    correlationId: z.string().trim().min(1).max(200).optional(),
    before: z.iso.datetime().optional(),
    cursor: z.string().min(1).max(1000).regex(/^[A-Za-z0-9_-]+$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }).refine((value) => !(value.before && value.cursor), { message: "Use either before or cursor", path: ["cursor"] }).parse(input);
  let cursorTime = filters.before ?? null;
  let cursorId = null;
  if (filters.cursor) {
    try {
      const decoded = Buffer.from(filters.cursor, "base64url").toString("utf8");
      const separator = decoded.indexOf("\0");
      cursorTime = decoded.slice(0, separator);
      cursorId = decoded.slice(separator + 1);
      if (separator < 1 || !z.iso.datetime().safeParse(cursorTime).success || !cursorId || cursorId.length > 200) throw new Error("invalid");
    } catch {
      throw httpError(422, "Invalid audit cursor", { cursor: ["Cursor is invalid or expired"] });
    }
  }
  const result = await pool.query(`
    SELECT a.*,u.display_name AS actor_name
    FROM audit_entries a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.organization_id=$1
      AND ($2::text IS NULL OR a.action=$2)
      AND ($3::text IS NULL OR a.actor_id=$3)
      AND ($4::text IS NULL OR a.entity_id=$4)
      AND ($5::text IS NULL OR a.id=$5 OR a.entity_id=$5
        OR a.details->>'correlationId'=$5 OR a.details->>'jobId'=$5
        OR a.details->>'attemptId'=$5 OR a.details->>'operationId'=$5
        OR a.details->>'receiptId'=$5 OR a.details->>'replyVersionId'=$5)
      AND ($6::timestamptz IS NULL OR ($7::text IS NULL AND a.created_at<$6) OR ($7::text IS NOT NULL AND (a.created_at,a.id)<($6::timestamptz,$7)))
    ORDER BY a.created_at DESC,a.id DESC LIMIT $8
  `, [organizationId, filters.action ?? null, filters.actorId ?? null, filters.entityId ?? null, filters.correlationId ?? null, cursorTime, cursorId, filters.limit + 1]);
  const hasMore = result.rows.length > filters.limit;
  const entries = result.rows.slice(0, filters.limit);
  const last = entries.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(`${new Date(last.created_at).toISOString()}\0${last.id}`).toString("base64url") : null;
  return { entries, nextCursor };
}
