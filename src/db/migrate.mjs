import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const migrationsDirectory = new URL("./migrations/", import.meta.url);

export async function migrate(pool) {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
  const migrations = await Promise.all(names.map(async (name) => {
    const match = /^(\d+)-[a-z0-9-]+\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}`);
    const sql = await readFile(new URL(name, migrationsDirectory), "utf8");
    return { version: Number(match[1]), name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  migrations.sort((a, b) => a.version - b.version);
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) throw new Error("Migration versions must be unique and contiguous from 1");
  }

  const client = await pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72419831)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows: applied } = await client.query("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
    for (const [index, entry] of applied.entries()) {
      const migration = migrations.find((item) => item.version === entry.version);
      if (!migration) throw new Error(`Unknown applied migration version ${entry.version}`);
      if (entry.version !== index + 1) throw new Error("Applied migration history is not contiguous");
      if (entry.checksum !== migration.checksum || entry.name !== migration.name) {
        throw new Error(`Migration checksum or name mismatch for version ${entry.version}`);
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, migration.checksum]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
