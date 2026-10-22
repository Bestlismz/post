import { expect, test } from "@playwright/test";

const baseItem = {
  conversationId: "group-conversation",
  channel: "facebook_group",
  processingRevision: 3,
  status: "needs_review",
  createdAt: "2026-10-22T07:26:00.000000Z",
  participant: { id: "mint", label: "Mint Kanyarat" },
  source: { id: "asoke-rentals", name: "คอนโดให้เช่า กรุงเทพฯ", health: "connected" },
  message: { id: "group-post", text: "หาคอนโดใกล้ BTS อโศก งบไม่เกิน 20,000 บาท 1 ห้องนอน เลี้ยงแมวได้ค่ะ" },
  summary: { location: "อโศก", budgetMax: 20000, assignee: null },
};

const items = Array.from({ length: 18 }, (_, index) => ({
  ...baseItem,
  id: index === 0 ? "group_1" : `group_${index + 1}`,
  conversationId: `group-conversation-${index + 1}`,
  participant: index === 0 ? baseItem.participant : { id: `member-${index}`, label: `ลูกค้าทดสอบ ${index + 1}` },
  message: { ...baseItem.message, id: `group-post-${index + 1}` },
  createdAt: new Date(Date.parse(baseItem.createdAt) - index * 60_000).toISOString(),
}));

const detail = {
  ...baseItem,
  id: "group_1",
  target: { kind: "comment", uiId: "comment" },
  timeline: [
    { id: "post", uiId: "post", direction: "inbound", author: "Mint Kanyarat", text: baseItem.message.text, createdAt: baseItem.createdAt, kind: "post" },
    { id: "comment", uiId: "comment", direction: "inbound", author: "Beam S.", text: "สนใจห้องนี้ค่ะ", createdAt: baseItem.createdAt, kind: "comment", isTarget: true },
  ],
  requirements: { district: "อโศก", budgetMax: 20000, bedrooms: 1, requiredPetPolicy: "allowed", moveInDate: null },
  missingRequirements: ["moveInDate"],
  matches: [],
  replies: [{ id: "reply-1", version: 1, processingRevision: 3, text: "สวัสดีค่ะ มีห้องตรงกับความต้องการให้ทีมตรวจสอบต่อได้ค่ะ" }],
  deliveries: [],
  events: [],
};

async function mockInbox(page) {
  let failNextList = false;
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role: "admin" }, csrfToken: "test-csrf" } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/inbox/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }));
  await page.route("**/api/inbox", (route) => {
    if (failNextList) { failNextList = false; return route.fulfill({ status: 503, json: { error: "temporary" } }); }
    return route.fulfill({ json: { items, nextCursor: null } });
  });
  await page.route(/\/api\/inbox\/[^/]+$/, (route) => route.fulfill({ json: detail }));
  return { failNextList() { failNextList = true; } };
}

test("table and workspace share URL state and the exact reply workflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop table behavior");
  await mockInbox(page);
  await page.goto("/inbox?view=table&state=needs_review");

  const table = page.getByRole("table", { name: "รายการ Inbox" });
  await expect(table).toBeVisible();
  await expect(page.getByRole("button", { name: "มุมมองตาราง" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "ต้องตรวจ 18" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toContainText("อโศก");
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toContainText("฿20,000");
  await page.getByRole("button", { name: "ทั้งหมด 18" }).click();
  await expect(page).not.toHaveURL(/state=/);
  await page.goBack();
  await expect(page).toHaveURL(/state=needs_review/);
  await expect(page.getByRole("button", { name: "ต้องตรวจ 18" })).toHaveAttribute("aria-pressed", "true");

  const scroller = page.locator(".inbox-table__scroll");
  const row = page.getByRole("row", { name: /Mint Kanyarat/ });
  await row.focus();
  await scroller.evaluate((node) => { node.scrollTop = 220; });
  const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
  await row.press("Enter");

  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
  await expect(page).toHaveURL(/view=table/);
  await expect(page).toHaveURL(/state=needs_review/);
  await expect(page).toHaveURL(/item=group_1/);

  await page.goBack();
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeFocused();
  await page.getByRole("button", { name: "ปิดรายละเอียดลีด" }).click();
  await expect(row).toBeFocused();

  await page.getByRole("button", { name: "มุมมองพื้นที่ทำงาน" }).click();
  await expect(page).toHaveURL(/view=workspace/);
  await expect(page).toHaveURL(/state=needs_review/);
  await expect(page.getByRole("complementary", { name: "คิวข้อความ" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("table", { name: "รายการ Inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ต้องตรวจ 18" })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(page.getByRole("complementary", { name: "คิวข้อความ" })).toBeVisible();
});

test("cached rows stay usable and expose a regional retry after refresh failure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop queue and table refresh behavior");
  await page.addInitScript(() => {
    class FixtureEventSource {
      constructor() { window.__tableSource = this; }
      close() {}
      addEventListener(type, listener) { if (type === "inbox") this.onmessage = listener; }
    }
    window.EventSource = FixtureEventSource;
    window.__refreshInbox = () => window.__tableSource?.onmessage?.({ data: JSON.stringify({ resourceType: "inbox", resourceId: "all" }) });
  });
  const fixture = await mockInbox(page);
  await page.goto("/inbox?view=table&state=needs_review");
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toBeVisible();

  fixture.failNextList();
  await page.evaluate(() => window.__refreshInbox());
  const staleAlert = page.getByRole("alert").filter({ hasText: "ข้อมูลอาจไม่ใช่ข้อมูลล่าสุด" });
  await expect(staleAlert).toBeVisible();
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toBeVisible();
  await page.getByRole("button", { name: "ลองโหลดคิวอีกครั้ง" }).click();
  await expect(staleAlert).toHaveCount(0);

  await page.getByRole("button", { name: "มุมมองพื้นที่ทำงาน" }).click();
  fixture.failNextList();
  await page.evaluate(() => window.__refreshInbox());
  await expect(staleAlert).toBeVisible();
  await expect(page.getByRole("button", { name: /Mint Kanyarat/ })).toBeVisible();
  await page.getByRole("button", { name: "ลองโหลดคิวอีกครั้ง" }).click();
  await expect(staleAlert).toHaveCount(0);
});

test("table view becomes a deliberate row list below tablet without horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile table fallback");
  await mockInbox(page);
  await page.goto("/inbox?view=table&state=needs_review");

  await expect(page.getByRole("table", { name: "รายการ Inbox" })).toBeHidden();
  await expect(page.getByRole("list", { name: "รายการ Inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mint Kanyarat/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});
