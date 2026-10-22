# Rental Radar Frontend and Production Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved premium responsive interface, converge duplicate flows, remove fixture/legacy production paths, and verify all customer-visible workflows.

**Architecture:** Next.js owns UI composition and a thin typed fetch client. Five destinations consume authoritative resource APIs. Inbox Workspace and Table views share selection, filters, commands, and composer; responsive variants change presentation, not domain behavior.

**Tech Stack:** Next.js 16, React 19, CSS Modules/global tokens, Lucide React icons, Playwright browser tests, axe-core, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-22-rental-radar-production-design.md`

## Global Constraints

- Approved visual target: `design/rental-radar-inbox-approved.png`.
- Primary navigation is exactly Inbox, Properties, Sources, Automations, Settings.
- Workspace and Table are views of one Inbox route.
- One reply composer serves Group and Messenger approval/manual actions.
- No fixture, demo, mock-success, or Browser top-level UI in production.
- No horizontal page overflow at 1440, 1280, 1024, 768, 430, or 390px.
- Minimum touch target is 44px; motion is 150 to 220ms and honors reduced motion.
- Use IBM Plex Sans Thai or Noto Sans Thai and Lucide icons; do not hand-draw replacement icons.

## Review Focus

- Long Thai text, URLs, and unit codes wrap without pushing actions off-screen. Covered in Task 2 and Task 7.
- A partial API failure preserves usable Inbox content and exposes retry near the failed region. Covered in Task 2.
- Back/forward restores route, view, filters, and selected work item. Covered in Task 1.
- Keyboard focus remains visible when drawers and mobile drill-down states open. Covered in Task 7.
- Stale inventory or delivery state disables approval and explains the required refresh. Covered in Task 2.

---

## File structure

```text
app/components/app-shell.jsx             five-destination responsive shell
app/components/icons.jsx                 Lucide wrapper and accessible labels
app/lib/api-client.mjs                    typed resource fetch and error mapping
app/lib/routes.mjs                        one route manifest and URL state
app/inbox/page.jsx                        Inbox route composition
app/inbox/inbox-queue.jsx                 queue and table view
app/inbox/conversation-pane.jsx           Group post/comments or Messenger timeline
app/inbox/lead-inspector.jsx              requirements and grounded unit rows
app/inbox/reply-composer.jsx               one approval/manual composer
app/properties/page.jsx                   Project and Unit management
app/properties/unit-editor.jsx            full-height CRUD drawer
app/sources/page.jsx                      Page and Group health/recovery
app/automations/page.jsx                  policies, formats, preview, kill switch
app/settings/page.jsx                     users, business profile, audit, retention
app/styles/tokens.css                     colors, type, spacing, motion
app/styles/layout.css                     shell and breakpoint behavior
tests/e2e/*.spec.mjs                      workflow and responsive browser tests
```

### Task 1: Design tokens, route manifest, and application shell

**Files:**
- Create: `app/components/app-shell.jsx`, `app/components/icons.jsx`, `app/lib/api-client.mjs`, `app/lib/routes.mjs`, `app/styles/tokens.css`, `app/styles/layout.css`
- Modify: `app/layout.jsx`, `app/page.jsx`, `app/globals.css`, `package.json`
- Test: `scripts/frontend-shell.test.mjs`

**Interfaces:**
- Consumes: authenticated `/api/me` and system health summary.
- Produces: `AppShell`, `routes`, `navigate(routeState)`, and `api.request(resource, options)`.

- [ ] **Step 1: Write failing shell tests**

Assert exactly five navigation entries, URL/popstate restoration, active route semantics, mobile navigation labels, safe API error mapping, and no old navigation labels.

```js
test("shell exposes one five-destination route manifest", () => {
  assert.deepEqual(routes.map(x => x.id), ["inbox", "properties", "sources", "automations", "settings"]);
  assert.equal(routes.some(x => /Overview|Messenger|Browser/.test(x.label)), false);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test scripts/frontend-shell.test.mjs`
Expected: FAIL against the current eight-item shell.

- [ ] **Step 3: Implement shell and tokens**

Add `lucide-react` and a Thai-capable local font dependency. Use warm neutral surfaces, fine dividers, restrained indigo, and no page-wide card container.

- [ ] **Step 4: Verify**

Run focused test and `npm run build`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app package.json package-lock.json scripts/frontend-shell.test.mjs
git commit -m "feat: add rental radar application shell"
```

### Task 2: Inbox Workspace view and one composer

**Files:**
- Create: `app/inbox/page.jsx`, `app/inbox/inbox-queue.jsx`, `app/inbox/conversation-pane.jsx`, `app/inbox/lead-inspector.jsx`, `app/inbox/reply-composer.jsx`
- Test: `tests/e2e/inbox-workspace.spec.mjs`

**Interfaces:**
- Consumes: Inbox list/detail/prepare/approve/handoff APIs and SSE receipts.
- Produces: one selected-work-item state shared by queue, conversation, inspector, and composer.

- [ ] **Step 1: Write failing Workspace E2E**

Assert Group post/comment rendering, Messenger rendering, requirements, current unit facts, approval, human handoff, stale-state block, regional retry, and exact reply persistence.

```js
test("one workspace renders context, grounded matches, and one composer", async ({ page }) => {
  await page.goto("/inbox?item=group_1");
  await expect(page.getByText("โพสต์จากกลุ่ม")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
});
```

- [ ] **Step 2: Run test**

Run: `npx playwright test tests/e2e/inbox-workspace.spec.mjs --project=desktop`
Expected: FAIL because the route does not exist.

- [ ] **Step 3: Implement Workspace view**

Use queue rows, a fluid conversation surface, a collapsible 340px inspector, and one sticky composer. Do not duplicate Group and Messenger composers.

- [ ] **Step 4: Verify**

Run the desktop E2E and capture screenshot at 1440x1024. Expected: PASS with no clipping.

- [ ] **Step 5: Commit**

```bash
git add app/inbox tests/e2e/inbox-workspace.spec.mjs
git commit -m "feat: build unified inbox workspace"
```

### Task 3: Inbox Table view and shared URL state

**Files:**
- Modify: `app/inbox/page.jsx`, `app/inbox/inbox-queue.jsx`, `app/lib/routes.mjs`
- Create: `app/inbox/focus-sheet.jsx`
- Test: `tests/e2e/inbox-table.spec.mjs`

**Interfaces:**
- Consumes: same Inbox state and commands as Task 2.
- Produces: `view=workspace|table`, saved filters in URL, and a focus sheet reusing detail/composer components.

- [ ] **Step 1: Write failing Table E2E**

Assert view switch, stable scroll position, keyboard row open, filter persistence through back/forward, focus-sheet close, and no second composer implementation.

```js
test("table and workspace share URL state and reply workflow", async ({ page }) => {
  await page.goto("/inbox?view=table&state=needs_review");
  await page.getByRole("row", { name: /Mint/ }).press("Enter");
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeVisible();
});
```

- [ ] **Step 2: Run test**

Run: `npx playwright test tests/e2e/inbox-table.spec.mjs --project=desktop`
Expected: FAIL on missing Table view.

- [ ] **Step 3: Implement Table view**

Use semantic table behavior at desktop and row-list fallback below tablet width. The focus sheet composes existing detail components.

- [ ] **Step 4: Verify**

Run Workspace and Table E2E. Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add app/inbox app/lib/routes.mjs tests/e2e/inbox-table.spec.mjs
git commit -m "feat: add high-volume inbox triage view"
```

### Task 4: Properties CRUD

**Files:**
- Create: `app/properties/page.jsx`, `app/properties/project-list.jsx`, `app/properties/unit-table.jsx`, `app/properties/unit-editor.jsx`
- Test: `tests/e2e/properties.spec.mjs`

**Interfaces:**
- Consumes: Project and Unit APIs.
- Produces: project hierarchy, unit filters, create/edit drawer, publish, availability, and archive UI.

- [ ] **Step 1: Write failing Properties E2E**

Create a Thai project and unit, validate incomplete publication, publish, change availability, detect stale edit, archive, and confirm historic row remains discoverable.

```js
test("inventory staff can publish and archive a valid unit", async ({ page }) => {
  await createUnit(page, { project: "ไลฟ์ อโศก", rent: 18000 });
  await page.getByRole("button", { name: "บันทึกและเผยแพร่" }).click();
  await expect(page.getByText("เผยแพร่แล้ว")).toBeVisible();
});
```

- [ ] **Step 2: Run test**

Run: `npx playwright test tests/e2e/properties.spec.mjs --project=desktop`
Expected: FAIL on missing Properties route.

- [ ] **Step 3: Implement Properties**

Use a grouped table on desktop and cards only as the deliberate mobile alternative. The editor is a full-height drawer with unsaved-change protection.

- [ ] **Step 4: Verify**

Run Properties E2E at desktop and mobile. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/properties tests/e2e/properties.spec.mjs
git commit -m "feat: add property inventory workspace"
```

### Task 5: Sources and Automations

**Files:**
- Create: `app/sources/page.jsx`, `app/sources/source-row.jsx`, `app/sources/browser-recovery.jsx`, `app/automations/page.jsx`, `app/automations/policy-editor.jsx`, `app/automations/policy-preview.jsx`
- Test: `tests/e2e/sources-automations.spec.mjs`

**Interfaces:**
- Consumes: Sources, source health, scan receipt, recovery, policy, preview, and pause APIs.
- Produces: Page status, multi-Group controls, per-source mode, live operation preview, policy explanation, and kill switches.

- [ ] **Step 1: Write failing Sources/Automations E2E**

Add a canonical Group, reject invalid URLs, request scan, show partial/auth-required states, switch mode, prove preview parity, pause globally, and restrict recovery to admin.

```js
test("source mode and policy preview explain actual behavior", async ({ page }) => {
  await page.goto("/sources");
  await page.getByRole("button", { name: "Approval" }).click();
  await expect(page.getByText("จะไม่ส่งข้อความอัตโนมัติ")).toBeVisible();
});
```

- [ ] **Step 2: Run test**

Run: `npx playwright test tests/e2e/sources-automations.spec.mjs --project=desktop`
Expected: FAIL on missing routes.

- [ ] **Step 3: Implement both destinations**

Keep browser recovery inside Sources. Show persistent operation receipts and policy reasons; do not duplicate automation toggles elsewhere.

- [ ] **Step 4: Verify**

Run focused E2E at desktop and tablet. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/sources app/automations tests/e2e/sources-automations.spec.mjs
git commit -m "feat: add source and automation operations"
```

### Task 6: Settings, audit, and readiness

**Files:**
- Create: `app/settings/page.jsx`, `app/settings/users-panel.jsx`, `app/settings/business-profile.jsx`, `app/settings/audit-view.jsx`, `app/settings/readiness.jsx`
- Test: `tests/e2e/settings.spec.mjs`

**Interfaces:**
- Consumes: user, role, business profile, retention, readiness, and audit APIs.
- Produces: Settings workflows without exposing secret values.

- [ ] **Step 1: Write failing Settings E2E**

Assert role visibility, business-profile update, audit correlation search, retention validation, and readiness showing configured/missing without token contents.

```js
test("settings reports readiness without revealing secrets", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("OpenAI configured")).toBeVisible();
  await expect(page.getByText(/sk-proj-/)).toHaveCount(0);
});
```

- [ ] **Step 2: Run test**

Run: `npx playwright test tests/e2e/settings.spec.mjs --project=desktop`
Expected: FAIL on missing Settings implementation.

- [ ] **Step 3: Implement Settings**

Activity history is contextual in Inbox; global audit search belongs here. Secrets may be replaced through deployment configuration but never read back.

- [ ] **Step 4: Verify**

Run focused E2E. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/settings tests/e2e/settings.spec.mjs
git commit -m "feat: add secure administration settings"
```

### Task 7: Responsive, accessibility, and visual comparison

**Files:**
- Modify: `app/styles/layout.css`, all new route components
- Create: `tests/e2e/responsive-accessibility.spec.mjs`, `scripts/visual-compare.mjs`
- Test: `tests/e2e/responsive-accessibility.spec.mjs`

**Interfaces:**
- Consumes: all five destinations and approved visual target.
- Produces: verified layouts at 1440, 1280, 1024, 768, 430, and 390px.

- [ ] **Step 1: Write failing responsive checks**

Assert document width equals viewport width, long Thai/English fixture strings remain visible, all actions are reachable, focus is trapped/restored in drawers, 44px targets, semantic labels, reduced motion, and axe has no serious/critical findings.

```js
test("supported viewports do not overflow", async ({ page }) => {
  for (const width of [1440, 1280, 1024, 768, 430, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
});
```

- [ ] **Step 2: Run checks**

Run: `npx playwright test tests/e2e/responsive-accessibility.spec.mjs`
Expected: FAIL until every breakpoint is implemented.

- [ ] **Step 3: Implement responsive states and motion**

Use explicit drill-down mobile states and sticky action bars. Compare the 1440x1024 implementation screenshot beside `design/rental-radar-inbox-approved.png`; fix hierarchy, spacing, type, and clipping rather than copying generated text defects.

- [ ] **Step 4: Verify**

Run responsive suite and `node scripts/visual-compare.mjs`. Expected: all assertions PASS and comparison artifact contains both full screens.

- [ ] **Step 5: Commit**

```bash
git add app tests/e2e/responsive-accessibility.spec.mjs scripts/visual-compare.mjs
git commit -m "fix: polish responsive and accessible workflows"
```

### Task 8: Production cutover and legacy deletion

**Files:**
- Delete: `app/components/command-center.jsx`, `app/components/group-review.jsx`, `app/components/messenger-inbox.jsx`, `app/components/reply-settings.jsx`, `src/demo.mjs`, `src/messenger-fixture.mjs`
- Modify: `app/page.jsx`, `src/server.mjs`, `Dockerfile`, `package.json`, verification scripts
- Move: fixture-only providers into `tests/fixtures/`
- Test: `scripts/production-boundary.test.mjs`, full E2E suite

**Interfaces:**
- Consumes: all replacement routes and APIs.
- Produces: one production UI and API surface with no legacy writable path.

- [ ] **Step 1: Write failing production-boundary test**

Assert production bundle and route manifest contain no `/api/state`, `/api/group`, `/api/scan`, `/api/demo`, `/fixture`, `Load customer demo`, old eight-item navigation, or direct UI imports of provider adapters.

```js
test("production graph contains no POC or fixture surface", async () => {
  const graph = await productionImportGraph();
  for (const forbidden of ["/api/state", "/api/demo", "/fixture", "src/demo.mjs"]) assert.equal(graph.includes(forbidden), false);
});
```

- [ ] **Step 2: Run test**

Run: `NODE_ENV=production node --test scripts/production-boundary.test.mjs`
Expected: FAIL while legacy paths remain.

- [ ] **Step 3: Migrate callers and delete legacy paths**

Remove compatibility routes only after all E2E tests use replacements. Keep fake providers under tests and a separate Compose profile excluded from the production image.

- [ ] **Step 4: Verify full release candidate**

Run: `npm test && npm run build && npx playwright test && docker compose config`
Expected: all PASS, production image builds, no legacy boundary violation.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: complete rental radar production cutover"
```

