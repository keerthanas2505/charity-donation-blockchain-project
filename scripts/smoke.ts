import { network } from "hardhat";

/**
 * Minimal end-to-end smoke test on a fresh in-memory chain:
 *   deploy + wire (same sequence as scripts/deploy.ts)
 *   -> create a campaign with one milestone
 *   -> fund it (needed for openVotingRound's pre-flight funding check)
 *   -> beneficiary submits a proof CID
 *   -> a staked verifier opens a voting round
 *   -> assert the round's stored proofCID == the submitted CID
 */

const { ethers } = await network.create();

const CID = "QmSmokeTestProofCID00000000000000000000000000";
const MIN_STAKE = ethers.parseEther("0.01");
const MILESTONE_AMOUNT = ethers.parseEther("1");

const log = (s = ""): void => console.log(s);
const step = (n: number | string, s: string): void =>
  console.log(`\n── Step ${n}: ${s} ──`);

const [deployer, beneficiary, verifier] = await ethers.getSigners();
log(`deployer    : ${deployer.address}`);
log(`beneficiary : ${beneficiary.address}`);
log(`verifier    : ${verifier.address}`);

// ── Step 0: deploy + wire (mirrors scripts/deploy.ts) ────────────────────────
step(0, "deploy + wire all four contracts");
const escrow = await ethers.deployContract("CampaignEscrow");
await escrow.waitForDeployment();
const escrowAddr = await escrow.getAddress();

const registry = await ethers.deployContract("VerifierRegistry", [
  MIN_STAKE,
  escrowAddr,
]);
await registry.waitForDeployment();
const registryAddr = await registry.getAddress();

const proofs = await ethers.deployContract("ProofRegistry", [escrowAddr]);
await proofs.waitForDeployment();
const proofsAddr = await proofs.getAddress();

const voting = await ethers.deployContract("MilestoneVoting", [
  registryAddr,
  proofsAddr,
  escrowAddr,
]);
await voting.waitForDeployment();
const votingAddr = await voting.getAddress();

await (await escrow.setVerifierRegistry(registryAddr)).wait();
await (await escrow.setMilestoneVoting(votingAddr)).wait();
await (await registry.setMilestoneVoting(votingAddr)).wait();

log(`  escrow   : ${escrowAddr}`);
log(`  registry : ${registryAddr}`);
log(`  proofs   : ${proofsAddr}`);
log(`  voting   : ${votingAddr}`);
log(`  escrow.milestoneVoting   = ${await escrow.milestoneVoting()}`);
log(`  escrow.verifierRegistry  = ${await escrow.verifierRegistry()}`);
log(`  registry.milestoneVoting = ${await registry.milestoneVoting()}`);

// ── Step 1: create a campaign with one milestone ─────────────────────────────
step(1, "create campaign — beneficiary = signer[1], 1 milestone @ 1 ETH");
await (
  await escrow
    .connect(deployer)
    .createCampaign(
      beneficiary.address,
      ["Dig a borehole well in village X"],
      [MILESTONE_AMOUNT],
    )
).wait();

const campaignId = 0n;
const milestoneId = 0n;
const [creator, benef, balance, reserved, mCount] =
  await escrow.getCampaign(campaignId);
log(`  campaignId     : ${campaignId}`);
log(`  creator        : ${creator}`);
log(`  beneficiary    : ${benef}`);
log(`  balance        : ${ethers.formatEther(balance)} ETH`);
log(`  reserved       : ${ethers.formatEther(reserved)} ETH`);
log(`  milestoneCount : ${mCount}`);
const [mDesc, mAmount, mState] = await escrow.getMilestone(
  campaignId,
  milestoneId,
);
log(
  `  milestone[0]   : "${mDesc}"  amount=${ethers.formatEther(mAmount)} ETH  state=${mState} (0=Pending)`,
);

// ── Step 1b: fund the campaign (openVotingRound requires availableBalance >= amount) ──
step("1b", "donate 1 ETH to the campaign");
await (
  await escrow.connect(deployer).donate(campaignId, { value: MILESTONE_AMOUNT })
).wait();
log(
  `  availableBalance : ${ethers.formatEther(await escrow.availableBalance(campaignId))} ETH`,
);

// ── Step 2: beneficiary submits a proof ──────────────────────────────────────
step(2, "beneficiary submits proof CID");
await (
  await proofs.connect(beneficiary).submitProof(campaignId, milestoneId, CID)
).wait();
log(`  submitted CID       : ${CID}`);
log(`  proofs.hasProof     : ${await proofs.hasProof(campaignId, milestoneId)}`);
log(
  `  proofs.getProofCID  : ${await proofs.getProofCID(campaignId, milestoneId)}`,
);
const [gpCid, gpSubmitter, , gpVersion] = await proofs.getProof(
  campaignId,
  milestoneId,
);
log(
  `  getProof           : cid="${gpCid}" submitter=${gpSubmitter} version=${gpVersion}`,
);

// ── Step 3: a staked verifier opens a voting round ───────────────────────────
step(3, "verifier stakes, then opens a voting round");
await (await registry.connect(verifier).stake({ value: MIN_STAKE })).wait();
log(
  `  isVerifier(verifier)   : ${await registry.isVerifier(verifier.address)}`,
);
log(
  `  reputationOf(verifier) : ${await registry.reputationOf(verifier.address)}`,
);
log(`  totalWeight            : ${await registry.totalWeight()}`);
await (
  await voting.connect(verifier).openVotingRound(campaignId, milestoneId)
).wait();
log(
  `  currentRoundIndex      : ${await voting.currentRoundIndex(campaignId, milestoneId)}`,
);

// ── Step 4: round.proofCID must equal the submitted CID ──────────────────────
step(4, "assert round.proofCID == submitted CID");
const round = await voting.getRound(campaignId, milestoneId);
log(`  getRound().status        : ${round.status} (1=Open)`);
log(`  getRound().weightSnapshot : ${round.weightSnapshot}`);
log(`  getRound().proofCID       : ${round.proofCID}`);
log(`  submitted CID             : ${CID}`);
log(
  `  live proofs.getProofCID   : ${await proofs.getProofCID(campaignId, milestoneId)}`,
);

log();
if (round.proofCID !== CID) {
  throw new Error(`MISMATCH: round.proofCID=${round.proofCID} submitted=${CID}`);
}
log("SMOKE TEST PASSED — round proofCID matches the submitted CID");
