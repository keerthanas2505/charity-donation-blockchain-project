import { network } from "hardhat";

/**
 * End-to-end multi-milestone demonstration script.
 * Can run against in-memory network or localhost node:
 *   npx hardhat run scripts/demo-full-lifecycle.ts
 */

const { ethers, networkHelpers } = await network.create();

const MIN_STAKE = ethers.parseEther("0.01");
const M0_AMOUNT = ethers.parseEther("0.5");
const M1_AMOUNT = ethers.parseEther("0.8");

console.log("=== Charity Donation Blockchain Project: Complete Lifecycle Demo ===\n");

const [deployer, beneficiary, v1, v2, v3, donor] = await ethers.getSigners();
console.log(`Deployer    : ${deployer.address}`);
console.log(`Beneficiary : ${beneficiary.address}`);
console.log(`Verifiers   : ${v1.address}, ${v2.address}, ${v3.address}`);
console.log(`Donor       : ${donor.address}\n`);

// 1. Deploy all 4 contracts
console.log("1. Deploying and wiring contracts...");
const escrow = await ethers.deployContract("CampaignEscrow");
await escrow.waitForDeployment();
const escrowAddr = await escrow.getAddress();

const registry = await ethers.deployContract("VerifierRegistry", [MIN_STAKE, escrowAddr]);
await registry.waitForDeployment();
const registryAddr = await registry.getAddress();

const proofs = await ethers.deployContract("ProofRegistry", [escrowAddr]);
await proofs.waitForDeployment();
const proofsAddr = await proofs.getAddress();

const voting = await ethers.deployContract("MilestoneVoting", [registryAddr, proofsAddr, escrowAddr]);
await voting.waitForDeployment();
const votingAddr = await voting.getAddress();

await (await escrow.setVerifierRegistry(registryAddr)).wait();
await (await escrow.setMilestoneVoting(votingAddr)).wait();
await (await registry.setMilestoneVoting(votingAddr)).wait();
console.log("   Contracts deployed and cross-authorized successfully.\n");

// 2. Register Verifiers
console.log("2. Staking verifiers...");
await (await registry.connect(v1).stake({ value: ethers.parseEther("0.05") })).wait();
await (await registry.connect(v2).stake({ value: ethers.parseEther("0.05") })).wait();
await (await registry.connect(v3).stake({ value: ethers.parseEther("0.05") })).wait();
console.log(`   3 Verifiers registered. Total active weight: ${await registry.totalWeight()}\n`);

// 3. Create Campaign
console.log("3. Creating campaign with 2 milestones...");
await (
  await escrow.connect(deployer).createCampaign(
    beneficiary.address,
    ["Milestone 1: Purchase 100 emergency medical kits", "Milestone 2: Deliver kits to regional clinics"],
    [M0_AMOUNT, M1_AMOUNT],
  )
).wait();
const campaignId = 0n;
console.log(`   Campaign #${campaignId} created. Beneficiary: ${beneficiary.address}\n`);

// 4. Donate ETH
console.log("4. Donating ETH to campaign escrow...");
await (await escrow.connect(donor).donate(campaignId, { value: ethers.parseEther("2.0") })).wait();
console.log(`   Donated 2.0 ETH. Available balance: ${ethers.formatEther(await escrow.availableBalance(campaignId))} ETH\n`);

// 5. Milestone 0: Submit Proof
console.log("5. Submitting milestone 0 proof to ProofRegistry...");
const proofCID = "ipfs://QmCharityMedicalKitShipmentReceipt2026";
await (await proofs.connect(beneficiary).submitProof(campaignId, 0, proofCID)).wait();
console.log(`   Proof pinned: ${proofCID}\n`);

// 6. Open Voting Round
console.log("6. Opening community voting round for Milestone 0...");
await (await voting.connect(v1).openVotingRound(campaignId, 0)).wait();
console.log("   Round #1 opened. Weight snapshot: 300\n");

// 7. Cast Votes
console.log("7. Verifiers voting...");
await (await voting.connect(v1).castVote(campaignId, 0, true)).wait();
await (await voting.connect(v2).castVote(campaignId, 0, true)).wait();
console.log("   Verifiers 1 and 2 voted APPROVE (Weight: 200/300 = 66.6% >= 66% threshold)\n");

// 8. Finalize Round
console.log("8. Finalizing round...");
await (await voting.connect(v1).finalizeRound(campaignId, 0)).wait();
const [, , mState, releaseAfter] = await escrow.getMilestone(campaignId, 0);
console.log(`   Milestone 0 state: ${mState} (1 = Timelocked). Release timestamp: ${releaseAfter}\n`);

// 9. Advance Time past 48h timelock
console.log("9. Fast-forwarding 48 hours past challenge timelock window...");
await networkHelpers.time.increase(48 * 3600 + 5);

// 10. Release Funds
console.log("10. Triggering release of funds to beneficiary...");
const benefBalBefore = await ethers.provider.getBalance(beneficiary.address);
await (await escrow.connect(donor).release(campaignId, 0)).wait();
const benefBalAfter = await ethers.provider.getBalance(beneficiary.address);
console.log(`    Beneficiary balance received: +${ethers.formatEther(benefBalAfter - benefBalBefore)} ETH`);

const [, , mStateFinal] = await escrow.getMilestone(campaignId, 0);
console.log(`    Milestone 0 final state: ${mStateFinal} (2 = Released)!\n`);

console.log("=== End-to-End Demo Completed Successfully ===");
