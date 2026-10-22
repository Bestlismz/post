import { createPool } from "../src/db/pool.mjs";
import { bootstrapAdmin } from "../src/auth/bootstrap.mjs";

const pool = createPool({ databaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
try {
  await bootstrapAdmin(pool, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, displayName: process.env.ADMIN_DISPLAY_NAME });
  process.stdout.write("First admin created. Clear ADMIN_PASSWORD from your environment.\n");
} catch (error) {
  process.stderr.write(error.message === "An admin already exists; bootstrap is disabled" ? `${error.message}\n` : "Admin bootstrap failed. Check the database and ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_DISPLAY_NAME.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
