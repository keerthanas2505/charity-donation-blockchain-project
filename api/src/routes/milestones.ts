import { Router } from "express";
import { query, queryOne } from "../db.js";
import { depId } from "../deployment.js";
import { notFound, wrap } from "../errors.js";
import { intParam } from "../params.js";

export const milestones = Router();

interface RoundRow {
  round_index: number;
  status: string;
  approve_weight: string;
  reject_weight: string;
  weight_snapshot: string;
  approved: boolean | null;
  proof_cid: string;
  deadline: Date;
  dispute_weight: string;
  dispute_forwarded: boolean;
  opened_block: string;
  opened_tx: string;
}
interface VoteRow {
  voter: string;
  approve: boolean;
  weight: string;
  aligned: boolean | null;
  tx_hash: string;
  log_index: number;
  block_number: string;
}

// ── GET /milestones/:campaignId/:milestoneId/votes ────────────────────────
// votes cast in the current/latest round for that milestone.
milestones.get(
  "/:campaignId/:milestoneId/votes",
  wrap(async (req, res) => {
    const campaignId = intParam(req.params.campaignId, "campaignId");
    const milestoneId = intParam(req.params.milestoneId, "milestoneId");

    const milestone = await queryOne<{ state: string }>(
      `SELECT state FROM milestones
        WHERE deployment_id = $1 AND campaign_id = $2 AND milestone_id = $3`,
      [depId(), campaignId, milestoneId],
    );
    if (!milestone) {
      throw notFound(
        `milestone ${campaignId}/${milestoneId} not found`,
      );
    }

    // latest round for this milestone (rounds.round_index is 1-based, monotonic)
    const round = await queryOne<RoundRow>(
      `SELECT round_index, status, approve_weight, reject_weight, weight_snapshot,
              approved, proof_cid, deadline, dispute_weight, dispute_forwarded,
              opened_block, opened_tx
         FROM rounds
        WHERE deployment_id = $1 AND campaign_id = $2 AND milestone_id = $3
        ORDER BY round_index DESC
        LIMIT 1`,
      [depId(), campaignId, milestoneId],
    );

    if (!round) {
      res.json({
        campaignId,
        milestoneId,
        milestoneState: milestone.state,
        round: null,
        voteCount: 0,
        votes: [],
      });
      return;
    }

    const votes = await query<VoteRow>(
      `SELECT voter, approve, weight, aligned, tx_hash, log_index, block_number
         FROM votes
        WHERE deployment_id = $1 AND campaign_id = $2
          AND milestone_id = $3 AND round_index = $4
        ORDER BY block_number ASC, log_index ASC`,
      [depId(), campaignId, milestoneId, round.round_index],
    );

    res.json({
      campaignId,
      milestoneId,
      milestoneState: milestone.state,
      round: {
        roundIndex: round.round_index,
        status: round.status,
        approveWeight: round.approve_weight,
        rejectWeight: round.reject_weight,
        weightSnapshot: round.weight_snapshot,
        approved: round.approved,
        proofCid: round.proof_cid,
        deadline: round.deadline,
        disputeWeight: round.dispute_weight,
        disputeForwarded: round.dispute_forwarded,
        openedBlock: Number(round.opened_block),
        openedTx: round.opened_tx,
      },
      voteCount: votes.length,
      votes: votes.map((v) => ({
        voter: v.voter,
        approve: v.approve,
        weight: v.weight,
        aligned: v.aligned,
        txHash: v.tx_hash,
        logIndex: v.log_index,
        blockNumber: Number(v.block_number),
      })),
    });
  }),
);
