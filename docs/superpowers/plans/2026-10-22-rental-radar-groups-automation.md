# Rental Radar Groups and Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Facebook Group observation and delivery into an isolated worker with durable schedules, per-source policies, evidence, circuit breakers, and terminal unknown outcomes.

**Architecture:** The application writes immutable scan or delivery commands to PostgreSQL. A private group-worker process receives only operation identity, allow-listed destination, exact text hash, and expiry. It owns the encrypted Chromium profile but no database, inventory, Meta Page token, or OpenAI capability.

**Tech Stack:** Node.js 22, Playwright Core, Chromium, PostgreSQL jobs, Express private worker API, Docker Compose, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-22-rental-radar-production-design.md`

## Global Constraints

- Accept only canonical numeric `https://www.facebook.com/groups/{id}` sources.
- One active browser lease per profile.
- Read-only scans may retry; possible sends may not retry automatically.
- Partial scans retain observed items and never delete missing items.
- Automatic mode requires allow-list, healthy session, healthy selector version, limits, business hours, grounded facts, and no kill switch.
- The protected browser session is private, short-lived, admin-only, and audited.

## Review Focus

- Facebook changes its DOM while a scan is running; observed items remain and coverage becomes partial. Covered in Task 2.
- A browser crash after clicking Reply becomes terminal `unknown`. Covered in Task 4.
- Identical comment text from another sender does not falsely reconcile a delivery. Covered in Task 4.
- Session expiration trips a circuit breaker and prevents automatic jobs until repaired. Covered in Task 3.
- Two scheduled scans for the same source and slot create one job. Covered in Task 5.

---

## File structure

```text
src/db/migrations/005-sources.sql       sources, group observations, schedules, circuit state
src/sources/service.mjs                 add source, health, policy, scan commands
src/sources/repository.mjs              source and observation persistence
src/channels/groups/contracts.mjs       signed private command schemas
src/channels/groups/client.mjs          application-side private worker client
src/group-worker/server.mjs             isolated command server
src/group-worker/session.mjs            exact profile/page selection and health
src/group-worker/observer.mjs           DOM observation and coverage
src/group-worker/delivery.mjs           send and reconciliation evidence
src/workers/group-results.mjs            application-side result acceptance
src/workers/scheduler.mjs               idempotent schedule-slot jobs
src/http/source-routes.mjs              Sources and recovery endpoints
scripts/group-worker-contract.test.mjs
scripts/group-delivery.integration.test.mjs
scripts/scheduler.test.mjs
```

### Task 1: Source domain and private worker contract

**Files:**
- Create: `src/db/migrations/005-sources.sql`, `src/sources/service.mjs`, `src/sources/repository.mjs`, `src/channels/groups/contracts.mjs`
- Test: `scripts/source-domain.test.mjs`

**Interfaces:**
- Consumes: actor, idempotency, automation policy.
- Produces: `addGroupSource`, `updateGroupSource`, `requestGroupScan`, and signed `ScanCommand | GroupReplyCommand | ReconcileCommand` schemas.

- [ ] **Step 1: Write failing source tests**

Cover URL canonicalization, idempotent add, organization scoping, expected revision, Observe/Approval/Automatic modes, and automatic-mode readiness refusal.

```js
test("automatic mode requires an allow-listed healthy source", async () => {
  const source = await addGroupSource("https://m.facebook.com/groups/1742522453522327/?ref=share");
  assert.equal(source.canonicalUrl, "https://www.facebook.com/groups/1742522453522327");
  await assert.rejects(setMode(source.id, "automatic"), /not ready/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/source-domain.test.mjs`
Expected: FAIL on missing source modules.

- [ ] **Step 3: Implement source domain and contracts**

Commands include operation ID, source ID, canonical target, exact text hash where applicable, issued-at, expiry, and signature. They contain no inventory rows or secrets.

- [ ] **Step 4: Verify**

Run focused tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/005-sources.sql src/sources src/channels/groups/contracts.mjs scripts/source-domain.test.mjs
git commit -m "feat: define group source and worker contracts"
```

### Task 2: Isolated observation worker

**Files:**
- Create: `src/group-worker/server.mjs`, `src/group-worker/session.mjs`, `src/group-worker/observer.mjs`, `src/channels/groups/client.mjs`
- Modify: `src/browser.mjs`
- Test: `scripts/group-worker-contract.test.mjs`, `scripts/browser.test.mjs`

**Interfaces:**
- Consumes: signed `ScanCommand`.
- Produces: `ScanObservationBatch` with selector version, coverage, stable identities, timestamps, and evidence hashes.

- [ ] **Step 1: Write failing contract tests**

Cover bad signatures, expired commands, wrong hosts, multiple Chromium pages, deterministic page selection, partial observations, duplicate identities, and browser-profile exclusivity.

```js
test("worker rejects untrusted commands and selects the commanded group page", async () => {
  assert.equal((await callWorker(expiredCommand)).status, 401);
  assert.equal((await scan(validCommand)).groupId, validCommand.groupId);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/group-worker-contract.test.mjs scripts/browser.test.mjs`
Expected: FAIL on missing isolated worker.

- [ ] **Step 3: Extract and implement observer**

Move Playwright selectors behind `observer.mjs`. Select or create the page for the command explicitly; never use `context.pages()[0]`. Return observations only.

- [ ] **Step 4: Verify**

Run focused suites against recorded fixture pages. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/group-worker src/channels/groups/client.mjs src/browser.mjs scripts/group-worker-contract.test.mjs scripts/browser.test.mjs
git commit -m "feat: isolate facebook group observation"
```

### Task 3: Durable scan results, coverage, and circuit breakers

**Files:**
- Create: `src/workers/group-results.mjs`
- Modify: `src/sources/service.mjs`, `src/sources/repository.mjs`
- Test: `scripts/group-scan.integration.test.mjs`

**Interfaces:**
- Consumes: `ScanObservationBatch` for one operation ID.
- Produces: normalized Group messages/work items, source health, scan coverage, and analysis jobs.

- [ ] **Step 1: Write failing scan tests**

Cover repeated results, partial coverage, missing items not deleted, auth-required state, three consecutive selector failures opening a circuit, successful recovery, and bounded read-only retries.

```js
test("partial scans retain earlier targets and repeated failures open the circuit", async () => {
  await acceptPartial(batchWithoutOldTarget);
  assert.ok(await findTarget(oldTargetId));
  assert.equal((await failSelectorThreeTimes()).circuitState, "open");
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/group-scan.integration.test.mjs`
Expected: FAIL on missing result handler.

- [ ] **Step 3: Implement result acceptance**

Persist observations and inbox work in one transaction. Keep discovery separate from analysis so rescans do not duplicate Inbox items.

- [ ] **Step 4: Verify**

Run scan and Inbox suites. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/group-results.mjs src/sources scripts/group-scan.integration.test.mjs
git commit -m "feat: persist resilient group scan results"
```

### Task 4: Group delivery and evidence reconciliation

**Files:**
- Create: `src/group-worker/delivery.mjs`, `src/workers/group-delivery-worker.mjs`
- Modify: `src/channels/groups/contracts.mjs`, `src/submission-policy.mjs`
- Test: `scripts/group-delivery.integration.test.mjs`

**Interfaces:**
- Consumes: authorized DeliveryIntent and signed `GroupReplyCommand`.
- Produces: `GroupSendObservation` with `sent | failed | unknown`, remote ID when available, evidence, destination, sender, and attempt bounds.

- [ ] **Step 1: Write failing delivery tests**

Cover exact target and content revalidation, crash before click, definite rejection, crash after click, visible verification, terminal unknown, and reconciliation that checks destination plus sender plus time plus content.

```js
test("crash after possible click is terminal unknown", async () => {
  const result = await deliverWithCrash({ phase: "after_click" });
  assert.equal(result.state, "unknown");
  assert.equal(await canLeaseAgain(result.intentId), false);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/group-delivery.integration.test.mjs`
Expected: FAIL on missing delivery modules.

- [ ] **Step 3: Implement delivery boundary**

Persist `attempting` before sending the private command. A lease expiry cannot make an attempting intent sendable. `not_found` reconciliation remains unknown and never authorizes automatic resend.

- [ ] **Step 4: Verify**

Run Group delivery and legacy submission-policy tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/group-worker/delivery.mjs src/workers/group-delivery-worker.mjs src/channels/groups/contracts.mjs src/submission-policy.mjs scripts/group-delivery.integration.test.mjs
git commit -m "feat: make group replies evidence driven"
```

### Task 5: Scheduler, policy preview, and kill switches

**Files:**
- Create: `src/workers/scheduler.mjs`, `src/policy/preview.mjs`, `src/http/automation-routes.mjs`
- Modify: `src/server.mjs`
- Test: `scripts/scheduler.test.mjs`, `scripts/policy-preview.test.mjs`

**Interfaces:**
- Consumes: source schedules and production policy evaluator.
- Produces: one scan job per `(source_id, schedule_slot)`, global/per-source pause, and `previewPolicy(sample, policy)`.

- [ ] **Step 1: Write failing scheduler tests**

Assert slot dedupe, timezone business hours, daily limit, global pause, per-source pause, unhealthy-source refusal, and preview parity with the production evaluator.

```js
test("scheduler deduplicates slots and preview uses production policy", async () => {
  await Promise.all([tick(slot), tick(slot)]);
  assert.equal(await scanJobCount(slot), 1);
  assert.deepEqual(await previewPolicy(sample, policy), await evaluatePolicy(sample, policy));
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/scheduler.test.mjs scripts/policy-preview.test.mjs`
Expected: FAIL on missing scheduler.

- [ ] **Step 3: Implement scheduler and routes**

Use database time and unique schedule-slot keys. The kill switch blocks new scan/delivery leases without mutating in-flight evidence.

- [ ] **Step 4: Verify**

Run focused tests and `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/scheduler.mjs src/policy/preview.mjs src/http/automation-routes.mjs src/server.mjs scripts/scheduler.test.mjs scripts/policy-preview.test.mjs
git commit -m "feat: schedule and control facebook automations"
```

### Task 6: Protected session recovery and controlled staging harness

**Files:**
- Create: `src/http/source-routes.mjs`, `scripts/staging-facebook-check.mjs`, `docs/runbooks/facebook-staging.md`
- Modify: `src/server.mjs`, `docker-compose.yml`, `supervisord.conf`, `.env.example`
- Test: `scripts/source-recovery.test.mjs`

**Interfaces:**
- Consumes: admin session, source ID, short-lived recovery request.
- Produces: audited protected browser tunnel and no-send staging checks; live send requires explicit `STAGING_FACEBOOK_SEND=true` plus source allow-list.

- [ ] **Step 1: Write failing recovery tests**

Assert non-admin rejection, tunnel expiry, automation lock while recovery is active, no public noVNC route, and staging refusal without both gates.

```js
test("browser recovery is private, expiring, and admin only", async () => {
  assert.equal((await viewer.startRecovery()).status, 403);
  assert.equal((await publicClient.get("/novnc")).status, 404);
  assert.equal(await tunnelStateAfterExpiry(), "closed");
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/source-recovery.test.mjs`
Expected: FAIL on missing recovery boundary.

- [ ] **Step 3: Implement recovery and staging harness**

Never automate credential entry. The runbook covers session expiry, checkpoint, selector drift, source pause, and human resolution of unknown sends.

- [ ] **Step 4: Verify**

Run: `docker compose config && npm test && node scripts/staging-facebook-check.mjs --no-send`
Expected: valid Compose, tests PASS, no-send health and scan evidence report produced.

- [ ] **Step 5: Commit**

```bash
git add src/http/source-routes.mjs src/server.mjs docker-compose.yml supervisord.conf .env.example scripts/staging-facebook-check.mjs scripts/source-recovery.test.mjs docs/runbooks/facebook-staging.md
git commit -m "feat: secure facebook session operations"
```

