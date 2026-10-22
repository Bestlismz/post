import { randomUUID } from "node:crypto";

export async function enqueueJob(tx, job) {
  const { organizationId, kind, payload = {}, retrySafe = false, availableAt = null } = job;
  const { rows: [row] } = await tx.query(`
    INSERT INTO jobs (id, organization_id, kind, payload, retry_safe, available_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, now())) RETURNING *
  `, [randomUUID(), organizationId, kind, JSON.stringify(payload), retrySafe, availableAt]);
  return row;
}

export async function claimJobs(pool, worker, limit) {
  if (typeof worker !== "string" || worker.trim().length === 0) throw new Error("Job worker must be a non-empty string");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Job claim limit must be a positive integer");
  const { rows } = await pool.query(`
    WITH candidates AS (
      SELECT id FROM jobs
      WHERE (status = 'pending' AND available_at <= now())
         OR (status = 'running' AND retry_safe AND lease_expires_at <= now())
      ORDER BY available_at, created_at, id
      LIMIT $2 FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET status = 'running', lease_owner = $1,
      lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1,
      updated_at = now()
    FROM candidates WHERE jobs.id = candidates.id
    RETURNING jobs.*
  `, [worker, limit]);
  return rows;
}
