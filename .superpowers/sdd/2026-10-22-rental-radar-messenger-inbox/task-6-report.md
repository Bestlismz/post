# Task 6 implementation report

Baseline: `38bbccb`.

Implementation commit: `11c28bb19207efd0beab853d21b8432d56764380`.

Implemented the Meta Send API client, final delivery gate, durable attempt outcomes, and human evidence reconciliation. No subagents or separate reviewer were used.

## Changes

- `createMetaSendClient({ fetchImpl, graphVersion, timeoutMs, maxResponseBytes })` sends one authenticated `POST /{version}/{encoded-page-id}/messages` request with `messaging_type: RESPONSE` and the attempt ID as message metadata. Graph versions are validated, Page paths are encoded, redirects are rejected, and tokens can only reach the official HTTPS Graph origin. The whole request and streamed response are bounded by time and byte limits. No provider error message, recipient ID, token, or message body appears in returned diagnostics.
- The client returns `dispatched` and `retrySafe` flags. Invalid local inputs return a deterministic pre-dispatch failure. Explicit provider authentication, permission, rate-limit, and invalid-request 4xx responses are terminal failed outcomes. HTTP 408, transient provider errors, network failures, timeout, 5xx, malformed responses, oversized responses, and successful responses without a valid remote message ID are unknown. Nothing retries an attempted request.
- `createMetaDeliveryWorker({ pool, credentials, client, clock })` exposes `deliverMessengerIntent(intentId)`, `runOnce()`, `recoverInterruptedAttempts()`, and `reconcileAttempt(intentId, { actor, evidence, providerMessageId })`. The consumed intent ID identifies immutable authorized content. The legacy `src/meta-client.mjs` is a small compatibility adapter over the same official client and has no fixture import.
- Final delivery locks organization policy, intent, work item, conversation, source, and snapshot unit/project rows. It checks authorization linkage, identical immutable reply content, supersession/cancellation, current policy/profile/format/source/conversation evidence, published available inventory, provider-event reply window, opt-out, takeover, source binding and outbound health, credential expiry and token rotation, rate limits, business hours, format, and delivery state.
- The transaction inserts one durable `attempting` row and attempt audit, reserves the non-retry-safe delivery job, and commits before remote I/O. An organization lock serializes rate decisions. A unique organization/intent constraint permits only one attempt. Later triggers in the same conversation have different intents and may send independently.
- Remote success persists the provider message ID, sent state, job completion, work-item completion, and audit in one transaction. Result persistence failure preserves `attempting`; re-entry returns unknown without dispatch. Recovery changes attempts older than two minutes to unknown with a durable audit and failed job, never to pending. The client timeout cannot exceed one minute. Lost COMMIT acknowledgement is also treated as uncertain.
- Human reconciliation requires a current operator/admin membership, nonempty human evidence, and an explicit remote message ID. Text-match inputs are rejected. It marks only an unresolved attempt sent and atomically updates job/work status and audit. Free-text evidence is not copied into logs or audit details; the actor and remote ID are retained.
- Credential failures before attempting back off for 30 seconds, with five permitted queue failures. They remain safe to retry because no attempt or remote request exists. This avoids blocking other delivery jobs on an unavailable credential.
- Migration `009-meta-attempts.sql` creates the tenant-scoped durable attempt table. Runtime grants permit only outcome columns to change, plus intent `UPDATE(id)` solely for PostgreSQL row-lock permission; the immutable intent trigger still rejects actual mutation. Runtime-role integration verifies successful sending and denied content, identity, and deletion mutations.
- Reused the existing locked context and freshness assertions through two exports from `src/inbox/service.mjs`. Updated foundation schema assertions for migration 9.

## TDD and verification

Initial RED: `node --test scripts/meta-delivery.integration.test.mjs` failed on the absent client and delivery worker modules.

Further observed RED cases covered disallowed HTTP origins, absent interrupted-attempt recovery, HTTP 408/transient uncertainty, missing pre-dispatch queue backoff, and work-item completion during human reconciliation. Each was made green before the final run.

The focused suite covers concurrent workers, final takeover during credential resolution, opt-out, provider-event expiry/future times, changed policy/profile/format/source/conversation/unit/project evidence, token expiry at both credential reads, durable provider IDs, timeout, crash after dispatch, lost outcome database connection, lost attempting COMMIT acknowledgement, generic lease reclamation, human remote-ID reconciliation, sent-audit rollback, later conversation replies, and final rate counts including unresolved attempts.

Final verification on 2026-10-22:

- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 223 passed, 0 failed, 0 skipped.
- Focused delivery integration suite: 24 tests passed as part of the full suite.
- `npm run build`: passed.
- `git diff --check`: passed.

The first full run caught the foundation test's hardcoded eight-migration schema list. Updated the expected migration and table list for the new attempt table, then reran the suite.

## Self-review and remaining integration

Reviewed organization-first lock ordering, terminal state replay, attempt identity uniqueness, absence of generic lease reclamation, token scope, expiry/token rechecks, redirect/endpoint construction, response bounds, diagnostic redaction, atomic sent audit persistence, takeover preservation during outcome settlement, and trigger-scoped later replies.

Tests use real PostgreSQL and injected provider transports; no live Page token or remote Meta send was used. Meta's published [Send API examples](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api) informed the official Page endpoint and request/response fields.

Task 7 still owns worker-process/Compose wiring and safe HTTP inbox/delivery DTO integration. A crashed attempting row is already returned as unknown on direct re-entry; `runOnce()` also persists unknown after the two-minute recovery threshold. No automatic resend exists for unknown, failed provider, or attempting outcomes.

The Task 4 `per month` parser limitation remains unchanged.

## Review follow-up: pre-dispatch claim fencing and provider IDs

Fix commit: `48ad1c974dea1080765bcd33e801c9c0b11d8d0c`.

Addressed the P2 concurrent retry-budget finding and P3 provider-ID validation cleanup with observed RED then GREEN tests.

- The deterministic five-worker regression holds credential failures until all five workers finish job selection. Before the fix, all five selected the same pending job, charged five attempts, and exhausted its retry budget. After the fix, one worker claims and charges one attempt; the other four return without credential access. The owner alone reschedules a pending job with its 30-second backoff, and no delivery attempt or remote send occurs.
- Delivery jobs now use an atomic `FOR UPDATE SKIP LOCKED` selection and update, a fresh UUID lease token per claim, and a 60-second pre-dispatch lease. Claims charge their own attempt once. Both direct intent delivery and `runOnce()` use this path and honor availability/backoff. Direct calls during backoff or an active claim return `DELIVERY_NOT_CLAIMED` without mutating the job.
- The final freshness transaction locks and validates the current job ID, intent, status, unexpired lease, and claim token before proceeding. Pre-dispatch failure settlement checks the same token before rescheduling. A delayed former owner cannot charge, overwrite backoff, or send after its lease has been replaced.
- Reclaim is allowed only for an expired pre-dispatch lease with no durable delivery attempt or cancellation. The attempting transaction replaces the pre-dispatch token with the irreversible attempt ID and clears lease expiry. Both generic and delivery-specific reclaim remain forbidden after attempting, including after unknown/provider failure results.
- The new expired-owner regression verifies that a delayed credential failure leaves the replacement's attempts, status, backoff timestamp, and owner unchanged. A second regression reclaims an expired pre-dispatch lease, sends once through the replacement, and verifies that the old owner cannot send after its token lookup resumes.
- The client now checks successful response shape and validates provider message IDs using a bounded ASCII identifier character schema. It does not compare IDs with outgoing text, recipient IDs, or tokens. Before the fix, reply text `1` incorrectly made provider ID `m_AbC1Def` unknown; the regression now returns sent. Empty, non-string, overlong, whitespace/control-containing, and invalid-character IDs remain unknown.

Verification after review fixes:

- `TEST_DATABASE_URL=postgres://localhost/postgres node --test scripts/meta-delivery.integration.test.mjs scripts/runtime-permissions.test.mjs scripts/meta-client.test.mjs`: 31 passed.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 227 passed, 0 failed, 0 skipped.
- `npm run build`: passed.
- `git diff --check`: passed.

Self-review checked atomic claim selection, organization/intent/job lock ordering, stale-owner fences at final dispatch and failure settlement, attempt accounting, absence of lease expiry after attempting, and provider-ID validation independent of reply text. No schema or runtime grant expansion was needed. No subagents or separate reviewer were used for the fixes.

## Facebook Group runtime review follow-up

Task 6 Group operations review fixes wire scheduled scans, signed result ingestion, reply delivery, and evidence-only reconciliation into the production application worker lifecycle. Delivery remains unclaimable until both the explicit staging switch and exact source allowlist pass; automated tests use only injected fake transports.

The application, scheduler, transport, staging tool, and private browser worker now share one strict canonical-base64 parser for exactly 32-byte HMAC keys. Recovery tracks every accepted WebSocket and destroys sockets before expiry, revoke, disconnect cleanup, or unlock. The worker actively probes Chromium CDP and Facebook session ownership; startup gaps, stale/auth/checkpoint sessions, and probe failures return non-ready health.

Compose keeps the browser service private and credential-minimal, persists `/data/group-operations` on a protected named volume independent of the browser profile, validates health response state, and provides a private-network, no-send-by-default `staging-check` tools profile. The runbook documents manual Facebook login/recovery only.

Final verification: PostgreSQL-backed suite 363/363, production build, Compose tools-profile config, both Docker image builds, diff check, and a real two-container replacement test proving the operation ledger prevents a second send all passed. No external Facebook action or credential automation was used.

## Real Facebook DOM review follow-up

The comment reply driver now re-locates the exact stable comment card, requires one card-owned localized Reply control, activates it, and accepts only one editor owned by that same card. It revalidates the target and exact editor text immediately before Enter. Cancellation and command expiry are checked before interaction and throughout bounded waits; interruption after Enter is classified as a possible send.

Authenticated sender identity now comes only from explicit session-owned account surfaces (banner, account menu, or composer-owned identity hook), normalized and deduplicated through a replaceable driver boundary. Feed authors and unrelated global profile links are ignored; missing or conflicting account identities fail closed.

RED fixtures demonstrated that the old driver failed a collapsed composer and mixed the logged-in identity with numeric post authors. GREEN isolated-Chromium fixtures cover collapsed composers, multiple comment cards/editors, missing and ambiguous Reply controls, ambiguous card-owned editors, cancellation/deadline, numeric user and Page identities, author-link exclusion, and an ambiguous account menu. Final verification: focused browser contracts 29/29, PostgreSQL-backed suite 365/365, production build, Compose config, group-worker image build, real container replacement dedupe test, and diff check passed. No external Facebook action was performed.

## Causal composer and dispatch-boundary review follow-up

Before clicking Reply, the driver snapshots handles and semantic state for every visible editor directly owned by the exact comment card. After the click it accepts exactly one reply-semantic editor only when it newly appeared or changed and is causally card-bound through local mutation, focus, or `aria-controls`. Pre-existing no-op editors, edit composers, unrelated focus, missing activation, and ambiguous candidates fail before any fill or keypress.

The irreversible boundary now starts immediately before invoking Enter. Any press rejection, browser/context closure, timeout, or cancellation after invocation carries `possibleClick`, settles the durable operation as unknown, and can only proceed through reconciliation. An isolated Chromium page-close-on-keydown fixture proves the replacement worker reads the terminal ledger and performs no second send.

Adversarial RED showed the old driver reused a pre-existing card textbox after a no-op Reply. GREEN verification: PostgreSQL-backed suite 367/367, production build, Compose config, group-worker image build, real container replacement dedupe test, and diff check passed. No external Facebook action was performed.

## Strict editor provenance and Enter invocation follow-up

The pre-click snapshot is now a categorical denylist of every visible, direct-card-owned editor DOM handle. A handle on that list can never become the reply editor during the operation, even if Reply changes its label, semantic role, focus, ID, or ARIA attributes. The accepted activation rule is exactly one reply-semantic editor that was absent from the visible-handle snapshot and is visible/direct-owned after the click; this includes a genuinely new node or the same node transitioning from hidden to visible. When `aria-controls` exists, its ID must match the candidate.

After final target re-location and the awaited exact text read, the driver performs one synchronous cancellation/deadline assertion immediately before invoking Enter, with no intervening await. Only errors from the Enter invocation or later carry possible-send; an abort raised by the final text-read boundary produces zero keydowns and a definite pre-dispatch failure.

RED fixtures showed all three pre-existing Reply/Edit/Write editors could be relabeled and focused into the old candidate path, and that an abort injected during the final text read was ignored. GREEN fixtures prove all three handles remain untouched with zero keydowns, a previously hidden valid reply editor succeeds, final-read abort sends zero keys, and both page-close and signal cancellation from keydown remain unknown without retry. Final verification: focused Group suites 49/49, PostgreSQL-backed suite 369/369, production build, Compose config, group-worker image, container replacement dedupe, and diff check passed. No external Facebook action was performed.
