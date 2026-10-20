import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load indexer/.env by absolute path, so it works from any cwd and whether or
// not a wrapper (dotenv-cli) already loaded it. dotenv never overrides a var
// that is already set, so double-loading is harmless.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), ".env") });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v === undefined ? dflt : Number(v);
}

/**
 * Blocks per eth_getLogs request during historical replay. Public RPC providers
 * cap this hard: Alchemy free tier = 10, Infura = 10k, QuickNode varies. Set
 * LOG_BATCH_SIZE to your provider's documented limit; raise it after upgrading.
 * `CHUNK_SIZE` is the pre-2026-09 name and still works as a fallback.
 */
function resolveLogBatchSize(): number {
  const raw = process.env.LOG_BATCH_SIZE ?? process.env.CHUNK_SIZE;
  if (process.env.LOG_BATCH_SIZE === undefined && process.env.CHUNK_SIZE !== undefined) {
    console.warn("[config] CHUNK_SIZE is deprecated; rename it to LOG_BATCH_SIZE");
  }
  const n = raw === undefined || raw === "" ? 10 : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`LOG_BATCH_SIZE must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// A local Hardhat/anvil node mines only on a tx, so its head stops advancing when
// idle and a non-zero confirmations gap would strand the newest blocks forever.
// Default to 0 there; a real RPC keeps its default of 5.
const rpcUrl = req("RPC_URL");
const isLocalRpc = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/.test(rpcUrl);

export const config = {
  databaseUrl: req("DATABASE_URL"),
  rpcUrl, // http(s):// or ws(s)://
  chainId: BigInt(req("CHAIN_ID")),

  addresses: {
    escrow: req("ESCROW_ADDRESS").toLowerCase(),
    registry: req("REGISTRY_ADDRESS").toLowerCase(),
    voting: req("VOTING_ADDRESS").toLowerCase(),
    proofs: req("PROOFS_ADDRESS").toLowerCase(),
  },

  /** Deploy block. Replaying from 0 against a live network is a mistake — set this. */
  startBlock: num("START_BLOCK", 0),
  label: process.env.LABEL ?? null,

  /**
   * Blocks to stay behind chain head so reorgs above the cursor never matter.
   * Must be 0 for a local node (see isLocalRpc) — its head does not advance while
   * idle, so any gap would leave the most recent events (notably Donated, which
   * lands one block after CampaignCreated) permanently unindexed.
   */
  confirmations: num("CONFIRMATIONS", isLocalRpc ? 0 : 5),
  /** Blocks per eth_getLogs request during replay. See resolveLogBatchSize(). */
  logBatchSize: resolveLogBatchSize(),
  /** Floor sweep cadence if the socket goes quiet. */
  pollIntervalMs: num("POLL_INTERVAL_MS", 15_000),
  /** How often reconcile() cross-checks derived state against contract views. */
  reconcileIntervalMs: num("RECONCILE_INTERVAL_MS", 300_000),
} as const;

export type Config = typeof config;
