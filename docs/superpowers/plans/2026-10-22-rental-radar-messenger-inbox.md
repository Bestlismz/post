# Rental Radar Messenger and Inbox Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable official Messenger ingestion, inventory-grounded reply preparation, one authorization path, and a shared Inbox read model.

**Architecture:** Meta payloads terminate at a signature-verifying adapter. An application service persists normalized events and PostgreSQL jobs before acknowledgment. Extraction, matching, structured reply rendering, policy, and delivery remain separate domain boundaries but are hidden behind `prepareReply` and `approveAndQueue`.

**Tech Stack:** Node.js 22, Express 5, PostgreSQL 17, OpenAI SDK 6, Meta Graph API, Zod, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-22-rental-radar-production-design.md`

## Global Constraints

- Messenger uses the official Meta webhook and Send API.
- Verify signatures over raw bytes before JSON parsing.
- Deduplicate inbound events on `(page_id, mid)` and preserve conversation order.
- OpenAI extracts requirements and phrases connective language; it cannot select unavailable units or emit unchecked room facts.
- Automatic and human approval share immutable ReplyVersion and DeliveryIntent records.
- Revalidate inventory, policy, reply window, opt-out, limits, and human takeover immediately before `attempting`.

## Review Focus

- A second customer message supersedes queued generation from older conversation context. Covered in Task 2.
- An echo, receipt, wrong-Page event, or unsupported attachment never reaches generation. Covered in Task 1.
- A human takeover arriving while delivery waits prevents the send. Covered in Task 5.
- OpenAI output that changes a price or invents a unit fails closed. Covered in Task 3.
- Multiple legitimate replies in one Messenger thread are not blocked by an overly broad uniqueness key. Covered in Task 4.

---

## File structure

```text
src/db/migrations/003-inbox.sql       conversations, messages, work items, reply versions
src/db/migrations/004-delivery.sql    policies, delivery intents, Meta connections
src/inbox/service.mjs                 ingest, prepare, approve, handoff commands
src/inbox/repository.mjs              canonical writes and Inbox projections
src/inbox/queries.mjs                 queue, item detail, timeline reads
src/replies/extractor.mjs             OpenAI structured requirements
src/replies/composer.mjs              structured fact/template selections
src/replies/renderer.mjs              deterministic factual sentence rendering
src/replies/validator.mjs             fact and style validation
src/policy/evaluator.mjs              observe/approval/automatic decision
src/channels/meta/ingress.mjs         signature, event normalization, filtering
src/channels/meta/oauth.mjs           Page connection and token health
src/channels/meta/client.mjs          official Send API adapter
src/workers/automation-worker.mjs     analysis and preparation jobs
src/workers/meta-delivery-worker.mjs  final revalidation and send
src/http/inbox-routes.mjs             Inbox queries and commands
src/http/meta-routes.mjs              webhook edge
src/http/meta-connection-routes.mjs   OAuth callback, Page selection, disconnect
```

### Task 1: Durable Messenger ingress

**Files:**
- Create: `src/db/migrations/003-inbox.sql`, `src/channels/meta/ingress.mjs`, `src/http/meta-routes.mjs`
- Modify: `src/server.mjs`, `src/meta-webhook.mjs`
- Test: `scripts/meta-ingress.integration.test.mjs`

**Interfaces:**
- Consumes: raw body, signature, configured Page ID, PostgreSQL transaction helpers.
- Produces: `acceptMetaWebhook({ rawBody, signature, pageId }): { status, acceptedEventIds }` and durable `analyze_work_item` jobs.

- [ ] **Step 1: Write failing ingress tests**

Cover invalid signatures, invalid JSON, duplicate `mid`, wrong Page, echoes, receipts, unsupported events, one transaction rollback, and acknowledgement only after durable job insertion.

```js
test("webhook acknowledges only a durable unique inbound message", async () => {
  assert.equal((await accept(signedEvent)).status, 200);
  assert.equal(await messageCount("mid_1"), 1);
  assert.equal(await jobCount("mid_1"), 1);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/meta-ingress.integration.test.mjs`
Expected: FAIL on missing ingress boundary.

- [ ] **Step 3: Implement ingress**

Normalize to conversation identity `(organization_id, page_id, psid)`, increment `processing_revision`, and persist only redacted raw evidence references.

- [ ] **Step 4: Verify**

Run the focused test and existing `scripts/meta-webhook.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/003-inbox.sql src/channels/meta src/http/meta-routes.mjs src/server.mjs src/meta-webhook.mjs scripts/meta-ingress.integration.test.mjs
git commit -m "feat: persist messenger events before acknowledgement"
```

### Task 2: Meta Page connection and token health

**Files:**
- Create: `src/db/migrations/004-delivery.sql`, `src/channels/meta/oauth.mjs`, `src/http/meta-connection-routes.mjs`
- Modify: `src/server.mjs`, `.env.example`
- Test: `scripts/meta-connection.test.mjs`

**Interfaces:**
- Consumes: Meta App ID/secret, authenticated admin, encrypted secret boundary.
- Produces: `beginMetaConnection(actor)`, `completeMetaConnection(code, state)`, `listEligiblePages(connection)`, `selectPage(pageId)`, `disconnectPage(sourceId)`, `inspectPageHealth(sourceId)`.

- [ ] **Step 1: Write failing connection tests**

Cover signed OAuth state, callback replay, required permission checks, Page selection, token encryption/redaction, revoked-token health, rotation, disconnect, and non-admin rejection.

```js
test("Meta connection stores an encrypted Page token and never returns it", async () => {
  const source = await completeMetaConnection(validCallback);
  assert.equal(source.health, "connected");
  assert.equal(JSON.stringify(await getSource(source.id)).includes(pageAccessToken), false);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/meta-connection.test.mjs`
Expected: FAIL on missing OAuth boundary.

- [ ] **Step 3: Implement Page connection**

Use authorization-code exchange, random single-use state, least-privilege requested permissions, encrypted token storage, and an explicit selected Page. Support environment-injected credentials only as a deployment fallback with the same health projection.

- [ ] **Step 4: Verify**

Run connection and auth suites. Expected: PASS with no token in logs or responses.

- [ ] **Step 5: Commit**

```bash
git add src/channels/meta/oauth.mjs src/http/meta-connection-routes.mjs src/db/migrations/004-delivery.sql src/server.mjs .env.example scripts/meta-connection.test.mjs
git commit -m "feat: connect facebook pages through meta oauth"
```

### Task 3: Conversation ordering and shared Inbox projections

**Files:**
- Create: `src/inbox/repository.mjs`, `src/inbox/queries.mjs`
- Test: `scripts/inbox.test.mjs`

**Interfaces:**
- Consumes: normalized inbound messages from Task 1.
- Produces: `listInbox(query, actor)`, `getInboxItem(id, actor)`, `claimConversationRevision(tx, conversationId, expectedRevision)`.

- [ ] **Step 1: Write failing projection tests**

Assert stable cursor ordering, channel/source filters, no duplicate work items, one Page plus PSID identity, and superseded-revision rejection when a newer message arrives.

```js
test("new conversation input supersedes older generation context", async () => {
  const old = await claimConversationRevision(tx, conversationId, 2);
  await receiveMessage(conversationId);
  await assert.rejects(commitPreparedReply(old), /superseded/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/inbox.test.mjs`
Expected: FAIL on missing query layer.

- [ ] **Step 3: Implement repository and queries**

Use row locks per conversation for writes. Read models return UI-owned DTOs and never provider payloads or SQL rows.

- [ ] **Step 4: Verify**

Run: `node --test scripts/inbox.test.mjs`
Expected: PASS with deterministic pagination.

- [ ] **Step 5: Commit**

```bash
git add src/inbox scripts/inbox.test.mjs
git commit -m "feat: add unified inbox read model"
```

### Task 4: Structured extraction and grounded reply rendering

**Files:**
- Create: `src/replies/extractor.mjs`, `src/replies/composer.mjs`, `src/replies/renderer.mjs`, `src/replies/validator.mjs`
- Modify: `src/messenger-generator.mjs`
- Test: `scripts/grounded-reply.test.mjs`

**Interfaces:**
- Consumes: conversation revision, business profile, match snapshot, reply format.
- Produces: `extractRequirements(input)`, `composeSelections(input)`, `renderReply(selections, facts, format)`, `validateReply(reply, context)`.

- [ ] **Step 1: Write failing grounding tests**

Assert strict extraction schema, evidence mapping, no introduction of unknown unit IDs, deterministic prices/dates/transit/pet facts, forbidden phrase rejection, and explicit ungrounded-human flag behavior.

```js
test("factual reply clauses come only from typed snapshot facts", async () => {
  const reply = renderReply(selections, snapshot, format);
  assert.match(reply.text, /18,000/);
  await assert.rejects(validateReply({ ...reply, text: reply.text.replace("18,000", "16,000") }, snapshot), /unsupported fact/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/grounded-reply.test.mjs`
Expected: FAIL on missing reply modules.

- [ ] **Step 3: Implement the pipeline**

Use OpenAI structured output for requirements and sentence/template selections. Render factual clauses in code from typed snapshots; never validate arbitrary prose by trusting citations alone.

- [ ] **Step 4: Verify**

Run the focused test with deterministic fake OpenAI responses, then existing relevance tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/replies src/messenger-generator.mjs scripts/grounded-reply.test.mjs
git commit -m "feat: compose inventory-grounded replies"
```

### Task 5: Reply versions, policies, and authorization

**Files:**
- Create: `src/inbox/service.mjs`, `src/policy/evaluator.mjs`
- Modify: `src/db/migrations/004-delivery.sql`, `src/inbox/repository.mjs`
- Test: `scripts/reply-authorization.test.mjs`

**Interfaces:**
- Consumes: queries, matcher, reply pipeline, actor, AutomationPolicy.
- Produces: `prepareReply(workItemId, expectedRevision)`, `approveAndQueue(replyVersionId, expectedRevision, actor)`, `requestHandoff(workItemId, reason, actor)`.

- [ ] **Step 1: Write failing state-machine tests**

Cover immutable edits, superseding versions, manual and policy actors, trigger-scoped uniqueness, stale inventory/policy rejection, observe mode, rate limits, business hours, and automatic fallback to review.

```js
test("manual and automatic approval create the same immutable delivery shape", async () => {
  assert.deepEqual(stripActor(await approve(manual)), stripActor(await approve(automatic)));
  await assert.rejects(editApprovedReply(), /immutable/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/reply-authorization.test.mjs`
Expected: FAIL on missing service.

- [ ] **Step 3: Implement service and evaluator**

Keep reply approval separate from delivery state. Insert authorization, DeliveryIntent, audit, and outbox job atomically.

- [ ] **Step 4: Verify**

Run reply authorization, matcher, and grounding suites. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/004-delivery.sql src/inbox src/policy scripts/reply-authorization.test.mjs
git commit -m "feat: authorize replies through one delivery ledger"
```

### Task 6: Meta delivery worker and final freshness gate

**Files:**
- Create: `src/channels/meta/client.mjs`, `src/workers/meta-delivery-worker.mjs`
- Modify: `src/meta-client.mjs`
- Test: `scripts/meta-delivery.integration.test.mjs`

**Interfaces:**
- Consumes: authorized DeliveryIntent ID.
- Produces: `deliverMessengerIntent(intentId): DeliveryOutcome` with `sent | failed | unknown`.

- [ ] **Step 1: Write failing delivery tests**

Cover Page token failures, safe retry classification, expired reply window, opt-out, changed inventory, changed policy, human takeover immediately before send, provider message ID persistence, and legitimate follow-up replies.

```js
test("human takeover wins immediately before Messenger delivery", async () => {
  await setThreadState(threadId, "human_handoff");
  const result = await deliverMessengerIntent(intentId);
  assert.equal(result.state, "cancelled");
  assert.equal(meta.sendCalls, 0);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/meta-delivery.integration.test.mjs`
Expected: FAIL on missing delivery worker.

- [ ] **Step 3: Implement client and worker**

Mark `attempting` and commit before remote I/O. Revalidate all freshness gates in the same transaction that leases the intent. Persist redacted responses and correlation IDs.

- [ ] **Step 4: Verify**

Run Messenger suites and `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/meta src/workers src/meta-client.mjs scripts/meta-delivery.integration.test.mjs
git commit -m "feat: deliver messenger replies with final safety checks"
```

### Task 7: Inbox HTTP boundary and fake-provider E2E

**Files:**
- Create: `src/http/inbox-routes.mjs`, `scripts/fake-meta-provider.mjs`, `scripts/inbox-e2e.test.mjs`
- Modify: `src/server.mjs`, `package.json`

**Interfaces:**
- Consumes: Inbox service and queries.
- Produces: `/api/inbox`, `/api/inbox/:id`, `/api/inbox/:id/prepare`, `/api/replies/:id/approve`, `/api/inbox/:id/handoff`, `/api/inbox/events`.

- [ ] **Step 1: Write failing E2E test**

Create a published unit, post a signed webhook, wait for preparation, approve, deliver through fake Meta, and assert one sent timeline event with exact grounded facts.

```js
test("signed inquiry becomes one grounded sent reply", async () => {
  await postSignedWebhook(inquiry);
  await approvePreparedReply();
  assert.equal(fakeMeta.sends.length, 1);
  assert.match(fakeMeta.sends[0].text, /Life Asoke.*18,000/s);
});
```

- [ ] **Step 2: Run test**

Run: `node --test scripts/inbox-e2e.test.mjs`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement routes and SSE receipts**

Return resource DTOs and persistent operation receipts. SSE carries IDs and state changes; clients refetch resources instead of receiving secrets or provider bodies.

- [ ] **Step 4: Verify**

Run: `npm test && npm run build`
Expected: all tests and production build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http src/server.mjs package.json scripts/fake-meta-provider.mjs scripts/inbox-e2e.test.mjs
git commit -m "feat: expose production inbox workflow"
```

