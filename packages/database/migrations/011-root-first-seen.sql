-- first_seen_ms on known_roots — the deterministic basis for a shielded
-- offer's expiry (MIP-0006 expiresAt) and firstSeenAt.
--
-- A shielded offer is fillable only while the Merkle root its proof commits
-- to stays inside the ledger's root-recency window. That window opens when
-- the chain FIRST accepted the root, so `first_seen_ms + ROOT_WINDOW` is the
-- deterministic expiry. The existing `last_seen_ms` is the WRONG basis: it
-- advances every time the root is re-accepted on a quiet chain, so an expiry
-- computed from it drifts later on each re-upsert — non-deterministic across
-- nodes that re-synced at different times.
--
-- Set once, on first insert, and never moved (see the ON CONFLICT in
-- UpsertKnownRootWithFirstSeen). Backfilled from last_seen_ms for any rows
-- that predate this column (none on a from-zero deploy; correct-enough for
-- dev DBs — it only means their oldest roots look slightly fresher).
ALTER TABLE known_roots ADD COLUMN IF NOT EXISTS first_seen_ms BIGINT;
UPDATE known_roots SET first_seen_ms = last_seen_ms WHERE first_seen_ms IS NULL;
