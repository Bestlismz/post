# Rendar reply-flow repair

## Decision

Use one server-owned workflow projection over the existing immutable reply,
authorization, delivery, reconciliation, job, and scan evidence. The projection
is the only source of operator-facing phase, blockers, and allowed actions.
React renders that contract; it does not infer lifecycle state from a collection
of booleans.

This is the incremental Candidate A architecture. The event-sourced aggregate
candidate was rejected for this urgent repair because it requires new event,
snapshot, operation, and effect persistence plus an all-writer cutover before a
user-visible fix can ship.

## First shipping slice

1. Add a pure projector and a truth table for observed, analyzing, review,
   queued, sending, uncertain, failed, sent, handoff, and superseded states.
2. Return the projection from Inbox list/detail; include stable reason keys,
   actual automation outcome, and server-derived actions.
3. Add explicit successor navigation and resume-from-handoff actions.
4. Prevent duplicate active preparation jobs and publish an Inbox invalidation
   as soon as scan ingestion creates or supersedes work.
5. Fence detail requests, periodically refresh the list when SSE is absent, and
   refresh list plus detail after mutations.
6. Render controls exclusively from projected actions. Remove Facebook-like
   controls that do not perform a real action.

## Invariants

- A verified provider receipt remains sent, including while a comment edit is
  pending or failed.
- An ambiguous provider result never exposes ordinary resend. It requires
  reconciliation and explicit absence verification.
- Superseded work cannot be sent and always links to the current successor.
- Human handoff suppresses automation and has an explicit resume path.
- Automatic source mode is configuration, not proof that an item was sent
  automatically. The item projection reports the actual decision and actor.
- Replaying prepare or a mutation cannot create a second active job, delivery
  intent, or provider attempt.
- Scan ingestion is visible in Inbox before AI analysis finishes.

## Throughput checkpoint

- Blocking first unit: projector contract and failing truth-table tests.
- Independent after that contract: backend transitions/invalidations and React
  rendering/refresh behavior.
- Shared mutable state: Inbox DTO and projector are owned by one implementation
  stream; no parallel edits to those files.
- Verification: unit truth table, integration transitions, full test/build,
  container health, and browser walkthrough without issuing an unconfirmed
  public Facebook comment.
