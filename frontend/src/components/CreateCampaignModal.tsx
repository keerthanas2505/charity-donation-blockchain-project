import { useState, useEffect } from "react";
import { X, Plus, Trash2, Coins, AlertCircle, Sparkles } from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { createCampaignAction, extractErrorMessage } from "../lib/web3Actions";
import { useToast } from "../lib/ToastContext";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (campaignId: number) => void;
}

interface MilestoneInput {
  description: string;
  amount: string;
}

export function CreateCampaignModal({ isOpen, onClose, onSuccess }: Props) {
  const { getSigner, address } = useWallet();
  const { showToast } = useToast();

  const [beneficiary, setBeneficiary] = useState(address ?? "");
  const [milestones, setMilestones] = useState<MilestoneInput[]>([
    { description: "Phase 1: Initial Setup & Procurement", amount: "0.5" },
    { description: "Phase 2: Execution & Field Verification", amount: "0.5" },
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyboard accessibility: Escape closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleAddMilestone = () => {
    if (milestones.length >= 10) return;
    setMilestones((prev) => [
      ...prev,
      { description: `Phase ${prev.length + 1}: Implementation`, amount: "0.5" },
    ]);
  };

  const handleRemoveMilestone = (index: number) => {
    if (milestones.length <= 1) return;
    setMilestones((prev) => prev.filter((_, i) => i !== index));
  };

  const handleMilestoneChange = (
    index: number,
    field: keyof MilestoneInput,
    value: string,
  ) => {
    setMilestones((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const totalTargetEth = milestones.reduce((sum, m) => {
    const v = parseFloat(m.amount);
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) {
      setError("Please connect your Web3 wallet first");
      return;
    }

    const trimmedBeneficiary = (beneficiary || address).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmedBeneficiary)) {
      setError("Please provide a valid 40-character hex beneficiary Ethereum address");
      return;
    }

    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      if (!m.description.trim()) {
        setError(`Milestone #${i + 1} description cannot be empty`);
        return;
      }
      const val = parseFloat(m.amount);
      if (isNaN(val) || val <= 0) {
        setError(`Milestone #${i + 1} amount must be greater than 0 ETH`);
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const signer = await getSigner();
      if (!signer) throw new Error("Could not get signer from wallet");

      showToast({
        type: "info",
        title: "Deploying Campaign Escrow",
        message: "Broadcasting campaign creation transaction to the Ethereum blockchain...",
      });

      const { campaignId, txHash } = await createCampaignAction(
        signer,
        trimmedBeneficiary,
        milestones.map((m) => m.description.trim()),
        milestones.map((m) => m.amount),
      );

      showToast({
        type: "success",
        title: "Campaign Escrow Deployed!",
        message: `TrustFund Campaign #${campaignId} has been created on-chain with ${milestones.length} milestones.`,
        txHash,
      });

      onSuccess(campaignId);
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      showToast({
        type: "error",
        title: "Creation Failed",
        message: msg,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-modal-title"
      >
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={18} color="var(--color-primary)" />
            <h2 id="create-modal-title" className="modal-title">
              Launch Verified Campaign
            </h2>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="beneficiary-address" className="form-label">
                <span>Beneficiary Payout Address</span>
                <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)" }}>Ethereum Address</span>
              </label>
              <input
                id="beneficiary-address"
                type="text"
                required
                className="form-input"
                value={beneficiary}
                onChange={(e) => {
                  setBeneficiary(e.target.value);
                  setError(null);
                }}
                placeholder={address ?? "0x..."}
                disabled={loading}
              />
              <span className="form-hint">
                The designated address that receives released ETH once each milestone is verified.
              </span>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <span className="form-label">Campaign Milestones ({milestones.length})</span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={handleAddMilestone}
                  disabled={loading || milestones.length >= 10}
                >
                  <Plus size={13} />
                  <span>Add Stage</span>
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {milestones.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      backgroundColor: "var(--color-surface)",
                      padding: "0.85rem",
                      borderRadius: "8px",
                      border: "1px solid var(--color-border-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--color-text-secondary)" }}>
                        Stage #{idx + 1}
                      </span>
                      {milestones.length > 1 && (
                        <button
                          type="button"
                          className="btn-disconnect"
                          onClick={() => handleRemoveMilestone(idx)}
                          disabled={loading}
                          title="Remove milestone"
                          aria-label={`Remove milestone ${idx + 1}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: "0.5rem" }}>
                      <input
                        type="text"
                        required
                        className="form-input"
                        placeholder="Deliverable description"
                        value={m.description}
                        onChange={(e) => handleMilestoneChange(idx, "description", e.target.value)}
                        disabled={loading}
                      />
                      <input
                        type="number"
                        step="any"
                        min="0.0001"
                        required
                        className="form-input"
                        placeholder="ETH"
                        value={m.amount}
                        onChange={(e) => handleMilestoneChange(idx, "amount", e.target.value)}
                        disabled={loading}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Total Budget Summary */}
            <div
              style={{
                padding: "0.85rem 1rem",
                backgroundColor: "var(--color-primary-subtle)",
                borderRadius: "8px",
                border: "1px solid var(--color-primary-border)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>Total Escrow Requirement:</span>
              <strong style={{ fontSize: "1.1rem", color: "var(--color-primary)", fontWeight: 800 }}>
                {totalTargetEth.toFixed(4)} ETH
              </strong>
            </div>

            {error && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "0.825rem",
                  color: "var(--color-danger)",
                  padding: "0.5rem 0.75rem",
                  backgroundColor: "var(--color-danger-subtle)",
                  borderRadius: "6px",
                  border: "1px solid var(--color-danger-border)",
                }}
                role="alert"
              >
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Coins size={15} />
              <span>{loading ? "Deploying Escrow…" : "Deploy Escrow on Blockchain"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
