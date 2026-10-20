import { useEffect, useState, useCallback } from "react";
import { formatEther } from "ethers";
import {
  Scale,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Coins,
  Copy,
  Check,
  Info,
} from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { getCampaignEscrowContract } from "../lib/contracts";
import { resolveDisputeAction, sweepUnallocatedAction, extractErrorMessage } from "../lib/web3Actions";
import { useToast } from "../lib/ToastContext";

export function AdminGovernance() {
  const { provider, address, getSigner } = useWallet();
  const { showToast } = useToast();

  const [contractOwner, setContractOwner] = useState<string | null>(null);
  const [unallocatedSlashed, setUnallocatedSlashed] = useState<bigint>(0n);
  const [sweepTo, setSweepTo] = useState(address ?? "");

  // Dispute resolution form states
  const [disputeCampaignId, setDisputeCampaignId] = useState("");
  const [disputeMilestoneId, setDisputeMilestoneId] = useState("");
  const [confirmUphold, setConfirmUphold] = useState<boolean | null>(null);

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!provider) return;
    try {
      setLoading(true);
      const escrow = getCampaignEscrowContract(provider);
      const [ownerAddr, unallocated]: [string, bigint] = await Promise.all([
        escrow.owner().catch(() => ""),
        escrow.unallocatedSlashed().catch(() => 0n),
      ]);
      setContractOwner(ownerAddr);
      setUnallocatedSlashed(unallocated);
      if (!sweepTo && address) setSweepTo(address);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [provider, address, sweepTo]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const isOwner = address && contractOwner && address.toLowerCase() === contractOwner.toLowerCase();

  const handleResolveDispute = async (uphold: boolean) => {
    const cId = parseInt(disputeCampaignId, 10);
    const mId = parseInt(disputeMilestoneId, 10);
    if (isNaN(cId) || isNaN(mId) || cId < 0 || mId < 0) {
      showToast({ type: "warning", title: "Invalid IDs", message: "Enter valid campaign and milestone integers" });
      return;
    }

    try {
      setActionLoading(`dispute-${uphold}`);
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({
        type: "info",
        title: "Resolving Dispute",
        message: `Resolving dispute on Campaign #${cId} Milestone #${mId} (${uphold ? "Uphold" : "Reject"})...`,
      });

      const { txHash } = await resolveDisputeAction(signer, cId, mId, uphold);
      showToast({
        type: "success",
        title: "Dispute Resolved!",
        message: uphold ? "Milestone upheld and funds released to beneficiary" : "Milestone rejected and reserved funds freed",
        txHash,
      });

      setDisputeCampaignId("");
      setDisputeMilestoneId("");
      setConfirmUphold(null);
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Resolution Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  const handleSweep = async () => {
    const target = sweepTo.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      showToast({ type: "warning", title: "Invalid Address", message: "Enter a valid recipient address" });
      return;
    }

    try {
      setActionLoading("sweep");
      const signer = await getSigner();
      if (!signer) throw new Error("Wallet not connected");

      showToast({ type: "info", title: "Sweeping Funds", message: "Withdrawing unallocated slashed ETH..." });
      const { txHash } = await sweepUnallocatedAction(signer, target);
      showToast({
        type: "success",
        title: "Swept Successfully!",
        message: "Unallocated funds forwarded to recipient",
        txHash,
      });
      await loadData();
    } catch (err) {
      showToast({ type: "error", title: "Sweep Failed", message: extractErrorMessage(err) });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div style={{ maxWidth: "860px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Section Header */}
      <div className="section-header">
        <div>
          <h2 className="section-title">Protocol Governance & Dispute Adjudication</h2>
          <p className="section-desc">
            Dispute arbitration, smart contract authority, and unallocated collateral management.
          </p>
        </div>
        <div>
          {isOwner ? (
            <span className="badge badge-released" style={{ padding: "0.4rem 0.85rem" }}>
              <ShieldCheck size={14} />
              <span>Contract Administrator</span>
            </span>
          ) : (
            <span className="badge badge-pending" style={{ padding: "0.4rem 0.85rem" }}>
              <Info size={14} />
              <span>Read-Only Observer</span>
            </span>
          )}
        </div>
      </div>

      {/* Owner Identity & Access Card */}
      <div className="stat-card" style={{ padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <span className="stat-header">Contract Administrator Address</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.95rem", color: "var(--color-text)", fontWeight: 600 }}>
                {loading ? "Checking blockchain…" : contractOwner || "Unknown"}
              </span>
              {contractOwner && (
                <button
                  type="button"
                  className="btn-disconnect"
                  onClick={() => handleCopy(contractOwner)}
                  title="Copy owner address"
                >
                  {copiedText === contractOwner ? <Check size={12} color="var(--color-primary)" /> : <Copy size={12} />}
                </button>
              )}
            </div>
          </div>

          <div>
            {isOwner ? (
              <span style={{ color: "var(--color-primary)", fontSize: "0.85rem", fontWeight: 600 }}>
                Your connected wallet holds administrative authority.
              </span>
            ) : (
              <span style={{ color: "var(--color-text-dim)", fontSize: "0.85rem" }}>
                Connected address does not match contract owner.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Dispute Arbitration Section */}
      <div
        className="card"
        style={{
          backgroundColor: "var(--color-surface-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "14px",
          padding: "1.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Scale size={20} color="var(--color-primary)" />
          <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>Dispute Arbitration Panel</h3>
        </div>

        <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
          When &ge;20% of verifiers dispute a timelocked milestone, funds are frozen. The contract
          administrator must arbitrate whether the deliverable evidence meets requirements.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1rem",
          }}
        >
          <div className="form-group">
            <label htmlFor="dispute-camp-id" className="form-label">
              Campaign ID
            </label>
            <input
              id="dispute-camp-id"
              type="number"
              min="0"
              placeholder="e.g. 0"
              className="form-input"
              value={disputeCampaignId}
              onChange={(e) => setDisputeCampaignId(e.target.value)}
              disabled={!isOwner || actionLoading !== null}
            />
          </div>

          <div className="form-group">
            <label htmlFor="dispute-mile-id" className="form-label">
              Milestone Index
            </label>
            <input
              id="dispute-mile-id"
              type="number"
              min="0"
              placeholder="e.g. 0"
              className="form-input"
              value={disputeMilestoneId}
              onChange={(e) => setDisputeMilestoneId(e.target.value)}
              disabled={!isOwner || actionLoading !== null}
            />
          </div>
        </div>

        {/* Confirmation State or Action Buttons */}
        {confirmUphold === null ? (
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => setConfirmUphold(true)}
              disabled={!isOwner || !disputeCampaignId || !disputeMilestoneId || actionLoading !== null}
            >
              <CheckCircle2 size={16} />
              <span>Uphold & Release to Beneficiary</span>
            </button>

            <button
              type="button"
              className="btn btn-danger"
              style={{ flex: 1 }}
              onClick={() => setConfirmUphold(false)}
              disabled={!isOwner || !disputeCampaignId || !disputeMilestoneId || actionLoading !== null}
            >
              <XCircle size={16} />
              <span>Reject Milestone & Free Reserved Funds</span>
            </button>
          </div>
        ) : (
          <div
            style={{
              padding: "1rem 1.25rem",
              backgroundColor: confirmUphold ? "var(--color-primary-subtle)" : "var(--color-danger-subtle)",
              border: `1px solid ${confirmUphold ? "var(--color-primary-border)" : "var(--color-danger-border)"}`,
              borderRadius: "8px",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <AlertTriangle size={16} color={confirmUphold ? "var(--color-primary)" : "var(--color-danger)"} />
              <strong style={{ fontSize: "0.9rem" }}>
                Confirm {confirmUphold ? "Upholding" : "Rejecting"} Campaign #{disputeCampaignId} Milestone #{disputeMilestoneId}?
              </strong>
            </div>

            <p style={{ fontSize: "0.825rem", color: "var(--color-text-secondary)" }}>
              {confirmUphold
                ? "This will permanently disburse the reserved milestone payout directly to the campaign beneficiary address."
                : "This will permanently reject the milestone, freeing the reserved funds back into available campaign escrow."}
            </p>

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setConfirmUphold(null)}
                disabled={actionLoading !== null}
              >
                Cancel
              </button>

              <button
                type="button"
                className={`btn btn-sm ${confirmUphold ? "btn-primary" : "btn-danger"}`}
                onClick={() => handleResolveDispute(confirmUphold)}
                disabled={actionLoading !== null}
              >
                <span>Confirm {confirmUphold ? "Disbursement" : "Rejection"}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Unallocated Slashed Funds Sweep */}
      <div
        className="card"
        style={{
          backgroundColor: "var(--color-surface-card)",
          border: "1px solid var(--color-border)",
          borderRadius: "14px",
          padding: "1.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Coins size={20} color="var(--color-primary)" />
          <h3 style={{ fontSize: "1.15rem", fontWeight: 700 }}>Unallocated Slashed Collateral</h3>
        </div>

        <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", lineHeight: 1.5 }}>
          When verifiers are slashed on non-existent campaigns, slashed funds accumulate in the escrow
          contract's unallocated pool. The contract owner can sweep them to a community treasury.
        </p>

        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <span style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--color-text)" }}>
            {formatEther(unallocatedSlashed)} ETH
          </span>
          <span style={{ fontSize: "0.825rem", color: "var(--color-text-dim)" }}>
            available to sweep
          </span>
        </div>

        <div className="form-group">
          <label htmlFor="sweep-addr" className="form-label">
            Recipient Address
          </label>
          <input
            id="sweep-addr"
            type="text"
            placeholder="0x..."
            className="form-input"
            value={sweepTo}
            onChange={(e) => setSweepTo(e.target.value)}
            disabled={!isOwner || actionLoading !== null}
          />
        </div>

        <div>
          <button
            type="button"
            className="btn btn-outline"
            onClick={handleSweep}
            disabled={!isOwner || unallocatedSlashed === 0n || actionLoading !== null}
          >
            <span>{actionLoading === "sweep" ? "Sweeping Funds…" : "Sweep Unallocated ETH"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
