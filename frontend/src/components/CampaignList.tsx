import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import {
  Search,
  PlusCircle,
  Coins,
  ArrowRight,
  FolderOpen,
  RefreshCw,
  AlertCircle,
  Copy,
  Check,
} from "lucide-react";
import { fetchCampaigns } from "../lib/api";
import { shortenAddress } from "../lib/format";
import type { Campaign } from "../types/campaign";

interface Props {
  onSelectCampaign: (id: number) => void;
  onDonateClick: (campaignId: number) => void;
  onCreateClick: () => void;
  refreshTrigger?: number;
}

export function CampaignList({
  onSelectCampaign,
  onDonateClick,
  onCreateClick,
  refreshTrigger = 0,
}: Props) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("id");
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const loadData = () => {
    setLoading(true);
    fetchCampaigns({ sort: sortBy })
      .then((res) => {
        setCampaigns(res.campaigns);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load campaigns from indexer");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    loadData();
  }, [sortBy, refreshTrigger]);

  const handleCopy = (e: React.MouseEvent, text: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedAddress(text);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const filteredCampaigns = campaigns.filter((c) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      c.id.toString().includes(term) ||
      c.beneficiary.toLowerCase().includes(term) ||
      c.creator.toLowerCase().includes(term)
    );
  });

  return (
    <section>
      <div className="section-header">
        <div>
          <h2 className="section-title">Verified TrustFund Initiatives</h2>
          <p className="section-desc">
            Smart contract escrows with milestone-gated releases and cryptographic verifier consensus.
          </p>
        </div>

        <div className="filter-bar">
          <div className="search-input-wrapper">
            <Search size={15} className="search-icon" />
            <input
              type="search"
              className="search-input"
              placeholder="Search by ID or address…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <select
            className="filter-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="id">Sort: Initial First</option>
            <option value="-id">Sort: Newest First</option>
            <option value="-balance">Sort: Highest Escrow</option>
            <option value="-milestones">Sort: Most Milestones</option>
          </select>

          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={loadData}
            title="Refresh list"
          >
            <RefreshCw size={13} className={loading ? "spinner" : ""} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onCreateClick}
          >
            <PlusCircle size={14} />
            <span>New Campaign</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="empty-state" style={{ padding: "4rem 1.5rem" }}>
          <div className="empty-icon">
            <RefreshCw size={26} className="spinner" />
          </div>
          <h3 className="empty-title">Synchronizing On-Chain Escrows</h3>
          <p className="empty-desc">
            Querying blockchain event logs and PostgreSQL indexer…
          </p>
        </div>
      )}

      {error && !loading && (
        <div
          style={{
            padding: "2rem",
            backgroundColor: "var(--color-surface-card)",
            border: "1px solid var(--color-danger-border)",
            borderRadius: "12px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.75rem",
          }}
          role="alert"
        >
          <AlertCircle size={28} color="var(--color-danger)" />
          <h3 style={{ color: "var(--color-danger)", fontSize: "1.1rem", fontWeight: 700 }}>
            Unable to fetch indexed campaigns
          </h3>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", maxWidth: "450px" }}>
            {error}
          </p>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={loadData}
          >
            <RefreshCw size={13} />
            <span>Retry Connection</span>
          </button>
        </div>
      )}

      {!loading && !error && filteredCampaigns.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            <FolderOpen size={28} />
          </div>
          <h3 className="empty-title">
            {searchTerm ? "No Initiatives Found" : "No Campaigns Deployed Yet"}
          </h3>
          <p className="empty-desc">
            {searchTerm
              ? "No initiatives match your query. Try searching by a different ID or Ethereum address."
              : "Be the first to launch an institutional-grade, milestone-verified campaign on TrustFund."}
          </p>
          <button type="button" className="btn btn-primary" onClick={onCreateClick}>
            <PlusCircle size={16} />
            <span>Deploy First Campaign</span>
          </button>
        </div>
      )}

      {!loading && !error && filteredCampaigns.length > 0 && (
        <div className="campaign-grid">
          {filteredCampaigns.map((c) => {
            const balEth = parseFloat(formatEther(c.balance || "0")).toFixed(3);
            const resEth = parseFloat(formatEther(c.reserved || "0")).toFixed(3);
            const availEth = parseFloat(formatEther(c.available || "0")).toFixed(3);

            const total = BigInt(c.balance || "0");
            const reserved = BigInt(c.reserved || "0");
            const pct = total > 0n ? Math.min(100, Number((reserved * 100n) / total)) : 0;

            return (
              <article key={c.id} className="campaign-card">
                <div className="campaign-card-header">
                  <span className="campaign-id-badge">Campaign #{c.id}</span>
                  <span className="badge badge-pending">
                    {c.milestoneCount} Milestone{c.milestoneCount === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="campaign-card-body">
                  <div className="campaign-parties">
                    <div className="party-row">
                      <span className="party-label">Beneficiary</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                        <span className="party-address" title={c.beneficiary}>
                          {shortenAddress(c.beneficiary)}
                        </span>
                        <button
                          type="button"
                          className="btn-disconnect"
                          onClick={(e) => handleCopy(e, c.beneficiary)}
                          title="Copy address"
                        >
                          {copiedAddress === c.beneficiary ? (
                            <Check size={12} color="var(--color-primary)" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="party-row">
                      <span className="party-label">Creator</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                        <span className="party-address" title={c.creator}>
                          {shortenAddress(c.creator)}
                        </span>
                        <button
                          type="button"
                          className="btn-disconnect"
                          onClick={(e) => handleCopy(e, c.creator)}
                          title="Copy address"
                        >
                          {copiedAddress === c.creator ? (
                            <Check size={12} color="var(--color-primary)" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="campaign-funding">
                    <div className="funding-header">
                      <div>
                        <span className="funding-raised">{balEth} ETH</span>
                        <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)", marginLeft: "6px" }}>
                          escrowed
                        </span>
                      </div>
                      <span className="funding-goal">
                        {availEth} ETH unreserved
                      </span>
                    </div>

                    <div className="progress-track" title={`${pct}% reserved for timelocked milestones`}>
                      <div className="progress-fill" style={{ width: `${Math.max(5, pct)}%` }} />
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
                      <span>Timelocked: {resEth} ETH</span>
                      <span>{pct}% reserved</span>
                    </div>
                  </div>
                </div>

                <div className="campaign-card-footer">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ flex: 1 }}
                    onClick={() => onDonateClick(c.id)}
                  >
                    <Coins size={14} />
                    <span>Contribute</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onSelectCampaign(c.id)}
                  >
                    <span>Inspect</span>
                    <ArrowRight size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
