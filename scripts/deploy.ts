import { network } from "hardhat";

/**
 * Deploys the Charity Donation Tracking System and wires every authorized-caller
 * address.
 *
 * Deploys against the PERSISTENT local node you start separately, so the
 * contracts and their state survive this script exiting and the indexer can
 * listen to them:
 *
 *   1) in one terminal:   npx hardhat node
 *   2) in another:         npx hardhat run scripts/deploy.ts
 *
 * `network.create({ network: "localhost" })` connects over HTTP to Hardhat 3's
 * built-in `localhost` network — http://127.0.0.1:8545, which is where
 * `hardhat node` serves. (No `--network` flag needed; passing one is overridden
 * by the explicit name here. To deploy elsewhere, change "localhost" to another
 * configured network, e.g. "sepolia".) A bare `network.create()` would instead
 * spin up an in-memory chain that vanishes when the script exits.
 *
 * The account that runs this becomes the IMMUTABLE `owner` of CampaignEscrow and
 * VerifierRegistry (it can resolveDispute, sweepUnallocated, and run the one-shot
 * wiring setters). Use a multisig for a real deployment.
 */

const { ethers } = await network.create({
  network: process.env.DEPLOY_NETWORK ?? "localhost",
});

// ── Parameters ───────────────────────────────────────────────────────────────
// VerifierRegistry constructor requires minStake > 0. Tune before mainnet.
const MIN_STAKE = ethers.parseEther("0.01");

// ── Signer ───────────────────────────────────────────────────────────────────
const [deployer] = await ethers.getSigners();
console.log("Deployer:", deployer.address);
console.log(
  "Balance :",
  ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
  "ETH",
);
console.log("minStake:", ethers.formatEther(MIN_STAKE), "ETH\n");

// ─────────────────────────────────────────────────────────────────────────────
// Deploy in dependency order. Every constructor argument below is stored in an
// `immutable`, so each dependency must already exist on-chain when we deploy the
// contract that points at it.
// ─────────────────────────────────────────────────────────────────────────────

// 1. CampaignEscrow — no constructor dependencies (root of the graph).
const escrow = await ethers.deployContract("CampaignEscrow");
await escrow.waitForDeployment();
const escrowAddr = await escrow.getAddress();
console.log("1. CampaignEscrow  ", escrowAddr);

// 2. VerifierRegistry — constructor(minStake, escrow).
const registry = await ethers.deployContract("VerifierRegistry", [
  MIN_STAKE,
  escrowAddr,
]);
await registry.waitForDeployment();
const registryAddr = await registry.getAddress();
console.log("2. VerifierRegistry", registryAddr);

// 3. ProofRegistry — constructor(escrow). Independent of VerifierRegistry;
//    steps 2 and 3 could be swapped.
const proofs = await ethers.deployContract("ProofRegistry", [escrowAddr]);
await proofs.waitForDeployment();
const proofsAddr = await proofs.getAddress();
console.log("3. ProofRegistry   ", proofsAddr);

// 4. MilestoneVoting — constructor(verifiers, proofs, escrow). Needs all three.
const voting = await ethers.deployContract("MilestoneVoting", [
  registryAddr,
  proofsAddr,
  escrowAddr,
]);
await voting.waitForDeployment();
const votingAddr = await voting.getAddress();
console.log("4. MilestoneVoting ", votingAddr, "\n");

// ─────────────────────────────────────────────────────────────────────────────
// Wire authorized callers. These one-shot `onlyOwner` setters gate every
// state-changing cross-contract call. The system is NOT usable until all three
// have run, and they revert ("already set") if run a second time.
// ─────────────────────────────────────────────────────────────────────────────

async function send(
  label: string,
  txPromise: Promise<{ wait: () => Promise<unknown> }>,
): Promise<void> {
  const tx = await txPromise;
  await tx.wait();
  console.log("wired:", label);
}

// gates VerifierRegistry -> escrow.creditSlashed()  (Phase 2 TODO #1)
await send(
  "escrow.verifierRegistry := VerifierRegistry",
  escrow.setVerifierRegistry(registryAddr),
);
// gates MilestoneVoting -> escrow.startTimelock() / raiseDispute()
await send(
  "escrow.milestoneVoting  := MilestoneVoting",
  escrow.setMilestoneVoting(votingAddr),
);
// gates MilestoneVoting -> registry.applyVoteResult() / incrementPendingVotes() / decrementPendingVotes()
await send(
  "registry.milestoneVoting := MilestoneVoting",
  registry.setMilestoneVoting(votingAddr),
);

// ─────────────────────────────────────────────────────────────────────────────
// Verify every wire and every immutable pointer.
// ─────────────────────────────────────────────────────────────────────────────
const checks: Array<[string, string, string]> = [
  ["escrow.milestoneVoting  ", await escrow.milestoneVoting(), votingAddr],
  ["escrow.verifierRegistry ", await escrow.verifierRegistry(), registryAddr],
  ["registry.escrow         ", await registry.escrow(), escrowAddr],
  ["registry.milestoneVoting", await registry.milestoneVoting(), votingAddr],
  ["proofs.escrow           ", await proofs.escrow(), escrowAddr],
  ["voting.escrow           ", await voting.escrow(), escrowAddr],
  ["voting.verifiers        ", await voting.verifiers(), registryAddr],
  ["voting.proofs           ", await voting.proofs(), proofsAddr],
];

console.log();
let allOk = true;
for (const [label, actual, expected] of checks) {
  const pass = actual.toLowerCase() === expected.toLowerCase();
  if (!pass) allOk = false;
  console.log(`  ${pass ? "OK " : "BAD"} ${label} = ${actual}`);
}
if (!allOk) throw new Error("wiring verification failed");

console.log("\nDeployed and wired. owner (escrow + registry) =", deployer.address);

const deployBlock = await ethers.provider.getBlockNumber();
console.log("deployment block:", deployBlock);