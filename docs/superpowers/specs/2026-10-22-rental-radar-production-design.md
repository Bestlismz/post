# Rental Radar production redesign

**Status:** Proposed for implementation  
**Date:** 2026-10-22  
**Visual target:** [`design/rental-radar-inbox-approved.png`](../../../design/rental-radar-inbox-approved.png)

## 1. Purpose

Rental Radar will become a production operations workspace for one Thai condominium rental company. It will monitor several authorized Facebook Groups, receive real Facebook Page Messenger conversations, identify rental demand, match that demand against current room inventory, prepare grounded replies, and send through either an approval or automatic policy.

The redesign replaces the current POC experience. Production must not display fixture customers, simulated inquiries, mock-success labels, duplicated workflows, or controls that imply Facebook is connected when it is not.

## 2. Product outcomes

The product must let an operator:

1. See Group posts, Group comments, and Messenger threads in one Inbox.
2. Read a Facebook post and its comment context without leaving the reply workspace.
3. See what the system extracted, what information is missing, and which rooms actually match.
4. Edit or approve one exact reply from one composer.
5. Configure each Group as Observe, Approval, or Automatic.
6. Let Messenger reply automatically when the message, inventory, channel window, and policy are all eligible.
7. Maintain projects and units through a real CRUD workflow.
8. Understand source health, scan progress, automation decisions, and delivery evidence.
9. Stop new automatic sends globally or per source without corrupting in-flight work.

## 3. Non-goals for the first production release

- Multi-company administration, billing, or self-service tenant signup.
- Automating Facebook username/password entry.
- Scraping a Group member and initiating an unsolicited Messenger conversation.
- Allowing OpenAI to select arbitrary database rows or write inventory.
- Claiming remote delivery is exactly once.
- Automatically retrying an uncertain Group comment submission.
- A general CRM, accounting system, booking engine, or property-management replacement.

All tenant-owned records still contain `organization_id`. Release one provisions one organization and does not expose organization switching.

## 4. Design decision

Use a pragmatic hybrid modular monolith with three runtime roles:

```text
web/API      Next.js UI, authentication, commands, queries, Messenger webhook
worker       analysis, matching, reply preparation, policy evaluation, delivery jobs
group-worker isolated Playwright/Chromium process with one encrypted persistent profile
```

PostgreSQL is the canonical database, durable job queue, idempotency store, outbox, and audit ledger. Redis, Kafka, and a workflow engine are not required for release one.

Messenger uses Meta's official webhook and Send API. Facebook Groups use the isolated browser worker because the required Group workflow is unavailable through an equivalent official API. Channel adapters stay separate while both channels share Inbox, inventory matching, reply policy, approval, and audit concepts.

## 5. Information architecture

Primary navigation contains five destinations:

| Destination | Responsibility |
| --- | --- |
| Inbox | Group posts/comments and Messenger threads, matching, reply review, delivery state |
| Properties | Project and unit inventory CRUD, publication, availability, media, revision history |
| Sources | Facebook Page connection, Groups, browser-session health, scan status, recovery |
| Automations | Modes, thresholds, schedules, formats, limits, business hours, policy preview |
| Settings | Company profile, users, roles, security, retention, integration readiness |

The following top-level destinations are removed:

- Overview becomes a compact operational strip inside Inbox.
- Lead Inbox, Reply Review, and Messenger become Inbox views.
- Browser and Facebook Login become protected recovery actions inside Sources.
- Activity becomes a contextual timeline and a searchable audit view under Settings.

## 6. Approved visual direction

The approved direction is the first humanized concept, with the table behavior from the third concept available as a view switch.

### 6.1 Product character

- Quiet operations tool, not a marketing dashboard.
- Warm neutral canvas with white working surfaces.
- Near-black text and fine gray dividers.
- One restrained indigo action color.
- Amber only for review or caution.
- Emerald only for connected, available, or confirmed success.
- Red only for blocking errors, unhealthy sources, and destructive actions.
- IBM Plex Sans Thai or Noto Sans Thai with tabular numerals.
- Body text at 14 to 15px and clear 20 to 24px page titles.
- Spacing, alignment, and typography separate regions before borders or elevation.
- Minimal shadows, minimal pills, and no gradients or glass effects.

The Inbox borrows proven operational patterns from [Intercom Inbox](https://www.intercom.com/helpdesk/inbox) and the restrained density of [Linear](https://linear.app/homepage), without cloning either product.

### 6.2 Inbox layouts

Inbox has two views backed by the same filters and selected item.

**Workspace view** is the default:

```text
64px navigation rail | 300px queue | fluid conversation | 340px inspector
```

- Queue rows use hairline separation instead of cards.
- The conversation is the visual hero.
- A Group item renders the original post, source metadata, nested comments, and reply target.
- A Messenger item renders the thread timeline in the same central region.
- The inspector contains extracted requirements, missing information, and grounded unit recommendations.
- The composer is the only place to edit, approve, or send a reply.
- Navigation, queue, and inspector can collapse independently.

**Table view** supports bulk triage:

- Rows show channel, customer or group, latest text, extracted location and budget, source, assignee, state, and age.
- Opening a row displays a right-side focus sheet without losing list position.
- The focus sheet uses the same item detail and composer as Workspace view.
- Table view is a mode, not another route or implementation.

### 6.3 Responsive rules

| Width | Behavior |
| --- | --- |
| 1280px and above | Four-region Workspace view; resizable queue and inspector |
| 1024px to 1279px | Icon rail; queue remains; inspector becomes a drawer |
| 768px to 1023px | Queue and conversation split; inspector is a full-height drawer |
| Below 768px | Drill-down routes: queue, conversation, matches; sticky reply action bar |

Requirements:

- Every flex or grid child that can shrink uses `min-width: 0`.
- Thai and English content uses safe wrapping and `overflow-wrap: anywhere` where identifiers may be long.
- Each major region owns its scroll container.
- No page-level horizontal scrolling at supported widths.
- Touch targets are at least 44px.
- Motion lasts 150 to 220ms and respects `prefers-reduced-motion`.
- Loading, empty, partial, stale, disconnected, permission-denied, and failure states have designed layouts.

## 7. Core domain model

### 7.1 Organization and users

```text
Organization
User
Membership(role: admin | operator | inventory_manager | viewer)
```

### 7.2 Inventory

```text
Project
  name, address, district, province
  latitude, longitude
  transit stations and walking distance
  amenities, media, revision

Unit
  project_id, unit_code
  room_type, bedrooms, bathrooms, floor, area_sqm
  monthly_rent_thb, deposit_months, advance_months
  pet_policy: allowed | case_by_case | not_allowed | unknown
  available_from
  status: draft | available | held | rented | archived
  published_at, facts_updated_at, revision
  media
```

Only a published unit in `available` state can enter a match. Archive replaces destructive deletion so historic citations and audit records remain valid.

Publication requires project identity, price, room type, availability date, contact-safe description, and a known pet policy decision. `unknown` is a valid explicit value, not an omitted fact.

### 7.3 Sources and policies

```text
Source
  kind: facebook_group | facebook_page
  provider identity and canonical URL
  health, last_success_at, last_error
  automation_mode: observe | approval | automatic

AutomationPolicy
  source scope or organization default
  relevance threshold
  match threshold
  business hours and timezone
  per-hour and per-day limits
  reply format revision
  escalation rules
  automatic-send enablement and kill switch
```

### 7.4 Conversations, work, replies, and delivery

```text
Conversation
  channel, source, external_conversation_id
  processing_revision
  bot_state: active | paused | human_handoff

InboundMessage
  provider_event_id, external_target_id
  normalized content, occurred_at
  dedupe key and raw encrypted evidence reference

WorkItem
  conversation, target, relevance, requirements
  state, assignee, last_activity_at, revision

MatchSnapshot
  requirements revision
  matcher version and inventory watermark
  typed unit fact snapshots and unit revisions
  hard-filter outcomes, score, and reasons

ReplyVersion
  exact text
  structured fact and template selections
  source: deterministic | openai | human
  match snapshot, format revision, policy revision
  state: draft | needs_review | approved | superseded

DeliveryIntent
  reply version, exact destination, exact text hash
  authorization actor
  state: queued | leased | attempting | sent | failed | unknown | cancelled
```

Reply approval state and delivery outcome remain separate. The UI projects both without maintaining two authoritative send statuses.

## 8. Inventory matching and grounded replies

OpenAI does not query inventory and does not decide which unavailable room to recommend.

The processing order is:

1. Normalize the new inbound message and current conversation context.
2. Extract structured rental requirements through strict OpenAI structured output.
3. Validate extracted evidence against the customer text.
4. Apply deterministic hard filters to published and available units.
5. Score remaining candidates through a versioned, explainable matcher.
6. Save an immutable typed match snapshot.
7. Select approved fact and sentence-template identifiers.
8. Let OpenAI phrase non-factual connective text within the configured reply style.
9. Render prices, availability, project names, pet policy, transit, dates, and unit facts deterministically from the snapshot.
10. Validate the final result and create an immutable reply version.

Every automatically generated factual sentence is derived from a structured template and typed fact reference. Citation membership alone is insufficient because it does not prove that free prose states the fact correctly.

Human edits pass through the same fact validator. An operator may explicitly mark a reply as an ungrounded human message, but that disables the automatic-grounding guarantee and always requires approval.

When nothing matches, the system truthfully says no current room matches and asks one useful clarifying question. It does not turn a near match into an availability claim.

Room availability is a timestamped observation unless a future booking or hold integration reserves the room. The reply displays the inventory freshness time where material.

## 9. Processing and delivery flows

### 9.1 Messenger inbound

1. Verify the webhook signature against the raw request body.
2. Reject wrong-Page events and acknowledge echoes, receipts, and unsupported events without generation.
3. Deduplicate on `(page_id, mid)`.
4. Persist the event, conversation revision, audit entry, and analysis job in one transaction.
5. Acknowledge Meta quickly.
6. Process messages in conversation order.
7. Reject generation based on a superseded conversation revision.
8. Analyze, match, compose, validate, and evaluate policy.
9. Immediately before `attempting`, revalidate inventory facts, policy revision, Page reply eligibility, opt-out state, limits, and human takeover.
10. Record the Meta outcome and provider message ID.

Messenger retries only failures classified safe by the adapter and policy.

### 9.2 Group scanning

1. Scheduler or operator creates one idempotent scan job per source and schedule slot.
2. PostgreSQL leases only one active job per browser profile.
3. Group worker verifies session health and opens the exact allow-listed Group.
4. It records scan coverage and normalizes stable post and comment identities.
5. Partial scans retain successfully observed content and never delete unseen targets.
6. Repeated authentication or selector failures trip a per-source circuit breaker.
7. New or materially changed content enters the shared analysis path.

Read-only scans may retry with bounded backoff. Session repair requires an audited protected browser session under Sources.

### 9.3 Group reply

1. Observe mode never prepares a delivery.
2. Approval mode creates a review item.
3. Automatic mode uses the same reply version and delivery-intent path with a policy actor.
4. Authorization revalidates target identity, content revision, inventory, policy, rate limits, session health, and reply facts.
5. The exact destination, text, text hash, fact snapshot, and authorization are frozen.
6. The worker records `attempting` before remote interaction.
7. A verified visible reply becomes `sent` with evidence.
8. A definite rejection becomes `failed`.
9. A timeout, crash, navigation loss, or ambiguous DOM after possible interaction becomes terminal `unknown`.

An `attempting` Group delivery never becomes sendable merely because its lease expires. Reconciliation requires the correct destination, sender identity, attempt time bounds, and visible content evidence. Failure to find the content does not authorize an automatic resend.

## 10. Application boundaries

Public application commands stay task-shaped:

```ts
Inbox.list(query)
Inbox.get(workItemId)
Inbox.prepareReply(workItemId, expectedRevision)
Inbox.approveAndQueue(replyVersionId, expectedRevision)
Inbox.handoff(workItemId, reason, expectedRevision)

Inventory.createProject(input)
Inventory.updateProject(id, patch, expectedRevision)
Inventory.createUnit(projectId, input)
Inventory.updateUnit(id, patch, expectedRevision)
Inventory.publishUnit(id, expectedRevision)
Inventory.changeAvailability(id, state, expectedRevision)
Inventory.archiveUnit(id, expectedRevision)

Sources.addGroup(url)
Sources.updatePolicy(sourceId, policy, expectedRevision)
Sources.requestScan(sourceId)
Sources.beginReauthentication(sourceId)

Messenger.acceptWebhook(rawBody, signature)
```

`prepareReply` hides extraction, matching, snapshots, OpenAI, formatting, validation, and handoff decisions. `approveAndQueue` hides freshness checks, policy evaluation, reservation, audit, and job creation.

Channel workers receive immutable operation IDs and narrow typed commands. The Group worker cannot read application tables, query inventory, alter policy, or receive Page tokens.

## 11. Durability and consistency

- API mutations require an idempotency key and expected revision.
- State change, audit ledger entry, and outbox job are committed together.
- Workers claim PostgreSQL jobs with leases and `FOR UPDATE SKIP LOCKED`.
- Safe pre-side-effect jobs can be retried with bounded backoff.
- Delivery records enter `attempting` before remote I/O.
- Automatic sends are invalidated when relevant inventory, policy, handoff, or conversation revisions change.
- One active delivery is allowed per explicit business trigger and destination. Messenger may have legitimate later replies in the same thread.
- The decision ledger is append-only evidence, not a second source of current state.
- A global pause stops new delivery leases while preserving queued and in-flight evidence.

## 12. Security and privacy

- Authenticate dashboard users and enforce RBAC on the server.
- Use secure HTTP-only SameSite cookies, CSRF protection, origin checks, CSP, rate limits, and payload limits.
- Store Meta tokens, webhook secret, OpenAI key, database credentials, and browser-profile key in a secret manager or environment-injected secret boundary.
- Never expose or persist a Facebook password in the product.
- Encrypt PostgreSQL, backups, evidence storage, and the browser-profile volume at rest.
- Restrict browser-worker egress to Facebook and required CDN endpoints.
- Run Chromium as non-root with a read-only filesystem except its profile and evidence mounts.
- Treat Facebook text, DOM, links, images, webhook data, and model output as untrusted input.
- Redact tokens, phone numbers, and unnecessary personal data from logs and ledger metadata.
- Give raw provider payloads and screenshots shorter, configurable retention periods.
- Keep the protected browser tunnel private, short-lived, admin-only, and audited.

## 13. Removal of POC and duplicate paths

Production cutover is incomplete until these paths are deleted:

- JSON state ownership after verified PostgreSQL migration.
- Fixture login and fixture Facebook routes.
- Simulated inquiry controls, demo seed actions, mock badges, and mock-success responses.
- `/api/state`, `/api/group`, `/api/scan`, and compatibility aliases after all callers migrate.
- Separate Lead Inbox, Reply Review, Messenger, Browser, Overview, and Activity implementations.
- Separate manual and automatic send implementations.
- Direct Playwright, Meta, or OpenAI calls from UI components and HTTP controllers.
- Frontend copies of automation policy and source health.
- Production fallback that presents deterministic or fixture output as successful AI work.

Fixtures remain in a test-only package and compose profile. The production build fails when fixture modules enter its dependency graph.

## 14. Migration strategy

Use vertical slices and maintain one writable source of truth at every stage.

1. Add PostgreSQL, organization, users, audit, idempotency, outbox, and job leases.
2. Add Projects and Units CRUD with publication rules, deterministic matching, and contract tests.
3. Move Messenger ingress to durable storage and build the unified Inbox read model.
4. Add grounded reply versions and inventory-aware Messenger delivery.
5. Move multi-Group discovery to read-only group-worker jobs.
6. Add Group approval delivery and terminal `unknown` handling.
7. Run approval-only production burn-in and measure false positives, selector stability, and unknown outcomes.
8. Enable Automatic mode only per allow-listed source after safety gates pass.
9. Switch to the redesigned UI and remove compatibility routes and POC screens in the same release window.

Existing JSON data is imported into PostgreSQL once, read-compared against the original, and then made read-only before final removal.

## 15. Verification strategy

### Domain tests

- Unit publication completeness.
- Availability transitions and archive behavior.
- Hard matching filters and versioned scoring.
- Typed fact rendering and grounding rejection.
- Observe, Approval, and Automatic policy outcomes.
- Reply and delivery state-machine properties.

### Contract tests

- Recorded Meta webhook and Send API shapes.
- Recorded Facebook Group observations with versioned selector fixtures.
- OpenAI structured extraction and phrasing schemas.

### Integration tests

- PostgreSQL transaction, outbox, lease, and crash recovery.
- Duplicate webhooks and repeated scans.
- Stale inventory between preparation, authorization, and send.
- Superseded Messenger conversation context.
- Human takeover racing a queued automatic reply.
- Crash before click, during click, and after possible Group submission.
- Partial scan coverage and session expiration.

### Product E2E tests

- Create a project and publish a unit.
- Receive a Messenger inquiry, match a unit, and send through a fake Meta provider.
- Discover a Group post, approve the prepared reply, and verify through a fake Facebook provider.
- Switch a Group among Observe, Approval, and Automatic.
- Pause globally and prove no new delivery enters `attempting`.
- Exercise desktop, tablet, and mobile layouts with long Thai and English content.
- Verify no horizontal overflow at 1440, 1280, 1024, 768, 430, and 390px.

Controlled real-provider staging tests occur only after fake-provider flows pass. They use an authorized Page, authorized test Groups, explicit send limits, and visible evidence capture.

## 16. Acceptance criteria

Release one is ready when:

1. Production starts without fixture data or fixture routes.
2. PostgreSQL is the only writable business-state source.
3. Inventory CRUD, publication, archive, and availability changes are durable and audited.
4. Replies cannot state room facts outside a typed current snapshot.
5. Messenger webhook acknowledgement is durable before asynchronous work begins.
6. Duplicate Messenger events and repeated Group observations do not duplicate work or sends.
7. Approval and Automatic modes converge on one authorization and delivery pipeline.
8. Group `unknown` outcomes never retry automatically.
9. Human handoff wins over queued automation before remote send.
10. All five primary destinations are responsive and keyboard accessible.
11. Inbox Workspace and Table views share filters, selected item, and composer behavior.
12. No supported viewport clips the queue, conversation, inspector, drawer, or action bar.
13. Operators can see why a lead matched, why a reply was held, and which room facts supported the answer.
14. A global kill switch and per-source pause prevent new automatic delivery attempts.
15. Real-provider staging evidence covers Group scanning, Group approval reply, Messenger inbound, Messenger outbound, session expiry, and source recovery.

