import { pathToFileURL } from "node:url";
import { createPool } from "../src/db/pool.mjs";

const grants = {
  organizations: "SELECT, UPDATE",
  users: "SELECT, INSERT",
  memberships: "SELECT, INSERT, UPDATE",
  sessions: "SELECT, INSERT, UPDATE",
  login_attempts: "SELECT, INSERT, UPDATE",
  idempotency_keys: "SELECT, INSERT, UPDATE",
  outbox: "SELECT, INSERT",
  projects: "SELECT, INSERT, UPDATE",
  units: "SELECT, INSERT, UPDATE",
  project_transit: "SELECT, INSERT",
  project_amenities: "SELECT, INSERT",
  audit_entries: "SELECT, INSERT",
  unit_fact_revisions: "SELECT, INSERT",
  match_snapshots: "SELECT, INSERT",
  jobs: "SELECT, INSERT, UPDATE (status, attempts, available_at, lease_owner, lease_expires_at, last_error, updated_at)",
  conversations: "SELECT, INSERT, UPDATE (processing_revision, updated_at, human_takeover, opted_out)",
  messages: "SELECT, INSERT",
  work_items: "SELECT, INSERT, UPDATE (status, updated_at)",
  reply_versions: "SELECT, INSERT",
  reply_supersessions: "SELECT, INSERT",
  reply_authorizations: "SELECT, INSERT",
  delivery_intents: "SELECT, INSERT, UPDATE (id)",
  delivery_attempts: "SELECT, INSERT, UPDATE (state, outcome_code, provider_message_id, finished_at)",
  delivery_cancellations: "SELECT, INSERT",
  group_delivery_attempts: "SELECT",
  group_send_receipts: "SELECT",
  meta_oauth_states: "SELECT, INSERT, UPDATE (used_at)",
  meta_page_sources: "SELECT, INSERT, UPDATE (name, health, expires_at, updated_at)",
  group_sources: "SELECT, INSERT, UPDATE (mode, allow_listed, policy, kill_switch, archived, revision, updated_at)",
  group_operations: "SELECT, INSERT",
  group_scan_receipts: "SELECT",
  group_observations: "SELECT",
  group_targets: "SELECT",
  group_source_schedules: "SELECT, INSERT, UPDATE (enabled, cadence_minutes, time_zone, days, start_local, end_local, daily_limit, maintenance_windows, revision, updated_at)",
  group_schedule_receipts: "SELECT",
  automation_control_receipts: "SELECT, INSERT",
  group_scan_dispatches: "SELECT",
};
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export async function provisionRuntime(pool, { role = "rental_radar_web", password, profile = "web" } = {}) {
  if(!['web','worker'].includes(profile)) throw new Error('Invalid runtime permission profile');
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
    const workerTables=new Set(['organizations','memberships','projects','units','project_transit','project_amenities','audit_entries','unit_fact_revisions','match_snapshots','jobs','conversations','messages','work_items','reply_versions','reply_supersessions','reply_authorizations','delivery_intents','delivery_attempts','delivery_cancellations','meta_page_sources','outbox']);
    const workerReadOnly=new Set(['memberships','project_transit','project_amenities','unit_fact_revisions']);
    workerTables.add('group_sources');
    workerTables.add('group_operations');
    for(const table of ['group_scan_receipts','group_observations','group_targets']) workerTables.add(table);
    for(const table of ['group_delivery_attempts','group_send_receipts']) workerTables.add(table);
    for(const table of ['group_source_schedules','group_schedule_receipts']) workerTables.add(table);
    workerTables.add('group_scan_dispatches');
    for (const [table, webPermissions] of Object.entries(grants)) {
      if(profile==='worker' && !workerTables.has(table))continue;
      const permissions=profile==='worker' && workerReadOnly.has(table)?'SELECT':
        profile==='worker' && table==='group_sources'?'SELECT, UPDATE (session_health, selector_health, selector_version, session_circuit, selector_circuit, selector_failures, last_result_order, updated_at)':
        profile==='worker' && ['group_scan_receipts','group_observations'].includes(table)?'SELECT, INSERT':
        profile==='worker' && ['group_delivery_attempts','group_send_receipts'].includes(table)?'SELECT, INSERT':
        profile==='worker' && table==='group_source_schedules'?'SELECT':
        profile==='worker' && table==='group_schedule_receipts'?'SELECT, INSERT':
        profile==='worker' && table==='group_scan_dispatches'?'SELECT, INSERT':
        profile==='worker' && table==='group_targets'?'SELECT, INSERT, UPDATE (observation_id, operation_order)':
        profile==='worker' && ['projects','units'].includes(table)?'SELECT, UPDATE (id)':
        profile==='worker' && table==='organizations'?'SELECT, UPDATE (id)':
        profile==='worker' && table==='meta_page_sources'?'SELECT, UPDATE (id)':
        webPermissions;
      await client.query(`GRANT ${permissions} ON TABLE ${quote(context.schema)}.${quote(table)} TO ${quote(role)}`);
    }
    for (const signature of ["meta_credential_read(text,text)", "meta_credential_write(text,text,text,text,jsonb,timestamptz)", "meta_credential_delete(text,text)"]) {
      await client.query(`REVOKE EXECUTE ON FUNCTION ${quote(context.schema)}.${signature} FROM ${quote(role)}`);
      if(profile==='worker' && !signature.startsWith('meta_credential_read('))continue;
      await client.query(`GRANT EXECUTE ON FUNCTION ${quote(context.schema)}.${signature} TO ${quote(role)}`);
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
    const worker=process.argv.includes('--worker');
    await provisionRuntime(pool, { role:worker?'rental_radar_worker':'rental_radar_web', profile:worker?'worker':'web',password: worker?process.env.WORKER_DATABASE_PASSWORD:process.env.RUNTIME_DATABASE_PASSWORD });
    process.stdout.write("Runtime database permissions provisioned.\n");
  } catch {
    process.stderr.write("Runtime provisioning failed. Check owner access, dedicated role ownership, migrations, and runtime password.\n");
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
