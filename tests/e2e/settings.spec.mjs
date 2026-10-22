import { expect, test } from "@playwright/test";

const privateToken = "sk-proj-super-secret-never-render";

async function mockSettings(page, { role = "admin" } = {}) {
  let profile = { name: "Rental Radar Thailand", description: "บริการหาคอนโดเช่าใกล้รถไฟฟ้า", relevanceThreshold: 72, revision: 1 };
  let retention = { rawPayloadDays: 30, screenshotDays: 7, revision: 1 };
  let users = [
    { id: "admin-1", email: "admin@rentalradar.test", displayName: "ณัฐวุฒิ", role: "admin", revision: 1 },
    { id: "operator-1", email: "ops@rentalradar.test", displayName: "พิมพ์ชนก", role: "operator", revision: 2 },
  ];
  const requests = [];
  const audits = [
    { id: "audit-3", actor_id: "admin-1", actor_name: "ณัฐวุฒิ", action: "settings.profile_changed", entity_type: "organization", entity_id: "org_default", details: { revision: 2, correlationId: "corr-profile-02" }, created_at: "2026-10-22T10:30:00.000Z" },
    { id: "audit-2", actor_id: "operator-1", actor_name: "พิมพ์ชนก", action: "delivery.sent", entity_type: "delivery_intent", entity_id: "delivery-18", details: { attemptId: "corr-send-18" }, created_at: "2026-10-22T09:30:00.000Z" },
    { id: "audit-1", actor_id: "admin-1", actor_name: "ณัฐวุฒิ", action: "user.role_changed", entity_type: "user", entity_id: "operator-1", details: { role: "operator" }, created_at: "2026-10-22T08:30:00.000Z" },
  ];

  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { id: `${role}-1`, displayName: role === "admin" ? "ณัฐวุฒิ" : "ผู้ชม", role } } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "settings-csrf" } }));
  await page.route(/\/api\/settings(?:\/.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    requests.push({ path, method, body: request.postDataJSON?.(), headers: request.headers() });
    if (role !== "admin") return route.fulfill({ status: 403, json: { error: "Role does not permit this action" } });
    if (method === "GET" && path.endsWith("/users")) return route.fulfill({ json: { users } });
    if (method === "GET" && path.endsWith("/business-profile")) return route.fulfill({ headers: { ETag: `"${profile.revision}"` }, json: profile });
    if (method === "GET" && path.endsWith("/retention")) return route.fulfill({ headers: { ETag: `"${retention.revision}"` }, json: retention });
    if (method === "GET" && path.endsWith("/readiness")) return route.fulfill({ json: {
      databaseConfigured: true,
      openaiConfigured: true,
      messengerConfigured: false,
      groupWorkerConfigured: true,
      missing: ["META_APP_SECRET"],
      integrations: [
        { id: "database", label: "Database", status: "configured" },
        { id: "openai", label: "OpenAI", status: "configured" },
        { id: "messenger", label: "Messenger", status: "missing", missing: ["META_APP_SECRET"] },
        { id: "group-worker", label: "Group worker", status: "configured" },
      ],
      configuration: { method: "deployment_environment", secretReadback: false },
      diagnostic: privateToken,
    } });
    if (method === "GET" && path.endsWith("/audit")) {
      const correlation = url.searchParams.get("correlationId");
      const action = url.searchParams.get("action");
      const cursor = url.searchParams.get("cursor");
      let filtered = audits.filter((entry) => !correlation || JSON.stringify(entry).includes(correlation));
      if (action) filtered = filtered.filter((entry) => entry.action === action);
      if (cursor) filtered = filtered.slice(2);
      return route.fulfill({ json: { entries: cursor ? filtered : filtered.slice(0, 2), nextCursor: cursor || filtered.length <= 2 ? null : "cursor-page-2" } });
    }
    if (method === "PATCH" && path.endsWith("/business-profile")) {
      profile = { ...request.postDataJSON(), revision: profile.revision + 1 };
      return route.fulfill({ headers: { ETag: `"${profile.revision}"` }, json: profile });
    }
    if (method === "PATCH" && path.endsWith("/retention")) {
      const body = request.postDataJSON();
      if (body.rawPayloadDays < 1 || body.screenshotDays < 1) return route.fulfill({ status: 422, json: { error: "Invalid request", fieldErrors: { rawPayloadDays: ["Too small"] } } });
      retention = { ...body, revision: retention.revision + 1 };
      return route.fulfill({ headers: { ETag: `"${retention.revision}"` }, json: retention });
    }
    if (method === "PATCH" && path.includes("/users/")) {
      const id = path.split("/").at(-1);
      users = users.map((user) => user.id === id ? { ...user, role: request.postDataJSON().role, revision: user.revision + 1 } : user);
      return route.fulfill({ json: users.find((user) => user.id === id) });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { requests };
}

test("admin Settings updates profile and role with safe concurrency headers", async ({ page }) => {
  const fixture = await mockSettings(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "การตั้งค่าระบบ" })).toBeVisible();
  await expect(page.getByText("admin@rentalradar.test")).toBeVisible();
  await page.getByLabel("สิทธิ์ของ พิมพ์ชนก").selectOption("inventory_manager");
  await expect(page.getByText("อัปเดตสิทธิ์แล้ว")).toBeVisible();
  await page.getByLabel("ชื่อธุรกิจ").fill("Rental Radar Premium");
  await page.getByRole("button", { name: "บันทึกข้อมูลธุรกิจ" }).click();
  await expect(page.getByText("บันทึกข้อมูลธุรกิจแล้ว")).toBeVisible();
  const writes = fixture.requests.filter((entry) => entry.method === "PATCH");
  expect(writes.every((entry) => entry.headers["x-csrf-token"] === "settings-csrf")).toBeTruthy();
  expect(writes.every((entry) => Boolean(entry.headers["idempotency-key"]))).toBeTruthy();
  expect(writes.every((entry) => Boolean(entry.headers["if-match"]))).toBeTruthy();
});

test("retention validation, audit correlation pagination, and readiness never reveal secrets", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/settings");
  await expect(page.getByText("OpenAI configured")).toBeVisible();
  await expect(page.getByText("Messenger missing")).toBeVisible();
  await expect(page.getByText(privateToken)).toHaveCount(0);
  await expect(page.getByText(/sk-proj-/)).toHaveCount(0);
  await expect(page.getByText("ค่าลับจะไม่ถูกแสดงย้อนกลับ")).toBeVisible();

  await page.getByLabel("เก็บ payload ดิบ (วัน)").fill("0");
  await page.getByRole("button", { name: "บันทึกระยะเวลา" }).click();
  await expect(page.getByText("กรุณาระบุ 1–3,650 วัน")).toBeVisible();

  await page.getByLabel("ค้นหา correlation ID").fill("corr-send-18");
  await page.getByRole("button", { name: "ค้นหาบันทึก" }).click();
  await expect(page.getByText("corr-send-18")).toBeVisible();
  await page.getByLabel("ค้นหา correlation ID").fill("");
  await page.getByRole("button", { name: "ค้นหาบันทึก" }).click();
  await page.getByRole("button", { name: "โหลดเพิ่มเติม" }).click();
  await expect(page.getByRole("region", { name: "Audit ledger" }).getByText("user.role_changed")).toBeVisible();
});

test("non-admin sees a deliberate permission state and mobile never overflows", async ({ page }) => {
  await mockSettings(page, { role: "viewer" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "การตั้งค่าสำหรับผู้ดูแลระบบ" })).toBeVisible();
  await expect(page.getByText("ข้อมูลกิจกรรมของรายการยังดูได้จาก Inbox")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});

test("Settings keeps long Thai administration data inside every supported viewport", async ({ page }) => {
  await mockSettings(page);
  for (const width of [1440, 1280, 1024, 768, 430, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "การตั้งค่าระบบ" })).toBeVisible();
    expect(await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))).toEqual({ scroll: width, client: width });
  }
  const buttons = await page.locator(".settings-page button:visible").evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(buttons.every((height) => height >= 44)).toBeTruthy();
});
