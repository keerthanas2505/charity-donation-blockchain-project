import { Router } from "express";
import { query } from "../db.js";
import { depId } from "../deployment.js";
import { wrap } from "../errors.js";
import { limitParam, ethAddressParam } from "../params.js";

export const verifiers = Router();

interface VerifierRow {
  address: string;
  staked_amount: string;
  reputation: number;
  is_verifier: boolean;
  against_strikes: number;
  first_joined_block: string | null;
}

// ── GET /verifiers/leaderboard ────────────────────────────────────────────
// reputation desc, with stakedAmount + isVerifier. ?limit= (default 100).
verifiers.get(
  "/leaderboard",
  wrap(async (req, res) => {
    const limit = limitParam(req.query.limit, 100, 500);
    const rows = await query<VerifierRow>(
      `SELECT address, staked_amount, reputation, is_verifier,
              against_strikes, first_joined_block
         FROM verifiers
        WHERE deployment_id = $1
        ORDER BY reputation DESC, staked_amount DESC, address ASC
        LIMIT $2`,
      [depId(), limit],
    );
    res.json({
      count: rows.length,
      limit,
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        address: r.address,
        reputation: r.reputation,
        stakedAmount: r.staked_amount,
        isVerifier: r.is_verifier,
        againstStrikes: r.against_strikes,
        firstJoinedBlock:
          r.first_joined_block === null ? null : Number(r.first_joined_block),
      })),
    });
  }),
);

// ── GET /verifiers/:address ──────────────────────────────────────────────
verifiers.get(
  "/:address",
  wrap(async (req, res) => {
    const address = ethAddressParam(req.params.address, "verifier address");
    const verifier = await query<VerifierRow>(
      `SELECT address, staked_amount, reputation, is_verifier,
              against_strikes, first_joined_block
         FROM verifiers
        WHERE deployment_id = $1 AND address = $2`,
      [depId(), address],
    );

    if (verifier.length === 0) {
      res.json({
        address,
        isVerifier: false,
        reputation: 0,
        stakedAmount: "0",
        againstStrikes: 0,
        firstJoinedBlock: null,
        votes: [],
      });
      return;
    }

    const r = verifier[0];
    const votes = await query<{
      campaign_id: string;
      milestone_id: string;
      round_index: number;
      approve: boolean;
      weight: string;
      aligned: boolean | null;
      tx_hash: string;
      block_number: string;
    }>(
      `SELECT campaign_id, milestone_id, round_index, approve, weight, aligned, tx_hash, block_number
         FROM votes
        WHERE deployment_id = $1 AND voter = $2
        ORDER BY block_number DESC
        LIMIT 50`,
      [depId(), address],
    );

    res.json({
      address: r.address,
      isVerifier: r.is_verifier,
      reputation: r.reputation,
      stakedAmount: r.staked_amount,
      againstStrikes: r.against_strikes,
      firstJoinedBlock:
        r.first_joined_block === null ? null : Number(r.first_joined_block),
      votes: votes.map((v) => ({
        campaignId: Number(v.campaign_id),
        milestoneId: Number(v.milestone_id),
        roundIndex: v.round_index,
        approve: v.approve,
        weight: v.weight,
        aligned: v.aligned,
        txHash: v.tx_hash,
        blockNumber: Number(v.block_number),
      })),
    });
  }),
);

