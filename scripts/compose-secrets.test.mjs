import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureComposeSecrets } from "./ensure-compose-secrets.mjs";

test("Compose secrets are generated once, separated by process, and preserve supplied credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rendar-compose-secrets-"));
  const databaseDirectory = path.join(root, "database"), runtimeDirectory = path.join(root, "runtime");
  try {
    const env = {
      POSTGRES_PASSWORD: "owner pass/หนึ่ง",
      RUNTIME_DATABASE_PASSWORD: "runtime-password-123",
      WORKER_DATABASE_URL: "postgres://worker:worker%20password@elsewhere/db",
      SESSION_SECRET: "session-secret-that-is-at-least-32-characters",
    };
    assert.deepEqual(await ensureComposeSecrets({ env, databaseDirectory, runtimeDirectory }), { databaseCreated: true, runtimeCreated: true });
    const web = execFileSync("/bin/sh", ["-c", `. ${JSON.stringify(path.join(runtimeDirectory, "web.env"))}; printf '%s\\n%s\\n' "$RUNTIME_DATABASE_URL" "$SESSION_SECRET"`], { encoding: "utf8" });
    assert.match(web, /rental_radar_web:runtime-password-123@postgres:5432\/rental_radar/);
    assert.match(web, /session-secret-that-is-at-least-32-characters/);
    assert.doesNotMatch(await readFile(path.join(runtimeDirectory, "worker.env"), "utf8"), /SESSION_SECRET|RUNTIME_DATABASE_URL/);
    assert.doesNotMatch(await readFile(path.join(runtimeDirectory, "group.env"), "utf8"), /DATABASE|SESSION|META_TOKEN/);
    assert.equal(await readFile(path.join(databaseDirectory, "postgres_password"), "utf8"), "owner pass/หนึ่ง\n");
    assert.deepEqual(await ensureComposeSecrets({ env: {}, databaseDirectory, runtimeDirectory }), { databaseCreated: false, runtimeCreated: false });
    assert.equal(await readFile(path.join(databaseDirectory, "postgres_password"), "utf8"), "owner pass/หนึ่ง\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
