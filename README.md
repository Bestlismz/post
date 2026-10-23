# rendar

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

The default Compose stack runs PostgreSQL, the authenticated web API, and one Messenger worker consuming automation and delivery jobs. The existing command-center screens still need the frontend cutover before all controls use the new APIs. The production image contains no fixture server or browser runtime.

Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD` for the database owner, and separate `RUNTIME_DATABASE_PASSWORD` and `WORKER_DATABASE_PASSWORD` values of at least 16 characters for `rental_radar_web` and `rental_radar_worker`. Set `RUNTIME_DATABASE_URL` and `WORKER_DATABASE_URL` to those accounts with URL-encoded passwords and host `postgres`. Set a random `SESSION_SECRET` of at least 32 characters. `APP_ORIGIN` must match the origin used by your browser. First build the web image and start only PostgreSQL:

```bash
docker compose build web
docker compose up -d postgres
```

Export `MIGRATION_DATABASE_URL` in your shell using the database owner and URL-encoded owner password with host `postgres`. Export both runtime passwords. These maintenance variables are passed only to short-lived containers. Web and worker receive their own restricted database URLs. Apply migrations and provision both roles explicitly:

```bash
docker compose run --rm -e MIGRATION_DATABASE_URL web npm run migrate
docker compose run --rm -e MIGRATION_DATABASE_URL -e RUNTIME_DATABASE_PASSWORD web npm run provision:runtime
docker compose run --rm -e MIGRATION_DATABASE_URL -e WORKER_DATABASE_PASSWORD web npm run provision:worker
```

For a one-time legacy import, run it before creating users or inventory. Mount the source file read-only. A dry run reports collection counts without writes; the real import reads the saved data back and compares it within the same transaction:

```bash
docker compose run --rm -e MIGRATION_DATABASE_URL -v /absolute/path/poc-state.json:/import/state.json:ro web npm run import:legacy -- /import/state.json --dry-run
docker compose run --rm -e MIGRATION_DATABASE_URL -v /absolute/path/poc-state.json:/import/state.json:ro web npm run import:legacy -- /import/state.json
```

Imports refuse an already populated database. They archive allowed business-state sections in `legacy_state_imports`, redact credential fields recursively, and preserve submitted and unknown delivery outcomes. Reserved or attempted sends become unknown in the delivery ledger. They do not enqueue work or enable sending. Later Messenger and Groups migrations must consume this archive before those channels activate.

Create the first administrator by exporting `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_DISPLAY_NAME` in your shell. The password must contain at least 12 characters:

```bash
docker compose run --rm -e MIGRATION_DATABASE_URL -e ADMIN_EMAIL -e ADMIN_PASSWORD -e ADMIN_DISPLAY_NAME web npm run create:admin
unset ADMIN_EMAIL ADMIN_PASSWORD ADMIN_DISPLAY_NAME MIGRATION_DATABASE_URL RUNTIME_DATABASE_PASSWORD WORKER_DATABASE_PASSWORD
docker compose up -d web
open http://localhost:3000
```

Both runtime roles own no schema objects and cannot run migrations or disable immutability triggers. The worker has no session access, user administration, or credential write/delete access. Row locks require narrow UPDATE privileges on identity columns; inventory facts remain read-only to the worker. Role provisioning is repeatable and must run after future migrations. For upgrades, stop web and worker, run migrations and provision both roles with owner credentials, then restart them.

Configure `OPENAI_API_KEY`, `META_TOKEN_KEY_VERSION`, and `META_TOKEN_KEYS` before `docker compose up -d worker`. The worker uses the official OpenAI Responses SDK and encrypted Page credentials saved by the OAuth workflow. It refuses owner database credentials and drains in-flight work on SIGTERM. Web receives Meta app/webhook/OAuth configuration; the worker receives only its provider key and Page encryption keys. No Groups worker is included.

Both production processes start directly with Node under Compose's init process. SIGTERM closes web receipt streams and stops accepting requests while accepted requests drain. The worker finishes its current invocation, then stops before claiming another queue stage or job. Both services have a 120-second stop grace period. Automation can make two sequential 30-second OpenAI calls; the grace period leaves another 60 seconds for normal database settlement. The Meta client permits a call timeout up to 60 seconds, with the same settlement allowance. An abnormal database stall beyond that window may still require forced termination; durable job leases and irreversible delivery-attempt records preserve recovery and no-resend behavior.

The [Inbox HTTP contract](docs/inbox-http-contract.md) describes authenticated resources, commands, and receipt replay. Frontend Cutover must implement `/settings/meta/callback` using the authenticated login flow's CSRF token. The backend accepts code/state only through the protected POST callback, and does not redirect callback query parameters into an unauthenticated mutation.

The repository ignores `.env` and `.env.local`. Do not commit credentials. PostgreSQL uses the named `rental-radar-postgres-data` volume. `rental-radar-browser-profile` and the separate browser network are reserved for the future Groups runtime; the web service cannot mount that profile.

## Run checks

```bash
TEST_DATABASE_URL=postgres://localhost/postgres npm test
npm run build
docker compose config --quiet
# Optional Docker lifecycle proof after building an image:
docker build -t rental-radar-lifecycle .
TEST_CONTAINER_IMAGE=rental-radar-lifecycle TEST_DATABASE_URL=postgres://localhost/postgres node --test scripts/inbox-container-lifecycle.mjs
```

Database tests create isolated schemas and remove them afterward. The legacy fixture tests remain in the repository, but the old combined POC Compose service has been removed. The fixture proof commands require a separate development fixture runtime and do not apply to the production stack.

## Stop and reset

`docker compose down` preserves PostgreSQL data. `docker compose down -v` deletes the stack's named volumes, including imported history and authentication records.

The second command is destructive. Use it only when you intend to reset the database.

## Production gaps

- TLS must be supplied by the deployment's reverse proxy.
- Messenger, Groups, retention execution, and the frontend cutover remain separate milestones.
- Facebook selectors cover visible posts only and require a live compatibility pass.

