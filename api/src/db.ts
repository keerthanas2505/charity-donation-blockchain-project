import pg from "pg";
import { config } from "./config.js";

// uint256 columns are NUMERIC(78,0) and ids are BIGINT — keep both as JS strings,
// never floats (same choice the indexer makes). This parser registration is
// process-global in `pg`; harmless that the indexer sets it too, since this is a
// separate process.
pg.types.setTypeParser(1700, (v: string) => v); // NUMERIC -> string
pg.types.setTypeParser(20, (v: string) => v); // BIGINT  -> string

/**
 * This API's OWN pool instance. It is not imported from or shared with
 * /indexer — the two processes just happen to point at the same DATABASE_URL.
 * Read-only workload, so a small pool is plenty.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  application_name: "charity-api",
});

pool.on("error", (err) => {
  // A pooled idle client errored (e.g. DB restarted). pg will discard it; log so
  // it is visible, don't crash the server.
  console.error("[db] idle client error:", err.message);
});

/** Thin helper: run a parametrised query, return the rows. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** Run a query expecting at most one row; returns it or null. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
