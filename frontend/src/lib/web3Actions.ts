import { parseEther, type Signer } from "ethers";
import {
  getCampaignEscrowContract,
  getVerifierRegistryContract,
  getMilestoneVotingContract,
  getProofRegistryContract,
} from "./contracts";

export function extractErrorMessage(err: unknown): string {
  if (!err) return "Transaction failed";
  if (typeof err === "string") return err;

  const e = err as {
    reason?: string;
    message?: string;
    shortMessage?: string;
    info?: { error?: { message?: string } };
    code?: unknown;
  };

  if (e.code === 4001 || e.code === "ACTION_REJECTED") {
    return "Transaction was rejected in your wallet";
  }

  if (e.reason) return e.reason;
  if (e.shortMessage) return e.shortMessage;
  if (e.info?.error?.message) return e.info.error.message;
  if (e.message) {
    // If the message contains revert reason quotes e.g. "execution reverted: reason"
    const match = e.message.match(/reverted with reason string '([^']+)'/);
    if (match && match[1]) return match[1];
    const match2 = e.message.match(/execution reverted: ([^",]+)/);
    if (match2 && match2[1]) return match2[1].trim();
    return e.message.slice(0, 150);
  }
  return "Transaction failed";
}

// ── CampaignEscrow Actions ──────────────────────────────────────────────────

export async function createCampaignAction(
  signer: Signer,
  beneficiary: string,
  descriptions: string[],
  amountsEth: string[],
): Promise<{ campaignId: number; txHash: string }> {
  const escrow = getCampaignEscrowContract(signer);
  const amountsWei = amountsEth.map((a) => parseEther(a));
  const tx = await escrow.createCampaign(beneficiary, descriptions, amountsWei);
  const receipt = await tx.wait();

  // Find CampaignCreated event from receipt
  let campaignId = 0;
  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed && parsed.name === "CampaignCreated") {
        campaignId = Number(parsed.args.campaignId);
        break;
      }
    } catch {
      /* ignore */
    }
  }

  return { campaignId, txHash: tx.hash };
}

export async function donateAction(
  signer: Signer,
  campaignId: number,
  amountEth: string,
): Promise<{ txHash: string }> {
  const escrow = getCampaignEscrowContract(signer);
  const value = parseEther(amountEth);
  const tx = await escrow.donate(campaignId, { value });
  await tx.wait();
  return { txHash: tx.hash };
}

export async function releaseMilestoneAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
): Promise<{ txHash: string }> {
  const escrow = getCampaignEscrowContract(signer);
  const tx = await escrow.release(campaignId, milestoneId);
  await tx.wait();
  return { txHash: tx.hash };
}

export async function resolveDisputeAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
  uphold: boolean,
): Promise<{ txHash: string }> {
  const escrow = getCampaignEscrowContract(signer);
  const tx = await escrow.resolveDispute(campaignId, milestoneId, uphold);
  await tx.wait();
  return { txHash: tx.hash };
}

export async function sweepUnallocatedAction(
  signer: Signer,
  toAddress: string,
): Promise<{ txHash: string }> {
  const escrow = getCampaignEscrowContract(signer);
  const tx = await escrow.sweepUnallocated(toAddress);
  await tx.wait();
  return { txHash: tx.hash };
}

// ── VerifierRegistry Actions ────────────────────────────────────────────────

export async function stakeAction(
  signer: Signer,
  amountEth: string,
): Promise<{ txHash: string }> {
  const registry = getVerifierRegistryContract(signer);
  const value = parseEther(amountEth);
  const tx = await registry.stake({ value });
  await tx.wait();
  return { txHash: tx.hash };
}

export async function unstakeAction(signer: Signer): Promise<{ txHash: string }> {
  const registry = getVerifierRegistryContract(signer);
  const tx = await registry.unstake();
  await tx.wait();
  return { txHash: tx.hash };
}

// ── ProofRegistry Actions ───────────────────────────────────────────────────

export async function submitProofAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
  cid: string,
): Promise<{ txHash: string }> {
  const proofs = getProofRegistryContract(signer);
  const tx = await proofs.submitProof(campaignId, milestoneId, cid);
  await tx.wait();
  return { txHash: tx.hash };
}

// ── MilestoneVoting Actions ─────────────────────────────────────────────────

export async function openVotingRoundAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
): Promise<{ txHash: string }> {
  const voting = getMilestoneVotingContract(signer);
  const tx = await voting.openVotingRound(campaignId, milestoneId);
  await tx.wait();
  return { txHash: tx.hash };
}

export async function castVoteAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
  approve: boolean,
): Promise<{ txHash: string }> {
  const voting = getMilestoneVotingContract(signer);
  const tx = await voting.castVote(campaignId, milestoneId, approve);
  await tx.wait();
  return { txHash: tx.hash };
}

export async function finalizeRoundAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
): Promise<{ txHash: string }> {
  const voting = getMilestoneVotingContract(signer);
  const tx = await voting.finalizeRound(campaignId, milestoneId);
  await tx.wait();
  return { txHash: tx.hash };
}

export async function raiseDisputeAction(
  signer: Signer,
  campaignId: number,
  milestoneId: number,
): Promise<{ txHash: string }> {
  const voting = getMilestoneVotingContract(signer);
  const tx = await voting.raiseDispute(campaignId, milestoneId);
  await tx.wait();
  return { txHash: tx.hash };
}
