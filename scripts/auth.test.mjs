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

test("login throttles known and unknown accounts equally, survives new routers, and expires", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, pool, request, restart }) => {
  await bootstrap();
  const attempt = (email, headers = {}) => request("/api/auth/login", { method: "POST", body: { email, password: "wrong" }, headers });
  let known, unknown;
  for (let index = 0; index < 5; index++) {
    known = await attempt("admin@example.com");
    unknown = await attempt("unknown@example.com");
    assert.equal(known.status, 401);
    assert.deepEqual(known.body, unknown.body);
  }
  await restart();
  known = await attempt("ADMIN@example.com", { "X-Forwarded-For": "192.0.2.2" });
  unknown = await attempt("unknown@example.com");
  assert.equal(known.status, 429);
  assert.deepEqual(known.body, unknown.body);
  assert.ok(Number(known.headers.get("retry-after")) > 0);
  assert.ok(Number(known.headers.get("retry-after")) <= 900);
  const successWhileBlocked = await request("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "long-password-123" } });
  assert.equal(successWhileBlocked.status, 429);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count, 0);
  await pool.query("UPDATE login_attempts SET expires_at=now()-interval '1 second'");
  assert.equal((await attempt("admin@example.com")).status, 401);
}));

test("login IP budget prevents rotating account guesses and cannot be reset by successes", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, request }) => {
  await bootstrap();
  for (let index = 0; index < 50; index++) {
    const result = await request("/api/auth/login", { method: "POST", body: { email: index % 10 === 0 ? "admin@example.com" : `guess${index}@example.com`, password: index % 10 === 0 ? "long-password-123" : "wrong" }, headers: { "X-Forwarded-For": `192.0.2.${index + 1}` } });
    assert.equal(result.status, index % 10 === 0 ? 200 : 401);
  }
  const limited = await request("/api/auth/login", { method: "POST", body: { email: "another@example.com", password: "wrong" } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
}));

test("successful login resets account failures and rotates a supplied session", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, request, login }) => {
  await bootstrap();
  const session = await login();
  for (let index = 0; index < 4; index++) assert.equal((await request("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "wrong" } })).status, 401);
  const rotated = await request("/api/auth/login", { method: "POST", cookie: session.cookie, body: { email: "admin@example.com", password: "long-password-123" } });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.headers.get("set-cookie").split(";")[0], session.cookie);
  assert.equal((await request("/api/me", session)).status, 401);
  assert.equal((await request("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "wrong" } })).status, 401);
}));

test("concurrent login guesses share one durable account budget", { skip: !databaseUrl }, () => httpFixture(async ({ bootstrap, request }) => {
  await bootstrap();
  const attempts = await Promise.all(Array.from({ length: 12 }, () => request("/api/auth/login", { method: "POST", body: { email: "admin@example.com", password: "wrong" } })));
  assert.equal(attempts.filter((result) => result.status === 401).length, 5);
  assert.equal(attempts.filter((result) => result.status === 429).length, 7);
}));

test("login throttle storage is bounded and expired rows can be reused without deleting state", { skip: !databaseUrl }, () => httpFixture(async ({ pool, request }) => {
  await pool.query("INSERT INTO login_attempts (organization_id,kind,key_hash,attempts,expires_at) SELECT 'org_default','account',md5(i::text)||md5(i::text),1,now()+interval '15 minutes' FROM generate_series(1,10000) i");
  const attempt = () => request("/api/auth/login", { method: "POST", body: { email: "unknown@example.com", password: "wrong" } });
  assert.equal((await attempt()).status, 429);
  await pool.query("UPDATE login_attempts SET expires_at=now()-interval '1 second' WHERE key_hash IN (SELECT key_hash FROM login_attempts ORDER BY key_hash LIMIT 2)");
  assert.equal((await attempt()).status, 401);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM login_attempts")).rows[0].count, 10000);
}));
