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

-- DEMO / TEMPORARY: known_tokens is a manually curated convenience table for
-- this demo. The official Midnight token-metadata standard is not yet live.
-- Names and kinds stored here are unverified and MUST NOT be treated as
-- authoritative token information. This table and its API endpoints will be
-- replaced once the standard is finalised.
CREATE TABLE known_tokens (
    id SERIAL PRIMARY KEY,
    token_color TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('shielded', 'unshielded'))
);

INSERT INTO known_tokens (token_color, name, kind) VALUES
('0000000000000000000000000000000000000000000000000000000000000000', 'NIGHT', 'unshielded');
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
    -- NOT NULL because the keyset cursor depends on it and the failure mode of
    -- a NULL is silent: Postgres sorts NULLs FIRST under DESC, and the keyset
    -- comparison (NULL, id) < (x, y) evaluates to NULL — so such a row would
    -- sit at the top of page one and never paginate past, with no error
    -- anywhere. Same reasoning as archived_at.
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
CREATE INDEX idx_offer_file_created_at_id ON offer_file (created_at DESC, id DESC);

-- The cursor orders on first_seen_at, NOT created_at: created_at is DEFAULT
-- NOW(), so page order was a property of when THIS node inserted each row, and
-- two replicas served the same book in different orders. It was invisible to
-- the determinism replay by construction, since created_at is in
-- DIFF_EXCLUDED_COLUMNS. The index must exist before the query switches:
-- cursor-pagination.test.ts asserts the page plans without a Sort node.
CREATE INDEX idx_offer_file_first_seen_at_id
    ON offer_file (first_seen_at DESC, id DESC);

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
    -- Copied on archive, so the cursor stays valid when an offer moves tables
    -- mid-pagination. NOT NULL for the same reason as on the live table.
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
    -- the trade timestamp (at_ms) by GetTradeHistory and copied into
    -- pair_stats.last_traded_at.
    archived_at TIMESTAMPTZ NOT NULL
);

-- trade-data.ts HISTORY_SQL: WHERE archive_reason = 'CONSUMED' ORDER BY archived_at DESC LIMIT 120
CREATE INDEX idx_offer_file_history_reason_archived_at
    ON offer_file_history (archive_reason, archived_at DESC);

CREATE INDEX idx_offer_file_history_offer_hash
    ON offer_file_history (offer_hash);

-- NOT used by resolveOfferCursor, which probes history by offer_hash and never
-- orders it. Kept for the archived-offer queries that do order by
-- first_seen_at, and so the two tables stay symmetric; drop it if that never
-- materialises.
CREATE INDEX idx_offer_file_history_first_seen_at_id
    ON offer_file_history (first_seen_at DESC, id DESC);

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
-- The fill-marker match is "did tx T create a UTXO paying <owner, type, value>".
CREATE INDEX idx_unshielded_creates_marker
    ON unshielded_creates (tx_hash, owner, token_type, value);

-- The offer's OWN declared unshielded outputs — its fill markers, the
-- unshielded counterpart of offer_file_commitments. A settling transaction must
-- create every one of them; a maker walking away creates none.
--
-- Matched on (owner, token_type, value) rather than on the intent hash and
-- output index, because those belong to the SETTLING intent and the maker
-- cannot know them when publishing. Amounts are exact: the offer fixes what the
-- maker is owed, and merging preserves outputs verbatim.
--
-- `count` is load-bearing, not bookkeeping. Without it, N identical outputs
-- collapse into one row and the marker check degrades to existence: an offer
-- declaring 5 x 20-UB records wants=100 (deriveTokenLegs NETS the imbalance)
-- but stores a single marker (owner, UB, "20"), so a maker self-spend creating
-- ONE 20-UB output satisfies it and the offer classifies `consumed` — a
-- fabricated fill at 5x its real size, for 1/5 the cost. That is a full bypass
-- of the very check these tables exist to add, and it is attacker-chosen.
-- No DEFAULT: insertOfferFileUnshieldedOutput writes 1 explicitly and
-- increments on conflict, and the archive copies the value.
CREATE TABLE offer_file_unshielded_outputs (
    offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
    owner         TEXT    NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    count         INTEGER NOT NULL,
    PRIMARY KEY (offer_file_id, owner, token_type, value)
);

CREATE TABLE offer_file_unshielded_outputs_history (
    offer_file_id INTEGER NOT NULL,
    owner         TEXT    NOT NULL,
    token_type    TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    count         INTEGER NOT NULL,
    PRIMARY KEY (offer_file_id, owner, token_type, value)
);

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

CREATE TABLE token_prices (
    token_color TEXT PRIMARY KEY,
    price_usd   NUMERIC NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pair_stats (
    pair_key       TEXT PRIMARY KEY,   -- LEAST(a,b)||'|'||GREATEST(a,b)
    base_color     TEXT NOT NULL,
    quote_color    TEXT NOT NULL,
    trade_count    INTEGER NOT NULL DEFAULT 0,
    last_price     NUMERIC,
    last_traded_at TIMESTAMPTZ
);

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
