import { useState, useEffect } from "react";
import { formatEther } from "ethers";
import {
  Compass,
  PlusCircle,
  ShieldCheck,
  Scale,
  User,
  Sun,
  Moon,
  Monitor,
  Copy,
  Check,
  LogOut,
  Wallet,
  AlertCircle,
} from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { shortenAddress } from "../lib/format";
import { TARGET_CHAIN_ID } from "../lib/constants";
import { useTheme } from "../lib/ThemeContext";
import { TrustFundLogo } from "./TrustFundLogo";

export type NavTab = "campaigns" | "create" | "verifiers" | "governance" | "account";

interface Props {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  onCreateClick: () => void;
}

export function Header({ activeTab, onTabChange, onCreateClick }: Props) {
  const { status, address, chainId, isWalletInstalled, connect, disconnect, switchNetwork, provider } =
    useWallet();
  const { theme, effectiveTheme, setTheme } = useTheme();
  const [balance, setBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!provider || !address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    provider
      .getBalance(address)
      .then((bal) => {
        if (!cancelled) setBalance(formatEther(bal));
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [provider, address, chainId]);

  const handleCopyAddress = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isCorrectNetwork = chainId === TARGET_CHAIN_ID;

  return (
    <header className="header">
      <div className="header-inner">
        {/* Brand Logo */}
        <div onClick={() => onTabChange("campaigns")}>
          <TrustFundLogo size="md" />
        </div>

        {/* Navigation Tabs */}
        <nav className="nav-links" aria-label="Main Navigation">
          <button
            type="button"
            className={`nav-btn ${activeTab === "campaigns" ? "active" : ""}`}
            onClick={() => onTabChange("campaigns")}
          >
            <Compass size={16} />
            <span>Explore</span>
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={onCreateClick}
          >
            <PlusCircle size={16} />
            <span>Create Campaign</span>
          </button>
          <button
            type="button"
            className={`nav-btn ${activeTab === "verifiers" ? "active" : ""}`}
            onClick={() => onTabChange("verifiers")}
          >
            <ShieldCheck size={16} />
            <span>Verifier Hub</span>
          </button>
          <button
            type="button"
            className={`nav-btn ${activeTab === "governance" ? "active" : ""}`}
            onClick={() => onTabChange("governance")}
          >
            <Scale size={16} />
            <span>Governance</span>
          </button>
          <button
            type="button"
            className={`nav-btn ${activeTab === "account" ? "active" : ""}`}
            onClick={() => onTabChange("account")}
          >
            <User size={16} />
            <span>Account</span>
          </button>
        </nav>

        {/* Actions: Theme Toggle, Network Badge, Wallet Status */}
        <div className="header-actions">
          {/* Theme Selector Toggle */}
          <div className="theme-toggle-group" role="group" aria-label="Theme selection">
            <button
              type="button"
              className={`theme-toggle-btn ${theme === "light" ? "active" : ""}`}
              onClick={() => setTheme("light")}
              title="Light mode"
              aria-label="Light mode"
            >
              <Sun size={15} />
            </button>
            <button
              type="button"
              className={`theme-toggle-btn ${theme === "dark" ? "active" : ""}`}
              onClick={() => setTheme("dark")}
              title="Dark mode"
              aria-label="Dark mode"
            >
              <Moon size={15} />
            </button>
            <button
              type="button"
              className={`theme-toggle-btn ${theme === "system" ? "active" : ""}`}
              onClick={() => setTheme("system")}
              title={`System mode (${effectiveTheme})`}
              aria-label="System mode"
            >
              <Monitor size={15} />
            </button>
          </div>

          {/* Connected Wallet Info */}
          {status === "connected" && (
            <>
              {isCorrectNetwork ? (
                <div className="network-badge" title={`Chain ID: ${chainId}`}>
                  <span className="network-dot online"></span>
                  <span>{chainId === 31337 ? "Hardhat Local" : "Sepolia"}</span>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => switchNetwork(TARGET_CHAIN_ID)}
                  title="Switch to supported network"
                >
                  <AlertCircle size={14} />
                  <span>Switch Network ({TARGET_CHAIN_ID})</span>
                </button>
              )}

              <div className="wallet-connected">
                {balance !== null && (
                  <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)", fontWeight: 500 }}>
                    {parseFloat(balance).toFixed(3)} ETH
                  </span>
                )}
                <span className="wallet-address" title={address ?? ""}>
                  {shortenAddress(address ?? "")}
                </span>
                <button
                  type="button"
                  className="btn-disconnect"
                  onClick={handleCopyAddress}
                  title="Copy wallet address"
                  aria-label="Copy address"
                >
                  {copied ? <Check size={13} color="var(--color-primary)" /> : <Copy size={13} />}
                </button>
                <button
                  type="button"
                  className="btn-disconnect"
                  onClick={disconnect}
                  title="Disconnect wallet"
                  aria-label="Disconnect wallet"
                >
                  <LogOut size={13} />
                </button>
              </div>
            </>
          )}

          {/* Disconnected / Connecting Wallet */}
          {status !== "connected" && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={connect}
              disabled={status === "connecting"}
            >
              <Wallet size={15} />
              <span>
                {!isWalletInstalled
                  ? "Install MetaMask"
                  : status === "connecting"
                    ? "Connecting…"
                    : "Connect Wallet"}
              </span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
