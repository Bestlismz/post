# Working conventions and source map

Verified on 2026-10-28 by reading the linked local files. Commands below were inspected, not executed as application checks.

## Constraints

- [AGENTS.md](../AGENTS.md) requires reading the relevant bundled Next.js guide under `node_modules/next/dist/docs/` before writing application code.
- [README.md](../README.md) requires exact-target review and confirmation for Facebook Group replies. It distinguishes this from Page Messenger automation.
- Keep credentials out of Git and the KB. Consult the project README for configuration and deployment instructions.

## Source map

- [README.md](../README.md): project intent, Docker setup, verification commands, and documented production gaps. Its runtime claims still require verification for the environment being used.
- [package.json](../package.json): scripts and declared dependencies. `npm test` runs `node --test scripts/*.test.mjs`; `npm run build` runs `next build`; `npm run test:e2e:fixture` builds and runs the fixture Playwright configuration.
- [Inbox HTTP contract](../docs/inbox-http-contract.md): HTTP interface reference.
- [Facebook staging runbook](../docs/runbooks/facebook-staging.md): staging procedures. This file had pre-existing local edits at initialization.
- [Production design](../docs/superpowers/specs/2026-10-22-rental-radar-production-design.md) and [roadmap](../docs/superpowers/plans/2026-10-22-rental-radar-roadmap.md): design and planned work, not proof of completion. These files were located but not reviewed during KB initialization.

## Coverage

Initialization reviewed this chat, the project README, package scripts, agent instructions, and Git sync status. It did not audit application code, earlier chats, live Facebook behavior, deployments, or test results.
