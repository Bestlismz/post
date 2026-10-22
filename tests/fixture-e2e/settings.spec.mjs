import { expect, test } from "@playwright/test";

test("fixture Settings uses stateful production-shaped APIs without exposing secrets", async ({ page, request }) => {
  const readiness = await request.get("/api/settings/readiness");
  expect(readiness.status()).toBe(200);
  const readinessBody = await readiness.json();
  expect(readinessBody.integrations).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "openai", status: "configured" }),
    expect.objectContaining({ id: "messenger", status: "missing" }),
  ]));
  expect(readinessBody.configuration.secretReadback).toBe(false);
  expect(JSON.stringify(readinessBody)).not.toMatch(/sk-proj-|fixture-token|fixture-secret/);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "การตั้งค่าระบบ" })).toBeVisible();
  await expect(page.getByText("OpenAI configured")).toBeVisible();
  await expect(page.getByText("Messenger missing")).toBeVisible();
  await page.getByLabel("ชื่อธุรกิจ").fill("Rental Radar Customer Demo");
  await page.getByRole("button", { name: "บันทึกข้อมูลธุรกิจ" }).click();
  await expect(page.getByText("บันทึกข้อมูลธุรกิจแล้ว")).toBeVisible();

  const saved = await request.get("/api/settings/business-profile");
  expect((await saved.json()).name).toBe("Rental Radar Customer Demo");
  const audit = await request.get("/api/settings/audit?correlationId=corr-send-18");
  expect((await audit.json()).entries).toEqual([expect.objectContaining({ action: "delivery.sent" })]);
});

test("fixture Settings validates retention and enforces role visibility", async ({ request }) => {
  const invalid = await request.patch("/api/settings/retention", {
    headers: { "X-CSRF-Token": "fixture-csrf", "Idempotency-Key": "fixture-invalid-retention", "If-Match": '"1"' },
    data: { rawPayloadDays: 0, screenshotDays: 7 },
  });
  expect(invalid.status()).toBe(422);
  const forbidden = await request.get("/api/settings/users", { headers: { "X-Fixture-Role": "viewer" } });
  expect(forbidden.status()).toBe(403);
});

test("fixture audit cursor is stable when a newer mutation arrives between pages", async ({ request }) => {
  const first = await request.get("/api/settings/audit?limit=1");
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.entries).toHaveLength(1);
  expect(firstBody.nextCursor).toBeTruthy();

  const profileResponse = await request.get("/api/settings/business-profile");
  const profile = await profileResponse.json();
  const changed = await request.patch("/api/settings/business-profile", {
    headers: { "X-CSRF-Token": "fixture-csrf", "Idempotency-Key": "fixture-between-pages", "If-Match": `"${profile.revision}"` },
    data: { name: "Inserted after first page", description: profile.description, relevanceThreshold: profile.relevanceThreshold },
  });
  expect(changed.status()).toBe(200);

  const second = await request.get(`/api/settings/audit?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.entries).toHaveLength(1);
  expect(secondBody.entries[0].id).not.toBe(firstBody.entries[0].id);
  expect(secondBody.entries[0].created_at <= firstBody.entries[0].created_at).toBe(true);
  expect((await request.get("/api/settings/audit?cursor=not-a-real-cursor")).status()).toBe(422);
});
