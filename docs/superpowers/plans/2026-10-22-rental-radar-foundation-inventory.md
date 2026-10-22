# Rental Radar Foundation and Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON business state with PostgreSQL and deliver authenticated Project and Unit CRUD plus deterministic, versioned room matching.

**Architecture:** Keep one application boundary in the current Node/Next repository. PostgreSQL owns canonical state, audit, idempotency, outbox, and jobs. Inventory exposes task-shaped commands and a pure matcher; HTTP routes never write SQL directly.

**Tech Stack:** Node.js 22, Next.js 16, Express 5, PostgreSQL 17, `pg`, `zod`, Node test runner, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-22-rental-radar-production-design.md`

## Global Constraints

- Every tenant-owned table has non-null `organization_id`; release one seeds exactly one organization.
- PostgreSQL is the only writable business-state source after cutover.
- Only published units in `available` state may enter a match snapshot.
- Archive replaces destructive inventory deletion.
- All mutations require an idempotency key and expected revision.
- State, audit entry, and outbox/job creation commit in one transaction.
- Production must not import fixture modules or expose secrets.

## Review Focus

- Concurrent edits to the same unit return `409` and preserve the newer revision. Covered in Task 4.
- Thai project names and unit codes with whitespace normalize without data loss. Covered in Task 3.
- Publishing an incomplete or `unknown`-availability unit fails with field errors. Covered in Task 3.
- A unit becoming held after matching invalidates the old match snapshot. Covered in Task 5.
- Reusing an idempotency key with a different request body returns `409`. Covered in Task 2.

---

## File structure

```text
src/config.mjs                         validated runtime configuration
src/db/pool.mjs                        PostgreSQL pool lifecycle
src/db/transaction.mjs                 transaction, audit, idempotency helpers
src/db/migrate.mjs                     ordered migration runner
src/db/migrations/001-foundation.sql   organization, users, sessions, audit, jobs
src/db/migrations/002-inventory.sql    projects, units, inventory revisions, match snapshots
src/auth/password.mjs                  password hashing and verification
src/auth/session.mjs                   signed session cookie boundary
src/auth/authorize.mjs                 role and capability checks
src/inventory/catalog.mjs              Project and Unit commands
src/inventory/matcher.mjs              pure hard filters and versioned scoring
src/inventory/repository.mjs           SQL adapter
src/inventory/schemas.mjs              Zod command and response schemas
src/http/inventory-routes.mjs          authenticated inventory endpoints
src/http/auth-routes.mjs               login, logout, current user
src/http/settings-routes.mjs           users, business profile, retention, audit queries
scripts/foundation.test.mjs            migrations, idempotency, audit tests
scripts/auth.test.mjs                  session and RBAC tests
scripts/settings.test.mjs              administration and secret-redaction tests
scripts/inventory.test.mjs             catalog and route integration tests
scripts/matcher.test.mjs               pure and PostgreSQL snapshot tests
docker-compose.yml                     web, worker, group-worker, postgres profiles
```

### Task 1: PostgreSQL foundation and migrations

**Files:**
- Create: `src/config.mjs`, `src/db/pool.mjs`, `src/db/migrate.mjs`, `src/db/migrations/001-foundation.sql`
- Modify: `package.json`, `.env.example`, `Dockerfile`
- Test: `scripts/foundation.test.mjs`

**Interfaces:**
- Consumes: `DATABASE_URL`, `APP_ORIGIN`, `SESSION_SECRET`, `NODE_ENV`.
- Produces: `loadConfig(env)`, `createPool(config)`, `migrate(pool)`, and core tables `organizations`, `users`, `memberships`, `sessions`, `idempotency_keys`, `audit_entries`, `jobs`, `outbox`.

- [ ] **Step 1: Write the failing migration test**

Assert two concurrent `migrate(pool)` calls produce one ordered schema, seed organization `org_default`, and leave no partially applied migration.

```js
test("migrations are atomic and concurrency safe", async () => {
  await Promise.all([migrate(pool), migrate(pool)]);
  assert.deepEqual(await appliedVersions(pool), [1, 2]);
  assert.equal(await organizationCount(pool, "org_default"), 1);
});
```

- [ ] **Step 2: Run the focused test**

Run: `TEST_DATABASE_URL=postgres://... node --test scripts/foundation.test.mjs`
Expected: FAIL because the database modules and tables do not exist.

- [ ] **Step 3: Implement the migration boundary**

Implement `loadConfig(env)`, `createPool({ databaseUrl, max })`, and `migrate(pool)` with a PostgreSQL advisory lock and checksummed migration ledger. Add `pg` and `zod`; do not add an ORM.

- [ ] **Step 4: Verify**

Run the focused test twice against a clean test database. Expected: PASS both times.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example Dockerfile src/config.mjs src/db scripts/foundation.test.mjs
git commit -m "feat: add postgres application foundation"
```

### Task 2: Transaction, idempotency, audit, and durable jobs

**Files:**
- Create: `src/db/transaction.mjs`, `src/jobs/queue.mjs`
- Modify: `src/db/migrations/001-foundation.sql`
- Test: `scripts/foundation.test.mjs`

**Interfaces:**
- Consumes: PostgreSQL pool from Task 1.
- Produces: `withTransaction(pool, fn)`, `runIdempotent(tx, command, fn)`, `appendAudit(tx, entry)`, `enqueueJob(tx, job)`, `claimJobs(pool, worker, limit)`.

- [ ] **Step 1: Add failing tests**

Test same-key/same-body replay, same-key/different-body conflict, rollback of state plus audit plus job, and expired safe-job lease reclaim.

```js
test("idempotency replays the same command and rejects a changed body", async () => {
  assert.deepEqual(await run(command), await run(command));
  await assert.rejects(run({ ...command, body: { changed: true } }), /idempotency/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/foundation.test.mjs`
Expected: FAIL on missing transaction helpers.

- [ ] **Step 3: Implement helpers**

Use canonical request hashes, unique `(organization_id, actor_id, route, key)`, append-only audit rows, and `FOR UPDATE SKIP LOCKED`. `attempting` delivery jobs are not part of generic lease reclaim.

- [ ] **Step 4: Verify**

Run: `node --test scripts/foundation.test.mjs`
Expected: PASS including crash/rollback assertions.

- [ ] **Step 5: Commit**

```bash
git add src/db src/jobs scripts/foundation.test.mjs
git commit -m "feat: add durable command and job primitives"
```

### Task 3: Inventory schema and catalog domain

**Files:**
- Create: `src/db/migrations/002-inventory.sql`, `src/inventory/catalog.mjs`, `src/inventory/repository.mjs`, `src/inventory/schemas.mjs`
- Test: `scripts/inventory.test.mjs`

**Interfaces:**
- Consumes: `withTransaction`, audit, idempotency, actor context.
- Produces: `createProject`, `updateProject`, `createUnit`, `updateUnit`, `publishUnit`, `changeAvailability`, `archiveUnit`, each accepting `{ organizationId, actorId, idempotencyKey, expectedRevision?, input }`.

- [ ] **Step 1: Write failing catalog tests**

Cover Project creation, Unit creation, required publication fields, explicit `petPolicy: "unknown"`, legal availability transitions, archive preservation, Thai text, and revision increments.

```js
test("only complete available units can be published", async () => {
  await assert.rejects(catalog.publishUnit(incomplete), /monthlyRentThb|availableFrom/);
  assert.equal((await catalog.publishUnit(complete)).revision, complete.revision + 1);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/inventory.test.mjs`
Expected: FAIL because inventory tables and commands do not exist.

- [ ] **Step 3: Implement the catalog**

Keep validation in `schemas.mjs`, lifecycle invariants in `catalog.mjs`, and SQL in `repository.mjs`. Store project transit and amenities in normalized child tables; store immutable unit fact revisions for later citations.

- [ ] **Step 4: Verify**

Run: `node --test scripts/inventory.test.mjs`
Expected: PASS with no destructive deletes.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/002-inventory.sql src/inventory scripts/inventory.test.mjs
git commit -m "feat: add versioned rental inventory catalog"
```

### Task 4: Authentication, RBAC, inventory, and settings HTTP APIs

**Files:**
- Create: `src/auth/password.mjs`, `src/auth/session.mjs`, `src/auth/authorize.mjs`, `src/http/auth-routes.mjs`, `src/http/inventory-routes.mjs`, `src/http/settings-routes.mjs`
- Modify: `src/server.mjs`, `package.json`, `.env.example`
- Test: `scripts/auth.test.mjs`, `scripts/inventory.test.mjs`, `scripts/settings.test.mjs`

**Interfaces:**
- Consumes: catalog commands from Task 3.
- Produces: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`, REST resources under `/api/projects` and `/api/units`, admin resources under `/api/settings/users`, `/api/settings/business-profile`, `/api/settings/retention`, `/api/settings/readiness`, `/api/settings/audit`, plus `requireRole(...roles)`.

- [ ] **Step 1: Write failing HTTP tests**

Assert secure session cookies, CSRF/origin rejection, viewer read-only behavior, inventory-manager writes, stale `If-Match` returning `409`, user role changes, audit filtering, retention validation, readiness secret redaction, and stable field-error JSON.

```js
test("inventory writes require role, origin, csrf, and current revision", async () => {
  assert.equal((await viewer.patch(unit)).status, 403);
  assert.equal((await editor.patch(unit, { ifMatch: "stale" })).status, 409);
  assert.equal((await readiness()).body.includes(process.env.OPENAI_API_KEY), false);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/auth.test.mjs scripts/inventory.test.mjs scripts/settings.test.mjs`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement auth and routes**

Use `scrypt` from Node crypto for password hashes, random opaque session tokens stored hashed in PostgreSQL, HTTP-only SameSite cookies, explicit Origin validation, and Zod request parsing. Seed the first admin through a one-time CLI command, never a production web fixture. Readiness returns booleans and missing configuration names, never secret values.

- [ ] **Step 4: Verify**

Run the focused tests, then `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth src/http src/server.mjs package.json package-lock.json .env.example scripts/auth.test.mjs scripts/inventory.test.mjs scripts/settings.test.mjs
git commit -m "feat: secure inventory application API"
```

### Task 5: Deterministic matching and immutable fact snapshots

**Files:**
- Create: `src/inventory/matcher.mjs`, `src/inventory/facts.mjs`
- Modify: `src/inventory/catalog.mjs`, `src/inventory/repository.mjs`
- Test: `scripts/matcher.test.mjs`

**Interfaces:**
- Consumes: `RentalRequirements` and published Unit revisions.
- Produces: `matchInventory(requirements, units, policy): MatchResult` and `saveMatchSnapshot(command): MatchSnapshot` with typed `factSnapshot` entries.

- [ ] **Step 1: Write failing matcher tests**

Pin hard filters for publication, availability date, budget, bedrooms, required pet policy, and geography. Pin stable scoring explanations, matcher version, and stale-snapshot rejection after unit revision changes.

```js
test("matcher excludes unavailable facts and snapshots reject revision drift", async () => {
  assert.deepEqual(matchInventory(requirements, units, policy).candidates.map(x => x.unitId), ["unit_ok"]);
  await assert.rejects(authorizeSnapshot(staleSnapshot), /inventory changed/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/matcher.test.mjs`
Expected: FAIL on missing matcher.

- [ ] **Step 3: Implement matcher and snapshot writer**

Make `matchInventory` pure. OpenAI may later reorder only the returned eligible IDs. Persist explicit fact fields, not `Record<string, unknown>`.

- [ ] **Step 4: Verify**

Run matcher and inventory suites. Expected: PASS and deterministic ordering across repeated runs.

- [ ] **Step 5: Commit**

```bash
git add src/inventory scripts/matcher.test.mjs scripts/inventory.test.mjs
git commit -m "feat: add grounded inventory matching"
```

### Task 6: Compose runtime and legacy import

**Files:**
- Create: `docker-compose.yml`, `scripts/import-json-state.mjs`, `scripts/import-json-state.test.mjs`
- Modify: `Dockerfile`, `package.json`, `.env.example`

**Interfaces:**
- Consumes: existing `state/state.json` export and PostgreSQL modules.
- Produces: idempotent `npm run migrate`, `npm run import:legacy`, and Compose services `web`, `worker`, `group-worker`, `postgres`.

- [ ] **Step 1: Write failing import tests**

Assert dry-run counts, one-time import, preserved submitted/unknown outcomes, read-compare output, and refusal to overwrite populated PostgreSQL state.

```js
test("legacy import is one-time and preserves terminal outcomes", async () => {
  assert.equal((await importLegacy(file, { dryRun: true })).writes, 0);
  assert.equal((await importLegacy(file)).unknownDeliveries, 1);
  await assert.rejects(importLegacy(file), /already populated/i);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/import-json-state.test.mjs`
Expected: FAIL on missing importer.

- [ ] **Step 3: Implement import and Compose**

Keep PostgreSQL and browser profile on separate volumes. The browser service receives no database or Meta credentials. Add health checks and named profiles for test fixtures.

- [ ] **Step 4: Verify**

Run: `docker compose config && npm test && npm run build`
Expected: valid Compose, all tests PASS, production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml Dockerfile package.json package-lock.json .env.example scripts/import-json-state.mjs scripts/import-json-state.test.mjs
git commit -m "feat: add production data runtime"
```

