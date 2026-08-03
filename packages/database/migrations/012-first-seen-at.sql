-- computed.firstSeenAt (MIP-0006): when the offer was first observable.
-- Deterministic per Q5, computed once at ingestion:
--   shielded   → the earliest first_seen_ms of the offer's proof roots (the
--                offer cannot predate the newest... conservatively, the
--                moment its proof became provable on this chain)
--   otherwise  → the Celestia block timestamp (when it appeared on the DA
--                layer; equals the NTP block time)
-- Never wall-clock: two nodes replaying the same blocks must agree.
ALTER TABLE offer_file ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
ALTER TABLE offer_file_history ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;
