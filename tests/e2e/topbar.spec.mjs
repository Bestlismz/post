import { expect, test } from "@playwright/test";

async function mockShell(page, role = "admin") {
  const requests = [];
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/facebook/session-summary", (route) => route.fulfill({ json: { state: "connected", identity: { displayName: "Rental Radar Thailand", avatarUrl: null, kind: "page" }, connections: { pages: 1, groups: 2, pageState: "connected", groupState: "healthy" }, canRecover: role === "admin" } }));
  await page.route("**/api/auth/logout", async (route) => {
    requests.push({ method: route.request().method(), headers: route.request().headers() });
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/inbox(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const status = url.searchParams.get("status");
    const count = status === "needs_review" ? 3 : status === "pending_or_updated" ? 2 : 5;
    return route.fulfill({ json: { items: [], resultCount: count, nextCursor: null } });
  });
  await page.route("**/api/inbox/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }));
  return requests;
}

test("topbar review presets and global search drive the one Inbox URL state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop menu keyboard flow");
  await mockShell(page);
  await page.goto("/properties");

  const review = page.getByRole("button", { name: /คิวที่ต้องตรวจ/ });
  await review.click();
  const menu = page.getByRole("menu", { name: "ตัวกรองคิวด่วน" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /ต้องตรวจ 3/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /ใหม่หรืออัปเดต 2/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inbox\?status=pending_or_updated/);
  await expect(menu).toHaveCount(0);

  const search = page.getByRole("searchbox", { name: "ค้นหาทั่วทั้ง Inbox" });
  await search.fill("อโศก ห้องว่าง");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/inbox\?q=/);
  await expect(page).not.toHaveURL(/status=/);
});

test("account menu reflects role and performs CSRF-protected logout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop account menu flow");
  const requests = await mockShell(page, "admin");
  await page.goto("/inbox");
  const account = page.getByRole("button", { name: "เปิดเมนูบัญชี" });
  await account.click();
  await expect(page.getByRole("menu", { name: "เมนูบัญชี" })).toContainText("ณัฐวุฒิ");
  await expect(page.getByRole("menu", { name: "เมนูบัญชี" })).toContainText("Rental Radar Thailand");
  await expect(page.getByRole("menu", { name: "เมนูบัญชี" })).toContainText("ผู้ดูแลระบบ");
  await expect(page.getByRole("menuitem", { name: "ตั้งค่าระบบ" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  await account.click();
  await page.getByRole("menuitem", { name: "ออกจากระบบ" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].headers["x-csrf-token"]).toBe("test-csrf");
});

test("mobile menus stay available without horizontal overflow and viewers do not see admin settings", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile topbar flow");
  await mockShell(page, "viewer");
  await page.goto("/inbox");
  await page.getByRole("button", { name: "เปิดเมนูบัญชี" }).click();
  await expect(page.getByRole("menuitem", { name: "ตั้งค่าระบบ" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "ออกจากระบบ" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "ดูสถานะการเชื่อมต่อ" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});
