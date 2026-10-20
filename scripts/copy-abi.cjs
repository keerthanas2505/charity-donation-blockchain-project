const fs = require("fs");
const path = require("path");

const contracts = ["CampaignEscrow", "VerifierRegistry", "MilestoneVoting", "ProofRegistry"];
for (const name of contracts) {
  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const targetPath = path.join(__dirname, "..", "frontend", "src", "abi", `${name}.json`);
  fs.writeFileSync(targetPath, JSON.stringify(artifact.abi, null, 2));
  console.log(`Copied ${name} ABI (${artifact.abi.length} entries) to ${targetPath}`);
}
