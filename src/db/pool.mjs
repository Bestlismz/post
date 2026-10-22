import pg from "pg";

export function createPool({ databaseUrl, max = 10 }) {
  if (!databaseUrl) throw new Error("databaseUrl is required");
  return new pg.Pool({ connectionString: databaseUrl, max });
}
