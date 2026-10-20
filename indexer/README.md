# Event indexer — Charity Donation Tracking System

Mirrors on-chain state of the four deployed contracts into PostgreSQL. Resumable
via a persisted block cursor; `contract.on()` is a latency layer over a chunked
`getLogs` replay.

## Layout

```
indexer/
  migrations/0001_init.sql   schema (deployments, campaigns, milestones, donations,
                             verifiers, rounds, votes, proofs, sync_state, event_log)
  config.ts                  env parsing (loads indexer/.env by absolute path)
  migrate.ts                 cross-platform migration runner (pg, no psql)
  db.ts                      pg Pool + tx() helper
  contracts.ts               ABIs (read from ../artifacts), Interfaces, Contract instances
  handlers.ts                one function per event -> SQL
  engine.ts                  processLog / replayRange / sweep / live listeners / reconcile / run
  register-deployment.ts     one-off: insert the deployments row
  index.ts                   entrypoint
```

## Setup

```bash
npm install                                    # adds pg, dotenv, dotenv-cli, tsx
cp indexer/.env.example indexer/.env           # then edit DATABASE_URL, RPC_URL, addresses, START_BLOCK

npm run db:migrate                             # dotenv -e indexer/.env -- tsx indexer/migrate.ts
npm run indexer:register                       # writes the deployments row + seeds the cursor
npm run indexer                                # replay, then live
```

Every script is `dotenv -e indexer/.env -- tsx indexer/<script>.ts`, so `indexer/.env`
is loaded the same way on Windows PowerShell, cmd, and POSIX shells — no shell
variable expansion, no reliance on the ambient environment. `config.ts` also loads
`indexer/.env` by absolute path, so `npx tsx indexer/index.ts` works directly too.

`db:migrate` runs the `.sql` files through `pg` (not `psql`), so Postgres client
tools do not need to be on `PATH`. Re-running it against an already-migrated
database prints `already applied` and exits 0.

The ABIs are read from `artifacts/contracts/*.sol/*.json` — run `npx hardhat compile`
first if `artifacts/` is missing. Needs Postgres 14+.

## What it does on start

1. Load `sync_state.last_synced_block` (seeded at `START_BLOCK - 1`).
2. `replayRange(cursor+1, head - CONFIRMATIONS)` — one `getLogs` per
   `LOG_BATCH_SIZE`-block window (default 10, matching Alchemy free tier's
   `eth_getLogs` cap; raise it on a paid plan) over all four addresses, logs
   sorted by `(blockNumber, logIndex)` (exact on-chain order across contracts),
   each processed in a transaction that also inserts
   `event_log(deployment_id, tx_hash, log_index)` `ON CONFLICT DO NOTHING`. The
   cursor advances per batch, so an interrupted replay resumes mid-range.
3. Attach `contract.on(event, …)` for every handled event on all four contracts.
   The listener only calls `scheduleSweep()` — it never writes.
4. One more `sweep()` to cover blocks mined during step 2→3.
5. Steady state: `sweep()` (mutex'd) is the only writer, triggered by the
   listeners, a `provider.on("block")` heartbeat, and a `POLL_INTERVAL_MS` timer.
   Every path is the same ordered, idempotent replay from the cursor.
6. `reconcile()` every `RECONCILE_INTERVAL_MS` cross-checks `campaigns` and
   `verifiers` against `getCampaign` / `reputationOf` / … and logs + corrects drift.

Because writes are idempotent (`event_log` PK), overlapping ranges, reorg
re-deliveries, and listener/sweep double-fires are all no-ops.

### `CONFIRMATIONS` on a local node

Step 2 stops at `head - CONFIRMATIONS`. A Hardhat node mines a block only when it
receives a transaction, so on an idle chain the head never moves and the newest
`CONFIRMATIONS` blocks are never reached. `Donated` is emitted in the block right
after `CampaignCreated` (a separate tx), so with `CONFIRMATIONS >= 1` you get the
campaign row but the donation is stranded one block past the horizon. Keep
`CONFIRMATIONS=0` for local; the config auto-selects 0 when `RPC_URL` is
localhost. Use 5+ only against a public network.

## Events handled (24)

CampaignEscrow: `CampaignCreated`, `Donated`, `TimelockStarted`, `DisputeRaised`,
`MilestoneReleased`, `DisputeResolved`, `SlashedFundsReceived`, `UpkeepPerformed`
VerifierRegistry: `VerifierJoined`, `Staked`, `Unstaked`, `VerifierRemoved`,
`ReputationChanged`, `StrikeRecorded`, `Slashed`, `SlashRoutedToEscrow`
MilestoneVoting: `RoundOpened`, `VoteCast`, `RoundFinalized`,
`DisputeThresholdReached`, `DisputeJoined`, `VoterSettled`
ProofRegistry: `ProofSubmitted`

`UpkeepPerformed` and `SlashRoutedToEscrow` land in `event_log` only (their state
effects arrive as `MilestoneReleased` / `SlashedFundsReceived` in the same tx).
`MilestoneVotingSet` / `VerifierRegistrySet` / `UnallocatedSwept` /
`PendingVotesChanged` are recorded in `event_log` but have no dedicated table.

## Notes

- `rounds.proof_cid` is `RoundOpened.proofCID` — the CID MilestoneVoting pinned at
  round-open, never a live `ProofRegistry` read. `proofs.cid` tracks the live
  ProofRegistry record separately.
- One contract read-through only: `getMilestone(campaignId, i)` in the
  `CampaignCreated` handler, for `description` + `amount` (no event carries them;
  both immutable so historically safe). Everything else is event-derived.
- `round_index` is derived (`MAX(round_index)+1` on `RoundOpened`, `MAX(...)` for
  votes/finalize) — safe given no `RoundOpened` is ever missed.
- Multiple deployments (networks, redeploys) coexist: each is its own
  `deployments` row + `deployment_id`, fully isolated.
