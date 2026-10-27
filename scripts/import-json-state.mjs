import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { createPool } from "../src/db/pool.mjs";

const collections = ["groups", "targets", "analyses", "drafts", "reviews", "submissions", "messengerThreads", "messengerMessages", "messengerOutbound", "processedWebhookEvents"];
const fields = new Set(["version", "config", "businessProfile", "replyProfile", "messengerConfig", ...collections, "events"]);
const credentialField = /token|secret|password|cookie|session|authorization|credential|apikey|accesskey|privatekey|browser|cdpurl|databaseurl|connectionstring|storagestate|localstorage|indexeddb|^auth$/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !credentialField.test(key.replaceAll(/[^a-z0-9]/gi, "")))
    .map(([key, item]) => [key, redact(item)]));
}

function prepare(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid legacy state");
  if (input.version !== undefined && ![1, 2, 3].includes(input.version)) throw new Error("Unsupported legacy state version");
  const snapshot = Object.fromEntries(Object.entries(input).filter(([key]) => fields.has(key))
    .map(([key, value]) => [key, collections.includes(key) && value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).map(([id, record]) => [id, redact(record)])) : redact(value)]));
  const counts = {};
  for (const key of collections) {
    if (snapshot[key] === undefined) continue;
    if (!snapshot[key] || typeof snapshot[key] !== "object" || Array.isArray(snapshot[key])) throw new Error("Invalid legacy collection");
    counts[key] = Object.keys(snapshot[key]).length;
  }
  const deliveryOutcomes = {};
  let unknownDeliveries = 0;
  for (const key of ["submissions", "messengerOutbound"]) {
    deliveryOutcomes[key] = Object.fromEntries(Object.entries(snapshot[key] ?? {}).map(([id, delivery]) => {
      if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("Invalid legacy delivery");
      const outcome = !delivery.state || ["attempted", "attempting", "reserved"].includes(delivery.state) ? "unknown" : delivery.state;
      if (outcome === "unknown") unknownDeliveries += 1;
      return [id, outcome];
    }));
  }
  return { snapshot, counts, deliveryOutcomes, unknownDeliveries };
}

export async function importLegacy(file, { pool, dryRun = false } = {}) {
  const bytes = await readFile(file);
  const { snapshot, counts, deliveryOutcomes, unknownDeliveries } = prepare(JSON.parse(bytes));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72419831)");
    const { rows: tables } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY tablename");
    for (const { tablename } of tables) {
      const identifier = `"${tablename.replaceAll('"', '""')}"`;
      await client.query(`LOCK TABLE ${identifier} IN SHARE ROW EXCLUSIVE MODE`);
      const condition = tablename === "organizations" ? ` WHERE id <> 'org_default' OR name <> 'Naina' OR profile_revision <> 1 OR retention_revision <> 1
        OR business_profile <> '{"description":"","relevanceThreshold":60}'::jsonb
        OR retention <> '{"rawPayloadDays":30,"screenshotDays":7}'::jsonb` : "";
      const { rows: [row] } = await client.query(`SELECT EXISTS (SELECT 1 FROM ${identifier}${condition}) AS populated`);
      if (row.populated) throw new Error("PostgreSQL state is already populated; import refused");
    }
    if (dryRun) {
      await client.query("ROLLBACK");
      return { dryRun: true, writes: 0, counts, unknownDeliveries, verified: false };
    }
    await client.query(`INSERT INTO legacy_state_imports (organization_id,source_checksum,snapshot,counts,delivery_outcomes)
      VALUES ('org_default',$1,$2,$3,$4)`, [checksum, JSON.stringify(snapshot), JSON.stringify(counts), JSON.stringify(deliveryOutcomes)]);
    const { rows: [persisted] } = await client.query("SELECT source_checksum,snapshot,counts,delivery_outcomes FROM legacy_state_imports WHERE organization_id = 'org_default'");
    if (!persisted || persisted.source_checksum !== checksum || !isDeepStrictEqual(persisted.snapshot, snapshot)
      || !isDeepStrictEqual(persisted.counts, counts) || !isDeepStrictEqual(persisted.delivery_outcomes, deliveryOutcomes)) {
      throw new Error("Legacy import verification failed");
    }
    await client.query("COMMIT");
    return { dryRun: false, writes: 1, counts, unknownDeliveries, verified: true };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (error) { releaseError = error; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    const args = process.argv.slice(2);
    const files = args.filter((arg) => !arg.startsWith("--"));
    if (files.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) {
      throw new Error("Usage: npm run import:legacy -- <state.json> [--dry-run]");
    }
    pool = createPool({ databaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
    process.stdout.write(`${JSON.stringify(await importLegacy(files[0], { pool, dryRun: args.includes("--dry-run") }))}\n`);
  } catch {
    process.stderr.write("Legacy import failed. Check the input, migrations, and an empty PostgreSQL database. No source values are logged.\n");
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
