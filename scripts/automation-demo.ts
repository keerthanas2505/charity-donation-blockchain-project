import { network } from "hardhat";

/**
 * Demonstrates the Chainlink Automation path on CampaignEscrow without a real
 * Automation registry: deploy + wire, drive one milestone to Timelocked, warp
 * past the 48h window, then call checkUpkeep() (off-chain simulation) and feed
 * its performData straight into performUpkeep() (what the registry would send).
 *
 *   npx hardhat run scripts/automation-demo.ts
 */

const { ethers, networkHelpers } = await network.create();

const MIN_STAKE = ethers.parseEther("0.01");
const AMOUNT = ethers.parseEther("1");
const CID = "QmAutomationCheckCID000000000000000000000000";
const log = (s = "") => console.log(s);

const [deployer, beneficiary, verifier] = await ethers.getSigners();

// deploy + wire
const escrow = await ethers.deployContract("CampaignEscrow");
await escrow.waitForDeployment();
const escrowAddr = await escrow.getAddress();
const registry = await ethers.deployContract("VerifierRegistry", [MIN_STAKE, escrowAddr]);
await registry.waitForDeployment();
const proofs = await ethers.deployContract("ProofRegistry", [escrowAddr]);
await proofs.waitForDeployment();
const voting = await ethers.deployContract("MilestoneVoting", [
  await registry.getAddress(), await proofs.getAddress(), escrowAddr,
]);
await voting.waitForDeployment();
await (await escrow.setVerifierRegistry(await registry.getAddress())).wait();
await (await escrow.setMilestoneVoting(await voting.getAddress())).wait();
await (await registry.setMilestoneVoting(await voting.getAddress())).wait();

// campaign + funding + proof + verifier
await (await escrow.createCampaign(beneficiary.address, ["well"], [AMOUNT])).wait();
await (await escrow.donate(0, { value: AMOUNT })).wait();
await (await proofs.connect(beneficiary).submitProof(0, 0, CID)).wait();
await (await registry.connect(verifier).stake({ value: MIN_STAKE })).wait();

// open round, approve, finalize -> startTimelock
await (await voting.connect(verifier).openVotingRound(0, 0)).wait();
await (await voting.connect(verifier).castVote(0, 0, true)).wait();
await (await voting.connect(verifier).finalizeRound(0, 0)).wait();

let [, , stAfter, relAfter] = await escrow.getMilestone(0, 0);
log(`after finalize: milestone state=${stAfter} (1=Timelocked) releaseAfter=${relAfter}`);

// checkUpkeep BEFORE the window elapses -> should be false
let [needed0, data0] = await escrow.checkUpkeep("0x");
log(`checkUpkeep (pre-elapse):  upkeepNeeded=${needed0}  performData=${data0}`);

// warp past the 48h timelock
await networkHelpers.time.increase(48 * 3600 + 1);

// checkUpkeep AFTER -> should be true, with performData encoding ([0],[0])
let [needed1, data1] = await escrow.checkUpkeep("0x");
log(`checkUpkeep (post-elapse): upkeepNeeded=${needed1}`);
const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint256[]", "uint256[]"], data1);
log(`  performData decodes to campaignIds=[${decoded[0]}] milestoneIds=[${decoded[1]}]`);

// performUpkeep -> releases; beneficiary should receive 1 ETH
const balBefore = await ethers.provider.getBalance(beneficiary.address);
const tx = await escrow.performUpkeep(data1);
const rcpt = await tx.wait();
const balAfter = await ethers.provider.getBalance(beneficiary.address);

let [, , stFinal] = await escrow.getMilestone(0, 0);
log(`after performUpkeep: milestone state=${stFinal} (2=Released)`);
log(`beneficiary balance delta = ${ethers.formatEther(balAfter - balBefore)} ETH`);
const evNames = (rcpt?.logs ?? []).map((l: any) => { try { return escrow.interface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
log(`events emitted by escrow: ${evNames.join(", ")}`);

// second performUpkeep on same data -> nothing releasable -> should revert
try {
  await (await escrow.performUpkeep(data1)).wait();
  log("second performUpkeep: DID NOT REVERT (unexpected)");
} catch (e: any) {
  log(`second performUpkeep reverts as expected: ${e.shortMessage ?? e.message}`);
}

log("\nautomation check done");
