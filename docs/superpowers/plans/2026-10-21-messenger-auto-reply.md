# Facebook Page Messenger Auto-reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Facebook Page Inbox integration that validates Meta webhooks, analyzes inbound rental inquiries, and sends one immediate policy-safe reply through the official Messenger Send API.

**Architecture:** Keep Messenger separate from browser-based Group monitoring. A raw-body webhook adapter authenticates and normalizes inbound events, a durable single-process worker claims each message once, a deterministic policy constrains OpenAI output, and a small Graph API client performs the send. The Command Center adds conversation and reply-format views over sanitized APIs.

**Tech Stack:** Node.js ESM, Express 5, Next.js 16, React 19, official OpenAI SDK, Meta Messenger Platform Webhooks/Send API, built-in `node:test`, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-21-multi-group-business-relevance-design.md`

## Global Constraints

- Use Meta Webhooks and the Messenger Send API; do not automate Page Inbox with Playwright.
- Auto-reply is disabled until Page ID, Page access token, app secret, verify token, public HTTPS callback, and fallback policy validate.
- Verify `X-Hub-Signature-256` over raw bytes before JSON parsing or persistence.
- Ignore echoes, delivery/read receipts, wrong-Page events, and unsupported events.
- Never initiate a Messenger conversation from scraped Group identity.
- Never log or return Page tokens, app secrets, verify tokens, OpenAI keys, or unredacted webhook bodies.
- Automatic replies gather requirements and hand off; they do not promise inventory, price, viewing, booking, or payment.

## Review Focus

- The same Meta `mid` delivered twice must produce exactly one outbound reservation and API call; Task 4 pins this.
- An outbound message echo must never trigger another reply; Task 1 pins this.
- A valid JSON body with an invalid signature must create no durable work; Task 1 pins this.
- Manual takeover racing a queued message must win before the Send API call; Task 4 pins this.
- An ambiguous Send API network result must not be blindly retried; Task 3 pins this.

---

## File structure

- `src/meta-webhook.mjs`: verification challenge, raw-body signature check, event normalization.
- `src/reply-policy.mjs`: reply-profile validation, variables, deterministic action gates.
- `src/messenger-generator.mjs`: strict OpenAI response generation and safe fallback.
- `src/meta-client.mjs`: small injectable Messenger Send API client.
- `src/messenger-worker.mjs`: durable claiming, deduplication, processing, recovery.
- `src/server.mjs`: webhook middleware order and sanitized Messenger APIs.
- `app/components/messenger-inbox.jsx`: thread list, conversation, lead insight, takeover control.
- `app/components/reply-settings.jsx`: Page readiness and reply-format editor/preview.
- `scripts/meta-webhook.test.mjs`, `scripts/reply-policy.test.mjs`, `scripts/meta-client.test.mjs`, `scripts/messenger-worker.test.mjs`: domain tests.
- `scripts/verify-messenger.mjs`: signed fixture webhook proof with mocked Send API.

### Task 1: Authenticated Meta webhook adapter

**Files:**
- Create: `src/meta-webhook.mjs`
- Create: `scripts/meta-webhook.test.mjs`
- Modify: `src/server.mjs`

**Interfaces:**
- Produces: `verifyChallenge(query, expectedToken) -> string`, `verifySignature(rawBody, signatureHeader, appSecret) -> boolean`, `normalizePageEvents(payload, pageId) -> NormalizedEvent[]`.
- Consumes: environment `META_VERIFY_TOKEN`, `META_APP_SECRET`, and `META_PAGE_ID`.

- [ ] **Step 1: Write failing challenge, signature, and normalization tests**

Cover valid/invalid verification tokens, valid/invalid/missing `sha256=` signatures, wrong Page, duplicate message bodies, text message, attachment-only message, echo, read, and delivery events. Assert only supported non-echo message events normalize.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/meta-webhook.test.mjs`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement constant-time verification and event normalization**

Use `crypto.createHmac("sha256", appSecret)` and `timingSafeEqual` only after equal-length checks. Normalize event key as `${pageId}:${mid}` and retain sender ID, timestamp, text, and attachment metadata.

- [ ] **Step 4: Mount raw webhook routes before `express.json()`**

Add `GET /webhooks/meta` and `POST /webhooks/meta` using `express.raw({ type: "application/json", limit: "256kb" })`. Reject invalid signatures with `401`; acknowledge accepted events with `200` before worker processing.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/meta-webhook.mjs src/server.mjs scripts/meta-webhook.test.mjs
git commit -m "feat: validate meta messenger webhooks"
```

### Task 2: Reply profile and policy engine

**Files:**
- Create: `src/reply-policy.mjs`
- Create: `scripts/reply-policy.test.mjs`

**Interfaces:**
- Consumes: version-3 reply profile, normalized inbound event, thread state, analysis result.
- Produces: `validateReplyProfile(input) -> ReplyProfile`, `renderReplyProfile(profile, fields, body) -> string`, `decideReplyAction({ event, thread, analysis, config, now }) -> PolicyDecision`, `validateGeneratedReply(text, profile) -> string`.

- [ ] **Step 1: Write failing profile and policy tests**

Pin Thai/English/bilingual values, max length, known variables, missing variable omission, required/forbidden phrases, opt-out, human request, low confidence, unsupported attachment, paused/handoff thread, and applicable reply-window rejection.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/reply-policy.test.mjs`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement profile validation and rendering**

Allow only `customer_name`, `location`, `budget`, `move_date`, and `business_name`; reject unknown placeholders at save time and cap the final response at the validated profile maximum.

- [ ] **Step 4: Implement deterministic policy decisions**

Return only `reply`, `clarify`, `acknowledge_and_handoff`, or `ignore`. Deterministic opt-out, handoff, channel, window, and thread-state checks override model suggestions.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/reply-policy.mjs scripts/reply-policy.test.mjs
git commit -m "feat: enforce messenger reply policy"
```

### Task 3: OpenAI response generator and Meta client

**Files:**
- Create: `src/messenger-generator.mjs`
- Create: `src/meta-client.mjs`
- Create: `scripts/meta-client.test.mjs`
- Create: `scripts/messenger-generator.test.mjs`

**Interfaces:**
- Produces: `createMessengerGenerator({ apiKey, model, client }) -> generate(event, thread, businessProfile, replyProfile)`, `createMetaClient({ pageAccessToken, graphVersion, fetchImpl }) -> { sendText({ recipientId, text, metadata }) }`.
- Consumes: policy validation from Task 2.

- [ ] **Step 1: Write failing generator and HTTP client tests**

Assert structured intent/extraction/action output, safe acknowledgement fallback, no invented availability, correct recipient payload, bearer token header, sanitized definite rejection, and ambiguous network result classified as `unknown` without retry.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test scripts/messenger-generator.test.mjs scripts/meta-client.test.mjs`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement strict OpenAI generation**

Use the official SDK Responses API with a strict schema. Treat inbound text as untrusted data. Run generated text through `validateGeneratedReply`; on failure return the configured safe acknowledgement and source `deterministic_fallback`.

- [ ] **Step 4: Implement one-attempt Send API client**

POST text to the configured Graph API version for `/me/messages`. Never place the token in a URL or error. Return `sent`, `rejected`, or `unknown`; do not retry inside the client.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/messenger-generator.mjs src/meta-client.mjs scripts/messenger-generator.test.mjs scripts/meta-client.test.mjs
git commit -m "feat: generate and send messenger replies"
```

### Task 4: Durable Messenger worker

**Files:**
- Create: `src/messenger-worker.mjs`
- Create: `scripts/messenger-worker.test.mjs`
- Modify: `src/state.mjs`

**Interfaces:**
- Consumes: store, generator, policy, Meta client, clock.
- Produces: `createMessengerWorker({ store, generate, decide, meta, now })` with `enqueue(events)`, `drain()`, `recover()`, `setThreadStatus(senderId, status)`.

- [ ] **Step 1: Write failing deduplication and recovery tests**

Assert duplicate `mid` creates one record, one inbound produces at most one reservation and send, sent work is never resumed, queued work resumes after restart, manual handoff before send suppresses it, echo creates no work, and unknown send result stays locked.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/messenger-worker.test.mjs`

Expected: FAIL because the worker does not exist.

- [ ] **Step 3: Add atomic state transitions**

Persist `received -> queued -> analyzing -> sent|handoff|failed|ignored`; reserve the outbound record before network I/O and relate it to `replyToMid`.

- [ ] **Step 4: Implement the single-process drain and startup recovery**

Process serially, re-read thread/config immediately before send, update lead insight, and never reattempt `sent` or `unknown` outbound records.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/messenger-worker.mjs src/state.mjs scripts/messenger-worker.test.mjs
git commit -m "feat: process messenger events exactly once"
```

### Task 5: Messenger APIs and fixture transport

**Files:**
- Modify: `src/server.mjs`
- Create: `src/messenger-fixture.mjs`
- Create: `scripts/messenger-api.test.mjs`

**Interfaces:**
- Consumes: webhook adapter, worker, reply policy, generator, and Meta client.
- Produces: spec-defined `/api/messenger/*` and `/api/reply-profile/*` APIs plus fixture-only signed event/send capture endpoints.

- [ ] **Step 1: Write failing sanitized API and enablement tests**

Assert status never returns secrets, enable rejects each missing requirement, disable is idempotent, profile preview never sends, thread status accepts only three values, and fixture events traverse the same worker.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/messenger-api.test.mjs`

Expected: FAIL because routes and fixture transport are missing.

- [ ] **Step 3: Wire Messenger services and APIs**

Implement status, enable, disable, thread list/status, reply-profile read/update/preview, and enqueue accepted webhook events after the response has been acknowledged.

- [ ] **Step 4: Add fixture-only Page and Send API capture**

Fixture mode signs webhook requests with the same HMAC path and records outbound payloads for assertions. Live mode must not mount test injection routes.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/server.mjs src/messenger-fixture.mjs scripts/messenger-api.test.mjs
git commit -m "feat: expose messenger workflow APIs"
```

### Task 6: Messenger Inbox and reply settings UI

**Files:**
- Create: `app/components/messenger-inbox.jsx`
- Create: `app/components/reply-settings.jsx`
- Modify: `app/page.jsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: sanitized Messenger status, threads, profile preview, profile update, and thread-status APIs.
- Produces: functional `Messenger` and `Settings` views in the Command Center.

- [ ] **Step 1: Implement the three-column Messenger workspace**

Add queue filters, selected conversation, sent/failed/handoff states, bot-active control, and lead insight for score, intent, location, budget, dates, and missing facts.

- [ ] **Step 2: Implement Page readiness and reply-format settings**

Show configured/missing indicators only, enable/disable control, language/tone/greeting/closing/max-length inputs, required/forbidden phrase chips, handoff keywords, and non-sending preview.

- [ ] **Step 3: Add race-safe takeover UX and animation**

Persist `human_handoff` before enabling manual compose UI; disable bot controls during the request. Reuse Command Center motion tokens and reduced-motion rules.

- [ ] **Step 4: Build and commit**

Run: `npm run build`

Expected: production build succeeds.

```bash
git add app/components/messenger-inbox.jsx app/components/reply-settings.jsx app/page.jsx app/globals.css
git commit -m "feat: add messenger operations workspace"
```

### Task 7: Docker configuration and end-to-end proof

**Files:**
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `package.json`
- Create: `scripts/verify-messenger.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed Messenger integration.
- Produces: documented environment contract and `npm run verify:messenger`.

- [ ] **Step 1: Add placeholder-only Meta configuration**

Document `META_PAGE_ID`, `META_PAGE_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION`, and the public callback requirement. Never commit real values.

- [ ] **Step 2: Write the signed end-to-end fixture verifier**

Send one signed tenant message twice, assert the webhook returns promptly, wait for one captured outbound message, assert reply format and recipient, inject its echo, and assert the outbound count remains one. Then switch the thread to handoff and assert a later inbound creates no send.

- [ ] **Step 3: Run complete verification**

Run: `npm test && npm run build && docker compose up --build -d && docker compose exec poc npm run verify:command-center && docker compose exec poc npm run verify:messenger`

Expected: all unit tests/builds pass; both verifiers pass; captured Messenger send count is exactly one for the duplicated event.

- [ ] **Step 4: Perform authorized live smoke test**

With a dedicated Meta test Page and public HTTPS callback, subscribe the webhook, send one message from a permitted tester, and confirm one formatted reply plus no echo loop. Do not use Group credentials for this step.

- [ ] **Step 5: Commit**

```bash
git add .env.example compose.yaml package.json scripts/verify-messenger.mjs README.md
git commit -m "docs: configure and verify messenger auto reply"
```
