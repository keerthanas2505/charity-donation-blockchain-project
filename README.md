# TrustFund — Institutional-Grade Blockchain Charity & Milestone Verification Protocol

**TrustFund** is a decentralized, transparent charitable funding and impact verification platform built on Ethereum, PostgreSQL, Express, and React. Donated funds are locked in milestone-based smart contract escrows and disbursed to beneficiaries only when independently staked verifiers validate on-chain proofs through weighted consensus.

---

## 🏛 System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                      TrustFund React 19 Frontend                       │
│     • Campaign Discovery • Creator Studio • Verifier Portal            │
│     • Governance & Disputes • Account Portfolio • Light / Dark Theme   │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ ethers.js (Web3)                │ HTTP REST (fetch)
                   ▼                                 ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│       EVM Smart Contracts            │  │     Express REST API         │
│  • CampaignEscrow (Funds & Timelock) │  │  • /campaigns  • /milestones │
│  • VerifierRegistry (Stakes/Weights) │  │  • /verifiers  • /stats      │
│  • ProofRegistry (IPFS Pointers)     │  │  • /proofs/upload (Pinata)   │
│  • MilestoneVoting (66% Consensus)   │  └──────────────┬───────────────┘
└──────────────────┬───────────────────┘                 │ Read Queries
                   │ Events                              │
                   ▼                                     ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────┐
│          Blockchain Indexer          │──►│     PostgreSQL Database      │
│  (Real-time event sync, log replay)  │  │   (charity_indexer schema)   │
└──────────────────────────────────────┘  └──────────────────────────────┘
```

---

## 🔑 Core Smart Contract Architecture

The TrustFund protocol consists of 4 tightly wired, cross-authorized smart contracts:

1. **`CampaignEscrow.sol`**:
   - Holds donated ETH safely in non-custodial escrow, partitioned into creator-defined milestones.
   - Enforces the fund accounting invariant: `reserved <= balance`.
   - Transitions milestones: `Pending` ➔ `Timelocked` (48h challenge window) ➔ `Released` (paid to beneficiary) or `Disputed` ➔ `Rejected` (funds unreserved).
   - Chainlink Automation compatible (`checkUpkeep` / `performUpkeep`).

2. **`VerifierRegistry.sol`**:
   - Open staking pool (minimum stake: `0.01 ETH`).
   - Verifier reputation tracked between `[0, 200]` (starts at `100`).
   - Verifiers voting with final consensus earn `+5` reputation; voting against consensus incurs `-10` and a strike.
   - 3 consecutive dissent strikes triggers a **10% stake slash**, routed directly into the affected campaign's escrow balance.
   - Locks unstaking while a verifier has pending unresolved votes.

3. **`ProofRegistry.sol`**:
   - Stores immutable IPFS content identifiers (CIDs) per `(campaignId, milestoneId)`.
   - Only the designated campaign beneficiary can submit deliverable proofs.
   - Gated: `MilestoneVoting` refuses to open a voting round unless a valid proof CID is on file.

4. **`MilestoneVoting.sol`**:
   - Orchestrates weighted community consensus.
   - Opens voting rounds once a proof exists, the milestone is `Pending`, and the campaign has sufficient available balance.
   - Pins proof CID and verifier total weight snapshot at round open.
   - **Approval Threshold**: &ge; 66% weighted reputation approval moves the milestone to `Timelocked`.
   - **Dispute Threshold**: During the 48-hour timelock, verifiers can challenge; reaching &ge; 20% dispute weight immediately freezes the milestone to `Disputed`.

---

## 🎨 Design System & User Experience

TrustFund features a fintech design system:

- **Original Brand Mark**: Geometric shield and hexagonal vault node SVG conveying security, transparency, and impact.
- **Iconography**: Clean vector icons via Lucide React; no emojis in user interfaces.
- **Dual Themes**: Complete Light, Dark, and System theme preferences with zero theme-flash and persistent `localStorage` synchronization.
- **Account Portfolio**: Dedicated `/account` view showing real connected wallet activity, created campaigns, verifier stake, reputation score, strikes, and voting history.
- **Code Splitting**: Heavy components (`CampaignDetail`, `VerifierPortal`, `AdminGovernance`, `AccountProfile`) are lazy-loaded with `React.lazy` and `Suspense`.

---

## 🛠 Prerequisites

- **Node.js**: v20+ or v24+
- **npm**: v10+
- **PostgreSQL**: v14+ running locally (database: `charity_indexer`)
- **MetaMask**: Web3 browser extension connected to `Localhost 8545` (Chain ID `31337`)

---

## ⚙️ Environment Configuration

Ensure the following configuration files exist (sample templates are provided in the repository):

### 1. `indexer/.env`
```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/charity_indexer
RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
ESCROW_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
REGISTRY_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
VOTING_ADDRESS=0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
PROOFS_ADDRESS=0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
START_BLOCK=0
CONFIRMATIONS=0
```

### 2. `api/.env`
```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/charity_indexer
CHAIN_ID=31337
ESCROW_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
PORT=4000
CORS_ORIGIN=*
# Optional: Pinata JWT for IPFS file pinning (leave empty for local CID mode)
PINATA_JWT=
```

### 3. `frontend/.env.local`
```ini
VITE_API_BASE_URL=http://localhost:4000
VITE_CHAIN_ID=31337
```

---

## 🚀 Step-by-Step Running Instructions

Follow these steps to run the complete TrustFund stack locally:

### Step 1: Install Dependencies
```bash
# Root dependencies (Hardhat, Ethers, Indexer)
npm install

# Backend API dependencies
npm --prefix api install

# Frontend dependencies
npm --prefix frontend install
```

### Step 2: Initialize Database Migrations
Create the PostgreSQL database and run the initial migration:
```bash
# In psql or your Postgres client:
# CREATE DATABASE charity_indexer;

npm run db:migrate
```

### Step 3: Start the Local Hardhat Node
In Terminal 1:
```bash
npx hardhat node
```
*Leave this running. It serves a JSON-RPC node at `http://127.0.0.1:8545` with 20 pre-funded test accounts.*

### Step 4: Deploy & Wire Contracts
In Terminal 2:
```bash
npm run deploy:local
```
*This deploys all 4 smart contracts and configures mutual authorization addresses.*

### Step 5: Register Deployment & Start the Indexer
In Terminal 2:
```bash
# Register the deployment in the PostgreSQL database
npm run indexer:register

# Start the event indexer service
npm run indexer
```
*The indexer listens for on-chain events and keeps PostgreSQL synchronized in real time.*

### Step 6: Start the Backend REST API
In Terminal 3:
```bash
npm run api:start
```
*The REST API will be available at `http://localhost:4000` with `/health`, `/stats`, `/campaigns`, `/verifiers`, and `/milestones`.*

### Step 7: Start the Frontend dApp
In Terminal 4:
```bash
npm run frontend:dev
```
*Open your browser and navigate to `http://localhost:5173`.*

---

## 🧪 Running Tests & Build Verifications

Execute test suites across every layer of the application:

```bash
# 1. Run all smart contract tests (3 Solidity + 58 Mocha tests = 61 passing)
npm test

# 2. Run backend API integration tests (7 passing)
npm run api:test

# 3. Typecheck root scripts and indexer
npx tsc --noEmit

# 4. Typecheck and build the Backend API
npm --prefix api run typecheck
npm --prefix api run build

# 5. Typecheck and build the Frontend production bundle (0 errors)
npm --prefix frontend run build
```

---

## 🎬 End-to-End Demonstration Walkthrough

You can test and demonstrate the complete TrustFund workflow either automatically via script or manually through the web UI:

### Automated Script Demonstration
Run the end-to-end lifecycle script:
```bash
npm run demo
```
This script automatically executes:
1. Contract deployment and cross-authorization
2. Staking 3 verifiers (`0.05 ETH` each)
3. Creating a 2-milestone campaign (`0.5 ETH` and `0.8 ETH`)
4. Donating `2.0 ETH` from a donor
5. Beneficiary submitting an IPFS proof CID
6. Opening a community voting round
7. Verifiers voting to approve (&ge; 66% threshold reached)
8. Finalizing the round into `Timelocked` status
9. Fast-forwarding the EVM clock past the 48-hour timelock window
10. Permissionless release of milestone payout directly to the beneficiary's wallet!

### Web UI Demonstration via MetaMask
1. **Connect Wallet**: Click **Connect Wallet** in the top right. Select an account from Hardhat's test accounts (e.g. Account #0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`).
2. **Network Setup**: Ensure MetaMask is connected to **Localhost 8545** (Chain ID `31337`). Use the **Switch Network** button if prompted.
3. **Explore Campaigns**: Browse deployed initiatives, search by ID or address, and filter by escrow size or milestone count.
4. **Deploy Campaign**: Click **+ Create Campaign**. Specify a beneficiary address, milestone descriptions (e.g., "Phase 1: Solar Panel Procurement"), and target ETH amounts. Click **Deploy Escrow on Blockchain**.
5. **Contribute Funds**: Click **Contribute** on any campaign card. Select a preset (e.g., `0.5 ETH`) and confirm the transaction in MetaMask.
6. **Join Verifier Pool**: Switch to the **Verifier Hub** tab. Enter `0.05 ETH` and click **Stake & Register**. Your reputation will initialize at 100 with 0 strikes.
7. **Submit Proof (as Beneficiary)**: Open the campaign details as the beneficiary address. Enter an IPFS CID (or upload an evidence file) and click **Submit CID**.
8. **Vote & Finalize**: Click **Open Community Voting Round**. As an active verifier, vote **Approve Proof**. Once 66% approval is reached, click **Finalize Round**.
9. **Dispute / Release**: The milestone enters the `Timelocked` state. Verifiers can flag a dispute if needed. Once the 48-hour timelock window elapses, click **Execute Milestone Payout** to transfer funds to the beneficiary.
10. **Governance / Owner**: Under **Governance**, the contract owner can adjudicate disputed milestones (Uphold or Reject) and sweep unallocated slashed collateral.
11. **Account Portfolio**: Visit the **Account** tab to review your connected address, ETH balance, deployed campaigns, verifier stake, and past voting records.

---

## 🔒 Security & Edge-Case Safeguards

- **Reentrancy Protection**: All fund-transferring functions (`release`, `resolveDispute`, `unstake`, `sweepUnallocated`) employ non-reentrant guards with Checks-Effects-Interactions (CEI).
- **Proof Pinning**: Milestone voting snapshots the exact proof CID at round opening, preventing beneficiaries from swapping evidence while voting is underway.
- **Unallocated Slash Sink**: Slashes targeted at non-existent campaigns do not revert; funds are safely credited to `unallocatedSlashed` to prevent griefing `finalizeRound()`.
- **Stake Lock**: Verifiers with pending unresolved votes cannot call `unstake()` until all their active rounds are settled.
- **Input & Bounds Validation**: Upkeep loops enforce `MAX_UPKEEP_BATCH = 20` and `MAX_CAMPAIGN_SCAN = 100` to prevent out-of-gas exploits.
- **Non-Custodial Architecture**: TrustFund never stores, requests, or transmits private keys, recovery phrases, or custodial passwords. All state changes are signed directly through Web3 providers.
