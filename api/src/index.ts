import { config } from "./config.js";
import { pool } from "./db.js";
import { resolveDeployment } from "./deployment.js";
import { buildApp } from "./server.js";

async function main(): Promise<void> {
  // Fail fast if the DB is down or the deployment row is missing.
  const dep = await resolveDeployment();
  console.log(
    `[api] deployment ${dep.id} (${dep.label ?? "no label"}) | chain ${dep.chain_id} | escrow ${dep.escrow_address}`,
  );
  console.log(`[api] pinata upload: ${config.pinataJwt ? "enabled" : "DISABLED (set PINATA_JWT)"}`);

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[api] ${sig} — closing`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    // hard cap in case a connection hangs
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[api] startup failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
