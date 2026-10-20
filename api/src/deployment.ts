import { config } from "./config.js";
import { queryOne } from "./db.js";

/**
 * The database holds many deployments (one row per wired 4-contract set, per
 * network). Every domain table is keyed by `deployment_id`, so the API must pin
 * exactly one. We resolve it ONCE here, at startup, from CHAIN_ID + ESCROW_ADDRESS
 * (the same pair the indexer's `deployments` UNIQUE constraint uses), and every
 * query then filters `WHERE deployment_id = $1`.
 */
let deploymentId: string | null = null;

interface DeploymentRow {
  id: string;
  chain_id: string;
  label: string | null;
  escrow_address: string;
  registry_address: string;
  voting_address: string;
  proofs_address: string;
  start_block: string;
}

export async function resolveDeployment(): Promise<DeploymentRow> {
  const row = await queryOne<DeploymentRow>(
    `SELECT id, chain_id, label, escrow_address, registry_address,
            voting_address, proofs_address, start_block
       FROM deployments
      WHERE chain_id = $1 AND escrow_address = $2`,
    [config.chainId.toString(), config.escrowAddress],
  );
  if (!row) {
    throw new Error(
      `no deployments row for chain_id=${config.chainId} escrow=${config.escrowAddress}. ` +
        `Register it first: (from repo root) npm run indexer:register`,
    );
  }
  deploymentId = row.id;
  return row;
}

/** The pinned deployment id. Throws if called before resolveDeployment(). */
export function depId(): string {
  if (deploymentId === null) {
    throw new Error("deployment not resolved yet");
  }
  return deploymentId;
}
