import { createContext } from "react";
import type { BrowserProvider, JsonRpcSigner } from "ethers";

export type WalletStatus = "disconnected" | "connecting" | "connected" | "error";

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  chainId: number | null;
  error: string | null;
  /** Whether an injected wallet (MetaMask or otherwise) was found at all. */
  isWalletInstalled: boolean;
  /**
   * The ethers provider wrapping window.ethereum, set whenever `status ===
   * "connected"` (null otherwise).
   */
  provider: BrowserProvider | null;
}

export interface WalletContextValue extends WalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: (chainId: number) => Promise<void>;
  getSigner: () => Promise<JsonRpcSigner | null>;
}

export const initialWalletState: WalletState = {
  status: "disconnected",
  address: null,
  chainId: null,
  error: null,
  isWalletInstalled: false,
  provider: null,
};

export const WalletContext = createContext<WalletContextValue | null>(null);
