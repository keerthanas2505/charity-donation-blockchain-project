import pg from "pg";
import { config } from "./config.js";

// uint256 columns are NUMERIC(78,0); keep them as JS strings, never floats.
pg.types.setTypeParser(1700, (v: string) => v); // NUMERIC -> string
pg.types.setTypeParser(20, (v: string) => v); // BIGINT  -> string

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });

export type Client = pg.PoolClient;

/** Run `fn` inside a transaction; rolls back and rethrows on error. */
export async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
