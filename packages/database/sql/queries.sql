/* @name InsertKnownToken */
INSERT INTO known_tokens (token_color, name, kind)
VALUES (:token_color!, :name!, :kind!)
ON CONFLICT (token_color) DO NOTHING;

/* @name GetKnownTokens */
SELECT * FROM known_tokens;

/* @name InsertOfferFileNullifier */
INSERT INTO offer_file_nullifiers (
    offer_file_id,
    nullifier
) VALUES (
    :offer_file_id!,
    :nullifier!
) ON CONFLICT (offer_file_id, nullifier) DO NOTHING;

/* @name InsertOfferFileUnshieldedSpend */
INSERT INTO offer_file_unshielded_spends (
    offer_file_id,
    owner,
    intent_hash,
    output_no
) VALUES (
    :offer_file_id!,
    :owner!,
    :intent_hash!,
    :output_no!
) ON CONFLICT (offer_file_id, owner, intent_hash, output_no) DO NOTHING;

/* The ArchiveOfferBy{Nullifier,UnshieldedSpend,IdTtl} queries that lived here
   were dead code: the state machine archives exclusively through the
   *WithHash prepared variants in queries.app.ts (archiveOfferSql), which also
   carry the chain-derived archived_at. Removed rather than left to rot —
   with archived_at now NOT NULL they would fail if ever called.

   Block-comment form, not `--`, and that is load-bearing: pgtyped's grammar
   accepts only `/*` at the top level, and a bare `--` here made it abort with
   "extraneous input" — then log "Skipped: no changes or no queries detected"
   and exit 0. So `bun run build:pgtypes` silently stopped regenerating this
   file while still reporting success, which is why hand-written `prepared`
   variants piled up in queries.app.ts with "fold in on the next regeneration"
   notes. There was no next regeneration. */

/* @name MarkNullifierMatched */
UPDATE nullifiers SET offer_matched = true WHERE nullifier = :nullifier!;

/* @name FindUnmatchedNullifier */
SELECT nullifier, height FROM nullifiers
WHERE nullifier = :nullifier! AND offer_matched = false;

/* @name IsNullifierSpent */
SELECT 1 AS spent FROM nullifiers WHERE nullifier = :nullifier!;

/* @name InsertCreatedUnshielded */
INSERT INTO created_unshielded (owner, intent_hash, output_no, height)
VALUES (:owner!, :intent_hash!, :output_no!, :height!)
ON CONFLICT (owner, intent_hash, output_no) DO NOTHING;

/* @name DeleteCreatedUnshielded */
DELETE FROM created_unshielded
WHERE owner = :owner!
  AND intent_hash = :intent_hash!
  AND output_no = :output_no!;

/* @name IsUnshieldedCreated */
SELECT 1 AS present
FROM created_unshielded
WHERE owner = :owner!
  AND intent_hash = :intent_hash!
  AND output_no = :output_no!;

/* @name PruneKnownRoots */
-- Drop roots older than the window cutoff, but never the most recent root: on
-- a quiet chain the latest root keeps being re-accepted, mirroring the
-- ledger's past_roots re-insertion each block.
DELETE FROM known_roots
WHERE last_seen_ms < :cutoff_ms!
  AND height < (SELECT MAX(height) FROM known_roots);
