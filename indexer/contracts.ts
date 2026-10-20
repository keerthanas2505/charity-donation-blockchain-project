import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { config } from "./config.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function abiOf(contract: string): ethers.InterfaceAbi {
  const p = resolve(
    projectRoot,
    "artifacts",
    "contracts",
    `${contract}.sol`,
    `${contract}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

export type ContractKey = "escrow" | "registry" | "voting" | "proofs";

const ABI: Record<ContractKey, ethers.InterfaceAbi> = {
  escrow: abiOf("CampaignEscrow"),
  registry: abiOf("VerifierRegistry"),
  voting: abiOf("MilestoneVoting"),
  proofs: abiOf("ProofRegistry"),
};

export function makeProvider(): ethers.AbstractProvider {
  return config.rpcUrl.startsWith("ws")
    ? new ethers.WebSocketProvider(config.rpcUrl)
    : new ethers.JsonRpcProvider(config.rpcUrl);
}

export interface Contracts {
  provider: ethers.AbstractProvider;
  iface: Record<ContractKey, ethers.Interface>;
  contract: Record<ContractKey, ethers.Contract>;
  addressToKey: Record<string, ContractKey>; // lowercased
  allAddresses: string[];
}

export function makeContracts(provider: ethers.AbstractProvider): Contracts {
  const iface = {} as Record<ContractKey, ethers.Interface>;
  const contract = {} as Record<ContractKey, ethers.Contract>;
  const addressToKey: Record<string, ContractKey> = {};
  for (const key of Object.keys(ABI) as ContractKey[]) {
    iface[key] = new ethers.Interface(ABI[key]);
    contract[key] = new ethers.Contract(config.addresses[key], ABI[key], provider);
    addressToKey[config.addresses[key]] = key;
  }
  return {
    provider,
    iface,
    contract,
    addressToKey,
    allAddresses: Object.values(config.addresses),
  };
}
