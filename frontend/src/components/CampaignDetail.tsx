import { useEffect, useState, useCallback } from "react";
import { formatEther } from "ethers";
import {
  ArrowLeft,
  Coins,
  RefreshCw,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  FileText,
  Upload,
  ExternalLink,
  ShieldCheck,
  Vote,
  Unlock,
  AlertCircle,
} from "lucide-react";
import { useWallet } from "../lib/useWallet";
import {
  getCampaignEscrowContract,
  getVerifierRegistryContract,
  getMilestoneVotingContract,
  getProofRegistryContract,
} from "../lib/contracts";
import { fetchDonations, uploadProofFile } from "../lib/api";
import { shortenAddress } from "../lib/format";
import { PINATA_GATEWAY } from "../lib/constants";
import {
  submitProofAction,
  openVotingRoundAction,
  castVoteAction,
  finalizeRoundAction,
  raiseDisputeAction,
  releaseMilestoneAction,
  extractErrorMessage,
} from "../lib/web3Actions";
import { useToast } from "../lib/ToastContext";
import type { Donation, MilestoneStateName } from "../types/campaign";

const STATE_NAMES: MilestoneStateName[] = [
  "Pending",
  "Timelocked",
  "Released",
  "Disputed",
  "Rejected",
];

interface OnChainMilestone {
  id: number;
  description: string;
  amount: bigint;
  state: number;
  releaseAfter: number;
  proofCid: string;
  hasProof: boolean;
  roundIndex: number;
  roundStatus: number; // 0=None, 1=Open, 2=Finalized
  approveWeight: bigint;
  rejectWeight: bigint;
  disputeWeight: bigint;
  weightSnapshot: bigint;
  approved: boolean;
  deadline: number;
  userVoted: boolean;
  userDisputed: boolean;
}

interface CampaignData {
  creator: string;
  beneficiary: string;
  balance: bigint;
  reserved: bigint;
  available: bigint;
  milestones: OnChainMilestone[];
}

interface Props {
  campaignId: number;
  onBack: () => void;
  onDonateClick: (campaignId: number) => void;
}

export function CampaignDetail({ campaignId, onBack, onDonateClick }: Props) {
  const { provider, address, getSigner } = useWallet();
  const { showToast } = useToast();

  const [campaign, setCampaign] = useState<CampaignData | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [isVerifier, setIsVerifier] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Proof submission form states per milestone
  const [proofInputs, setProofInputs] = useState<Record<number, string>>({});
  const [uploadingMilestone, setUploadingMilestone] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    if (!provider) return;
    try {
      setLoading(true);
      setError(null);

      const escrow = getCampaignEscrowContract(provider);
      const registry = getVerifierRegistryContract(provider);
      const voting = getMilestoneVotingContract(provider);
      const proofs = getProofRegistryContract(provider);

      // 1. Campaign state
      const [creator, beneficiary, balance, reserved, milestoneCount]: [
        string,
        string,
        bigint,
        bigint,
        bigint,
      ] = await escrow.getCampaign(campaignId);

      // Check if user is verifier
      if (address) {
        const isV = await registry.isVerifier(address).catch(() => false);
        setIsVerifier(Boolean(isV));
      }

      // 2. Milestones with proof & round info
      const mList: OnChainMilestone[] = [];
      for (let i = 0; i < Number(milestoneCount); i++) {
        const [description, amount, mState, releaseAfter]: [
          string,
          bigint,
          bigint,
          bigint,
        ] = await escrow.getMilestone(campaignId, i);

        // Proof info
        const hasP = await proofs.hasProof(campaignId, i).catch(() => false);
        let cid = "";
        if (hasP) {
          cid = await proofs.getProofCID(campaignId, i).catch(() => "");
        }

        // Round info
        const rIndex: bigint = await voting.currentRoundIndex(campaignId, i).catch(() => 0n);
        let rStatus = 0;
        let approveW = 0n;
        let rejectW = 0n;
        let disputeW = 0n;
        let weightSnap = 0n;
        let approved = false;
        let deadline = 0;
        let userVoted = false;
        let userDisputed = false;

        if (rIndex > 0n) {
          const r = await voting.getRound(campaignId, i).catch(() => null);
          if (r) {
            rStatus = Number(r.status);
            approveW = r.approveWeight;
            rejectW = r.rejectWeight;
            disputeW = r.disputeWeight;
            weightSnap = r.weightSnapshot;
            approved = Boolean(r.approved);
            deadline = Number(r.deadline);
          }

          if (address) {
            const [voted] = await voting.voteOf(campaignId, i, address).catch(() => [false, false]);
            userVoted = Boolean(voted);
            const disputed = await voting.hasDisputed(campaignId, i, address).catch(() => false);
            userDisputed = Boolean(disputed);
          }
        }

        mList.push({
          id: i,
          description,
          amount,
          state: Number(mState),
          releaseAfter: Number(releaseAfter),
          proofCid: cid,
          hasProof: Boolean(hasP),
          roundIndex: Number(rIndex),
          roundStatus: rStatus,
          approveWeight: approveW,
          rejectWeight: rejectW,
          disputeWeight: disputeW,
          weightSnapshot: weightSnap,
          approved,
          deadline,
          userVoted,
          userDisputed,
        });
      }

      setCampaign({
        creator,
        beneficiary,
        balance,
        reserved,
        available: balance - reserved,
        milestones: mList,
      });

      // Fetch donation events from API
      fetchDonations(campaignId)
        .then((res) => setDonations(res.donations))
        .catch(() => {
          /* ignore if API offline */
        });
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [provider, address, campaignId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // ── Action Handlers ────────────────────────────────────────────────────────

  const handleSubmitProof = async (milestoneId: number) => {
    const cid = (proofInputs[milestoneId] || "").trim();
    if (!cid) {
      showToast({ type: "warning", title: "Missing CID", message: "Please enter an IPFS CID or upload a file" });
      return;
    }

    try {
      setActionLoading(`proof-${milestoneId}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Submitting Proof", message: "Registering proof on blockchain..." });
      const { txHash } = await submitProofAction(signer, campaignId, milestoneId, cid);
      showToast({
        type: "success",
        title: "Proof Registered!",
        message: `Milestone #${milestoneId + 1} proof submitted on-chain`,
        txHash,
      });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Proof Submission Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleFileUpload = async (milestoneId: number, file: File) => {
    try {
      setUploadingMilestone(milestoneId);
      showToast({ type: "info", title: "Uploading to IPFS", message: "Pinning file via Pinata..." });
      const { cid } = await uploadProofFile(file);
      setProofInputs((prev) => ({ ...prev, [milestoneId]: cid }));
      showToast({ type: "success", title: "Pinned to IPFS!", message: `CID generated: ${cid.slice(0, 14)}...` });
    } catch (err) {
      showToast({
        type: "error",
        title: "Upload Failed",
        message: `${extractErrorMessage(err)}. (Note: If Pinata credentials are not set in api/.env, enter an IPFS CID directly).`,
      });
    } finally {
      setUploadingMilestone(null);
    }
  };

  const handleOpenRound = async (milestoneId: number) => {
    try {
      setActionLoading(`open-${milestoneId}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Opening Round", message: "Initiating community voting round on-chain..." });
      const { txHash } = await openVotingRoundAction(signer, campaignId, milestoneId);
      showToast({ type: "success", title: "Voting Round Open!", message: "Staked verifiers can now cast weighted votes", txHash });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Failed to Open Round", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleCastVote = async (milestoneId: number, approve: boolean) => {
    try {
      setActionLoading(`vote-${milestoneId}-${approve}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Casting Vote", message: `Submitting ${approve ? "Approve" : "Reject"} vote...` });
      const { txHash } = await castVoteAction(signer, campaignId, milestoneId, approve);
      showToast({ type: "success", title: "Vote Cast!", message: `Your weighted reputation vote has been recorded`, txHash });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Voting Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleFinalizeRound = async (milestoneId: number) => {
    try {
      setActionLoading(`finalize-${milestoneId}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Finalizing Round", message: "Settling round results on blockchain..." });
      const { txHash } = await finalizeRoundAction(signer, campaignId, milestoneId);
      showToast({ type: "success", title: "Round Finalized!", message: "Consensus tallied; timelock started or rejected", txHash });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Finalization Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRaiseDispute = async (milestoneId: number) => {
    try {
      setActionLoading(`dispute-${milestoneId}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Raising Dispute", message: "Recording dispute weight..." });
      const { txHash } = await raiseDisputeAction(signer, campaignId, milestoneId);
      showToast({ type: "warning", title: "Dispute Weight Registered", message: "Dispute submitted against timelocked release", txHash });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Dispute Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRelease = async (milestoneId: number) => {
    try {
      setActionLoading(`release-${milestoneId}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Releasing Funds", message: "Transferring milestone payout to beneficiary..." });
      const { txHash } = await releaseMilestoneAction(signer, campaignId, milestoneId);
      showToast({ type: "success", title: "Funds Released!", message: "ETH successfully sent to beneficiary", txHash });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Release Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!provider) {
    return (
      <div className="empty-state" style={{ maxWidth: "560px", margin: "3rem auto" }}>
        <div className="empty-icon">
          <AlertCircle size={28} />
        </div>
        <h3 className="empty-title">Wallet Required</h3>
        <p className="empty-desc">
          Connect your Web3 wallet to inspect live on-chain campaign data and interact with milestones.
        </p>
        <button type="button" className="btn btn-outline" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Campaigns</span>
        </button>
      </div>
    );
  }

  if (loading && !campaign) {
    return (
      <div className="empty-state" style={{ padding: "4rem 1.5rem" }}>
        <div className="empty-icon">
          <RefreshCw size={26} className="spinner" />
        </div>
        <h3 className="empty-title">Querying On-Chain State</h3>
        <p className="empty-desc">
          Reading escrow balances, proof registry, and voting rounds from contracts…
        </p>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="empty-state" style={{ maxWidth: "560px", margin: "3rem auto" }}>
        <div className="empty-icon">
          <AlertCircle size={28} color="var(--color-danger)" />
        </div>
        <h3 className="empty-title" style={{ color: "var(--color-danger)" }}>Campaign Not Found</h3>
        <p className="empty-desc">{error || "Failed to load campaign records"}</p>
        <button type="button" className="btn btn-outline" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Back to Campaigns</span>
        </button>
      </div>
    );
  }

  const isBeneficiary = address?.toLowerCase() === campaign.beneficiary.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Campaign Details Header */}
      <div
        style={{
          backgroundColor: "var(--color-surface-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "14px",
          padding: "2rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={onBack}
          >
            <ArrowLeft size={14} />
            <span>Back to Campaigns</span>
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void loadData()}
              disabled={loading}
              title="Refresh on-chain data"
            >
              <RefreshCw size={13} className={loading ? "spinner" : ""} />
              <span>Refresh On-Chain</span>
            </button>

            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onDonateClick(campaignId)}
            >
              <Coins size={14} />
              <span>Contribute ETH</span>
            </button>
          </div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <h1 style={{ fontSize: "1.85rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
              TrustFund Campaign #{campaignId}
            </h1>
            <span className="badge badge-released">
              <ShieldCheck size={13} />
              <span>Audited On-Chain</span>
            </span>
          </div>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
            Autonomous escrow deployed on Ethereum. Funds are released strictly sequentially upon milestone proof and verifier consensus.
          </p>
        </div>

        {/* 4 Metadata Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "1rem",
            paddingTop: "1rem",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <div>
            <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
              Creator
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                {shortenAddress(campaign.creator)}
              </span>
              <button
                type="button"
                className="btn-disconnect"
                onClick={() => handleCopy(campaign.creator)}
                title="Copy creator address"
              >
                {copiedText === campaign.creator ? <Check size={12} color="var(--color-primary)" /> : <Copy size={12} />}
              </button>
            </div>
          </div>

          <div>
            <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
              Beneficiary
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  color: isBeneficiary ? "var(--color-primary)" : "var(--color-text-secondary)",
                  fontWeight: isBeneficiary ? 700 : 500,
                }}
              >
                {shortenAddress(campaign.beneficiary)} {isBeneficiary && "(Your Address)"}
              </span>
              <button
                type="button"
                className="btn-disconnect"
                onClick={() => handleCopy(campaign.beneficiary)}
                title="Copy beneficiary address"
              >
                {copiedText === campaign.beneficiary ? <Check size={12} color="var(--color-primary)" /> : <Copy size={12} />}
              </button>
            </div>
          </div>

          <div>
            <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
              Total In Escrow
            </span>
            <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "var(--color-text)", marginTop: "2px" }}>
              {parseFloat(formatEther(campaign.balance)).toFixed(4)} ETH
            </div>
          </div>

          <div>
            <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
              Available for New Rounds
            </span>
            <div style={{ fontSize: "1.35rem", fontWeight: 800, color: "var(--color-primary)", marginTop: "2px" }}>
              {parseFloat(formatEther(campaign.available)).toFixed(4)} ETH
            </div>
          </div>
        </div>
      </div>

      {/* Milestones Stepper & Verification Section */}
      <section>
        <div className="section-header">
          <div>
            <h2 className="section-title">Milestone Verification & Payout Stepper</h2>
            <p className="section-desc">
              All releases require immutable IPFS evidence, &ge;66% verifier reputation approval, and a 48-hour challenge timelock.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {campaign.milestones.map((m) => {
            const stateName = STATE_NAMES[m.state] ?? "Pending";
            const isPending = m.state === 0;
            const isTimelocked = m.state === 1;
            const isReleased = m.state === 2;
            const isDisputed = m.state === 3;
            const isRejected = m.state === 4;

            const isReleasable = isTimelocked && now >= m.releaseAfter;
            const timelockRemainingSec = isTimelocked ? Math.max(0, m.releaseAfter - now) : 0;

            const totalSnap = Number(m.weightSnapshot);
            const appWeight = Number(m.approveWeight);
            const approvalPct = totalSnap > 0 ? Math.round((appWeight * 100) / totalSnap) : 0;
            const approvalReached = approvalPct >= 66;

            const disputeSnap = Number(m.weightSnapshot);
            const dispWeight = Number(m.disputeWeight);
            const disputePct = disputeSnap > 0 ? Math.round((dispWeight * 100) / disputeSnap) : 0;

            return (
              <article
                key={m.id}
                style={{
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "12px",
                  padding: "1.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "1.25rem",
                  transition: "all 0.2s ease",
                }}
              >
                {/* Milestone Top Row */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <div
                      style={{
                        width: "32px",
                        height: "32px",
                        borderRadius: "8px",
                        backgroundColor: isReleased ? "var(--color-primary-subtle)" : "var(--color-surface-hover)",
                        border: `1px solid ${isReleased ? "var(--color-primary-border)" : "var(--color-border)"}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        color: isReleased ? "var(--color-primary)" : "var(--color-text-secondary)",
                      }}
                    >
                      {m.id + 1}
                    </div>
                    <div>
                      <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Milestone #{m.id + 1}</h3>
                      <p style={{ fontSize: "0.875rem", color: "var(--color-text-secondary)", marginTop: "2px" }}>
                        {m.description}
                      </p>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: "1.2rem", fontWeight: 800, color: "var(--color-primary)" }}>
                        {formatEther(m.amount)} ETH
                      </span>
                      <span style={{ display: "block", fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
                        Target Payout
                      </span>
                    </div>

                    <span className={`badge badge-${stateName.toLowerCase()}`}>
                      {isReleased && <CheckCircle2 size={13} />}
                      {isTimelocked && <Clock size={13} />}
                      {isDisputed && <AlertTriangle size={13} />}
                      {isRejected && <XCircle size={13} />}
                      <span>{stateName}</span>
                    </span>
                  </div>
                </div>

                {/* Timelock Alert Box */}
                {isTimelocked && (
                  <div
                    style={{
                      padding: "0.85rem 1.15rem",
                      backgroundColor: "var(--color-accent-subtle)",
                      border: "1px solid var(--color-accent-border)",
                      borderRadius: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.875rem" }}>
                      <Clock size={16} color="var(--color-accent)" />
                      <span>
                        <strong>48-Hour Timelock Active:</strong> Challenge window ends in{" "}
                        {timelockRemainingSec > 0
                          ? `${Math.floor(timelockRemainingSec / 3600)}h ${Math.floor((timelockRemainingSec % 3600) / 60)}m`
                          : "Ready for Disbursement!"}
                      </span>
                    </div>

                    {isReleasable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => handleRelease(m.id)}
                        disabled={actionLoading !== null}
                      >
                        <Unlock size={14} />
                        <span>
                          {actionLoading === `release-${m.id}` ? "Releasing Funds…" : "Execute Milestone Payout"}
                        </span>
                      </button>
                    )}
                  </div>
                )}

                {/* Dispute Alert Box */}
                {isDisputed && (
                  <div
                    style={{
                      padding: "0.85rem 1.15rem",
                      backgroundColor: "var(--color-danger-subtle)",
                      border: "1px solid var(--color-danger-border)",
                      borderRadius: "8px",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "0.875rem",
                    }}
                  >
                    <AlertTriangle size={16} color="var(--color-danger)" style={{ flexShrink: 0 }} />
                    <span>
                      <strong>Milestone Disputed:</strong> Over 20% of verifier weight challenged this milestone.
                      Funds are frozen safely in escrow pending resolution in the Governance & Admin panel.
                    </span>
                  </div>
                )}

                {/* Two-Column Interactive Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                    gap: "1.25rem",
                  }}
                >
                  {/* Proof Box */}
                  <div
                    style={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border-subtle)",
                      borderRadius: "10px",
                      padding: "1.15rem",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.75rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <FileText size={15} color="var(--color-primary)" />
                      <span style={{ fontSize: "0.825rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
                        Deliverable Evidence (IPFS)
                      </span>
                    </div>

                    {m.hasProof ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                        <div style={{ wordBreak: "break-all", fontFamily: "var(--font-mono)", fontSize: "0.825rem", color: "var(--color-text)" }}>
                          CID: {m.proofCid}
                        </div>
                        <a
                          href={`https://${PINATA_GATEWAY}/ipfs/${m.proofCid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontSize: "0.8rem",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            color: "var(--color-accent)",
                          }}
                        >
                          <span>Inspect Evidence on IPFS Gateway</span>
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    ) : (
                      <span style={{ color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
                        No deliverable proof uploaded yet.
                      </span>
                    )}

                    {isBeneficiary && isPending && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.25rem" }}>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <input
                            type="text"
                            placeholder="Enter IPFS CID (e.g. Qm...)"
                            className="form-input"
                            style={{ fontSize: "0.825rem", padding: "0.4rem 0.6rem" }}
                            value={proofInputs[m.id] ?? ""}
                            onChange={(e) => setProofInputs((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          />
                          <button
                            type="button"
                            className="btn btn-sm btn-outline"
                            onClick={() => handleSubmitProof(m.id)}
                            disabled={actionLoading !== null}
                          >
                            Submit CID
                          </button>
                        </div>

                        <label
                          className="btn btn-sm btn-secondary"
                          style={{ width: "100%", cursor: "pointer", justifyContent: "center" }}
                        >
                          <Upload size={13} />
                          <span>{uploadingMilestone === m.id ? "Pinning to IPFS…" : "Upload Evidence File"}</span>
                          <input
                            type="file"
                            style={{ display: "none" }}
                            onChange={(e) => {
                              if (e.target.files?.[0]) {
                                void handleFileUpload(m.id, e.target.files[0]);
                              }
                            }}
                            disabled={uploadingMilestone !== null}
                          />
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Verification & Consensus Box */}
                  <div
                    style={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border-subtle)",
                      borderRadius: "10px",
                      padding: "1.15rem",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.75rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <Vote size={15} color="var(--color-primary)" />
                      <span style={{ fontSize: "0.825rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-dim)" }}>
                        Consensus Verification
                      </span>
                    </div>

                    {m.roundStatus === 0 ? (
                      <div>
                        <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--color-text-dim)" }}>
                          No active voting round on this milestone.
                        </p>
                        {m.hasProof && isPending && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => handleOpenRound(m.id)}
                            disabled={actionLoading !== null || campaign.available < m.amount}
                          >
                            <Vote size={13} />
                            <span>
                              {actionLoading === `open-${m.id}`
                                ? "Opening Round…"
                                : campaign.available < m.amount
                                  ? "Insufficient Balance to Open"
                                  : "Open Community Voting Round"}
                            </span>
                          </button>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.825rem" }}>
                          <span>
                            Round #{m.roundIndex} ({m.roundStatus === 1 ? "Voting Active" : "Finalized"})
                          </span>
                          <strong>{approvalPct}% Approval (&ge;66% needed)</strong>
                        </div>

                        <div className="progress-track">
                          <div
                            className="progress-fill"
                            style={{
                              width: `${Math.min(100, approvalPct)}%`,
                              background: approvalReached
                                ? "var(--color-primary)"
                                : "linear-gradient(90deg, var(--color-warning), #0284c7)",
                            }}
                          />
                        </div>

                        {m.roundStatus === 1 && (
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                            {isVerifier && !m.userVoted && (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  onClick={() => handleCastVote(m.id, true)}
                                  disabled={actionLoading !== null}
                                >
                                  <Check size={13} />
                                  <span>Approve Proof</span>
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-danger"
                                  onClick={() => handleCastVote(m.id, false)}
                                  disabled={actionLoading !== null}
                                >
                                  <XCircle size={13} />
                                  <span>Reject Proof</span>
                                </button>
                              </>
                            )}

                            {m.userVoted && (
                              <span style={{ fontSize: "0.825rem", color: "var(--color-primary)", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <CheckCircle2 size={13} />
                                <span>Your vote has been cast</span>
                              </span>
                            )}

                            {(approvalReached || now >= m.deadline) && (
                              <button
                                type="button"
                                className="btn btn-sm btn-outline"
                                onClick={() => handleFinalizeRound(m.id)}
                                disabled={actionLoading !== null}
                              >
                                <span>{actionLoading === `finalize-${m.id}` ? "Finalizing…" : "Finalize Round"}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Dispute flag button during timelock */}
                    {isTimelocked && isVerifier && !m.userDisputed && (
                      <div style={{ marginTop: "0.25rem" }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => handleRaiseDispute(m.id)}
                          disabled={actionLoading !== null}
                        >
                          <AlertTriangle size={13} />
                          <span>Challenge Release ({disputePct}% / 20% threshold)</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Donation History Table */}
      <section>
        <div className="section-header">
          <div>
            <h2 className="section-title">Verified Donation Ledger ({donations.length})</h2>
            <p className="section-desc">
              All on-chain donations indexed from the CampaignEscrow contract for Initiative #{campaignId}.
            </p>
          </div>
        </div>

        {donations.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Coins size={28} />
            </div>
            <h4 className="empty-title">No Contributions Yet</h4>
            <p className="empty-desc">
              Be the first donor to fund this campaign's milestones.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onDonateClick(campaignId)}
            >
              <Coins size={16} />
              <span>Make First Contribution</span>
            </button>
          </div>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Contributor</th>
                  <th>Amount</th>
                  <th>Block Number</th>
                  <th>Timestamp</th>
                  <th>Transaction Hash</th>
                </tr>
              </thead>
              <tbody>
                {donations.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontFamily: "var(--font-mono)" }}>{shortenAddress(d.donor)}</span>
                        <button
                          type="button"
                          className="btn-disconnect"
                          onClick={() => handleCopy(d.donor)}
                          title="Copy address"
                        >
                          {copiedText === d.donor ? <Check size={12} color="var(--color-primary)" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </td>
                    <td>
                      <strong style={{ color: "var(--color-primary)", fontWeight: 700 }}>
                        {parseFloat(formatEther(d.amount)).toFixed(4)} ETH
                      </strong>
                    </td>
                    <td>#{d.blockNumber}</td>
                    <td style={{ fontSize: "0.8rem", color: "var(--color-text-dim)" }}>
                      {d.blockTime ? new Date(d.blockTime).toLocaleString() : "Confirmed"}
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
                        {shortenAddress(d.txHash)}
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
