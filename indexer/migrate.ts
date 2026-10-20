/**
 * Cross-platform migration runner.
 *
 * Applies indexer/migrations/*.sql in filename order via `pg`, using
 * DATABASE_URL from indexer/.env. No `psql` on PATH required, and no shell
 * variable expansion — the previous `psql "$DATABASE_URL" -f ...` silently fell
 * back to the Windows username in PowerShell/cmd because `$DATABASE_URL` is a
 * POSIX-only construct.
 *
 *   npm run db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

// Postgres "already exists" codes: duplicate_table / _object / _schema.
const ALREADY_APPLIED = new Set(["42P07", "42710", "42P06"]);

async function main() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no .sql files in ${migrationsDir}`);

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  console.log(`connected: ${redact(config.databaseUrl)}`);
  try {
    for (const f of files) {
      const sql = readFileSync(resolve(migrationsDir, f), "utf8");
      process.stdout.write(`  ${f} ... `);
      try {
        await client.query(sql); // each file wraps itself in BEGIN/COMMIT
        console.log("applied");
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code && ALREADY_APPLIED.has(code)) {
          console.log(`already applied (${code})`);
        } else {
          throw e;
        }
      }
    }
  } finally {
    await client.end();
  }
  console.log("migrations complete");
}

main().catch((e) => {
  console.error("migration failed:", (e as Error).message ?? e);
  process.exitCode = 1;
});
