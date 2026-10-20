import { useState, useEffect } from "react";
import { X, Coins, Heart, ShieldCheck, AlertCircle } from "lucide-react";
import { useWallet } from "../lib/useWallet";
import { donateAction, extractErrorMessage } from "../lib/web3Actions";
import { useToast } from "../lib/ToastContext";

interface Props {
  campaignId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const PRESET_AMOUNTS = ["0.01", "0.05", "0.1", "0.5", "1.0"];

export function DonateModal({ campaignId, isOpen, onClose, onSuccess }: Props) {
  const { getSigner, address } = useWallet();
  const { showToast } = useToast();
  const [amount, setAmount] = useState("0.1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyboard accessibility
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) {
      setError("Please connect your Web3 wallet first");
      return;
    }
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Please enter a valid ETH amount greater than 0");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const signer = await getSigner();
      if (!signer) throw new Error("Could not get signer from wallet");

      showToast({
        type: "info",
        title: "Transaction Pending",
        message: `Broadcasting donation of ${amount} ETH to Campaign #${campaignId}...`,
      });

      const { txHash } = await donateAction(signer, campaignId, amount);

      showToast({
        type: "success",
        title: "Donation Confirmed!",
        message: `Successfully contributed ${amount} ETH to Campaign #${campaignId}!`,
        txHash,
      });

      onSuccess();
      onClose();
    } catch (err) {
      const msg = extractErrorMessage(err);
      setError(msg);
      showToast({
        type: "error",
        title: "Donation Failed",
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
        aria-labelledby="donate-modal-title"
      >
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Heart size={18} color="var(--color-primary)" />
            <h2 id="donate-modal-title" className="modal-title">
              Contribute to Initiative #{campaignId}
            </h2>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="donation-amount" className="form-label">
                <span>Contribution Amount</span>
                <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)" }}>ETH</span>
              </label>
              <input
                id="donation-amount"
                type="number"
                step="any"
                min="0.0001"
                required
                className="form-input"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setError(null);
                }}
                placeholder="0.1"
                disabled={loading}
                autoFocus
              />

              {/* Quick Select Presets */}
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                {PRESET_AMOUNTS.map((p) => (
                  <button
                    type="button"
                    key={p}
                    className={`btn btn-sm ${amount === p ? "btn-primary" : "btn-outline"}`}
                    style={{ flex: 1 }}
                    onClick={() => setAmount(p)}
                    disabled={loading}
                  >
                    {p}
                  </button>
                ))}
              </div>

              {error && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "0.825rem",
                    color: "var(--color-danger)",
                    marginTop: "0.5rem",
                  }}
                  role="alert"
                >
                  <AlertCircle size={14} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {/* Escrow Guarantee Notice */}
            <div
              style={{
                padding: "0.85rem 1rem",
                backgroundColor: "var(--color-primary-subtle)",
                borderRadius: "8px",
                border: "1px solid var(--color-primary-border)",
                display: "flex",
                alignItems: "flex-start",
                gap: "0.75rem",
                fontSize: "0.825rem",
                color: "var(--color-text-muted)",
              }}
            >
              <ShieldCheck size={18} color="var(--color-primary)" style={{ flexShrink: 0, marginTop: "1px" }} />
              <div>
                <strong style={{ color: "var(--color-text)", display: "block", marginBottom: "2px" }}>
                  Escrow Guarantee
                </strong>
                Donated ETH is held in the non-custodial CampaignEscrow contract and locked until milestones
                receive &ge;66% verifier approval and clear the 48-hour challenge window.
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              <Coins size={15} />
              <span>{loading ? "Processing Contribution…" : `Contribute ${amount || "0"} ETH`}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
