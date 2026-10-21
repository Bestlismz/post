# Facebook group reply POC

This throwaway POC tests the risky browser workflow before the production architecture is built. It runs a Next.js dashboard, an Express workflow API, headed Chromium, Playwright, Xvfb, and noVNC in one Docker container.

## What it proves

- A user can sign in inside the same persistent Chromium profile that Playwright controls.
- One authorized group URL is saved in persistent state and reused after restarts.
- Visible feed cards are opened through their timestamp control so the scanner can save canonical post and comment permalinks automatically.
- The official OpenAI SDK can generate a reply draft. A labeled deterministic mock is used when no key is configured or the request fails.
- The operator can edit the draft and review an immutable target and message snapshot.
- The application reserves the target before the remote click and never retries an ambiguous outcome.
- Fixture mode verifies the visible reply and rejects a second submission for the same target.

The fixture does not prove current Facebook selector compatibility. Live mode is a separate, authorized manual smoke test.

## Run fixture mode

```bash
docker compose up --build -d
open http://localhost:3000
```

Open **Browser** in the dashboard. Click **Continue as Fixture Admin**. Return to **Overview**, bind the prefilled group URL, and scan.

To use OpenAI for draft generation without writing a key to disk, export the key in the shell that starts Compose:

```bash
export OPENAI_API_KEY="your-key"
docker compose up --build -d
```

The repository ignores `.env` and `.env.local`. Do not commit a key.

## Run the repeatable proof

With the fixture stack running:

```bash
docker compose exec poc npm run verify
docker compose restart poc
docker compose exec poc npm run verify
```

The verifier logs into the local fixture, scans, edits a draft, freezes the review snapshot, submits once, attempts a second confirmation, and asserts that only one visible reply exists. It also saves a dashboard screenshot at `/state/evidence/dashboard.png` inside the app-state volume.

## Authorized live smoke test

Use only an account and group you have permission to test. Start with submission disabled:

```bash
POC_MODE=live docker compose up --build -d
```

Sign in through **Browser**, save a numeric group URL such as `https://www.facebook.com/groups/123456789` once, and scan. Later restarts reuse the saved group and browser profile. The selector adapter opens visible posts to capture canonical post and comment IDs, and fails closed when it cannot verify a permanent link.

Enable one real reply only after inspecting the selected test target:

```bash
POC_MODE=live POC_LIVE_SUBMISSION=true docker compose up -d
```

Live submission remains `unknown` after the click because this POC cannot prove account identity and placement as strongly as the fixture. It stores screenshot evidence and locks the target against retries.

## Stop and reset

`docker compose down` keeps the Chromium profile and duplicate history. `docker compose down -v` deletes both volumes, including the saved login, replies, and submission locks.

The second command is destructive. Use it only when you intend to reset the entire POC.

## Production gaps

- No dashboard authentication or TLS.
- No queue, scheduler, PostgreSQL, retention job, or multi-customer isolation.
- Facebook selectors cover visible posts only and require a live compatibility pass.
- A single process and JSON journal are deliberate POC limits. Production should separate the browser service and use transactional storage.

