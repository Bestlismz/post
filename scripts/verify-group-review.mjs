import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

const base = process.env.BASE_URL || "http://127.0.0.1:3401";
const screenshotDir = process.env.SCREENSHOT_DIR || "/tmp/group-review-verification";
fs.mkdirSync(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const targets = [
  makeTarget("post", "post", "Mali", "หาห้องเช่าใกล้ BTS อ่อนนุช\nงบไม่เกิน 12,000 บาท"),
  makeTarget("verified", "comment", "Nok", "อยากได้ห้องใกล้สถานีค่ะ"),
  makeTarget("free", "comment", "Pim", "สนใจห้องที่เลี้ยงแมวได้ค่ะ"),
  makeTarget("unknown", "comment", "Som", "ขอดูรายละเอียดเพิ่มเติม"),
  makeTarget("attempted", "comment", "Dao", "ย้ายเข้าเดือนหน้าค่ะ"),
  makeTarget("context", "comment", "Comment author", "This comment must not become the original post.", { postId: "p2", postText: "Parent context without a captured author" }),
  makeTarget("long", "post", "Long content", `${"ทดสอบเนื้อหายาวภาษาไทย ".repeat(35)}\nhttps://example.com/${"verylongpath".repeat(30)}`, { postId: "p3" }),
];
const submissions = ["verified", "unknown", "attempted"].map((state) => ({ id: state, targetKey: state, state, exactText: `Exact ${state} response`, evidenceId: `evidence-${state}`, detail: "Captured app outcome", createdAt: "2026-10-21T08:00:00Z" }));
const workspace = { groups: [{ id: "g1", name: "Bangkok Room Finder" }], targets, submissions, analyses: [], drafts: [], messenger: { configured: false, enabled: false }, messengerThreads: [], messengerMessages: [], messengerOutbound: [], events: [], businessProfile: { relevanceThreshold: 60 }, config: {}, replyProfile: {}, browserOperation: { status: "idle" } };
const drafts = new Map();
const requests = [];
let reviewCount = 0;
let pendingPatch = null;
let pendingGenerate = null;
let delayPatch = false;
let delayGenerate = false;
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const body = request.postDataJSON();
  requests.push({ path, body, method: request.method() });
  let data;
  if (path === "/api/state") data = workspace;
  else if (path === "/api/drafts") {
    data = { id: `draft-${drafts.size}`, targetKey: body.targetKey, text: `Draft for ${body.targetKey}`, revision: 1 };
    drafts.set(data.id, data);
    if (delayGenerate) await new Promise((resolve) => { pendingGenerate = resolve; });
  } else if (request.method() === "PATCH" && path.startsWith("/api/drafts/")) {
    const draft = drafts.get(path.split("/").at(-1));
    data = { ...draft, text: body.text, revision: draft.revision + 1 };
    drafts.set(data.id, data);
    if (delayPatch) await new Promise((resolve) => { pendingPatch = resolve; });
  } else if (path.endsWith("/review")) {
    const draft = drafts.get(path.split("/").at(-2));
    data = { targetKey: draft.targetKey, token: `token-${++reviewCount}`, target: { ...targets.find((target) => target.key === draft.targetKey), groupName: "Snapshot group name" }, exactText: draft.text };
  } else if (path === "/api/submit") {
    data = { id: "mock-attempt", targetKey: "free", state: "unknown", exactText: drafts.get("draft-0").text, detail: "Mocked outcome remains unconfirmed", evidenceId: "mock-evidence" };
    submissions.push(data);
  } else return route.abort();
  await route.fulfill({ json: data });
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(base);
  await page.getByRole("button", { name: "Reply review", exact: true }).click();
  await shot("empty");
  await choose("p1");
  assert.equal(await page.locator(".fb-comments > li").count(), 4);
  assert.equal(await page.locator(".fb-composer").count(), 1);
  assert.equal(await page.locator(".fb-submission.is-unconfirmed .fb-comment-bubble").count(), 0);
  assert.equal(await page.locator(".fb-submission.is-verified .fb-comment-bubble").count(), 1);
  assert.equal(await page.getByText("Attempt in progress", { exact: true }).count(), 1);
  await shot("post-and-outcomes");
  await page.getByRole("button", { name: /^Reply to comment by Pim/ }).click();
  await page.getByRole("button", { name: "Generate reply draft" }).click();
  await page.getByLabel("Replying to Pim").fill("Exact edited reply\nSecond line");
  await shot("inline-draft");
  await page.getByRole("button", { name: "Review exact reply" }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(requests.filter((item) => item.path === "/api/submit").length, 0);
  assert.match(await page.getByRole("dialog").innerText(), /Snapshot group name/);
  assert.equal(await page.locator(".app-shell").evaluate((element) => element.inert), true);
  assert.equal(await page.getByRole("dialog").getByLabel("Exact message").inputValue(), "Exact edited reply\nSecond line");
  await page.getByLabel("I confirm this exact reply and destination").check();
  await shot("immutable-review");
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertFits();
    await shot(`immutable-review-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.textContent === "Review exact reply");
  await page.getByRole("button", { name: "Review exact reply" }).click();
  assert.equal(await page.getByLabel("I confirm this exact reply and destination").isChecked(), false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^Reply to comment by Nok/ }).click();
  assert.equal(await page.locator(".fb-composer").count(), 0);
  await page.getByRole("button", { name: /^Reply to comment by Pim/ }).click();
  assert.equal(await page.getByRole("button", { name: "Generate reply draft" }).count(), 1);
  await page.getByRole("button", { name: "Generate reply draft" }).click();
  await page.getByLabel("Replying to Pim").waitFor();
  await page.getByRole("button", { name: "Review exact reply" }).click();
  await page.getByLabel("I confirm this exact reply and destination").check();
  await page.getByRole("button", { name: "Send once", exact: true }).click();
  await page.getByText("Mocked outcome remains unconfirmed", { exact: true }).waitFor();
  const sends = requests.filter((item) => item.path === "/api/submit");
  assert.equal(sends.length, 1);
  assert.deepEqual(Object.keys(sends[0].body).sort(), ["confirmed", "token"]);
  assert.equal(await page.locator(".fb-composer").count(), 0);
  await page.reload();
  await page.getByRole("button", { name: "Reply review", exact: true }).click();
  await choose("p1");
  await page.getByRole("button", { name: /^Reply to comment by Pim/ }).click();
  assert.equal(await page.locator(".fb-composer").count(), 0);
  assert.equal(requests.filter((item) => item.path === "/api/submit").length, 1);
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertFits();
    await shot(`outcomes-${width}`);
    await choose("p2");
    assert.equal(await page.locator(".fb-post-header b").innerText(), "Original post");
    assert.equal(await page.getByRole("button", { name: /^Reply to post/ }).count(), 0);
    await assertFits();
    await shot(`context-${width}`);
    await choose("p3");
    await assertFits();
    await shot(`long-${width}`);
    await choose("p1");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await choose("p2");
  delayGenerate = true;
  await page.getByRole("button", { name: "Generate reply draft" }).click();
  await waitUntil(() => !!pendingGenerate);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Reply review", exact: true }).click();
  pendingGenerate();
  delayGenerate = false;
  await choose("p3");
  assert.equal(await page.getByRole("button", { name: "Generate reply draft" }).count(), 1);
  await page.getByRole("button", { name: "Generate reply draft" }).click();
  await page.getByLabel("Replying to Long content").fill("Edit before delayed save");
  delayPatch = true;
  const reviewsBefore = reviewCount;
  await page.getByRole("button", { name: "Review exact reply" }).click();
  await waitUntil(() => !!pendingPatch);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  pendingPatch();
  delayPatch = false;
  await page.waitForLoadState("networkidle");
  assert.equal(reviewCount, reviewsBefore, "An unmounted workflow must not issue its next review request");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, mockedSubmitRequests: sends.length, realSubmitRequests: 0, screenshots: screenshotDir, assertions: "siblings, exact review, confirmation reset, focus, per-target locks, reload, mobile, stale generate/save" }));
} finally { await browser.close(); }

function makeTarget(key, kind, author, text, extra = {}) {
  return { key, kind, author, text, groupId: "g1", postId: "p1", commentId: kind === "comment" ? key : null, postText: "Captured parent text", url: `https://www.facebook.com/groups/100/posts/200/${kind === "comment" ? `?comment_id=${key}` : ""}`, ...extra };
}
async function choose(postId) { await page.getByLabel("Choose conversation").selectOption(JSON.stringify(["g1", postId])); }
async function shot(name) { await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: await page.getByRole("dialog").count() === 0 }); }
async function assertFits() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Page overflows at ${page.viewportSize().width}px`); }
async function waitUntil(predicate) { for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("Delayed request did not begin"); }
