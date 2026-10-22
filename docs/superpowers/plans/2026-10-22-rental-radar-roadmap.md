# Rental Radar Production Roadmap

The approved production redesign is split into four implementation plans. Execute them in this order so every cutover has one writable source of truth and an independently testable result.

1. [Foundation and Inventory](./2026-10-22-rental-radar-foundation-inventory.md)
   - Exit gate: PostgreSQL, authentication, RBAC, audit, durable jobs, Project and Unit CRUD, and deterministic match snapshots pass integration tests.
2. [Messenger and Inbox Core](./2026-10-22-rental-radar-messenger-inbox.md)
   - Exit gate: a signed fake Meta event produces one inventory-grounded sent reply through the shared authorization ledger.
3. [Groups and Automation](./2026-10-22-rental-radar-groups-automation.md)
   - Exit gate: isolated Group scan and approval reply flows pass crash, partial coverage, circuit breaker, and terminal-unknown tests.
4. [Frontend and Production Cutover](./2026-10-22-rental-radar-frontend-cutover.md)
   - Exit gate: all five destinations pass functional, responsive, accessibility, production-boundary, and full E2E verification.

## Release progression

```text
local fake providers
  -> integration environment
  -> authorized real Page and test Groups in approval-only mode
  -> measured burn-in
  -> automatic mode enabled per source
```

Automatic Group replies remain disabled until approval-only burn-in demonstrates acceptable relevance precision, selector stability, and unknown-outcome rate. Real-provider testing never replaces fake-provider crash and retry tests.

