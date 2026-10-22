# Task 6 report

Implemented the protected Facebook Group browser runtime, manual session recovery, and controlled staging harness. The browser worker is private to the Compose browser network, has no published host port, owns the persistent Chromium profile volume, and receives no database, OpenAI, Meta Page, owner, or Facebook login credentials.

## Recovery and runtime boundary

- Added a dedicated Node 22 browser image with Chromium, Xvfb, Openbox, x11vnc, noVNC/websockify, Supervisor, and Python 3 for the profile `flock` helper. Supervisor runs only the isolated Group command server and browser-session processes.
- Chromium always opens Facebook for a human login. No code accepts, types, logs, or persists a Facebook username/password. Profile cookies remain solely in the protected browser volume.
- The Group worker exposes signed recovery start/stop controls and a redacted health result. Recovery leases are source-bound, limited to 30–600 seconds, expire closed, and block scan/send/reconciliation commands while active.
- The application exposes a tenant-scoped admin-only noVNC proxy with an opaque expiring session ID. HTTP assets and WebSocket upgrades independently authenticate the live application session and organization/source binding. `/novnc` is not public.
- Starting recovery durably pauses the source and appends an audit event before returning the tunnel. Manual close stops the private recovery lease and appends a second audit event. Expiry also closes the app-side tunnel and asks the worker to stop recovery.
- Existing cancellation propagates from the private HTTP request through the session boundary, including disconnect and deadline cleanup. Health exposes only stable recovery and profile-ownership states, never paths, pages, cookies, actor identity, or credentials.

## Staging controls

- A live Group reply command now requires both `STAGING_FACEBOOK_SEND=true` and an exact numeric Group ID in `STAGING_FACEBOOK_SOURCE_ALLOWLIST`, in addition to the normal signed-command and runtime allow-list checks. Read-only scans do not require the send gate.
- `scripts/staging-facebook-check.mjs` is no-send by default. With an exact allow-listed source it performs only a signed read scan and reports bounded coverage, health, selector version, observation count, and evidence hashes—never post/comment text. `--send` is readiness-only and performs no action.
- The runbook documents manual login, checkpoint/session recovery, selector drift, source pause, dual staging gates, and mandatory human handling of unknown sends. It explicitly prohibits credentials/cookies in env, source, logs, or support material.

## TDD and verification

Initial RED covered the absent recovery registry, private worker controls, source/admin/tenant boundary, noVNC protection, recovery automation lock, and dual send gates. Subsequent RED/GREEN checks covered signed recovery requests, redacted health, cleanup on expiry, Compose credential isolation, browser volume ownership, read-only staging evidence, and the 100-digit Group ID boundary shared with the source contract.

Final verification on 2026-10-22:

- Focused recovery/worker/runtime suites: 35 passed, 0 failed.
- `TEST_DATABASE_URL=postgres://localhost/postgres npm test`: 353 passed, 0 failed, 0 skipped.
- `npm run build`: passed with Next.js 16.4.2.
- `docker compose config`: passed with explicit non-secret test configuration.
- `git diff --check`: passed.
- Built `Dockerfile.group-worker` and ran the real image with `--network none`: private health returned available/healthy, Python 3.11.2 was present, no host ports existed, forbidden credential variables were absent, and Supervisor launched Xvfb, Openbox, Chromium, the Group worker, x11vnc, and websockify.

Tests use fake/injected providers and recorded DOM fixtures. No external Facebook action was performed and no Facebook credential was read. No subagents were used.
