export type MilestoneStateName =
  | "Pending"
  | "Timelocked"
  | "Released"
  | "Disputed"
  | "Rejected";

export interface ProofInfo {
  submitted: boolean;
  cid?: string;
  submitter?: string;
  version?: number;
  submittedAt?: string;
  submittedTx?: string;
}

export interface RoundInfo {
  roundIndex: number;
  status: "Open" | "Finalized";
  approveWeight: string;
  rejectWeight: string;
  weightSnapshot: string;
  approved: boolean | null;
  proofCid: string;
  deadline: string;
  disputeWeight: string;
  disputeForwarded: boolean;
  openedBlock: number;
}

export interface Milestone {
  id: number;
  description: string;
  amount: string;
  state: MilestoneStateName;
  releaseAfter: string | null;
  proof: ProofInfo;
  latestRound: RoundInfo | null;
}

export interface Campaign {
  id: number;
  beneficiary: string;
  creator: string;
  balance: string;
  reserved: string;
  available: string;
  milestoneCount: number;
  createdAt: string;
  createdBlock: number;
  createdTx: string;
  milestones?: Milestone[];
}

export interface CampaignListResponse {
  count: number;
  sort: string | null;
  limit: number;
  campaigns: Campaign[];
}

export interface Donation {
  donor: string;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: string;
}

export interface DonationsResponse {
  campaignId: number;
  count: number;
  limit: number;
  totalInPage: string;
  donations: Donation[];
}

export interface VerifierLeaderboardEntry {
  rank: number;
  address: string;
  reputation: number;
  stakedAmount: string;
  isVerifier: boolean;
  againstStrikes: number;
  firstJoinedBlock: number | null;
}

export interface VerifierDetail {
  address: string;
  isVerifier: boolean;
  reputation: number;
  stakedAmount: string;
  againstStrikes: number;
  firstJoinedBlock: number | null;
  votes: Array<{
    campaignId: number;
    milestoneId: number;
    roundIndex: number;
    approve: boolean;
    weight: string;
    aligned: boolean | null;
    txHash: string;
    blockNumber: number;
  }>;
}

export interface PlatformStats {
  campaignCount: number;
  totalBalance: string;
  totalReserved: string;
  totalDonated: string;
  donationCount: number;
  activeVerifiers: number;
  totalStaked: string;
  releasedAmount: string;
  openRounds: number;
}
