import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const base = process.env.BASE_URL || "http://127.0.0.1:3000";
await waitFor(`${base}/health`);
const browser = await chromium.connectOverCDP(process.env.CHROME_CDP_URL || "http://127.0.0.1:9222");
const context = browser.contexts()[0], page = context.pages()[0] ?? await context.newPage();
await page.goto(`${base}/fixture/login`); if (await page.getByRole("button", { name: "Continue as Fixture Admin" }).count()) await page.getByRole("button", { name: "Continue as Fixture Admin" }).click();
for (const id of ["1001", "1002"]) await api("/api/groups", { method: "POST", body: { url: `${base}/fixture/groups/${id}` } });
const before = await api("/api/state"), result = await api("/api/groups/scan-all", { method: "POST", body: {} }), state = await api("/api/state");
assert.equal(result.completed, 2); assert.ok(state.targets.some((x) => x.groupId === "1001")); assert.ok(state.targets.some((x) => x.groupId === "1002"));
assert.ok(state.analyses.some((x) => x.intent === "tenant_lead")); assert.ok(state.analyses.some((x) => ["owner_lead", "listing"].includes(x.intent)));
assert.deepEqual(state.submissions, before.submissions, "Group scan never sends replies automatically");
const scores = state.analyses.map((x) => x.score).sort((a,b) => b-a); assert.ok(scores[0] >= scores.at(-1));
console.log(JSON.stringify({ ok: true, groups: state.groups.length, targets: state.targets.length, analyzed: state.analyses.length, automaticGroupReplies: 0 })); await browser.close();
async function api(path, options={}) { const response=await fetch(base+path,{...options,headers:{"Content-Type":"application/json"},body:options.body===undefined?undefined:JSON.stringify(options.body)});const data=await response.json();if(!response.ok)throw new Error(`${path}: ${data.error}`);return data; }
async function waitFor(url) { for(let i=0;i<60;i++){try{if((await fetch(url)).ok)return}catch{}await new Promise(r=>setTimeout(r,1000))}throw new Error("App did not become healthy"); }
