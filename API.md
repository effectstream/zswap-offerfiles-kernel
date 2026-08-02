# ZSwap-DA — Developer API Reference

ZSwap-DA is a dual-chain indexer and offer relay for shielded DEX swaps. It watches two chains simultaneously — **Midnight** (shielded settlement) and **Celestia** (decentralised data availability) — and presents a single REST API for reading live swap offers and writing new ones.

This document targets application developers who want to interact with the endpoints directly, submit ZSwap offers to Celestia, or drive settlement transactions on Midnight programmatically.

**Interactive playground:** `bun run docs:dev` →
[`http://localhost:10601/docs/`](http://localhost:10601/docs/) (Vite + React),
or `bun run docs:build` and open
[`http://localhost:9999/docs`](http://localhost:9999/docs). Debug offer upload
(`POST /v1/offers`), browse the open book, poll status, stream SSE,
settle via the batcher's `midnight-balancer` target, and connect a wallet to
inspect balances / mint test tokens (`VITE_PROOF_SERVER_URL`, default
`http://localhost:6300`).

---

## Environments

Three configurations ship out of the box. All endpoints and env-var names are identical across environments; only the values differ.

| | **Undeployed (local dev)** | **Preview** | **Mainnet** |
|---|---|---|---|
| `MIDNIGHT_NETWORK_ID` | `undeployed` | `preview` | `mainnet` |
| `CELESTIA_NETWORK` | `devnet` | `mocha` | `mainnet` |
| `CELESTIA_RPC_URL` | `http://127.0.0.1:26658` | QuickNode Mocha-4 URL | QuickNode / self-hosted |
| `CELESTIA_POLLING_INTERVAL_MS` | `6000` | `3000` | `30000` |
| `CELESTIA_START_HEIGHT` | `1` | `10620000` ¹ | set to your deployment block |
| `MIDNIGHT_START_BLOCK` | `1` | `1` | set to your deployment block |
| `OFFER_TTL_SECONDS` | default = root window (1 h) | default = root window (1 h) ² | default = root window (1 h) ² |
| Node API port | `9999` | `9999` | `9999` |
| Batcher port | `3334` | `3334` | `3334` |
| Config file | `config.dev.ts` | `config.preview.ts` | `config.mainnet.ts` |

¹ Mocha-4 block equivalent to Midnight Preview genesis (2026-03-25T01:05:42 UTC).  
² Preview and Mainnet use a ~1-hour Merkle-root window. Offers proving against an expired root cannot settle; matching `OFFER_TTL_SECONDS` to the root window prevents the indexer from serving un-fillable offers.

### Environment variables (complete reference)

```bash
# ── Celestia ────────────────────────────────────────────────────────────────
CELESTIA_NETWORK=devnet|mocha|mainnet    # selects polling-interval default
CELESTIA_RPC_URL=http://...              # light-node JSON-RPC endpoint
CELESTIA_NAMESPACE=6d6e2d737761702d7631   # 10-byte namespace id suffix (hex, no 0x).
                                        # Default = the MIP-0006 SHARED namespace
                                        # ("mn-swap-v1"): one namespace = one liquidity
                                        # pool. Override only for isolated dev/e2e.
CELESTIA_AUTH_TOKEN=                    # bearer token; leave empty for QuickNode (auth is in the URL)
CELESTIA_START_HEIGHT=1                 # skip blocks before your deployment
CELESTIA_POLLING_INTERVAL_MS=6000       # how often to poll for new blocks
CELESTIA_STEP_SIZE=200                  # blocks per fetch window
CELESTIA_FETCH_CONCURRENCY=12           # parallel RPC calls per window

# ── Midnight ─────────────────────────────────────────────────────────────────
MIDNIGHT_NETWORK_ID=undeployed|preview|mainnet
MIDNIGHT_CONTRACT_ADDRESS=mn1...        # required on preview/mainnet
MIDNIGHT_START_BLOCK=1
MIDNIGHT_DELAY_MS=30000                 # indexer poll delay

# ── NTP timing ────────────────────────────────────────────────────────────────
NTP_START_TIME=1774400742000            # epoch anchor (ms); default = Preview block 1
BLOCK_TIME_MS=600000                    # 10 min/block keeps catch-up short
NTP_STEP_SIZE=1000

# ── Node ──────────────────────────────────────────────────────────────────────
EFFECTSTREAM_API_PORT=9999
BATCHER_SUBMIT_URL=http://127.0.0.1:3334
OFFER_TTL_SECONDS=                      # offer lifetime; DEFAULTS to ROOT_WINDOW_SECONDS
                                        # (shielded fillability tracks the root window)
OFFER_MAX_BYTES=1048576                 # max decoded offer size (DoS guard)
ENABLE_TOKEN_REGISTRY=false             # POST /v1/known-tokens; names are UNVERIFIED — dev/e2e only
ROOT_WINDOW_SECONDS=                    # known-roots retention window. Defaults PER NETWORK:
                                        # 3600 (1 h) on all currently deployed networks;
                                        # MIDNIGHT_NETWORK_ID=stagenet → 1209600 (2 weeks —
                                        # placeholder, network not publicly available yet).
                                        # Must mirror the zswap crate's past_roots window
                                        # (hardcoded through node 1.x, parameterized from
                                        # 2.x) — NOT the on-chain global_ttl, which bounds
                                        # intent TTLs and moves independently. Too wide ⇒
                                        # phantom unfillable offers on the book; too narrow
                                        # ⇒ valid offers rejected ROOT_UNKNOWN.
```

**Retention model.** The three liveness sets are deliberately asymmetric, and the differences are load-bearing:

| Set | Retention | Why |
|---|---|---|
| `nullifiers` | **Forever** | A shielded spend is permanent. Coin commitments stay in the Merkle tree after being spent, so a maker can always build a valid current-root proof for a long-spent coin — the nullifier is the only thing that catches it. There is intentionally no TTL. |
| `created_unshielded` | **Live-set** | Create inserts, spend deletes; absence means "spent or never existed". Self-trimming, so no TTL is needed. |
| `known_roots` | **TTL-limited** (`ROOT_WINDOW_SECONDS`) | Unlike a spend, a root's validity genuinely expires. The ledger's `past_roots` is a *TimeFilterMap*: the current root is re-inserted every block and entries older than `tblock − window` are evicted — so a root stays valid while it keeps being current, and our prune mirrors that by aging on **last-seen**. Independent from the on-chain `global_ttl` (which bounds intent TTLs) despite both being 1 h. |

---

## How it works (indexer overview)

```
Celestia DA                    Midnight
     │                               │
     │  every blob in namespace      │  every block: nullifiers,
     │  → raw MIP-0005 tx bytes      │  unshielded UTXOs, Merkle roots
     ▼                               ▼
         ┌─────────────────────────────┐
         │   ZSwap-DA indexer (node)   │
         │                             │
         │  offer_file  (live offers)  │
         │  nullifiers  (spent coins)  │
         │  known_roots (root window)  │
         └────────────┬────────────────┘
                      │  REST API  :9999
                      ▼
               your application
```

**Offer lifecycle:**

1. A maker encodes a `swapoffer1…` blob and POSTs it to `/v1/offers`.
2. The node validates it, then forwards it to the batcher which publishes it as a Celestia blob.
3. The Celestia indexer picks up the blob and re-validates it deterministically. On success the offer lands in `offer_file`.
4. When any input coin is spent on Midnight (nullifier seen or unshielded UTXO consumed), the offer moves to `offer_file_history` with `archive_reason = 'CONSUMED'`.
5. If no consumption is observed before the TTL, a scheduled cleanup archives it with `archive_reason = 'TTL'`.

---

## Node API — port 9999

Base URL: `http://<host>:9999`

---

### Health

#### `GET /health`

Framework-level liveness probe. Returns `200 OK` as soon as the HTTP server is up, regardless of sync state.

```bash
curl http://host:9999/health
```

```json
{ "status": "ok" }
```

---

#### `GET /v1/health/sync`

Per-protocol sync progress. Use this to confirm the node is serving live data before submitting offers.

```bash
curl http://host:9999/v1/health/sync
```

**Response**

```json
{
  "ts": 1750800000000,
  "status": "syncing",
  "ntp": {
    "current": 1270,
    "tip":     12816,
    "pct":     9.9,
    "lag_blocks":  11546,
    "lag_seconds": 6927600
  },
  "midnight": {
    "current": 127000,
    "fetched": 127500,
    "tip":     1281600,
    "pct":     9.9
  },
  "celestia": {
    "current": 12231713,
    "fetched": 12231800,
    "tip":     12233200,
    "pct":     99.8
  }
}
```

| Field | Description |
|---|---|
| `status` | `"ok"` — within 2 NTP blocks of real time (≤ 20 min lag); `"syncing"` — catching up; `"error"` — no blocks finalized yet |
| `ntp.lag_seconds` | Seconds of history remaining to process |
| `midnight.tip` | Live Midnight chain tip (cached 60 s; `null` if unreachable) |
| `celestia.tip` | Live Celestia chain tip (cached 60 s; `null` if unreachable) |
| `sets.*` | Sizes of the ingested liveness sets (cached 15 s) |
| `recent_rejections` | Blobs discarded at ingestion, as `{celestia_height, code, count}` for the 20 most recent heights. Rejected blob bodies are deleted, so this is how namespace spam stays visible — see [Ingestion pipeline](#ingestion-pipeline-the-critical-path) |

On a fresh database the initial sync of 89 days of Midnight history takes approximately 4 hours.

---

### Reading offers

#### `GET /v1/offers`

Returns the current live offer book — offers published to Celestia, validated, and not yet consumed or expired.

**Query parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `token` | hex string | — | Filter to offers that include this token color (64 hex chars, no `0x`). Matches both giving and wanting sides. |
| `direction` | `GIVING` \| `WANTING` | any | Filter by side. Only meaningful when `token` is also set. |
| `limit` | integer | 100 | Max results (capped at 100). |
| `after_hash` | hex string | — | Keyset cursor: the previous page's `nextCursor`. Malformed or unknown values answer `400 INVALID_CURSOR` (never a silent first page). There is **no `offset`** — cursors cost O(1) regardless of depth and are immune to concurrent inserts/archives shifting the page window. |

**Response** — `{ "offers": [...], "nextCursor": "<hash>" | null }`, newest first. Pass `nextCursor` back as `after_hash` to fetch the next page; `null` means exhausted (a full final page returns a cursor whose follow-up fetch yields `{ "offers": [], "nextCursor": null }`). The list is **blob-free**: a single offer blob is 16–25 KB of bech32m, so a 100-row page carrying blobs would be megabytes. Each row instead carries `offerId`; fetch the string per offer via `GET /v1/offers/:offerId`.

```json
{
  "offers": [{
    "version": 1,
    "offerId": "9f2c4a…64 hex chars…e1",
    "blobChars": 24781,
    "celestiaHeight": "12231800",
    "computed": {
      "gives": [
        { "token": "0000…0000", "amount": "1000000", "type": "UNSHIELDED" }
      ],
      "wants": [
        { "token": "70ce…b569", "amount": "500000", "type": "SHIELDED" }
      ],
      "expiresAt": "2026-06-01T13:00:00.000Z",
      "inputNullifiers": ["7c1d9b…"],
      "firstSeenAt": "2026-06-01T12:00:00.000Z",
      "status": "live"
    }
  }],
  "nextCursor": null
}
```

Each row is a MIP-0006 `OffchainOfferPayload`. **`offerBech32` is omitted in list responses** — the spec's presence rule is "at least one of `offerId`/`offerBech32`", and a real offer's string is 16–25 KB, so a 100-row page carrying strings would be megabytes. Fetch the string per offer via `GET /v1/offers/:offerId`, which always includes it. `blobChars` sizes that fetch.

| Field | Description |
|---|---|
| `offerId` | **Content hash** — hex sha256 of the raw MIP-0005 transaction bytes (the canonical serialized `Transaction`; the bech32m string is an encoding of these bytes). Identical on every node that indexes the same offer. |
| `id` | Local row id. **Deployment-specific bookkeeping** — two nodes indexing the same namespace assign different ids. Never use it for cross-system references. |
| `blobChars` | Length of the bech32m string served by `GET /v1/offers/:offerId` |
| `gives` | Tokens the maker is offering. Each leg carries `kind` (`SHIELDED`/`UNSHIELDED`, MIP-0006 `TokenLeg.type`) — the same color on different value layers is two distinct legs, never netted |
| `wants` | Tokens the maker is requesting (same leg shape) |
| `ttl_seconds` | Offer lifetime in seconds from `metadata_created_at`, as a **string** |

All string/number fields are returned as-is from the DB; numeric-looking values (`celestia_height`, `ttl_seconds`, token `amount`) are **strings** to preserve full precision.

```bash
# All open offers giving NIGHT:
curl "http://host:9999/v1/offers?token=0000000000000000000000000000000000000000000000000000000000000000&direction=GIVING"
```

---

#### `GET /v1/offers/:hash`

One offer — **including its `swapoffer1…` string** (`offerBech32`; the MIP requires it in single-offer responses) — addressed by content hash (the hex sha256 of the raw offer bytes, as served in list rows and submit responses). Resolves archived offers too, so a consumed/expired offer still returns with its final status.

```bash
curl "http://host:9999/v1/offers/9f2c4a...e1"
```

**Response**

```json
{
  "version": 1,
  "offerId": "9f2c4a…e1",
  "offerBech32": "swapoffer1...",
  "celestiaHeight": "12231800",
  "ttlSeconds": "3600",
  "computed": {
    "gives": [ { "token": "00…00", "amount": "1000000", "type": "UNSHIELDED" } ],
    "wants": [ { "token": "70ce…69", "amount": "500000", "type": "SHIELDED" } ],
    "expiresAt": "2026-06-01T13:00:00.000Z",
    "inputNullifiers": ["7c1d9b…"],
    "firstSeenAt": "2026-06-01T12:00:00.000Z",
    "status": "live"
  }
}
```

`computed.status` is `"live"` | `"consumed"` | `"cancelled"` | `"expired"`. Unknown hashes → `404 { "error": "NOT_FOUND", "offerId": "…" }`; malformed hashes → `400 { "error": "INVALID_HASH" }`.

#### `GET /v1/offers/:hash/status`

Lightweight status probe by content hash:

```json
{ "offerId": "9f2c4a…e1", "status": "live" }
```

`status` is `"live"` | `"consumed"` | `"cancelled"` | `"expired"` | `"not_found"`.

**Fill vs cancel.** Settlement is atomic — a fill consumes *all* of an offer's inputs in *one* Midnight transaction — so an archived offer whose nullifiers were spent across different transactions, or only partially spent, is reported `"cancelled"` with certainty: it can never have settled. `"consumed"` means all inputs left in a single transaction — and for offers with stored **fill markers** (the offer's own output commitments, plaintext in the published blob and captured at ingestion) the classification is exact in both directions: a genuine settlement must create those commitments on-chain (merging preserves outputs verbatim), so their absence from the spending tx proves a cancel, single-input offers included. Marker-less offers (unshielded-only wants, rows indexed before the commitments migration) keep the one-tx heuristic. Chain-side commitments come from the `Midnight:NullifierAndCommitment` primitive at zero extra indexer cost. Chart/trade data counts only `"consumed"` offers.

---

#### `POST /v1/offers/status`

Status lookup by blob, for reconciling a "My Trades" list on startup when only the blobs are held client-side. POST body — a real blob is 16–25 KB, beyond any practical query-string limit.

**Body:** `{ "offer": "swapoffer1..." }`, or batched: `{ "offers": ["swapoffer1...", ...] }` (max 50).

```bash
curl -X POST http://host:9999/v1/offers/status \
  -H 'Content-Type: application/json' \
  -d '{"offer":"swapoffer1..."}'
```

**Response**

```json
{ "offerId": "9f2c4a…e1", "status": "live" }
```

Batched requests return `{ "statuses": [ … ] }` in input order. `status` is one of `"live"` | `"consumed"` | `"cancelled"` | `"expired"` | `"not_found"` (see *Fill vs cancel* above). A blob that does not decode answers `{ "status": "not_found" }` with no `offerId`.

Lookups resolve via the offer's content hash (an indexed probe). A blob that does not decode as a `swapoffer1…` string answers `"not_found"` **without touching the database** — undecodable blobs can never have been indexed, and this keeps junk submissions from costing more than a hash attempt.

---

#### `GET /v1/pairs`

All known trading pairs, combining historical fill data from `pair_stats` with live open-offer counts. Use this to populate a pair picker or market list. Pairs are keyed by **token color only** — resolve display names separately via `GET /v1/known-tokens`.

```bash
curl http://host:9999/v1/pairs
```

```json
[
  {
    "pair_key":       "70ce552eaec9be6e009189bffbb69184b2dd008ba9bdaec6da5305fc505eb569|0000000000000000000000000000000000000000000000000000000000000000",
    "base_color":     "70ce552eaec9be6e009189bffbb69184b2dd008ba9bdaec6da5305fc505eb569",
    "quote_color":    "0000000000000000000000000000000000000000000000000000000000000000",
    "trade_count":    12,
    "last_price":     12.5,
    "last_traded_at": "2026-06-01T12:00:00.000Z",
    "open_count":     6
  }
]
```

| Field | Description |
|---|---|
| `pair_key` | `base_color\|quote_color` — the stable pair identifier |
| `trade_count` | Number of filled (consumed) offers for this pair |
| `last_price`, `last_traded_at` | From the most recent fill; **`null` until the pair has traded** |
| `open_count` | Live open offers for this pair right now |

---

#### `GET /v1/known-tokens`

> **⚠️ Demo endpoint — do not use as a source of truth.**
> This registry is a temporary convenience feature for this demo. The official Midnight token-metadata standard is not yet live. Names and kinds stored here are manually curated and unverified. Do not rely on this endpoint for authoritative token information.

All registered token colors.

```bash
curl http://host:9999/v1/known-tokens
```

```json
[
  { "id": 1, "token_color": "0000000000000000000000000000000000000000000000000000000000000000", "name": "NIGHT", "kind": "unshielded" }
]
```

New token colors are auto-registered when a valid offer containing them is indexed.

---

#### `POST /v1/known-tokens`

> **⚠️ Demo endpoint — disabled by default.**
> Requires `ENABLE_TOKEN_REGISTRY=true`; otherwise returns `404 NOT_ENABLED`. Enable it for local dev and e2e only.
> Registering a name here does not make it canonical. Any operator can write any name against any color. Wait for the official token-metadata standard before building user-facing trust on top of this endpoint.

Register a human-readable name for a token color before any offers appear (e.g. immediately after a browser-wallet mint).

```bash
curl -X POST http://host:9999/v1/known-tokens \
  -H "Content-Type: application/json" \
  -d '{"color":"70ce552eaec9be6e009189bffbb69184b2dd008ba9bdaec6da5305fc505eb569","name":"TESTTOKENA","kind":"shielded"}'
```

**Body**

```json
{
  "color": "70ce552eaec9be6e009189bffbb69184b2dd008ba9bdaec6da5305fc505eb569",
  "name": "TESTTOKENA",
  "kind": "shielded"
}
```

`name` must be unique (max 16 chars, stored uppercased). `kind` is `"shielded"` or `"unshielded"`.

**Success `200`**

```json
{ "success": true, "color": "70ce...", "name": "TESTTOKENA", "kind": "shielded" }
```

**Conflict `409`** — name or color already registered:

```json
{ "error": "Token name \"TESTTOKENA\" is already taken" }
```

---

### Writing offers

#### `POST /v1/offers`

Validate and forward a `swapoffer1…` blob to Celestia DA via the batcher. This is the recommended submission path — structure and coin liveness are verified before any Celestia fee is incurred.

```bash
curl -X POST http://host:9999/v1/offers \
  -H "Content-Type: application/json" \
  -d '{"offer":"swapoffer1..."}'
```

**Success `200`**

```json
{ "success": true, "offerId": "9f2c4a…e1", "result": { ... } }
```

`offerId` is the offer's content hash — track it with `GET /v1/offers/:offerId` once indexed. Ignore `result` (internal batcher receipt; shape not stable).

**Error `400`**

```json
{ "error": "ROOT_UNKNOWN", "reason": "input merkle root not a known recent chain root: abc123..." }
```

| Error code | Meaning |
|---|---|
| `INVALID_FORMAT` | Blob is not a valid `swapoffer1…` encoding |
| `INVALID_PROOF` | Cryptographic proof verification failed |
| `NULLIFIER_SPENT` | A shielded input coin is already spent on Midnight |
| `UTXO_NOT_LIVE` | An unshielded UTXO was spent or was never created on-chain |
| `ROOT_UNKNOWN` | The shielded input proves against a Merkle root outside the `ROOT_WINDOW_SECONDS` retention window |
| `DUPLICATE_OFFER` (`409`) | Byte-identical offer already indexed (open **or** archived) — rejected before any Celestia fee |

Validation consults the node's local state only — no live RPC calls are made. `ROOT_UNKNOWN` can fire while the node is still syncing (the root simply hasn't arrived yet). Retry once `/v1/health/sync` reports `"status":"ok"`.

---

### Market data

#### `GET /v1/quote`

Price quote for a token swap, backed by the `token_prices` table. On first request the deterministic fallback price is written; subsequent calls are consistent. Operators can override rows directly in the DB.

Both tokens must be registered in `known_tokens` — unknown colors answer `404 { "error": "UNKNOWN_TOKEN" }` rather than fabricating a rate, and malformed colors answer `400`.

**Query parameters:** `from_token`, `to_token` (64-hex, no `0x`), `from_amount` (base units), optional `to_amount`.

```bash
curl "http://host:9999/v1/quote?from_token=0000...0000&to_token=70ce...b569&from_amount=1000000"
```

**Response**

```json
{
  "from_token":          "0000...0000",
  "to_token":            "70ce...b569",
  "from_amount":         "1000000",
  "market_rate":         1.4623555716999876,
  "suggested_to_amount": "1425796",
  "to_amount":           "1425796",
  "implied_rate":        1.425796,
  "discount":            0.025,
  "sponsored":           true,
  "from_usd":            1.46,
  "to_usd":              1.42
}
```

| Field | Description |
|---|---|
| `market_rate` | Reference price `to/from` from the `token_prices` table |
| `suggested_to_amount` | `from_amount × market_rate` at the reference price (string, base units) |
| `to_amount` | The quoted receive amount — your `to_amount` if supplied, else `suggested_to_amount` |
| `implied_rate` | Effective `to_amount / from_amount` you'd be trading at |
| `discount` | Fractional gap below `market_rate` (e.g. `0.025` = 2.5% under market) |
| `sponsored` | `true` when the implied rate is at least the sponsorship discount below market (the batcher's fee-sponsorship policy hook) |
| `from_usd`, `to_usd` | USD value of each leg at the reference price |

---

#### `GET /v1/chart/stats?base=<A>&quote=<B>`

24-hour statistics for a pair derived from consumed (filled) offers. Falls back to the mid of current open offers when no fills exist yet.

```bash
curl "http://host:9999/v1/chart/stats?base=70ce...b569&quote=0000...0000"
```

```json
{
  "base": "70ce...",
  "quote": "0000...",
  "last": 12.5,
  "change24": 2.3,
  "high": 13.1,
  "low": 12.0,
  "volume_base": 10000000,
  "volume_quote": 800000
}
```

---

#### `GET /v1/chart/history?base=<A>&quote=<B>`

Last 120 fills (consumed offers) for a pair, newest first.

```json
[
  { "price": 12.5, "amt": 1000000, "up": true, "at": "2026-06-01T12:00:00.000Z" }
]
```

---

### Real-time events

#### `GET /v1/offers/stream`

Server-Sent Events stream for real-time offer lifecycle notifications. A comment-only keepalive (`: heartbeat`) is sent every 30 seconds.

```bash
curl -N http://host:9999/v1/offers/stream
```

**Event types**

```
data: {"type":"connected","timestamp":1750800000000}

data: {"type":"offer_indexed","offerId":42,"celestiaHeight":12231800,"gives":[...],"wants":[...],"timestamp":...}

data: {"type":"offer_consumed","offerId":42,"nullifier":"abc123...","timestamp":...}

data: {"type":"offer_expired","offerId":42,"timestamp":...}

data: {"type":"offer_rejected","code":"ROOT_UNKNOWN","reason":"...","celestiaHeight":...,"timestamp":...}

data: {"type":"token_minted","name":"MYTOKEN","color":"...","kind":"shielded","timestamp":...}
```

`timestamp` (ms epoch) is added by the server to every event. `offer_consumed`
carries **either** `nullifier` (shielded input spent) **or** `unshieldedSpend`
(`{owner, intentHash, outputNo}`, unshielded UTXO spent) depending on which coin
was consumed — handle both.

---

### Midnight configuration

#### `GET /v1/midnight/config`

Public Midnight configuration the browser contract client needs. Never includes secrets.

```bash
curl http://host:9999/v1/midnight/config
```

```json
{
  "contractAddress": "mn1abc...",
  "indexerUri":      "https://indexer.midnight.network:8088/graphql",
  "indexerWsUri":    "wss://indexer.midnight.network:8088/graphql",
  "proofServerUri":  "https://proof.midnight.network",
  "networkId":       "preview"
}
```

Returns `500` if `MIDNIGHT_CONTRACT_ADDRESS` is not set.

---

## Batcher API — port 3334

The batcher accepts `swapoffer1…` blobs, validates them, and publishes them as Celestia blobs. In normal usage you go through `/v1/offers` on the node (which calls the batcher internally). Direct batcher access is for advanced integrations.

Base URL: `http://<host>:3334`  
Swagger UI: `http://<host>:3334/documentation`

---

#### `GET /health`

```json
{ "status": "ok" }
```

---

#### `GET /status`

Batcher initialization state, pending input counts, and queue targets.

---

#### `GET /queue-stats`

```json
{
  "totalPendingInputs": 3,
  "targets": [
    {
      "target": "midnight-balancer",
      "pendingInputs": 3,
      "isReady": true,
      "criteriaType": "size",
      "timeSinceLastProcess": 120
    }
  ]
}
```

---

#### `POST /send-input`

Submit a blob directly to the batcher queue. Structure and cryptographic proofs are validated before acceptance. Liveness checks (spent coins, root-known) are not repeated here — they are enforced at the node's STM ingestion step.

**Body**

```json
{
  "data": {
    "input": "swapoffer1...",
    "target": "midnight-balancer",
    "address": "mn1...",
    "addressType": 0
  },
  "confirmationLevel": "wait-receipt"
}
```

**Success `200`**

```json
{
  "success": true,
  "message": "Input accepted",
  "inputsProcessed": 1,
  "transactionHash": "0xabc..."
}
```

**Rate-limited `429`**

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please retry after 60 seconds.",
  "retryAfter": 60
}
```

---

## Token colors

Token colors are 32-byte (64 hex character) identifiers used throughout the Midnight shielded ledger. They appear **without** a `0x` prefix in all API fields. Amounts are always integers in the token's base unit.

The one pre-seeded native token:

| Name | Color | Kind | Notes |
|---|---|---|---|
| `NIGHT` | `0000000000000000000000000000000000000000000000000000000000000000` | `unshielded` | Native Midnight token. `nativeToken()` in the SDK returns `TokenType::Unshielded(NIGHT)`. 1 NIGHT = 10⁶ Stars (atomic units). |

Shielded and unshielded NIGHT share the same color (`0x0000…0000`) and differ only by the enum tag (`Unshielded=0`, `Shielded=1`). The API does not distinguish them by color — both appear as the all-zeros color in offer legs.

---

## Encoding offers (`swapoffer1…`)

Offer blobs follow **MIP-0005** (HRP `swapoffer`). The encoding bundles a proven Midnight `Transaction` plus the cryptographic proofs required for settlement. Use `OfferFiles.encode` / `OfferFiles.decode` from `@effectstream/mip-zswap-offer/mip5` (also re-exported by `@zswap-da/validator`) rather than constructing the binary format by hand.

P2P swap semantics (gives/wants derivation, two-sided rule, off-chain payload shape) live in `@effectstream/mip-zswap-offer/mip6` (**MIP-0006**). DA/API alignment is **complete**: Celestia blobs carry the **raw transaction bytes** (no envelope — the on-chain payload type was removed from the spec), and API responses are `OffchainOfferPayload`s.

The decoded offer contains:

| Field | Description |
|---|---|
| `nullifiers` | Hashes of shielded input coins being spent |
| `unshieldedSpends` | `(owner, intentHash, outputNo)` triples for unshielded inputs |
| `inputRoots` | Merkle roots against which the input proofs are made |
| `gives` / `wants` | The token legs of the swap |

All of these are checked by `/v1/offers` before any Celestia fee is incurred.

### Ingestion pipeline (the critical path)

Anyone can post any bytes to the shared Celestia namespace for the price of a blob fee, so the **STM ingestion ladder is the authoritative filter** — `/v1/offers` and the batcher can both be bypassed. It is ordered cheapest-first so a blob that was never going to be indexed costs as little as possible:

| # | Check | Cost | Rejects |
|---|---|---|---|
| 1 | HRP prefix `swapoffer1` | O(1) | random bytes |
| 2 | **Encoded-length bound** | O(1) | oversized blobs, *before* decoding them |
| 3 | bech32m charset + checksum | O(n) | corrupt / non-offer text |
| 4 | Decoded size vs `OFFER_MAX_BYTES` | O(1) | oversized payloads |
| 5 | `Transaction.deserialize` | O(n) | not a ledger transaction |
| 6 | Structural: spendable input, two-sided legs (MIP-0006) | cheap | giveaways, non-swaps |
| 7 | Merkle-root extraction | cheap byte parse | unreadable roots |
| 8 | **Dedup** by content hash | one indexed probe | replays (open *and* archived) |
| 9 | **Liveness**: nullifier unspent, UTXO live, root known | indexed probes | stale / un-settleable offers |
| 10 | **`wellFormed`** — ZK proofs + signatures | **dominant cost** | forged offers |

Crypto runs **last** because it is orders of magnitude more expensive than every other step: a replayed or stale blob must never reach it. Nothing is skipped — an offer is indexed only after `wellFormed` passes — so the ordering changes *which* rejection fires, never turning a rejection into an acceptance. Callers select this with `crypto: "defer"` on `validateZswapOffer` plus an explicit `verifyOfferCrypto(tx, opts)`; the default remains inline verification, which is what the batcher uses (it has no DB to consult and must know an offer is genuine before spending a fee).

Rejected blobs are additionally **deleted** from `effectstream.primitive_accounting` in the same block transaction that created them. The framework persists every fetched blob there permanently, so on a permissionless namespace that is unbounded storage anyone can fill for the price of a blob fee.

What survives is the *fact* of the rejection, aggregated in `offer_rejections` as one row per `(celestia_height, code)` and surfaced on `GET /v1/health/sync` as `recent_rejections`. Aggregation is what makes that table safe to keep: its row count is bounded by heights × reject codes, never by the number of blobs posted — a million junk blobs in one block produce a single row with `count: 1000000`.

Step 5 of the ideal ladder — *reject offers below a minimum value* — is **not implemented**: it needs a price oracle. MIP-0006 suggests the natural floor is the offer's own publication cost. The derived legs are available at that point in the pipeline, so the hook slot exists.

### Manual submission (curl)

```bash
BLOB="swapoffer1..."

# Recommended: submit through the node (validates + forwards to batcher)
curl -s -X POST http://host:9999/v1/offers \
  -H "Content-Type: application/json" \
  -d "{\"blob\":\"$BLOB\"}" | jq .

# Advanced: submit directly to the batcher (skips liveness re-check)
curl -s -X POST http://host:3334/send-input \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "input": "'"$BLOB"'",
      "target": "midnight-balancer",
      "address": "mn1...",
      "addressType": 0
    },
    "confirmationLevel": "wait-receipt"
  }' | jq .

# Confirm the offer landed in the indexer (list is blob-free; note the offerId)
curl -s "http://host:9999/v1/offers?limit=5" | jq '.offers[0]'

# Fetch the full offer (with blob) by its content hash
curl -s "http://host:9999/v1/offers/$(curl -s 'http://host:9999/v1/offers?limit=1' | jq -r '.offers[0].offerId')" | jq .

# Stream lifecycle events while waiting for settlement
curl -N http://host:9999/v1/offers/stream
```

---

## Direct Celestia access (bypassing this backend)

Every offer is just a blob in one Celestia namespace, so you can post and read
the DA layer directly — the node/batcher are a convenience layer, not a
gatekeeper. Talk JSON-RPC 2.0 to the **same Celestia node** the stack uses
(`CELESTIA_RPC_URL`, default `http://127.0.0.1:26658`), with
`Authorization: Bearer $CELESTIA_AUTH_TOKEN` (omit the header on QuickNode —
auth is embedded in the URL).

**When to use which path:**

| | Via this backend | Directly on Celestia |
|---|---|---|
| **Post** | `POST /v1/offers` — validates structure + proofs + liveness **before** any fee | `blob.Submit` — you pay the TIA fee even for a bad blob; the indexer re-validates and drops it (emitting `offer_rejected`) |
| **Read** | `GET /v1/offers` — validated, indexed, liveness-checked, named | `blob.GetAll` — raw bytes; re-validate yourself with `@zswap-da/validator` |

Prefer the REST paths for apps. Reach for direct access for archival/mirroring,
independent verification, or posting without trusting an operator.

### Namespace

The offer namespace is `CELESTIA_NAMESPACE` (hex, default
`6d6e2d737761702d7631` = `mn-swap-v1`). Celestia's RPC wants it base64-encoded as a 29-byte
array — 1 version byte (`0x00`) + 28-byte ID, right-aligned:

```bash
# 6d6e2d737761702d7631 (mn-swap-v1) →
NS_B64="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN6tvu8="

# derive it for any namespace:
bun -e 'const h=process.argv[1].replace(/^0x/,"");const b=new Uint8Array(29);const x=(h.match(/.{1,2}/g)??[]).map(n=>parseInt(n,16));b.set(x,29-x.length);console.log(Buffer.from(b).toString("base64"))' 6d6e2d737761702d7631
```

### Post an offer — `blob.Submit`

The blob `data` is the `swapoffer1…` string, UTF-8 → base64. `share_version` is
`0`. The second param is the tx config (`fee` in utia, `gasLimit`); on mainnet
add `gas_price`/`max_gas_price` to skip the on-chain estimator (avoids 429s).

```bash
BLOB="swapoffer1..."
DATA_B64=$(printf %s "$BLOB" | base64 | tr -d '\n')

curl -s -X POST "$CELESTIA_RPC_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CELESTIA_AUTH_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"blob.Submit\",
       \"params\":[[{\"namespace\":\"$NS_B64\",\"data\":\"$DATA_B64\",\"share_version\":0}],
                   {\"fee\":2000,\"gasLimit\":100000}]}"
# → {"jsonrpc":"2.0","id":1,"result":1234567}   ← the inclusion height
```

The indexer sees this blob on its next Celestia poll and, if it validates, the
offer appears at `GET /v1/offers` and streams as `offer_indexed` on
`/v1/offers/stream` — no difference from an offer posted via the API, because it *is*
the same blob.

### Read offers — `blob.GetAll`

Fetch every namespace blob at a given height (params: `[height, [namespaceB64]]`):

```bash
HEIGHT=1234567
curl -s -X POST "$CELESTIA_RPC_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CELESTIA_AUTH_TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"blob.GetAll\",
       \"params\":[$HEIGHT,[\"$NS_B64\"]]}" \
| jq -r '.result[].data' | while read -r d; do echo "$d" | base64 -d; echo; done
#   ↑ each result[].data is base64 → decode to recover the swapoffer1… string
```

`blob.GetAll` returns `null` (not an error) for a height with no namespace blobs.
To scan a range, walk heights from your deployment block to the chain tip:

```bash
# current tip
curl -s -X POST "$CELESTIA_RPC_URL" -H "Authorization: Bearer $CELESTIA_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"header.NetworkHead","params":[]}' \
| jq -r '.result.header.height'
```

Reading raw blobs gives you **unvalidated** bytes — anyone can post to the
namespace. Re-run `validateZswapOffer` from `@zswap-da/validator` before trusting
one, exactly as the indexer does. And mind the retention window: Celestia prunes
blob data after ~7 days (see [Celestia data retention](README.md#celestia-data-retention-read-before-relying-on-history)),
so historical reads need an archival endpoint or a mirror, not a default node.
