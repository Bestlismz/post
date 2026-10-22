import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import next from "next";
import { loadConfig } from "./config.mjs";
import { createPool } from "./db/pool.mjs";
import { createApplicationRouter } from "./http/auth-routes.mjs";
import { errorHandler } from "./http/boundary.mjs";
import { createMetaRouter } from "./http/meta-routes.mjs";

const config = loadConfig();
const pool = createPool(config);
await pool.query("SELECT 1");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frontend = next({ dev: false, dir: root });
let frontendReady;
const app = express();
app.disable("x-powered-by");
app.use(createMetaRouter({ pool, organizationId: process.env.META_ORGANIZATION_ID, pageId: process.env.META_PAGE_ID, appSecret: process.env.META_APP_SECRET, verifyToken: process.env.META_VERIFY_TOKEN }));
app.use(express.json({ limit: "32kb" }));
app.use(createApplicationRouter({ pool, config }));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use(["/api", "/fixture", "/novnc"], (_request, response) => response.status(404).json({ error: "Resource not found", fieldErrors: {} }));
app.use(async (request, response) => {
  frontendReady ??= frontend.prepare();
  await frontendReady;
  return frontend.getRequestHandler()(request, response);
});
app.use(errorHandler);
const server = http.createServer(app);
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => {
  process.stdout.write(`Application listening on http://0.0.0.0:${server.address().port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close(() => { void pool.end().then(() => frontendReady ? frontend.close() : undefined); });
  server.closeIdleConnections();
});
