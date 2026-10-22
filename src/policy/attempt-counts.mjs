export async function loadHourlyAttemptCounts(database, { organizationId, sourceId, conversationId, now }) {
  const { rows: [counts] } = await database.query(`SELECT count(*)::int AS organization,
    count(*) FILTER(WHERE coalesce(d.source_id,d.group_source_id)=$2)::int AS source,
    count(*) FILTER(WHERE d.conversation_id=$3)::int AS conversation
    FROM delivery_attempts a JOIN delivery_intents d ON d.organization_id=a.organization_id AND d.id=a.delivery_intent_id
    WHERE a.organization_id=$1 AND a.started_at>$4::timestamptz-interval '1 hour'`, [organizationId, sourceId, conversationId, now]);
  return counts;
}
