# SDD ledger — plan: docs/superpowers/plans/2026-10-22-rental-radar-groups-automation.md

Baseline: commit `380afd5`, managed linked worktree, detached HEAD, 247 tests passing; production build, Compose, fake-provider E2E, and real container lifecycle checks green.

## Preflight compatibility scan

| Scope | Produces / consumes | Finding |
| --- | --- | --- |
| Task 1 internal | planned migration 005 vs existing 001–010 | Conflict: next migration is 011. |
| Task 1 -> Task 2 | source + signed command -> isolated worker | Clean if private result envelopes are signed too. |
| Task 2 -> Task 3 | observations -> durable acceptance | Gap: result authenticity/replay semantics are not explicit in the plan. |
| Task 3 -> existing Inbox | group observations -> conversations/messages/work items | Conflict: `conversations.channel` permits Messenger only. |
| Task 4 -> existing delivery ledger | group intent -> source FK | Conflict: `delivery_intents.source_id` references `meta_page_sources`. |
| Task 4 internal | possible send -> private worker | Clean only with a worker-local durable operation ledger; process memory is insufficient after restart. |
| Task 5 -> worker leases | global/source kill switch -> new claims | Clean if evaluated in claim transaction without rewriting in-flight evidence. |
| Task 6 -> Compose | isolated worker + profile volume | Clean if worker receives no DB/OpenAI/Meta credentials and is not host-published. |
| New tables -> runtime roles | sources/results/schedules -> web/worker | Gap: explicit provisioner allowlists must be extended per task. |

Ruling: Task 1 creates `011-group-sources.sql`, not 005. It also alters the conversation channel constraint to allow `facebook_group` while preserving Messenger behavior. Cost if wrong: migration collision and inability to normalize group observations into Inbox.

Ruling: signed command and result envelopes use versioned canonical serialization, key IDs, expiry, operation IDs, constant-time HMAC verification, bounded bodies, and replay classification. Task 2 signs worker results; Task 3 verifies them before persistence. Cost if wrong: a network peer could inject observations or replay state changes.

Ruling: Task 3 creates additive `012-group-observations.sql` for result receipts, observations, and circuit state. Task 4 creates additive `013-group-delivery.sql` to support group source references and a worker-local durable operation ledger on the protected profile volume. Neither rewrites deployed migration 008. Cost if wrong: scan evidence has no durable home, group delivery cannot use the immutable intent ledger, or a worker restart can duplicate a possible send.

Ruling: group conversations use reserved internal namespaces: `page_id=facebook_group:{groupId}`, `psid=facebook_group_target:{rootPostId}`, and digest/version-qualified message IDs. These fields never enter UI DTOs; channel is `facebook_group`. Cost if wrong: raw numeric identities can collide with Messenger Page/sender tuples, while a broad schema rename would destabilize verified Messenger paths.

Ruling: Task 3 enqueues `analyze_group_work_item`, not Messenger's `analyze_work_item`. Task 4 extends the trusted Inbox preparation service and automation worker for `facebook_group`, then consumes this distinct job kind before group delivery can be authorized. Cost if wrong: the current Messenger worker claims group work with a Meta-source lookup, exhausts retries, and marks valid leads failed.

Ruling: every table-owning task extends web/worker grants minimally. The isolated browser worker has no database role at all; only the application-side result/scheduler/delivery workers use `rental_radar_worker`. Cost if wrong: either runtime failure or unnecessary credential blast radius.

Ruling: Task 6 extends Compose with a private, non-host-published `group-worker` service on the browser network and protected profile volume. It receives only command-signing configuration and browser/session configuration—never database, OpenAI, Meta Page, or owner credentials. Cost if wrong: isolation boundary collapses.

## Task progress

- Task 1: complete (commits `f7e4b1f`, `08fa18b`; group-ID bound finding fixed; review clean)
- Task 2: complete (commits `86fadad`, `bd08e6f`, `e63e327`; identity, cancellation, quarantine, and session classification findings fixed; review clean)
- Task 2: implemented and verified (isolated worker/client, raw transport authentication, kernel profile lease, partial DOM observations; 269 tests and build pass). Python 3 is required in the Task 6 worker image. See `task-2-report.md`.
- Task 2 review corrections: all four findings fixed with RED/GREEN regressions; 38 focused tests, 280 full database-backed tests, and production build pass. Selector version `facebook-dom-v2`; timeout/disconnect cancellation must be forwarded through Task 6 server/session wiring.
- Task 2 final ownership/health corrections: unconfirmed shutdown/launch quarantines and retains profile ownership until actual termination; safe `getHealth()` state added. Evaluation errors re-probe auth/checkpoint/session loss before selector failure. 42 focused tests, 284 full database-backed tests, build and diff-check pass.
- Task 3: implemented with strict TDD and self-review. Additive migration 012, signed immutable receipts, observation history/current projections, stable group Inbox discovery, ordered source circuits, explicit recovery, and two bounded linked scan retries. Group analysis is queued as `analyze_group_work_item` for Task 4 and is not claimed by Messenger automation. All 299 database-backed tests and build pass. See `task-3-report.md`.
- Task 3 review fixes: semantic edits create immutable message/work revisions and supersede actionable older work under the conversation lock. Current equal digests and late target observations create no duplicate/stale work; newer A-to-B-to-A changes remain distinct revisions. Reserved Group provider namespaces and explicit channel guards prevent Messenger collisions in both arrival orders. No migration rewrite or schema change. All 305 database-backed tests and build pass.
- Task 4: implemented with strict TDD and self-review. Additive migration 013 extends the shared immutable reply/authorization/intent ledger with an exclusive Group source reference, append-only Group attempt bindings, and signed send receipts. Trusted Inbox preparation consumes `analyze_group_work_item` using DB-owned Group policy, health, format, and inventory evidence. Application delivery commits `attempting` before a signed private command, revalidates current target/content/source/policy at the final gate, and never retries a possible send. The isolated browser boundary uses an fsynced profile-volume operation ledger, exact destination/target/text checks, terminal unknown semantics, and evidence-only reconciliation across destination, sender, time, and content. `not_found` stays unknown. Private reply/reconcile transport, minimal runtime grants, Messenger compatibility, all 316 database-backed tests, production build, and diff check pass. See `task-4-report.md`.
- Task 4 review fixes: interrupted attempts older than two minutes are bounded and atomically finalized unknown with failed jobs and audit; direct rerun never dispatches. The browser ledger fsyncs sender/start and a possible-send phase before click and preserves real bounds across abrupt restart. Lost/unsigned responses retain an untrusted DB reconciliation seed separate from signed evidence. Reconciliation binds the original attempt operation and can recover sender/bounds from the local ledger. Only the worker role may insert immutable attempt/receipt evidence; web is SELECT-only with INSERT/UPDATE/DELETE denial tests. Lost gate COMMIT acknowledgement, settlement rollback, abrupt restart, and lost response regressions pass. All 322 database-backed tests, build, and diff check pass.
