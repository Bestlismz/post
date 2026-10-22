import { expect, test } from "@playwright/test";

test("fixture server exposes seeded Sources and Automations without intercepted APIs", async ({ page, request }) => {
  const sourcesResponse = await request.get("/api/sources");
  expect(sourcesResponse.status()).toBe(200);
  const sources = await sourcesResponse.json();
  expect(sources.actorRole).toBe("admin");
  expect(sources.pages).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Rental Radar Thailand", health: "connected" }),
  ]));
  expect(sources.groups).toHaveLength(2);
  expect(new Set(sources.groups.map((source) => source.mode))).toEqual(new Set(["observe", "approval"]));
  expect(sources.groups).toEqual(expect.arrayContaining([
    expect.objectContaining({
      health: expect.objectContaining({ session: "healthy", selector: "healthy" }),
      latestReceipt: expect.objectContaining({ coverage: "complete", health: "healthy" }),
    }),
    expect.objectContaining({
      health: expect.objectContaining({ session: "auth_required", sessionCircuit: true }),
      latestReceipt: expect.objectContaining({ coverage: "partial", health: "auth_required" }),
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
  await expect(page.getByText("Rental Radar Thailand")).toBeVisible();
  await expect(page.locator(".source-row")).toHaveCount(2);
  await expect(page.getByText("สแกนครบแล้ว")).toBeVisible();
  await expect(page.getByText("สแกนได้บางส่วน")).toBeVisible();

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
    mode: "observe",
    revision: 1,
  }));
  const replay = await request.post("/api/sources/groups", {
    data: { url: "https://m.facebook.com/groups/999000111/?ref=share" },
    headers: headers("add-999"),
  });
  expect(await replay.json()).toEqual(created);
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
});
