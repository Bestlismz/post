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

## Start with Docker Compose

The default stack creates persistent random secrets, starts PostgreSQL, applies every migration, provisions separate restricted web and worker roles, creates the first administrator, loads ten sample rooms, and then starts the web, automation worker, and isolated Facebook browser worker. Run:

```bash
docker compose up
```

Use `docker compose up --build` after pulling source changes when you want to force an image rebuild.

Open [http://localhost:3000](http://localhost:3000) and sign in with:

- Email: `admin@rendar.local`
- Password: `admin123456`

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters), and `ADMIN_DISPLAY_NAME` before the first start to replace those local defaults. Existing administrator accounts are never replaced. `BOOTSTRAP_SAMPLE_DATA=false` disables the sample inventory. `WEB_PORT` and `APP_ORIGIN` can change the local address. The generated database, session, encryption, and command keys stay in private named volumes and are reused across restarts; no generated secret is printed or committed.

Facebook login, Meta app credentials, and the OpenAI key remain explicit operator setup in the web Settings/Sources screens. Compose does not embed personal Facebook passwords. The browser profile is persistent, so a completed Facebook login survives normal restarts.

For production, copy `.env.example` to `.env`, replace the bootstrap administrator values, set the public HTTPS `APP_ORIGIN`, configure the provider values, and place a reverse proxy/TLS endpoint in front of the localhost-only web port. You can also supply owner/runtime/worker passwords and signing/encryption keys before the first start; Compose imports them into its secret volumes once.

For a one-time legacy import, run it before first startup or against a stopped application stack. Mount the source file read-only:

```bash
docker compose run --rm -v /absolute/path/poc-state.json:/import/state.json:ro bootstrap node scripts/import-json-state.mjs /import/state.json --dry-run
```

Imports refuse an already populated database. They archive allowed business-state sections in `legacy_state_imports`, redact credential fields recursively, and preserve submitted and unknown delivery outcomes. Reserved or attempted sends become unknown in the delivery ledger. They do not enqueue work or enable sending. Later Messenger and Groups migrations must consume this archive before those channels activate.

Both runtime roles own no schema objects and cannot run migrations or disable immutability triggers. The worker has no session access, user administration, or credential write/delete access. Row locks require narrow UPDATE privileges on identity columns; inventory facts remain read-only to the worker. Role provisioning is repeatable and must run after future migrations. For upgrades, stop web and worker, run migrations and provision both roles with owner credentials, then restart them.

The worker uses the official OpenAI Responses SDK and encrypted Page credentials saved by the OAuth workflow. It refuses owner database credentials and drains in-flight work on SIGTERM. Web receives Meta app/webhook/OAuth configuration; the worker receives only its provider key and Page encryption keys. The Groups worker is isolated on a private browser network and never receives database, session, Meta, or OpenAI secrets.

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

