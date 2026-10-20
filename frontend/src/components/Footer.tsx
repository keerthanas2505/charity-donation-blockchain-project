import { TrustFundLogo } from "./TrustFundLogo";
import {
  CAMPAIGN_ESCROW_ADDRESS,
  VERIFIER_REGISTRY_ADDRESS,
  MILESTONE_VOTING_ADDRESS,
  PROOF_REGISTRY_ADDRESS,
  TARGET_CHAIN_ID,
} from "../lib/constants";
import { shortenAddress } from "../lib/format";
import { ShieldCheck } from "lucide-react";
import type { NavTab } from "./Header";

interface FooterProps {
  onTabChange: (tab: NavTab) => void;
  onCreateClick: () => void;
}

export function Footer({ onTabChange, onCreateClick }: FooterProps) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        {/* Brand & Mission */}
        <div className="footer-brand">
          <TrustFundLogo size="md" />
          <p className="footer-desc">
            TrustFund is an open, trust-minimized charitable funding protocol.
            All contributions are held in smart contract escrows and disbursed only
            upon weighted consensus from independently staked verifiers.
          </p>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: "var(--color-primary)", fontSize: "0.8rem", fontWeight: 600 }}>
            <ShieldCheck size={16} />
            <span>Audited Smart Contract Escrows</span>
          </div>
        </div>

        {/* Navigation */}
        <div>
          <h4 className="footer-col-title">Protocol Navigation</h4>
          <ul className="footer-links">
            <li>
              <a
                href="#campaigns"
                className="footer-link"
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange("campaigns");
                }}
              >
                Explore Campaigns
              </a>
            </li>
            <li>
              <a
                href="#create"
                className="footer-link"
                onClick={(e) => {
                  e.preventDefault();
                  onCreateClick();
                }}
              >
                Launch Campaign
              </a>
            </li>
            <li>
              <a
                href="#verifiers"
                className="footer-link"
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange("verifiers");
                }}
              >
                Verifier Hub & Staking
              </a>
            </li>
            <li>
              <a
                href="#governance"
                className="footer-link"
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange("governance");
                }}
              >
                Governance & Disputes
              </a>
            </li>
            <li>
              <a
                href="#account"
                className="footer-link"
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange("account");
                }}
              >
                Account & Portfolio
              </a>
            </li>
          </ul>
        </div>

        {/* Verified Contracts */}
        <div>
          <h4 className="footer-col-title">Core Contracts ({TARGET_CHAIN_ID === 31337 ? "Local 31337" : "Sepolia"})</h4>
          <ul className="footer-links">
            <li>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)", display: "block" }}>Escrow</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                {shortenAddress(CAMPAIGN_ESCROW_ADDRESS)}
              </span>
            </li>
            <li>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)", display: "block" }}>Voting Engine</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                {shortenAddress(MILESTONE_VOTING_ADDRESS)}
              </span>
            </li>
            <li>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)", display: "block" }}>Verifier Registry</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                {shortenAddress(VERIFIER_REGISTRY_ADDRESS)}
              </span>
            </li>
            <li>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)", display: "block" }}>Proof Registry</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                {shortenAddress(PROOF_REGISTRY_ADDRESS)}
              </span>
            </li>
          </ul>
        </div>

        {/* System & Architecture */}
        <div>
          <h4 className="footer-col-title">System Status</h4>
          <ul className="footer-links">
            <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="network-dot online"></span>
              <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>Smart Contracts Live</span>
            </li>
            <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="network-dot online"></span>
              <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>PostgreSQL Indexer</span>
            </li>
            <li style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="network-dot online"></span>
              <span style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>Express API Active</span>
            </li>
            <li style={{ marginTop: "0.5rem" }}>
              <span style={{ fontSize: "0.75rem", color: "var(--color-text-dim)" }}>
                Consensus threshold: 66% weight
                <br />
                Challenge window: 48h timelock
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div className="footer-bottom">
        <div>
          © {new Date().getFullYear()} TrustFund Protocol. Released under ISC open-source license.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
          <span>Transparent Blockchain Impact Verification</span>
        </div>
      </div>
    </footer>
  );
}
