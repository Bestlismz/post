import { expect, test } from "@playwright/test";

const queue = [
  {
    id: "group_1",
    conversationId: "group-conversation",
    channel: "facebook_group",
    processingRevision: 3,
    status: "needs_review",
    createdAt: "2026-10-22T07:26:00.000000Z",
    participant: { id: "mint", label: "Mint Kanyarat" },
    source: { id: "asoke-rentals", name: "คอนโดให้เช่า กรุงเทพฯ", health: "connected" },
    message: { id: "group-post", text: "หาคอนโดใกล้ BTS อโศก งบไม่เกิน 20,000 บาท 1 ห้องนอน เลี้ยงแมวได้ค่ะ https://facebook.com/groups/very-long-group-address-that-must-wrap/posts/123" },
  },
  {
    id: "messenger_1",
    conversationId: "messenger-conversation",
    channel: "messenger",
    processingRevision: 2,
    status: "pending",
    createdAt: "2026-10-22T06:10:00.000000Z",
    participant: { id: "nattapong", label: "Nattapong S." },
    source: { id: "page-source", name: "Rental Radar Page", health: "connected" },
    message: { id: "messenger-message", text: "มีห้องว่างปลายพฤศจิกายนไหมครับ" },
  },
  {
    id: "stale_1",
    conversationId: "stale-conversation",
    channel: "facebook_group",
    processingRevision: 7,
    status: "superseded",
    createdAt: "2026-10-22T05:00:00.000000Z",
    participant: { id: "stale", label: "Ployphailin" },
    source: { id: "asoke-rentals", name: "คอนโดให้เช่า กรุงเทพฯ", health: "connected" },
    message: { id: "stale-post", text: "ขอรายละเอียดเพิ่มได้ไหมคะ" },
  },
  {
    id: "partial_1",
    conversationId: "partial-conversation",
    channel: "messenger",
    processingRevision: 1,
    status: "pending",
    createdAt: "2026-10-22T04:00:00.000000Z",
    participant: { id: "partial", label: "Worachet" },
    source: { id: "page-source", name: "Rental Radar Page", health: "connected" },
    message: { id: "partial-message", text: "สนใจห้องใกล้รถไฟฟ้าครับ" },
  },
];

const groupDetail = {
  ...queue[0],
  target: { kind: "post", author: "Mint Kanyarat", groupName: "คอนโดให้เช่า กรุงเทพฯ" },
  timeline: [
    { id: "post", direction: "inbound", author: "Mint Kanyarat", text: queue[0].message.text, createdAt: queue[0].createdAt },
    { id: "comment", direction: "inbound", author: "Beam S.", text: "ลองดูแถวอโศก-เพชรบุรีค่ะ มีเยอะเลย", createdAt: "2026-10-22T07:33:00.000000Z", kind: "comment" },
  ],
  requirements: { district: "อโศก", budgetMax: 20000, bedrooms: 1, requiredPetPolicy: "allowed", moveInDate: null },
  missingRequirements: ["moveInDate"],
  matches: [
    { unitId: "life-a1207", projectName: "Life Asoke", unitCode: "A-1207-LONG-UNIT-CODE-WRAPS-SAFELY", monthlyRentThb: 18000, bedrooms: 1, areaSqm: 35, floor: 12, petPolicy: "allowed", transit: ["MRT เพชรบุรี 300 ม."], availableFrom: "2026-11-01", factsUpdatedAt: "2026-10-22T06:28:00.000Z", score: 96 },
  ],
  replies: [{ id: "reply-1", version: 1, processingRevision: 3, text: "สวัสดีค่ะคุณมิ้นท์ ทางเรามีห้องที่ตรงกับความต้องการที่ Life Asoke ราคา 18,000 บาทต่อเดือน เลี้ยงแมวได้ค่ะ กรุณายืนยันห้องว่างกับทีมงานอีกครั้งนะคะ" }],
  deliveries: [],
  events: [],
};

const messengerDetail = {
  ...queue[1],
  timeline: [
    { id: "m1", direction: "inbound", author: "Nattapong S.", text: "สวัสดีครับ สนใจห้อง Life Asoke", createdAt: "2026-10-22T06:00:00.000000Z" },
    { id: "m2", direction: "outbound", author: "ทีม Rental Radar", text: "ยินดีช่วยตรวจสอบให้ค่ะ ต้องการย้ายเข้าช่วงไหนคะ", createdAt: "2026-10-22T06:04:00.000000Z" },
    { id: "m3", direction: "inbound", author: "Nattapong S.", text: queue[1].message.text, createdAt: queue[1].createdAt },
  ],
  requirements: { district: "อโศก", budgetMax: null, bedrooms: null, requiredPetPolicy: null, moveInDate: "2026-11-25" },
  missingRequirements: ["budgetMax", "bedrooms"],
  matches: [], replies: [], deliveries: [], events: [],
};

async function mockInbox(page) {
  let partialAttempts = 0;
  const commands = [];
  await page.route("**/health", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (route) => route.fulfill({ json: { user: { displayName: "ณัฐวุฒิ", role: "admin" }, csrfToken: "test-csrf" } }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({ json: { csrfToken: "test-csrf" } }));
  await page.route("**/api/inbox/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }));
  await page.route("**/api/inbox", (route) => route.fulfill({ json: { items: queue, nextCursor: null } }));
  await page.route(/\/api\/inbox\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === "partial_1" && partialAttempts++ === 0) return route.fulfill({ status: 503, json: { error: "upstream timeout" } });
    const detail = id === "messenger_1" ? messengerDetail : id === "stale_1" ? { ...groupDetail, ...queue[2], stale: true, staleReason: "มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุด" } : id === "partial_1" ? { ...messengerDetail, ...queue[3] } : groupDetail;
    return route.fulfill({ json: detail });
  });
  await page.route(/\/api\/inbox\/[^/]+\/(prepare|handoff)$/, async (route) => {
    commands.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 202, json: { operation: { receiptId: `receipt-${commands.length}`, resourceId: "group_1", resourceType: "work_item", state: "queued" } } });
  });
  await page.route(/\/api\/replies\/[^/]+\/(edit|approve)$/, async (route) => {
    commands.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    const editing = new URL(route.request().url()).pathname.endsWith("/edit");
    await route.fulfill({ status: editing ? 200 : 202, json: editing ? { reply: { id: "reply-2", version: 2, text: route.request().postDataJSON().text } } : { operation: { receiptId: `receipt-${commands.length}`, resourceId: "delivery-1", resourceType: "delivery_intent", state: "queued" } } });
  });
  return { commands };
}

test("one workspace renders Group context, grounded facts, and one exact composer", async ({ page }) => {
  const fixture = await mockInbox(page);
  await page.goto("/inbox?item=group_1");

  await expect(page.getByText("โพสต์จากกลุ่ม")).toBeVisible();
  await expect(page.getByText("ความคิดเห็นทั้งหมด (1)")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "ความต้องการ" })).toBeVisible();
  await expect(page.getByText("Life Asoke", { exact: true })).toBeVisible();
  await expect(page.getByText("A-1207-LONG-UNIT-CODE-WRAPS-SAFELY")).toBeVisible();

  const exact = "สวัสดีค่ะคุณมิ้นท์ ห้อง Life Asoke ราคา 18,000 บาทต่อเดือนยังอยู่ในรายการปัจจุบันค่ะ";
  await page.getByRole("textbox", { name: "ข้อความตอบกลับ" }).fill(exact);
  await page.getByRole("button", { name: "อนุมัติและส่ง" }).click();
  await expect(page.getByText("บันทึกข้อความฉบับนี้แล้ว")).toBeVisible();
  await expect.poll(() => fixture.commands.some((entry) => entry.body?.text === exact)).toBeTruthy();
  await expect.poll(() => fixture.commands.some((entry) => entry.path.endsWith("/approve"))).toBeTruthy();
  await expect(page.locator("body")).toHaveCSS("overflow-x", "clip");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
});

test("Messenger reuses the timeline, composer, and human handoff", async ({ page }) => {
  const fixture = await mockInbox(page);
  await page.goto("/inbox?item=messenger_1");
  await expect(page.getByText("ข้อความจากเพจ")).toBeVisible();
  await expect(page.getByText("ทีม Rental Radar")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "ข้อความตอบกลับ" })).toHaveCount(1);
  await page.getByRole("button", { name: "ส่งให้ทีมดูแล" }).click();
  await expect(page.getByText("ส่งต่อให้ทีมแล้ว")).toBeVisible();
  await expect.poll(() => fixture.commands.some((entry) => entry.path.endsWith("/handoff"))).toBeTruthy();
});

test("stale work is blocked and a failed detail region retries without losing the queue", async ({ page }) => {
  await mockInbox(page);
  await page.goto("/inbox?item=stale_1");
  await expect(page.getByText("ข้อมูลชุดนี้ไม่ใช่เวอร์ชันล่าสุด")).toBeVisible();
  await expect(page.getByRole("button", { name: "อนุมัติและส่ง" })).toBeDisabled();
  await expect(page.getByText("มีข้อความหรือข้อมูลห้องที่ใหม่กว่า กรุณาโหลดข้อมูลล่าสุด")).toBeVisible();

  await page.getByRole("button", { name: /Worachet/ }).click();
  await expect(page.getByRole("button", { name: "ลองโหลดรายละเอียดอีกครั้ง" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mint Kanyarat/ })).toBeVisible();
  await page.getByRole("button", { name: "ลองโหลดรายละเอียดอีกครั้ง" }).click();
  await expect(page.getByText("สนใจห้องใกล้รถไฟฟ้าครับ")).toBeVisible();
});

test("SSE receipts refresh only the selected region", async ({ page }) => {
  await page.addInitScript(() => {
    class FixtureEventSource {
      constructor() {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ receiptId: "r-1", resourceId: "group_1", resourceType: "work_item", state: "ready" }), lastEventId: "12" }), 80);
      }
      close() {}
      addEventListener(type, listener) { if (type === "inbox") this.onmessage = listener; }
    }
    window.EventSource = FixtureEventSource;
  });
  await mockInbox(page);
  await page.goto("/inbox?item=group_1");
  await expect(page.getByText("อัปเดตแล้ว")).toBeVisible();
});
