-- Drop the auth block and maker note (MIP-0006 removals).
--
-- auth_*: the spec removed wrapper authentication as UNSOUND and
-- privacy-harming — the signature was over the wrapper, not bound to the
-- secret controlling the offer's coins, so anyone could strip and re-sign a
-- published offer; and a public signer key deanonymises the maker. The
-- columns were never populated here (always NULL) and are gone from the
-- spec; keeping them invites someone to "finish" the feature.
--
-- metadata_maker_note: maker messages are removed from the spec entirely.
-- An unauthenticated note beside an offer is a phishing surface, and the
-- ledger Transaction has no field for an authenticated one — message support
-- of any kind requires a protocol update (see MIP-0005 "No attached
-- messages" / MIP-0006 Future Work).
ALTER TABLE offer_file DROP COLUMN IF EXISTS auth_signer_public_key;
ALTER TABLE offer_file DROP COLUMN IF EXISTS auth_signature;
ALTER TABLE offer_file DROP COLUMN IF EXISTS auth_scheme;
ALTER TABLE offer_file DROP COLUMN IF EXISTS metadata_maker_note;

ALTER TABLE offer_file_history DROP COLUMN IF EXISTS auth_signer_public_key;
ALTER TABLE offer_file_history DROP COLUMN IF EXISTS auth_signature;
ALTER TABLE offer_file_history DROP COLUMN IF EXISTS auth_scheme;
ALTER TABLE offer_file_history DROP COLUMN IF EXISTS metadata_maker_note;
