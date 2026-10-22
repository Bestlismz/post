# Task 5 report

Implemented durable Facebook Group scan scheduling, policy preview, and organization/source kill switches in additive migration `014-automation-scheduling.sql`. Existing migrations and immutable delivery evidence remain unchanged.

## Scheduling and durable decisions

`createGroupScheduler` reads its tick instant from PostgreSQL, evaluates each configured source under organization/source locks, and produces at most one durable job for each `(organization, source, UTC schedule slot)`. The unique receipt constraint and lock order make concurrent scheduler processes idempotent. Every due decision is append-only: scheduled receipts bind the job and durable source/slot parameters, while skipped receipts retain stable reason codes and the exact schedule snapshot used.

The pure schedule evaluator uses IANA local time, including DST transitions, supports weekday windows (including overnight windows), UTC maintenance intervals, per-local-day scan limits, cadence slots, global/source pauses, archive state, session and selector health/circuits, and supported selector versions. Scheduled jobs carry their slot, so the generic queue claim boundary rechecks pause, archive, health, and circuit gates before issuing a lease. Manual scans remain distinguishable and explicit recovery behavior is preserved.

Persisted invalid schedule data is isolated per source: it produces an `INVALID_SCHEDULE` receipt using a bounded UTC fallback slot and cannot abort processing of another due source. Application routes reject such data before storage.

## Policy preview and controls

`previewPolicy(sample, policy, now)` delegates directly to the production `evaluatePolicy` function already used by the final Group delivery gate. The authenticated preview route uses database time, so preview and dispatch share the same business-hours semantics.

Admin control routes persist global and per-source pause changes through idempotent commands, append an immutable control receipt with a stable reason code, and append an audit event. They only change the control flag; running jobs, attempts, and evidence rows are not rewritten. Group scan and delivery claim queries refuse new leases while paused. Direct delivery calls retain Task 4 fail-closed cancellation semantics without creating an attempt.

The schedule API creates or updates source schedules under optimistic revision control, validates IANA zones and maintenance bounds, returns ETags, and audits changes. Read APIs expose bounded operational state without provider identities or command envelopes.

## Runtime boundary

The production application worker now runs one bounded scheduler loop beside the existing Messenger workers. It polls sequentially, never overlaps its own ticks, isolates tick and observability failures, reports stable event codes, drains an active tick on SIGTERM/SIGINT, and stops polling after abort. Multiple application-worker replicas remain safe because the database receipt constraint is the idempotency authority.

Runner configuration is parsed and range-checked synchronously before either sibling loop can start. The worker and scheduler loops are supervised as one process: an unexpected rejection or clean exit aborts their shared controller, waits for every sibling to settle, and rethrows the first failure so the process exits. Normal signal shutdown remains clean.

Each scheduler tick has one monotonic deadline and an explicit source batch limit with a stable cursor. Immediately before every SQL statement, the query boundary recomputes the tick's remaining budget, applies it as both a client read timeout and the next PostgreSQL `statement_timeout`, then checks the same deadline after completion. A deadline or signal failure destroys the active connection so PostgreSQL cancels and rolls back server work instead of continuing in the background. Acquisition, every source transaction, and commit all share this single budget; abort is checked between sources, and a late connection acquired after timeout is released. The default 30-second tick deadline stays inside Compose's two-minute shutdown grace.

The web role may manage mutable schedules and insert control receipts but cannot mutate schedule decision receipts. The worker role can read schedules, append schedule receipts, and append scan-dispatch lineage, but cannot administer schedules or read control receipts. The browser worker remains database-free.

Scheduled jobs intentionally contain no pre-signed command. After a paused or unhealthy source recovers and the queue grants a valid lease, `prepareGroupScanDispatch` rechecks all source gates under locks and signs a fresh five-minute command. Its append-only dispatch receipt distinguishes `COMMAND_FRESH`, `COMMAND_CURRENT`, and `COMMAND_REFRESHED`, preserving the source/slot/job identity and predecessor lineage. Legacy scheduled commands delayed beyond expiry are replaced atomically; their original operation and schedule receipt are never rewritten.

## TDD and verification

- Initial RED: missing scheduler/preview/routes/schema and delivery claim ignoring pauses.
- GREEN: concurrent slot dedupe, database time, durable scan parameters, DST-safe local windows, maintenance windows, daily limits, explicit refusal reasons, global/source pause, and policy evaluator parity.
- API RED/GREEN: schedule create/update revision handling, IANA validation, idempotent controls, immutable receipts, and preservation of running jobs.
- Claim RED/GREEN: queued scheduled scans and Group deliveries remain pending while paused or unhealthy and become claimable only after gates recover.
- Runtime RED/GREEN: a restricted worker initially failed on a row lock; serialization now uses the source row so schedules remain read-only to the worker.
- Review RED/GREEN: the production worker previously never invoked the scheduler; the new runtime regression proves stored schedule state creates a job and that shutdown prevents another poll. Failure isolation and overlap prevention have direct runner regressions.
- Expiry RED/GREEN: scheduler-created commands could expire during a pause. Scheduling now stores only durable parameters, and a six-minute delayed legacy command is verified expired then atomically replaced with one valid signed command at dispatch without changing its slot receipt.
- Re-review RED/GREEN: invalid runner settings start zero iterations; unexpected loop rejection and clean exit both abort and drain siblings while preserving the primary error. A server-blocked scheduler transaction is cancelled inside the tick deadline during SIGTERM-like abort, late connection acquisition is released, and five sources advance through two-row batches without duplicate jobs.
- Final RED/GREEN: two sequential 75 ms lock waits under a 100 ms tick budget terminate at the shared total deadline rather than receiving a fresh timeout per statement. The current source transaction is rolled back with no job or receipt, while multi-source batches retain their already committed, idempotent earlier work.
- Focused scheduler/policy/foundation/delivery tests passed.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 343 passed, zero failures/skips.
- `npm run build`: passed.
- `git diff --check`: passed.

No external Facebook action was performed. No credentials were read, logged, or persisted. No subagents were used.
