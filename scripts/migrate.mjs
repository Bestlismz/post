import { createPool } from "../src/db/pool.mjs";
import { migrate } from "../src/db/migrate.mjs";

let pool;
try {
  pool = createPool({ databaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
  await migrate(pool);
  process.stdout.write("Database migrations applied.\n");
} catch {
  process.stderr.write("Migration failed. Check DATABASE_URL and migration history.\n");
  process.exitCode = 1;
} finally {
  await pool?.end();
}
