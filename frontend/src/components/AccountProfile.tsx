import { useEffect, useState, useCallback } from "react";
import { formatEther } from "ethers";
import {
  Wallet,
  Copy,
  Check,
  Shield,
  ShieldCheck,
  PlusCircle,
  Vote,
  ExternalLink,
  Layers,
  HeartHandshake,
  AlertCircle,
  LogOut,
  Info,
} from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { shortenAddress } from "../lib/format";
import { TARGET_CHAIN_ID } from "../lib/constants";
import { fetchCampaigns, fetchVerifier } from "../lib/api";
import { getVerifierRegistryContract } from "../lib/contracts";
import type { Campaign, VerifierDetail } from "../types/campaign";

interface Props {
  onSelectCampaign: (id: number) => void;
  onCreateClick: () => void;
  onNavigateTab: (tab: "campaigns" | "create" | "verifiers" | "governance") => void;
}

export function AccountProfile({ onSelectCampaign, onCreateClick, onNavigateTab }: Props) {
  const { status, address, chainId, isWalletInstalled, connect, disconnect, switchNetwork, provider } =
    useWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  // User campaigns
  const [userCampaigns, setUserCampaigns] = useState<Campaign[]>([]);
  // Verifier details
  const [verifierProfile, setVerifierProfile] = useState<VerifierDetail | null>(null);
  const [onChainVerifier, setOnChainVerifier] = useState<{
    isVerifier: boolean;
    reputation: number;
    stakedAmount: bigint;
    againstStrikes: number;
    pendingVotes: number;
  } | null>(null);

  const isCorrectNetwork = chainId === TARGET_CHAIN_ID;

  const loadAccountData = useCallback(async () => {
    if (!address || !provider) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

      // 1. Fetch balance
      const bal = await provider.getBalance(address).catch(() => 0n);
      setBalance(formatEther(bal));

      // 2. Fetch all campaigns and filter by creator
      const campRes = await fetchCampaigns({ limit: 100 }).catch(() => null);
      if (campRes) {
        const mine = campRes.campaigns.filter(
          (c) => c.creator.toLowerCase() === address.toLowerCase(),
        );
        setUserCampaigns(mine);
      }

      // 3. On-chain verifier data
      const registry = getVerifierRegistryContract(provider);
      const [isV, rep, staked, strikes, pending] = await Promise.all([
        registry.isVerifier(address).catch(() => false),
        registry.reputationOf(address).catch(() => 0n),
        registry.stakedAmount(address).catch(() => 0n),
        registry.againstStrikes(address).catch(() => 0n),
        registry.pendingVotes(address).catch(() => 0n),
      ]);

      setOnChainVerifier({
        isVerifier: Boolean(isV),
        reputation: Number(rep),
        stakedAmount: BigInt(staked),
        againstStrikes: Number(strikes),
        pendingVotes: Number(pending),
      });

      // 4. API verifier history
      if (isV) {
        const vDetail = await fetchVerifier(address).catch(() => null);
        if (vDetail) {
          setVerifierProfile(vDetail);
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [address, provider]);

  useEffect(() => {
    void loadAccountData();
  }, [loadAccountData]);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // If wallet not connected
  if (status !== "connected" || !address) {
    return (
      <div className="empty-state" style={{ maxWidth: "560px", margin: "3rem auto" }}>
        <div className="empty-icon">
          <Wallet size={28} />
        </div>
        <h2 className="empty-title">Connect Your Web3 Wallet</h2>
        <p className="empty-desc">
          Connect your Ethereum wallet (MetaMask) to view your TrustFund portfolio, created
          campaigns, verifier reputation, and voting records.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={connect}
          disabled={status === "connecting"}
        >
          <Wallet size={18} />
          <span>
            {!isWalletInstalled
              ? "Install MetaMask"
              : status === "connecting"
                ? "Connecting…"
                : "Connect Wallet"}
          </span>
        </button>

        <div
          style={{
            fontSize: "0.8rem",
            color: "var(--color-text-dim)",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "1rem",
          }}
        >
          <Info size={14} />
          <span>TrustFund is purely non-custodial. No private keys or passwords are ever requested.</span>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="empty-state" style={{ padding: "4rem 1.5rem" }}>
        <div className="empty-icon">
          <Wallet size={26} className="spinner" />
        </div>
        <h3 className="empty-title">Loading Account Portfolio</h3>
        <p className="empty-desc">Querying campaigns, verifier reputation, and on-chain records…</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Account Header Card */}
      <div
        className="card"
        style={{
          backgroundColor: "var(--color-surface-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "14px",
          padding: "1.75rem 2rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div
            style={{
              width: "56px",
              height: "56px",
              borderRadius: "12px",
              backgroundColor: "var(--color-primary-subtle)",
              border: "1px solid var(--color-primary-border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--color-primary)",
            }}
          >
            <Wallet size={28} />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                {shortenAddress(address)}
              </h2>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={handleCopy}
                style={{ padding: "0.2rem 0.5rem" }}
                title="Copy full address"
              >
                {copied ? <Check size={13} color="var(--color-primary)" /> : <Copy size={13} />}
                <span style={{ fontSize: "0.75rem" }}>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.825rem", color: "var(--color-text-muted)" }}>
              <span>
                Balance:{" "}
                <strong style={{ color: "var(--color-text)" }}>
                  {balance !== null ? `${parseFloat(balance).toFixed(4)} ETH` : "Loading…"}
                </strong>
              </span>
              <span>•</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                <span className={`network-dot ${isCorrectNetwork ? "online" : "wrong"}`}></span>
                {chainId === 31337 ? "Hardhat Local (31337)" : `Chain ID: ${chainId}`}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {!isCorrectNetwork && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => switchNetwork(TARGET_CHAIN_ID)}
            >
              <AlertCircle size={14} />
              <span>Switch Network ({TARGET_CHAIN_ID})</span>
            </button>
          )}

          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={disconnect}
          >
            <LogOut size={14} />
            <span>Disconnect</span>
          </button>
        </div>
      </div>

      {/* Security & Authentication Notice */}
      <div
        style={{
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          fontSize: "0.825rem",
          color: "var(--color-text-muted)",
        }}
      >
        <Shield size={18} color="var(--color-primary)" style={{ flexShrink: 0 }} />
        <span>
          <strong>Cryptographic Wallet Session:</strong> You are connected via Web3 provider.
          Your address is authenticated directly by digital signatures on the blockchain.
          No custodial accounts, credentials, or personal records are stored.
        </span>
      </div>

      {/* Grid: Verifier Status & Quick Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <span>Verifier Status</span>
            <ShieldCheck size={16} color="var(--color-primary)" />
          </div>
          <div className="stat-value" style={{ fontSize: "1.35rem" }}>
            {onChainVerifier?.isVerifier ? (
              <span className="badge badge-released">Active Verifier</span>
            ) : (
              <span className="badge badge-rejected">Not Registered</span>
            )}
          </div>
          <div className="stat-meta">
            {onChainVerifier?.isVerifier ? (
              <button
                type="button"
                className="btn btn-sm btn-outline"
                style={{ marginTop: "0.5rem" }}
                onClick={() => onNavigateTab("verifiers")}
              >
                Manage Stake
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                style={{ marginTop: "0.5rem" }}
                onClick={() => onNavigateTab("verifiers")}
              >
                Join Registry (0.01 ETH)
              </button>
            )}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span>Reputation Score</span>
            <Vote size={16} />
          </div>
          <div className="stat-value">
            {onChainVerifier?.isVerifier ? onChainVerifier.reputation : "—"}
          </div>
          <div className="stat-meta">
            {onChainVerifier?.isVerifier
              ? `Range: [0 - 200] • Strikes: ${onChainVerifier.againstStrikes}/3`
              : "Starts at 100 upon staking"}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span>Staked In Protocol</span>
            <Layers size={16} />
          </div>
          <div className="stat-value">
            {onChainVerifier?.isVerifier
              ? `${formatEther(onChainVerifier.stakedAmount)} ETH`
              : "0.00 ETH"}
          </div>
          <div className="stat-meta">
            {onChainVerifier?.pendingVotes
              ? `${onChainVerifier.pendingVotes} vote(s) pending lock`
              : "Free to unstake"}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span>Campaigns Created</span>
            <HeartHandshake size={16} />
          </div>
          <div className="stat-value">{userCampaigns.length}</div>
          <div className="stat-meta">
            <button
              type="button"
              className="btn btn-sm btn-outline"
              style={{ marginTop: "0.5rem" }}
              onClick={onCreateClick}
            >
              <PlusCircle size={13} />
              <span>New Campaign</span>
            </button>
          </div>
        </div>
      </div>

      {/* Campaigns Created by this User */}
      <section>
        <div className="section-header">
          <div>
            <h3 className="section-title">Campaigns Deployed by You</h3>
            <p className="section-desc">
              All campaigns on the blockchain where your address is registered as the creator.
            </p>
          </div>
        </div>

        {userCampaigns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <HeartHandshake size={28} />
            </div>
            <h4 className="empty-title">No Campaigns Created Yet</h4>
            <p className="empty-desc">
              Deploy your first escrow-protected charitable campaign with multi-milestone validation.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onCreateClick}
            >
              <PlusCircle size={16} />
              <span>Create Campaign</span>
            </button>
          </div>
        ) : (
          <div className="campaign-grid">
            {userCampaigns.map((camp) => (
              <div key={camp.id} className="campaign-card">
                <div className="campaign-card-header">
                  <span className="campaign-id-badge">Campaign #{camp.id}</span>
                  <span className="badge badge-pending">
                    {camp.milestoneCount} Milestone{camp.milestoneCount === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="campaign-card-body">
                  <div className="campaign-parties">
                    <div className="party-row">
                      <span className="party-label">Beneficiary:</span>
                      <span className="party-address">{shortenAddress(camp.beneficiary)}</span>
                    </div>
                    <div className="party-row">
                      <span className="party-label">Created:</span>
                      <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
                        {camp.createdAt ? new Date(camp.createdAt).toLocaleDateString() : `Block #${camp.createdBlock}`}
                      </span>
                    </div>
                  </div>

                  <div className="campaign-funding">
                    <div className="funding-header">
                      <span className="funding-raised">
                        {parseFloat(formatEther(BigInt(camp.balance || "0"))).toFixed(4)} ETH
                      </span>
                      <span className="funding-goal">Balance in Escrow</span>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{
                          width: `${Math.min(100, Math.max(10, (parseFloat(formatEther(BigInt(camp.balance || "0"))) / 1) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="campaign-card-footer">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ width: "100%" }}
                    onClick={() => onSelectCampaign(camp.id)}
                  >
                    <span>Manage Campaign Details</span>
                    <ExternalLink size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Verifier Voting History */}
      {onChainVerifier?.isVerifier && (
        <section>
          <div className="section-header">
            <div>
              <h3 className="section-title">Your Voting & Consensus Activity</h3>
              <p className="section-desc">
                Historical verification rounds where your address participated.
              </p>
            </div>
          </div>

          {!verifierProfile?.votes || verifierProfile.votes.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Vote size={28} />
              </div>
              <h4 className="empty-title">No Votes Cast Yet</h4>
              <p className="empty-desc">
                When beneficiaries submit milestone deliverable proofs, browse active rounds in the
                Verifier Hub or Campaign Details to cast verification votes.
              </p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onNavigateTab("verifiers")}
              >
                <span>Go to Verifier Hub</span>
              </button>
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Milestone</th>
                    <th>Round</th>
                    <th>Your Vote</th>
                    <th>Weight</th>
                    <th>Consensus Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {verifierProfile.votes.map((v, i) => (
                    <tr key={i}>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline"
                          onClick={() => onSelectCampaign(v.campaignId)}
                        >
                          Campaign #{v.campaignId}
                        </button>
                      </td>
                      <td>Milestone #{v.milestoneId}</td>
                      <td>Round #{v.roundIndex}</td>
                      <td>
                        <span
                          className={`badge ${v.approve ? "badge-released" : "badge-disputed"}`}
                        >
                          {v.approve ? "Approved" : "Rejected"}
                        </span>
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>{v.weight}</td>
                      <td>
                        {v.aligned === null ? (
                          <span className="badge badge-pending">Pending Outcome</span>
                        ) : v.aligned ? (
                          <span className="badge badge-released">+5 Rep (Consensus)</span>
                        ) : (
                          <span className="badge badge-disputed">-10 Rep & Strike</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
