import { createHash } from "node:crypto";
import { httpError } from "../auth/authorize.mjs";
import { authorizeInboxActor } from "./repository.mjs";

const columns = `w.id,w.conversation_id,w.processing_revision,w.status,
  to_char(w.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  c.channel,m.id AS message_id,m.text AS message_text,
  s.id AS source_id,s.name AS source_name,s.health AS source_health`;
const relations = `FROM work_items w
  JOIN conversations c ON c.organization_id=w.organization_id AND c.id=w.conversation_id
  JOIN messages m ON m.organization_id=w.organization_id AND m.id=w.message_id AND m.conversation_id=c.id
  LEFT JOIN meta_page_sources s ON s.organization_id=c.organization_id AND s.page_id=c.page_id`;

function itemDto(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channel: row.channel,
    processingRevision: row.processing_revision,
    status: row.status,
    createdAt: row.created_at,
    participant: { id: row.conversation_id, label: "Messenger customer" },
    source: { id: row.source_id, name: row.source_name ?? "Messenger", health: row.source_health ?? "unavailable" },
    message: { id: row.message_id, text: row.message_text },
  };
}

function parseQuery(query, organizationId) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw httpError(400, "Invalid Inbox query");
  const { limit = 25, channel = null, sourceId = null, search = "", cursor = null } = query;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw httpError(400, "Page size must be between 1 and 100");
  if (channel !== null && channel !== "messenger") throw httpError(400, "Invalid channel");
  if (sourceId !== null && (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 200)) throw httpError(400, "Invalid source");
  if (typeof search !== "string" || search.length > 500) throw httpError(400, "Invalid search");
  const normalizedSearch = search.trim();
  const scope = createHash("sha256").update(JSON.stringify([organizationId, channel, sourceId, normalizedSearch])).digest("hex");
  let position = null;
  if (cursor !== null) {
    try {
      if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor) throw new Error();
      position = JSON.parse(decoded.toString("utf8"));
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
  return { limit, channel, sourceId, search: normalizedSearch, scope, position };
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
  const { rows } = await pool.query(`SELECT ${columns} ${relations}
    WHERE w.organization_id=$1 AND ($2::text IS NULL OR c.channel=$2)
      AND ($3::text IS NULL OR s.id=$3)
      AND ($4::text='' OR strpos(lower(m.text),lower($4))>0 OR strpos(lower(coalesce(s.name,'')),lower($4))>0)
      AND ($5::timestamptz IS NULL OR (w.created_at,w.id)<($5::timestamptz,$6::text))
    ORDER BY w.created_at DESC,w.id DESC LIMIT $7`,
  [organizationId, parsed.channel, parsed.sourceId, parsed.search, parsed.position?.at ?? null, parsed.position?.id ?? null, parsed.limit + 1]);
  const selected = rows.slice(0, parsed.limit);
  const last = selected.at(-1);
  const nextCursor = rows.length > parsed.limit ? Buffer.from(JSON.stringify({ v: 1, at: last.created_at, id: last.id, scope: parsed.scope })).toString("base64url") : null;
  return { items: selected.map(itemDto), nextCursor };
}

export async function getInboxItem(pool, id, actor) {
  const organizationId = authorizeInboxActor(actor);
  if (typeof id !== "string" || !id || id.length > 200) throw httpError(400, "Invalid Inbox item ID");
  // The timeline and item share one statement snapshot, including during ingress.
  const { rows: [row] } = await pool.query(`SELECT ${columns},
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',tm.id,'text',tm.text,
      'direction',tm.direction,'processingRevision',tm.processing_revision,
      'createdAt',to_char(tm.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY tm.processing_revision,tm.id),'[]'::jsonb)
      FROM messages tm WHERE tm.organization_id=w.organization_id AND tm.conversation_id=w.conversation_id) AS timeline
    ${relations} WHERE w.organization_id=$1 AND w.id=$2`, [organizationId, id]);
  if (!row) return null;
  return { ...itemDto(row), timeline: row.timeline.map((message) => ({
    id: message.id, text: message.text, direction: message.direction,
    processingRevision: message.processingRevision, createdAt: message.createdAt,
  })) };
}
