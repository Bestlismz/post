# Rental Radar command center POC

This POC monitors multiple authorized Facebook Groups for condo-rental leads and runs an official Facebook Page Messenger auto-reply workflow. It includes a Next.js command center, Express workflow API, OpenAI analysis with a deterministic fallback, headed Chromium for Group review, and Meta webhook/Send API boundaries for Page Inbox.

## What it proves

- A user can sign in inside the same persistent Chromium profile that Playwright controls.
- Multiple authorized Group URLs are saved once and reused after restarts.
- Visible feed cards are opened through their timestamp control so the scanner can save canonical post and comment permalinks automatically.
- The official OpenAI SDK can generate a reply draft. A labeled deterministic mock is used when no key is configured or the request fails.
- The operator can edit the draft and review an immutable target and message snapshot.
- The application reserves the target before the remote click and never retries an ambiguous outcome.
- Fixture mode verifies the visible reply and rejects a second submission for the same target.
- Business relevance ranks tenant, owner, and listing signals across all saved Groups.
- Page Inbox validates signed webhooks, deduplicates Meta message IDs, applies a configurable reply format, and reserves one outbound send.

Group replies are never automatic: every Group reply still requires exact-target review and confirmation. Immediate automation applies only to Facebook Page Messenger after its credentials validate and the operator enables it.

The fixture does not prove current Facebook selector compatibility. Live mode is a separate, authorized manual smoke test.

## Run the foundation runtime

The default Compose stack now runs PostgreSQL and the authenticated web API. Messenger and Groups workers will be added by their implementation plans. The existing command-center screens still need the frontend cutover before all controls use the new APIs. The production image contains no fixture server or browser runtime.

Copy `.env.example` to `.env`, set `POSTGRES_PASSWORD`, set `COMPOSE_DATABASE_URL` with the same URL-encoded password and host `postgres`, and set a random `SESSION_SECRET` of at least 32 characters. `APP_ORIGIN` must match the origin used by your browser. Then start the stack:

```bash
docker compose up --build -d
open http://localhost:3000
```

The web service waits for PostgreSQL health and applies checksum-verified migrations before starting. To apply migrations explicitly:

```bash
docker compose run --rm web npm run migrate
```

For a one-time legacy import, run it before creating users or inventory. Mount the source file read-only. A dry run reports collection counts without writes; the real import reads the saved data back and compares it within the same transaction:

```bash
docker compose run --rm -v /absolute/path/poc-state.json:/import/state.json:ro web npm run import:legacy -- /import/state.json --dry-run
docker compose run --rm -v /absolute/path/poc-state.json:/import/state.json:ro web npm run import:legacy -- /import/state.json
```

Imports refuse an already populated database. They archive allowed business-state sections in `legacy_state_imports`, redact credential fields recursively, and preserve submitted and unknown delivery outcomes. Reserved or attempted sends become unknown in the delivery ledger. They do not enqueue work or enable sending. Later Messenger and Groups migrations must consume this archive before those channels activate.

Create the first administrator by exporting `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_DISPLAY_NAME` in your shell. The password must contain at least 12 characters:

```bash
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_DISPLAY_NAME web npm run create:admin
unset ADMIN_EMAIL ADMIN_PASSWORD ADMIN_DISPLAY_NAME
```

The repository ignores `.env` and `.env.local`. Do not commit credentials. PostgreSQL uses the named `rental-radar-postgres-data` volume. `rental-radar-browser-profile` and the separate browser network are reserved for the future Groups runtime; the web service cannot mount that profile.

## Run checks

```bash
TEST_DATABASE_URL=postgres://localhost/postgres npm test
npm run build
docker compose config --quiet
```

Database tests create isolated schemas and remove them afterward. The legacy fixture tests remain in the repository, but the old combined POC Compose service has been removed. The fixture proof commands require a separate development fixture runtime and do not apply to the production stack.

## Stop and reset

`docker compose down` preserves PostgreSQL data. `docker compose down -v` deletes the stack's named volumes, including imported history and authentication records.

The second command is destructive. Use it only when you intend to reset the database.

## Production gaps

- TLS must be supplied by the deployment's reverse proxy.
- Messenger, Groups, retention execution, and the frontend cutover remain separate milestones.
- Facebook selectors cover visible posts only and require a live compatibility pass.

