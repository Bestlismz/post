import { httpError } from "../auth/authorize.mjs";
import { validateInboxText } from "./validation.mjs";

export function authorizeInboxActor(actor, { write = false } = {}) {
  if (!actor || typeof actor.organizationId !== "string" || !actor.organizationId.trim()) throw httpError(401, "Authentication required");
  const roles = write ? ["admin", "operator"] : ["admin", "operator", "inventory_manager", "viewer"];
  if (!roles.includes(actor.role)) throw httpError(403, "Role does not permit this action");
  return validateInboxText(actor.organizationId, "organization ID");
}

// The caller owns the transaction. Keep its lock through all revision-dependent writes.
export async function claimConversationRevision(tx, conversationId, expectedRevision, actor) {
  const organizationId = authorizeInboxActor(actor, { write: true });
  validateInboxText(conversationId, "conversation ID");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw httpError(400, "Invalid processing revision");
  const { rows: [conversation] } = await tx.query(`SELECT c.id,c.processing_revision FROM conversations c
    WHERE c.organization_id=$1 AND c.id=$2 FOR UPDATE`, [organizationId, conversationId]);
  if (!conversation) throw httpError(404, "Conversation not found");
  if (conversation.processing_revision !== expectedRevision) throw httpError(409, "Conversation revision superseded");
  return { conversationId: conversation.id, processingRevision: conversation.processing_revision };
}

// A claim from an earlier transaction is only context, never permission to persist.
export async function commitConversationRevision(tx, claim, actor, persist) {
  const current = await claimConversationRevision(tx, claim?.conversationId, claim?.processingRevision, actor);
  return persist(current);
}
