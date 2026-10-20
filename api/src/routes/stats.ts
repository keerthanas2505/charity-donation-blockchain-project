import { Router } from "express";
import { queryOne } from "../db.js";
import { depId } from "../deployment.js";
import { wrap } from "../errors.js";

export const stats = Router();

interface StatsRow {
  campaign_count: string;
  total_balance: string;
  total_reserved: string;
  total_donated: string;
  donation_count: string;
  active_verifiers: string;
  total_staked: string;
  released_amount: string;
  open_rounds: string;
}

stats.get(
  "/",
  wrap(async (_req, res) => {
    const deploymentId = depId();

    const row = await queryOne<StatsRow>(
      `SELECT
        (SELECT COUNT(*)::text FROM campaigns WHERE deployment_id = $1) AS campaign_count,
        (SELECT COALESCE(SUM(balance), 0)::text FROM campaigns WHERE deployment_id = $1) AS total_balance,
        (SELECT COALESCE(SUM(reserved), 0)::text FROM campaigns WHERE deployment_id = $1) AS total_reserved,
        (SELECT COALESCE(SUM(amount), 0)::text FROM donations WHERE deployment_id = $1) AS total_donated,
        (SELECT COUNT(*)::text FROM donations WHERE deployment_id = $1) AS donation_count,
        (SELECT COUNT(*)::text FROM verifiers WHERE deployment_id = $1 AND is_verifier = true) AS active_verifiers,
        (SELECT COALESCE(SUM(staked_amount), 0)::text FROM verifiers WHERE deployment_id = $1) AS total_staked,
        (SELECT COALESCE(SUM(amount), 0)::text FROM milestones WHERE deployment_id = $1 AND state = 'Released') AS released_amount,
        (SELECT COUNT(*)::text FROM rounds WHERE deployment_id = $1 AND status = 'Open') AS open_rounds`,
      [deploymentId],
    );

    res.json({
      campaignCount: Number(row?.campaign_count ?? 0),
      totalBalance: row?.total_balance ?? "0",
      totalReserved: row?.total_reserved ?? "0",
      totalDonated: row?.total_donated ?? "0",
      donationCount: Number(row?.donation_count ?? 0),
      activeVerifiers: Number(row?.active_verifiers ?? 0),
      totalStaked: row?.total_staked ?? "0",
      releasedAmount: row?.released_amount ?? "0",
      openRounds: Number(row?.open_rounds ?? 0),
    });
  }),
);
