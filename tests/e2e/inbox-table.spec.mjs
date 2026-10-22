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
  channel: index === 1 ? "messenger" : "facebook_group",
  status: index === 1 ? "pending" : "needs_review",
  participant: index === 0 ? baseItem.participant : { id: `member-${index}`, label: index === 1 ? "Nattapong S." : `ลูกค้าทดสอบ ${index + 1}` },
  message: { ...baseItem.message, id: `group-post-${index + 1}`, text: index === 1 ? "มีห้องแถวทองหล่อ งบ 35,000 ไหมครับ" : baseItem.message.text },
  source: index === 1 ? { id: "page", name: "Rental Radar Page", health: "connected" } : baseItem.source,
  summary: index === 1 ? { location: "ทองหล่อ", budgetMax: 35000, assignee: null } : baseItem.summary,
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
  await page.route(/\/api\/inbox(?:\?.*)?$/, (route) => {
    if (failNextList) { failNextList = false; return route.fulfill({ status: 503, json: { error: "temporary" } }); }
    const url = new URL(route.request().url());
    const value = items.filter((item) => {
      const min = Number(url.searchParams.get("budgetMin") || 0), max = Number(url.searchParams.get("budgetMax") || Number.MAX_SAFE_INTEGER);
      const budget = item.summary?.budgetMax;
      return (!url.searchParams.get("channel") || item.channel === url.searchParams.get("channel"))
        && (!url.searchParams.get("status") || item.status === url.searchParams.get("status"))
        && (!url.searchParams.get("location") || item.summary?.location?.includes(url.searchParams.get("location")))
        && (!url.searchParams.get("budgetMin") || (budget != null && budget >= min))
        && (!url.searchParams.get("budgetMax") || (budget != null && budget <= max))
        && (!url.searchParams.get("q") || `${item.participant.label} ${item.message.text} ${item.source.name}`.toLowerCase().includes(url.searchParams.get("q").toLowerCase()));
    });
    return route.fulfill({ json: { items: value, resultCount: value.length, nextCursor: null } });
  });
  await page.route(/\/api\/inbox\/[^/]+$/, (route) => route.fulfill({ json: detail }));
  return { failNextList() { failNextList = true; } };
}

test("table-only Inbox keeps authoritative filters and the exact reply workflow in URL history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop table behavior");
  await mockInbox(page);
  await page.goto("/inbox?view=workspace&state=needs_review");

  const table = page.getByRole("table", { name: "รายการ Inbox" });
  await expect(table).toBeVisible();
  await expect(page.getByLabel("รูปแบบ Inbox")).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=|state=/);
  await expect(page).toHaveURL(/status=needs_review/);
  await expect(page.getByText("17 รายการ")).toBeVisible();
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toContainText("อโศก");
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toContainText("฿20,000");
  await page.getByRole("combobox", { name: "สถานะ" }).selectOption("");
  await page.getByRole("combobox", { name: "ช่องทาง" }).selectOption("messenger");
  await expect(page).toHaveURL(/channel=messenger/);
  await expect(page.getByRole("row", { name: /Nattapong S\./ })).toBeVisible();
  await page.getByRole("searchbox", { name: "ค้นหา", exact: true }).fill("ทองหล่อ");
  await page.getByRole("button", { name: "ค้นหา Inbox" }).click();
  await expect(page).toHaveURL(/q=/);
  await page.goBack();
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole("button", { name: "ล้างตัวกรอง" }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  const scroller = page.locator(".inbox-table__scroll");
  const row = page.getByRole("row", { name: /Mint Kanyarat/ });
  await row.focus();
  await scroller.evaluate((node) => { node.scrollTop = 220; });
  const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
  await row.press("Enter");

  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
  await expect(page).toHaveURL(/item=group_1/);

  await page.goBack();
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollBefore);
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeFocused();
  await page.getByRole("button", { name: "ปิดรายละเอียดลีด" }).click();
  await expect(row).toBeFocused();

  await expect(page.getByRole("complementary", { name: "คิวข้อความ" })).toHaveCount(0);
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
  await page.goto("/inbox?status=needs_review");
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toBeVisible();

  fixture.failNextList();
  await page.evaluate(() => window.__refreshInbox());
  const staleAlert = page.getByRole("alert").filter({ hasText: "ข้อมูลอาจไม่ใช่ข้อมูลล่าสุด" });
  await expect(staleAlert).toBeVisible();
  await expect(page.getByRole("row", { name: /Mint Kanyarat/ })).toBeVisible();
  await page.getByRole("button", { name: "ลองโหลดคิวอีกครั้ง" }).click();
  await expect(staleAlert).toHaveCount(0);

});

test("table view becomes a deliberate row list below tablet without horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile table fallback");
  await mockInbox(page);
  await page.goto("/inbox?status=needs_review");

  await expect(page.getByRole("table", { name: "รายการ Inbox" })).toBeHidden();
  await expect(page.getByRole("list", { name: "รายการ Inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mint Kanyarat/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "ช่องทาง" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});
