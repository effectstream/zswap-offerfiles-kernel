-- Content-addressed offer identity (the MIP-0006 `offerId`).
--
-- `offer_hash` is the hex sha256 of the offer's canonical bytes — the raw
-- MIP-0005 `Transaction` serialization (bech32m-decoded blob). Unlike the
-- SERIAL `id`, which is local bookkeeping and diverges across deployments
-- (different filters, ingestion order, or restarts), the hash is identical on
-- every node that indexes the same offer, so it is the only identifier safe to
-- expose for cross-system lookups.
--
-- Computed in application code at ingestion (bech32m decode is not available
-- in SQL); NULL means a legacy row whose blob predates the current codec.
ALTER TABLE offer_file ADD COLUMN IF NOT EXISTS offer_hash TEXT;
ALTER TABLE offer_file_history ADD COLUMN IF NOT EXISTS offer_hash TEXT;

-- Uniqueness over open offers doubles as the MIP-0006 duplicate-rejection
-- gate: re-publishing byte-identical offer bytes must not index twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_file_offer_hash
    ON offer_file (offer_hash) WHERE offer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offer_file_history_offer_hash
    ON offer_file_history (offer_hash);

-- NOTE: the archive queries copy an explicit column list from offer_file into
-- offer_file_history — they must name offer_hash explicitly (see the
-- *WithHash archive queries in sql/queries.app.ts). A BEFORE INSERT trigger
-- that looked the hash up from the live row was tried and rejected: inside
-- the archiving wCTE the trigger's SELECT may or may not see the row being
-- deleted in the same statement (sub-statement snapshot ordering), so it
-- silently produced NULLs.
