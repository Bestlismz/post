# Inbox HTTP contract

All Inbox routes use the `rental_session` cookie and the session's current tenant and role. Reads permit admin, operator, inventory manager, and viewer. Writes permit admin and operator. Resource IDs never select a tenant.

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/inbox` | Optional `limit` 1–100, `channel=messenger`, `sourceId`, `search` up to 500 characters, scoped `cursor` | `{items,nextCursor}` |
| `GET /api/inbox/:id` | Work item ID | Item DTO with `timeline`, `replies`, `deliveries`, `events`; ETag is its processing revision |
| `POST /api/inbox/:id/prepare` | `{}` | 202 `{operation}`; enqueues automation using server-owned context |
| `POST /api/replies/:id/approve` | `{}` | 202 `{operation}`; atomically authorizes and queues delivery |
| `POST /api/inbox/:id/handoff` | `{reason}` with 1–200 characters | 202 `{operation}`; claims human takeover and cancels queued jobs |
| `GET /api/inbox/events` | Optional `Last-Event-ID` decimal header | Authenticated tenant receipt stream |

Every command requires matching `Origin`, the login response's `X-CSRF-Token`, an `Idempotency-Key` up to 200 characters, and the current `If-Match` processing revision. Reusing a key with the same resource, revision, and body returns the same durable operation receipt. Changing those inputs returns 409. Receipt creation commits with the mutation. Retrying a receipt after the resource changes still returns the original acceptance.

An operation is `{id,resourceId,resourceType,state}`. A receipt's initial state records acceptance, not the current delivery outcome. Refetch the item to determine the current state. Prepare and approve return `queued`; handoff returns `handoff`. Service errors return `{error,fieldErrors,code}`. Statuses include 400 for malformed input, 401 for no session, 403 for forbidden role/Origin/CSRF, 404 for absent or foreign resources, 409 for stale evidence/revisions or conflicting idempotency, 413 for oversized JSON, 422 for invalid command fields, and 429 for stream limits. Freshness failures retain machine codes such as `CONVERSATION_SUPERSEDED`, `POLICY_CHANGED`, and `INVENTORY_CHANGED`.

Detail resources expose the latest 100 inbound timeline messages, 20 reply versions, 20 deliveries, and 100 receipt events. Reply DTOs contain only ID, version, processing revision and text. Delivery DTOs contain ID, reply ID, state and provider message ID. Neither resource projects PSIDs, raw provider bodies, credentials, or trusted generation context. An unresolved committed attempt projects `unknown` and never authorizes a resend.

The SSE `inbox` event uses a durable decimal `id` and JSON `{receiptId,resourceId,resourceType,state}`. It contains no message text, PSID, provider message ID/body, or credentials. Refetch resources when an event arrives. New inquiries, preparations, authorizations, attempts, delivery outcomes, and handoffs emit receipts. Receipt positions are assigned while holding a transaction lock until commit, preventing an uncommitted earlier receipt from falling behind an already replayed cursor.

Reconnect with the last event ID. More than 500 missed events or a cursor ahead of the tenant watermark produces one `reset` event with `{receiptId:null,resourceId:null,resourceType:"inbox",state:"refetch"}` and the current watermark. Refetch the Inbox on reset. The stream sends comment heartbeats every 15 seconds, polls at one-second intervals, permits at most 100 connections per process and three per session, and disconnects slow consumers when the socket buffer fills. Disconnection releases intervals and connection slots. Session expiry/revocation and server shutdown close active streams. A fresh server process replays the same database receipts.

## Frontend Cutover dependency

The production frontend authentication/CSRF state is not implemented yet. Frontend Cutover must supply a same-origin `/settings/meta/callback` page that captures `code` and `state`, removes them from browser history, and uses the logged-in admin session and CSRF token to POST strict `{code,state}` JSON to `/api/meta/connection/callback`. It must preserve this session across the OAuth round trip. The callback POST checks Origin, CSRF, admin membership, tenant, and expiring single-use state before exchanging the code. Success returns `{id,status:"select_page"}` with no tokens; use that ID to list and select an eligible Page. The backend callback contract is tested through the authenticated HTTP route against a fake official Meta transport. Until that frontend exists, `META_REDIRECT_URI` is a documented integration dependency.
