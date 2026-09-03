-- THE schema. One file, applied from zero.
--
-- This replaces the former 000..013 migration chain. That chain existed to
-- upgrade deployed databases; there are none, and there never were — this
-- system has not shipped. Fifteen incremental ALTERs describing a table that
-- has only ever been created once is not history, it is scaffolding, and it
-- was actively costing us: `ADD COLUMN … DEFAULT x` then `DROP DEFAULT`,
-- backfills for rows that cannot exist, and columns left nullable solely
-- because an ALTER could not tighten them on a populated table.
--
-- Rules for editing this file, so it does not grow a chain again:
--   * Change the schema HERE, in place. Do not add 001-*.sql.
--   * No `IF NOT EXISTS` and no `DEFAULT` cushions. This file runs against an
--     empty database exactly once; a second run failing loudly is correct, and
--     a default that exists "so an old writer still works" has no old writer.
--   * A column the logic depends on is NOT NULL. The failure mode of a
--     forgotten write must be an error, not a silent wrong answer — see
--     archived_at and first_seen_at below, both of which were bugs first.
--
-- Local-only additions go in local-migration.sql, which still runs after this.

-- ── Reference prices (assets) ─────────────────────────────────────────────
--
-- Declared here, ahead of known_tokens, only because known_tokens.asset_id
-- references it. The rest of the market-data tables (token_prices) are in the
-- "Market data" section further down, and this table's comment block is the
-- one place the whole pricing model is written out:
--
--   asset_prices   USD per COIN of a tradable asset, keyed by the CoinGecko
--                  id. USD is the numeraire: every price in this schema is a
--                  USD price and NO asset is assumed to be worth one dollar —
--                  the stablecoins are quoted like everything else, so a
--                  depeg is visible in quotes and in the sponsorship gate.
--                  Refreshed by the standalone `packages/price-feed` process.
--   known_tokens   maps a Midnight token colour to an asset_id (or, when NULL,
--                  is mapped by NAME through packages/database/price-map.ts)
--                  and carries the `decimals` needed to turn a per-coin price
--                  into the per-BASE-UNIT price the API serves.
--   token_prices   operator overrides (`manual`) and the deterministic demo
--                  rows (`fallback`) for tokens with no asset behind them.
--
-- source:
--   'seed'  the value shipped in this file — captured from CoinGecko on
--           2026-09-02 so a stack that never runs the price-feed service still
--           quotes real ratios. Overwritten by the service.
--   'feed'  written by packages/price-feed from CoinGecko.
--
-- There is no third source. Every asset in this table is fetched from the
-- provider; nothing is pinned to a constant.
--
-- Seed values, all captured 2026-09-02 from
--   GET /api/v3/simple/price?ids=<id>&vs_currencies=usd&include_last_updated_at=true
-- provider_updated_at is CoinGecko's own `last_updated_at` (unix seconds),
-- written through to_timestamp() so the epoch in the plan is the literal here
-- and no timezone is guessed:
--   bitcoin    77387       1788380750
--   ethereum   2393.28     1788380750
--   usd-coin   0.999818    1788380750
--   midnight-3 0.01918181  1788380780   (NIGHT — coingecko.com/en/coins/midnight-3)
--   usdm-2     1.001       1788388850   (Moneta's Cardano USDM, the asset the
--                                        VIA Labs bridge carries to Midnight —
--                                        coingecko.com/en/coins/usdm-2. Close
--                                        to a dollar, but NOT a $1 peg: it is
--                                        observed like every other asset.)
CREATE TABLE asset_prices (
    asset_id            TEXT PRIMARY KEY,
    price_usd           NUMERIC NOT NULL,
    source              TEXT NOT NULL CHECK (source IN ('seed', 'feed')),
    provider_updated_at TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO asset_prices (asset_id, price_usd, source, provider_updated_at) VALUES
('bitcoin',    77387,      'seed',  to_timestamp(1788380750)),
('ethereum',   2393.28,    'seed',  to_timestamp(1788380750)),
('usd-coin',   0.999818,   'seed',  to_timestamp(1788380750)),
('midnight-3', 0.01918181, 'seed',  to_timestamp(1788380780)),
('usdm-2',     1.001,      'seed',  to_timestamp(1788388850));

-- One row (id = 1), upserted by packages/price-feed after every cycle. Not
-- seeded: "the feed has never run here" and "the feed ran and told us nothing"
-- must be distinguishable, and an absent row is the honest spelling of the
-- first. GET /v1/prices reports all-null feed status when it is missing.
CREATE TABLE price_feed_status (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    provider    TEXT NOT NULL,
    last_run_at TIMESTAMPTZ,
    last_ok_at  TIMESTAMPTZ,
    last_error  TEXT
);

-- DEMO / TEMPORARY: known_tokens is a manually curated convenience table for
-- this demo. The official Midnight token-metadata standard is not yet live.
-- Names and kinds stored here are unverified and MUST NOT be treated as
-- authoritative token information. This table and its API endpoints will be
-- replaced once the standard is finalised.
--
-- decimals / asset_id carry a DEFAULT and a NULL respectively, which the
-- header's "no DEFAULT cushions" rule allows here because neither is a
-- compatibility shim for an old writer:
--   decimals DEFAULT 0 is the real semantic default of this registry — the
--     faucet mints 1000 base units = 1000 coins, so 0 (base unit == coin) is
--     what every token registered through POST /v1/known-tokens without an
--     explicit decimals genuinely has.
--   asset_id NULL means "no asset behind this colour" (test tokens), which is
--     a state the resolver handles explicitly, not a missing value.
CREATE TABLE known_tokens (
    id SERIAL PRIMARY KEY,
    token_color TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('shielded', 'unshielded')),
    -- Base units per coin, as a power of ten. The API serves prices PER BASE
    -- UNIT (amounts are integer base units everywhere and carry no metadata),
    -- so a token's price is asset_prices.price_usd / 10^decimals.
    decimals INTEGER NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 38),
    -- When set, wins over the name map in packages/database/price-map.ts.
    asset_id TEXT REFERENCES asset_prices(asset_id)
);

-- Faucet-minted colours (WBTC, WETH, TESTTOKEN*) are NOT seeded: they derive
-- from the deployed contract address and change on every clean redeploy, so
-- they are registered at runtime and priced BY NAME through price-map.ts.
-- Only these three survive a redeploy unchanged:
--   NIGHT — the native token, colour 0x00…00 on every network. **6 decimals**:
--           1 NIGHT = 10^6 Stars (its base unit) — STARS_PER_NIGHT in
--           midnight-ledger/ledger/src/structure.rs, confirmed in
--           NIGHT-shielded-vs-unshielded-FINDINGS.md ("1 NIGHT = 10⁶ atomic
--           units (Stars)"). This row was seeded at 0 before PR #54's own
--           follow-up fix: since `decimals` here means "base units per PRICED
--           coin" (not the display decimals of the colour itself), a 0 priced
--           one Star at NIGHT's whole-coin price of ~$0.019 — every quote and
--           sponsorship threshold touching NIGHT (and anything registered to
--           mirror it, e.g. sNight) was off by 10^6.
--   USDC  — a placeholder colour (64 x '1'). There is no USDC token on
--           preprod; the row exists so the pair is quotable at a real
--           reference price (Q-5). Kept at **6 decimals**, same as USDM
--           below: real USDC is 6 decimals on every chain it exists on, so a
--           future real USDC colour needs no decimals change, only a new row.
--   USDM  — the VIA Labs bridge's Midnight token type on *preview*
--           (bridge contract 471dfe55c866fdbc085c9011a51f0cd0e9c9bfca6bb985c35f7716b6e73e485c).
--           Mainnet is a different type:
--           8c2c22bc0c37fa999d0611cb5c570f587938ac5ffc8b0925143dad4c0764e94b
--           (contract 65023744190a4fc7c8ac9a3dfbc8cfc28f63d2aaa431ceda1d88fdb9a096a6a1).
--           Also a placeholder on preprod (no USDM there, Q-5), but kept
--           unshielded with 6 decimals — the bridge's real shape — so the row
--           needs no change if the bridge ever reaches this network. The
--           asset behind it is Moneta's Cardano USDM (`usdm-2`), the token
--           the bridge carries — priced from the provider, not pegged (Q-10).
--
-- Faucet-minted dev/test tokens (WBTC, WETH, TESTTOKEN*, …) are NOT touched by
-- this: they keep the table's DEFAULT of 0 (comment above) — the faucet mints
-- 1000 base units = 1000 coins, so 0 is genuinely correct for them.
INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES
('0000000000000000000000000000000000000000000000000000000000000000', 'NIGHT', 'unshielded', 6, 'midnight-3'),
('1111111111111111111111111111111111111111111111111111111111111111', 'USDC',  'shielded',   6, 'usd-coin'),
('003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73', 'USDM',  'unshielded', 6, 'usdm-2');
-- ('0000000000000000000000000000000000000000000000000000000000000001', 'SILK', 'shielded'),
-- ('0000000000000000000000000000000000000000000000000000000000000002', 'DUSK', 'shielded')

-- ── Live offers ───────────────────────────────────────────────────────────
--
-- No auth_signer_public_key / auth_signature / auth_scheme, and no
-- metadata_maker_note. MIP-0006 removed wrapper authentication as UNSOUND and
-- privacy-harming — the signature was over the wrapper, not bound to the
-- secret controlling the offer's coins, so anyone could strip and re-sign a
-- published offer, and a public signer key deanonymises the maker. Maker notes
-- are removed from the spec entirely: an unauthenticated note beside an offer
-- is a phishing surface, and the ledger Transaction has no field for an
-- authenticated one. Both were dropped rather than left unpopulated, because
-- an empty column invites someone to "finish" the feature.
CREATE TABLE offer_file (
    id SERIAL PRIMARY KEY,
    celestia_height BIGINT NOT NULL,
    transaction_hex TEXT NOT NULL,
    -- Content-addressed offer identity (the MIP-0006 `offerId`): hex sha256 of
    -- the offer's canonical bytes — the raw MIP-0005 `Transaction`
    -- serialization, bech32m-decoded. Unlike the SERIAL `id`, which is local
    -- bookkeeping and diverges across deployments (different filters,
    -- ingestion order, restarts), the hash is identical on every node that
    -- indexes the same offer, so it is the only identifier safe to expose for
    -- cross-system lookups. Computed in application code at ingestion (bech32m
    -- decode is not available in SQL). NOT NULL: every writer supplies it —
    -- the node computes it, out-of-band inserts such as seed-market.ts pass
    -- their own.
    offer_hash TEXT NOT NULL,
    metadata_created_at TIMESTAMPTZ,
    metadata_expires_at TIMESTAMPTZ,
    -- computed.firstSeenAt (MIP-0006): when the offer was first observable.
    -- Deterministic, computed once at ingestion:
    --   shielded  → the earliest first_seen_ms of the offer's proof roots (the
    --               moment its proof became provable on this chain)
    --   otherwise → the Celestia block timestamp (when it appeared on the DA
    --               layer; equals the NTP block time)
    -- Never wall-clock: two nodes replaying the same blocks must agree.
    -- Served as computed.firstSeenAt and nothing more — it is NOT the cursor
    -- key. It was, briefly, and that was a bug: for a shielded offer this
    -- derives from when THIS NODE first saw the proof root, so replicas with
    -- different sync starts disagree. A fine display value, a bad sort key.
    -- NOT NULL because every writer sets it and a missing chain-derived
    -- timestamp should fail loudly, not serve null to a client.
    first_seen_at TIMESTAMPTZ NOT NULL,
    -- TTL in seconds for how long this offer should remain active.
    -- Default = 1 hour (matches the Midnight reference Merkle-root window
    -- on the shielded path; see packages/node/env.ts for the full rationale).
    ttl_seconds BIGINT NOT NULL DEFAULT 3600,
    -- When THIS node inserted the row — a local observation, deliberately not
    -- chain-derived, and excluded from the determinism diff for that reason.
    -- Never sort or filter on it: see excluded-columns-are-write-only.test.ts.
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Uniqueness over open offers doubles as the MIP-0006 duplicate-rejection
-- gate: re-publishing byte-identical offer bytes must not index twice.
CREATE UNIQUE INDEX idx_offer_file_offer_hash ON offer_file (offer_hash);

-- Keyset (cursor) pagination for the offer book.
--
-- OFFSET pagination re-scans and discards every earlier row on each page, so
-- deep pages cost O(offset) — and the offset shifts whenever an offer is
-- indexed or archived mid-pagination, silently skipping or repeating rows.
-- The API instead resolves an opaque `after_hash` cursor to the anchor row's
-- key and seeks with a row-value comparison. `id` is the tie-break; it never
-- leaves the node, since the cursor is the offer_hash, resolved server-side.
-- Keyset pagination on the PUBLICATION tuple. Both parts are facts every
-- replica agrees on: celestia_height is the DA height the offer was published
-- at, offer_hash is the sha256 of its canonical bytes. Neither depends on sync
-- start, insertion order or SERIAL assignment.
--
-- Two earlier keys were wrong. `created_at` is DEFAULT NOW(), so page order was
-- decided by when THIS node inserted each row — and it is in
-- DIFF_EXCLUDED_COLUMNS, so the determinism replay could never catch it.
-- `first_seen_at` is chain-derived but, for a shielded offer, derives from when
-- THIS NODE first saw the proof root, so a replica with a different
-- MIDNIGHT_START_BLOCK orders differently; the determinism suite misses that
-- too, because both instances start at height 1 by construction.
--
-- The index must exist before the query switches: cursor-pagination.test.ts
-- asserts the page plans without a Sort node, so a missing index is a test
-- failure rather than a silent slow scan.
CREATE INDEX idx_offer_file_height_hash
    ON offer_file (celestia_height DESC, offer_hash DESC);

-- ── Offer legs ────────────────────────────────────────────────────────────
--
-- `kind` carries the MIP-0006 TokenLeg.type. The validator used to merge
-- derived legs by token color alone, NETTING the same color across value
-- layers — a give of shielded X against a want of unshielded X cancelled out,
-- misstating the offer's terms. The MIP is explicit that layers stay separate,
-- so the uniqueness tuple includes `kind`: the same color may appear on both
-- layers of the same side.
--
-- NOTE for the market queries: one offer may carry two rows for the same
-- (color, direction), one per layer. Queries pairing GIVING×WANTING rows must
-- aggregate by color first or they double-count such offers.
CREATE TABLE offer_file_tokens (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    token_color TEXT NOT NULL,
    amount TEXT NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('SHIELDED', 'UNSHIELDED')),
    UNIQUE (offer_file_id, token_color, direction, kind)
);

CREATE INDEX idx_offer_file_tokens_token_direction_offer
    ON offer_file_tokens (token_color, direction, offer_file_id);

CREATE INDEX idx_offer_file_tokens_offer_file_id
    ON offer_file_tokens (offer_file_id);

-- ── Offer input references ────────────────────────────────────────────────
--
-- A single shielded coin can back multiple competing offers (e.g. maker posts
-- A→NIGHT and A→USDC both spending the same coin). All such offers share the
-- same nullifier and are mutually exclusive — the first to land wins. So the
-- constraint is per-offer, not global.
CREATE TABLE offer_file_nullifiers (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    nullifier TEXT NOT NULL,
    UNIQUE (offer_file_id, nullifier)
);

CREATE INDEX idx_offer_file_nullifiers_nullifier
    ON offer_file_nullifiers (nullifier);

-- Same multi-offer rule as nullifiers: a single unshielded UTXO can be
-- referenced by multiple competing offers.
CREATE TABLE offer_file_unshielded_spends (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    output_no INTEGER NOT NULL,
    UNIQUE (offer_file_id, owner, intent_hash, output_no)
);

CREATE INDEX idx_offer_file_unshielded_spends_lookup
    ON offer_file_unshielded_spends (owner, intent_hash, output_no);

-- The offer's own shielded output commitments, read from the published blob at
-- ingestion (they are plaintext fields of the serialized outputs). These are
-- the fill markers: the offer tx fixes the maker's outputs and merging
-- preserves them, so a settling tx creates exactly these commitments on-chain
-- while a cancel (maker spending inputs elsewhere) creates none.
CREATE TABLE offer_file_commitments (
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    commitment    TEXT NOT NULL,
    PRIMARY KEY (offer_file_id, commitment)
);

-- The MARKER DEDUP probe (ruled 2026-08-18), and it must not lead with
-- offer_file_id. findActiveOfferByCommitment asks "does an ACTIVE offer already
-- claim this commitment", with no offer known in advance — the opposite
-- direction from the primary key above, which cannot serve it. Without this
-- index every accepted offer pays a sequential scan of the live book per
-- declared commitment, at BOTH doors.
--
-- Non-unique deliberately: it is the ingestion check that enforces uniqueness,
-- and a UNIQUE constraint here would turn a rejected duplicate into a failed
-- INSERT inside the block transaction — a crash where a reject code belongs.
CREATE INDEX idx_offer_file_commitments_commitment
    ON offer_file_commitments (commitment);

-- ── Archived offers ───────────────────────────────────────────────────────
--
-- Archival is destructive: the live row is DELETEd. If the consuming block is
-- later reorged out, the offer cannot be restored without a full resync. Only
-- safe when archive-triggering events come from finalized blocks.
CREATE TABLE offer_file_history (
    id INTEGER PRIMARY KEY,
    celestia_height BIGINT NOT NULL,
    transaction_hex TEXT NOT NULL,
    offer_hash TEXT NOT NULL,
    metadata_created_at TIMESTAMPTZ,
    metadata_expires_at TIMESTAMPTZ,
    -- Copied on archive so an archived offer still serves its firstSeenAt.
    -- (What keeps the CURSOR valid across archival is celestia_height +
    -- offer_hash, both also copied.) NOT NULL as on the live table.
    first_seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ,
    -- Copy of the TTL (in seconds) that was active for the original offer.
    ttl_seconds BIGINT,
    -- Why this offer left the live table:
    --   'CONSUMED' — one of the offer's inputs was spent on Midnight. Whether
    --     that was a fill or a cancel is decided at READ time by
    --     cancelledPredicate, from the spending tx and the offer's own fill
    --     markers; the archive itself cannot tell them apart.
    --   'TTL' — the scheduled cleanup timer fired before any consumption was
    --     observed. This does not mean the offer stayed fillable until then —
    --     see env.ts for the Merkle-root-window caveat on the shielded path.
    archive_reason TEXT,
    -- The L2 block timestamp of the archiving event (chain-derived, replica-
    -- deterministic) — NOT the wall clock of whichever node ran the archive.
    -- NOT NULL and no default on purpose: an INSERT that forgets this column
    -- must fail loudly rather than silently record node-local time. Served as
    -- the trade timestamp (at_ms) by GetTradeHistory and as the trade time on
    -- every market surface.
    archived_at TIMESTAMPTZ NOT NULL,

    -- ── The FILL VERDICT: adjudicated once, then never recomputed ──────────
    --
    -- Fill-vs-cancel used to be decided at READ time, by running
    -- cancelledPredicate over every archived offer on every market query. That
    -- is ~8 correlated subqueries per offer, and it was re-deriving answers
    -- that cannot change: every table the predicate reads (unshielded_spends,
    -- unshielded_creates, nullifiers, commitments) is an append-only permanent
    -- set, a UTXO is spent exactly once, and a declared identity can only be
    -- created by the transaction carrying its intent. An offer archived last
    -- week can never reclassify.
    --
    -- Measured cost of not exploiting that (PGlite, full derivation):
    -- 0.9 s at 500 archived offers, 13.8 s at 2 000, 170 s at 10 000 — the
    -- PER-OFFER cost itself climbing 2 ms -> 7 ms -> 17 ms. Neither the e2e
    -- (60 offers) nor the unit fixtures are large enough to show it.
    --
    -- So the verdict is written ONCE, when the post-commit gate releases the
    -- offer's lifecycle event — the first moment the evidence is guaranteed
    -- visible, and where the pair_stats increment used to run. Market queries
    -- then aggregate stored columns instead of re-adjudicating history.
    --
    -- NULL settled means NOT YET ADJUDICATED, and that is load-bearing: it is
    -- how a write lost to a crash or a transient error is found again
    -- (see findUnadjudicatedFills). An unadjudicated offer is absent from
    -- market data until repaired, never silently counted as a cancel.
    settled BOOLEAN,

    -- Set only when this fill is a PRICE OBSERVATION: settled, exactly one
    -- colour on each side (baskets are excluded by ruling 2026-08-10), and
    -- both amounts non-zero (a zero leg has no defined price). A settled
    -- basket is therefore `settled = true` with a NULL base_color — a real
    -- state, not a gap. base/quote are assigned by LEAST/GREATEST of the hex
    -- COLOUR, so price is always quote-per-base regardless of which side the
    -- maker took.
    base_color   TEXT,
    quote_color  TEXT,
    base_amount  NUMERIC,
    quote_amount NUMERIC
);

-- Market aggregates scan fills by pair, newest first.
CREATE INDEX idx_offer_file_history_pair_fills
    ON offer_file_history (base_color, quote_color, archived_at DESC)
    WHERE settled AND base_color IS NOT NULL;

-- The repair sweep, and the reason a lost adjudication is recoverable rather
-- than permanent drift: this finds exactly the offers still owed a verdict,
-- so the sweep costs O(missing) instead of O(history).
CREATE INDEX idx_offer_file_history_unadjudicated
    ON offer_file_history (id)
    WHERE archive_reason = 'CONSUMED' AND settled IS NULL;

-- trade-data.ts HISTORY_SQL: WHERE archive_reason = 'CONSUMED' ORDER BY archived_at DESC LIMIT 120
CREATE INDEX idx_offer_file_history_reason_archived_at
    ON offer_file_history (archive_reason, archived_at DESC);

CREATE INDEX idx_offer_file_history_offer_hash
    ON offer_file_history (offer_hash);

CREATE TABLE offer_file_tokens_history (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL,
    token_color TEXT NOT NULL,
    amount TEXT NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('SHIELDED', 'UNSHIELDED')),
    archived_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_offer_file_tokens_history_offer_file_id
    ON offer_file_tokens_history (offer_file_id);

CREATE TABLE offer_file_nullifiers_history (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL,
    nullifier TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE offer_file_unshielded_spends_history (
    id SERIAL PRIMARY KEY,
    offer_file_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    output_no INTEGER NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE offer_file_commitments_history (
    offer_file_id INTEGER NOT NULL,
    commitment    TEXT NOT NULL,
    PRIMARY KEY (offer_file_id, commitment)
);

-- ── Chain observations: permanent sets ────────────────────────────────────
--
-- Every shielded nullifier observed on Midnight, kept FOREVER — this set is
-- the double-spend record `isNullifierSpent` consults before indexing an
-- offer, and a spend never becomes un-spent, so completeness is the whole
-- point. Do NOT add a TTL: coin commitments stay in the Merkle tree after
-- being spent, so a maker can always build a valid, current-root proof for a
-- long-spent coin; the nullifier is the only thing that catches it.
--
-- offer_matched=true:  matched to one of our indexed offers.
-- offer_matched=false: not (yet) ours — either the early-arrival race
--   (Midnight event before the Celestia offer) or, far more often, unrelated
--   Midnight-wide activity. Both are load-bearing for the spent-check.
--
-- `tx_hash` is the SPENDING transaction, and it is the fill-vs-cancel
-- discriminator: settlement is ATOMIC, so a fill consumes ALL of an offer's
-- inputs in ONE transaction. Nullifiers spent across different txs, or only
-- partially spent, can never be a fill. Nullable because an event may arrive
-- without one, in which case classification stays conservative.
--
-- Retention across the sets, for contrast:
--   nullifiers         — shielded spends, permanent (here).
--   commitments        — shielded creations, permanent.
--   created_unshielded — unshielded live-set, self-trimming (spend deletes).
--   known_roots        — TTL-limited, because root validity really does expire.
CREATE TABLE nullifiers (
    nullifier     TEXT        PRIMARY KEY,
    height        BIGINT      NOT NULL,
    tx_hash       TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    offer_matched BOOLEAN     NOT NULL DEFAULT FALSE
);
-- No secondary index: `isNullifierSpent` and `findUnmatchedNullifier` are both
-- primary-key lookups. An index here would cost a write on every nullifier
-- insert — the highest-volume insert path in the system — and serve no read.

-- Zswap COMMITMENTS (coin creations). Commitments are the public leaves of the
-- zswap Merkle tree — exactly as public as nullifiers; only coin contents and
-- the commitment↔nullifier link are private. Permanent, mirroring `nullifiers`:
-- a commitment insertion is a chain fact, and both tables carry one 32-byte
-- hash per coin event.
CREATE TABLE commitments (
    commitment TEXT PRIMARY KEY,     -- 64-hex, globally unique for chain life
    tx_hash    TEXT,                 -- ledger tx hash that created the coin
    mt_index   TEXT,                 -- zswap Merkle-tree index (decimal u64)
    height     BIGINT NOT NULL
);
-- Classification looks up "commitments created by tx T".
CREATE INDEX idx_commitments_tx_hash ON commitments (tx_hash);

-- Every unshielded spend observed on chain, kept FOREVER for the same reason
-- `nullifiers` is: a spend never becomes un-spent, and this is the record
-- read-time classification consults. Distinct from `created_unshielded`, which
-- is a LIVE-set that deletes on spend and answers a different question ("can
-- this offer still settle"). Classification needs the opposite — what was
-- consumed, and by which transaction.
--
-- Before this table existed, every consumption of an unshielded-only offer
-- classified `consumed`, because nothing recorded WHICH transaction spent an
-- unshielded UTXO. All three branches of cancelledPredicate were dead on that
-- layer — not merely inaccurate, unable to fire at all. A maker who spent
-- their own UTXO on themselves was recorded as a completed sale, moving chart
-- history, volume, last_price and trade_count for the cost of a self-transfer.
--
-- No new capability was needed: the midnight-unshielded-{spend,create}
-- primitives already deliver txHash, value and tokenType; the state machine was
-- discarding them.
CREATE TABLE unshielded_spends (
    owner       TEXT    NOT NULL,
    intent_hash TEXT    NOT NULL,
    output_no   INTEGER NOT NULL,
    tx_hash     TEXT,                -- the SPENDING transaction — the discriminator
    height      BIGINT  NOT NULL,
    PRIMARY KEY (owner, intent_hash, output_no)
);
-- No secondary index on tx_hash: no query looks spends up that way (the
-- predicate always joins on the PK triple), and this is one of the highest-
-- volume insert paths in the system. Same argument as `nullifiers`.

-- Every unshielded UTXO created on chain, kept forever — the unshielded
-- analogue of `commitments`. `created_unshielded` cannot serve this purpose: it
-- deletes the row when the UTXO is later spent, which would retroactively erase
-- the evidence that a settlement happened and silently reclassify a historical
-- fill as a cancel.
CREATE TABLE unshielded_creates (
    owner       TEXT    NOT NULL,
    intent_hash TEXT    NOT NULL,
    output_no   INTEGER NOT NULL,
    tx_hash     TEXT,                -- the CREATING transaction
    token_type  TEXT    NOT NULL,    -- hex serialized token type
    value       TEXT    NOT NULL,    -- u128 as decimal string
    height      BIGINT  NOT NULL,
    PRIMARY KEY (owner, intent_hash, output_no)
);
-- DROPPED 2026-08-18. The fill-marker match is the exact primary key above
-- (owner, intent_hash, output_no), so branch 3 of unshieldedCancelledPredicate
-- is a PK probe. idx_unshielded_creates_marker indexed
-- (tx_hash, owner, token_type, value) for the superseded SHAPE grouping and no
-- query has read it since Phase (d); it was kept only as a rollback cushion for
-- the read-path change. Phase (d) ships in the same PR that closes this
-- project, so the cushion is a retro-compatibility shim with nothing to roll
-- back to — and nothing is deployed. Removed rather than carried: every insert
-- into unshielded_creates was maintaining it for no reader.

-- The offer's OWN declared unshielded outputs — its fill markers, the
-- unshielded counterpart of offer_file_commitments. A settling transaction must
-- create every one of them; a maker walking away creates none.
--
-- Exact identity is (owner, intent_hash, output_no), precomputed from the
-- published intent exactly as the ledger will stamp it. The segment rule is
-- asymmetric: guaranteed outputs use intentHash(0), while fallible outputs use
-- intentHash(the intent map's physical segment key). Transaction.merge
-- preserves those map keys, so both are knowable at ingestion.
--
-- token_type and value are deliberately retained for display and audit even
-- though they are not identity. `count` remains load-bearing for a repeated
-- declaration of the exact same identity and lets the pre-Phase-(d) shape
-- predicate preserve multiplicity by summing across exact-identity rows.
-- No DEFAULT: insertOfferFileUnshieldedOutput writes 1 explicitly and
-- increments only when the full identity conflicts.
CREATE TABLE offer_file_unshielded_outputs (
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    owner         TEXT    NOT NULL,
    intent_hash   TEXT    NOT NULL,
    output_no     INTEGER NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    count         INTEGER NOT NULL,
    PRIMARY KEY (offer_file_id, owner, intent_hash, output_no)
);

-- The unshielded half of the MARKER DEDUP probe, same argument as
-- idx_offer_file_commitments_commitment: findActiveOfferByUnshieldedOutput
-- looks the live book up BY IDENTITY, and the primary key above leads with
-- offer_file_id, so it cannot serve that direction.
CREATE INDEX idx_offer_file_unshielded_outputs_identity
    ON offer_file_unshielded_outputs (owner, intent_hash, output_no);

CREATE TABLE offer_file_unshielded_outputs_history (
    offer_file_id INTEGER NOT NULL,
    owner         TEXT    NOT NULL,
    intent_hash   TEXT    NOT NULL,
    output_no     INTEGER NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    count         INTEGER NOT NULL,
    PRIMARY KEY (offer_file_id, owner, intent_hash, output_no)
);
-- DROPPED 2026-08-18 with supersededByDuplicatePredicate, the only reader of
-- this direction on the HISTORY table. It indexed
-- (owner, intent_hash, output_no) so the projection-side duplicate collapse
-- could ask "does ANOTHER archived offer declare this identity" without a scan
-- (measured before it existed: a pair-stats derivation took 0.9 s at 500
-- archived offers, 13.8 s at 2 000 and 461 s at 10 000). Marker dedup moved
-- that question to INGESTION, where it is asked of the LIVE tables instead —
-- see idx_offer_file_unshielded_outputs_identity above. Branch 3 of
-- unshieldedCancelledPredicate reads this table by offer_file_id, which the
-- primary key already serves.

-- cancelledPredicate correlates on offer_file_id five times per candidate row,
-- and these history tables otherwise carry only a SERIAL primary key.
CREATE INDEX idx_offer_file_unshielded_spends_history_offer
    ON offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no);
CREATE INDEX idx_offer_file_nullifiers_history_offer
    ON offer_file_nullifiers_history (offer_file_id, nullifier);

-- ── Chain observations: liveness sets ─────────────────────────────────────
--
-- Every unshielded UTXO ever created on chain (regular AND system
-- transactions). Append-only, kept from genesis — an old UTXO stays spendable
-- forever, so this set must never be pruned. An offer referencing a triple
-- absent here references a UTXO the chain never created.
CREATE TABLE created_unshielded (
    owner TEXT NOT NULL,
    intent_hash TEXT NOT NULL,
    output_no INTEGER NOT NULL,
    height BIGINT NOT NULL,
    -- Local observation, like offer_file.created_at: excluded from the
    -- determinism diff, never read for logic.
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (owner, intent_hash, output_no)
);

-- The coin-commitment Merkle tree roots the chain has held, mirroring the
-- ledger's `past_roots`. Pruned to the configured root window (the chain only
-- accepts proofs against roots inside that window), so it is a rolling set. An
-- offer whose input proves against a root absent here cannot settle
-- (fabricated or aged-out root).
--
-- `first_seen_ms` is the deterministic basis for a shielded offer's expiry
-- (MIP-0006 expiresAt) and firstSeenAt: the window opens when the chain FIRST
-- accepted the root. `last_seen_ms` is the WRONG basis for expiry — it
-- advances every time the root is re-accepted on a quiet chain, so an expiry
-- computed from it drifts later on each re-upsert, which is non-deterministic
-- across nodes that re-synced at different times. Set once on first insert and
-- never moved (see the ON CONFLICT in UpsertKnownRootWithFirstSeen).
CREATE TABLE known_roots (
    root TEXT PRIMARY KEY,
    height BIGINT NOT NULL,
    last_seen_ms BIGINT NOT NULL,
    first_seen_ms BIGINT NOT NULL
);

-- PruneKnownRoots runs every ~6 s (once per Midnight block) with:
--   DELETE WHERE last_seen_ms < :cutoff AND height < (SELECT MAX(height) ...)
-- Default window is 14 days at 1 root/6 s = ~201 600 rows — must be indexed.
CREATE INDEX idx_known_roots_last_seen_ms ON known_roots (last_seen_ms);
CREATE INDEX idx_known_roots_height       ON known_roots (height);

-- ── Market data ───────────────────────────────────────────────────────────

-- Per-token USD price PER BASE UNIT, for the two cases asset_prices cannot
-- cover. This table is no longer the primary price source — see the
-- asset_prices comment block above for the full model.
--
--   'manual'   an operator's override. Wins over everything, and NOTHING ever
--              rewrites it: not the price-feed service (which only touches
--              asset_prices), not the quote path. Delete the row to go back to
--              the asset price.
--   'fallback' the deterministic demo price (priceOf() in
--              packages/node/market-mock.ts), written once on the first quote
--              of a registered token with no asset behind it — the test
--              tokens. It is NOT a market price and every API surface labels
--              it as such; the sponsorship gate treats it as UNPRICED.
--
-- DEFAULT 'fallback' is not a compatibility cushion: the only writer that
-- omits the column is that first-quote insert, and 'fallback' is what it
-- means. A manual row is written by hand, with the column stated.
CREATE TABLE token_prices (
    token_color TEXT PRIMARY KEY,
    price_usd   NUMERIC NOT NULL,
    source      TEXT NOT NULL DEFAULT 'fallback' CHECK (source IN ('manual', 'fallback')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- pair_stats is GONE, deliberately.
--
-- It was a write-side projection incremented once per archived offer, and it
-- could not agree with the read side by construction: two implementations of
-- "is this a fill" that drifted independently. Measured on a live chain — five
-- settlement transactions left trade_count = 7, while the read-side aggregate
-- over the same data disagreed with BOTH numbers. It also had no way back: the
-- increment was not idempotent, so a lost event was permanent drift.
--
-- With the verdict stored on offer_file_history, the aggregate is a GROUP BY
-- over indexed columns and needs no materialisation at all. One adjudication,
-- one source, nothing to reconcile — see getPairs / getPairStats24h.

-- ── Operations ────────────────────────────────────────────────────────────
--
-- Rejection counters for blobs discarded at Celestia ingestion.
--
-- The blob bodies themselves are DELETEd from effectstream.primitive_accounting
-- when the STM rejects them: they are attacker-controlled bytes we have decided
-- to discard, and the namespace is permissionless, so keeping them is unbounded
-- storage anyone can fill for the price of a blob fee.
--
-- Deleting outright would leave operators blind to "is someone spamming us, and
-- with what?", so the fact of each rejection is aggregated here instead.
-- Aggregation is what makes this safe to keep: the row count is bounded by
-- (heights that had a rejection) × (distinct reject codes), NOT by the number
-- of blobs posted. An attacker publishing a million junk blobs in one block
-- produces exactly one row.
--
-- Deterministic: counts are a pure function of the blobs in each Celestia
-- block, so a replay from genesis rebuilds them identically. No wall-clock
-- timestamps for that reason — `celestia_height` already says when.
CREATE TABLE offer_rejections (
    celestia_height BIGINT NOT NULL,
    code            TEXT   NOT NULL,
    count           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (celestia_height, code)
);

-- "What is being rejected lately?" — the ops question this table answers.
CREATE INDEX idx_offer_rejections_height
    ON offer_rejections (celestia_height DESC);
