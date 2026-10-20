import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import {
  ShieldCheck,
  Lock,
  FileCheck2,
  AlertTriangle,
  ArrowRight,
  PlusCircle,
  Coins,
  CheckCircle2,
  FolderGit2,
  Users,
} from "lucide-react";
import { fetchStats } from "../lib/api";
import type { PlatformStats } from "../types/campaign";

interface Props {
  onCreateClick: () => void;
  onExploreClick: () => void;
  onVerifierClick?: () => void;
}

export function LandingStats({ onCreateClick, onExploreClick, onVerifierClick }: Props) {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchStats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        // Fallback gracefully if API is warming up
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalDonatedEth = stats ? parseFloat(formatEther(stats.totalDonated)).toFixed(2) : "0.00";
  const totalReleasedEth = stats ? parseFloat(formatEther(stats.releasedAmount)).toFixed(2) : "0.00";
  const totalStakedEth = stats ? parseFloat(formatEther(stats.totalStaked)).toFixed(2) : "0.00";

  return (
    <section className="hero-section">
      {/* Brand Hero Badge */}
      <div className="hero-badge">
        <ShieldCheck size={14} />
        <span>TrustFund Protocol • Verified Impact Architecture</span>
      </div>

      {/* Main Headline */}
      <h1 className="hero-title">
        Decentralized Charitable Funding with Cryptographic Accountability
      </h1>

      {/* Subtitle */}
      <p className="hero-subtitle">
        TrustFund replaces blind trust with smart contract escrows. Donated funds are locked on Ethereum
        and disbursed to beneficiaries only when independently staked verifiers validate deliverable proofs.
      </p>

      {/* Primary CTAs */}
      <div className="hero-actions">
        <button type="button" className="btn btn-primary btn-lg" onClick={onCreateClick}>
          <PlusCircle size={18} />
          <span>Launch a Campaign</span>
        </button>
        <button type="button" className="btn btn-secondary btn-lg" onClick={onExploreClick}>
          <span>Explore Verified Causes</span>
          <ArrowRight size={16} />
        </button>
      </div>

      {/* 4 Architectural Value Pillars */}
      <div className="pillars-grid">
        <div className="pillar-card">
          <div className="pillar-icon-wrapper">
            <Lock size={22} />
          </div>
          <h3 className="pillar-title">Milestone Escrows</h3>
          <p className="pillar-desc">
            Contributions remain in non-custodial smart contracts, partitioned by specific deliverables.
            Beneficiaries receive funds only after completing each stage.
          </p>
        </div>

        <div className="pillar-card">
          <div className="pillar-icon-wrapper">
            <Users size={22} />
          </div>
          <h3 className="pillar-title">Staked Consensus</h3>
          <p className="pillar-desc">
            Independent community verifiers stake real ETH to vote. Reaching &ge;66% reputation approval
            authorizes milestone release; dishonest voters forfeit stake.
          </p>
        </div>

        <div className="pillar-card">
          <div className="pillar-icon-wrapper">
            <FileCheck2 size={22} />
          </div>
          <h3 className="pillar-title">Cryptographic Proofs</h3>
          <p className="pillar-desc">
            Beneficiaries must anchor immutable IPFS content identifiers (CIDs) of receipts, photos, or
            reports before any voting round can be initiated.
          </p>
        </div>

        <div className="pillar-card">
          <div className="pillar-icon-wrapper">
            <AlertTriangle size={22} />
          </div>
          <h3 className="pillar-title">20% Dispute Halt</h3>
          <p className="pillar-desc">
            Approved milestones enter a 48-hour timelock. If &ge;20% of verifier weight raises a dispute,
            payout is frozen instantly for administrative review.
          </p>
        </div>
      </div>

      {/* Live Protocol Statistics */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <span>Total Donations</span>
            <Coins size={16} color="var(--color-primary)" />
          </div>
          <div className="stat-value">
            {loading ? "…" : `${totalDonatedEth} ETH`}
          </div>
          <div className="stat-meta">
            {stats?.donationCount ?? 0} on-chain contribution{stats?.donationCount === 1 ? "" : "s"}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span>Disbursed Funds</span>
            <CheckCircle2 size={16} color="var(--color-primary)" />
          </div>
          <div className="stat-value">
            {loading ? "…" : `${totalReleasedEth} ETH`}
          </div>
          <div className="stat-meta">Verified milestone releases</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <span>Active Campaigns</span>
            <FolderGit2 size={16} color="var(--color-accent)" />
          </div>
          <div className="stat-value">
            {loading ? "…" : (stats?.campaignCount ?? 0)}
          </div>
          <div className="stat-meta">
            {stats?.openRounds ?? 0} active voting round{stats?.openRounds === 1 ? "" : "s"}
          </div>
        </div>

        <div
          className="stat-card"
          onClick={onVerifierClick}
          style={{ cursor: onVerifierClick ? "pointer" : "default" }}
          title={onVerifierClick ? "Navigate to Verifier Hub" : undefined}
        >
          <div className="stat-header">
            <span>Security Collateral</span>
            <ShieldCheck size={16} color="var(--color-primary)" />
          </div>
          <div className="stat-value">
            {loading ? "…" : `${totalStakedEth} ETH`}
          </div>
          <div className="stat-meta">
            {stats?.activeVerifiers ?? 0} bonded verifier{stats?.activeVerifiers === 1 ? "" : "s"}
          </div>
        </div>
      </div>
    </section>
  );
}
