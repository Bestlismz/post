import { expect, test } from "@playwright/test";

const group = {
  id: "group-source-1",
  canonicalUrl: "https://www.facebook.com/groups/1742522453522327",
  mode: "observe",
  allowListed: true,
  health: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false },
  paused: false,
  revision: 1,
  latestOperation: { operationId: "scan-1", state: "completed", createdAt: "2026-10-22T08:30:00.000Z" },
  latestReceipt: { operationId: "scan-1", coverage: "complete", health: "healthy", reason: null, createdAt: "2026-10-22T08:30:01.000Z" },
  receiptHistory: [{ operationId: "scan-1", coverage: "complete", health: "healthy", reason: null, createdAt: "2026-10-22T08:30:01.000Z" }],
  session: { owner: "group-worker", state: "available" },
};

const policy = { mode: "automatic", minimumConfidence: 0.82, rateLimits: { organization: 100, source: 20, conversation: 2 }, businessHours: { timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "19:00" } };
const replyFormat = { locale: "th", tone: "friendly", greetingId: "hello", closingId: "thanks", ctaId: "requirements", emojiPolicy: "none", maxLength: 900, numberFormat: "grouped", dateFormat: "dmy", requiredDisclosureId: "snapshot", forbiddenPhrases: [] };

async function mockOperations(page, { role = "admin", conflictPolicyOnce = false } = {}) {
  let groups = [{ ...group }], paused = false, policyRevision = 1, formatRevision = 1, pendingReads = 0;
  const receipts = [];
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/sources", (route) => { if (groups[0].latestOperation?.state === "queued" && ++pendingReads >= 2) { const receipt = { operationId: "scan-new", coverage: "partial", health: "auth_required", reason: "session_unavailable", createdAt: "2026-10-22T09:00:02.000Z" }; groups = groups.map((source, index) => index ? source : { ...source, health: { ...source.health, session: "auth_required", sessionCircuit: true }, latestOperation: { ...source.latestOperation, state: "completed" }, latestReceipt: receipt, receiptHistory: [receipt, ...source.receiptHistory] }); } return route.fulfill({ json: { actorRole: role, pages: [{ id: "page-source", name: "Rental Radar Thailand", health: "connected", expiresAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" }], groups } }); });
  await page.route("**/api/sources/groups", async (route) => {
    const url = route.request().postDataJSON().url;
    if (!/^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/\d+\/?(?:\?[^#]*)?$/.test(url)) return route.fulfill({ status: 422, json: { error: "Invalid group URL" } });
    const id = `group-source-${groups.length + 1}`;
    const numeric = new URL(url).pathname.split("/")[2];
    const created = { ...group, id, canonicalUrl: `https://www.facebook.com/groups/${numeric}`, allowListed: false, latestOperation: null, latestReceipt: null, receiptHistory: [], revision: 1 };
    groups = [...groups, created];
    return route.fulfill({ status: 201, json: created });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const patch = route.request().postDataJSON();
    if (patch.policy && conflictPolicyOnce) { conflictPolicyOnce = false; groups = groups.map((source) => source.id === id ? { ...source, revision: source.revision + 1 } : source); return route.fulfill({ status: 409, json: { error: "Revision conflict" } }); }
    groups = groups.map((source) => source.id === id ? { ...source, ...patch, revision: source.revision + 1 } : source);
    return route.fulfill({ json: groups.find((source) => source.id === id) });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+\/scans$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    pendingReads = 0; groups = groups.map((source) => source.id === id ? { ...source, latestOperation: { operationId: "scan-new", state: "queued", createdAt: "2026-10-22T09:00:00.000Z" } } : source);
    return route.fulfill({ status: 202, json: { operationId: "scan-new", state: "queued" } });
  });
  await page.route(/\/api\/sources\/[^/]+\/browser-health$/, (route) => route.fulfill({ json: { sourceId: "group-source-1", sourceHealth: { session: "auth_required", selector: "healthy", sessionCircuit: true, selectorCircuit: false, paused: true }, browser: { ok: false, session: { state: "auth_required" }, recovery: { state: "available" } } } }));
  await page.route(/\/api\/sources\/[^/]+\/recovery$/, (route) => role === "admin" ? route.fulfill({ status: 201, json: { sourceId: "group-source-1", sessionId: "recovery-1", expiresAt: "2026-10-22T09:10:00.000Z", tunnelUrl: "/api/sources/group-source-1/recovery/recovery-1/novnc/vnc.html" } }) : route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await page.route("**/api/automation", (route) => route.fulfill({ json: { actorRole: role, paused, policy: { value: policy, revision: policyRevision }, replyFormat: { value: replyFormat, revision: formatRevision }, sources: groups.map((source) => ({ id: source.id, label: source.canonicalUrl, revision: source.revision, policy: { rateLimits: policy.rateLimits, businessHours: policy.businessHours }, paused: source.paused, mode: source.mode, health: source.health, previewContexts: [{ id: `conversation-${source.id}`, label: "บทสนทนา revision 1", updatedAt: "2026-10-22T09:00:00.000Z" }], schedule: { enabled: true, cadenceMinutes: 15, timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00", dailyLimit: 48, maintenanceWindows: [], revision: 1 } })), receipts } }));
  await page.route("**/api/automation/policy-preview", async (route) => {
    const { sample, sourceId, conversationId } = route.request().postDataJSON();
    const selected = groups.find((source) => source.id === sourceId);
    expect(conversationId).toBe(`conversation-${sourceId}`);
    const reasons = [];
    if (paused) reasons.push("global_pause");
    if (selected.paused) reasons.push("source_pause");
    if (selected.mode !== "automatic") reasons.push("approval_required");
    if (sample.confidence < policy.minimumConfidence) reasons.push("confidence");
    return route.fulfill({ json: { source: { id: selected.id, label: selected.canonicalUrl }, effectivePolicy: { ...policy, mode: selected.mode }, action: reasons.length ? "review" : "authorize", reasons } });
  });
  await page.route("**/api/automation/pause", async (route) => {
    paused = route.request().postDataJSON().paused;
    const receipt = { id: "receipt-global", scope: "organization", paused, reasonCode: paused ? "GLOBAL_PAUSED" : "GLOBAL_RESUMED", createdAt: "2026-10-22T09:01:00.000Z" };
    receipts.unshift(receipt);
    return route.fulfill({ json: { paused, receiptId: receipt.id, reasonCode: receipt.reasonCode } });
  });
  await page.route(/\/api\/automation\/sources\/[^/]+\/pause$/, async (route) => { const value = route.request().postDataJSON().paused; groups = groups.map((source, index) => index ? source : { ...source, paused: value, revision: source.revision + 1 }); return route.fulfill({ json: { sourceId: "group-source-1", paused: value, revision: groups[0].revision, updatedAt: new Date().toISOString(), receiptId: "receipt-source", reasonCode: value ? "SOURCE_PAUSED" : "SOURCE_RESUMED" } }); });
  await page.route("**/api/automation/policy", async (route) => { policyRevision++; return route.fulfill({ json: { value: route.request().postDataJSON(), revision: policyRevision } }); });
  await page.route("**/api/automation/reply-format", async (route) => { formatRevision++; return route.fulfill({ json: { value: route.request().postDataJSON(), revision: formatRevision } }); });
  return { get groups() { return groups; }, get paused() { return paused; } };
}

test("Sources adds only canonical Groups, changes mode, and makes scan/recovery state visible", async ({ page }) => {
  const state = await mockOperations(page);
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "แหล่งข้อมูล Facebook" })).toBeVisible();
  await expect(page.getByText("Rental Radar Thailand")).toBeVisible();
  await expect(page.locator(".page-source-row").getByText("เชื่อมต่อแล้ว")).toBeVisible();

  await page.getByRole("button", { name: "เพิ่มกลุ่ม" }).click();
  await page.getByLabel("ลิงก์ Facebook Group").fill("https://facebook.com/groups/not-a-number");
  await page.getByRole("button", { name: "ยืนยันเพิ่มกลุ่ม" }).click();
  await expect(page.getByText("ลิงก์ต้องเป็น Facebook Group แบบตัวเลขเท่านั้น")).toBeVisible();
  await page.getByLabel("ลิงก์ Facebook Group").fill("https://m.facebook.com/groups/999000111/?ref=share");
  await page.getByRole("button", { name: "ยืนยันเพิ่มกลุ่ม" }).click();
  await expect(page.getByText("https://www.facebook.com/groups/999000111")).toBeVisible();
  expect(state.groups).toHaveLength(2);

  const source = page.getByTestId("source-group-source-1");
  await source.getByRole("button", { name: "Approval" }).click();
  await expect(source.getByText("เตรียมคำตอบและรอคนอนุมัติ")).toBeVisible();
  await source.getByRole("button", { name: "สแกนตอนนี้" }).click();
  await expect(source.locator(".source-run-state strong").getByText("อยู่ในคิวสแกน", { exact: true })).toBeVisible();
  await expect(source.getByText("สแกนล่าสุดต้องตรวจสอบ")).toBeVisible();
  await expect(source.getByText("ต้องเข้าสู่ระบบใหม่")).toBeVisible();
  await source.getByRole("button", { name: "ดูรายละเอียดการสแกน" }).click();
  await expect(source.getByText(/เจ้าของ session: group-worker/)).toBeVisible();
  await source.getByRole("button", { name: "กู้คืนการเชื่อมต่อ" }).click();
  await expect(page.getByTitle("Facebook session recovery")).toHaveAttribute("src", /\/api\/sources\/group-source-1\/recovery\/recovery-1\/novnc\/vnc\.html/);
  await expect(page.locator("body")).toHaveCSS("overflow-x", "clip");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});

test("circuit-open source recovers the browser before sending an explicit recovery scan", async ({ page }) => {
  const scanRequests = [];
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "Admin", role: "admin" } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/sources", (route) => route.fulfill({ json: {
    actorRole: "admin",
    pages: [],
    groups: [{
      ...group,
      id: "group-source-recovery",
      displayName: "test autopost",
      canonicalUrl: "https://www.facebook.com/groups/2625323481252008",
      mode: "approval",
      health: { session: "healthy", selector: "failed", sessionCircuit: false, selectorCircuit: true },
    }],
  } }));
  await page.route("**/api/sources/groups/group-source-recovery/scans", async (route) => {
    scanRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { operationId: "recovery-operation", state: "queued" } });
  });
  await page.route("**/api/sources/group-source-recovery/recovery", (route) => route.fulfill({ status: 201, json: { sourceId: "group-source-recovery", sessionId: "recovery-operation", expiresAt: "2026-10-22T09:10:00.000Z", tunnelUrl: "/api/sources/group-source-recovery/recovery/recovery-operation/novnc/vnc.html" } }));
  await page.route("**/api/sources/group-source-recovery/recovery/recovery-operation", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/sources/group-source-recovery/recovery/recovery-operation/novnc/vnc.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>recovery</title>" }));

  await page.goto("/sources");
  const source = page.getByTestId("source-group-source-recovery");
  await source.getByRole("button", { name: "กู้คืนการเชื่อมต่อ" }).click();
  await page.getByRole("button", { name: "ยืนยันและสแกนทดสอบ" }).click();
  await expect.poll(() => scanRequests).toEqual([{ recovery: true }]);
});

test("retry-required scan state stays scoped to its group through unrelated loads and recovery", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "fake-clock lifecycle runs once in desktop Chromium");
  await page.clock.install({ time: new Date("2026-10-22T09:00:00.000Z") });
  const priorReceipt = { operationId: "scan-prior", coverage: "complete", health: "healthy", reason: null, createdAt: "2026-10-22T08:00:00.000Z" };
  let groups = [
    { ...group, id: "source-a", canonicalUrl: "https://www.facebook.com/groups/111", latestOperation: { operationId: "scan-a", state: "queued", createdAt: "2026-10-22T08:48:00.000Z" }, latestReceipt: priorReceipt, receiptHistory: [priorReceipt] },
    { ...group, id: "source-b", canonicalUrl: "https://www.facebook.com/groups/222", latestOperation: { operationId: "scan-b", state: "completed", createdAt: "2026-10-22T08:30:00.000Z" }, latestReceipt: { ...priorReceipt, operationId: "scan-b" }, receiptHistory: [{ ...priorReceipt, operationId: "scan-b" }] },
  ];
  let sourceLoads = 0;
  let failPolls = true;
  let completeA = false;
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "Admin", role: "admin" } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/sources", (route) => {
    sourceLoads += 1;
    if (sourceLoads > 1 && failPolls) return route.fulfill({ status: 503, json: { error: "temporary" } });
    if (completeA) {
      const receipt = { operationId: "scan-a", coverage: "complete", health: "healthy", reason: null, createdAt: "2026-10-22T09:12:01.000Z" };
      groups = groups.map((source) => source.id === "source-a" ? { ...source, latestOperation: { ...source.latestOperation, state: "completed" }, latestReceipt: receipt, receiptHistory: [receipt, ...source.receiptHistory] } : source);
      completeA = false;
    }
    const pendingB = groups.find((source) => source.id === "source-b")?.latestOperation?.state === "queued";
    if (pendingB) groups = groups.map((source) => source.id === "source-b" ? { ...source, latestOperation: { ...source.latestOperation, state: "completed" } } : source);
    return route.fulfill({ json: { actorRole: "admin", pages: [], groups } });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+\/scans$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    groups = groups.map((source) => source.id === id ? { ...source, latestOperation: { operationId: `scan-${id}-new`, state: "queued", createdAt: "2026-10-22T09:12:00.000Z" } } : source);
    return route.fulfill({ status: 202, json: { operationId: `scan-${id}-new`, state: "queued" } });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+$/, (route) => route.fulfill({ json: groups.find((source) => source.id === new URL(route.request().url()).pathname.split("/").at(-1)) }));
  await page.route(/\/api\/sources\/[^/]+\/browser-health$/, (route) => route.fulfill({
    json: {
      sourceId: "source-a",
      sourceHealth: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false, paused: false },
      browser: { ok: true, session: { state: "healthy" }, recovery: { state: "available" } },
    },
  }));
  await page.route(/\/api\/sources\/[^/]+\/recovery$/, (route) => route.fulfill({ status: 201, json: { sourceId: "source-a", sessionId: "session-a", expiresAt: "2026-10-22T09:20:00.000Z", tunnelUrl: "/api/sources/source-a/recovery/session-a/novnc/vnc.html" } }));
  await page.route(/\/api\/sources\/[^/]+\/recovery\/[^/]+$/, (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/sources/source-a/recovery/session-a/novnc/vnc.html", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>recovery</title>" }));

  await page.goto("/sources");
  await expect(page.getByTestId("source-source-a").locator(".source-run-state strong").getByText("อยู่ในคิวสแกน", { exact: true })).toBeVisible();
  await page.clock.fastForward(12 * 60_000 + 1_000);
  const sourceA = page.getByTestId("source-source-a"), sourceB = page.getByTestId("source-source-b");
  await expect(sourceA.getByText("ตรวจสถานะล่าสุดไม่ได้")).toBeVisible();
  await expect(sourceA.getByRole("button", { name: "โหลดสถานะ" })).toBeVisible();
  const loadsAtFailure = sourceLoads;

  failPolls = false;
  await sourceB.getByRole("button", { name: "สแกนตอนนี้" }).click();
  const loadsAfterB = sourceLoads;
  await sourceA.getByRole("button", { name: "ดูรายละเอียดการสแกน" }).click();
  await sourceA.getByRole("button", { name: "เปิดหน้ากู้คืนเซสชัน" }).click();
  await page.getByRole("button", { name: "ปิดหน้ากู้คืน" }).evaluate((button) => button.click());
  await page.clock.fastForward(1);
  await expect.poll(() => sourceLoads).toBeGreaterThan(loadsAfterB);
  await expect(sourceA.getByText("ตรวจสถานะล่าสุดไม่ได้")).toBeVisible();
  const loadsAfterRecovery = sourceLoads;
  await page.clock.fastForward(60_000);
  expect(loadsAfterRecovery).toBeGreaterThan(loadsAtFailure);
  expect(sourceLoads).toBe(loadsAfterRecovery);
  await expect(sourceA.getByText("ตรวจสถานะล่าสุดไม่ได้")).toBeVisible();
  await expect(sourceB.getByText("ตรวจสถานะล่าสุดไม่ได้")).toHaveCount(0);

  completeA = true;
  await sourceA.getByRole("button", { name: "โหลดสถานะ" }).evaluate((button) => button.click());
  await page.clock.fastForward(1_000);
  await expect(sourceA.getByText("ตรวจสถานะล่าสุดไม่ได้")).toHaveCount(0);
  await expect(sourceA.getByText("สแกนล่าสุดเสร็จแล้ว")).toBeVisible();
  await expect(sourceB.getByText("ตรวจสถานะล่าสุดไม่ได้")).toHaveCount(0);
});

test("Automations previews the production decision and persists pause/format receipts", async ({ page }) => {
  const state = await mockOperations(page);
  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "กติกาอัตโนมัติ" })).toBeVisible();
  await page.getByLabel("แหล่งข้อมูลสำหรับทดสอบ").selectOption("group-source-1");
  await expect(page.getByLabel("บทสนทนาสำหรับตรวจ rate limit")).toHaveValue("conversation-group-source-1");
  await page.getByLabel("ความมั่นใจของตัวอย่าง").fill("70");
  await page.getByRole("button", { name: "ทดสอบกติกา" }).click();
  await expect(page.getByText("ส่งให้คนตรวจ")).toBeVisible();
  await expect(page.getByText("ความมั่นใจต่ำกว่าเกณฑ์ 82%")).toBeVisible();

  await page.getByLabel("รูปแบบคำทักทาย").selectOption("none");
  await page.getByRole("button", { name: "บันทึกรูปแบบคำตอบ" }).click();
  await expect(page.getByText("บันทึกรูปแบบคำตอบ revision 2 แล้ว")).toBeVisible();
  await page.getByRole("button", { name: "หยุดการส่งอัตโนมัติทั้งหมด" }).click();
  await expect(page.getByText("หยุดการส่งใหม่ทั่วทั้งระบบแล้ว")).toBeVisible();
  await expect(page.getByText("GLOBAL_PAUSED")).toBeVisible();
  expect(state.paused).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});

test("source pause adopts the new revision before a policy save", async ({ page }) => {
  await mockOperations(page);
  await page.goto("/automations");
  const row = page.locator(".automation-source-row").first();
  await row.getByRole("button", { name: "พักแหล่งนี้" }).click();
  await row.getByRole("button", { name: "บันทึก policy" }).click();
  await expect(page.getByText("บันทึก policy รายแหล่งแล้ว")).toBeVisible();
});

test("source policy conflict refreshes the authoritative revision before retry", async ({ page }) => {
  await mockOperations(page, { conflictPolicyOnce: true });
  await page.goto("/automations");
  const row = page.locator(".automation-source-row").first();
  await row.getByRole("button", { name: "บันทึก policy" }).click();
  await expect(page.getByText("ข้อมูลแหล่งเปลี่ยนระหว่างแก้ไข โหลด revision ล่าสุดแล้ว กรุณาตรวจสอบและบันทึกอีกครั้ง")).toBeVisible();
  await row.getByRole("button", { name: "บันทึก policy" }).click();
  await expect(page.getByText("บันทึก policy รายแหล่งแล้ว")).toBeVisible();
});

test("all Sources and Automations controls meet 44px across supported viewports", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one Chromium project checks all viewport classes");
  await mockOperations(page);
  for (const viewport of [{ width: 1440, height: 1024 }, { width: 1024, height: 900 }, { width: 412, height: 915 }]) {
    await page.setViewportSize(viewport);
    for (const path of ["/sources", "/automations"]) {
      await page.goto(path);
      const undersized = await page.locator(".ops-page button:not([disabled]),.ops-page a[href],.ops-page input,.ops-page select").evaluateAll((nodes) => nodes.map((node) => node instanceof HTMLInputElement && node.type === "checkbox" ? node.closest("label") : node).filter(Boolean).filter((node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44); }).map((node) => ({ tag: node.tagName, text: node.textContent?.trim(), aria: node.getAttribute("aria-label"), box: node.getBoundingClientRect().toJSON() })));
      expect(undersized, `${path} at ${viewport.width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    }
  }
});

test("browser recovery is visible but unavailable to non-admin users", async ({ page }) => {
  await mockOperations(page, { role: "operator" });
  await page.goto("/sources");
  const source = page.getByTestId("source-group-source-1");
  await source.getByRole("button", { name: "ดูรายละเอียดการสแกน" }).click();
  await expect(source.getByText("เฉพาะผู้ดูแลระบบเท่านั้นที่เปิดหน้ากู้คืนได้")).toBeVisible();
  await expect(source.getByRole("button", { name: "เปิดหน้ากู้คืนเซสชัน" })).toHaveCount(0);
});

test("tablet keeps Sources and Automations inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "tablet viewport runs once from desktop Chromium");
  await page.setViewportSize({ width: 1024, height: 900 });
  await mockOperations(page);
  for (const path of ["/sources", "/automations"]) {
    await page.goto(path);
    expect(await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))).toEqual({ document: 1024, viewport: 1024 });
  }
});
