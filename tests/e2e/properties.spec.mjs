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

async function mockInventory(page, { role = "inventory_manager" } = {}) {
  let projects = [];
  let units = [];
  let unitSequence = 0;
  let conflictTarget = null;
  let csrfRequests = 0;
  let currentCsrf = "";
  const requests = [];

  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role } } }),
  );
  await page.route("**/api/auth/csrf", (route) => {
    csrfRequests++;
    currentCsrf = `test-csrf-${csrfRequests}`;
    return route.fulfill({ json: { csrfToken: currentCsrf } });
  });
  await page.route(
    /\/api\/(projects|units)(?:\/[^/]+(?:\/(?:publish|availability|archive))?)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const segments = url.pathname.split("/").filter(Boolean);
      const resource = segments[1];
      const id = segments[2];
      const action = segments[3];
      const method = request.method();
      const body = request.postDataJSON?.() ?? {};
      requests.push({
        method,
        path: url.pathname,
        body,
        headers: request.headers(),
      });

      if (method === "GET" && !id)
        return route.fulfill({
          json: resource === "projects" ? { projects } : { units },
        });
      if (method === "GET" && id) {
        const entity = (resource === "projects" ? projects : units).find(
          (entry) => entry.id === id,
        );
        return entity
          ? route.fulfill({ json: entity })
          : route.fulfill({ status: 404, json: { error: "Not found" } });
      }
      if (method === "POST" && resource === "projects" && !id) {
        if (request.headers()["x-csrf-token"] !== currentCsrf)
          return route.fulfill({
            status: 403,
            json: { error: "CSRF token rejected" },
          });
        const project = {
          ...projectSeed,
          ...body,
          id: `project-${projects.length + 1}`,
          revision: 1,
        };
        projects = [...projects, project];
        return route.fulfill({
          status: 201,
          headers: { ETag: '"1"' },
          json: project,
        });
      }
      if (method === "POST" && resource === "units" && !id) {
        if (request.headers()["x-csrf-token"] !== currentCsrf)
          return route.fulfill({
            status: 403,
            json: { error: "CSRF token rejected" },
          });
        const unit = {
          ...body,
          id: `unit-${++unitSequence}`,
          organizationId: "org_default",
          status: "draft",
          publishedAt: null,
          factsUpdatedAt: "2026-10-22T08:00:00.000Z",
          revision: 1,
        };
        units = [...units, unit];
        return route.fulfill({
          status: 201,
          headers: { ETag: '"1"' },
          json: unit,
        });
      }

      if (method !== "GET" && request.headers()["x-csrf-token"] !== currentCsrf)
        return route.fulfill({
          status: 403,
          json: { error: "CSRF token rejected" },
        });
      if (resource === "projects") {
        const index = projects.findIndex((entry) => entry.id === id);
        if (index < 0)
          return route.fulfill({ status: 404, json: { error: "Not found" } });
        const current = projects[index];
        if (conflictTarget === "project-edit") {
          conflictTarget = null;
          projects[index] = {
            ...current,
            district: "ดินแดง",
            revision: current.revision + 1,
          };
          return route.fulfill({
            status: 409,
            json: { error: "Revision conflict" },
          });
        }
        if (request.headers()["if-match"] !== `"${current.revision}"`)
          return route.fulfill({
            status: 409,
            json: { error: "Revision conflict" },
          });
        const next = { ...current, ...body, revision: current.revision + 1 };
        projects[index] = next;
        return route.fulfill({
          headers: { ETag: `"${next.revision}"` },
          json: next,
        });
      }

      const index = units.findIndex((entry) => entry.id === id);
      if (index < 0)
        return route.fulfill({ status: 404, json: { error: "Not found" } });
      const current = units[index];
      const expected = request.headers()["if-match"];
      const operation = method === "PATCH" ? "unit-edit" : action;
      if (conflictTarget === operation) {
        conflictTarget = null;
        units[index] = {
          ...current,
          monthlyRentThb: 19500,
          revision: current.revision + 1,
        };
        return route.fulfill({
          status: 409,
          json: { error: "Revision conflict" },
        });
      }
      if (expected !== `"${current.revision}"`)
        return route.fulfill({
          status: 409,
          json: { error: "Revision conflict" },
        });

      let next = current;
      if (method === "PATCH") next = { ...current, ...body };
      if (method === "POST" && action === "publish")
        next = { ...current, publishedAt: "2026-10-22T08:05:00.000Z" };
      if (method === "POST" && action === "availability")
        next = { ...current, status: body.status };
      if (method === "POST" && action === "archive")
        next = { ...current, status: "archived" };
      next = {
        ...next,
        revision: current.revision + 1,
        factsUpdatedAt: "2026-10-22T08:05:00.000Z",
      };
      units[index] = next;
      return route.fulfill({
        headers: { ETag: `"${next.revision}"` },
        json: next,
      });
    },
  );

  return {
    requests,
    get csrfRequests() {
      return csrfRequests;
    },
    get currentCsrf() {
      return currentCsrf;
    },
    expireCsrf() {
      currentCsrf = "expired-by-server";
    },
    forceConflict(target = "unit-edit") {
      conflictTarget = target;
    },
    seedProject(project = projectSeed) {
      projects = [project];
    },
    seedUnit(unit = completeUnit) {
      unitSequence++;
      units = [
        {
          ...unit,
          id: `unit-${unitSequence}`,
          organizationId: "org_default",
          status: "available",
          publishedAt: "2026-10-22T08:00:00.000Z",
          factsUpdatedAt: "2026-10-22T08:00:00.000Z",
          revision: 2,
        },
      ];
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
  await page
    .getByLabel("รายละเอียดสำหรับลูกค้า")
    .fill(completeUnit.description);
}

test("inventory staff creates a project, validates publication, and publishes a grounded unit", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop inventory workflow");
  const fixture = await mockInventory(page);
  await page.goto("/properties");

  await expect(
    page.getByRole("heading", { name: "ห้องและโครงการ" }),
  ).toBeVisible();
  await fillProject(page);
  await expect(page.getByRole("treeitem", { name: /ไลฟ์ อโศก/ })).toBeVisible();

  await fillUnit(page, { complete: false });
  await page.getByRole("button", { name: "บันทึกและเผยแพร่" }).click();
  await expect(page.getByText("กรอกข้อมูลที่จำเป็นก่อนเผยแพร่")).toBeVisible();
  await expect(
    page
      .getByTestId("publication-errors")
      .getByText("ค่าเช่าต่อเดือน", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("ประเภทห้อง").selectOption("1 ห้องนอน");
  await page.getByLabel("ค่าเช่าต่อเดือน").fill("18000");
  await page.getByLabel("วันที่พร้อมเข้าอยู่").fill("2026-11-01");
  await page.getByLabel("นโยบายสัตว์เลี้ยง").selectOption("allowed");
  await page
    .getByLabel("รายละเอียดสำหรับลูกค้า")
    .fill(completeUnit.description);
  await page.getByRole("button", { name: "บันทึกและเผยแพร่" }).click();

  await expect(page.getByText("เผยแพร่แล้ว")).toBeVisible();
  await expect(page.getByRole("row", { name: /A-1207/ })).toBeVisible();
  expect(fixture.csrfRequests).toBeGreaterThan(0);
  expect(
    fixture.requests.some((entry) => entry.path.endsWith("/publish")),
  ).toBeTruthy();
  expect(
    fixture.requests
      .filter((entry) => entry.method !== "GET")
      .every((entry) => entry.headers["idempotency-key"]),
  ).toBeTruthy();
  expect(
    fixture.requests
      .filter((entry) => entry.method !== "GET")
      .every((entry) => entry.headers["x-csrf-token"] === fixture.currentCsrf),
  ).toBeTruthy();
});

test("an expired CSRF token is rotated once and the same mutation is retried safely", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop CSRF contract");
  const fixture = await mockInventory(page);
  await page.goto("/properties");
  await expect(
    page.getByRole("button", { name: "เพิ่มโครงการ" }),
  ).toBeVisible();
  await expect.poll(() => fixture.csrfRequests).toBe(1);
  fixture.expireCsrf();
  await fillProject(page);
  await expect(page.getByRole("treeitem", { name: /ไลฟ์ อโศก/ })).toBeVisible();

  const attempts = fixture.requests.filter(
    (entry) => entry.method === "POST" && entry.path === "/api/projects",
  );
  expect(fixture.csrfRequests).toBe(2);
  expect(attempts).toHaveLength(2);
  expect(attempts[0].headers["idempotency-key"]).toBe(
    attempts[1].headers["idempotency-key"],
  );
  expect(attempts[1].headers["x-csrf-token"]).toBe(fixture.currentCsrf);
});

test("inventory staff handles stale edits, changes availability, and keeps archived history discoverable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop inventory workflow");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");

  await expect(
    page
      .getByTestId("unit-table")
      .getByRole("row", { name: /โครงการ ไลฟ์ อโศก · 1 ห้อง/ }),
  ).toBeVisible();
  await page
    .getByRole("row", { name: /A-1207/ })
    .getByRole("button", { name: "แก้ไขห้อง A-1207" })
    .click();
  await page.getByLabel("ค่าเช่าต่อเดือน").fill("18500");
  fixture.forceConflict();
  await page.getByRole("button", { name: "บันทึกการเปลี่ยนแปลง" }).click();
  await expect(page.getByText("ข้อมูลห้องถูกแก้ไขจากที่อื่น")).toBeVisible();
  await page.getByRole("button", { name: "โหลดข้อมูลล่าสุด" }).click();
  await expect(page.getByLabel("ค่าเช่าต่อเดือน")).toHaveValue("19500");

  await page.getByRole("button", { name: "ปิดแผงแก้ไข" }).click();
  await page
    .getByRole("row", { name: /A-1207/ })
    .getByLabel("สถานะห้อง")
    .selectOption("held");
  await expect(
    page.getByRole("row", { name: /A-1207/ }).getByLabel("สถานะห้อง"),
  ).toHaveValue("held");

  await page
    .getByRole("row", { name: /A-1207/ })
    .getByRole("button", { name: "เมนูห้อง A-1207" })
    .click();
  const archiveMenuTrigger = page
    .getByRole("row", { name: /A-1207/ })
    .getByRole("button", { name: "เมนูห้อง A-1207" });
  await page.getByRole("menuitem", { name: "เก็บเข้าประวัติ" }).click();
  await page.getByRole("button", { name: "ยืนยันเก็บเข้าประวัติ" }).click();
  await expect(page.getByText("เก็บในประวัติแล้ว")).toBeVisible();
  await expect(archiveMenuTrigger).toBeFocused();
  await page.getByLabel("ตัวกรองสถานะ").selectOption("archived");
  await expect(page.getByRole("row", { name: /A-1207/ })).toBeVisible();
});

test("[mobile] inventory uses deliberate cards and protects unsaved edits", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile inventory workflow");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");

  await expect(page.getByTestId("unit-table")).toBeHidden();
  const card = page.getByTestId("unit-card").filter({ hasText: "A-1207" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "แก้ไขห้อง A-1207" }).click();
  await page
    .getByLabel("รายละเอียดสำหรับลูกค้า")
    .fill("เปลี่ยนรายละเอียดแต่ยังไม่บันทึก");
  await page.getByRole("button", { name: "ปิดแผงแก้ไข" }).click();
  await expect(
    page.getByRole("dialog", { name: "ยังไม่ได้บันทึก" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "กลับไปแก้ไข" }).click();
  await expect(page.getByLabel("รายละเอียดสำหรับลูกค้า")).toHaveValue(
    "เปลี่ยนรายละเอียดแต่ยังไม่บันทึก",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("project matching facts are editable and stale project revisions recover safely", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop project editing");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  await page.goto("/properties");

  await page.getByRole("button", { name: "แก้ไขโครงการ ไลฟ์ อโศก" }).click();
  await expect(page.getByLabel("เขต / อำเภอ")).toHaveValue("ราชเทวี");
  await expect(page.getByLabel("จังหวัด")).toHaveValue("กรุงเทพมหานคร");
  await expect(page.getByLabel("สถานีรถไฟฟ้าใกล้ที่สุด")).toHaveValue(
    "MRT เพชรบุรี",
  );
  await expect(page.getByLabel("ระยะเดินจากสถานี (เมตร)")).toHaveValue("300");
  await expect(page.getByLabel("สิ่งอำนวยความสะดวก")).toHaveValue(
    "สระว่ายน้ำ, ฟิตเนส",
  );

  await page.getByLabel("สถานีรถไฟฟ้าใกล้ที่สุด").fill("MRT พระราม 9");
  fixture.forceConflict("project-edit");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
  await expect(page.getByText("ข้อมูลโครงการถูกแก้ไขจากที่อื่น")).toBeVisible();
  await page.getByRole("button", { name: "โหลดโครงการล่าสุด" }).click();
  await expect(page.getByLabel("เขต / อำเภอ")).toHaveValue("ดินแดง");
  await page.getByLabel("สถานีรถไฟฟ้าใกล้ที่สุด").fill("MRT พระราม 9");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
  await expect(page.getByText("อัปเดตโครงการแล้ว")).toBeVisible();
  expect(
    fixture.requests.some(
      (entry) =>
        entry.method === "PATCH" &&
        entry.path === "/api/projects/project-asoke",
    ),
  ).toBeTruthy();
});

test("project editor round-trips and deliberately orders every transit station", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "desktop multi-station editing",
  );
  const fixture = await mockInventory(page);
  fixture.seedProject({
    ...projectSeed,
    transit: [
      { station: "MRT เพชรบุรี", walkingDistanceM: 300 },
      { station: "BTS อโศก", walkingDistanceM: 850 },
      { station: "ARL มักกะสัน", walkingDistanceM: 450 },
    ],
  });
  await page.goto("/properties");
  await page.getByRole("button", { name: "แก้ไขโครงการ ไลฟ์ อโศก" }).click();
  await expect(page.getByTestId("transit-row")).toHaveCount(3);
  await page.getByLabel("เขต / อำเภอ").fill("ห้วยขวาง");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
  await expect(page.getByText("อัปเดตโครงการแล้ว")).toBeVisible();
  const unrelatedUpdate = fixture.requests.findLast(
    (entry) => entry.method === "PATCH" && entry.path === "/api/projects/project-asoke",
  );
  expect(unrelatedUpdate.body.transit).toEqual([
    { station: "MRT เพชรบุรี", walkingDistanceM: 300 },
    { station: "BTS อโศก", walkingDistanceM: 850 },
    { station: "ARL มักกะสัน", walkingDistanceM: 450 },
  ]);

  await page.getByRole("button", { name: "แก้ไขโครงการ ไลฟ์ อโศก" }).click();
  await page.getByRole("button", { name: "เลื่อน ARL มักกะสัน ขึ้น" }).click();
  await page.getByRole("button", { name: "ลบสถานี BTS อโศก" }).click();
  await page.getByRole("button", { name: "เพิ่มสถานี" }).click();
  await page.getByLabel("สถานีรถไฟฟ้า 3").fill("BTS พร้อมพงษ์");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
  await expect(
    page.getByText("กรุณาระบุชื่อสถานีและระยะเดินเป็นจำนวนเต็มตั้งแต่ 0 เมตรขึ้นไป"),
  ).toBeVisible();
  await page.getByLabel("ระยะเดินสถานี 3 (เมตร)").fill("700");
  await page.getByRole("button", { name: "บันทึกโครงการ" }).click();
  await expect(page.getByText("อัปเดตโครงการแล้ว")).toBeVisible();

  const update = fixture.requests.findLast(
    (entry) =>
      entry.method === "PATCH" && entry.path === "/api/projects/project-asoke",
  );
  expect(update.body.district).toBe("ห้วยขวาง");
  expect(update.body.transit).toEqual([
    { station: "MRT เพชรบุรี", walkingDistanceM: 300 },
    { station: "ARL มักกะสัน", walkingDistanceM: 450 },
    { station: "BTS พร้อมพงษ์", walkingDistanceM: 700 },
  ]);
});

test("availability and archive conflicts offer entity refresh without lying about the result", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop conflict recovery");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");

  fixture.forceConflict("availability");
  await page
    .getByRole("row", { name: /A-1207/ })
    .getByLabel("สถานะห้อง")
    .selectOption("held");
  await expect(page.getByText("สถานะห้องถูกแก้ไขจากที่อื่น")).toBeVisible();
  await page.getByRole("button", { name: "โหลดห้องล่าสุด" }).click();
  await expect(
    page.getByRole("row", { name: /A-1207/ }).getByLabel("สถานะห้อง"),
  ).toHaveValue("available");

  await page
    .getByRole("row", { name: /A-1207/ })
    .getByRole("button", { name: "เมนูห้อง A-1207" })
    .click();
  await page.getByRole("menuitem", { name: "เก็บเข้าประวัติ" }).click();
  fixture.forceConflict("archive");
  await page.getByRole("button", { name: "ยืนยันเก็บเข้าประวัติ" }).click();
  const dialog = page.getByRole("dialog", { name: "เก็บห้องนี้เข้าประวัติ?" });
  await expect(dialog.getByText("ข้อมูลห้องถูกแก้ไขจากที่อื่น")).toBeVisible();
  await dialog.getByRole("button", { name: "โหลดข้อมูลล่าสุดและปิด" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row", { name: /A-1207/ })).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /A-1207/ })
      .getByRole("button", { name: "เมนูห้อง A-1207" }),
  ).toBeFocused();
});

test("project edit control keeps a 44px target without page overflow", async ({
  page,
}) => {
  const fixture = await mockInventory(page);
  fixture.seedProject();
  await page.goto("/properties");
  const edit = page.getByRole("button", { name: "แก้ไขโครงการ ไลฟ์ อโศก" });
  await expect(edit).toBeVisible();
  const box = await edit.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await edit.click();
  const undersized = await page
    .getByRole("dialog", { name: "แก้ไขโครงการ" })
    .locator("button, input, textarea")
    .evaluateAll((controls) =>
      controls
        .filter((control) => control.getClientRects().length)
        .map((control) => ({
          label: control.getAttribute("aria-label") || control.textContent?.trim(),
          width: control.getBoundingClientRect().width,
          height: control.getBoundingClientRect().height,
        }))
        .filter(({ width, height }) => width < 44 || height < 44),
    );
  expect(undersized).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("drawers trap focus, guard Escape, nest semantics, and restore the trigger", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop keyboard behavior");
  const fixture = await mockInventory(page);
  fixture.seedProject();
  fixture.seedUnit();
  await page.goto("/properties");
  const trigger = page
    .getByRole("row", { name: /A-1207/ })
    .getByRole("button", { name: "แก้ไขห้อง A-1207" });

  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "แก้ไขข้อมูลห้อง" });
  await expect(page.getByRole("button", { name: "ปิดแผงแก้ไข" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page
    .getByLabel("รายละเอียดสำหรับลูกค้า")
    .fill("แก้แล้วแต่ยังไม่บันทึก");
  await page.keyboard.press("Escape");
  const guard = page.getByRole("dialog", { name: "ยังไม่ได้บันทึก" });
  await expect(guard).toBeVisible();
  await expect(page.locator(".property-drawer")).toHaveAttribute("inert", "");
  await expect(
    guard.getByRole("button", { name: "กลับไปแก้ไข" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(guard).toBeHidden();
  await expect(page.getByRole("button", { name: "ปิดแผงแก้ไข" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "ทิ้งการเปลี่ยนแปลง" }).click();
  await expect(trigger).toBeFocused();
});

for (const role of ["admin", "inventory_manager"]) {
  test(`${role} receives inventory mutation controls`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop role behavior");
    const fixture = await mockInventory(page, { role });
    fixture.seedProject();
    fixture.seedUnit();
    await page.goto("/properties");
    await expect(
      page.getByRole("button", { name: "เพิ่มโครงการ" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "เพิ่มห้อง" }).first(),
    ).toBeEnabled();
    await expect.poll(() => fixture.csrfRequests).toBeGreaterThan(0);
  });
}

for (const role of ["operator", "viewer"]) {
  test(`${role} sees authoritative inventory in read-only mode`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop role behavior");
    const fixture = await mockInventory(page, { role });
    fixture.seedProject();
    fixture.seedUnit();
    await page.goto("/properties");
    await expect(page.getByText("โหมดอ่านอย่างเดียว")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "เพิ่มโครงการ" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "เพิ่มห้อง" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("row", { name: /A-1207/ }).getByLabel("สถานะห้อง"),
    ).toBeDisabled();
    expect(fixture.csrfRequests).toBe(0);
  });
}
