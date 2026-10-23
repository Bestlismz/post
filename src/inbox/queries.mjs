import { createHash } from "node:crypto";
import { httpError } from "../auth/authorize.mjs";
import { authorizeInboxActor } from "./repository.mjs";
import { validateInboxText } from "./validation.mjs";

const columns = `w.id,w.conversation_id,w.processing_revision,w.status,
  w.created_at AS sort_created_at,
  to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  c.channel,m.id AS message_id,m.text AS message_text,
  CASE WHEN c.channel='facebook_group' THEN (SELECT o.author_label FROM group_observations o WHERE o.organization_id=w.organization_id AND o.id=(m.raw_evidence->>'observationId') LIMIT 1) END AS author_label,
  CASE WHEN c.channel='facebook_group' THEN (SELECT o.kind FROM group_observations o WHERE o.organization_id=w.organization_id AND o.id=(m.raw_evidence->>'observationId') LIMIT 1) END AS target_kind,
  coalesce(s.id,g.id) AS source_id,CASE WHEN c.channel='facebook_group' THEN coalesce(g.display_name,'Facebook group') ELSE s.name END AS source_name,
  CASE WHEN c.channel='facebook_group' THEN g.session_health ELSE s.health END AS source_health,
  latest_reply.context AS latest_reply_context`;
const relations = `FROM work_items w
  JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
  JOIN messages m ON m.organization_id=w.organization_id AND m.id=w.message_id AND m.conversation_id=c.id
  LEFT JOIN meta_page_sources s ON c.channel='messenger' AND s.organization_id=c.organization_id AND s.page_id=c.page_id
  LEFT JOIN group_sources g ON c.channel='facebook_group' AND g.organization_id=c.organization_id AND 'facebook_group:' || g.group_id=c.page_id
  LEFT JOIN LATERAL (SELECT rv.context FROM reply_versions rv
    WHERE rv.organization_id=w.organization_id AND rv.work_item_id=w.id
    ORDER BY rv.version DESC LIMIT 1) latest_reply ON true`;
const locationSql = `coalesce(latest_reply.context#>>'{snapshot,requirements,geography,districts,0}',latest_reply.context#>>'{snapshot,requirements,district}',latest_reply.context#>>'{extraction,requirements,geography,districts,0}',latest_reply.context#>>'{extraction,requirements,district}',latest_reply.context#>>'{extraction,fields,district,value}')`;
const budgetTextSql = `coalesce(latest_reply.context#>>'{snapshot,requirements,budgetMax}',latest_reply.context#>>'{extraction,requirements,budgetMax}',latest_reply.context#>>'{extraction,fields,budgetMax,value}')`;
const budgetSql = `(CASE WHEN ${budgetTextSql} ~ '^\\d{1,10}$' THEN (${budgetTextSql})::bigint END)`;
const authorSql = `(CASE WHEN c.channel='facebook_group' THEN (SELECT o.author_label FROM group_observations o WHERE o.organization_id=w.organization_id AND o.id=(m.raw_evidence->>'observationId') LIMIT 1) END)`;

function safeSummaryLocation(context) {
  const snapshot = context?.snapshot?.requirements;
  const extraction = context?.extraction?.requirements;
  const value = snapshot?.geography?.districts?.[0] ?? snapshot?.district
    ?? extraction?.geography?.districts?.[0] ?? extraction?.district
    ?? context?.extraction?.fields?.district?.value;
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return normalized && normalized.length <= 160 && !/[\p{Cc}\p{Cs}]/u.test(normalized) ? normalized : null;
}

function safeSummaryBudget(context) {
  const snapshot = context?.snapshot?.requirements;
  const extraction = context?.extraction?.requirements;
  const value = snapshot?.budgetMax ?? extraction?.budgetMax ?? context?.extraction?.fields?.budgetMax?.value;
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function itemDto(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel,
    processingRevision: row.processing_revision,
    status: row.status,
    createdAt: row.created_at,
    participant: { id: row.conversation_id, label: row.author_label || (row.channel === "facebook_group" ? "Group participant" : "Messenger customer") },
    source: { id: row.source_id, name: row.source_name ?? "Messenger", health: row.source_health ?? "unavailable" },
    message: { id: row.message_id, text: row.message_text },
    summary: { location: safeSummaryLocation(row.latest_reply_context), budgetMax: safeSummaryBudget(row.latest_reply_context), assignee: null },
  };
}

function parseQuery(query, organizationId) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw httpError(400, "Invalid Inbox query");
  const { limit = 100, channel = null, status = null, sourceId = null, location = "", budgetMin = null, budgetMax = null, assignee = null, q, search = q ?? "", cursor = null } = query;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "Page size must be between 1 and 100");
  if (channel !== null && !['messenger','facebook_group'].includes(channel)) throw httpError(400, "Invalid channel");
  if (status !== null && !['pending','pending_or_updated','preparing','needs_review','ready','completed','superseded','handoff','failed'].includes(status)) throw httpError(400, "Invalid status");
  if (assignee !== null && assignee !== 'unassigned') throw httpError(400, "Invalid assignee");
  if (sourceId !== null) validateInboxText(sourceId, "source");
  validateInboxText(location, "location", { maxLength: 160, allowEmpty: true });
  validateInboxText(search, "search", { maxLength: 500, allowEmpty: true });
  for (const value of [budgetMin,budgetMax]) if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)) throw httpError(400, "Invalid budget");
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) throw httpError(400, "Invalid budget range");
  const normalizedSearch = search.trim();
  const normalizedLocation = location.trim();
  const scope = createHash("sha256").update(JSON.stringify([organizationId, channel, status, sourceId, normalizedLocation, budgetMin, budgetMax, assignee, normalizedSearch])).digest("hex");
  let position = null;
  if (cursor !== null) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor) throw new Error();
      position = JSON.parse(decoded.toString("utf8"));
      validateInboxText(position.id, "cursor ID");
      validateInboxText(position.at, "cursor timestamp");
      validateInboxText(position.scope, "cursor scope");
      const validShape = JSON.stringify(position) === decoded.toString("utf8")
        && Object.keys(position).sort().join(",") === "at,id,scope,v"
        && position.v === 1 && position.scope === scope;
      const validId = typeof position.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(position.id);
      const validTimestamp = typeof position.at === "string"
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(position.at)
        && Number(position.at.slice(0, 4)) > 0
        && Number.isFinite(Date.parse(position.at))
        && new Date(position.at).toISOString() === position.at.slice(0, 23) + "Z";
      if (!validShape || !validId || !validTimestamp) throw new Error();
    } catch { throw httpError(400, "Invalid Inbox cursor"); }
  }
  return { limit, channel, status, sourceId, location: normalizedLocation, budgetMin, budgetMax, assignee, search: normalizedSearch, scope, position };
}

export function createInboxQueries({ pool }) {
  return {
    listInbox: (query, actor) => listInbox(pool, query, actor),
    getInboxItem: (id, actor) => getInboxItem(pool, id, actor),
  };
}

export async function listInbox(pool, query = {}, actor) {
  const organizationId = authorizeInboxActor(actor);
  const parsed = parseQuery(query, organizationId);
  const { rows } = await pool.query(`WITH filtered AS (SELECT ${columns} ${relations}
    WHERE w.organization_id=$1 AND ($2::text IS NULL OR c.channel=$2)
      AND (($3::text IS NULL AND w.status<>'superseded') OR ($3='pending_or_updated' AND w.status IN ('pending','superseded')) OR w.status=$3)
      AND ($4::text IS NULL OR coalesce(s.id,g.id)=$4)
      AND ($5::text='' OR strpos(lower(coalesce(${locationSql},'')),lower($5))>0)
      AND ($6::bigint IS NULL OR ${budgetSql}>=$6)
      AND ($7::bigint IS NULL OR ${budgetSql}<=$7)
      AND ($8::text IS NULL OR $8='unassigned')
      AND ($9::text='' OR strpos(lower(m.text),lower($9))>0 OR strpos(lower(CASE WHEN c.channel='facebook_group' THEN coalesce(g.display_name,'Facebook group') ELSE coalesce(s.name,'') END),lower($9))>0 OR strpos(lower(coalesce(${authorSql},'')),lower($9))>0))
    SELECT filtered.*,(SELECT count(*)::int FROM filtered) AS total_count FROM filtered
      WHERE ($10::timestamptz IS NULL OR (sort_created_at,id)<($10::timestamptz,$11::text))
    ORDER BY sort_created_at DESC,id DESC LIMIT $12`,
  [organizationId, parsed.channel, parsed.status, parsed.sourceId, parsed.location, parsed.budgetMin, parsed.budgetMax, parsed.assignee, parsed.search, parsed.position?.at ?? null, parsed.position?.id ?? null, parsed.limit + 1]);
  const selected = rows.slice(0, parsed.limit);
  const last = selected.at(-1);
  const nextCursor = rows.length > parsed.limit ? Buffer.from(JSON.stringify({ v: 1, at: last.created_at, id: last.id, scope: parsed.scope })).toString("base64url") : null;
  return { items: selected.map(itemDto), resultCount: Number(rows[0]?.total_count ?? 0), nextCursor };
}

export async function getInboxItem(pool, id, actor) {
  const organizationId = authorizeInboxActor(actor);
  validateInboxText(id, "Inbox item ID");
  // The timeline and item share one statement snapshot, including during ingress.
  const { rows: [row] } = await pool.query(`SELECT ${columns},
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',tm.id,'text',tm.text,
      'direction',tm.direction,'processingRevision',tm.processing_revision,
      'author',CASE WHEN c.channel='facebook_group' THEN (SELECT o.author_label FROM group_observations o WHERE o.organization_id=w.organization_id AND o.id=(tm.raw_evidence->>'observationId') LIMIT 1) END,
      'kind',CASE WHEN c.channel='facebook_group' THEN (SELECT o.kind FROM group_observations o WHERE o.organization_id=w.organization_id AND o.id=(tm.raw_evidence->>'observationId') LIMIT 1) END,
      'uiId',tm.id,'isTarget',tm.id=m.id,
      'createdAt',to_char(tm.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY tm.processing_revision,tm.id),'[]'::jsonb)
      FROM (SELECT * FROM messages WHERE organization_id=w.organization_id AND conversation_id=w.conversation_id ORDER BY processing_revision DESC LIMIT 100) tm) AS timeline,
    (SELECT coalesce(jsonb_agg(r),'[]') FROM (SELECT id,version,conversation_revision AS "processingRevision",content->>'text' AS text
      FROM reply_versions WHERE organization_id=w.organization_id AND work_item_id=w.id ORDER BY version DESC LIMIT 20) r) AS replies,
    (SELECT coalesce(jsonb_agg(d),'[]') FROM (SELECT di.id,di.reply_version_id AS "replyId",
      CASE WHEN a.state='attempting' THEN 'unknown' ELSE coalesce(a.state,CASE WHEN dc.delivery_intent_id IS NOT NULL THEN 'cancelled' ELSE 'queued' END) END AS state,
      a.provider_message_id AS "providerMessageId"
      FROM delivery_intents di JOIN reply_versions rv ON rv.organization_id=di.organization_id AND rv.id=di.reply_version_id
      LEFT JOIN delivery_attempts a ON a.organization_id=di.organization_id AND a.delivery_intent_id=di.id
      LEFT JOIN delivery_cancellations dc ON dc.organization_id=di.organization_id AND dc.delivery_intent_id=di.id
      WHERE di.organization_id=w.organization_id AND rv.work_item_id=w.id ORDER BY di.created_at DESC LIMIT 20) d) AS deliveries,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('receiptId',e.payload->'receiptId','resourceId',e.payload->'resourceId',
      'resourceType',e.payload->'resourceType','state',e.payload->'state') ORDER BY e.event_position),'[]') FROM (SELECT payload,event_position FROM outbox
      WHERE organization_id=w.organization_id AND kind IN ('inbox.changed','inbox.operation')
      AND (payload->>'resourceId'=w.id OR payload->>'resourceId'=w.conversation_id
        OR payload->>'resourceId' IN (SELECT id FROM reply_versions WHERE organization_id=w.organization_id AND work_item_id=w.id)
        OR payload->>'resourceId' IN (SELECT di.id FROM delivery_intents di JOIN reply_versions rv ON rv.organization_id=di.organization_id AND rv.id=di.reply_version_id WHERE di.organization_id=w.organization_id AND rv.work_item_id=w.id))
      ORDER BY event_position DESC LIMIT 100) e) AS events
    ${relations} WHERE w.organization_id=$1 AND w.id=$2`, [organizationId, id]);
  if (!row) return null;
  const context=row.latest_reply_context ?? {};
  const fields=context.extraction?.fields ?? {};
  const rawRequirements=context.snapshot?.requirements ?? context.extraction?.requirements ?? {};
  const requirements={
    district:rawRequirements.geography?.districts?.[0] ?? rawRequirements.district ?? null,
    budgetMax:rawRequirements.budgetMax ?? null,
    bedrooms:rawRequirements.bedrooms ?? null,
    requiredPetPolicy:rawRequirements.requiredPetPolicy ?? null,
    moveInDate:rawRequirements.moveInDate ?? null,
  };
  const requirementFields=["district","budgetMax","bedrooms","requiredPetPolicy","moveInDate"];
  const candidates=new Map((context.snapshot?.candidates ?? []).map(candidate=>[candidate.unitId,candidate]));
  const matches=(context.snapshot?.factSnapshot ?? []).map(fact=>({...fact,score:candidates.get(fact.unitId)?.score ?? null}));
  return { ...itemDto(row), target:row.channel==='facebook_group'?{kind:row.target_kind,uiId:row.message_id}:null, stale:row.status==='superseded',
    staleReason:row.status==='superseded'?'มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุด':null,
    requirements,missingRequirements:requirementFields.filter(name=>fields[name]?.status !== 'known'),matches,
    timeline: row.timeline.map((message) => ({
    id: message.id, uiId:message.uiId, text: message.text, direction: message.direction, author: message.author, kind:message.kind, isTarget:message.isTarget,
    processingRevision: message.processingRevision, createdAt: message.createdAt,
  })), replies:row.replies,deliveries:row.deliveries,events:row.events };
}
