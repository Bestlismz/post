import { expect, test } from "@playwright/test";
import { evaluateSourceDecision } from "../../src/policy/source-decision.mjs";

const evaluationTime = new Date("2026-10-22T03:00:00.000Z");

test("fixture server exposes seeded Sources and Automations without intercepted APIs", async ({ page, request }) => {
  const sourcesResponse = await request.get("/api/sources");
  expect(sourcesResponse.status()).toBe(200);
  const sources = await sourcesResponse.json();
  expect(sources.actorRole).toBe("admin");
  expect(sources.pages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "61595791349401", name: "BestRedar", health: "connected" }),
  ]));
  expect(sources.groups).toHaveLength(2);
  expect(new Set(sources.groups.map((source) => source.mode))).toEqual(new Set(["observe", "automatic"]));
  expect(sources.groups).toEqual(expect.arrayContaining([
    expect.objectContaining({
      health: expect.objectContaining({ session: "healthy", selector: "healthy" }),
      latestReceipt: expect.objectContaining({ coverage: "complete", health: "healthy" }),
    }),
    expect.objectContaining({
      displayName: "test autopost",
      accessLevel: "reader",
      health: expect.objectContaining({ session: "healthy", selector: "failed", selectorCircuit: true }),
      latestReceipt: expect.objectContaining({ coverage: "none", health: "selector_failure" }),
    }),
  ]));

  const automationResponse = await request.get("/api/automation");
  expect(automationResponse.status()).toBe(200);
  const automation = await automationResponse.json();
  expect(automation.sources).toHaveLength(2);
  expect(automation.sources.every((source) => source.previewContexts.length > 0)).toBeTruthy();
  expect(automation.replyFormat.value).toEqual(expect.objectContaining({ locale: "th", tone: "friendly" }));

  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "แหล่งข้อมูล Facebook" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Facebook Page" }).getByText("BestRedar")).toBeVisible();
  await expect(page.locator(".source-row")).toHaveCount(2);
  await expect(page.getByText("สแกนครบแล้ว")).toBeVisible();
  await expect(page.getByText("สแกนไม่สำเร็จ")).toBeVisible();
  await expect(page.getByText("autopost", { exact: true })).toBeVisible();
  await expect(page.getByText("test autopost", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ตรวจใหม่" }).click();
  await expect(page.getByRole("status")).toContainText("อัปเดตสถานะ Facebook Page แล้ว");

  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "กติกาอัตโนมัติ" })).toBeVisible();
  await expect(page.locator(".automation-source-row")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Policy preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ทดสอบกติกา" })).toBeEnabled();
});

test("fixture mutations preserve canonical URLs, revisions, idempotency, scan receipts, and automation controls", async ({ request }) => {
  const csrfResponse = await request.post("/api/auth/csrf");
  const { csrfToken } = await csrfResponse.json();
  const headers = (key, revision) => ({
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    ...(revision == null ? {} : { "If-Match": `"${revision}"` }),
  });

  const rejected = await request.post("/api/sources/groups", {
    data: { url: "https://www.facebook.com/groups/999000111" },
    headers: { "Idempotency-Key": "missing-csrf" },
  });
  expect(rejected.status()).toBe(403);

  const add = await request.post("/api/sources/groups", {
    data: { url: "https://m.facebook.com/groups/999000111/?ref=share" },
    headers: headers("add-999"),
  });
  expect(add.status()).toBe(201);
  const created = await add.json();
  expect(created).toEqual(expect.objectContaining({
    canonicalUrl: "https://www.facebook.com/groups/999000111",
    created: true,
    mode: "observe",
    revision: 1,
  }));
  const replay = await request.post("/api/sources/groups", {
    data: { url: "https://m.facebook.com/groups/999000111/?ref=share" },
    headers: headers("add-999"),
  });
  expect(await replay.json()).toEqual(created);
  const duplicate = await request.post("/api/sources/groups", {
    data: { url: "https://www.facebook.com/groups/999000111" },
    headers: headers("add-999-duplicate"),
  });
  expect(duplicate.status()).toBe(200);
  expect(await duplicate.json()).toEqual(expect.objectContaining({ id: created.id, created: false }));
  const reusedKey = await request.post("/api/sources/groups", {
    data: { url: "https://www.facebook.com/groups/999000222" },
    headers: headers("add-999"),
  });
  expect(reusedKey.status()).toBe(409);

  const staleMode = await request.patch(`/api/sources/groups/${created.id}`, {
    data: { mode: "approval" },
    headers: headers("mode-stale", 99),
  });
  expect(staleMode.status()).toBe(409);
  const mode = await request.patch(`/api/sources/groups/${created.id}`, {
    data: { mode: "approval" },
    headers: headers("mode-approval", 1),
  });
  expect(await mode.json()).toEqual(expect.objectContaining({ mode: "approval", revision: 2 }));

  const scan = await request.post(`/api/sources/groups/${created.id}/scans`, {
    data: {},
    headers: headers("scan-999", 2),
  });
  expect(scan.status()).toBe(202);
  const queued = await scan.json();
  expect(queued).toEqual(expect.objectContaining({ state: "queued" }));
  await expect.poll(async () => {
    const state = await (await request.get("/api/sources")).json();
    return state.groups.find((source) => source.id === created.id)?.latestOperation?.state;
  }).toBe("completed");
  const scannedSources = await (await request.get("/api/sources")).json();
  expect(scannedSources.groups.find((source) => source.id === created.id)?.latestReceipt).toEqual(expect.objectContaining({
    operationId: queued.operationId,
    coverage: "complete",
    health: "healthy",
  }));
  const projectedInbox = await (await request.get("/api/inbox?search=%E0%B8%AA%E0%B8%99%E0%B9%83%E0%B8%88%E0%B8%AB%E0%B9%89%E0%B8%AD%E0%B8%87%E0%B9%80%E0%B8%8A%E0%B9%88%E0%B8%B2%E0%B9%83%E0%B8%81%E0%B8%A5%E0%B9%89%E0%B8%A3%E0%B8%96%E0%B9%84%E0%B8%9F%E0%B8%9F%E0%B9%89%E0%B8%B2")).json();
  expect(projectedInbox.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      channel: "facebook_group",
      source: expect.objectContaining({ name: created.canonicalUrl }),
      message: expect.objectContaining({ text: expect.stringContaining("18,000") }),
    }),
  ]));

  const health = await request.get(`/api/sources/${created.id}/browser-health`);
  expect(await health.json()).toEqual(expect.objectContaining({
    sourceId: created.id,
    browser: expect.objectContaining({ ok: true }),
  }));
  const recovery = await request.post(`/api/sources/${created.id}/recovery`, {
    data: { ttlSeconds: 300 },
    headers: headers("recover-999"),
  });
  expect(recovery.status()).toBe(201);
  expect(await recovery.json()).toEqual(expect.objectContaining({
    sourceId: created.id,
    tunnelUrl: expect.stringContaining(`/api/sources/${created.id}/recovery/`),
  }));

  const automationBefore = await (await request.get("/api/automation")).json();
  const preview = await request.post("/api/automation/policy-preview", {
    data: {
      sourceId: automationBefore.sources[0].id,
      conversationId: automationBefore.sources[0].previewContexts[0].id,
      sample: { grounded: true, automaticEligible: true, confidence: 0.7, replyWindowOpen: true },
    },
  });
  expect(await preview.json()).toEqual(expect.objectContaining({ action: "review", reasons: expect.arrayContaining(["confidence"]) }));

  const pause = await request.post("/api/automation/pause", {
    data: { paused: true },
    headers: headers("global-pause"),
  });
  expect(await pause.json()).toEqual(expect.objectContaining({ paused: true, reasonCode: "GLOBAL_PAUSED" }));
  const pauseReplay = await request.post("/api/automation/pause", {
    data: { paused: true },
    headers: headers("global-pause"),
  });
  expect(await pauseReplay.json()).toEqual(await pause.json());

  const policy = { ...automationBefore.policy.value, minimumConfidence: 0.9 };
  const savedPolicy = await request.put("/api/automation/policy", {
    data: policy,
    headers: headers("policy-2", automationBefore.policy.revision),
  });
  expect(await savedPolicy.json()).toEqual({ value: policy, revision: automationBefore.policy.revision + 1 });
  const stalePolicy = await request.put("/api/automation/policy", {
    data: policy,
    headers: headers("policy-stale", automationBefore.policy.revision),
  });
  expect(stalePolicy.status()).toBe(409);

  const replyFormat = { ...automationBefore.replyFormat.value, greetingId: "none" };
  const savedFormat = await request.put("/api/automation/reply-format", {
    data: replyFormat,
    headers: headers("format-2", automationBefore.replyFormat.revision),
  });
  expect(await savedFormat.json()).toEqual({ value: replyFormat, revision: automationBefore.replyFormat.revision + 1 });

  const scheduledSource = automationBefore.sources[0];
  const schedule = { ...scheduledSource.schedule, cadenceMinutes: 30 };
  delete schedule.revision;
  const savedSchedule = await request.put(`/api/automation/sources/${scheduledSource.id}/schedule`, {
    data: schedule,
    headers: headers("schedule-2", scheduledSource.schedule.revision),
  });
  expect(await savedSchedule.json()).toEqual({ sourceId: scheduledSource.id, schedule, revision: scheduledSource.schedule.revision + 1 });

  const automationAfter = await (await request.get("/api/automation")).json();
  expect(automationAfter.paused).toBeTruthy();
  expect(automationAfter.receipts[0]).toEqual(expect.objectContaining({ reasonCode: "GLOBAL_PAUSED" }));
  expect(automationAfter.policy.revision).toBe(automationBefore.policy.revision + 1);
  expect(automationAfter.replyFormat.revision).toBe(automationBefore.replyFormat.revision + 1);

  await request.post("/api/automation/pause", {
    data: { paused: false },
    headers: headers("global-resume"),
  });
});

test("fixture policy preview is the production source evaluator for authorize and refusal paths", async ({ request }) => {
  const automation = await (await request.get("/api/automation")).json();
  const sourceState = await (await request.get("/api/sources")).json();
  const automatic = automation.sources.find((source) => source.mode === "automatic");
  const observe = automation.sources.find((source) => source.mode === "observe" && source.health.selectorCircuit);
  expect(automatic).toBeTruthy();
  expect(observe).toBeTruthy();

  const sample = { grounded: true, automaticEligible: true, confidence: 0.95, replyWindowOpen: true, optOut: false, humanTakeover: false };
  const productionSource = (source) => {
    const state = sourceState.groups.find((entry) => entry.id === source.id);
    return ({
    mode: source.mode,
    policy: source.policy,
    kill_switch: source.paused,
    archived: false,
    allow_listed: state.allowListed,
    session_health: source.health.session,
    selector_health: source.health.selector,
    session_circuit: source.health.sessionCircuit,
    selector_circuit: source.health.selectorCircuit,
    });
  };
  const preview = async (source, conversationId, context = sample) => {
    const response = await request.post("/api/automation/policy-preview", { data: { sourceId: source.id, conversationId, sample: context } });
    expect(response.status()).toBe(200);
    return response.json();
  };

  const cleanConversation = automatic.previewContexts.find((context) => !context.id.endsWith("-busy"));
  const eligible = await preview(automatic, cleanConversation.id);
  const expectedEligible = evaluateSourceDecision({
    organizationPaused: false,
    organizationPolicy: automation.policy.value,
    source: productionSource(automatic),
    context: { ...sample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: eligible.action, reasons: eligible.reasons, effectivePolicy: eligible.effectivePolicy }).toEqual(expectedEligible);
  expect(eligible.evaluatedAt).toBe(evaluationTime.toISOString());

  const refusedSample = { ...sample, confidence: 0.4, optOut: true, humanTakeover: true };
  const refused = await preview(automatic, cleanConversation.id, refusedSample);
  const expectedRefused = evaluateSourceDecision({
    organizationPaused: false,
    organizationPolicy: automation.policy.value,
    source: productionSource(automatic),
    context: { ...refusedSample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: refused.action, reasons: refused.reasons, effectivePolicy: refused.effectivePolicy }).toEqual(expectedRefused);
  expect(refused.reasons).toEqual(expect.arrayContaining(["confidence", "opt_out", "human_takeover"]));

  const busyConversation = automatic.previewContexts.find((context) => context.id.endsWith("-busy"));
  expect(busyConversation).toBeTruthy();
  const rateLimited = await preview(automatic, busyConversation.id);
  expect(rateLimited.reasons).toEqual(expect.arrayContaining(["source_rate_limit", "conversation_rate_limit"]));

  const observed = await preview(observe, observe.previewContexts[0].id);
  const expectedObserved = evaluateSourceDecision({
    organizationPaused: false,
    organizationPolicy: automation.policy.value,
    source: productionSource(observe),
    context: { ...sample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: observed.action, reasons: observed.reasons, effectivePolicy: observed.effectivePolicy }).toEqual(expectedObserved);
  expect(observed.reasons).toEqual(expect.arrayContaining(["observe_mode", "source_selector_unhealthy", "selector_circuit_open"]));

  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const headers = (key, revision) => ({
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    ...(revision == null ? {} : { "If-Match": `"${revision}"` }),
  });
  const sourcePause = await request.post(`/api/automation/sources/${automatic.id}/pause`, { data: { paused: true }, headers: headers("preview-source-pause") });
  expect(sourcePause.status()).toBe(200);
  const pausedAutomatic = { ...automatic, paused: true };
  const pausedPreview = await preview(pausedAutomatic, cleanConversation.id);
  const expectedPaused = evaluateSourceDecision({
    organizationPaused: false,
    organizationPolicy: automation.policy.value,
    source: productionSource(pausedAutomatic),
    context: { ...sample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: pausedPreview.action, reasons: pausedPreview.reasons, effectivePolicy: pausedPreview.effectivePolicy }).toEqual(expectedPaused);
  expect(pausedPreview.reasons).toContain("source_pause");
  await request.post(`/api/automation/sources/${automatic.id}/pause`, { data: { paused: false }, headers: headers("preview-source-resume") });

  await request.post("/api/automation/pause", { data: { paused: true }, headers: headers("preview-global-pause") });
  const globallyPaused = await preview(automatic, cleanConversation.id);
  const expectedGlobalPause = evaluateSourceDecision({
    organizationPaused: true,
    organizationPolicy: automation.policy.value,
    source: productionSource(automatic),
    context: { ...sample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: globallyPaused.action, reasons: globallyPaused.reasons, effectivePolicy: globallyPaused.effectivePolicy }).toEqual(expectedGlobalPause);
  expect(globallyPaused.reasons).toContain("global_pause");
  await request.post("/api/automation/pause", { data: { paused: false }, headers: headers("preview-global-resume") });

  const observeState = sourceState.groups.find((source) => source.id === observe.id);
  const outsidePolicy = { ...observe.policy, businessHours: { ...observe.policy.businessHours, days: [5] } };
  const changedSource = await request.patch(`/api/sources/groups/${observe.id}`, {
    data: { mode: "approval", allowListed: false, policy: outsidePolicy },
    headers: headers("preview-source-override", observeState.revision),
  });
  expect(changedSource.status()).toBe(200);
  const changedState = await changedSource.json();
  const changedAutomation = (await (await request.get("/api/automation")).json()).sources.find((source) => source.id === observe.id);
  const overridden = await preview(changedAutomation, changedAutomation.previewContexts[0].id);
  const expectedOverride = evaluateSourceDecision({
    organizationPaused: false,
    organizationPolicy: automation.policy.value,
    source: {
      ...productionSource(changedAutomation),
      allow_listed: false,
    },
    context: { ...sample, counts: { organization: 3, source: 0, conversation: 0 } },
    now: evaluationTime,
  });
  expect({ action: overridden.action, reasons: overridden.reasons, effectivePolicy: overridden.effectivePolicy }).toEqual(expectedOverride);
  expect(overridden.reasons).toEqual(expect.arrayContaining(["source_not_allowlisted", "business_hours", "approval_required"]));
  const restoredSource = await request.patch(`/api/sources/groups/${observe.id}`, {
    data: { mode: "observe", allowListed: true, policy: observe.policy },
    headers: headers("preview-source-restore", changedState.revision),
  });
  expect(restoredSource.status()).toBe(200);
});

test("fixture rejects invalid automation policy, reply format, and schedule without changing revisions", async ({ request }) => {
  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const before = await (await request.get("/api/automation")).json();
  const headers = (key, revision) => ({ "X-CSRF-Token": csrfToken, "Idempotency-Key": key, "If-Match": `"${revision}"` });

  const invalidPolicy = await request.put("/api/automation/policy", {
    data: { ...before.policy.value, mode: "launch", minimumConfidence: 2 },
    headers: headers("invalid-policy", before.policy.revision),
  });
  expect(invalidPolicy.status()).toBe(422);

  const invalidPolicyTimeZone = await request.put("/api/automation/policy", {
    data: { ...before.policy.value, businessHours: { ...before.policy.value.businessHours, timeZone: "Mars/Olympus" } },
    headers: headers("invalid-policy-timezone", before.policy.revision),
  });
  expect(invalidPolicyTimeZone.status()).toBe(422);

  const invalidFormat = await request.put("/api/automation/reply-format", {
    data: { ...before.replyFormat.value, locale: "jp", unexpected: true },
    headers: headers("invalid-format", before.replyFormat.revision),
  });
  expect(invalidFormat.status()).toBe(422);

  const source = before.sources[0];
  const invalidSchedule = await request.put(`/api/automation/sources/${source.id}/schedule`, {
    data: { ...source.schedule, revision: undefined, cadenceMinutes: 0, timeZone: "Mars/Olympus" },
    headers: headers("invalid-schedule", source.schedule.revision),
  });
  expect(invalidSchedule.status()).toBe(422);

  const after = await (await request.get("/api/automation")).json();
  expect(after.policy.revision).toBe(before.policy.revision);
  expect(after.replyFormat.revision).toBe(before.replyFormat.revision);
  expect(after.sources.find((entry) => entry.id === source.id).schedule).toEqual(source.schedule);
});

test("fixture role identity enforces production read, scan, recovery, and automation boundaries", async ({ request }) => {
  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const roleHeaders = (role, key, revision) => ({
    "X-Fixture-Role": role,
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    ...(revision == null ? {} : { "If-Match": `"${revision}"` }),
  });
  const viewerSources = await request.get("/api/sources", { headers: { "X-Fixture-Role": "viewer" } });
  const viewerState = await viewerSources.json();
  expect(viewerState.actorRole).toBe("viewer");
  const source = viewerState.groups[0];

  const viewerRecovery = await request.post(`/api/sources/${source.id}/recovery`, {
    data: { ttlSeconds: 300 },
    headers: roleHeaders("viewer", "viewer-recovery"),
  });
  expect(viewerRecovery.status()).toBe(403);

  const operatorPause = await request.post("/api/automation/pause", {
    data: { paused: true },
    headers: roleHeaders("operator", "operator-pause"),
  });
  expect(operatorPause.status()).toBe(403);

  const operatorScan = await request.post(`/api/sources/groups/${source.id}/scans`, {
    data: {},
    headers: roleHeaders("operator", "operator-scan", source.revision),
  });
  expect(operatorScan.status()).toBe(202);

  const viewerScan = await request.post(`/api/sources/groups/${source.id}/scans`, {
    data: {},
    headers: roleHeaders("viewer", "viewer-scan", source.revision),
  });
  expect(viewerScan.status()).toBe(403);
});

test("fixture scan gates refuse paused and circuit-open work without replacing evidence", async ({ request }) => {
  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const headers = (key, revision) => ({
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    ...(revision == null ? {} : { "If-Match": `"${revision}"` }),
  });
  const initial = await (await request.get("/api/sources")).json();
  const healthy = initial.groups.find((source) => source.mode === "automatic");
  const circuit = initial.groups.find((source) => source.health.selectorCircuit);
  const priorHealthyOperation = healthy.latestOperation;
  const priorHealthyReceipt = healthy.latestReceipt;
  const priorCircuitOperation = circuit.latestOperation;
  const priorCircuitReceipt = circuit.latestReceipt;

  await request.post("/api/automation/pause", { data: { paused: true }, headers: headers("gate-global-pause") });
  const globalBlocked = await request.post(`/api/sources/groups/${healthy.id}/scans`, { data: {}, headers: headers("gate-global-scan", healthy.revision) });
  expect(globalBlocked.status()).toBe(409);
  expect(await globalBlocked.json()).toEqual(expect.objectContaining({ error: "Source automation is paused", reasonCode: "GLOBAL_PAUSED" }));
  let after = await (await request.get("/api/sources")).json();
  expect(after.groups.find((source) => source.id === healthy.id)).toEqual(expect.objectContaining({ latestOperation: priorHealthyOperation, latestReceipt: priorHealthyReceipt }));
  await request.post("/api/automation/pause", { data: { paused: false }, headers: headers("gate-global-resume") });

  const pause = await request.post(`/api/automation/sources/${healthy.id}/pause`, { data: { paused: true }, headers: headers("gate-source-pause") });
  const paused = await pause.json();
  const sourceBlocked = await request.post(`/api/sources/groups/${healthy.id}/scans`, { data: {}, headers: headers("gate-source-scan", paused.revision) });
  expect(sourceBlocked.status()).toBe(409);
  expect(await sourceBlocked.json()).toEqual(expect.objectContaining({ error: "Source automation is paused", reasonCode: "SOURCE_PAUSED" }));
  const resume = await request.post(`/api/automation/sources/${healthy.id}/pause`, { data: { paused: false }, headers: headers("gate-source-resume") });
  expect(resume.status()).toBe(200);

  const circuitBlocked = await request.post(`/api/sources/groups/${circuit.id}/scans`, { data: {}, headers: headers("gate-circuit-scan", circuit.revision) });
  expect(circuitBlocked.status()).toBe(409);
  expect(await circuitBlocked.json()).toEqual(expect.objectContaining({ error: "Source circuit requires explicit recovery", reasonCode: "SELECTOR_CIRCUIT_OPEN" }));
  after = await (await request.get("/api/sources")).json();
  expect(after.groups.find((source) => source.id === circuit.id)).toEqual(expect.objectContaining({ latestOperation: priorCircuitOperation, latestReceipt: priorCircuitReceipt }));

  const recovery = await request.post(`/api/sources/groups/${circuit.id}/scans`, { data: { recovery: true }, headers: headers("gate-circuit-recovery", circuit.revision) });
  expect(recovery.status()).toBe(202);
  const queued = await recovery.json();
  await expect.poll(async () => {
    const state = await (await request.get("/api/sources")).json();
    return state.groups.find((source) => source.id === circuit.id)?.latestOperation?.state;
  }).toBe("completed");
  after = await (await request.get("/api/sources")).json();
  expect(after.groups.find((source) => source.id === circuit.id)?.latestReceipt).toEqual(expect.objectContaining({ operationId: queued.operationId, coverage: "partial", health: "selector_failure" }));
});

test("fixture operational clock advances scan evidence and expires recovery independently from policy time", async ({ request }) => {
  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const headers = (key, revision) => ({
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    ...(revision == null ? {} : { "If-Match": `"${revision}"` }),
  });
  const before = await (await request.get("/api/sources")).json();
  const source = before.groups.find((entry) => entry.mode === "automatic");
  const priorEvidenceAt = Date.parse(source.latestReceipt.createdAt);

  const first = await request.post(`/api/sources/groups/${source.id}/scans`, {
    data: {},
    headers: headers("clock-scan-first", source.revision),
  });
  expect(first.status()).toBe(202);
  const firstOperation = await first.json();
  await expect.poll(async () => {
    const state = await (await request.get("/api/sources")).json();
    return state.groups.find((entry) => entry.id === source.id)?.latestReceipt?.operationId;
  }).toBe(firstOperation.operationId);
  const afterFirst = (await (await request.get("/api/sources")).json()).groups.find((entry) => entry.id === source.id);
  expect(Date.parse(afterFirst.latestOperation.createdAt)).toBeGreaterThan(priorEvidenceAt);
  expect(Date.parse(afterFirst.latestReceipt.createdAt)).toBeGreaterThanOrEqual(Date.parse(afterFirst.latestOperation.createdAt));

  const second = await request.post(`/api/sources/groups/${source.id}/scans`, {
    data: {},
    headers: headers("clock-scan-second", source.revision),
  });
  expect(second.status()).toBe(202);
  const secondOperation = await second.json();
  await expect.poll(async () => {
    const state = await (await request.get("/api/sources")).json();
    return state.groups.find((entry) => entry.id === source.id)?.latestReceipt?.operationId;
  }).toBe(secondOperation.operationId);
  const afterSecond = (await (await request.get("/api/sources")).json()).groups.find((entry) => entry.id === source.id);
  expect(Date.parse(afterSecond.latestOperation.createdAt)).toBeGreaterThan(Date.parse(afterFirst.latestOperation.createdAt));
  expect(Date.parse(afterSecond.latestReceipt.createdAt)).toBeGreaterThan(Date.parse(afterFirst.latestReceipt.createdAt));

  const recovery = await request.post(`/api/sources/${source.id}/recovery`, {
    data: { ttlSeconds: 30 },
    headers: headers("clock-recovery"),
  });
  expect(recovery.status()).toBe(201);
  const session = await recovery.json();
  const expired = await request.get(session.tunnelUrl);
  expect(expired.status()).toBe(404);
  const alreadyCleaned = await request.delete(`/api/sources/${source.id}/recovery/${session.sessionId}`, {
    headers: headers("clock-recovery-delete"),
  });
  expect(alreadyCleaned.status()).toBe(404);

  const automation = await (await request.get("/api/automation")).json();
  const previewSource = automation.sources.find((entry) => entry.id === source.id);
  const preview = await request.post("/api/automation/policy-preview", {
    data: {
      sourceId: source.id,
      conversationId: previewSource.previewContexts.find((entry) => !entry.id.endsWith("-busy")).id,
      sample: { grounded: true, automaticEligible: true, confidence: 1, replyWindowOpen: true },
    },
  });
  expect((await preview.json()).evaluatedAt).toBe(evaluationTime.toISOString());
});

test("fixture source PATCH rejects non-object and invalid present fields without mutation", async ({ request }) => {
  const csrfToken = (await (await request.post("/api/auth/csrf")).json()).csrfToken;
  const source = (await (await request.get("/api/sources")).json()).groups.find((entry) => entry.mode === "automatic");
  const headers = (key) => ({
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": key,
    "If-Match": `"${source.revision}"`,
  });
  const invalidBodies = [
    ["patch-null-mode", { mode: null }, 422],
    ["patch-null-policy", { policy: null }, 422],
    ["patch-null-allowlist", { allowListed: null }, 422],
    ["patch-null-kill-switch", { killSwitch: null }, 422],
    ["patch-zero-policy", { policy: 0 }, 422],
    ["patch-empty-mode", { mode: "" }, 422],
    ["patch-false-archive", { archived: false }, 422],
    ["patch-array", [], 422],
    ["patch-scalar", 7, 400],
    ["patch-unknown", { unknown: true }, 422],
    ["patch-invalid-mode", { mode: "off" }, 422],
  ];
  for (const [key, data, expectedStatus] of invalidBodies) {
    const response = await request.patch(`/api/sources/groups/${source.id}`, { data, headers: headers(key) });
    expect(response.status(), key).toBe(expectedStatus);
  }

  const after = (await (await request.get("/api/sources")).json()).groups.find((entry) => entry.id === source.id);
  expect(after).toEqual(source);

  const empty = await request.patch(`/api/sources/groups/${source.id}`, { data: {}, headers: headers("patch-empty") });
  expect(empty.status()).toBe(200);
  expect(await empty.json()).toEqual(expect.objectContaining({ revision: source.revision + 1 }));
});
