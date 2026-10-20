# /api — read-only REST API

An Express server that serves **cached data from the `charity_indexer` Postgres
database** the `/indexer` process fills. It is a **separate process** with its
**own `package.json`, its own `.env`, and its own `pg` connection pool** — it
shares only the `DATABASE_URL`, never a connection instance. The indexer keeps
running independently; this server never writes to the domain tables.

One endpoint (`POST /proofs/upload`) talks to Pinata to pin a file to IPFS; it
still does not touch the chain or the `proofs` table (see below).

## Run

```bash
cd api
npm install
cp .env.example .env         # set DATABASE_URL, CHAIN_ID, ESCROW_ADDRESS, PINATA_JWT
npm start                    # tsx src/index.ts   (dev: npm run dev — watch mode)
```

The database and its schema must already exist (`npm run db:migrate` from the repo
root) and a `deployments` row must match `CHAIN_ID` + `ESCROW_ADDRESS`
(`npm run indexer:register`). The server resolves that row to a `deployment_id`
once at startup and every query filters on it.

`npm run build` emits `dist/`; `npm run serve` runs the compiled output.

## Which database driver — `pg`, not Prisma

Plain `pg` with a `Pool`. This service issues a small set of hand-written,
read-only SQL queries against composite-key tables and `numeric(78,0)` columns
that must stay **strings** (a global type-parser override, mirrored from the
indexer). `pg` gives direct control over that and adds ~0 startup cost and no
schema-drift surface. Prisma would add a code-gen step, its own copy of the schema
to keep in sync with `indexer/migrations/*.sql`, and `BigInt`/`Decimal` wrappers
to fight — real value only if we wanted a typed model layer or migrations here,
and migrations belong to the indexer. So: `pg`.

Connection pooling: one `pg.Pool` (`max: 8`) created in `src/db.ts` and reused for
every request — never a connection per request.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | pings the DB |
| `GET` | `/campaigns` | list: `id, beneficiary, balance, reserved, milestoneCount`. `?sort=` one of `id,balance,reserved,milestones,created` (prefix `-` for desc), `?limit=` 1–500 (default 100) |
| `GET` | `/campaigns/:id` | campaign + every milestone + each milestone's latest round (`MAX(round_index)`, or `null`) + `proof.submitted` status |
| `GET` | `/campaigns/:id/donations` | donations for the campaign, newest first, `?limit=` 1–1000 (default 200) |
| `GET` | `/verifiers/leaderboard` | verifiers by `reputation DESC, staked_amount DESC`; includes `stakedAmount`, `isVerifier`, `againstStrikes`. `?limit=` 1–500 |
| `GET` | `/milestones/:campaignId/:milestoneId/votes` | the votes in that milestone's current/latest round (round is `null` if none opened yet) |
| `POST` | `/proofs/upload` | multipart `file` field → pins to IPFS via Pinata → `{ cid, gatewayUrl, ... }` |

### Errors

- `400` — non-numeric id, unknown `sort`, non-positive `limit`, missing/empty upload file.
- `404` — unknown campaign id, unknown milestone, unknown route.
- `502` — Pinata unreachable / rejected the upload.
- `503` — `POST /proofs/upload` when `PINATA_JWT` is not set (checked before the
  upload is buffered, so disabled = fast reject).

Amounts and weights (`balance`, `reserved`, `amount`, `*_weight`, `stakedAmount`)
are wei as **decimal strings** — never parsed to JS numbers.

## `POST /proofs/upload` — the only endpoint hitting an external service

```
client --(multipart file)--> /api --(Bearer PINATA_JWT)--> Pinata
client <-------( cid )------- /api <------( IpfsHash )----- Pinata

then, entirely client-side:
client wallet --> ProofRegistry.submitProof(campaignId, milestoneId, cid)   [on-chain]
                        |
                        v  emits ProofSubmitted
                  indexer  --> upserts the `proofs` row
                        |
                        v
/api GET /campaigns/:id  now reports proof.submitted = true
```

Why it is split this way:

1. **The API never writes `proofs`.** Pinning to IPFS is permissionless — a CID
   only *means* something once the campaign's beneficiary commits it on-chain via
   `ProofRegistry.submitProof` (the contract enforces `msg.sender ==
   beneficiaryOf(campaignId)`). This endpoint just returns the content address of
   the bytes you sent. The authoritative write happens on-chain and reaches the DB
   through the indexer.
2. **The Pinata key never leaves the server.** It lives only in `api/.env`
   (`PINATA_JWT`), is attached as an `Authorization: Bearer` header in
   `src/pinata.ts`, and is never in a response body. A browser calling Pinata
   directly would leak it.
3. **The server holds no private key** and does not sign transactions. The client
   takes the returned `cid` and submits it from the user's wallet.
4. **Clean failure modes:** Pinata down → `502`, nothing moved, client retries.
   Client uploads but never submits on-chain → file is pinned, no `proofs` row,
   harmless.

Request:

```bash
curl -X POST http://localhost:4000/proofs/upload \
  -F file=@./impact-report.pdf \
  -F campaignId=0 -F milestoneId=1        # optional, attached as Pinata metadata only
```

Response (`201`):

```json
{
  "cid": "bafkrei...",
  "size": 51234,
  "pinnedAt": "2026-09-06T14:00:00.000Z",
  "gatewayUrl": "https://gateway.pinata.cloud/ipfs/bafkrei...",
  "filename": "impact-report.pdf",
  "metadata": { "campaignId": "0", "milestoneId": "1" },
  "next": "submit this cid on-chain: ProofRegistry.submitProof(campaignId, milestoneId, cid)"
}
```

Max upload size is `MAX_UPLOAD_BYTES` (default 10 MiB) — over that is `400`.

## Layout

```
api/
  package.json          own deps; "qs" override clears a transitive advisory
  tsconfig.json         ESM, node20, strict
  .env / .env.example   own config (DATABASE_URL, deployment id, PINATA_JWT)
  src/
    config.ts           env parsing (loads api/.env by absolute path)
    db.ts               the API's own pg.Pool + query helpers
    deployment.ts       resolve CHAIN_ID + ESCROW_ADDRESS -> deployment_id once
    errors.ts           ApiError, wrap(), error middleware
    params.ts           ?sort / ?limit / :id validation
    pinata.ts           server-side pinFileToIPFS client
    routes/
      campaigns.ts  verifiers.ts  milestones.ts  proofs.ts
    server.ts           express app assembly
    index.ts            startup + graceful shutdown
```
