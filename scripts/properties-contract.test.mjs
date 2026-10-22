import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { httpFixture } from "./http-test-helpers.mjs";

test(
  "properties production contract rotates CSRF separately from identity and accepts it on inventory writes",
  { skip: !process.env.TEST_DATABASE_URL },
  () =>
    httpFixture(async ({ bootstrap, login, request }) => {
      await bootstrap();
      const session = await login();
      const me = await request("/api/me", session);
      assert.equal(me.status, 200);
      assert.equal(Object.hasOwn(me.body, "csrfToken"), false);

      const csrf = await request("/api/auth/csrf", {
        ...session,
        method: "POST",
        body: {},
      });
      assert.equal(csrf.status, 200);
      assert.match(csrf.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
      const rotated = await request("/api/auth/csrf", {
        ...session,
        method: "POST",
        body: {},
      });
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.body.csrfToken, csrf.body.csrfToken);
      const rejected = await request("/api/projects", {
        ...session,
        csrf: csrf.body.csrfToken,
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: { name: "โครงการ CSRF เก่า" },
      });
      assert.equal(rejected.status, 403);
      const created = await request("/api/projects", {
        ...session,
        csrf: rotated.body.csrfToken,
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: { name: "โครงการ Contract" },
      });
      assert.equal(created.status, 201);
    }),
);
