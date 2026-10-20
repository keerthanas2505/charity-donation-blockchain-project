import type { Log, Result } from "ethers";
import type { Client } from "./db.js";
import type { Contracts, ContractKey } from "./contracts.js";

export interface Env {
  deploymentId: string;
  votingPeriod: bigint; // MilestoneVoting.VOTING_PERIOD(), read once at startup
  contracts: Contracts;
}

export type Handler = (
  c: Client,
  env: Env,
  a: Result,
  log: Log,
  blockTime: number,
) => Promise<void>;

const S = (x: unknown) => (x as bigint).toString(); // -> NUMERIC/BIGINT text
const A = (x: unknown) => (x as string).toLowerCase(); // -> eth_address

async function currentRound(
  c: Client,
  env: Env,
  campaignId: unknown,
  milestoneId: unknown,
): Promise<number> {
  const r = await c.query(
    `SELECT MAX(round_index) AS ri FROM rounds
       WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
    [env.deploymentId, S(campaignId), S(milestoneId)],
  );
  if (r.rows[0].ri == null)
    throw new Error(`no round for ${campaignId}/${milestoneId} — missed RoundOpened`);
  return Number(r.rows[0].ri);
}

async function milestoneAmount(
  c: Client,
  env: Env,
  campaignId: unknown,
  milestoneId: unknown,
): Promise<string> {
  const r = await c.query(
    `SELECT amount FROM milestones
       WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
    [env.deploymentId, S(campaignId), S(milestoneId)],
  );
  if (!r.rows[0])
    throw new Error(`no milestone row ${campaignId}/${milestoneId} — missed CampaignCreated`);
  return r.rows[0].amount as string;
}

// ── CampaignEscrow ─────────────────────────────────────────────────────────
const escrow: Record<string, Handler> = {
  async CampaignCreated(c, env, a, log, bt) {
    await c.query(
      `INSERT INTO campaigns
         (deployment_id, campaign_id, beneficiary, creator, milestone_count,
          created_at, created_block, created_tx)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6), $7, $8)
       ON CONFLICT (deployment_id, campaign_id) DO NOTHING`,
      [
        env.deploymentId, S(a.campaignId), A(a.beneficiary), A(a.creator),
        Number(a.milestoneCount), bt, log.blockNumber, log.transactionHash,
      ],
    );
    // description + amount are immutable and carried by no event -> read once.
    const count = Number(a.milestoneCount);
    for (let i = 0; i < count; i++) {
      const m = await env.contracts.contract.escrow.getMilestone(a.campaignId, i);
      await c.query(
        `INSERT INTO milestones
           (deployment_id, campaign_id, milestone_id, description, amount, state)
         VALUES ($1,$2,$3,$4,$5,'Pending')
         ON CONFLICT (deployment_id, campaign_id, milestone_id) DO NOTHING`,
        [env.deploymentId, S(a.campaignId), i, m[0] as string, (m[1] as bigint).toString()],
      );
    }
  },

  async Donated(c, env, a, log, bt) {
    await c.query(
      `INSERT INTO donations
         (deployment_id, campaign_id, donor, amount, tx_hash, log_index, block_number, block_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))
       ON CONFLICT (deployment_id, tx_hash, log_index) DO NOTHING`,
      [
        env.deploymentId, S(a.campaignId), A(a.donor), S(a.amount),
        log.transactionHash, log.index, log.blockNumber, bt,
      ],
    );
    await c.query(
      `UPDATE campaigns SET balance = balance + $3::numeric, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2`,
      [env.deploymentId, S(a.campaignId), S(a.amount)],
    );
  },

  async TimelockStarted(c, env, a) {
    const amt = await milestoneAmount(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE milestones
          SET state='Timelocked', release_after = to_timestamp($4), updated_at = now()
        WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId), Number(a.releaseAfter)],
    );
    await c.query(
      `UPDATE campaigns SET reserved = reserved + $3::numeric, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2`,
      [env.deploymentId, S(a.campaignId), amt],
    );
  },

  async DisputeRaised(c, env, a) {
    await c.query(
      `UPDATE milestones SET state='Disputed', updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId)],
    );
  },

  async MilestoneReleased(c, env, a) {
    const amt = await milestoneAmount(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE milestones SET state='Released', updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId)],
    );
    await c.query(
      `UPDATE campaigns
          SET balance = balance - $3::numeric, reserved = reserved - $3::numeric, updated_at = now()
        WHERE deployment_id=$1 AND campaign_id=$2`,
      [env.deploymentId, S(a.campaignId), amt],
    );
  },

  async DisputeResolved(c, env, a) {
    if (a.upheld) {
      // uphold -> _payout -> MilestoneReleased in the same tx handles the funds
      await c.query(
        `UPDATE milestones SET state='Released', updated_at = now()
           WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
        [env.deploymentId, S(a.campaignId), S(a.milestoneId)],
      );
    } else {
      const amt = await milestoneAmount(c, env, a.campaignId, a.milestoneId);
      await c.query(
        `UPDATE milestones SET state='Rejected', release_after = NULL, updated_at = now()
           WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
        [env.deploymentId, S(a.campaignId), S(a.milestoneId)],
      );
      await c.query(
        `UPDATE campaigns SET reserved = reserved - $3::numeric, updated_at = now()
           WHERE deployment_id=$1 AND campaign_id=$2`,
        [env.deploymentId, S(a.campaignId), amt],
      );
    }
  },

  async SlashedFundsReceived(c, env, a) {
    // credited to the campaign only if the row exists (else on-chain unallocatedSlashed)
    await c.query(
      `UPDATE campaigns SET balance = balance + $3::numeric, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2`,
      [env.deploymentId, S(a.campaignId), S(a.amount)],
    );
  },

  async UpkeepPerformed() {
    /* event_log only — the releases arrive as MilestoneReleased in the same tx */
  },
};

// ── VerifierRegistry ───────────────────────────────────────────────────────
const registry: Record<string, Handler> = {
  async VerifierJoined(c, env, a, log) {
    await c.query(
      `INSERT INTO verifiers (deployment_id, address, is_verifier, first_joined_block)
       VALUES ($1,$2,true,$3)
       ON CONFLICT (deployment_id, address)
       DO UPDATE SET is_verifier = true, updated_at = now()`,
      [env.deploymentId, A(a.verifier), log.blockNumber],
    );
  },
  async Staked(c, env, a) {
    await c.query(
      `INSERT INTO verifiers (deployment_id, address, staked_amount)
       VALUES ($1,$2,$3)
       ON CONFLICT (deployment_id, address)
       DO UPDATE SET staked_amount = $3::numeric, updated_at = now()`,
      [env.deploymentId, A(a.verifier), S(a.totalStaked)],
    );
  },
  async Unstaked(c, env, a) {
    await c.query(
      `UPDATE verifiers SET staked_amount = 0, updated_at = now()
         WHERE deployment_id=$1 AND address=$2`,
      [env.deploymentId, A(a.verifier)],
    );
  },
  async VerifierRemoved(c, env, a) {
    await c.query(
      `UPDATE verifiers SET is_verifier = false, updated_at = now()
         WHERE deployment_id=$1 AND address=$2`,
      [env.deploymentId, A(a.verifier)],
    );
  },
  async ReputationChanged(c, env, a) {
    await c.query(
      `INSERT INTO verifiers (deployment_id, address, reputation)
       VALUES ($1,$2,$3)
       ON CONFLICT (deployment_id, address)
       DO UPDATE SET reputation = $3::int, updated_at = now()`,
      [env.deploymentId, A(a.verifier), Number(a.newRep)],
    );
  },
  async StrikeRecorded(c, env, a) {
    await c.query(
      `UPDATE verifiers SET against_strikes = $3::int, updated_at = now()
         WHERE deployment_id=$1 AND address=$2`,
      [env.deploymentId, A(a.verifier), Number(a.strikes)],
    );
  },
  async Slashed(c, env, a) {
    if ((a.amount as bigint) === 0n) return; // no-op slash still emits Slashed(v, 0)
    await c.query(
      `UPDATE verifiers SET staked_amount = staked_amount - $3::numeric, updated_at = now()
         WHERE deployment_id=$1 AND address=$2`,
      [env.deploymentId, A(a.verifier), S(a.amount)],
    );
  },
  async SlashRoutedToEscrow() {
    /* event_log only — campaign credit is SlashedFundsReceived on escrow */
  },
};

// ── MilestoneVoting ────────────────────────────────────────────────────────
const voting: Record<string, Handler> = {
  async RoundOpened(c, env, a, log, bt) {
    const ri = (
      await c.query(
        `SELECT COALESCE(MAX(round_index),0)+1 AS ri FROM rounds
           WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3`,
        [env.deploymentId, S(a.campaignId), S(a.milestoneId)],
      )
    ).rows[0].ri as number;
    const deadline = bt + Number(env.votingPeriod);
    await c.query(
      `INSERT INTO rounds
         (deployment_id, campaign_id, milestone_id, round_index, status,
          weight_snapshot, proof_cid, deadline, opened_block, opened_tx)
       VALUES ($1,$2,$3,$4,'Open',$5,$6, to_timestamp($7), $8, $9)
       ON CONFLICT (deployment_id, campaign_id, milestone_id, round_index) DO NOTHING`,
      [
        env.deploymentId, S(a.campaignId), S(a.milestoneId), ri,
        S(a.totalWeightSnapshot), a.proofCID as string, deadline,
        log.blockNumber, log.transactionHash,
      ],
    );
  },

  async VoteCast(c, env, a, log) {
    const ri = await currentRound(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `INSERT INTO votes
         (deployment_id, campaign_id, milestone_id, round_index, voter, approve, weight,
          tx_hash, log_index, block_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (deployment_id, campaign_id, milestone_id, round_index, voter) DO NOTHING`,
      [
        env.deploymentId, S(a.campaignId), S(a.milestoneId), ri, A(a.verifier),
        a.approve as boolean, S(a.weight), log.transactionHash, log.index, log.blockNumber,
      ],
    );
    const col = a.approve ? "approve_weight" : "reject_weight";
    await c.query(
      `UPDATE rounds SET ${col} = ${col} + $5::numeric, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3 AND round_index=$4`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId), ri, S(a.weight)],
    );
  },

  async RoundFinalized(c, env, a) {
    const ri = await currentRound(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE rounds SET status='Finalized', approved=$5, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3 AND round_index=$4`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId), ri, a.approved as boolean],
    );
  },

  async DisputeThresholdReached(c, env, a) {
    const ri = await currentRound(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE rounds SET dispute_forwarded = true, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3 AND round_index=$4`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId), ri],
    );
  },

  async DisputeJoined(c, env, a) {
    const ri = await currentRound(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE rounds SET dispute_weight = $5::numeric, updated_at = now()
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3 AND round_index=$4`,
      [env.deploymentId, S(a.campaignId), S(a.milestoneId), ri, S(a.cumulativeDisputeWeight)],
    );
  },

  async VoterSettled(c, env, a) {
    const ri = await currentRound(c, env, a.campaignId, a.milestoneId);
    await c.query(
      `UPDATE votes SET aligned = $6
         WHERE deployment_id=$1 AND campaign_id=$2 AND milestone_id=$3
           AND round_index=$4 AND voter=$5`,
      [
        env.deploymentId, S(a.campaignId), S(a.milestoneId), ri,
        A(a.verifier), a.alignedWithOutcome as boolean,
      ],
    );
  },
};

// ── ProofRegistry ──────────────────────────────────────────────────────────
const proofs: Record<string, Handler> = {
  async ProofSubmitted(c, env, a, log, bt) {
    // version bump is safe (non-idempotent) because the event_log guard means
    // this handler runs at most once per (tx_hash, log_index).
    await c.query(
      `INSERT INTO proofs
         (deployment_id, campaign_id, milestone_id, cid, submitter, version, submitted_at, submitted_tx)
       VALUES ($1,$2,$3,$4,$5,1, to_timestamp($6), $7)
       ON CONFLICT (deployment_id, campaign_id, milestone_id)
       DO UPDATE SET cid = EXCLUDED.cid, submitter = EXCLUDED.submitter,
                     version = proofs.version + 1,
                     submitted_at = EXCLUDED.submitted_at,
                     submitted_tx = EXCLUDED.submitted_tx, updated_at = now()`,
      [
        env.deploymentId, S(a.campaignId), S(a.milestoneId), a.cid as string,
        A(a.submittedBy), bt, log.transactionHash,
      ],
    );
  },
};

export const HANDLERS: Record<ContractKey, Record<string, Handler>> = {
  escrow,
  registry,
  voting,
  proofs,
};
