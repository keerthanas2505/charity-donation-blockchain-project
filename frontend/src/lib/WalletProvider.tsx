import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { JsonRpcSigner } from "ethers";
import {
  getAuthorizedAccount,
  getChainId,
  getInjectedProvider,
  hasInjectedWallet,
  requestConnection,
  switchNetwork as switchNetworkUtil,
} from "./wallet";
import {
  WalletContext,
  initialWalletState,
  type WalletContextValue,
  type WalletState,
} from "./walletContextValue";

function messageFor(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    ((err as { code?: unknown }).code === 4001 ||
      (err as { code?: unknown }).code === "ACTION_REJECTED")
  ) {
    return "Connection request rejected";
  }
  if (err instanceof Error) return err.message;
  return "Failed to connect wallet";
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>(() => ({
    ...initialWalletState,
    isWalletInstalled: hasInjectedWallet(),
  }));
  const mountedRef = useRef(true);

  const connect = useCallback(async () => {
    if (!hasInjectedWallet()) {
      setState((s) => ({
        ...s,
        status: "error",
        error: "No wallet found — please install MetaMask",
        isWalletInstalled: false,
        provider: null,
      }));
      return;
    }
    setState((s) => ({ ...s, status: "connecting", error: null }));
    try {
      const { provider, address } = await requestConnection();
      const chainId = await getChainId(provider);
      if (!mountedRef.current) return;
      setState({ status: "connected", address, chainId, error: null, isWalletInstalled: true, provider });
    } catch (err) {
      if (!mountedRef.current) return;
      setState((s) => ({ ...s, status: "error", error: messageFor(err) }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState((s) => ({
      ...s,
      status: "disconnected",
      address: null,
      chainId: null,
      error: null,
      provider: null,
    }));
  }, []);

  const switchNetwork = useCallback(async (chainId: number) => {
    try {
      await switchNetworkUtil(chainId);
    } catch (err) {
      setState((s) => ({ ...s, error: messageFor(err) }));
    }
  }, []);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner | null> => {
    if (!state.provider) return null;
    try {
      return await state.provider.getSigner();
    } catch {
      return null;
    }
  }, [state.provider]);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasInjectedWallet()) return;

    getAuthorizedAccount()
      .then(async (existing) => {
        if (!mountedRef.current || !existing) return;
        const chainId = await getChainId(existing.provider).catch(() => null);
        if (!mountedRef.current) return;
        setState({
          status: "connected",
          address: existing.address,
          chainId,
          error: null,
          isWalletInstalled: true,
          provider: existing.provider,
        });
      })
      .catch(() => {
        /* no pre-existing authorization */
      });

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] as string[] | undefined) ?? [];
      if (accounts.length === 0) {
        setState((s) => ({ ...s, status: "disconnected", address: null, error: null, provider: null }));
        return;
      }
      setState((s) => ({
        ...s,
        status: "connected",
        address: accounts[0],
        error: null,
        provider: s.provider ?? getInjectedProvider(),
      }));
    };

    const handleChainChanged = (...args: unknown[]) => {
      const chainIdHex = args[0] as string;
      setState((s) => ({ ...s, chainId: parseInt(chainIdHex, 16) }));
    };

    window.ethereum?.on?.("accountsChanged", handleAccountsChanged);
    window.ethereum?.on?.("chainChanged", handleChainChanged);

    return () => {
      mountedRef.current = false;
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  const value: WalletContextValue = { ...state, connect, disconnect, switchNetwork, getSigner };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
