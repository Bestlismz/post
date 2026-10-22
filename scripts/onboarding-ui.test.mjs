import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retryOnceWithFreshCsrf } from "../app/lib/csrf-retry.mjs";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production image contains every server runtime module tree", async () => {
  const dockerfile = await source("Dockerfile");
  for (const directory of ["src/sources", "src/automation"]) assert.ok(dockerfile.includes(`COPY ${directory} ./${directory}`));
});

test("protected UI has a real app login and keeps Facebook credentials out of the form", async () => {
  const [shell, login] = await Promise.all([source("app/components/app-shell.jsx"), source("app/login/page.jsx")]);
  assert.match(shell, /router\.replace\(`\/login\?next=/);
  assert.match(login, /\/api\/auth\/login/);
  assert.match(login, /รหัสผ่านของบัญชีแอป/);
  assert.doesNotMatch(login, /facebookPassword|facebook_password/i);
});

test("customer fixture supports the app login screen with dedicated non-Facebook credentials", async () => {
  const fixture = await source("src/fixture-server.mjs");
  assert.match(fixture, /app\.post\("\/api\/auth\/login"/);
  assert.match(fixture, /FIXTURE_APP_EMAIL/);
  assert.doesNotMatch(fixture, /bestlismzwp|sk-proj-/i);
});

test("Meta callback scrubs provider query before the protected completion request", async () => {
  const callback = await source("app/settings/meta/callback/page.jsx");
  const scrub = callback.indexOf('window.history.replaceState({}, "", "/settings/meta/callback")');
  const exchange = callback.indexOf('api.request("/api/meta/connection/callback"');
  assert.ok(scrub >= 0 && exchange > scrub);
  assert.match(callback, /\/api\/auth\/csrf/);
  assert.doesNotMatch(callback, /localStorage|sessionStorage/);
});

test("Sources exposes Page connect select health and disconnect operations", async () => {
  const sources = await source("app/sources/page.jsx");
  for (const route of ["/api/meta/connection/begin", "/pages", "/select", "/health", "/disconnect"]) assert.ok(sources.includes(route));
  assert.match(sources, /target\.hostname !== "www\.facebook\.com"/);
});

test("Inbox mutation policy retries a stale cross-tab CSRF token exactly once", async () => {
  const calls = [], refreshed = [];
  const result = await retryOnceWithFreshCsrf({ token: "stale", request: async (token) => { calls.push(token); if (token === "stale") throw Object.assign(new Error("rejected"), { status: 403 }); return "ok"; }, refresh: async () => "fresh", onRefresh: (token) => refreshed.push(token) });
  assert.equal(result, "ok"); assert.deepEqual(calls, ["stale", "fresh"]); assert.deepEqual(refreshed, ["fresh"]);
  let attempts = 0;
  await assert.rejects(retryOnceWithFreshCsrf({ token: "current", request: async () => { attempts++; throw Object.assign(new Error("conflict"), { status: 409 }); }, refresh: async () => { throw new Error("must not refresh"); } }), /conflict/);
  assert.equal(attempts, 1);
});
