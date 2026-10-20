import type { Log, Result } from "ethers";
import { config } from "./config.js";
import { pool, tx } from "./db.js";
import {
  makeContracts,
  makeProvider,
  type Contracts,
  type ContractKey,
} from "./contracts.js";
import { HANDLERS, type Env } from "./handlers.js";

let contracts!: Contracts;
let env!: Env;

// ── block-time cache (getLogs doesn't carry timestamps) ───────────────────
const blockTimeCache = new Map<number, number>();
async function getBlockTime(bn: number): Promise<number> {
  const hit = blockTimeCache.get(bn);
  if (hit !== undefined) return hit;
  const b = await contracts.provider.getBlock(bn);
  if (!b) throw new Error(`block ${bn} not found`);
  if (blockTimeCache.size > 5000) blockTimeCache.clear();
  blockTimeCache.set(bn, b.timestamp);
  return b.timestamp;
}

function jsonArgs(r: Result): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.toObject())) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

// ── the single writer path (used by both replay and live) ────────────────
async function processLog(log: Log): Promise<void> {
  const key = contracts.addressToKey[log.address.toLowerCase()] as
    | ContractKey
    | undefined;
  if (!key) return;

  let parsed: ReturnType<Contracts["iface"][ContractKey]["parseLog"]>;
  try {
    parsed = contracts.iface[key].parseLog({
      topics: [...log.topics],
      data: log.data,
    });
  } catch {
    return;
  }
  if (!parsed) return;

  const blockTime = await getBlockTime(log.blockNumber);

  await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO event_log
         (deployment_id, tx_hash, log_index, block_number, block_time,
          contract, event_name, args)
       VALUES ($1,$2,$3,$4, to_timestamp($5), $6, $7, $8)
       ON CONFLICT (deployment_id, tx_hash, log_index) DO NOTHING`,
      [
        env.deploymentId,
        log.transactionHash,
        log.index,
        log.blockNumber,
        blockTime,
        log.address.toLowerCase(),
        parsed!.name,
        JSON.stringify(jsonArgs(parsed!.args)),
      ],
    );
    if (ins.rowCount === 0) return; // already processed — idempotent

    const handler = HANDLERS[key][parsed!.name];
    if (handler) await handler(c, env, parsed!.args, log, blockTime);
  });
}

// ── cursor ───────────────────────────────────────────────────────────────
async function getCursor(): Promise<number> {
  const r = await pool.query(
    "SELECT last_synced_block FROM sync_state WHERE deployment_id=$1",
    [env.deploymentId],
  );
  return Number(r.rows[0].last_synced_block);
}
async function setCursor(bn: number): Promise<void> {
  await pool.query(
    `UPDATE sync_state
        SET last_synced_block = GREATEST(last_synced_block, $2), updated_at = now()
      WHERE deployment_id=$1`,
    [env.deploymentId, bn],
  );
}

// ── chunked, ordered, resumable replay ───────────────────────────────────
// One eth_getLogs per iteration, spanning at most config.logBatchSize blocks so
// range-limited providers (Alchemy free tier = 10) never reject the request.
// The cursor advances per batch, so an interrupted replay resumes mid-range.
async function replayRange(from: number, to: number): Promise<void> {
  if (from > to) return;
  const span = to - from + 1;
  const batch = config.logBatchSize;
  let done = 0;
  let lastProgressAt = 0;

  for (let start = from; start <= to; start += batch) {
    const end = Math.min(start + batch - 1, to);
    const logs = await contracts.provider.getLogs({
      address: contracts.allAddresses,
      fromBlock: start,
      toBlock: end,
    });
    // exact on-chain order across all four contracts
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    for (const log of logs) await processLog(log);
    await setCursor(end);

    done += end - start + 1;
    if (logs.length) {
      console.log(`[replay] ${start}-${end}: ${logs.length} logs  (${done}/${span})`);
    } else if (Date.now() - lastProgressAt > 5_000) {
      // heartbeat across long empty stretches so a big replay visibly advances
      console.log(`[replay] ${start}-${end}: 0 logs  (${done}/${span}, ${((done / span) * 100).toFixed(1)}%)`);
      lastProgressAt = Date.now();
    }
  }
}

// ── sweep: mutex'd, self-coalescing; the only thing that advances the cursor
let sweeping = false;
let sweepQueued = false;
let debounce: NodeJS.Timeout | null = null;

function scheduleSweep(): void {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void sweep();
  }, 300);
}

async function sweep(): Promise<void> {
  if (sweeping) {
    sweepQueued = true;
    return;
  }
  sweeping = true;
  try {
    do {
      sweepQueued = false;
      const cursor = await getCursor();
      const head = await contracts.provider.getBlockNumber();
      await replayRange(cursor + 1, head - config.confirmations);
    } while (sweepQueued);
  } catch (e) {
    console.error("[sweep] error (will retry next tick):", e);
  } finally {
    sweeping = false;
  }
}

// ── live listeners: low-latency trigger only, no writes ──────────────────
async function startLive(): Promise<void> {
  for (const key of Object.keys(HANDLERS) as ContractKey[]) {
    const ct = contracts.contract[key];
    for (const eventName of Object.keys(HANDLERS[key])) {
      await ct.on(eventName, () => scheduleSweep());
    }
  }
  contracts.provider.on("block", () => scheduleSweep());
  console.log("[live] contract.on() listeners attached (all four contracts)");
}

// ── reconcile: cross-check derived state against contract views ──────────
async function reconcile(): Promise<void> {
  try {
    const { rows: cs } = await pool.query(
      "SELECT campaign_id, balance, reserved FROM campaigns WHERE deployment_id=$1",
      [env.deploymentId],
    );
    for (const row of cs) {
      const oc = await contracts.contract.escrow.getCampaign(row.campaign_id);
      const bal = (oc.balance as bigint).toString();
      const res = (oc.reserved as bigint).toString();
      if (bal !== row.balance || res !== row.reserved) {
        console.warn(
          `[reconcile] campaign ${row.campaign_id} drift db(${row.balance}/${row.reserved}) chain(${bal}/${res}) — correcting`,
        );
        await pool.query(
          "UPDATE campaigns SET balance=$2, reserved=$3, updated_at=now() WHERE deployment_id=$1 AND campaign_id=$4",
          [env.deploymentId, bal, res, row.campaign_id],
        );
      }
    }

    const { rows: vs } = await pool.query(
      "SELECT address, staked_amount, reputation, is_verifier, against_strikes FROM verifiers WHERE deployment_id=$1",
      [env.deploymentId],
    );
    for (const row of vs) {
      const reg = contracts.contract.registry;
      const [staked, rep, isV, strikes] = await Promise.all([
        reg.stakedAmount(row.address),
        reg.reputationOf(row.address),
        reg.isVerifier(row.address),
        reg.againstStrikes(row.address),
      ]);
      const s = (staked as bigint).toString();
      if (
        s !== row.staked_amount ||
        Number(rep) !== row.reputation ||
        Boolean(isV) !== row.is_verifier ||
        Number(strikes) !== row.against_strikes
      ) {
        console.warn(`[reconcile] verifier ${row.address} drift — correcting`);
        await pool.query(
          `UPDATE verifiers SET staked_amount=$2, reputation=$3, is_verifier=$4, against_strikes=$5, updated_at=now()
             WHERE deployment_id=$1 AND address=$6`,
          [env.deploymentId, s, Number(rep), Boolean(isV), Number(strikes), row.address],
        );
      }
    }
    console.log(`[reconcile] checked ${cs.length} campaigns, ${vs.length} verifiers`);
  } catch (e) {
    console.error("[reconcile] error:", e);
  }
}

// ── orchestration ────────────────────────────────────────────────────────
export async function run(): Promise<void> {
  const provider = makeProvider();
  contracts = makeContracts(provider);

  const dep = await pool.query(
    "SELECT id FROM deployments WHERE chain_id=$1 AND escrow_address=$2",
    [config.chainId.toString(), config.addresses.escrow],
  );
  if (!dep.rows[0]) {
    throw new Error(
      "no deployments row for this chain_id + escrow address — run: tsx indexer/register-deployment.ts",
    );
  }
  const deploymentId = String(dep.rows[0].id);

  await pool.query(
    `INSERT INTO sync_state (deployment_id, last_synced_block)
     VALUES ($1,$2) ON CONFLICT (deployment_id) DO NOTHING`,
    [deploymentId, config.startBlock - 1],
  );

  const votingPeriod: bigint = await contracts.contract.voting.VOTING_PERIOD();
  env = { deploymentId, votingPeriod, contracts };

  const head = await provider.getBlockNumber();
  const cursor = await getCursor();
  console.log(
    `[start] deployment ${deploymentId} | head ${head} | cursor ${cursor} | confirmations ${config.confirmations}`,
  );

  // 1) replay everything missed while we were down
  await replayRange(cursor + 1, head - config.confirmations);
  console.log(`[start] replay done, cursor ${await getCursor()}`);

  // 2) go live, then 3) close the gap opened between step 1 and listener attach
  await startLive();
  await sweep();
  void reconcile();

  const pollTimer = setInterval(scheduleSweep, config.pollIntervalMs);
  const recTimer = setInterval(() => void reconcile(), config.reconcileIntervalMs);

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] shutting down`);
    clearInterval(pollTimer);
    clearInterval(recTimer);
    if (debounce) clearTimeout(debounce);
    try {
      await provider.removeAllListeners();
    } catch {
      /* ignore */
    }
    for (let i = 0; sweeping && i < 100; i++)
      await new Promise((r) => setTimeout(r, 100));
    try {
      provider.destroy();
    } catch {
      /* ignore */
    }
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[ready] indexing live");
}
