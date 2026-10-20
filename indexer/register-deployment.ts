/**
 * One-off: insert (or update) the `deployments` row for the wired 4-contract set
 * this indexer will follow, and seed its sync_state cursor at start_block - 1.
 *
 *   tsx indexer/register-deployment.ts
 *
 * Reads the same env vars as the indexer (see config.ts / .env).
 */
import { config } from "./config.js";
import { pool } from "./db.js";

async function main() {
  const { addresses, chainId, startBlock, label } = config;

  const res = await pool.query(
    `INSERT INTO deployments
       (chain_id, label, escrow_address, registry_address, voting_address, proofs_address, start_block)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (chain_id, escrow_address) DO UPDATE
       SET registry_address = EXCLUDED.registry_address,
           voting_address   = EXCLUDED.voting_address,
           proofs_address   = EXCLUDED.proofs_address,
           label            = EXCLUDED.label
     RETURNING id`,
    [
      chainId.toString(),
      label,
      addresses.escrow,
      addresses.registry,
      addresses.voting,
      addresses.proofs,
      startBlock,
    ],
  );
  const id = String(res.rows[0].id);

  await pool.query(
    `INSERT INTO sync_state (deployment_id, last_synced_block)
     VALUES ($1,$2) ON CONFLICT (deployment_id) DO NOTHING`,
    [id, startBlock - 1],
  );

  console.log(`deployment ${id} registered`);
  console.log(`  chain_id   ${chainId}`);
  console.log(`  escrow     ${addresses.escrow}`);
  console.log(`  registry   ${addresses.registry}`);
  console.log(`  voting     ${addresses.voting}`);
  console.log(`  proofs     ${addresses.proofs}`);
  console.log(`  start_block ${startBlock} (cursor seeded at ${startBlock - 1})`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
