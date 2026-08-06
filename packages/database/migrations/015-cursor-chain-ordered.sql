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
-- excluded from the diff, so replicas are held to it. `id` remains a safe
-- tiebreaker: the determinism run proves `offer_file` matches byte-for-byte
-- across independently-synced instances, ids included, because ingestion order
-- is deterministic.
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
-- Safe to assert: every insert sets it (insertOfferFileWithHash, from
-- state-machine.ts's firstSeenAt), the archive copies it through
-- HISTORY_COLUMNS, and this is a new system with no pre-012 rows.
ALTER TABLE offer_file         ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE offer_file_history ALTER COLUMN first_seen_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offer_file_first_seen_at_id
    ON offer_file (first_seen_at DESC, id DESC);

-- The archive copies first_seen_at into history (see HISTORY_COLUMNS), so an
-- anchor whose offer was consumed mid-pagination still resolves.
CREATE INDEX IF NOT EXISTS idx_offer_file_history_first_seen_at_id
    ON offer_file_history (first_seen_at DESC, id DESC);
