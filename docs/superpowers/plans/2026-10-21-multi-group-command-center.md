# Multi-group Lead Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the single-group POC into a multi-group rental-lead monitor with durable relevance analysis and an Open WebUI-inspired Operations Command Center frontend.

**Architecture:** Preserve the existing Playwright adapter and send-once Group reply workflow, but move group configuration into version-3 state and add focused domain modules for migration, relevance analysis, and scan orchestration. The Next.js client consumes one sanitized workspace API and renders the approved command-center shell without introducing a second frontend framework.

**Tech Stack:** Node.js ESM, Express 5, Next.js 16, React 19, official OpenAI SDK, Playwright Core, built-in `node:test`, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-21-multi-group-business-relevance-design.md`

## Global Constraints

- Group browsing continues through the persistent authorized Chromium session; no account password is stored by the app.
- Group scanning and submission share the existing single browser lease.
- Group replies remain manual, immutable-review, explicit-confirmation, send-once operations.
- Analyses are strict structured results and fall back to clearly labeled deterministic output.
- Existing targets, drafts, reviews, submissions, evidence, and events survive migration.
- UI direction is Operations Command Center with compact navigation, split panels, cobalt actions, emerald health states, 160–220 ms motion, and `prefers-reduced-motion` support.
- Open WebUI is interaction inspiration only; do not copy its source, name, logo, or trade dress.

## Review Focus

- A version-1 state with a verified submission must migrate without changing the submission key or unlocking the target; Task 1 pins this.
- Adding the same Group in URL variants must remain idempotent; Task 1 pins this.
- Thai text mentioning a condo without rental intent must not become a high-score lead; Task 2 pins this.
- One failing group must not erase earlier scan results or stop later enabled groups; Task 3 pins this.
- A stale analysis must not appear current after target text or business profile changes; Task 2 pins this.

---

## File structure

- `src/state.mjs`: durable store, version-3 migration, sanitized public-state projection.
- `src/groups.mjs`: canonical Group records and sequential scan-all orchestration.
- `src/relevance.mjs`: deterministic extraction, OpenAI structured analysis, cache fingerprints.
- `src/server.mjs`: HTTP wiring only; existing review/submission behavior stays intact.
- `app/page.jsx`: top-level navigation, data loading, and view selection.
- `app/components/command-center.jsx`: overview metrics, Group manager, and lead inbox.
- `app/components/group-review.jsx`: existing Group draft/review/send-once workspace.
- `app/components/ui.jsx`: small shared status, panel, badge, and notice components.
- `app/globals.css`: tokens, responsive layout, and motion.
- `scripts/state.test.mjs`, `scripts/relevance.test.mjs`, `scripts/groups.test.mjs`: domain tests.
- `scripts/verify-command-center.mjs`: fixture-mode API and browser proof.

### Task 1: Version-3 state and multi-group records

**Files:**
- Modify: `src/state.mjs`
- Create: `scripts/state.test.mjs`

**Interfaces:**
- Produces: `migrateState(input, now) -> Version3State`, `normalizeGroupUrl(rawUrl) -> { id, url }`, `upsertGroup(state, rawUrl, now) -> GroupRecord`, and the existing `createStore`, `publicState`, `preserveSubmittedTargetKeys` exports.
- Consumes: no new project interfaces.

- [ ] **Step 1: Write failing migration and idempotency tests**

Add tests named `migrates version 1 without unlocking submissions`, `accepts version 2 draft state`, `canonicalizes numeric Facebook group URLs`, and `upserts URL variants as one group`. Assert `version === 3`, the legacy Group becomes `groups[groupId]`, and existing submission data is deep-equal.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/state.test.mjs`

Expected: FAIL because the new exports and schema do not exist.

- [ ] **Step 3: Implement migration and Group record helpers**

Implement the exact interfaces above. Initialize `businessProfile`, `replyProfile`, `messengerConfig`, `messengerThreads`, `messengerMessages`, `processedWebhookEvents`, `groups`, and `analyses`; keep Messenger disabled. Make `load()` migrate before recovery and atomic write.

- [ ] **Step 4: Extend `publicState` without exposing secrets**

Return arrays for groups, targets, analyses, drafts, submissions, and events plus sanitized runtime readiness. Preserve existing frontend fields during this task.

- [ ] **Step 5: Run state and legacy tests**

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state.mjs scripts/state.test.mjs
git commit -m "feat: migrate state for multi-group monitoring"
```

### Task 2: Rental relevance analysis

**Files:**
- Create: `src/relevance.mjs`
- Create: `scripts/relevance.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: version-3 `businessProfile`, target `{ key, fingerprint, text, postText, context }`.
- Produces: `createRelevanceAnalyzer({ apiKey, model }) -> analyze(target, profile)`, `analyzeDeterministically(target, profile) -> Analysis`, `analysisFingerprints(target, profile) -> { targetFingerprint, businessProfileFingerprint }`, `isAnalysisFresh(analysis, target, profile) -> boolean`.

- [ ] **Step 1: Write failing deterministic classification and extraction tests**

Cover explicit Thai tenant demand, English tenant demand, explicit owner-help request, neutral listing, irrelevant condo news, weak condo mention, Thai budgets, location, bedrooms, and move date. Assert exact intent, threshold behavior, extracted values, and that weak mentions score below 60.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/relevance.test.mjs`

Expected: FAIL because `src/relevance.mjs` does not exist.

- [ ] **Step 3: Implement deterministic analysis and fingerprints**

Use explicit weighted positive and negative signals. Return the spec's complete `Analysis` shape with source `deterministic`; `isAnalysisFresh` compares both fingerprints.

- [ ] **Step 4: Add strict OpenAI structured analysis with fallback**

Use `client.responses.create` through the official SDK and a JSON schema for score, intent, reasons, and extracted criteria. Validate every field locally; return `deterministic_fallback` with sanitized detail on request or validation failure.

- [ ] **Step 5: Add injected-client tests for valid, invalid, and rejected OpenAI output**

Allow `createRelevanceAnalyzer({ apiKey, model, client })` for tests. Assert valid structured output uses source `openai`; malformed and thrown responses use deterministic fallback without leaking a string matching `sk-`.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/relevance.mjs scripts/relevance.test.mjs package.json
git commit -m "feat: analyze rental lead relevance"
```

### Task 3: Multi-group scan service and APIs

**Files:**
- Create: `src/groups.mjs`
- Create: `scripts/groups.test.mjs`
- Modify: `src/server.mjs`

**Interfaces:**
- Consumes: store, site browser, analyzer, and `withBrowserLease(operation)`.
- Produces: `createGroupService({ store, site, analyze, withBrowserLease, now })` with `add(rawUrl)`, `setEnabled(groupId, enabled)`, `scanOne(groupId)`, `scanAll()`, and `analyzePending()`.

- [ ] **Step 1: Write failing service tests**

Use fake store/site/analyzer. Assert add is idempotent, disabled Groups are skipped, scans are sequential, a middle failure is recorded while the final Group still runs, previous results remain, and only missing/stale targets are analyzed.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/groups.test.mjs`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement `createGroupService`**

Persist `scanning`, `completed`, and `failed` status per Group. Reuse `preserveSubmittedTargetKeys`; delete absent targets only within the scanned Group and only when they have no submission.

- [ ] **Step 4: Wire exact Group and analysis routes**

Add `GET/POST /api/groups`, `PATCH /api/groups/:groupId`, `POST /api/groups/:groupId/scan`, `POST /api/groups/scan-all`, `GET/PUT /api/business-profile`, `POST /api/targets/:targetKey/analyze`, and `POST /api/analyze-pending`. Keep `/api/group` and `/api/scan` as compatibility aliases.

- [ ] **Step 5: Run all tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/groups.mjs src/server.mjs scripts/groups.test.mjs
git commit -m "feat: scan and analyze multiple groups"
```

### Task 4: Multi-group fixture proof

**Files:**
- Modify: `src/browser.mjs`
- Modify: `src/server.mjs`
- Modify: `fixture/fixture.css`
- Create: `scripts/multi-group-fixture.test.mjs`

**Interfaces:**
- Consumes: `site.normalizeGroupUrl`, `site.inspectSession`, and `site.scan` used by Task 3.
- Produces: fixture Groups `1001` and `1002` with stable, collision-free post/comment keys.

- [ ] **Step 1: Write failing fixture adapter tests**

Assert both fixture URLs normalize, scan results retain their Group IDs, and identical post IDs in two Groups cannot collide.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test scripts/multi-group-fixture.test.mjs`

Expected: FAIL because only Group `1001` is supported.

- [ ] **Step 3: Implement parameterized fixture routes and scan parsing**

Serve two deterministic rental feeds from `/fixture/groups/:groupId`; keep login cookie behavior and reply safety unchanged.

- [ ] **Step 4: Run all tests and commit**

Run: `npm test`

Expected: all tests PASS.

```bash
git add src/browser.mjs src/server.mjs fixture/fixture.css scripts/multi-group-fixture.test.mjs
git commit -m "test: add multi-group browser fixture"
```

### Task 5: Operations Command Center frontend

**Files:**
- Modify: `app/page.jsx`
- Create: `app/components/command-center.jsx`
- Create: `app/components/group-review.jsx`
- Create: `app/components/ui.jsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: sanitized `/api/state`, Group APIs, business-profile APIs, and the unchanged draft/review/submission APIs.
- Produces: views `overview`, `leads`, `groups`, `messenger-placeholder`, `browser`, `activity`, and `settings`; Messenger becomes functional in the second plan.

- [ ] **Step 1: Extract the existing Group review flow without behavioral changes**

Move its target selection, draft editor, receipt, and exact-confirmation modal into `group-review.jsx`. Verify all existing labels and submit locking remain reachable.

- [ ] **Step 2: Build the command-center shell and metrics**

Implement compact navy navigation, top metrics, auto-reply `Needs setup` placeholder, responsive header, Group health cards, and lead inbox sorted by score descending.

- [ ] **Step 3: Add lead filters and profile editor**

Implement relevant-only default, Group filter, intent filter, low-signal reveal, profile description, threshold input, save, and analyze-pending action.

- [ ] **Step 4: Add motion and accessible states**

Use CSS-only 160–220 ms transitions, capped five-row stagger, one-shot score animation, persistent errors, focus-visible rings, semantic buttons, and reduced-motion overrides.

- [ ] **Step 5: Build and commit**

Run: `npm run build`

Expected: Next.js production build succeeds with no hydration or lint errors.

```bash
git add app/page.jsx app/components/command-center.jsx app/components/group-review.jsx app/components/ui.jsx app/globals.css
git commit -m "feat: build lead command center interface"
```

### Task 6: Docker verification and handoff

**Files:**
- Create: `scripts/verify-command-center.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed multi-group API and frontend.
- Produces: `npm run verify:command-center` and documented Docker workflow.

- [ ] **Step 1: Write the end-to-end verifier**

The script logs into the fixture, adds both Groups, runs scan-all, asserts both Groups produced targets, asserts at least one tenant and owner/listing lead, checks score ordering in the API, and verifies a legacy Group target still uses manual review.

- [ ] **Step 2: Update Docker and environment documentation**

Document the business profile, OpenAI fallback labels, multiple saved Groups, and the boundary that Group replies are never automatic. Do not place real keys in examples.

- [ ] **Step 3: Run complete verification**

Run: `npm test && npm run build && docker compose up --build -d && docker compose exec poc npm run verify:command-center`

Expected: tests and build pass; verifier reports two Groups, analyzed leads, and zero automatic Group replies.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-command-center.mjs package.json .env.example compose.yaml README.md
git commit -m "docs: verify multi-group command center"
```

