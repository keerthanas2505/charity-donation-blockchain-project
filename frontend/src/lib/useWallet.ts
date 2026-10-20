import { useContext } from "react";
import { WalletContext, type WalletContextValue } from "./walletContextValue";

/**
 * Wallet connection state (address, chain ID, status, error) plus
 * connect/disconnect. Must be used within a <WalletProvider> (mounted in
 * main.tsx around <App />).
 */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a <WalletProvider>");
  }
  return ctx;
}
