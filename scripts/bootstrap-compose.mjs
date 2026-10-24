import { bootstrapAdmin } from "../src/auth/bootstrap.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { createPool } from "../src/db/pool.mjs";
import { seedSampleInventory } from "./seed-sample-inventory.mjs";
import { provisionRuntime } from "./provision-runtime.mjs";

const pool = createPool({ databaseUrl: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL });
try {
  await migrate(pool);
  await provisionRuntime(pool, { role: "rental_radar_web", profile: "web", password: process.env.RUNTIME_DATABASE_PASSWORD });
  await provisionRuntime(pool, { role: "rental_radar_worker", profile: "worker", password: process.env.WORKER_DATABASE_PASSWORD });
  const { rowCount } = await pool.query("SELECT 1 FROM memberships WHERE organization_id='org_default' AND role='admin' LIMIT 1");
  if (!rowCount) {
    await bootstrapAdmin(pool, {
      email: process.env.ADMIN_EMAIL ?? "admin@rendar.local",
      password: process.env.ADMIN_PASSWORD ?? "admin123456",
      displayName: process.env.ADMIN_DISPLAY_NAME ?? "Rendar Admin",
    });
    process.stdout.write("Default administrator created.\n");
  } else process.stdout.write("Administrator already exists.\n");
  if (process.env.BOOTSTRAP_SAMPLE_DATA !== "false") {
    const saved = await seedSampleInventory({ pool });
    process.stdout.write(`Sample inventory ready: ${saved.length} published rooms.\n`);
  }
  process.stdout.write("Rendar bootstrap completed.\n");
} catch (error) {
  process.stderr.write(`Rendar bootstrap failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
