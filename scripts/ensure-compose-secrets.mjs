import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
const generatedSecret = () => randomBytes(32).toString("hex");
const generatedKey = () => randomBytes(32).toString("base64");

function passwordFromUrl(value) {
  if (!value) return null;
  try { return decodeURIComponent(new URL(value).password) || null; }
  catch { return null; }
}

async function readExisting(file) {
  try {
    const value = await readFile(file, "utf8");
    if (!value.trim()) throw new Error(`Existing secret file is empty: ${file}`);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeOnce(file, content, mode = 0o444) {
  try {
    const existing = await readFile(file, "utf8");
    if (!existing.trim()) throw new Error(`Existing secret file is empty: ${file}`);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode, flag: "wx" });
  await rename(temporary, file);
  await chmod(file, mode);
  return true;
}

export async function ensureComposeSecrets({
  env = process.env,
  databaseDirectory = "/run/rendar-db",
  runtimeDirectory = "/run/rendar",
} = {}) {
  await mkdir(databaseDirectory, { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const databasePasswordFile = path.join(databaseDirectory, "postgres_password");
  const persistedOwnerPassword = await readExisting(databasePasswordFile);
  const ownerPassword = persistedOwnerPassword?.trim() || env.POSTGRES_PASSWORD || generatedSecret();
  const runtimePassword = env.RUNTIME_DATABASE_PASSWORD || passwordFromUrl(env.RUNTIME_DATABASE_URL) || generatedSecret();
  const workerPassword = env.WORKER_DATABASE_PASSWORD || passwordFromUrl(env.WORKER_DATABASE_URL) || generatedSecret();
  const sessionSecret = env.SESSION_SECRET || generatedSecret();
  const metaKeyVersion = env.META_TOKEN_KEY_VERSION || "compose-v1";
  const metaKeys = env.META_TOKEN_KEYS && env.META_TOKEN_KEYS !== "{}" ? env.META_TOKEN_KEYS : JSON.stringify({ [metaKeyVersion]: generatedKey() });
  const groupKeyId = env.GROUP_COMMAND_KEY_ID || "compose-v1";
  const groupKeys = env.GROUP_COMMAND_KEYS && env.GROUP_COMMAND_KEYS !== "{}" ? env.GROUP_COMMAND_KEYS : JSON.stringify({ [groupKeyId]: generatedKey() });
  const databaseName = env.POSTGRES_DB || "rental_radar";
  const ownerUser = env.POSTGRES_USER || "rental_radar";
  const url = (user, password) => `postgres://${user}:${encodeURIComponent(password)}@postgres:5432/${databaseName}`;

  const databaseCreated = await writeOnce(databasePasswordFile, `${ownerPassword}\n`);
  await writeOnce(path.join(databaseDirectory, "owner.env"), `export MIGRATION_DATABASE_URL=${shellQuote(url(ownerUser, ownerPassword))}\n`);
  const commonMeta = { META_TOKEN_KEY_VERSION: metaKeyVersion, META_TOKEN_KEYS: metaKeys };
  const commonGroup = { GROUP_COMMAND_KEY_ID: groupKeyId, GROUP_COMMAND_KEYS: groupKeys };
  const environments = {
    "bootstrap.env": { RUNTIME_DATABASE_PASSWORD: runtimePassword, WORKER_DATABASE_PASSWORD: workerPassword },
    "web.env": { RUNTIME_DATABASE_URL: url("rental_radar_web", runtimePassword), SESSION_SECRET: sessionSecret, ...commonMeta, ...commonGroup },
    "worker.env": { WORKER_DATABASE_URL: url("rental_radar_worker", workerPassword), ...commonMeta, ...commonGroup },
    "group.env": commonGroup,
  };
  let runtimeCreated = false;
  for (const [file, values] of Object.entries(environments)) {
    const content = Object.entries(values).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n") + "\n";
    runtimeCreated = await writeOnce(path.join(runtimeDirectory, file), content) || runtimeCreated;
  }
  return { databaseCreated, runtimeCreated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureComposeSecrets();
    process.stdout.write(result.databaseCreated || result.runtimeCreated ? "Compose secrets initialized.\n" : "Compose secrets already initialized.\n");
  } catch {
    process.stderr.write("Compose secret initialization failed. Check the secret volumes and supplied values.\n");
    process.exitCode = 1;
  }
}
