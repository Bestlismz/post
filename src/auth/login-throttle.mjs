import { tokenHash } from "./session.mjs";
import { withTransaction } from "../db/transaction.mjs";

const organizationId = "org_default";
const capacity = 10000;
const windowMs = 15 * 60 * 1000;
const retrySeconds = (expiresAt, now) => Math.max(1, Math.ceil((expiresAt - now) / 1000));

// Separate account and IP budgets prevent either address rotation or account rotation.
// PostgreSQL serializes reservations across processes; no raw email/IP is persisted.
export async function reserveLoginAttempt(pool, { email, ip }) {
  return withTransaction(pool, async (tx) => {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
    const { rows: [{ now }] } = await tx.query("SELECT clock_timestamp() AS now");
    const keys = [{ kind: "account", hash: tokenHash(email), limit: 5 }, { kind: "ip", hash: tokenHash(ip), limit: 50 }];
    const rows = await tx.query("SELECT kind,key_hash,attempts,expires_at FROM login_attempts WHERE organization_id=$1 AND ((kind='account' AND key_hash=$2) OR (kind='ip' AND key_hash=$3))", [organizationId, keys[0].hash, keys[1].hash]);
    const missing = [];
    let retryAfter = 0;
    for (const key of keys) {
      const row = rows.rows.find((entry) => entry.kind === key.kind);
      if (!row) missing.push(key);
      else if (row.expires_at > now && row.attempts >= key.limit) retryAfter = Math.max(retryAfter, retrySeconds(row.expires_at, now));
    }
    if (retryAfter) return { retryAfter };
    if (missing.length) {
      const { rows: [{ count }] } = await tx.query("SELECT count(*)::int AS count FROM login_attempts WHERE organization_id=$1", [organizationId]);
      const shortage = Math.max(0, count + missing.length - capacity);
      if (shortage) {
        const expired = await tx.query("SELECT kind,key_hash FROM login_attempts WHERE organization_id=$1 AND expires_at<=$2 AND NOT ((kind='account' AND key_hash=$3) OR (kind='ip' AND key_hash=$4)) ORDER BY expires_at LIMIT $5", [organizationId, now, keys[0].hash, keys[1].hash, shortage]);
        if (expired.rowCount < shortage) {
          const { rows: [{ expiry }] } = await tx.query("SELECT min(expires_at) AS expiry FROM login_attempts WHERE organization_id=$1 AND expires_at>$2", [organizationId, now]);
          return { retryAfter: retrySeconds(expiry ?? new Date(now.valueOf() + windowMs), now) };
        }
        for (const [index, previous] of expired.rows.entries()) {
          const replacement = missing[index];
          await tx.query("UPDATE login_attempts SET kind=$4,key_hash=$5,attempts=0 WHERE organization_id=$1 AND kind=$2 AND key_hash=$3", [organizationId, previous.kind, previous.key_hash, replacement.kind, replacement.hash]);
        }
      }
    }
    for (const key of keys) await tx.query(`INSERT INTO login_attempts (organization_id,kind,key_hash,attempts,expires_at) VALUES ($1,$2,$3,1,$4)
      ON CONFLICT (organization_id,kind,key_hash) DO UPDATE SET
      attempts=CASE WHEN login_attempts.expires_at<=$5 THEN 1 ELSE login_attempts.attempts+1 END,
      expires_at=CASE WHEN login_attempts.expires_at<=$5 THEN EXCLUDED.expires_at ELSE login_attempts.expires_at END`, [organizationId, key.kind, key.hash, new Date(now.valueOf() + windowMs), now]);
    return { retryAfter: 0 };
  });
}

export async function resetAccountAttempts(tx, email) {
  await tx.query("UPDATE login_attempts SET attempts=0 WHERE organization_id=$1 AND kind='account' AND key_hash=$2", [organizationId, tokenHash(email)]);
}
