import { useState, lazy, Suspense } from "react";
import { Header, type NavTab } from "./components/Header";
import { Footer } from "./components/Footer";
import { LandingStats } from "./components/LandingStats";
import { CampaignList } from "./components/CampaignList";
import { CreateCampaignModal } from "./components/CreateCampaignModal";
import { DonateModal } from "./components/DonateModal";
import { PlusCircle, RefreshCw } from "lucide-react";

// Heavy panels are lazy-loaded to split them into separate async chunks
const CampaignDetail = lazy(() =>
  import("./components/CampaignDetail").then((m) => ({ default: m.CampaignDetail }))
);
const VerifierPortal = lazy(() =>
  import("./components/VerifierPortal").then((m) => ({ default: m.VerifierPortal }))
);
const AdminGovernance = lazy(() =>
  import("./components/AdminGovernance").then((m) => ({ default: m.AdminGovernance }))
);
const AccountProfile = lazy(() =>
  import("./components/AccountProfile").then((m) => ({ default: m.AccountProfile }))
);

function PanelSkeleton() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "360px",
        gap: "0.75rem",
        color: "var(--color-text-muted)",
      }}
    >
      <RefreshCw size={28} className="spinner" color="var(--color-primary)" />
      <span style={{ fontSize: "0.875rem" }}>Loading Protocol Module…</span>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<NavTab>("campaigns");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isDonateModalOpen, setIsDonateModalOpen] = useState(false);
  const [donateTargetId, setDonateTargetId] = useState<number | null>(null);

  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleTabChange = (tab: NavTab) => {
    setActiveTab(tab);
    setSelectedId(null);
  };

  const handleOpenDonate = (campaignId: number) => {
    setDonateTargetId(campaignId);
    setIsDonateModalOpen(true);
  };

  const handleCreateSuccess = (newCampaignId: number) => {
    setRefreshTrigger((prev) => prev + 1);
    setSelectedId(newCampaignId);
    setActiveTab("campaigns");
  };

  const handleDonateSuccess = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <div className="app-container">
      <Header
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onCreateClick={() => setIsCreateModalOpen(true)}
      />

      <main className="main-content">
        {selectedId !== null ? (
          <Suspense fallback={<PanelSkeleton />}>
            <CampaignDetail
              key={selectedId}
              campaignId={selectedId}
              onBack={() => setSelectedId(null)}
              onDonateClick={handleOpenDonate}
            />
          </Suspense>
        ) : (
          <>
            {activeTab === "campaigns" && (
              <>
                <LandingStats
                  onCreateClick={() => setIsCreateModalOpen(true)}
                  onExploreClick={() => {
                    const el = document.getElementById("campaigns-section");
                    el?.scrollIntoView({ behavior: "smooth" });
                  }}
                  onVerifierClick={() => setActiveTab("verifiers")}
                />
                <div id="campaigns-section">
                  <CampaignList
                    onSelectCampaign={setSelectedId}
                    onDonateClick={handleOpenDonate}
                    onCreateClick={() => setIsCreateModalOpen(true)}
                    refreshTrigger={refreshTrigger}
                  />
                </div>
              </>
            )}

            {activeTab === "create" && (
              <div
                className="card"
                style={{
                  textAlign: "center",
                  padding: "4rem 2rem",
                  maxWidth: "680px",
                  margin: "2rem auto",
                  backgroundColor: "var(--color-surface-card)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "16px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "1.25rem",
                }}
              >
                <div className="pillar-icon-wrapper" style={{ width: "54px", height: "54px" }}>
                  <PlusCircle size={28} />
                </div>
                <h2 style={{ fontSize: "1.75rem", fontWeight: 800 }}>Launch a Verified TrustFund Initiative</h2>
                <p style={{ color: "var(--color-text-muted)", maxWidth: "520px", lineHeight: 1.6, fontSize: "0.95rem" }}>
                  Partition your cause into sequential milestones with measurable targets. Contributed funds
                  are held securely in an independent on-chain escrow and released only after community verification.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  onClick={() => setIsCreateModalOpen(true)}
                >
                  <PlusCircle size={18} />
                  <span>Configure Campaign Milestones</span>
                </button>
              </div>
            )}

            {activeTab === "verifiers" && (
              <Suspense fallback={<PanelSkeleton />}>
                <VerifierPortal onSelectCampaign={setSelectedId} />
              </Suspense>
            )}

            {activeTab === "governance" && (
              <Suspense fallback={<PanelSkeleton />}>
                <AdminGovernance />
              </Suspense>
            )}

            {activeTab === "account" && (
              <Suspense fallback={<PanelSkeleton />}>
                <AccountProfile
                  onSelectCampaign={setSelectedId}
                  onCreateClick={() => setIsCreateModalOpen(true)}
                  onNavigateTab={handleTabChange}
                />
              </Suspense>
            )}
          </>
        )}
      </main>

      <Footer
        onTabChange={handleTabChange}
        onCreateClick={() => setIsCreateModalOpen(true)}
      />

      <CreateCampaignModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
      />

      {donateTargetId !== null && (
        <DonateModal
          campaignId={donateTargetId}
          isOpen={isDonateModalOpen}
          onClose={() => {
            setIsDonateModalOpen(false);
            setDonateTargetId(null);
          }}
          onSuccess={handleDonateSuccess}
        />
      )}
    </div>
  );
}

export default App;
