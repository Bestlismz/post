import { createHash, randomUUID } from "node:crypto";
import { normalizePageEvents, verifySignature } from "../../meta-webhook.mjs";
import { appendAudit, withTransaction } from "../../db/transaction.mjs";
import { enqueueJob } from "../../jobs/queue.mjs";

export async function acceptMetaWebhook({ pool, rawBody, signature, appSecret, environmentSource }) {
  if (!verifySignature(rawBody, signature, appSecret)) return { status: 403, acceptedEventIds: [] };
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); }
  catch { return { status: 400, acceptedEventIds: [] }; }
  const pageIds = [...new Set((payload?.object === "page" && Array.isArray(payload.entry) ? payload.entry : []).map((entry) => entry?.id).filter((id) => typeof id === "string" && id))].sort();
  if (!pageIds.length) return { status: 200, acceptedEventIds: [] };
  const evidence = { sha256: createHash("sha256").update(rawBody).digest("hex"), byteLength: rawBody.length };
  try {
    const acceptedEventIds = await withTransaction(pool, async (tx) => {
      const accepted = [];
      const readSources = async () => (await tx.query("SELECT organization_id,page_id,health,expires_at FROM meta_page_sources WHERE page_id=ANY($1::text[]) ORDER BY organization_id,page_id", [pageIds])).rows;
      const initial = await readSources();
      const fallback = [];
      for (const pageId of pageIds) {
        if (initial.some((source) => source.page_id === pageId) || !environmentSource) continue;
        const source = await environmentSource(pageId);
        if (source?.pageId === pageId && source.organizationId && source.health === "connected" && (!source.expiresAt || new Date(source.expiresAt).getTime() > Date.now())) fallback.push({ organization_id: source.organizationId, page_id: pageId, health: source.health, expires_at: source.expiresAt ? new Date(source.expiresAt) : null });
      }
      // Match source-management lock order and recheck after waiting for rotation
      // or disconnect. The payload supplies only Page IDs, never tenant IDs.
      const organizations = [...new Set([...initial, ...fallback].map((source) => source.organization_id))].sort();
      if (organizations.length) await tx.query("SELECT id FROM organizations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [organizations]);
      const current = await readSources();
      if (current.some((source) => !organizations.includes(source.organization_id))) throw new Error("Source ownership changed during ingress");
      const sources = [...current, ...fallback.filter((source) => !current.some((row) => row.page_id === source.page_id))];
      const events = pageIds.flatMap((pageId) => {
        const bindings = sources.filter((source) => source.page_id === pageId);
        // Ambiguous ownership and unhealthy durable rows fail closed. A durable
        // disconnected source must never fall back to deployment credentials.
        if (bindings.length !== 1 || bindings[0].health !== "connected" || (bindings[0].expires_at && new Date(bindings[0].expires_at).getTime() <= Date.now())) return [];
        return normalizePageEvents(payload, pageId).map((event) => ({ ...event, organizationId: bindings[0].organization_id }));
      });
      // Every transaction locks conversations in the same order, including batched webhooks.
      const ordered = [...events].sort((a, b) => a.organizationId.localeCompare(b.organizationId) || a.pageId.localeCompare(b.pageId) || a.senderId.localeCompare(b.senderId));
      for (const event of ordered) {
        const { organizationId } = event;
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
