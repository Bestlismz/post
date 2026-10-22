import { pathToFileURL } from "node:url";
import { createPool } from "../src/db/pool.mjs";

const grants = {
  organizations: "SELECT, UPDATE",
  users: "SELECT, INSERT",
  memberships: "SELECT, INSERT, UPDATE",
  sessions: "SELECT, INSERT, UPDATE",
  login_attempts: "SELECT, INSERT, UPDATE",
  idempotency_keys: "SELECT, INSERT, UPDATE",
  projects: "SELECT, INSERT, UPDATE",
  units: "SELECT, INSERT, UPDATE",
  project_transit: "SELECT, INSERT",
  project_amenities: "SELECT, INSERT",
  audit_entries: "SELECT, INSERT",
  unit_fact_revisions: "SELECT, INSERT",
  match_snapshots: "SELECT, INSERT",
  jobs: "SELECT, INSERT",
};
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export async function provisionRuntime(pool, { role = "rental_radar_web", password } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || typeof password !== "string" || password.length < 16) {
    throw new Error("A valid dedicated role and runtime password of at least 16 characters are required");
  }
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72419832)");
    const { rows: [context] } = await client.query("SELECT current_user AS owner, current_database() AS database, current_schema() AS schema");
    if (context.owner === role) throw new Error("Runtime role must differ from the owner");
    const existing = await client.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role]);
    if (existing.rowCount) {
      const unsafe = await client.query(`SELECT 1 FROM pg_auth_members WHERE member=$1
        UNION ALL SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o'`, [existing.rows[0].oid]);
      if (unsafe.rowCount) throw new Error("Runtime role must not own objects or have role memberships");
    } else {
      await client.query(`CREATE ROLE ${quote(role)} LOGIN`);
    }
    const { rows: [statement] } = await client.query("SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
    await client.query(statement.sql);
    await client.query(`REVOKE ALL ON DATABASE ${quote(context.database)} FROM ${quote(role)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(context.database)} TO ${quote(role)}`);
    await client.query(`REVOKE ALL ON SCHEMA ${quote(context.schema)} FROM ${quote(role)}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${quote(context.schema)} FROM PUBLIC`);
    await client.query(`GRANT USAGE ON SCHEMA ${quote(context.schema)} TO ${quote(role)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${quote(context.schema)} FROM ${quote(role)}`);
    for (const [table, permissions] of Object.entries(grants)) {
      await client.query(`GRANT ${permissions} ON TABLE ${quote(context.schema)}.${quote(table)} TO ${quote(role)}`);
    }
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${quote(context.schema)} FROM ${quote(role)}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quote(context.schema)} TO ${quote(role)}`);
    await client.query("COMMIT");
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
    pool = createPool({ databaseUrl: process.env.MIGRATION_DATABASE_URL });
    await provisionRuntime(pool, { password: process.env.RUNTIME_DATABASE_PASSWORD });
    process.stdout.write("Runtime database permissions provisioned.\n");
  } catch {
    process.stderr.write("Runtime provisioning failed. Check owner access, dedicated role ownership, migrations, and runtime password.\n");
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
