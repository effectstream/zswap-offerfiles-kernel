-- Keyset pagination on a CHAIN-derived key.
--
-- The cursor ordered on `offer_file.created_at`, which is `DEFAULT NOW()` —
-- node-local wall clock. That made the live book's page order a property of
-- when THIS node happened to insert each row, so two replicas serving the same
-- book returned different orders, and a client failing over mid-pagination got
-- exactly the skips and repeats the keyset cursor exists to prevent.
--
-- Worse, it was invisible to our strongest check. `created_at` is in
-- DIFF_EXCLUDED_COLUMNS — legitimately, since "when did I first see this" is a
-- local fact two correct replicas disagree on — so the determinism replay could
-- never catch a divergence here by construction.
--
-- `first_seen_at` is chain-derived (migration 012: the earliest proof-root
-- first-seen for shielded offers, the Celestia block time otherwise) and is NOT
-- excluded from the diff, so replicas are held to it.
--
-- SCOPE OF THAT GUARANTEE, stated precisely: it holds for nodes that replay the
-- SAME block range. For a shielded offer the value comes from
-- known_roots.first_seen_ms, which is the block in which THIS NODE first
-- observed the root — so a replica started at a later MIDNIGHT_START_BLOCK
-- records a later value and orders the book differently. The determinism suite
-- cannot see this: main.grand-b.ts uses startBlockHeight 1 on every primitive,
-- identical to dev, so both instances agree by construction. Pin the sync start
-- as a cluster invariant, or move the key to metadata_created_at (the Celestia
-- block time, which has no such dependency) — but that column is nullable and
-- would need the same tightening this migration applies here.
--
-- `id` as tiebreaker: SERIAL assignment is order-preserving under deterministic
-- ingestion, and the cursor never leaves the node that issued it, so only the
-- RELATIVE order of tied rows must agree. Note PR-H makes ties common where
-- they were near-impossible: every shielded offer proving against the same root
-- now shares a byte-identical timestamp. 005-offer-hash.sql calls `id` "local
-- bookkeeping"; both are true — it is local, and locally order-preserving.
--
-- The index must exist before the query switches: cursor-pagination.test.ts
-- asserts the page query plans without a Sort node, so a missing index is a
-- test failure rather than a silent slow scan.
-- NOT NULL because the cursor now depends on it, and the failure mode of a
-- NULL is silent: Postgres sorts NULLs FIRST under DESC, and the keyset
-- comparison (NULL, id) < (x, y) evaluates to NULL — so such a row would sit at
-- the top of page one and never paginate past, with no error anywhere. Same
-- reasoning as archived_at in 000-init: a column the logic depends on must fail
-- loudly when a write forgets it.
--
-- Backfilled first, mirroring 011-root-first-seen.sql: migration 012 added the
-- column nullable with no backfill, so any row indexed before it holds NULL and
-- SET NOT NULL would abort. None on a from-zero deploy; correct-enough for dev
-- DBs, and the alternative is a migration that cannot be applied to one.
--
-- NOTE the earlier claim that "every insert sets it" was too strong:
-- insertOfferFileWithHash is not the only writer — packages/tests/seed-market.ts
-- inserts directly, and did NOT set it until this change.
UPDATE offer_file
   SET first_seen_at = COALESCE(metadata_created_at, created_at, NOW())
 WHERE first_seen_at IS NULL;
UPDATE offer_file_history
   SET first_seen_at = COALESCE(metadata_created_at, created_at, archived_at)
 WHERE first_seen_at IS NULL;

ALTER TABLE offer_file         ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE offer_file_history ALTER COLUMN first_seen_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offer_file_first_seen_at_id
    ON offer_file (first_seen_at DESC, id DESC);

-- History index: NOT used by resolveOfferCursor, which probes history by
-- offer_hash (idx_offer_file_history_offer_hash) and never orders it. Kept for
-- the archived-offer queries that do order by first_seen_at, and so the two
-- tables stay symmetric; drop it if that never materialises.
CREATE INDEX IF NOT EXISTS idx_offer_file_history_first_seen_at_id
    ON offer_file_history (first_seen_at DESC, id DESC);
