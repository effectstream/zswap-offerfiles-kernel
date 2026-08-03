-- Keyset (cursor) pagination for the offer book.
--
-- OFFSET pagination re-scans and discards every earlier row on each page, so
-- deep pages cost O(offset) — and the offset shifts whenever an offer is
-- indexed or archived mid-pagination, silently skipping or repeating rows.
-- The API instead resolves an opaque `after_hash` cursor to the anchor row's
-- (created_at, id) and seeks with a row-value comparison:
--
--   WHERE (created_at, id) < (:anchor_created_at, :anchor_id)
--   ORDER BY created_at DESC, id DESC
--
-- `id` is the tie-break for offers sharing a created_at (same-block indexing).
-- It never leaves the node: the cursor is the offer_hash, resolved
-- server-side, so the non-portable SERIAL id stays internal.
CREATE INDEX IF NOT EXISTS idx_offer_file_created_at_id
    ON offer_file (created_at DESC, id DESC);

-- Redundant prefix of the composite above (000-init.sql created it for the
-- old ORDER BY created_at scan). Dropping it removes an index write from
-- every offer insert.
DROP INDEX IF EXISTS idx_offer_file_created_at;
