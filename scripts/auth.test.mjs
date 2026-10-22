import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrl, httpFixture } from "./http-test-helpers.mjs";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("production starts without importing JSON state, browser or fixture modules", { skip: !databaseUrl }, async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const runtime = await mkdtemp(path.join(tmpdir(), "radar-production-"));
  await cp(path.join(root, "src"), path.join(runtime, "src"), { recursive: true });
  await cp(path.join(root, "package.json"), path.join(runtime, "package.json"));
  await symlink(path.join(root, "node_modules"), path.join(runtime, "node_modules"));
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/\\/(?:demo|messenger-fixture|state|browser|fixture-server)\\.mjs$/.test(specifier)) throw new Error('PRODUCTION_IMPORT_FORBIDDEN ' + specifier);
      return next(specifier, context);
    }});
    await import('./src/server.mjs');`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { cwd: runtime, env: { ...process.env, NODE_ENV: "production", POC_MODE: "fixture", DATABASE_URL: databaseUrl, APP_ORIGIN: "https://radar.example", SESSION_SECRET: "s".repeat(32), PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 20000);
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(output)); });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /Application listening on .*:(\d+)/.exec(output);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    for (const path of ["/api/demo/seed", "/api/state", "/fixture/login", "/novnc/"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.includes("seed") ? "POST" : "GET" });
      assert.equal(response.status, 404);
    }
    const invalid = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://radar.example" }, body: '{"password":"secret",' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "Invalid JSON", fieldErrors: {} });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await ended;
    }
    await rm(runtime, { recursive: true, force: true });
  }
});

test("password hashes use salted scrypt and reject invalid passwords", async () => {
  const { hashPassword, verifyPassword } = await import("../src/auth/password.mjs");
  const first = await hashPassword("long-password-123");
  assert.match(first, /^scrypt\$/);
  assert.notEqual(first, await hashPassword("long-password-123"));
  assert.equal(await verifyPassword("long-password-123", first), true);
  assert.equal(await verifyPassword("wrong", first), false);
  assert.equal(await verifyPassword("wrong", "invalid"), false);
});

test("CLI bootstraps exactly one first admin, with no HTTP bootstrap path", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, request, login }) => {
  await bootstrap();
  await assert.rejects(bootstrap("second@example.com"), /admin already exists/i);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM memberships WHERE role='admin'")).rows[0].count, 1);
  const session = await login();
  assert.equal((await request("/api/auth/bootstrap", { ...session, method: "POST", body: {} })).status, 404);
  assert.equal((await pool.query("SELECT password_hash FROM users")).rows[0].password_hash.includes("long-password-123"), false);
}));

test("sessions use hashed opaque tokens, secure cookies, live roles, and logout revocation", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, request, login }) => {
  await bootstrap();
  assert.equal((await request("/api/me")).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "wrong" } })).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", headers: { Origin: "https://evil.example" }, body: {} })).status, 403);
  const session = await login();
  assert.match(session.result.headers.get("set-cookie"), /HttpOnly/);
  assert.match(session.result.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(session.result.headers.get("set-cookie"), /Secure/);
  const { rows: [stored] } = await pool.query("SELECT * FROM sessions");
  assert.equal(session.cookie.includes(stored.token_hash), false);
  assert.notEqual(stored.csrf_token_hash, session.csrf);
  assert.equal((await request("/api/me", session)).body.user.role, "admin");
  assert.equal((await request("/api/auth/logout", { cookie: session.cookie, method: "POST" })).status, 403);
  assert.equal((await request("/api/auth/logout", { ...session, method: "POST", headers: { Origin: "" } })).status, 403);
  assert.equal((await request("/api/auth/logout", { ...session, method: "POST" })).status, 200);
  assert.equal((await request("/api/me", session)).status, 401);
  const expired = await login();
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await request("/api/me", expired)).status, 401);
}));
