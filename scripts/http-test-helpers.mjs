import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import express from "express";
import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const origin = "https://radar.example";
const execute = promisify(execFile);
export async function httpFixture(fn) {
  const admin = createPool({ databaseUrl });
  const schema = `http_${randomUUID().replaceAll("-", "")}`;
  let pool, server;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool({ databaseUrl: url.href });
    await migrate(pool);
    const bootstrap = (email = "admin@example.com") => execute(process.execPath, ["scripts/create-admin.mjs"], {
      env: { ...process.env, DATABASE_URL: url.href, ADMIN_EMAIL: email, ADMIN_PASSWORD: "long-password-123", ADMIN_DISPLAY_NAME: "Admin" },
    });
    const { createApplicationRouter } = await import("../src/http/auth-routes.mjs");
    const app = express();
    app.use(express.json());
    app.use(createApplicationRouter({ pool, config: { appOrigin: origin, nodeEnv: "production" }, env: { OPENAI_API_KEY: "private-api-key" } }));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, { method = "GET", body, cookie, csrf, headers = {} } = {}) => {
      const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const login = async (email = "admin@example.com") => {
      const result = await request("/api/auth/login", { method: "POST", body: { email, password: "long-password-123" } });
      assert.equal(result.status, 200);
      return { cookie: result.headers.get("set-cookie").split(";")[0], csrf: result.body.csrfToken, result };
    };
    const mutate = (session, route, body, revision = 1, extra = {}) => request(route, { ...session, method: "PATCH", body, headers: { "Idempotency-Key": randomUUID(), "If-Match": String(revision), ...extra } });
    const addUser = async (role, organizationId = "org_default") => {
      const { hashPassword } = await import("../src/auth/password.mjs");
      const id = randomUUID(), email = `${id}@example.com`;
      await pool.query("INSERT INTO users (id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)", [id, email, await hashPassword("long-password-123"), role]);
      await pool.query("INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,$3)", [organizationId, id, role]);
      return { id, ...(await login(email)) };
    };
    await fn({ pool, bootstrap, request, login, mutate, addUser });
  } finally {
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}
