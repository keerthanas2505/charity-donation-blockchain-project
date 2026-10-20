import { BrowserProvider } from "ethers";

export interface ConnectedWallet {
  provider: BrowserProvider;
  address: string;
}

/**
 * True if an EIP-1193 injected wallet (MetaMask or otherwise) is present in
 * this browser. Safe to call anywhere — never throws.
 */
export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && typeof window.ethereum !== "undefined";
}

/**
 * Prompts the user via the wallet's account-selection popup (skipped by the
 * wallet if this site is already authorized) and returns a connected
 * BrowserProvider plus the active address.
 *
 * Throws if no injected wallet exists, no account is returned, or the user
 * rejects the request (ethers/MetaMask surface that as an error with
 * `code === "ACTION_REJECTED"` / `4001`) — callers are expected to catch this.
 */
export async function requestConnection(): Promise<ConnectedWallet> {
  if (!hasInjectedWallet()) {
    throw new Error("No wallet found — please install MetaMask");
  }
  const provider = new BrowserProvider(window.ethereum!);
  const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
  const address = accounts[0];
  if (!address) {
    throw new Error("No account was authorized");
  }
  return { provider, address };
}

/**
 * Silent check for an already-authorized account — no popup. Used to restore
 * connection state on page load without forcing a fresh eth_requestAccounts
 * prompt every time.
 */
export async function getAuthorizedAccount(): Promise<ConnectedWallet | null> {
  if (!hasInjectedWallet()) return null;
  const provider = new BrowserProvider(window.ethereum!);
  const accounts = (await provider.send("eth_accounts", [])) as string[];
  if (accounts.length === 0) return null;
  return { provider, address: accounts[0] };
}

/** The chain ID the given provider is currently pointed at. */
export async function getChainId(provider: BrowserProvider): Promise<number> {
  const network = await provider.getNetwork();
  return Number(network.chainId);
}

/**
 * A fresh BrowserProvider wrapping window.ethereum. Callers must check
 * hasInjectedWallet() first — this throws otherwise (mirrors requestConnection).
 * Used when we already know an account is authorized (e.g. a live
 * accountsChanged event) but don't have a provider instance on hand yet.
 */
export function getInjectedProvider(): BrowserProvider {
  if (!hasInjectedWallet()) {
    throw new Error("No wallet found — please install MetaMask");
  }
  return new BrowserProvider(window.ethereum!);
}

/**
 * Switch connected network in MetaMask. Adds the network if missing.
 */
export async function switchNetwork(chainId: number): Promise<void> {
  if (!hasInjectedWallet() || !window.ethereum) {
    throw new Error("No wallet found");
  }
  const hexChainId = "0x" + chainId.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
  } catch (err: unknown) {
    const error = err as { code?: number };
    // 4902 means the chain has not been added to MetaMask
    if (error.code === 4902) {
      if (chainId === 31337) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: hexChainId,
              chainName: "Hardhat Localhost",
              rpcUrls: ["http://127.0.0.1:8545"],
              nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            },
          ],
        });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
}

