-- Charity Donation Tracking System — indexer schema
-- One migration, initial schema. Apply with:  psql "$DATABASE_URL" -f indexer/migrations/0001_init.sql
--
-- Mirrors on-chain state of the four deployed contracts, keyed by
-- (deployment_id, on-chain id). `deployments` normalizes the four contract
-- addresses that make up one wired system.

BEGIN;

-- ── Domains ────────────────────────────────────────────────────────────────
CREATE DOMAIN eth_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN eth_hash    AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');

-- Solidity: enum State { Pending, Timelocked, Released, Disputed, Rejected }
CREATE TYPE milestone_state AS ENUM
  ('Pending', 'Timelocked', 'Released', 'Disputed', 'Rejected');

-- Solidity: enum RoundStatus { None, Open, Finalized } — 'None' never persists.
CREATE TYPE round_status AS ENUM ('Open', 'Finalized');

-- ── deployments ───────────────────────────────────────────────────────────
CREATE TABLE deployments (
  id                bigserial PRIMARY KEY,
  chain_id          bigint       NOT NULL,
  label             text,
  escrow_address    eth_address  NOT NULL,
  registry_address  eth_address  NOT NULL,
  voting_address    eth_address  NOT NULL,
  proofs_address    eth_address  NOT NULL,
  start_block       bigint       NOT NULL,          -- deploy block; replay floor
  created_at        timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (chain_id, escrow_address)
);

-- ── sync_state ────────────────────────────────────────────────────────────
CREATE TABLE sync_state (
  deployment_id     bigint PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  last_synced_block bigint      NOT NULL,           -- every log in blocks <= this is committed
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ── campaigns  (CampaignEscrow.campaigns[id]) ─────────────────────────────
CREATE TABLE campaigns (
  deployment_id   bigint        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id     bigint        NOT NULL,
  beneficiary     eth_address   NOT NULL,
  creator         eth_address   NOT NULL,           -- from CampaignCreated
  balance         numeric(78,0) NOT NULL DEFAULT 0, -- accumulated from event deltas
  reserved        numeric(78,0) NOT NULL DEFAULT 0, -- amounts of Timelocked/Disputed milestones
  milestone_count int           NOT NULL,
  created_at      timestamptz   NOT NULL,           -- block time of CampaignCreated
  created_block   bigint        NOT NULL,
  created_tx      eth_hash      NOT NULL,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, campaign_id),
  CHECK (reserved <= balance)
);

-- ── milestones  (CampaignEscrow campaign.milestones[i]) ───────────────────
CREATE TABLE milestones (
  deployment_id  bigint          NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id    bigint          NOT NULL,
  milestone_id   bigint          NOT NULL,
  description    text            NOT NULL,          -- read-through getMilestone (immutable)
  amount         numeric(78,0)   NOT NULL,          -- read-through getMilestone (immutable)
  state          milestone_state NOT NULL DEFAULT 'Pending',
  release_after  timestamptz,                       -- null until Timelocked
  updated_at     timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, campaign_id, milestone_id),
  FOREIGN KEY (deployment_id, campaign_id)
    REFERENCES campaigns(deployment_id, campaign_id) ON DELETE CASCADE
);
CREATE INDEX milestones_by_state ON milestones (deployment_id, state);

-- ── donations  (append-only; no on-chain struct to mirror) ────────────────
CREATE TABLE donations (
  id            bigserial     PRIMARY KEY,
  deployment_id bigint        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id   bigint        NOT NULL,
  donor         eth_address   NOT NULL,
  amount        numeric(78,0) NOT NULL,
  tx_hash       eth_hash      NOT NULL,
  log_index     int           NOT NULL,
  block_number  bigint        NOT NULL,
  block_time    timestamptz   NOT NULL,
  UNIQUE (deployment_id, tx_hash, log_index),       -- idempotent replay
  FOREIGN KEY (deployment_id, campaign_id)
    REFERENCES campaigns(deployment_id, campaign_id) ON DELETE CASCADE
);
CREATE INDEX donations_by_campaign ON donations (deployment_id, campaign_id);
CREATE INDEX donations_by_donor    ON donations (deployment_id, donor);

-- ── verifiers  (VerifierRegistry per-address state) ──────────────────────
CREATE TABLE verifiers (
  deployment_id      bigint        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  address            eth_address   NOT NULL,
  staked_amount      numeric(78,0) NOT NULL DEFAULT 0,
  reputation         int           NOT NULL DEFAULT 0,   -- 0..200
  is_verifier        boolean       NOT NULL DEFAULT false,
  against_strikes    int           NOT NULL DEFAULT 0,
  first_joined_block bigint,
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, address),
  CHECK (reputation BETWEEN 0 AND 200)
);
CREATE INDEX verifiers_active ON verifiers (deployment_id) WHERE is_verifier;

-- ── rounds  (MilestoneVoting.Round, keyed by roundIndex) ─────────────────
CREATE TABLE rounds (
  deployment_id     bigint        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id       bigint        NOT NULL,
  milestone_id      bigint        NOT NULL,
  round_index       int           NOT NULL,              -- MilestoneVoting.roundIndexOf, 1-based
  status            round_status  NOT NULL DEFAULT 'Open',
  approve_weight    numeric(78,0) NOT NULL DEFAULT 0,    -- Σ VoteCast.weight where approve
  reject_weight     numeric(78,0) NOT NULL DEFAULT 0,    -- Σ VoteCast.weight where !approve
  weight_snapshot   numeric(78,0) NOT NULL,              -- RoundOpened.totalWeightSnapshot
  approved          boolean,                             -- null until Finalized
  proof_cid         text          NOT NULL,              -- RoundOpened.proofCID (SNAPSHOT, not live)
  deadline          timestamptz   NOT NULL,              -- openedAt + VOTING_PERIOD
  dispute_weight    numeric(78,0) NOT NULL DEFAULT 0,    -- DisputeJoined.cumulativeDisputeWeight  (beyond spec)
  dispute_forwarded boolean       NOT NULL DEFAULT false,-- DisputeThresholdReached                (beyond spec)
  opened_block      bigint        NOT NULL,
  opened_tx         eth_hash      NOT NULL,
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, campaign_id, milestone_id, round_index),
  FOREIGN KEY (deployment_id, campaign_id, milestone_id)
    REFERENCES milestones(deployment_id, campaign_id, milestone_id) ON DELETE CASCADE
);
CREATE INDEX rounds_open ON rounds (deployment_id) WHERE status = 'Open';

-- ── votes  (append-only; one per verifier per round = on-chain key) ──────
CREATE TABLE votes (
  deployment_id bigint        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id   bigint        NOT NULL,
  milestone_id  bigint        NOT NULL,
  round_index   int           NOT NULL,
  voter         eth_address   NOT NULL,
  approve       boolean       NOT NULL,
  weight        numeric(78,0) NOT NULL,               -- VoteCast.weight            (beyond spec)
  aligned       boolean,                              -- VoterSettled, null until finalize (beyond spec)
  tx_hash       eth_hash      NOT NULL,
  log_index     int           NOT NULL,
  block_number  bigint        NOT NULL,
  PRIMARY KEY (deployment_id, campaign_id, milestone_id, round_index, voter),
  FOREIGN KEY (deployment_id, campaign_id, milestone_id, round_index)
    REFERENCES rounds(deployment_id, campaign_id, milestone_id, round_index) ON DELETE CASCADE
);
CREATE INDEX votes_by_voter ON votes (deployment_id, voter);

-- ── proofs  (ProofRegistry._proofs[key] — current record only) ──────────
CREATE TABLE proofs (
  deployment_id bigint      NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  campaign_id   bigint      NOT NULL,
  milestone_id  bigint      NOT NULL,
  cid           text        NOT NULL,                 -- current CID (live ProofRegistry value)
  submitter     eth_address NOT NULL,
  version       int         NOT NULL,                 -- on-chain submission count
  submitted_at  timestamptz NOT NULL,                 -- block time of latest ProofSubmitted
  submitted_tx  eth_hash    NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, campaign_id, milestone_id),
  FOREIGN KEY (deployment_id, campaign_id, milestone_id)
    REFERENCES milestones(deployment_id, campaign_id, milestone_id) ON DELETE CASCADE
);

-- ── event_log  (every processed log: idempotency key + full audit) ──────
CREATE TABLE event_log (
  deployment_id bigint      NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  tx_hash       eth_hash    NOT NULL,
  log_index     int         NOT NULL,
  block_number  bigint      NOT NULL,
  block_time    timestamptz NOT NULL,
  contract      eth_address NOT NULL,
  event_name    text        NOT NULL,
  args          jsonb       NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, tx_hash, log_index)
);
CREATE INDEX event_log_by_block ON event_log (deployment_id, block_number);
CREATE INDEX event_log_by_name  ON event_log (deployment_id, event_name);

COMMIT;
