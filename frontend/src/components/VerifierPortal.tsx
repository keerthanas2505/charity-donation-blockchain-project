import { useEffect, useState, useCallback } from "react";
import { formatEther } from "ethers";
import {
  ShieldCheck,
  Vote,
  AlertTriangle,
  TrendingUp,
  Coins,
  Copy,
  Check,
  Lock,
  Unlock,
  AlertCircle,
} from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { getVerifierRegistryContract } from "../lib/contracts";
import { fetchLeaderboard } from "../lib/api";
import { shortenAddress } from "../lib/format";
import { stakeAction, unstakeAction, extractErrorMessage } from "../lib/web3Actions";
import { useToast } from "../lib/ToastContext";
import type { VerifierLeaderboardEntry } from "../types/campaign";

interface UserVerifierState {
  isVerifier: boolean;
  reputation: number;
  stakedAmount: bigint;
  againstStrikes: number;
  pendingVotes: number;
  minStake: bigint;
}

interface Props {
  onSelectCampaign: (id: number) => void;
}

export function VerifierPortal({ onSelectCampaign: _onSelectCampaign }: Props) {
  const { provider, address, getSigner } = useWallet();
  const { showToast } = useToast();

  const [verifierState, setVerifierState] = useState<UserVerifierState | null>(null);
  const [stakeAmount, setStakeAmount] = useState("0.01");
  const [leaderboard, setLeaderboard] = useState<VerifierLeaderboardEntry[]>([]);
  const [totalWeight, setTotalWeight] = useState<bigint>(0n);
  const [_loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!provider) return;
    try {
      setLoading(true);
      const registry = getVerifierRegistryContract(provider);
      const minStake: bigint = await registry.minStake();
      const weight: bigint = await registry.totalWeight().catch(() => 0n);
      setTotalWeight(weight);

      if (address) {
        const [isV, rep, staked, strikes, pending] = await Promise.all([
          registry.isVerifier(address),
          registry.reputationOf(address),
          registry.stakedAmount(address),
          registry.againstStrikes(address),
          registry.pendingVotes(address),
        ]);

        setVerifierState({
          isVerifier: Boolean(isV),
          reputation: Number(rep),
          stakedAmount: BigInt(staked),
          againstStrikes: Number(strikes),
          pendingVotes: Number(pending),
          minStake,
        });
      }

      // Fetch leaderboard from API
      fetchLeaderboard(50)
        .then((res) => setLeaderboard(res.leaderboard))
        .catch(() => {
          /* ignore if API offline */
        });
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [provider, address]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCopy = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddress(addr);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleStake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) {
      showToast({ type: "warning", title: "Wallet Disconnected", message: "Connect your Web3 wallet first" });
      return;
    }
    const val = parseFloat(stakeAmount);
    if (isNaN(val) || val <= 0) {
      showToast({ type: "warning", title: "Invalid Amount", message: "Enter a positive stake amount" });
      return;
    }

    try {
      setActionLoading("stake");
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Submitting Stake", message: `Staking ${stakeAmount} ETH into VerifierRegistry...` });
      const { txHash } = await stakeAction(signer, stakeAmount);
      showToast({
        type: "success",
        title: "Stake Confirmed!",
        message: `Successfully staked ${stakeAmount} ETH. You now participate in milestone verification!`,
        txHash,
      });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Staking Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnstake = async () => {
    if (!address) return;
    if (verifierState && verifierState.pendingVotes > 0) {
      showToast({
        type: "warning",
        title: "Unstake Locked",
        message: `You have ${verifierState.pendingVotes} pending vote(s). Unstaking is locked until rounds finalize.`,
      });
      return;
    }

    try {
      setActionLoading("unstake");
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Unstaking", message: "Withdrawing full staked ETH..." });
      const { txHash } = await unstakeAction(signer);
      showToast({
        type: "success",
        title: "Unstake Successful!",
        message: "Your staked ETH has been returned to your wallet.",
        txHash,
      });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Unstake Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Section Header */}
      <div className="section-header">
        <div>
          <h2 className="section-title">Verifier Hub & Staking Collateral</h2>
          <p className="section-desc">
            Staked verifiers independently review deliverable proofs, cast weighted votes, and safeguard donor capital.
          </p>
        </div>
        <div className="badge badge-released" style={{ fontSize: "0.85rem", padding: "0.4rem 0.85rem" }}>
          <ShieldCheck size={14} />
          <span>Active Network Voting Weight: {totalWeight.toString()}</span>
        </div>
      </div>

      {/* Protocol Mechanics Notice */}
      <div
        style={{
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "1.25rem",
          fontSize: "0.825rem",
          color: "var(--color-text-muted)",
        }}
      >
        <div style={{ display: "flex", gap: "8px" }}>
          <TrendingUp size={16} color="var(--color-primary)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong style={{ color: "var(--color-text)", display: "block" }}>Consensus Reward</strong>
            Voting with the finalized outcome grants +5 reputation points up to the 200 cap.
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <AlertTriangle size={16} color="var(--color-warning)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong style={{ color: "var(--color-text)", display: "block" }}>Dissent Penalty</strong>
            Voting against consensus results in -10 reputation and records 1 strike.
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <AlertCircle size={16} color="var(--color-danger)" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong style={{ color: "var(--color-text)", display: "block" }}>3-Strike Slashing</strong>
            Reaching 3 strikes triggers a 10% stake slash routed directly into the affected campaign escrow.
          </div>
        </div>
      </div>

      {/* Verifier State & Staking Form */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
        }}
      >
        {/* Your Verifier Profile Card */}
        <div className="stat-card" style={{ padding: "1.75rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
            <span className="stat-header">Your Verifier Profile</span>
            {verifierState?.isVerifier ? (
              <span className="badge badge-released">
                <ShieldCheck size={12} />
                <span>Active Verifier</span>
              </span>
            ) : (
              <span className="badge badge-rejected">Not Registered</span>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem", marginTop: "0.5rem" }}>
            <div>
              <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
                Collateral Staked
              </span>
              <div style={{ fontSize: "1.75rem", fontWeight: 800, color: "var(--color-text)", marginTop: "2px" }}>
                {verifierState ? formatEther(verifierState.stakedAmount) : "0.00"} ETH
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.825rem", marginBottom: "0.35rem" }}>
                <span>Reputation Score</span>
                <strong>{verifierState?.reputation ?? 0} / 200</strong>
              </div>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{
                    width: `${((verifierState?.reputation ?? 0) / 200) * 100}%`,
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--color-text-dim)", marginTop: "4px" }}>
                <span>Initial: 100</span>
                <span>Maximum: 200</span>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: "0.5rem",
                padding: "0.85rem",
                backgroundColor: "var(--color-surface-hover)",
                borderRadius: "8px",
                border: "1px solid var(--color-border)",
                textAlign: "center",
              }}
            >
              <div>
                <span style={{ fontSize: "0.7rem", color: "var(--color-text-dim)", display: "block" }}>Strikes</span>
                <strong style={{ fontSize: "1.1rem", color: (verifierState?.againstStrikes ?? 0) >= 2 ? "var(--color-danger)" : "inherit" }}>
                  {verifierState?.againstStrikes ?? 0} / 3
                </strong>
              </div>
              <div>
                <span style={{ fontSize: "0.7rem", color: "var(--color-text-dim)", display: "block" }}>Pending</span>
                <strong style={{ fontSize: "1.1rem" }}>{verifierState?.pendingVotes ?? 0}</strong>
              </div>
              <div>
                <span style={{ fontSize: "0.7rem", color: "var(--color-text-dim)", display: "block" }}>Weight</span>
                <strong style={{ fontSize: "1.1rem", color: "var(--color-primary)" }}>
                  {verifierState?.reputation ?? 0}
                </strong>
              </div>
            </div>

            {verifierState?.isVerifier && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleUnstake}
                disabled={actionLoading !== null || verifierState.pendingVotes > 0}
                style={{ width: "100%", marginTop: "0.25rem" }}
              >
                {verifierState.pendingVotes > 0 ? (
                  <>
                    <Lock size={14} />
                    <span>Unstake Locked ({verifierState.pendingVotes} Active Rounds)</span>
                  </>
                ) : (
                  <>
                    <Unlock size={14} />
                    <span>{actionLoading === "unstake" ? "Unstaking…" : "Withdraw Stake & De-register"}</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Stake Form Card */}
        <div className="stat-card" style={{ padding: "1.75rem" }}>
          <span className="stat-header">
            {verifierState?.isVerifier ? "Add to Verifier Collateral" : "Join TrustFund Verifier Pool"}
          </span>
          <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", margin: "0.5rem 0 1.25rem", lineHeight: 1.5 }}>
            Staking ETH binds your economic interest to truthful impact audits. Minimum stake requirement is{" "}
            <strong>0.01 ETH</strong>.
          </p>

          <form onSubmit={handleStake} style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
            <div className="form-group">
              <label htmlFor="stake-amount" className="form-label">
                <span>Stake Amount</span>
                <span style={{ color: "var(--color-text-dim)", fontSize: "0.75rem" }}>ETH</span>
              </label>
              <input
                id="stake-amount"
                type="number"
                step="any"
                min="0.01"
                required
                className="form-input"
                value={stakeAmount}
                onChange={(e) => setStakeAmount(e.target.value)}
                placeholder="0.01"
                disabled={actionLoading !== null}
              />
              <span className="form-hint">
                Minimum stake: 0.01 ETH. You can withdraw anytime after your active votes conclude.
              </span>
            </div>

            <div style={{ display: "flex", gap: "0.5rem" }}>
              {["0.01", "0.05", "0.1", "0.5"].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  className="btn btn-sm btn-outline"
                  style={{ flex: 1 }}
                  onClick={() => setStakeAmount(amt)}
                >
                  {amt}
                </button>
              ))}
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={actionLoading !== null}
            >
              <Coins size={16} />
              <span>
                {actionLoading === "stake"
                  ? "Staking on Blockchain…"
                  : verifierState?.isVerifier
                    ? "Increase Stake"
                    : "Stake & Register"}
              </span>
            </button>
          </form>
        </div>
      </div>

      {/* Verifier Leaderboard */}
      <section>
        <div className="section-header">
          <div>
            <h2 className="section-title">Verifier Reputation Leaderboard</h2>
            <p className="section-desc">
              Community verifiers ranked by accumulated reputation score and consensus integrity.
            </p>
          </div>
        </div>

        {leaderboard.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Vote size={28} />
            </div>
            <h4 className="empty-title">No Staked Verifiers Registered</h4>
            <p className="empty-desc">
              Be the first to stake into the VerifierRegistry and secure community milestone releases.
            </p>
          </div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Verifier Address</th>
                  <th>Reputation</th>
                  <th>Staked ETH</th>
                  <th>Strikes</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((v) => (
                  <tr key={v.address}>
                    <td>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "24px",
                          height: "24px",
                          borderRadius: "6px",
                          backgroundColor: v.rank <= 3 ? "var(--color-primary-subtle)" : "var(--color-surface-hover)",
                          color: v.rank <= 3 ? "var(--color-primary)" : "var(--color-text-muted)",
                          fontWeight: 700,
                          fontSize: "0.8rem",
                        }}
                      >
                        #{v.rank}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontFamily: "var(--font-mono)" }}>{shortenAddress(v.address)}</span>
                        {address?.toLowerCase() === v.address.toLowerCase() && (
                          <span className="badge badge-timelocked" style={{ fontSize: "0.7rem", padding: "0.15rem 0.45rem" }}>
                            You
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn-disconnect"
                          onClick={() => handleCopy(v.address)}
                          title="Copy address"
                        >
                          {copiedAddress === v.address ? <Check size={12} color="var(--color-primary)" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      <strong style={{ color: "var(--color-primary)", fontSize: "0.95rem" }}>
                        {v.reputation} / 200
                      </strong>
                    </td>
                    <td>{parseFloat(formatEther(v.stakedAmount)).toFixed(3)} ETH</td>
                    <td>
                      <span style={{ color: v.againstStrikes > 1 ? "var(--color-danger)" : "var(--color-text-dim)" }}>
                        {v.againstStrikes}/3
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${v.isVerifier ? "badge-released" : "badge-rejected"}`}>
                        {v.isVerifier ? "Active" : "Exited"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
