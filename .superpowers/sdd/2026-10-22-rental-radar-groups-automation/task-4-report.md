# Task 4 report

Implemented evidence-driven Facebook Group reply delivery and reconciliation in additive migration `013-group-delivery.sql`. Existing migrations remain unchanged. The shared reply/version/authorization/delivery-intent ledger now supports exactly one Messenger Page source or Group source per intent. Group delivery bindings and signed result receipts are append-only.

## Trusted preparation and authorization

`loadContext` now resolves a Group conversation only through its reserved Group namespace and database-owned `group_sources` row. Reply evidence freezes the effective source policy, source revision/mode/health/allow-list state, organization profile, reply format revision, conversation revision, and inventory snapshot. `analyze_group_work_item` is consumed by the same trusted automation worker without allowing Messenger source lookup or client-supplied context.

Approval and automatic decisions create the existing immutable reply version, authorization, and delivery intent ledger. Group intents use `group_source_id`, enqueue `deliver_group_reply`, and cannot also reference a Meta Page source. Automatic preparation uses Group policy and health from the database. Human approval still passes transport, health, opt-out, rate, and business-hour gates.

## Delivery boundary

`createGroupDeliveryWorker` rechecks authorization, reply content, source health/circuits/kill switches, current target projection, immutable inventory evidence, current business hours, and rate limits under the organization/intent lock. It inserts the signed exact `GroupReplyCommand`, `delivery_attempts.state='attempting'`, and the Group attempt binding in one committed transaction before any private browser command is issued. After that commit no lease expiry or process restart can authorize another send.

The isolated browser boundary stores an fsynced operation record under the protected profile volume before locating the target, then durably records the actual sender, start bound, and `possible_send` phase before the click. The record contains only a command digest and outcome evidence, not reply text or credentials. Exact canonical destination, target identity, and command text/hash are revalidated. A definite pre-click rejection is `failed`; a possible click, transport ambiguity, lost acknowledgement, or interrupted local record is terminal `unknown`; only visible exact evidence is `sent`. Abrupt restart retains the real sender/time bounds, returns the durable outcome, and never clicks again.

Private client/server transport accepts signed `GroupReplyCommand` and `ReconcileCommand` envelopes in addition to scans. Results are signed, bounded, tied to operation/source/group/destination/target/text hash, and validate attempt bounds. Sent results require a remote ID; failed/unknown/not-found results cannot claim one.

## Reconciliation

Reconciliation is evidence-only. Each committed attempt has an application-owned, untrusted reconciliation seed containing its operation, destination, target, text hash, and bounded time window; this survives a lost or unsigned transport response without masquerading as signed worker evidence. The browser resolves the original durable operation record and must match canonical destination, exact post/comment target, sender, exact text hash, and an observation time inside the original attempt bounds. Signed receipts preserve the full authenticated result envelope and digest. `not_found` and `unknown` remain terminal unknown and never enable automatic resend. Only a fully bound `sent` result records the remote ID and completes the work item.

Application-side recovery scans at most 100 Group attempts older than the two-minute in-flight bound. Under the organization/intent lock it atomically changes `attempting` to terminal `unknown`, fails the delivery job, and appends an audit record. Direct reruns, process death, lost gate commit acknowledgement, and failed outcome settlement cannot redispatch.

The isolated browser module has no database dependency or credential input. Only the application delivery worker uses the restricted database role. The worker role has SELECT/INSERT on the two new immutable Group evidence tables; the web role is SELECT-only and cannot insert, update, or delete their rows.

## TDD and verification

- Initial RED: seven tests failed on the missing browser delivery boundary, missing Group delivery worker, Messenger-only trusted preparation, and absent migration 013.
- GREEN: exact target/text delivery, local restart deduplication, pre/post-click classification, signed sent evidence, terminal unknown, multi-factor reconciliation, shared intent authorization, and source gating passed.
- Transport RED/GREEN: client lacked reply/reconcile methods; signed private server routing and result binding now pass.
- Contract RED/GREEN: impossible remote-ID states and out-of-command attempt times are rejected.
- Final-policy RED/GREEN: a reply approved inside business hours was incorrectly dispatched after the window closed; delivery now re-evaluates DB policy immediately before committing `attempting`.
- Self-review RED/GREEN: authenticated result signatures were not retained in immutable receipts; full signed envelopes are now preserved, while synthesized transport-unknown outcomes do not masquerade as worker receipts.
- Focused Group/Messenger/submission regression: 99 tests passed before the final policy refinement.
- Independent-review RED/GREEN: added bounded interruption recovery, lost-COMMIT and failed-settlement regressions, pre-click durable sender/bounds, abrupt-restart reconciliation, untrusted lost-response seeds, and restricted-role evidence-write enforcement.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 322 passed, zero failures/skips.
- `npm run build`: passed.
- `git diff --check`: passed.

No external Facebook action was performed. No credentials were read, logged, or persisted. No subagents were used.
