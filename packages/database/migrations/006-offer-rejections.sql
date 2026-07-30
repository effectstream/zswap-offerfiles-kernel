-- Rejection counters for blobs discarded at Celestia ingestion.
--
-- The blob bodies themselves are DELETEd from effectstream.primitive_accounting
-- when the STM rejects them (see the ingestion ladder in state-machine.ts):
-- they are attacker-controlled bytes we have decided to discard, and the
-- namespace is permissionless, so keeping them is unbounded storage anyone can
-- fill for the price of a blob fee.
--
-- Deleting outright would leave operators blind to "is someone spamming us,
-- and with what?", so the fact of each rejection is aggregated here instead.
-- Aggregation is what makes this safe to keep: the row count is bounded by
-- (heights that had a rejection) × (distinct reject codes), NOT by the number
-- of blobs posted. An attacker publishing a million junk blobs in one block
-- produces exactly one row.
--
-- Deterministic: counts are a pure function of the blobs in each Celestia
-- block, so a replay from genesis rebuilds them identically. No wall-clock
-- timestamps for that reason — `celestia_height` already says when.
CREATE TABLE IF NOT EXISTS offer_rejections (
    celestia_height BIGINT NOT NULL,
    code            TEXT   NOT NULL,
    count           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (celestia_height, code)
);

-- "What is being rejected lately?" — the ops question this table answers.
CREATE INDEX IF NOT EXISTS idx_offer_rejections_height
    ON offer_rejections (celestia_height DESC);
