import { loadPolicyEvaluationSnapshot } from "./attempt-counts.mjs";
import { evaluateSourceDecision } from "./source-decision.mjs";

export async function evaluateCurrentSourceDecision(database, {
  organizationId,
  sourceId,
  conversationId,
  organizationPaused,
  organizationPolicy,
  source,
  context,
  actorKind = "policy",
}, { clock } = {}) {
  const { now, counts } = await loadPolicyEvaluationSnapshot(database, { organizationId, sourceId, conversationId }, { clock });
  const decision = evaluateSourceDecision({ organizationPaused, organizationPolicy, source, actorKind, context: { ...context, counts }, now });
  return { decision, evaluatedAt: now, counts };
}
