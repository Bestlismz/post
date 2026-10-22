import { expect, test } from "@playwright/test";

const group = {
  id: "group-source-1",
  canonicalUrl: "https://www.facebook.com/groups/1742522453522327",
  mode: "observe",
  allowListed: true,
  health: { session: "healthy", selector: "healthy", sessionCircuit: false, selectorCircuit: false },
  paused: false,
  revision: 1,
  latestScan: { operationId: "scan-1", state: "completed", coverage: "complete", health: "healthy", reason: null, createdAt: "2026-10-22T08:30:00.000Z" },
  session: { owner: "group-worker", state: "available" },
};

const policy = { mode: "automatic", minimumConfidence: 0.82, rateLimits: { organization: 100, source: 20, conversation: 2 }, businessHours: { timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "19:00" } };
const replyFormat = { locale: "th", tone: "friendly", greetingId: "hello", closingId: "thanks", ctaId: "requirements", emojiPolicy: "none", maxLength: 900, numberFormat: "grouped", dateFormat: "dmy", requiredDisclosureId: "snapshot", forbiddenPhrases: [] };

async function mockOperations(page, { role = "admin" } = {}) {
  let groups = [{ ...group }], paused = false, policyRevision = 1, formatRevision = 1;
  const receipts = [];
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/sources", (route) => route.fulfill({ json: { actorRole: role, pages: [{ id: "page-source", name: "Rental Radar Thailand", health: "connected", expiresAt: "2026-12-01T00:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" }], groups } }));
  await page.route("**/api/sources/groups", async (route) => {
    const url = route.request().postDataJSON().url;
    if (!/^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/\d+\/?(?:\?[^#]*)?$/.test(url)) return route.fulfill({ status: 422, json: { error: "Invalid group URL" } });
    const id = `group-source-${groups.length + 1}`;
    const numeric = new URL(url).pathname.split("/")[2];
    const created = { ...group, id, canonicalUrl: `https://www.facebook.com/groups/${numeric}`, allowListed: false, latestScan: null, revision: 1 };
    groups = [...groups, created];
    return route.fulfill({ status: 201, json: created });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const patch = route.request().postDataJSON();
    groups = groups.map((source) => source.id === id ? { ...source, ...patch, revision: source.revision + 1 } : source);
    return route.fulfill({ json: groups.find((source) => source.id === id) });
  });
  await page.route(/\/api\/sources\/groups\/[^/]+\/scans$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const latestScan = { operationId: "scan-new", state: "completed", coverage: "partial", health: "auth_required", reason: "login_required", createdAt: "2026-10-22T09:00:00.000Z" };
    groups = groups.map((source) => source.id === id ? { ...source, health: { ...source.health, session: "auth_required", sessionCircuit: true }, latestScan } : source);
    return route.fulfill({ status: 202, json: { operationId: "scan-new", state: "queued" } });
  });
  await page.route(/\/api\/sources\/[^/]+\/browser-health$/, (route) => route.fulfill({ json: { sourceId: "group-source-1", sourceHealth: { session: "auth_required", selector: "healthy", sessionCircuit: true, selectorCircuit: false, paused: true }, browser: { ok: false, session: { state: "auth_required" }, recovery: { state: "available" } } } }));
  await page.route(/\/api\/sources\/[^/]+\/recovery$/, (route) => role === "admin" ? route.fulfill({ status: 201, json: { sourceId: "group-source-1", sessionId: "recovery-1", expiresAt: "2026-10-22T09:10:00.000Z", tunnelUrl: "/api/sources/group-source-1/recovery/recovery-1/novnc/vnc.html" } }) : route.fulfill({ status: 403, json: { error: "forbidden" } }));
  await page.route("**/api/automation", (route) => route.fulfill({ json: { actorRole: role, paused, policy: { value: policy, revision: policyRevision }, replyFormat: { value: replyFormat, revision: formatRevision }, sources: groups.map((source) => ({ id: source.id, label: source.canonicalUrl, revision: source.revision, policy: { rateLimits: policy.rateLimits, businessHours: policy.businessHours }, paused: source.paused, mode: source.mode, health: source.health, schedule: { enabled: true, cadenceMinutes: 15, timeZone: "Asia/Bangkok", days: [1, 2, 3, 4, 5], start: "08:00", end: "20:00", dailyLimit: 48, maintenanceWindows: [], revision: 1 } })), receipts } }));
  await page.route("**/api/automation/policy-preview", async (route) => {
    const { sample, policy: input } = route.request().postDataJSON();
    const reasons = [];
    if (input.mode !== "automatic") reasons.push("approval_required");
    if (sample.confidence < input.minimumConfidence) reasons.push("confidence");
    return route.fulfill({ json: { action: reasons.length ? "review" : "authorize", reasons } });
  });
  await page.route("**/api/automation/pause", async (route) => {
    paused = route.request().postDataJSON().paused;
    const receipt = { id: "receipt-global", scope: "organization", paused, reasonCode: paused ? "GLOBAL_PAUSED" : "GLOBAL_RESUMED", createdAt: "2026-10-22T09:01:00.000Z" };
    receipts.unshift(receipt);
    return route.fulfill({ json: { paused, receiptId: receipt.id, reasonCode: receipt.reasonCode } });
  });
  await page.route(/\/api\/automation\/sources\/[^/]+\/pause$/, async (route) => route.fulfill({ json: { sourceId: "group-source-1", paused: route.request().postDataJSON().paused, receiptId: "receipt-source", reasonCode: "SOURCE_PAUSED" } }));
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
  await expect(source.getByText("จะไม่ส่งข้อความอัตโนมัติ")).toBeVisible();
  await source.getByRole("button", { name: "สแกนตอนนี้" }).click();
  await expect(source.getByText("สแกนได้บางส่วน")).toBeVisible();
  await expect(source.getByText("ต้องเข้าสู่ระบบ Facebook ใหม่")).toBeVisible();
  await source.getByRole("button", { name: "ตรวจสอบเซสชัน" }).click();
  await expect(source.getByText("group-worker เป็นเจ้าของ browser session นี้")).toBeVisible();
  await source.getByRole("button", { name: "เปิดหน้ากู้คืนเซสชัน" }).click();
  await expect(page.getByTitle("Facebook session recovery")).toHaveAttribute("src", /\/api\/sources\/group-source-1\/recovery\/recovery-1\/novnc\/vnc\.html/);
  await expect(page.locator("body")).toHaveCSS("overflow-x", "clip");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});

test("Automations previews the production decision and persists pause/format receipts", async ({ page }) => {
  const state = await mockOperations(page);
  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "กติกาอัตโนมัติ" })).toBeVisible();
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

test("browser recovery is visible but unavailable to non-admin users", async ({ page }) => {
  await mockOperations(page, { role: "operator" });
  await page.goto("/sources");
  const source = page.getByTestId("source-group-source-1");
  await source.getByRole("button", { name: "ตรวจสอบเซสชัน" }).click();
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
