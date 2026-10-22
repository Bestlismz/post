import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

test("production image runs only the web process without browser or fixture assets", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /chromium|supervisord|COPY fixture|COPY src \.\/src/);
  const server = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(server, /import\(["'].*(?:fixture|import-json-state)/);
});

test("Compose separates web, Messenger worker, and isolated Group browser storage", async () => {
  await assert.rejects(access(new URL("../compose.yaml", import.meta.url)), { code: "ENOENT" });
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /\n  postgres:/);
  assert.match(compose, /\n  web:/);
  const services = compose.slice(compose.indexOf("services:"), compose.indexOf("\nvolumes:"));
  assert.match(services, /\n  worker:/);
  assert.match(services, /\n  group-worker:/);
  assert.equal((compose.match(/healthcheck:/g) ?? []).length, 3);
  assert.match(compose, /condition: service_healthy/);
  const web = services.slice(services.indexOf("\n  web:"));
  assert.match(web, /DATABASE_URL: \$\{RUNTIME_DATABASE_URL:/);
  assert.doesNotMatch(web, /COMPOSE_DATABASE_URL|MIGRATION_DATABASE_URL|POSTGRES_PASSWORD|npm run migrate/);
  assert.match(compose, /name: rental-radar-postgres-data/);
  assert.match(compose, /name: rental-radar-browser-profile/);
  const webService=services.slice(services.indexOf("\n  web:"),services.indexOf("\n  worker:"));
  assert.doesNotMatch(webService,/browser-profile:/);
});
