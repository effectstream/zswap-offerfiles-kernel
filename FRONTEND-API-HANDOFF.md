# ZSwap-DA API — Frontend Migration Handoff

**Audience:** the agent updating the separate frontend repo.
**Status of this doc:** generated 2026-07-31 from the actual route handlers on the
current PR chain (#7–#18). Every response shape below was read from the code, not
from memory. The backend will be **redeployed from zero** with these changes — there
is no compatibility window and no legacy fallback: the old API simply stops existing.

Base URL: `http://<host>:9999`. All offer-related endpoints moved from `/api/*` to
`/v1/*`. Rate limit: **60 requests/min per IP** across all routes → HTTP 429
`{ "error": "RATE_LIMITED", "reason": "..." }`. On 429, back off; do not retry-loop.

---

## 1. The two breaking ideas (read this first)

### 1.1 Offers are content-addressed

Numeric `id` is gone from the wire. An offer's identity is its **`offerId`**:
lowercase-hex SHA-256 of the offer's **raw transaction bytes** (not of the
`swapoffer1…` string). It is identical across every node that indexes the same
offer, so it is safe to use in URLs, dedup keys, and React keys.
If you have a blob and need its id client-side:
`sha256(bech32m-decode(blob))` — or `OfferFiles.offerId(bytes)` from
`@effectstream/mip-zswap-offer` **v0.3.0** (on npm). The same package's
`OffchainOfferPayload` type matches these response shapes exactly.

### 1.2 The list is blob-free; the payload is MIP-0006 shaped

A real offer blob is 16–25 KB of bech32m. The list endpoint **never** returns it.
Rendering the book needs only the list; the blob is fetched per offer, by id,
only when the user acts (take/settle/copy).

All offer responses are now the MIP-0006 `OffchainOfferPayload` shape — camelCase,
with the derived fields under a `computed` wrapper (they are computed by the
indexer from the transaction itself; nothing in `computed` is maker-supplied).

---

## 2. Old → new mapping (mechanical changes)

| Old | New |
|---|---|
| `GET /api/zswaps` | `GET /v1/offers` |
| `GET /api/zswaps/:id` (numeric) | `GET /v1/offers/:offerId` (64-hex) |
| `GET /api/zswap-status?blob=…` | `POST /v1/offers/status` body `{ "offer": "swapoffer1…" }` |
| `POST /api/zswap` body `{ blob }` | `POST /v1/offers` body `{ "offer": "swapoffer1…" }` |
| `GET /api/known-tokens` | `GET /v1/known-tokens` |
| `GET /api/quote`, `/api/pairs`, `/api/chart/*` | same under `/v1/…` |
| `GET /api/midnight/config` | `GET /v1/midnight/config` |
| `GET /api/events` (SSE) | `GET /v1/offers/stream` |
| `GET /api/health/sync` | `GET /v1/health/sync` |
| status `"open"` | status `"live"` |
| status `"completed"` | status `"consumed"` |
| field `offer_hash` | `offerId` |
| field `blob` / `transaction_hex` | `offerBech32` |
| field `next_cursor` | `nextCursor` |
| field `blob_chars` | `blobChars` |
| field `celestia_height` | `blockHeight` (Effectstream L2 height; not a Celestia height) |
| leg field `kind` | `type` (values unchanged: `SHIELDED` \| `UNSHIELDED`) |
| top-level `gives`/`wants` | `computed.gives` / `computed.wants` |
| `metadata_expires_at` | `computed.expiresAt` |
| numeric `id` anywhere | gone — use `offerId` |

Statuses: `live | consumed | cancelled | expired | unknown | not_found`.
`consumed` = a fill verified by the offer's stored output commitments.
`cancelled` = inputs spent across transactions / partially, or a one-transaction
spend that is proven to be missing at least one stored marker. `unknown` = archived
without enough complete transaction-bound proof (including markerless rows and offers with unshielded inputs)
to distinguish a fill from a maker cancellation; never show it as a successful
fill. All three are off the book.

---

## 3. Offer endpoints (the new shapes, exactly)

### `GET /v1/offers` — the book

Query params (all optional): `limit` (default & max 100), `token` (64-hex color),
`direction` (`GIVING` | `WANTING`, filters which side `token` matched),
`after_hash` (pagination cursor — note: query params are snake_case; only
**response bodies** went camelCase).

```json
{
  "offers": [
    {
      "version": 1,
      "offerId": "9f2c4a…64 hex…e1",
      "blobChars": 24781,
      "blockHeight": "12231800",
      "computed": {
        "gives": [ { "token": "0000…0000", "amount": "1000000", "type": "UNSHIELDED" } ],
        "wants": [ { "token": "70ce…b569", "amount": "500000", "type": "SHIELDED" } ],
        "expiresAt": "2026-06-01T13:00:00.000Z",
        "inputNullifiers": ["7c1d9b…"],
        "firstSeenAt": "2026-06-01T12:00:00.000Z",
        "status": "live"
      }
    }
  ],
  "nextCursor": "9f2c4a…"
}
```

- **`offerBech32` is intentionally absent here.** Do not look for it; fetch per
  offer via the detail endpoint. `blobChars` tells you the size of that fetch.
- `amount` values are **strings** (bigint-safe). Never `Number()` them for math;
  fine for display via `BigInt(amount)`.
- `token` is a 64-hex color. Resolve display names via `/v1/known-tokens`; render
  unknown colors as truncated hex, never hide them.
- Legs are **layer-tagged** (`type`). Two legs of the same token but different
  `type` are different assets for netting purposes — never merge them.
- `expiresAt` is the earliest applicable constraint: proof-root
  last-seen + root window and earliest Intent TTL are both considered for mixed
  transactions; publication TTL is used only if neither exists. The root-derived
  value is deliberately conservative because the chain can refresh a current
  root after ingestion, but the indexer archives at its persisted cutoff. Treat
  the REST status as authoritative and refetch when a countdown reaches zero.
- Pagination loop: request with `after_hash=<previous nextCursor>` until
  `nextCursor` is `null`. A full page can be the last one — the next request then
  returns `{ "offers": [], "nextCursor": null }`. A fabricated/stale cursor gets
  HTTP 400 `INVALID_CURSOR` → restart from page one, don't loop.
- Ordering: newest first, stable under concurrent inserts/archives (keyset, not
  offset — no skipped or repeated rows mid-pagination).

### `GET /v1/offers/:offerId` — full offer (the only place the blob lives)

`:offerId` must be 64 lowercase hex chars, else 400 `INVALID_HASH`.
Unknown id → 404 `{ "error": "NOT_FOUND", "offerId": "…" }`.

Same payload as a list row, plus — guaranteed present — the blob, and it also
resolves **archived** offers (with their terminal status):

```json
{
  "version": 1,
  "offerId": "9f2c4a…",
  "offerBech32": "swapoffer1q…(16–25 KB)",
  "blockHeight": "12231800",
  "ttlSeconds": "3600",
  "computed": {
    "gives": [ … ], "wants": [ … ],
    "expiresAt": "…", "inputNullifiers": [ "…" ],
    "firstSeenAt": "…",
    "status": "live"
  }
}
```

### `GET /v1/offers/:offerId/status` — cheap poll

```json
{ "offerId": "9f2c4a…", "status": "live" }
```
`unknown` = archived but not safely classifiable as a fill or cancellation.
`not_found` (in the 200 body) = never indexed under that id.

### `POST /v1/offers/status` — status when you only have a blob

Body `{ "offer": "swapoffer1…" }` →
`{ "offerId": "…", "status": "…" }`, or `{ "status": "not_found" }` (no `offerId`)
when the blob doesn't even decode. Batch variant for reconciling a "My Trades"
list on startup: `{ "offers": ["swapoffer1…", …] }` (max 50) →
`{ "statuses": [ … ] }` in input order. Prefer the GET variant whenever you already
know the id — this one exists for pasted blobs.

### `POST /v1/offers` — publish (maker flow)

Body: `{ "offer": "swapoffer1…" }`.

Success (200): `{ "success": true, "offerId": "9f2c4a…", "result": … }`.
**Ignore `result`** (internal batcher receipt, shape not stable). Store `offerId`;
the offer appears in `GET /v1/offers` only after the Celestia round-trip
(seconds to ~a minute) — poll `GET /v1/offers/:offerId/status` until it leaves
`not_found`, or watch the SSE stream.

Errors — all bodies are `{ "error": CODE, "reason": "human text", …extras }`:

| HTTP | `error` | Meaning / UI treatment |
|---|---|---|
| 409 | `DUPLICATE_OFFER` | Already indexed; body has `offerId` + current `status`. Not a failure — link the user to the existing offer. |
| 409 | `DUPLICATE_MARKERS` | **NEW, breaking (2026-08-18).** A LIVE offer already declares one of this offer's outputs — i.e. this is the same intent, re-wrapped or re-proved. Body has `offerId` (this blob) + `activeOfferId` (the live offer that owns the marker). Treat it exactly like `DUPLICATE_OFFER`: not a failure, link the user to `activeOfferId`. Do NOT auto-retry — a re-proof produces different bytes and the same markers, so it is refused again. The user's existing offer is untouched and still fillable; to change terms they cancel it first. |
| 400 | `BAD_ENCODING`, `BAD_DESERIALIZE` | Not a valid `swapoffer1…` blob. |
| 400 | `TOO_LARGE` | Decoded blob over the size cap. |
| 400 | `NOT_A_SWAP`, `NO_SPENDABLE_INPUT` | Valid tx, but not a takeable offer. |
| 400 | `CROSS_LAYER` | The offer mixes shielded and unshielded legs. Unfillable by construction — no shielded↔unshielded settlement path exists. Terminal; the user must rebuild both legs on one layer. |
| 400 | `NULLIFIER_SPENT`, `UTXO_NOT_LIVE` | An input coin is already spent/unknown — the offer can never settle. Terminal; don't offer retry. (`UTXO_SPENT` and `UTXO_UNKNOWN` are library-level distinctions folded into `UTXO_NOT_LIVE` by this route.) |
| 400 | `ROOT_UNKNOWN` | The wallet proved against a Merkle root this node hasn't synced. Body includes `hint` + `diagnostics` (node's indexer URI vs the wallet's). **Show `hint` verbatim** — it names the exact Lace misconfiguration. Retrying the same blob will not help. |
| 400 | `VALIDATION` | Malformed request body. |
| 429 | `RATE_LIMITED` | Back off. |

For completeness, the validator union is: `BAD_ENCODING`, `TOO_LARGE`,
`BAD_DESERIALIZE`, `WRONG_TX_VARIANT`, `NO_SPENDABLE_INPUT`, `NOT_A_SWAP`,
`CROSS_LAYER`, `UNKNOWN_TOKEN`, `PROOF_INVALID`, `SIGNATURE_INVALID`,
`NULLIFIER_SPENT`, `UTXO_SPENT`, `UTXO_UNKNOWN`, `ROOT_UNKNOWN`,
`ROOT_UNREADABLE`, `DUPLICATE`. `WRONG_TX_VARIANT` is reserved;
`UNKNOWN_TOKEN` and `ROOT_UNREADABLE` are fail-closed guards not reachable from
today's wire format; callback-only `UTXO_*`/`DUPLICATE` values map to the
public codes described above. `DUPLICATE_MARKERS` is deliberately NOT in that
union: it is an API/STM gate code like `DUPLICATE_OFFER` and `UTXO_NOT_LIVE`,
because the rule reads the live book rather than the blob.

**Basket offers are accepted but carry no market data.** An offer with more than
one token color on a side (give A+B, want C+D) is a sealed pre-agreed
settlement, not a price: nobody agreed what A alone is worth in C. It is
indexed, listed on `GET /v1/offers`, and settles normally — but it contributes
nothing to `/v1/pairs` (no row, no `open_count`), `/v1/chart/history` or
`/v1/chart/stats`. Don't build a market list expecting every open offer to
appear as a pair.

### `GET /v1/offers/stream` — SSE

`data:`-only frames (no `event:` field — dispatch on `data.type`), comment
heartbeat every 30 s, every frame carries `timestamp` (ms). Events:

```
{ "type": "connected", "timestamp": … }                     // on open
{ "type": "offer_indexed",  "offerId": <number>, "offerHash": "…", "blockHeight": …, "gives": […], "wants": […] }
{ "type": "offer_consumed", "offerId": <number>, "offerHash": "…", "nullifier": "…" }
{ "type": "offer_expired",  "offerId": <number>, "offerHash": "…" }
{ "type": "offer_rejected", "code": "…", "reason": "…", "offerHash": "…", "blockHeight": … }
{ "type": "token_minted",   "name": "…", "color": "…", "kind": "shielded|unshielded" }
```

The node caps concurrent streams (default 100). Capacity exhaustion returns
`503 SSE_CAPACITY` plus `Retry-After: 5`; a slow consumer is disconnected when
its response buffer applies backpressure. Reconnect with backoff and refetch
`GET /v1/offers` after every reconnect because SSE has no replay cursor.

⚠️ Known wart: in SSE events `offerId` is still the **internal numeric row id**,
not the content hash — the hash is in `offerHash`. Correlate SSE ↔ REST via
`offerHash` only. Simplest robust strategy: treat any `offer_*` event as a
"refetch the book" signal rather than patching state from event fields. The hash
can be absent only for legacy rows or a rejection too malformed to hash.

---

## 4. Unchanged-shape endpoints (still snake_case — deliberate, for now)

These serve DB/registry rows and did **not** get the camelCase treatment. Take
their shapes as-is; don't "fix" the casing client-side beyond your own mapping:

- `GET /v1/known-tokens` → `[{ "id": 1, "token_color": "70ce…", "name": "tDUST", "kind": "shielded" }]`
- `GET /v1/pairs` → `[{ "pair_key": "…", "base_color": "…", "quote_color": "…", "trade_count": 3, "last_price": "2.0", "last_traded_at": "…", "open_count": 1 }]`
- `GET /v1/quote?from_token=…&to_token=…&from_amount=…[&to_amount=…]` →
  `{ "from_token", "to_token", "from_amount", "market_rate", "suggested_to_amount", "to_amount", "implied_rate", "discount", "sponsored", "from_usd", "to_usd", "source" }`.
  Tokens must be distinct 64-hex colors (no `0x`). Amounts are canonical decimal
  u256 strings: `from_amount` is positive; neither amount accepts signs, leading
  zeroes, separators, decimals, or exponents. Invalid input is `400 VALIDATION`
  and is never sanitized into a different amount.
  `source` is `"token-prices"` or `"demo-fallback"`. This is market data, not a
  reservation/executable quote.
  Unregistered colors do NOT error: they quote at a $1 demo fallback (two unknowns ⇒ 1:1). Don't render fallback quotes as real market prices — check the token against `/v1/known-tokens` if the UI needs to distinguish.
- `GET /v1/chart/stats?base=…&quote=…` → `{ "base", "quote", "last", "change24", "high", "low", "volume_base", "volume_quote" }` (numbers; `change24` in %).
- `GET /v1/chart/history?base=…&quote=…` → newest-first `[{ "price": n, "amt": n, "up": bool, "at": ms }]`. Derived **only from genuine fills** (consumed, not cancelled) — expect it to be sparser than the old data if the old one counted cancels.
- `GET /v1/midnight/config` → `{ "contractAddress", "indexerUri", "indexerWsUri", "proofServerUri", "networkId" }` (already camelCase).
- `GET /v1/health` → `{ "status": "ok|syncing|error", "synced": bool }`, aggregate
  protocol readiness across NTP, Midnight, and Celestia. `GET /v1/health/sync`
  returns the same overall status plus per-chain positions/lag and set diagnostics.
  Gate "the book is current" UI on `synced` or either endpoint's `status === "ok"`.
- `POST /v1/known-tokens` `{ color, name, kind }` — **dev/e2e only**; disabled in
  production (`ENABLE_TOKEN_REGISTRY=false`) → don't build UI that requires it.

ZK assets (`/keys/*`, `/zkir/*`) and the batcher endpoints (`:3334`) are unchanged.

---

## 5. Working reference implementations (in this repo)

Aligned with everything above and safe to copy from:

- `docs/src/api.ts` — typed client for every endpoint (the `Offer`/`OfferDetail`
  types match this doc exactly).
- `docs/src/panels/Accept.tsx` — book table + click-to-fetch-blob pattern.
- `api-examples/03-offers.ts` — list → status → detail walk.
- `api-examples/11-settle-offer.ts` — full taker flow (pick from book → fetch blob
  by id → balance → settle via batcher → poll status to `consumed`).
- `packages/node/api.test.ts` — executable spec of every shape and error.

Definitive prose reference: `API.md` at the repo root.
