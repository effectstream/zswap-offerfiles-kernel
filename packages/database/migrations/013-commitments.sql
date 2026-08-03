-- Zswap COMMITMENTS (coin creations) from the Midnight:NullifierAndCommitment
-- primitive (effectstream#838). Commitments are the public leaves of the
-- zswap Merkle tree — exactly as public as nullifiers; only coin contents and
-- the commitment↔nullifier link are private.
--
-- Purpose: EXACT fill-vs-cancel classification (Q2 phase 2 / plan item #22).
-- The offer tx fixes the maker's output commitments and merging preserves
-- outputs, so the settling tx creates exactly those commitments on-chain;
-- a cancel (maker spending inputs elsewhere) creates none of them.
--   fill  ⇔ the single tx that spent all inputs ALSO created the offer's
--           output commitments.
--
-- Retention: forever, mirroring `nullifiers` — a commitment insertion is a
-- permanent chain fact and both tables carry one 32-byte hash per coin event.
CREATE TABLE IF NOT EXISTS commitments (
  commitment TEXT PRIMARY KEY,     -- 64-hex, globally unique for chain life
  tx_hash    TEXT,                 -- ledger tx hash that created the coin
  mt_index   TEXT,                 -- zswap Merkle-tree index (decimal u64)
  height     BIGINT NOT NULL
);
-- Classification looks up "commitments created by tx T".
CREATE INDEX IF NOT EXISTS idx_commitments_tx_hash ON commitments (tx_hash);

-- The offer's own shielded output commitments, read from the published blob
-- at ingestion (they are plaintext fields of the serialized outputs).
CREATE TABLE IF NOT EXISTS offer_file_commitments (
  offer_file_id INTEGER NOT NULL REFERENCES offer_file(id) ON DELETE CASCADE,
  commitment    TEXT NOT NULL,
  PRIMARY KEY (offer_file_id, commitment)
);
CREATE TABLE IF NOT EXISTS offer_file_commitments_history (
  offer_file_id INTEGER NOT NULL,
  commitment    TEXT NOT NULL,
  PRIMARY KEY (offer_file_id, commitment)
);
