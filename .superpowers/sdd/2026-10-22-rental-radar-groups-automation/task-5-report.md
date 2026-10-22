# Task 5 report

Implemented durable Facebook Group scan scheduling, policy preview, and organization/source kill switches in additive migration `014-automation-scheduling.sql`. Existing migrations and immutable delivery evidence remain unchanged.

## Scheduling and durable decisions

`createGroupScheduler` reads its tick instant from PostgreSQL, evaluates each configured source under organization/source locks, and produces at most one signed scan operation and one durable job for each `(organization, source, UTC schedule slot)`. The unique receipt constraint and lock order make concurrent scheduler processes idempotent. Every due decision is append-only: scheduled receipts bind the operation and job IDs, while skipped receipts retain stable reason codes and the exact schedule snapshot used.

The pure schedule evaluator uses IANA local time, including DST transitions, supports weekday windows (including overnight windows), UTC maintenance intervals, per-local-day scan limits, cadence slots, global/source pauses, archive state, session and selector health/circuits, and supported selector versions. Scheduled jobs carry their slot, so the generic queue claim boundary rechecks pause, archive, health, and circuit gates before issuing a lease. Manual scans remain distinguishable and explicit recovery behavior is preserved.

Persisted invalid schedule data is isolated per source: it produces an `INVALID_SCHEDULE` receipt using a bounded UTC fallback slot and cannot abort processing of another due source. Application routes reject such data before storage.

## Policy preview and controls

`previewPolicy(sample, policy, now)` delegates directly to the production `evaluatePolicy` function already used by the final Group delivery gate. The authenticated preview route uses database time, so preview and dispatch share the same business-hours semantics.

Admin control routes persist global and per-source pause changes through idempotent commands, append an immutable control receipt with a stable reason code, and append an audit event. They only change the control flag; running jobs, attempts, and evidence rows are not rewritten. Group scan and delivery claim queries refuse new leases while paused. Direct delivery calls retain Task 4 fail-closed cancellation semantics without creating an attempt.

The schedule API creates or updates source schedules under optimistic revision control, validates IANA zones and maintenance bounds, returns ETags, and audits changes. Read APIs expose bounded operational state without provider identities or command envelopes.

## Runtime boundary

The web role may manage mutable schedules and insert control receipts but cannot mutate schedule decision receipts. The worker role can read schedules and append schedule receipts, but cannot administer schedules or read control receipts. It retains only the existing command/job/audit capabilities required to produce a scheduled scan. The browser worker remains database-free.

## TDD and verification

- Initial RED: missing scheduler/preview/routes/schema and delivery claim ignoring pauses.
- GREEN: concurrent slot dedupe, database time, signed scan operations, DST-safe local windows, maintenance windows, daily limits, explicit refusal reasons, global/source pause, and policy evaluator parity.
- API RED/GREEN: schedule create/update revision handling, IANA validation, idempotent controls, immutable receipts, and preservation of running jobs.
- Claim RED/GREEN: queued scheduled scans and Group deliveries remain pending while paused or unhealthy and become claimable only after gates recover.
- Runtime RED/GREEN: a restricted worker initially failed on a row lock; serialization now uses the source row so schedules remain read-only to the worker.
- Focused scheduler/policy/foundation/delivery tests passed.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 331 passed, zero failures/skips.
- `npm run build`: passed.
- `git diff --check`: passed.

No external Facebook action was performed. No credentials were read, logged, or persisted. No subagents were used.
