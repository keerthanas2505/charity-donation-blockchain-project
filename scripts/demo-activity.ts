import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";
import { network } from "hardhat";

/**
 * Generates real on-chain activity against the ALREADY-DEPLOYED contracts on your
 * local Hardhat node, so the indexer has events to pick up.
 *
 *   1) terminal 1:  npx hardhat node
 *   2) terminal 2:  npx hardhat run scripts/deploy.ts        (once)
 *   3) terminal 3:  npx hardhat run scripts/demo-activity.ts --network localhost
 *
 * It does NOT deploy anything — it attaches to the CampaignEscrow whose address it
 * reads from indexer/.env (edit ESCROW_ADDRESS there, or override the ESCROW
 * constant below). Then, as the deployer:
 *   1. createCampaign() with 2 milestones (beneficiary = signer #1, or #0 solo)
 *   2. donate() ETH to that campaign
 *   3. prints the campaign id and every transaction hash
 *
 * `network.create({ network: "localhost" })` connects over HTTP to Hardhat 3's
 * built-in `localhost` network (http://127.0.0.1:8545) — the same one deploy.ts
 * uses. The `--network localhost` flag is therefore redundant but harmless.
 */

// ── Resolve the deployed CampaignEscrow address ──────────────────────────────
// Read it from indexer/.env so this script and the indexer never drift apart.
// Set ESCROW here to hard-code instead.
const ESCROW: string | undefined = undefined;

function escrowAddressFromEnvFile(): string {
  const envPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "indexer",
    ".env",
  );
  const parsed = parseEnv(readFileSync(envPath, "utf8"));
  const addr = parsed.ESCROW_ADDRESS;
  if (!addr) {
    throw new Error(
      `ESCROW_ADDRESS not found in ${envPath} — set the ESCROW constant in this script instead`,
    );
  }
  return addr;
}

const escrowAddr = ESCROW ?? escrowAddressFromEnvFile();

// ── Connect ─────────────────────────────────────────────────────────────────
const { ethers } = await network.create({
  network: process.env.DEPLOY_NETWORK ?? "localhost",
});

const signers = await ethers.getSigners();
const creator = signers[0];
const beneficiary = signers[1] ?? signers[0]; // node gives 20 accounts; fall back to solo

console.log("Escrow      :", escrowAddr);
console.log("Creator     :", creator.address);
console.log("Beneficiary :", beneficiary.address);

// Fail fast with a clear message if nothing is deployed at that address.
if ((await ethers.provider.getCode(escrowAddr)) === "0x") {
  throw new Error(
    `no contract code at ${escrowAddr} — is the node running and has deploy.ts been run against it?`,
  );
}

const escrow = await ethers.getContractAt("CampaignEscrow", escrowAddr, creator);

// ── 1. Create a campaign with 2 milestones ──────────────────────────────────
const descriptions = [
  "Milestone 1: procure and deliver 500 water filters",
  "Milestone 2: install filters and train 10 local technicians",
];
const amounts = [ethers.parseEther("0.001"), ethers.parseEther("0.002")]; // 0.003 ETH total

const createTx = await escrow.createCampaign(
  beneficiary.address,
  descriptions,
  amounts,
);
const createRcpt = await createTx.wait();

// Pull the campaign id out of the CampaignCreated event
//   event CampaignCreated(uint256 indexed campaignId, address indexed creator,
//                         address indexed beneficiary, uint256 milestoneCount)
let campaignId: bigint | undefined;
for (const log of createRcpt!.logs) {
  try {
    const parsed = escrow.interface.parseLog(log);
    if (parsed?.name === "CampaignCreated") {
      campaignId = parsed.args.campaignId as bigint;
      break;
    }
  } catch {
    // log from another contract / not decodable with this ABI — ignore
  }
}
if (campaignId === undefined) {
  // Fallback: the new campaign is always the last one.
  campaignId = (await escrow.campaignCount()) - 1n;
}

console.log("\n1. createCampaign");
console.log("   campaignId :", campaignId.toString());
console.log("   milestones :", descriptions.length);
console.log("   tx hash    :", createTx.hash);
console.log("   block      :", createRcpt!.blockNumber);

// ── 2. Donate ETH to it ─────────────────────────────────────────────────────
const donationAmount = ethers.parseEther("0.003");
const donateTx = await escrow.donate(campaignId, { value: donationAmount });
const donateRcpt = await donateTx.wait();

console.log("\n2. donate");
console.log("   amount  :", ethers.formatEther(donationAmount), "ETH");
console.log("   tx hash :", donateTx.hash);
console.log("   block   :", donateRcpt!.blockNumber);

// ── 3. Summary ─────────────────────────────────────────────────────────────
const [, ben, balance, reserved] = await escrow.getCampaign(campaignId);
console.log("\n3. on-chain state");
console.log("   campaignId          :", campaignId.toString());
console.log("   beneficiary         :", ben);
console.log("   balance             :", ethers.formatEther(balance), "ETH");
console.log("   reserved            :", ethers.formatEther(reserved), "ETH");
console.log("   createCampaign tx   :", createTx.hash);
console.log("   donate tx           :", donateTx.hash);
