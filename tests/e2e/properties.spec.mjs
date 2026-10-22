import { expect, test } from "@playwright/test";

const projectSeed = {
  id: "project-asoke",
  organizationId: "org_default",
  name: "ไลฟ์ อโศก",
  address: "ถนนอโศก-ดินแดง",
  district: "ราชเทวี",
  province: "กรุงเทพมหานคร",
  latitude: 13.753,
  longitude: 100.561,
  transit: [{ station: "MRT เพชรบุรี", walkingDistanceM: 300 }],
  amenities: ["สระว่ายน้ำ", "ฟิตเนส"],
  media: [],
  revision: 1,
};

const completeUnit = {
  projectId: projectSeed.id,
  unitCode: "A-1207",
  roomType: "1 ห้องนอน",
  bedrooms: 1,
  bathrooms: 1,
  floor: 12,
  areaSqm: 35,
  monthlyRentThb: 18000,
  depositMonths: 2,
  advanceMonths: 1,
  petPolicy: "allowed",
  availableFrom: "2026-11-01",
  description: "ห้องมุม วิวเมือง เฟอร์นิเจอร์ครบ พร้อมเข้าอยู่",
  media: [],
};

async function mockInventory(page) {
  let projects = [];
  let units = [];
  let unitSequence = 0;
  let conflictOnce = false;
  const requests = [];

  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role: "inventory_manager" }, csrfToken: "test-csrf" } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route(/\/api\/(projects|units)(?:\/[^/]+(?:\/(?:publish|availability|archive))?)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname.split("/").filter(Boolean);
    const resource = segments[1];
    const id = segments[2];
    const action = segments[3];
    const method = request.method();
    const body = request.postDataJSON?.() ?? {};
    requests.push({ method, path: url.pathname, body, headers: request.headers() });

    if (method === "GET" && !id) return route.fulfill({ json: resource === "projects" ? { projects } : { units } });
    if (method === "GET" && id) {
      const entity = (resource === "projects" ? projects : units).find((entry) => entry.id === id);
      return entity ? route.fulfill({ json: entity }) : route.fulfill({ status: 404, json: { error: "Not found" } });
    }
    if (method === "POST" && resource === "projects" && !id) {
      const project = { ...projectSeed, ...body, id: `project-${projects.length + 1}`, revision: 1 };
      projects = [...projects, project];
      return route.fulfill({ status: 201, headers: { ETag: '"1"' }, json: project });
    }
    if (method === "POST" && resource === "units" && !id) {
      const unit = { ...body, id: `unit-${++unitSequence}`, organizationId: "org_default", status: "draft", publishedAt: null, factsUpdatedAt: "2026-10-22T08:00:00.000Z", revision: 1 };
      units = [...units, unit];
      return route.fulfill({ status: 201, headers: { ETag: '"1"' }, json: unit });
    }

    const index = units.findIndex((entry) => entry.id === id);
    if (index < 0) return route.fulfill({ status: 404, json: { error: "Not found" } });
    const current = units[index];
    const expected = request.headers()["if-match"];
    if (conflictOnce) {
      conflictOnce = false;
      units[index] = { ...current, monthlyRentThb: 19500, revision: current.revision + 1 };
      return route.fulfill({ status: 409, json: { error: "Revision conflict" } });
    }
    if (expected !== `"${current.revision}"`) return route.fulfill({ status: 409, json: { error: "Revision conflict" } });

    let next = current;
    if (method === "PATCH") next = { ...current, ...body };
    if (method === "POST" && action === "publish") next = { ...current, publishedAt: "2026-10-22T08:05:00.000Z" };
    if (method === "POST" && action === "availability") next = { ...current, status: body.status };
    if (method === "POST" && action === "archive") next = { ...current, status: "archived" };
    next = { ...next, revision: current.revision + 1, factsUpdatedAt: "2026-10-22T08:05:00.000Z" };
    units[index] = next;
    return route.fulfill({ headers: { ETag: `"${next.revision}"` }, json: next });
  });

  return {
    requests,
    forceConflict() { conflictOnce = true; },
    seedProject(project = projectSeed) { projects = [project]; },
    seedUnit(unit = completeUnit) {
      unitSequence++;
      units = [{ ...unit, id: `unit-${unitSequence}`, organizationId: "org_default", status: "available", publishedAt: "2026-10-22T08:00:00.000Z", factsUpdatedAt: "2026-10-22T08:00:00.000Z", revision: 2 }];
    },
  };
}

async function fillProject(page) {
  await page.getByRole("button", { name: "เพิ่มโครงการ" }).click();
  await page.getByLabel("ชื่อโครงการ", { exact: true }).fill("ไลฟ์ อโศก");
  await page.getByLabel("เขต / อำเภอ").fill("ราชเทวี");
  await page.getByLabel("จังหวัด").fill("กรุงเทพมหานคร");
  await page.getByLabel("สถานีรถไฟฟ้าใกล้ที่สุด").fill("MRT เพชรบุรี");
  await page.getByLabel("ระยะเดินจากสถานี (เมตร)").fill("300");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
}

async function fillUnit(page, { complete = true } = {}) {
  await page.getByRole("button", { name: "เพิ่มห้อง" }).first().click();
  await page.getByLabel("รหัสห้อง").fill("A-1207");
  if (!complete) return;
  await page.getByLabel("ประเภทห้อง").selectOption("1 ห้องนอน");
  await page.getByLabel("ค่าเช่าต่อเดือน").fill("18000");
  await page.getByLabel("วันที่พร้อมเข้าอยู่").fill("2026-11-01");
  await page.getByLabel("นโยบายสัตว์เลี้ยง").selectOption("allowed");
  await page.getByLabel("รายละเอียดสำหรับลูกค้า").fill(completeUnit.description);
}

test("inventory staff creates a project, validates publication, and publishes a grounded unit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop inventory workflow");
  const fixture = await mockInventory(page);
  await page.goto("/properties");

  await expect(page.getByRole("heading", { name: "ห้องและโครงการ" })).toBeVisible();
  await fillProject(page);
  await expect(page.getByRole("treeitem", { name: /ไลฟ์ อโศก/ })).toBeVisible();

  await fillUnit(page, { complete: false });
  await page.getByRole("button", { name: "บันทึกและเผยแพร่" }).click();
  await expect(page.getByText("กรอกข้อมูลที่จำเป็นก่อนเผยแพร่")).toBeVisible();
  await expect(page.getByTestId("publication-errors").getByText("ค่าเช่าต่อเดือน", { exact: true })).toBeVisible();

  await page.getByLabel("ประเภทห้อง").selectOption("1 ห้องนอน");
  await page.getByLabel("ค่าเช่าต่อเดือน").fill("18000");
  await page.getByLabel("วันที่พร้อมเข้าอยู่").fill("2026-11-01");
  await page.getByLabel("นโยบายสัตว์เลี้ยง").selectOption("allowed");
  await page.getByLabel("รายละเอียดสำหรับลูกค้า").fill(completeUnit.description);
  await page.getByRole("button", { name: "บันทึกและเผยแพร่" }).click();

  await expect(page.getByText("เผยแพร่แล้ว")).toBeVisible();
  await expect(page.getByRole("row", { name: /A-1207/ })).toBeVisible();
  expect(fixture.requests.some((entry) => entry.path.endsWith("/publish"))).toBeTruthy();
  expect(fixture.requests.filter((entry) => entry.method !== "GET").every((entry) => entry.headers["idempotency-key"])).toBeTruthy();
});

test("inventory staff handles stale edits, changes availability, and keeps archived history discoverable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop inventory workflow");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");

  await expect(page.getByTestId("unit-table").getByRole("row", { name: /โครงการ ไลฟ์ อโศก · 1 ห้อง/ })).toBeVisible();
  await page.getByRole("row", { name: /A-1207/ }).getByRole("button", { name: "แก้ไขห้อง A-1207" }).click();
  await page.getByLabel("ค่าเช่าต่อเดือน").fill("18500");
  fixture.forceConflict();
  await page.getByRole("button", { name: "บันทึกการเปลี่ยนแปลง" }).click();
  await expect(page.getByText("ข้อมูลห้องถูกแก้ไขจากที่อื่น")).toBeVisible();
  await page.getByRole("button", { name: "โหลดข้อมูลล่าสุด" }).click();
  await expect(page.getByLabel("ค่าเช่าต่อเดือน")).toHaveValue("19500");

  await page.getByRole("button", { name: "ปิดแผงแก้ไข" }).click();
  await page.getByRole("row", { name: /A-1207/ }).getByLabel("สถานะห้อง").selectOption("held");
  await expect(page.getByRole("row", { name: /A-1207/ }).getByLabel("สถานะห้อง")).toHaveValue("held");

  await page.getByRole("row", { name: /A-1207/ }).getByRole("button", { name: "เมนูห้อง A-1207" }).click();
  await page.getByRole("menuitem", { name: "เก็บเข้าประวัติ" }).click();
  await page.getByRole("button", { name: "ยืนยันเก็บเข้าประวัติ" }).click();
  await expect(page.getByText("เก็บในประวัติแล้ว")).toBeVisible();
  await page.getByLabel("ตัวกรองสถานะ").selectOption("archived");
  await expect(page.getByRole("row", { name: /A-1207/ })).toBeVisible();
});

test("[mobile] inventory uses deliberate cards and protects unsaved edits", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile inventory workflow");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");

  await expect(page.getByTestId("unit-table")).toBeHidden();
  const card = page.getByTestId("unit-card").filter({ hasText: "A-1207" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "แก้ไขห้อง A-1207" }).click();
  await page.getByLabel("รายละเอียดสำหรับลูกค้า").fill("เปลี่ยนรายละเอียดแต่ยังไม่บันทึก");
  await page.getByRole("button", { name: "ปิดแผงแก้ไข" }).click();
  await expect(page.getByRole("dialog", { name: "ยังไม่ได้บันทึก" })).toBeVisible();
  await page.getByRole("button", { name: "กลับไปแก้ไข" }).click();
  await expect(page.getByLabel("รายละเอียดสำหรับลูกค้า")).toHaveValue("เปลี่ยนรายละเอียดแต่ยังไม่บันทึก");
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "visible");
});
