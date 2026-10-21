import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = "http://127.0.0.1:3000";
const groupUrl = `${baseUrl}/fixture/groups/1001`;

await waitFor(`${baseUrl}/health`);
const browser = await connectBrowser();
const context = browser.contexts()[0];
const fixturePage = context.pages()[0] ?? await context.newPage();
await fixturePage.goto(`${baseUrl}/fixture/login`, { waitUntil: "domcontentloaded" });
if (await fixturePage.getByRole("button", { name: "Continue as Fixture Admin" }).count()) {
  await fixturePage.getByRole("button", { name: "Continue as Fixture Admin" }).click();
  await fixturePage.waitForURL("**/fixture/groups/1001");
}

await api("/api/group", { method: "POST", body: { url: groupUrl } });
const scan = await api("/api/scan", { method: "POST", body: {} });
assert.ok(scan.targets.length >= 5, "scan returns post and comment targets");
const target = scan.targets.find((item) => item.key === "fixture:1001:p1:post");
assert.ok(target, "fixture post target is present");

let state = await api("/api/state");
let submission = state.submissions.find((item) => item.targetKey === target.key);
if (!submission) {
  submission = await createAndSubmit(target.key, "ข้อความตรวจสอบ POC ที่แก้ไขโดยผู้ใช้");
  assert.equal(submission.state, "verified", "first submit is visibly verified");
}

const repliesBefore = await api("/fixture/api/state");
const matchingBefore = repliesBefore.replies.filter((reply) => reply.targetKey === target.key);
assert.equal(matchingBefore.length, 1, "target has exactly one fixture reply");

const replay = await createAndSubmit(target.key, "ข้อความใหม่ที่ต้องไม่ถูกส่งซ้ำ");
assert.equal(replay.id, submission.id, "second confirmation returns the original reservation");
const repliesAfter = await api("/fixture/api/state");
assert.equal(repliesAfter.replies.filter((reply) => reply.targetKey === target.key).length, 1, "duplicate confirmation creates no second reply");

const dashboard = await context.newPage();
await dashboard.goto(baseUrl, { waitUntil: "networkidle" });
await dashboard.setViewportSize({ width: 1440, height: 1000 });
await dashboard.getByRole("button", { name: /Fixture mode/ }).click();
await dashboard.getByRole("button", { name: /Nok Comment/ }).click();
await dashboard.getByRole("button", { name: "Generate reply draft" }).click();
await dashboard.getByRole("button", { name: "Review exact reply" }).click();
await dashboard.getByRole("dialog").waitFor({ state: "visible" });
await dashboard.screenshot({ path: "/state/evidence/dashboard.png", fullPage: true });

console.log(JSON.stringify({
  ok: true,
  targets: scan.targets.length,
  submissionState: replay.state,
  duplicateReplyCount: repliesAfter.replies.filter((reply) => reply.targetKey === target.key).length,
  dashboardScreenshot: "/state/evidence/dashboard.png",
}));
await browser.close();

async function createAndSubmit(targetKey, exactText) {
  const draft = await api("/api/drafts", { method: "POST", body: { targetKey } });
  const edited = await api(`/api/drafts/${draft.id}`, { method: "PATCH", body: { text: exactText, revision: draft.revision } });
  const review = await api(`/api/drafts/${draft.id}/review`, { method: "POST", body: { revision: edited.revision } });
  assert.equal(review.exactText, exactText, "review freezes the exact edited message");
  return api("/api/submit", { method: "POST", body: { token: review.token, confirmed: true } });
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("POC did not become healthy");
}

async function connectBrowser() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await chromium.connectOverCDP("http://127.0.0.1:9222");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Chromium CDP did not become ready");
}

