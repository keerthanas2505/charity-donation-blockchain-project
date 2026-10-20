import { Contract, type ContractRunner } from "ethers";
import campaignEscrowAbi from "../abi/CampaignEscrow.json";
import verifierRegistryAbi from "../abi/VerifierRegistry.json";
import milestoneVotingAbi from "../abi/MilestoneVoting.json";
import proofRegistryAbi from "../abi/ProofRegistry.json";
import {
  CAMPAIGN_ESCROW_ADDRESS,
  VERIFIER_REGISTRY_ADDRESS,
  MILESTONE_VOTING_ADDRESS,
  PROOF_REGISTRY_ADDRESS,
} from "./constants";

export function getCampaignEscrowContract(runner: ContractRunner): Contract {
  return new Contract(CAMPAIGN_ESCROW_ADDRESS, campaignEscrowAbi, runner);
}

export function getVerifierRegistryContract(runner: ContractRunner): Contract {
  return new Contract(VERIFIER_REGISTRY_ADDRESS, verifierRegistryAbi, runner);
}

export function getMilestoneVotingContract(runner: ContractRunner): Contract {
  return new Contract(MILESTONE_VOTING_ADDRESS, milestoneVotingAbi, runner);
}

export function getProofRegistryContract(runner: ContractRunner): Contract {
  return new Contract(PROOF_REGISTRY_ADDRESS, proofRegistryAbi, runner);
}
