# SDD ledger — plan: docs/superpowers/plans/2026-10-22-rental-radar-messenger-inbox.md

Baseline: commit `3f57dd7`, managed linked worktree, detached HEAD, 115 tests passing; production build, Docker build, Compose smoke, and restricted runtime-role integration green.

## Preflight compatibility scan

| Scope | Produces / consumes | Finding |
| --- | --- | --- |
| Task 1 internal | planned `003-inbox.sql` vs existing migrations | Conflict: foundation already owns migrations 003–006. |
| Task 2 internal | planned `004-delivery.sql` vs existing migrations | Conflict: foundation already owns migration 004. |
| Task 1 -> Task 3 | normalized messages -> Inbox projections | Clean after migration renumbering. |
| Task 1 -> Task 4 | durable analyze jobs -> extraction | Gap: no automation worker is assigned to any task. |
| Task 2 -> Task 6 | encrypted Page token -> Meta client | Clean if tokens are decrypted only at adapter boundary and never projected. |
| Task 3 -> Task 5 | conversation revisions -> reply authorization | Clean. |
| Task 4 -> Task 5 | reply pipeline -> prepareReply | Clean. |
| Task 5 -> Task 6 | DeliveryIntent -> final delivery | Clean. |
| Task 6 -> Task 7 | worker outcome -> HTTP/SSE projection | Clean. |
| New migrations -> runtime DB role | new tables -> web/worker access | Gap: foundation runtime grants are explicit and must be extended safely. |
| Task 7 -> Compose | production workers -> deployment | Gap: plan omits Compose and worker entrypoint wiring. |

Ruling: Messenger migrations are `007-inbox.sql` and `008-delivery.sql`; every reference and migration assertion uses versions 7 and 8. Task 5 modifies migration 008 only while still pre-release. Cost if wrong: migration checksum drift or collision with settings/import tables.

Ruling: each migration-owning task updates the runtime-role provisioner and permission tests for its tables. Web/worker roles receive only the exact DML required; token ciphertext and immutable ledgers remain inaccessible except through narrow application paths. Cost if wrong: production either fails at runtime or silently restores owner-level access.

Ruling: Task 5 also creates `src/workers/automation-worker.mjs` after `prepareReply` exists. Task 7 wires `worker` into Compose/package scripts and proves it uses runtime credentials. Cost if wrong: durable analyze jobs accumulate without a consumer.

Ruling: review-focus ownership follows implementation boundaries: superseded conversation context is tested in Tasks 3 and 5; invented facts in Task 4; trigger-scoped reply uniqueness in Task 5; human takeover final gate in Task 6. Cost if wrong: requirements appear covered by a task that cannot implement them.

Ruling: delivery/inbox schemas must preserve channel event time and processing order separately; row locks and revisions determine processing order, never untrusted webhook arrival timestamps. Cost if wrong: out-of-order retries can supersede newer customer input.

## Task progress

- Task 1: complete (commit `daa26dc`; review clean)
- Task 2: complete (commits `7d98d54`, `7b4a5d1`, `74e197c`; durable Page routing, expiry refresh, and no-200-drop findings fixed; re-review clean)
- Task 3: complete (commits `03649e6`, `c90141f`; pre-SQL Unicode/control validation finding fixed; re-review clean)
- Task 4: complete (commits `0c5309d`, `39334a4`, `39d0813`, `599eca6`, `421e5f7`; evidence, eligibility, format, and root-cause budget parser findings fixed; review approved with non-blocking `per month` parsing limitation)
- Task 5: complete (commits `2dc94c4`, `93e4b77`, `38bbccb`; stale recovery and final-attempt reconciliation findings fixed; review clean)
- Task 6: complete (commits `11c28bb`, `48ad1c9`; pre-dispatch claim fencing and provider-ID validation findings fixed; review clean)
- Task 7: complete (commits `261ada9`, `380afd5`; production lifecycle findings fixed; review clean)

Messenger plan status: complete. Final head: `380afd5`.
- Task 6: implemented (commits `11c28bb`, `48ad1c9`; P2 pre-dispatch retry fencing and P3 provider-ID validation fixed with RED/GREEN regressions; 227 full-suite tests passed, build passed; re-review pending)
- Task 7: implemented and self-reviewed (commit `261ada9`; authenticated Inbox commands/resources, atomic operation receipts, bounded tenant SSE replay, production restricted worker/Compose, fake-provider E2E; 246 full-suite tests and build pass; production image/container smoke pass; same-origin OAuth callback page remains an explicit Frontend Cutover dependency with tested backend POST contract)
- Task 7 lifecycle review follow-up: implemented and self-reviewed (commit `380afd5`; direct Node web CMD, abort before each worker stage, 120-second web/worker grace; 247 full-suite tests plus build, focused22, Compose/image checks and real container SSE/accepted-request/11-second-provider drain proof pass; re-review pending)
- Facebook Group Task 6 review follow-up: implemented and self-reviewed on top of `0dd5cad`; production scan/delivery/reconciliation wiring, canonical 32-byte HMAC parsing, force-closed recovery sockets, durable operation ledger, private staging harness, and active CDP/session readiness verified with 363 PostgreSQL-backed tests, production build, Compose config, Docker images, and real container replacement dedupe proof.
- Facebook Group real-DOM review follow-up: exact comment-owned Reply/editor activation and explicit session-owned sender resolution implemented with isolated Chromium RED/GREEN fixtures; 365 full-suite tests, build, Compose, image build, and container replacement proof passed without external Facebook action.
