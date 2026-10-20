import { Router } from "express";
import { query, queryOne } from "../db.js";
import { depId } from "../deployment.js";
import { notFound, wrap } from "../errors.js";
import { intParam, limitParam, sortParam } from "../params.js";

export const campaigns = Router();

// ── row shapes ─────────────────────────────────────────────────────────────
interface CampaignRow {
  campaign_id: string;
  beneficiary: string;
  creator: string;
  balance: string;
  reserved: string;
  milestone_count: number;
  created_at: Date;
  created_block: string;
  created_tx: string;
}
interface MilestoneRow {
  milestone_id: string;
  description: string;
  amount: string;
  state: string;
  release_after: Date | null;
}
interface RoundRow {
  milestone_id: string;
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
}
interface ProofRow {
  milestone_id: string;
  cid: string;
  submitter: string;
  version: number;
  submitted_at: Date;
  submitted_tx: string;
}
interface DonationRow {
  donor: string;
  amount: string;
  tx_hash: string;
  log_index: number;
  block_number: string;
  block_time: Date;
}

// ── mappers (snake_case DB -> camelCase JSON) ──────────────────────────────
const mapCampaign = (r: CampaignRow) => ({
  id: Number(r.campaign_id),
  beneficiary: r.beneficiary,
  creator: r.creator,
  balance: r.balance,
  reserved: r.reserved,
  available: (BigInt(r.balance) - BigInt(r.reserved)).toString(),
  milestoneCount: r.milestone_count,
  createdAt: r.created_at,
  createdBlock: Number(r.created_block),
  createdTx: r.created_tx,
});
const mapRound = (r: RoundRow) => ({
  roundIndex: r.round_index,
  status: r.status,
  approveWeight: r.approve_weight,
  rejectWeight: r.reject_weight,
  weightSnapshot: r.weight_snapshot,
  approved: r.approved,
  proofCid: r.proof_cid,
  deadline: r.deadline,
  disputeWeight: r.dispute_weight,
  disputeForwarded: r.dispute_forwarded,
  openedBlock: Number(r.opened_block),
});
const mapProof = (r: ProofRow) => ({
  cid: r.cid,
  submitter: r.submitter,
  version: r.version,
  submittedAt: r.submitted_at,
  submittedTx: r.submitted_tx,
});
const mapDonation = (r: DonationRow) => ({
  donor: r.donor,
  amount: r.amount,
  txHash: r.tx_hash,
  logIndex: r.log_index,
  blockNumber: Number(r.block_number),
  blockTime: r.block_time,
});

// ── GET /campaigns ────────────────────────────────────────────────────────
// list: id, beneficiary, balance, reserved, milestoneCount   (?sort= ?limit=)
const LIST_SORTS: Record<string, string> = {
  id: "campaign_id",
  balance: "balance",
  reserved: "reserved",
  milestones: "milestone_count",
  created: "created_at",
};

campaigns.get(
  "/",
  wrap(async (req, res) => {
    const orderBy = sortParam(req.query.sort, LIST_SORTS, "campaign_id ASC");
    const limit = limitParam(req.query.limit, 100, 500);

    const rows = await query<CampaignRow>(
      `SELECT campaign_id, beneficiary, creator, balance, reserved,
              milestone_count, created_at, created_block, created_tx
         FROM campaigns
        WHERE deployment_id = $1
        ORDER BY ${orderBy}, campaign_id ASC
        LIMIT $2`,
      [depId(), limit],
    );
    res.json({ count: rows.length, sort: req.query.sort ?? null, limit, campaigns: rows.map(mapCampaign) });
  }),
);

// ── GET /campaigns/:id ────────────────────────────────────────────────────
// full detail: campaign + milestones + each milestone's latest round + proof
campaigns.get(
  "/:id",
  wrap(async (req, res) => {
    const id = intParam(req.params.id, "campaign id");

    const campaign = await queryOne<CampaignRow>(
      `SELECT campaign_id, beneficiary, creator, balance, reserved,
              milestone_count, created_at, created_block, created_tx
         FROM campaigns
        WHERE deployment_id = $1 AND campaign_id = $2`,
      [depId(), id],
    );
    if (!campaign) throw notFound(`campaign ${id} not found`);

    const [milestones, latestRounds, proofs] = await Promise.all([
      query<MilestoneRow>(
        `SELECT milestone_id, description, amount, state, release_after
           FROM milestones
          WHERE deployment_id = $1 AND campaign_id = $2
          ORDER BY milestone_id ASC`,
        [depId(), id],
      ),
      // one row per milestone: the highest round_index
      query<RoundRow>(
        `SELECT DISTINCT ON (milestone_id)
                milestone_id, round_index, status, approve_weight, reject_weight,
                weight_snapshot, approved, proof_cid, deadline, dispute_weight,
                dispute_forwarded, opened_block
           FROM rounds
          WHERE deployment_id = $1 AND campaign_id = $2
          ORDER BY milestone_id ASC, round_index DESC`,
        [depId(), id],
      ),
      query<ProofRow>(
        `SELECT milestone_id, cid, submitter, version, submitted_at, submitted_tx
           FROM proofs
          WHERE deployment_id = $1 AND campaign_id = $2`,
        [depId(), id],
      ),
    ]);

    const roundByMs = new Map(latestRounds.map((r) => [r.milestone_id, r]));
    const proofByMs = new Map(proofs.map((p) => [p.milestone_id, p]));

    res.json({
      ...mapCampaign(campaign),
      milestones: milestones.map((m) => {
        const round = roundByMs.get(m.milestone_id) ?? null;
        const proof = proofByMs.get(m.milestone_id) ?? null;
        return {
          id: Number(m.milestone_id),
          description: m.description,
          amount: m.amount,
          state: m.state,
          releaseAfter: m.release_after,
          proof: {
            submitted: proof !== null,
            ...(proof ? mapProof(proof) : {}),
          },
          latestRound: round ? mapRound(round) : null,
        };
      }),
    });
  }),
);

// ── GET /campaigns/:id/donations ──────────────────────────────────────────
campaigns.get(
  "/:id/donations",
  wrap(async (req, res) => {
    const id = intParam(req.params.id, "campaign id");
    const limit = limitParam(req.query.limit, 200, 1000);

    // 404 if the campaign itself is unknown (vs. a real campaign with 0 donations)
    const exists = await queryOne(
      `SELECT 1 FROM campaigns WHERE deployment_id = $1 AND campaign_id = $2`,
      [depId(), id],
    );
    if (!exists) throw notFound(`campaign ${id} not found`);

    const rows = await query<DonationRow>(
      `SELECT donor, amount, tx_hash, log_index, block_number, block_time
         FROM donations
        WHERE deployment_id = $1 AND campaign_id = $2
        ORDER BY block_number DESC, log_index DESC
        LIMIT $3`,
      [depId(), id, limit],
    );
    const total = rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
    res.json({
      campaignId: id,
      count: rows.length,
      limit,
      totalInPage: total.toString(),
      donations: rows.map(mapDonation),
    });
  }),
);
