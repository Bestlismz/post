import { expect, test } from "@playwright/test";

test("fixture Inbox uses the production table URL filters and one focus sheet", async ({ page, request }) => {
  const filtered = await request.get("/api/inbox?channel=messenger&location=%E0%B8%AD%E0%B9%82%E0%B8%A8%E0%B8%81&assignee=unassigned");
  expect(filtered.status()).toBe(200);
  const payload = await filtered.json();
  expect(payload.resultCount).toBe(1);
  expect(payload.items[0]).toEqual(expect.objectContaining({ channel: "messenger", summary: expect.objectContaining({ location: "อโศก" }) }));
  const firstPage = await (await request.get("/api/inbox?limit=1")).json();
  expect(firstPage.items).toHaveLength(1);
  expect(firstPage.resultCount).toBe(3);
  expect(firstPage.nextCursor).toBeTruthy();
  const secondPage = await (await request.get(`/api/inbox?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).json();
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);

  await page.goto("/inbox?view=workspace&state=needs_review");
  await expect(page).toHaveURL(/\/inbox\?status=needs_review/);
  await expect(page.getByRole("table", { name: "รายการ Inbox" })).toBeVisible();
  await expect(page.getByText("1 รายการ")).toBeVisible();
  const row = page.getByRole("row", { name: /Mint Kanyarat/ });
  await row.press("Enter");
  await expect(page.getByRole("dialog", { name: "รายละเอียดลีด" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
});

test("fixture topbar exposes safe Facebook identity and revokes the fixture app session on logout", async ({ page }) => {
  await page.goto("/inbox");
  await page.getByRole("button", { name: "เปิดเมนูบัญชี" }).click();
  const menu = page.getByRole("menu", { name: "เมนูบัญชี" });
  await expect(menu).toContainText("Rental Radar Thailand");
  await expect(menu).not.toContainText("fixture-token");
  await page.getByRole("menuitem", { name: "ออกจากระบบ" }).click();
  await expect.poll(async () => (await page.request.get("/api/me")).status()).toBe(401);
});
