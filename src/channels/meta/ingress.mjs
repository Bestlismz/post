import { createHash, randomUUID } from "node:crypto";
import { normalizePageEvents, verifySignature } from "../../meta-webhook.mjs";
import { appendAudit, withTransaction } from "../../db/transaction.mjs";
import { enqueueJob } from "../../jobs/queue.mjs";

export async function acceptMetaWebhook({ pool, organizationId, rawBody, signature, pageId, appSecret }) {
  if (!verifySignature(rawBody, signature, appSecret)) return { status: 403, acceptedEventIds: [] };
  if (!organizationId || !pageId) return { status: 503, acceptedEventIds: [] };
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { return { status: 400, acceptedEventIds: [] }; }
  const events = normalizePageEvents(payload, pageId);
  if (!events.length) return { status: 200, acceptedEventIds: [] };
  const evidence = { sha256: createHash("sha256").update(rawBody).digest("hex"), byteLength: rawBody.length };
  try {
    const acceptedEventIds = await withTransaction(pool, async (tx) => {
      const accepted = [];
      // Every transaction locks conversations in the same order, including batched webhooks.
      const ordered = [...events].sort((a, b) => a.senderId.localeCompare(b.senderId));
      for (const event of ordered) {
        await tx.query(`INSERT INTO conversations(id,organization_id,page_id,psid) VALUES ($1,$2,$3,$4)
          ON CONFLICT (organization_id,page_id,psid) DO NOTHING`, [randomUUID(), organizationId, event.pageId, event.senderId]);
        const { rows: [conversation] } = await tx.query(`SELECT id,processing_revision FROM conversations
          WHERE organization_id=$1 AND page_id=$2 AND psid=$3 FOR UPDATE`, [organizationId, event.pageId, event.senderId]);
        const revision = conversation.processing_revision + 1;
        const messageId = randomUUID();
        const inserted = await tx.query(`INSERT INTO messages(id,organization_id,conversation_id,page_id,mid,text,provider_timestamp_ms,processing_revision,raw_evidence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (organization_id,page_id,mid) DO NOTHING RETURNING id`,
        [messageId, organizationId, conversation.id, event.pageId, event.mid, event.text, event.timestamp, revision, JSON.stringify(evidence)]);
        if (!inserted.rowCount) continue;
        await tx.query("UPDATE conversations SET processing_revision=$2,updated_at=now() WHERE id=$1", [conversation.id, revision]);
        const workItemId = randomUUID();
        await tx.query(`INSERT INTO work_items(id,organization_id,conversation_id,message_id,processing_revision) VALUES ($1,$2,$3,$4,$5)`, [workItemId, organizationId, conversation.id, messageId, revision]);
        await enqueueJob(tx, { organizationId, kind: "analyze_work_item", retrySafe: true, payload: { workItemId, conversationId: conversation.id, messageId, processingRevision: revision } });
        await appendAudit(tx, { organizationId, action: "messenger.message_received", entityType: "message", entityId: messageId, details: { workItemId, processingRevision: revision, evidence } });
        accepted.push(messageId);
      }
      return accepted;
    });
    return { status: 200, acceptedEventIds };
  } catch {
    // Do not expose provider payloads, sender identity, or database diagnostics.
    return { status: 503, acceptedEventIds: [] };
  }
}
