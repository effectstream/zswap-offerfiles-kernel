// Typed queries defined in TS (compiled to pgtyped IR at module load).
//
// These MUST be real @pgtyped/runtime PreparedQuery objects, not just
// .run()-compatible wrappers: the STM executes queries via World.resolve,
// which yields `[query.queryIR, input]` — it introspects the pgtyped IR and
// never calls .run(). A wrapper without queryIR makes every state transition
// that touches it throw `undefined is not an object (evaluating
// 'queryIR.params')` INVISIBLY (the runtime catch routes STF errors to
// log.remote, not the console) — live-debugged 2026-08-02: known_roots,
// nullifiers and commitments all silently empty while unshielded tables
// (generated PreparedQueries) worked.
//
// compileIR reproduces pgtyped's SQL-flavour IR: params as :name (optional)
// / :name! (required), locs = inclusive char offsets of each occurrence.
// `::type` casts must not parse as params. Verified against the
// generator's own output in queries.app.test.ts (oracle test).

import { PreparedQuery } from "@pgtyped/runtime";
import type { DateOrString, NumberOrString } from "./queries.queries.ts";

interface IRParam {
  name: string;
  required: boolean;
  transform: { type: "scalar" };
  locs: { a: number; b: number }[];
}

export function compileIR(statement: string): {
  usedParamSet: Record<string, true>;
  params: IRParam[];
  statement: string;
} {
  const usedParamSet: Record<string, true> = {};
  const params: IRParam[] = [];
  const byName = new Map<string, IRParam>();
  // Reject matches preceded by ':' or identifier chars: `::int` casts and
  // mid-word colons never produce params.
  const re = /(?<![:A-Za-z0-9_]):([A-Za-z_][A-Za-z0-9_]*)(!?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement))) {
    const name = m[1]!;
    const required = m[2] === "!";
    let p = byName.get(name);
    if (!p) {
      p = { name, required, transform: { type: "scalar" }, locs: [] };
      byName.set(name, p);
      params.push(p);
      usedParamSet[name] = true;
    }
    p.required = p.required || required;
    p.locs.push({ a: m.index, b: m.index + m[0].length - 1 });
  }
  return { usedParamSet, params, statement };
}

function prepared<P, R>(statement: string): PreparedQuery<P, R> {
  return new PreparedQuery<P, R>(compileIR(statement) as any);
}

// ── SQL fragment helpers (must precede all prepared() consts: statements
// are compiled at module load, so these can no longer live mid-file) ──

// Read-time fill-vs-cancel classification of an archived (CONSUMED) offer.
// Three branches, each individually certain:
//
//   1. PARTIAL SPEND — some offer nullifier never landed on-chain while
//      others did. Settlement is atomic, so this can never have been a fill.
//   2. SPLIT SPEND — the nullifiers span more than one distinct tx. Same
//      atomicity argument.
//   3. MISSING FILL MARKERS — all nullifiers landed in ONE tx, but that tx
//      did not create the offer's own output commitments. The offer tx fixes
//      the maker's output commitments and merging preserves outputs
//      verbatim, so every genuine settlement creates ALL of them; their
//      absence proves the inputs were spent by a non-settlement tx. This is
//      what upgrades the old all-in-one-tx HEURISTIC to a proof — including
//      the single-input case it could never classify. (A tx that recreates
//      the exact commitments is a maker self-fill: the offer's terms
//      executed, so `consumed` is the right answer there.)
//
// Branch 3 is vacuous for offers with no stored commitments (rows indexed
// before migration 013, or offers whose wants are unshielded-only): those
// keep the branch-1/2 heuristic. NULL tx_hash on any spend row also falls
// back — never classify on absent evidence.
const shieldedCancelledPredicate = (idExpr: string) => `(
  EXISTS (SELECT 1 FROM offer_file_nullifiers_history cnx
          LEFT JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
          WHERE cnx.offer_file_id = ${idExpr} AND cnn.nullifier IS NULL)
  OR (SELECT COUNT(DISTINCT cnn.tx_hash)
      FROM offer_file_nullifiers_history cnx
      JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
      WHERE cnx.offer_file_id = ${idExpr}) > 1
  OR (
    (SELECT COUNT(DISTINCT cnn.tx_hash)
     FROM offer_file_nullifiers_history cnx
     JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
     WHERE cnx.offer_file_id = ${idExpr} AND cnn.tx_hash IS NOT NULL) = 1
    AND NOT EXISTS (SELECT 1 FROM offer_file_nullifiers_history cnx
                    JOIN nullifiers cnn ON cnn.nullifier = cnx.nullifier
                    WHERE cnx.offer_file_id = ${idExpr} AND cnn.tx_hash IS NULL)
    AND EXISTS (
      SELECT 1 FROM offer_file_commitments_history oc
      WHERE oc.offer_file_id = ${idExpr}
        AND NOT EXISTS (
          SELECT 1 FROM commitments cm
          WHERE cm.commitment = oc.commitment
            AND cm.tx_hash = (SELECT MIN(cnn2.tx_hash)
                              FROM offer_file_nullifiers_history cnx2
                              JOIN nullifiers cnn2 ON cnn2.nullifier = cnx2.nullifier
                              WHERE cnx2.offer_file_id = ${idExpr})))
  )
)`;

// ── The same three branches, on the UNSHIELDED layer ────────────────────────
//
// Until migration 014 this layer had NO evidence at all: nothing recorded which
// transaction spent an unshielded UTXO, so branches 1-3 above could not fire —
// not merely misclassify, but never fire — and every consumption of an
// unshielded-only offer read `consumed`. A maker spending their own UTXO on
// themselves was recorded as a completed sale.
//
// The evidence was always available; the state machine discarded it. The
// primitives deliver `txHash`, `value` and `tokenType` on both the spend and
// create events, so the shielded argument ports over intact:
//
//   1. PARTIAL SPEND — an offer spend ref with no matching row in
//      unshielded_spends. Settlement is atomic, so this cannot have been a fill.
//   2. SPLIT SPEND — the offer's spends span more than one tx. Same argument.
//   3. MISSING FILL MARKERS — the offer declared an unshielded output that was
//      never created. Phase (d) moved this branch onto the EXACT identity
//      `(owner, intent_hash, output_no)` that phase (b) precomputes from the
//      offer's own intent; it previously grouped on (owner, token_type, value)
//      and leaned on the settling transaction to scope the comparison.
//
//      Why the identity is sound as a key, and why the transaction is no longer
//      one: `UtxoState::apply_offer` stamps every output with
//      `parent.intent_hash(segment_id)` (ledger 8.1.0 semantics.rs:1668-1680),
//      so only a transaction containing THAT intent can create THAT identity,
//      and replay protection admits an intent once (semantics.rs:1694-1705).
//      The create therefore comes from the settling transaction necessarily —
//      correlating on tx_hash re-derives a fact the identity already carries.
//
//      What that fixes: the CROSS-OFFER MARKER BYPASS. Two disjoint offers each
//      wanting 20 UB to the same address, "settled" by one transaction paying
//      20 once, both matched under shape grouping because a payout of the right
//      (owner, token, value) satisfied both. Identities are per-intent, so one
//      payout now satisfies exactly the offer that declared it.
//
//      It also retires the multiplicity arithmetic. N identical declared
//      payouts used to need a SUM(count) > COUNT(creates) comparison to stop
//      one payout satisfying all N; as distinct identities they are distinct
//      rows, and an uncreated one fails the EXISTS on its own.
//
// Vacuous, as on the shielded side, when the offer declares no unshielded
// outputs — a `uu` offer always does, so in practice branch 3 applies wherever
// it matters. NULL tx_hash falls back rather than classifying on absent
// evidence.
const unshieldedCancelledPredicate = (idExpr: string) => `(
  -- MARKER GATE, and it is what makes this migration safe to deploy.
  --
  -- unshielded_spends starts EMPTY, while offer_file_unshielded_spends_history
  -- is populated in every pre-014 database. Without this gate, branch 1 sees no
  -- matching spend row for any historical offer and flips every one of them to
  -- cancelled — silently reclassifying genuine past fills, erasing them from
  -- chart history and volume, while pair_stats (a persisted write-side
  -- projection, incremented once at archive time) keeps counting them. The two
  -- would then disagree permanently.
  --
  -- Migration 013 avoided this by construction: its branch is gated behind
  -- EXISTS(offer_file_commitments_history), which is empty for pre-013 rows, so
  -- the whole branch goes vacuous and the old classification stands. This is
  -- that same gate. Pre-014 rows have no marker rows -> predicate inert. Offers
  -- indexed after 014 always have them, since a uu offer structurally
  -- declares outputs. Offers live AT the upgrade also go inert, which is the
  -- honest answer: their marker evidence was never captured.
  EXISTS (SELECT 1 FROM offer_file_unshielded_outputs_history
          WHERE offer_file_id = ${idExpr})
  AND (
  EXISTS (SELECT 1 FROM offer_file_unshielded_spends_history uxh
          LEFT JOIN unshielded_spends us
            ON us.owner = uxh.owner AND us.intent_hash = uxh.intent_hash
           AND us.output_no = uxh.output_no
          WHERE uxh.offer_file_id = ${idExpr} AND us.owner IS NULL)
  OR (SELECT COUNT(DISTINCT us.tx_hash)
      FROM offer_file_unshielded_spends_history uxh
      JOIN unshielded_spends us
        ON us.owner = uxh.owner AND us.intent_hash = uxh.intent_hash
       AND us.output_no = uxh.output_no
      WHERE uxh.offer_file_id = ${idExpr}) > 1
  OR EXISTS (
    -- Branch 3, on exact identities: cancelled unless EVERY declared identity
    -- exists in unshielded_creates. No transaction correlation and no
    -- multiplicity arithmetic — see the argument above for why neither is
    -- needed once the key is the identity the ledger itself stamps.
    SELECT 1 FROM offer_file_unshielded_outputs_history uo
    WHERE uo.offer_file_id = ${idExpr}
      AND NOT EXISTS (
        SELECT 1 FROM unshielded_creates uc
        WHERE uc.owner = uo.owner
          AND uc.intent_hash = uo.intent_hash
          AND uc.output_no = uo.output_no
      )
  )
  )
)`;

// Either layer's evidence is enough to prove a cancel, and each predicate is
// INERT on the other layer: a pure shielded offer has no unshielded spend rows,
// so every unshielded branch is false, and vice versa.
//
// A cross-layer offer would be judged by both, which is conservative but NOT a
// full atomicity check: each layer counts distinct spending txs over its own
// inputs, so shielded inputs in tx1 and unshielded inputs in tx2 fires neither
// branch 2. That gap is now CLOSED UPSTREAM rather than here: §2.4's ruling is
// implemented — `CROSS_LAYER` is in OfferRejectCode and validate.ts rejects the
// shape immediately after the two-sided rule, at both doors — so no cross-layer
// offer is ever indexed and this predicate never sees one.
//
// Kept as a comment rather than deleted: it records WHY these predicates are
// safe to leave layer-independent. If §2.4 were ever relaxed, this is the
// weakness that would come back.
/*
 * REMOVED 2026-08-18: supersededByDuplicatePredicate.
 *
 * It existed to make one SETTLEMENT count as one trade when two offers wrapped
 * one intent — measured on a live chain, five settlements read as seven trades.
 * That collapse was a PROJECTION-side repair of an INGESTION-side defect, and
 * the marker-dedup ruling removes the defect: two offers declaring the same
 * markers can no longer coexist in the live book, because the second is
 * rejected at both doors (packages/node/marker-dedup.ts). With nothing left to
 * collapse, keeping the predicate would mean carrying a quadratic self-join
 * over the archive on every market read to defend against a state the system
 * can no longer reach.
 *
 * Recorded rather than silently deleted because the reasoning is the load-
 * bearing part: identities are per-intent, so only alternatives over ONE intent
 * could ever collide here — which is exactly the set that ingestion now
 * refuses. The shielded twin (t6 in unshielded-fill-vs-cancel.test.ts) was
 * never covered by this predicate at all and is likewise closed at ingestion,
 * by the commitment probe; t6 stays as the tripwire that fails the day that
 * stops being true.
 */

const cancelledPredicate = (idExpr: string) =>
  `(${shieldedCancelledPredicate(idExpr)} OR ${unshieldedCancelledPredicate(idExpr)})`;

// ── Baskets are not price observations (§2.5, ruled ACCEPT-but-exclude) ─────
//
// A basket is an offer with more than one colour on a side: give A+B, want C+D.
// It is a legitimate, sealed, pre-agreed settlement — it lives, settles and
// archives like any other offer, and NONE of that is affected here. What it is
// not is a PRICE. Nobody agreed that 1317 A is worth 1983 C; they agreed that
// A+B together are worth C+D together. Splitting that into per-pair prices
// invents agreements that were never made.
//
// Measured, not argued: one 2x2 basket became FOUR trades at four different
// prices on four pairs, with every leg's volume counted twice, and manufactured
// four rows on /v1/pairs. See multileg-pairs.test.ts.
//
// Why this cannot be fixed by reconstructing the constituent swaps instead:
// merging is lossy at the segment level. Two zswaps merged into one transaction
// land in segment 0 TOGETHER, netted, with nothing left to say which +N pairs
// with which -M (probe-segments.ts). The sealed sub-balances are not recoverable
// from the bytes, so there is no honest query-side reconstruction — exclusion is
// the only option that does not fabricate.
//
// Eligibility, stated positively: at most one give colour AND at most one want
// colour. Expressed as "no direction has two colours" so a single grouped
// subquery covers both sides.
//
// `tokensTable` selects the live (`offer_file_tokens`) or archived
// (`offer_file_tokens_history`) side; they are separate tables, so the caller
// must name the one matching `idExpr`'s table or the filter silently matches
// nothing and every basket sails through.
const notABasketPredicate = (idExpr: string, tokensTable: string) => `
NOT EXISTS (
  SELECT 1 FROM ${tokensTable} bt
  WHERE bt.offer_file_id = ${idExpr}
  GROUP BY bt.direction
  HAVING COUNT(DISTINCT bt.token_color) > 1
)`;

/**
 * Every PRICED FILL, from the stored verdict where one exists and computed
 * where one does not yet.
 *
 * The second branch is the important one. Adjudication runs in an api.ts
 * listener on the post-commit event, so between an offer being archived and
 * its verdict being written there is a window — normally a second, but as long
 * as STM lag makes it. Reading only the stored column made a settled offer
 * report `consumed` from /v1/offers/:hash/status while being absent from
 * /v1/chart/history at the same instant: the read/write split this refactor
 * exists to remove, reintroduced one layer down. The grand e2e caught it on a
 * contended box.
 *
 * So the stored verdict is a CACHE of a pure function, and a miss computes.
 * That keeps read-time truth exact and leaves the column as what it is — an
 * optimisation for the rows that have one, never the reason an answer is
 * wrong. The fallback is bounded by the partial index on
 * (archive_reason = 'CONSUMED' AND settled IS NULL): in steady state that set
 * is the handful of offers archived in the last few seconds.
 *
 * WHY LATERAL, AND NOT A GROUPED SUBQUERY. That bound is a property of HOW the
 * legs are fetched, not merely of the WHERE clause. Written as
 * `JOIN (SELECT offer_file_id, ... GROUP BY 1, 2) g ON g.offer_file_id = h.id`
 * the aggregate is uncorrelated, so Postgres must materialise it over the WHOLE
 * of offer_file_tokens_history before the join can discard anything — the
 * `settled IS NULL` restriction reaches h, never the aggregate. Measured on
 * PGlite (market-read-cost.bench.ts, 50 fills on the read pair and 5 rows owed
 * a verdict at every point): two HashAggregates over 16 110 token rows,
 * 884 kB of sorts and 8 000 rows discarded by the join filter, to produce five
 * rows — and a read cost that tracked BACKGROUND archive size, 4.7x-9.0x
 * across a 16x growth in offers on pairs the query never returns.
 *
 * LATERAL correlates the aggregate to h.id, which forces h to be the outer
 * relation: the partial index picks the few unadjudicated rows and each one
 * costs a single indexed lookup of its own legs. Same rows, same order, and the
 * only difference is that the work is now proportional to what is MISSING
 * rather than to what has been archived since the process started — which is
 * what the sweep's index was designed for, and what the verdict design exists
 * to buy. On single-backend PGlite this is not a micro-optimisation: the
 * aggregation contends with the STM's own writes, and STM lag is the metric
 * that shows it.
 */
const pricedFillsSql = `
    SELECT h.id, h.offer_hash, h.archived_at, h.base_color, h.quote_color,
           h.base_amount, h.quote_amount
      FROM offer_file_history h
     WHERE h.settled AND h.base_color IS NOT NULL
    UNION ALL
    SELECT h.id, h.offer_hash, h.archived_at,
           LEAST(g.token_color, w.token_color),
           GREATEST(g.token_color, w.token_color),
           CASE WHEN g.token_color = LEAST(g.token_color, w.token_color)
                THEN g.amount ELSE w.amount END,
           CASE WHEN g.token_color = LEAST(g.token_color, w.token_color)
                THEN w.amount ELSE g.amount END
      FROM offer_file_history h
      JOIN LATERAL (SELECT t.token_color, SUM(t.amount::numeric) AS amount
                      FROM offer_file_tokens_history t
                     WHERE t.offer_file_id = h.id AND t.direction = 'GIVING'
                     GROUP BY t.token_color) g ON TRUE
      JOIN LATERAL (SELECT t.token_color, SUM(t.amount::numeric) AS amount
                      FROM offer_file_tokens_history t
                     WHERE t.offer_file_id = h.id AND t.direction = 'WANTING'
                     GROUP BY t.token_color) w ON TRUE
     WHERE h.settled IS NULL
       AND h.archive_reason = 'CONSUMED'
       AND g.amount > 0 AND w.amount > 0
       AND ${notABasketPredicate("h.id", "offer_file_tokens_history")}
       AND NOT ${cancelledPredicate("h.id")}`;


// Status of an archived row: expired (TTL) / cancelled / consumed.
const archivedStatusCase = (tableIdExpr: string) => `
  CASE WHEN archive_reason <> 'CONSUMED' THEN 'expired'
       WHEN ${cancelledPredicate(tableIdExpr)} THEN 'cancelled'
       ELSE 'consumed'
  END`;


// Hash-aware archive queries. These supersede the generated
// ArchiveOfferBy* queries: the history insert names offer_hash explicitly,
// because a BEFORE INSERT trigger reading the live row proved unreliable
// inside the archiving wCTE (sub-statement snapshot ordering — see
// migrations/005-offer-hash.sql). The three variants differ only in how
// offers are matched and the archive_reason recorded.
const HISTORY_COLUMNS = `
        id,
        celestia_height,
        transaction_hex,
        offer_hash,
        metadata_created_at,
        metadata_expires_at,
        first_seen_at,
        created_at,
        ttl_seconds`;

// Every _history INSERT carries :archived_at! — the L2 block timestamp of the
// archiving event, passed by the state machine from data.blockTimestamp. The
// columns are NOT NULL with no default (000-init.sql), so forgetting the param
// is a hard error, never a silent fall-back to node-local NOW(). This is what
// makes archive timestamps identical across replicas (asserted by the
// grand-e2e determinism phase) and correct after a resync.
const archiveOfferSql = (matched: string, reason: "CONSUMED" | "TTL") => `
WITH matched AS (
${matched}
),
archived_offer AS (
    INSERT INTO offer_file_history (${HISTORY_COLUMNS},
        archive_reason,
        archived_at
    )
    SELECT${HISTORY_COLUMNS},
        '${reason}',
        :archived_at!
    FROM offer_file
    WHERE id IN (SELECT offer_file_id FROM matched)
    RETURNING id
),
archived_tokens AS (
    INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
    SELECT offer_file_id, token_color, amount, direction, kind, :archived_at!
    FROM offer_file_tokens
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
archived_nullifiers AS (
    INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
    SELECT offer_file_id, nullifier, :archived_at!
    FROM offer_file_nullifiers
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
archived_unshielded_spends AS (
    INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
    SELECT offer_file_id, owner, intent_hash, output_no, :archived_at!
    FROM offer_file_unshielded_spends
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
archived_commitments AS (
    INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
    SELECT offer_file_id, commitment
    FROM offer_file_commitments
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
),
-- The unshielded fill markers must survive archival for exactly the reason the
-- commitments do: classification is READ-time, so evidence left behind in the
-- live tables is evidence that no longer exists when the question is asked.
archived_unshielded_outputs AS (
    INSERT INTO offer_file_unshielded_outputs_history
      (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
    SELECT offer_file_id, owner, intent_hash, output_no, token_type, value, count
    FROM offer_file_unshielded_outputs
    WHERE offer_file_id IN (SELECT offer_file_id FROM matched)
)
DELETE FROM offer_file
WHERE id IN (SELECT offer_file_id FROM matched)
RETURNING id, offer_hash`;


// ── Sync health — effectstream framework schema ────────────────────────────

// The NTP protocol's REAL anchor, snapshotted by the framework at startup.
// The env defaults (NTP_START_TIME = Preview genesis, BLOCK_TIME_MS = 10 min)
// describe deployed networks; the dev orchestrator anchors NTP at launch
// time with 1 s blocks, so a tip computed from env reads ~130 days behind
// on a machine that is actually AT tip. Health must use this snapshot and
// fall back to env only when it is absent.
export interface IGetNtpConfigSnapshotResult {
  start_time: NumberOrString | null;
  block_time_ms: NumberOrString | null;
}
export const getNtpConfigSnapshot = prepared<void, IGetNtpConfigSnapshotResult>(
  `SELECT (immutable_config->>'startTime')::bigint  AS start_time,
          (immutable_config->>'blockTimeMS')::bigint AS block_time_ms
   FROM effectstream.sync_protocol_config_snapshot
   WHERE network_type = 'ntp'
   LIMIT 1`,
);

export interface IGetNtpCurrentBlockResult {
  current: NumberOrString | null;
}
export const getNtpCurrentBlock = prepared<void, IGetNtpCurrentBlockResult>(
      "SELECT MAX(block_height) AS current FROM effectstream.effectstream_blocks",
);

export interface IGetSyncProtocolPaginationResult {
  protocol_name: string;
  merged: NumberOrString | null;
  fetched: NumberOrString | null;
}
export const getSyncProtocolPagination = prepared<void, IGetSyncProtocolPaginationResult>(
      `SELECT protocol_name,
              MIN(page_number) AS merged,
              MAX(page_number) AS fetched
       FROM effectstream.sync_protocol_pagination
       GROUP BY protocol_name`,
);

export interface IGetLatestEffectstreamBlockResult {
  block_height: NumberOrString;
  ms_timestamp: NumberOrString | null;
  effectstream_block_hash: Buffer | null;
  main_chain_block_hash: Buffer | null;
}
export const getLatestEffectstreamBlock = prepared<void, IGetLatestEffectstreamBlockResult>(
      // ms_timestamp IS NOT NULL: the column is nullable, and callers use this
      // row AS THE CHAIN CLOCK (the 24 h window cutoff, the root-window gate).
      // A newest row with a NULL timestamp would otherwise make them fall back
      // to wall clock — silently reintroducing the mixed-clock defect — instead
      // of using the newest block that actually carries a time.
      `SELECT block_height, ms_timestamp, effectstream_block_hash, main_chain_block_hash
       FROM effectstream.effectstream_blocks
       WHERE ms_timestamp IS NOT NULL
       ORDER BY block_height DESC
       LIMIT 1`,
);

export interface IGetNullifierStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getNullifierStats = prepared<void, IGetNullifierStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM nullifiers",
);

export interface IGetKnownRootStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getKnownRootStats = prepared<void, IGetKnownRootStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM known_roots",
);

export interface IGetUnshieldedStatsResult {
  total: number;
  latest_height: NumberOrString | null;
}
export const getUnshieldedStats = prepared<void, IGetUnshieldedStatsResult>(
      "SELECT COUNT(*)::int AS total, MAX(height) AS latest_height FROM created_unshielded",
);

export interface IGetLastOfferResult {
  id: number;
  celestia_height: NumberOrString;
  created_at: DateOrString | null;
}
export const getLastOffer = prepared<void, IGetLastOfferResult>(
      `SELECT id, celestia_height, created_at
       FROM offer_file
       ORDER BY id DESC
       LIMIT 1`,
);

// ── 24 h pair stats (full window, no row cap) ──────────────────────────────
//
// Computed in SQL over EVERY fill in the window. The old path derived stats
// from the display-history query and inherited its LIMIT 120, so any pair
// with >120 fills in 24 h reported understated volume, a truncated high/low
// window, and a change24 baselined on the 120th-newest trade mislabelled as
// "24 h ago". The display list keeps its cap; stats must not.
//
// One round trip, four scalar-subquery groups over a shared fills CTE:
//   last_price       — newest fill ever (not window-bound: a quiet pair still
//                      has a last traded price)
//   ref_before_24h   — newest fill at or older than the 24 h cutoff: the
//                      correct change24 baseline
//   oldest_in_24h    — fallback baseline when the pair's whole history is
//                      inside the window (change-since-inception)
//   window aggregates — high / low / volumes / fill count over ALL 24 h fills
//
// Zero-amount legs are excluded up front (price would be 0 or ∞) — same
// filter the old JS path applied per row.
export interface IGetPairStats24hParams {
  base: string;
  quote: string;
  /**
   * Start of the 24 h window, derived from the CHAIN clock — see trade-data.ts.
   *
   * This used to be `NOW() - INTERVAL '24 hours'`, wall clock, compared against
   * `h.archived_at`, which is the L2 block timestamp. Two clocks in one
   * comparison. Any node whose chain time is not wall time — a replica catching
   * up, a replay, a devnet anchored in the past — reported zero volume and a
   * collapsed high/low while /v1/chart/history still listed every fill: the API
   * contradicting itself about whether trades exist.
   *
   * Same defect class as the archived_at fix, one layer up; closing that one is
   * what made this reachable.
   */
  cutoff: DateOrString;
}
export interface IGetPairStats24hResult {
  last_price: string | null;
  ref_before_24h: string | null;
  oldest_in_24h: string | null;
  fills_24h: number;
  high_24h: string | null;
  low_24h: string | null;
  volume_base_24h: string | null;
  volume_quote_24h: string | null;
}
export const getPairStats24h = prepared<IGetPairStats24hParams, IGetPairStats24hResult>(
      // Reads the STORED verdicts. This CTE used to re-adjudicate every
      // archived offer inline — cancelledPredicate, the duplicate check and
      // the basket check, per row, on every chart request. A verdict cannot
      // change once written, so that work was pure repetition; the measured
      // cost is recorded on offer_file_history's fill-verdict columns.
      //
      // Stored colours are LEAST/GREATEST-normalised, but the CALLER may pass
      // :base!/:quote! either way round, so amounts and price are re-oriented
      // to the caller's base here. That keeps this query's contract identical
      // to the version it replaces.
      `WITH priced AS (${pricedFillsSql}
       ), fills AS (
         SELECT archived_at, offer_hash,
                CASE WHEN :base! = base_color
                     THEN quote_amount / NULLIF(base_amount, 0)
                     ELSE base_amount / NULLIF(quote_amount, 0) END AS price,
                CASE WHEN :base! = base_color THEN base_amount ELSE quote_amount END AS base_amt,
                CASE WHEN :base! = base_color THEN quote_amount ELSE base_amount END AS quote_amt
         FROM priced
         WHERE base_color = LEAST(:base!, :quote!)
           AND quote_color = GREATEST(:base!, :quote!)
       )
       SELECT
         (SELECT price FROM fills ORDER BY archived_at DESC, offer_hash DESC LIMIT 1)::text AS last_price,
         (SELECT price FROM fills
           WHERE archived_at <= :cutoff!
           ORDER BY archived_at DESC, offer_hash DESC LIMIT 1)::text AS ref_before_24h,
         (SELECT price FROM fills
           WHERE archived_at > :cutoff!
           ORDER BY archived_at ASC, offer_hash ASC LIMIT 1)::text AS oldest_in_24h,
         (SELECT COUNT(*)::int FROM fills
           WHERE archived_at > :cutoff!) AS fills_24h,
         (SELECT MAX(price) FROM fills
           WHERE archived_at > :cutoff!)::text AS high_24h,
         (SELECT MIN(price) FROM fills
           WHERE archived_at > :cutoff!)::text AS low_24h,
         (SELECT SUM(base_amt) FROM fills
           WHERE archived_at > :cutoff!)::text AS volume_base_24h,
         (SELECT SUM(quote_amt) FROM fills
           WHERE archived_at > :cutoff!)::text AS volume_quote_24h`,
);

// ── Trade history ──────────────────────────────────────────────────────────
// Classified replacement for the generated GetTradeHistory: cancels must not
// render as trades. LIMIT 120 is fine HERE (display list) — stats never use
// this query (see getPairStats24h).

export interface IGetTradeHistoryParams {
  base: string;
  quote: string;
}
export interface IGetTradeHistoryResult {
  at_ms: string;
  g_color: string;
  g_amt: string;
  w_color: string;
  w_amt: string;
}
export const getTradeHistory = prepared<IGetTradeHistoryParams, IGetTradeHistoryResult>(
      // Reads the STORED verdicts, like getPairStats24h. The g_color/g_amt,
      // w_color/w_amt shape is kept verbatim so trade-data.ts's toFill() is
      // untouched: it re-orients to the caller's base itself, and duplicating
      // that here would be a second place to get it wrong.
      `WITH priced AS (${pricedFillsSql}
       )
       SELECT (EXTRACT(EPOCH FROM archived_at) * 1000)::bigint AS at_ms,
              base_color  AS g_color, base_amount::text  AS g_amt,
              quote_color AS w_color, quote_amount::text AS w_amt
       FROM priced
       WHERE base_color = LEAST(:base!, :quote!)
         AND quote_color = GREATEST(:base!, :quote!)
       -- Same tie-break as everywhere else: the newest row here is the trade
       -- /v1/chart/stats calls last_price, and a list whose order changes
       -- between identical requests is its own defect.
       ORDER BY archived_at DESC, offer_hash DESC
       LIMIT 120`,
);

export interface IGetOpenLegsParams {
  base: string;
  quote: string;
}
export interface IGetOpenLegsResult {
  g_color: string;
  g_amt: string;
  w_color: string;
  w_amt: string;
}
export const getOpenLegs = prepared<IGetOpenLegsParams, IGetOpenLegsResult>(
      `SELECT g.token_color AS g_color, g.amount AS g_amt,
              w.token_color AS w_color, w.amount AS w_amt
       FROM offer_file o
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens
             WHERE direction = 'GIVING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) g ON g.offer_file_id = o.id
       JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric)::text AS amount
             FROM offer_file_tokens
             WHERE direction = 'WANTING' AND token_color IN (:base!, :quote!)
             GROUP BY 1, 2) w ON w.offer_file_id = o.id
       WHERE ${notABasketPredicate("o.id", "offer_file_tokens")}
         AND ((g.token_color = :base! AND w.token_color = :quote!)
           OR (g.token_color = :quote! AND w.token_color = :base!))`,
);

// ── Token prices ───────────────────────────────────────────────────────────

export interface IGetTokenPriceParams { token_color: string }
export interface IGetTokenPriceResult { price_usd: string }
export const getTokenPrice = prepared<IGetTokenPriceParams, IGetTokenPriceResult>(
      "SELECT price_usd FROM token_prices WHERE token_color = :token_color!",
);

export interface IUpsertTokenPriceParams { token_color: string; price_usd: number }
export type IUpsertTokenPriceResult = void;
export const upsertTokenPrice = prepared<IUpsertTokenPriceParams, IUpsertTokenPriceResult>(
      `INSERT INTO token_prices (token_color, price_usd)
       VALUES (:token_color!, :price_usd!)
       ON CONFLICT (token_color) DO NOTHING`,
);

// ── Known tokens (duplicate-check queries) ─────────────────────────────────

export interface ICheckTokenNameExistsParams { name: string }
export interface ICheckTokenNameExistsResult { present: number }
export const checkTokenNameExists = prepared<ICheckTokenNameExistsParams, ICheckTokenNameExistsResult>(
      "SELECT 1 AS present FROM known_tokens WHERE name = :name! LIMIT 1",
);

export interface IGetTokenByColorParams { token_color: string }
export interface IGetTokenByColorResult { name: string }
export const getTokenByColor = prepared<IGetTokenByColorParams, IGetTokenByColorResult>(
      "SELECT name FROM known_tokens WHERE token_color = :token_color! LIMIT 1",
);

// ── Pair stats ─────────────────────────────────────────────────────────────

export interface IAdjudicateOfferFillParams { offer_id: number }
export interface IAdjudicateOfferFillResult {
  id: number;
  settled: boolean;
  base_color: string | null;
  quote_color: string | null;
}
/**
 * Write the fill verdict for ONE archived offer, once.
 *
 * This replaces the pair_stats increment and runs in the same place: the
 * api.ts listener, on the post-commit-gated lifecycle event. That instant is
 * not incidental — it is the first moment the offer's evidence is guaranteed
 * visible to another connection, because Midnight-UnshieldedSpend is
 * configured BEFORE Midnight-UnshieldedCreate, so inside the archiving
 * transaction the same block's create rows do not exist yet.
 *
 * Idempotent: it recomputes from the same evidence and writes the same answer,
 * so a retry, a replay, or the repair sweep can all run it again safely. That
 * is what the old `trade_count + 1` could not be.
 *
 * base/quote/amounts are set only when the fill is a PRICE OBSERVATION —
 * settled, one colour per side, both amounts non-zero. A settled basket stores
 * settled = true with NULL colours, which is the honest answer: it happened,
 * and it is not a price.
 */
export const adjudicateOfferFill = prepared<IAdjudicateOfferFillParams, IAdjudicateOfferFillResult>(
      `UPDATE offer_file_history h
          SET settled = NOT ${cancelledPredicate("h.id")},
              base_color = leg.base_color,
              quote_color = leg.quote_color,
              base_amount = leg.base_amount,
              quote_amount = leg.quote_amount
         FROM (
             SELECT
                 CASE WHEN ok THEN base_color END AS base_color,
                 CASE WHEN ok THEN quote_color END AS quote_color,
                 CASE WHEN ok THEN base_amount END AS base_amount,
                 CASE WHEN ok THEN quote_amount END AS quote_amount
             FROM (
                 SELECT
                     LEAST(g.token_color, w.token_color) AS base_color,
                     GREATEST(g.token_color, w.token_color) AS quote_color,
                     CASE WHEN g.token_color = LEAST(g.token_color, w.token_color)
                          THEN g.amount ELSE w.amount END AS base_amount,
                     CASE WHEN g.token_color = LEAST(g.token_color, w.token_color)
                          THEN w.amount ELSE g.amount END AS quote_amount,
                     -- A PRICE OBSERVATION requires all four. A settled offer
                     -- that is not a price (a basket, or a cancel) is stored
                     -- settled = true with NULL colours — "it happened, it was
                     -- not a price". The duplicate-wrapper case used to land
                     -- here too; it cannot arise any more, because marker dedup
                     -- refuses the second wrapper at ingestion.
                     (g.amount > 0 AND w.amount > 0
                      AND ${notABasketPredicate("g.offer_file_id", "offer_file_tokens_history")}
                      AND NOT ${cancelledPredicate("g.offer_file_id")}) AS ok
                 FROM (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
                       FROM offer_file_tokens_history
                       WHERE direction = 'GIVING' AND offer_file_id = :offer_id!
                       GROUP BY 1, 2) g
                 JOIN (SELECT offer_file_id, token_color, SUM(amount::numeric) AS amount
                       FROM offer_file_tokens_history
                       WHERE direction = 'WANTING' AND offer_file_id = :offer_id!
                       GROUP BY 1, 2) w ON w.offer_file_id = g.offer_file_id
             ) legs
         ) leg
        WHERE h.id = :offer_id!
          AND h.archive_reason = 'CONSUMED'
        RETURNING h.id, h.settled, h.base_color, h.quote_color`,
);

export interface IFindUnadjudicatedFillsParams { limit: number }
export interface IFindUnadjudicatedFillsResult { id: number }
/**
 * The repair sweep: archived offers that still owe a verdict.
 *
 * This is what makes a lost adjudication recoverable instead of permanent
 * drift, and it is why the durability of the write stopped mattering. The
 * partial index on (archive_reason = 'CONSUMED' AND settled IS NULL) makes it
 * cost O(missing) rather than O(history), so it can run often and cheaply.
 *
 * An unadjudicated offer is ABSENT from market data until repaired — never
 * silently counted as a cancel, which would be a fabricated non-trade.
 */
export const findUnadjudicatedFills = prepared<IFindUnadjudicatedFillsParams, IFindUnadjudicatedFillsResult>(
      `SELECT id FROM offer_file_history
        WHERE archive_reason = 'CONSUMED' AND settled IS NULL
        ORDER BY archived_at
        LIMIT :limit!`,
);

/**
 * The `/v1/pairs` ordering CONTRACT (§8, ruled 2026-08-10).
 *
 * "Liquidity first; we want to always show the major players — and make the
 * users see by default the largest pools." So `open_count` leads and recency
 * only breaks its ties.
 *
 * `pair_key` last is MANDATORY, not tidiness: `last_traded_at` quantises to L2
 * block time, so full ties on both keys are common, and without a deterministic
 * final key two replicas can order the same pairs differently — which p7a's
 * A-vs-B byte comparison would report as a phantom failure.
 *
 * Exported because the tiebreaker is not observable from data: `pair_key` is
 * built from the grouped colours, so an aggregate already tends to return it
 * sorted and a fixture cannot tell "ordered by pair_key" from "happened to come back
 * sorted". A test asserting this string is the only honest way to pin it; the
 * liquidity-first half IS data-observable and is asserted normally.
 * Documented for clients in API.md.
 */
export const PAIRS_ORDER_BY = "open_count DESC, last_traded_at DESC NULLS LAST, pair_key";

export interface IGetPairsResult {
  pair_key: string;
  base_color: string;
  quote_color: string;
  trade_count: number;
  last_price: string | null;
  last_traded_at: DateOrString | null;
  open_count: number;
}
export const getPairs = prepared<void, IGetPairsResult>(
      // Aggregated from the stored fill verdicts, not from a projection table.
      //
      // pair_stats used to hold these numbers and was incremented once per
      // archived offer by an event listener. That was a second implementation
      // of "is this a fill", and it drifted from the read side independently —
      // measured on a live chain as trade_count 7 for five settlements. With
      // the verdict adjudicated once and stored, there is one source and
      // nothing to reconcile, and this GROUP BY runs over a partial index
      // (settled AND base_color IS NOT NULL) rather than re-deriving history.
      //
      // DISTINCT ON gives last_price the newest fill per pair; the FULL OUTER
      // JOIN keeps pairs that have only open offers (no fills yet) and pairs
      // that have only history (no open offers).
      `WITH priced AS (${pricedFillsSql}
       ),
       fills AS (
           SELECT base_color, quote_color,
                  COUNT(*)::int AS trade_count,
                  MAX(archived_at) AS last_traded_at
           FROM priced
           GROUP BY base_color, quote_color
       ),
       newest AS (
           SELECT DISTINCT ON (base_color, quote_color)
                  base_color, quote_color,
                  quote_amount / NULLIF(base_amount, 0) AS last_price
           FROM priced
           -- archived_at is the L2 block time and quantises, so ties are
           -- routine. offer_hash breaks them: content-addressed, therefore
           -- identical on every replica, unlike the deployment-local SERIAL.
           -- getPairStats24h orders the same way, which is what makes
           -- /v1/pairs and /v1/chart/stats agree instead of each picking a
           -- different trade from the same instant.
           ORDER BY base_color, quote_color, archived_at DESC, offer_hash DESC
       ),
       hist AS (
           SELECT f.base_color || '|' || f.quote_color AS pair_key,
                  f.base_color, f.quote_color, f.trade_count,
                  n.last_price, f.last_traded_at
           FROM fills f
           JOIN newest n ON n.base_color = f.base_color AND n.quote_color = f.quote_color
       )
       SELECT
           COALESCE(hist.pair_key, live.pair_key) AS pair_key,
           COALESCE(hist.base_color, split_part(live.pair_key, '|', 1)) AS base_color,
           COALESCE(hist.quote_color, split_part(live.pair_key, '|', 2)) AS quote_color,
           COALESCE(hist.trade_count, 0) AS trade_count,
           hist.last_price,
           hist.last_traded_at,
           COALESCE(live.open_count, 0) AS open_count
       FROM hist
       FULL OUTER JOIN (
           SELECT
               LEAST(g.token_color, w.token_color) || '|' || GREATEST(g.token_color, w.token_color) AS pair_key,
               COUNT(*)::int AS open_count
           FROM offer_file_tokens g
           JOIN offer_file_tokens w ON w.offer_file_id = g.offer_file_id AND w.direction = 'WANTING'
           WHERE g.direction = 'GIVING'
             AND ${notABasketPredicate("g.offer_file_id", "offer_file_tokens")}
           GROUP BY 1
       ) live ON live.pair_key = hist.pair_key
       ORDER BY ${PAIRS_ORDER_BY}`,
);

// ── Offer hash (content-addressed lookups, MIP-0006 offerId) ───────────────
// offer_hash = hex sha256 of the raw MIP-0005 transaction bytes. These
// supersede the generated InsertOfferFile / GetOfferFiles for call sites that
// carry the hash; fold them into queries.sql on the next pgtyped regeneration.

export interface IInsertOfferFileWithHashParams {
  celestia_height: NumberOrString;
  transaction_hex: string;
  offer_hash: string;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  /**
   * NOT nullable — the column is NOT NULL (migration 015) because keyset
   * every writer sets it. The SQL already required it (`:first_seen_at!`);
   * the type said otherwise, so a caller could pass null and only find out at
   * runtime. Chain-derived: state-machine.ts computes it from the earliest
   * proof-root first-seen, or the Celestia block time.
   */
  first_seen_at: DateOrString;
  ttl_seconds: NumberOrString | null;
}
export interface IInsertOfferFileWithHashResult { id: number }
export const insertOfferFileWithHash = prepared<IInsertOfferFileWithHashParams, IInsertOfferFileWithHashResult>(
      `INSERT INTO offer_file (
           celestia_height,
           transaction_hex,
           offer_hash,
           metadata_created_at,
           metadata_expires_at,
           first_seen_at,
           ttl_seconds
       ) VALUES (
           :celestia_height!,
           :transaction_hex!,
           :offer_hash!,
           :metadata_created_at!,
           :metadata_expires_at!,
           :first_seen_at!,
           COALESCE(:ttl_seconds!, 3600)
       ) RETURNING id`,
);

// ── Fill vs cancel (read-time classification, phase 1) ─────────────────────
//
// Settlement is atomic: a fill consumes ALL of an offer's inputs in ONE
// Midnight transaction. So an archived-CONSUMED offer is CANCELLED — with
// certainty — when either
//   (a) some of its nullifiers were never spent at all (the maker moved one
//       coin elsewhere; the rest can now never settle), or
//   (b) its nullifiers were spent across MORE THAN ONE transaction.
// Everything else stays `consumed`. All-in-one-tx is a heuristic (a maker
// consolidating the same coins in one personal tx looks identical) until
// phase 2 adds output-commitment tracking; offers with no shielded inputs
// (unshielded-only) have no nullifiers to group and classify as `consumed`.
//
// Read-time on purpose: the archive fires on the FIRST nullifier event of a
// block, before its same-tx siblings are processed — but the whole block
// commits in one DB transaction, so readers only ever see complete state.
//
// `idExpr` is the SQL expression for the archived offer's id in the caller's
// scope (e.g. "offer_file_history.id" or "h.id").
// Nullifier insert that captures the spending transaction's hash. Supersedes
// the generated UpsertNullifier (which predates the tx_hash column) at the
// STM call site; ON CONFLICT keeps the FIRST-seen hash — a nullifier can only
// be spent once, so a second event for it is a replay, not new information.
export interface IInsertNullifierWithTxParams {
  nullifier: string;
  height: NumberOrString;
  tx_hash: string | null;
}
export type IInsertNullifierWithTxResult = void;
export const insertNullifierWithTx = prepared<IInsertNullifierWithTxParams, IInsertNullifierWithTxResult>(
      `INSERT INTO nullifiers (nullifier, height, tx_hash)
       VALUES (:nullifier!, :height!, :tx_hash!)
       ON CONFLICT (nullifier) DO NOTHING`,
);

// Leg insert carrying the MIP-0006 layer tag. Supersedes the generated
// InsertOfferFileToken (which predates the kind column) at the STM call site.
export interface IInsertOfferFileTokenWithKindParams {
  offer_file_id: number;
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export type IInsertOfferFileTokenWithKindResult = void;
export const insertOfferFileTokenWithKind = prepared<IInsertOfferFileTokenWithKindParams, IInsertOfferFileTokenWithKindResult>(
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
       VALUES (:offer_file_id!, :token_color!, :amount!, :direction!, :kind!)`,
);

// Open + archived in one probe: dedup gate at ingestion/submit, and the
// status half of GET /api/zswaps/:hash.
export interface IGetOfferStatusByHashParams { offer_hash: string }
export interface IGetOfferStatusByHashResult {
  id: number;
  status: string;
  archive_reason: string | null;
}
export const getOfferStatusByHash = prepared<IGetOfferStatusByHashParams, IGetOfferStatusByHashResult>(
      `SELECT id, 'live' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id,
           (${archivedStatusCase("offer_file_history.id")}) AS status,
           archive_reason
       FROM offer_file_history
       WHERE offer_hash = :offer_hash!`,
);

export interface IGetOfferByHashParams { offer_hash: string }
export interface IGetOfferByHashResult {
  id: number;
  celestia_height: NumberOrString;
  transaction_hex: string;
  offer_hash: string;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  first_seen_at: DateOrString | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
  status: string;
  archive_reason: string | null;
}
export const getOfferByHash = prepared<IGetOfferByHashParams, IGetOfferByHashResult>(
      `SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, first_seen_at,
              ttl_seconds, created_at,
              'live' AS status, NULL::text AS archive_reason
       FROM offer_file
       WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT id, celestia_height, transaction_hex, offer_hash,
              metadata_created_at, metadata_expires_at, first_seen_at,
              ttl_seconds, created_at,
              (${archivedStatusCase("offer_file_history.id")}) AS status,
              archive_reason
       FROM offer_file_history
       WHERE offer_hash = :offer_hash!
       LIMIT 1`,
);

// Legs for one archived-or-open offer; `live` picks the table.
export interface IGetOfferTokensAnyParams { offer_file_id: number; live: boolean }
export interface IGetOfferTokensAnyResult {
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export const getOfferTokensAny = prepared<IGetOfferTokensAnyParams, IGetOfferTokensAnyResult>(
      `SELECT token_color, amount, direction, kind FROM offer_file_tokens
       WHERE :live! AND offer_file_id = :offer_file_id!
       UNION ALL
       SELECT token_color, amount, direction, kind FROM offer_file_tokens_history
       WHERE NOT :live! AND offer_file_id = :offer_file_id!`,
);

// Chain-side commitment record from the Midnight:NullifierAndCommitment
// primitive (kind: "commitment" events). Commitments are globally unique for
// the life of the chain, so ON CONFLICT DO NOTHING makes replays idempotent;
// first-seen wins, matching insertNullifierWithTx.
export interface IInsertCommitmentParams {
  commitment: string;
  tx_hash: string | null;
  mt_index: string | null;
  height: number;
}
export const insertCommitment = prepared<IInsertCommitmentParams, never>(
      `INSERT INTO commitments (commitment, tx_hash, mt_index, height)
       VALUES (:commitment!, :tx_hash!, :mt_index!, :height!)
       ON CONFLICT (commitment) DO NOTHING`,
);

// The offer's own shielded output commitments, captured at ingestion from the
// published blob. These are the fill markers: a settling tx must create all
// of them (merging preserves outputs verbatim).
export interface IInsertOfferFileCommitmentParams {
  offer_file_id: number;
  commitment: string;
}
export const insertOfferFileCommitment = prepared<IInsertOfferFileCommitmentParams, never>(
      `INSERT INTO offer_file_commitments (offer_file_id, commitment)
       VALUES (:offer_file_id!, :commitment!)
       ON CONFLICT DO NOTHING`,
);

// ── Unshielded classification (migration 014) ───────────────────────────────
// The three inserts that give the unshielded layer the same evidence the
// shielded layer has had since 013. Each mirrors its shielded counterpart
// exactly, including first-seen-wins on replay.

// Chain-side spend record. Distinct from deleteCreatedUnshielded, which mutates
// the LIVE set: this is the permanent "what was consumed, and by which tx"
// record that read-time classification consults, the analogue of `nullifiers`.
export interface IInsertUnshieldedSpendParams {
  owner: string;
  intent_hash: string;
  output_no: number;
  tx_hash: string | null;
  height: number;
}
export const insertUnshieldedSpend = prepared<IInsertUnshieldedSpendParams, never>(
      `INSERT INTO unshielded_spends (owner, intent_hash, output_no, tx_hash, height)
       VALUES (:owner!, :intent_hash!, :output_no!, :tx_hash!, :height!)
       ON CONFLICT (owner, intent_hash, output_no) DO NOTHING`,
);

// Chain-side create record — the analogue of `commitments`. Permanent on
// purpose: created_unshielded deletes on spend, which would retroactively erase
// the proof that a settlement happened and silently reclassify a historical
// fill as a cancel.
export interface IInsertUnshieldedCreateParams {
  owner: string;
  intent_hash: string;
  output_no: number;
  tx_hash: string | null;
  token_type: string;
  value: string;
  height: number;
}
export const insertUnshieldedCreate = prepared<IInsertUnshieldedCreateParams, never>(
      `INSERT INTO unshielded_creates (owner, intent_hash, output_no, tx_hash, token_type, value, height)
       VALUES (:owner!, :intent_hash!, :output_no!, :tx_hash!, :token_type!, :value!, :height!)
       ON CONFLICT (owner, intent_hash, output_no) DO NOTHING`,
);

// The offer's own declared unshielded outputs — its fill markers on that layer.
export interface IInsertOfferFileUnshieldedOutputParams {
  offer_file_id: number;
  owner: string;
  intent_hash: string;
  output_no: number;
  token_type: string;
  value: string;
}
export const insertOfferFileUnshieldedOutput = prepared<IInsertOfferFileUnshieldedOutputParams, never>(
      `INSERT INTO offer_file_unshielded_outputs
         (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
       VALUES (:offer_file_id!, :owner!, :intent_hash!, :output_no!, :token_type!, :value!, 1)
       ON CONFLICT (offer_file_id, owner, intent_hash, output_no)
       DO UPDATE SET count = offer_file_unshielded_outputs.count + 1`,
);

// ── Marker dedup, rule (ii) — ruled 2026-08-18 ──────────────────────────────
//
// "Does an ACTIVE offer already claim this marker?", asked once per declared
// marker at BOTH doors. The rule, its placement after crypto and the
// first-wins argument live in packages/node/marker-dedup.ts; these are the two
// probes it is made of, one per layer.
//
// ACTIVE needs no predicate. Archival DELETEs the live row and the marker rows
// cascade, so presence in these tables IS the live book — which is also what
// keeps this O(live book) instead of O(history).
//
// ORDER BY offer_hash, never the SERIAL id: the id is deployment-local and p7a
// compares instance A against B, so an id-keyed choice of incumbent would swap
// a dedup answer for a determinism failure. LIMIT 1 because the caller needs
// one name for the reason string, not the set.
//
// Both probes are index-served — see the two indexes added for exactly this
// direction of lookup in 000-init.sql. Without them each accepted offer costs a
// sequential scan of the live book per declared marker, at both doors.
export interface IFindActiveOfferByCommitmentParams { commitment: string }
export interface IFindActiveOfferByCommitmentResult {
  offer_file_id: number;
  offer_hash: string | null;
}
export const findActiveOfferByCommitment = prepared<IFindActiveOfferByCommitmentParams, IFindActiveOfferByCommitmentResult>(
      `SELECT c.offer_file_id, o.offer_hash
         FROM offer_file_commitments c
         JOIN offer_file o ON o.id = c.offer_file_id
        WHERE c.commitment = :commitment!
        ORDER BY o.offer_hash
        LIMIT 1`,
);

export interface IFindActiveOfferByUnshieldedOutputParams {
  owner: string;
  intent_hash: string;
  output_no: number;
}
export interface IFindActiveOfferByUnshieldedOutputResult {
  offer_file_id: number;
  offer_hash: string | null;
}
export const findActiveOfferByUnshieldedOutput = prepared<IFindActiveOfferByUnshieldedOutputParams, IFindActiveOfferByUnshieldedOutputResult>(
      `SELECT u.offer_file_id, o.offer_hash
         FROM offer_file_unshielded_outputs u
         JOIN offer_file o ON o.id = u.offer_file_id
        WHERE u.owner = :owner!
          AND u.intent_hash = :intent_hash!
          AND u.output_no = :output_no!
        ORDER BY o.offer_hash
        LIMIT 1`,
);

// Batched nullifiers for a page of offers — computed.inputNullifiers in the
// MIP-0006 payload (the keys an indexer watches to mark an offer consumed).
export interface IGetOfferNullifiersForOffersParams { offer_file_ids: number[]; live: boolean }
export interface IGetOfferNullifiersForOffersResult { offer_file_id: number; nullifier: string }
export const getOfferNullifiersForOffers = prepared<IGetOfferNullifiersForOffersParams, IGetOfferNullifiersForOffersResult>(
      `SELECT offer_file_id, nullifier FROM offer_file_nullifiers
       WHERE :live! AND offer_file_id = ANY(:offer_file_ids!)
       UNION ALL
       SELECT offer_file_id, nullifier FROM offer_file_nullifiers_history
       WHERE NOT :live! AND offer_file_id = ANY(:offer_file_ids!)`,
);

// Batched legs for a page of open offers (kills the per-offer N+1 in the list).
export interface IGetOfferTokensForOffersParams { offer_file_ids: number[] }
export interface IGetOfferTokensForOffersResult {
  offer_file_id: number;
  token_color: string;
  amount: string;
  direction: string;
  kind: string;
}
export const getOfferTokensForOffers = prepared<IGetOfferTokensForOffersParams, IGetOfferTokensForOffersResult>(
      `SELECT offer_file_id, token_color, amount, direction, kind
       FROM offer_file_tokens
       WHERE offer_file_id = ANY(:offer_file_ids!)`,
);

// List page without the ~24 KB blob; blob_chars lets UIs size downloads.
// EXISTS instead of JOIN + DISTINCT: the join duplicated each offer per leg
// and forced a 9-column dedup before the sort; EXISTS lets the planner walk
// the (created_at, id) index and stop at LIMIT (measured 12× faster at 5k
// offers, and the gap widens with book size). When :token is '' the OR
// short-circuits — no probe at all on the unfiltered path.
//
// Pagination is KEYSET, not OFFSET: the caller resolves an `after_hash`
// cursor to the anchor row's (created_at, id) via resolveOfferCursor and
// passes both here (or nulls for the first page). The row-value comparison
// seeks straight to the anchor position in idx_offer_file_created_at_id —
// no O(offset) discard, and concurrent inserts/archives cannot shift the
// page window. `id` tie-breaks offers sharing a created_at; it stays
// server-side (the public cursor is the offer_hash).
export interface IGetOpenOffersPageParams {
  token: string;
  direction: string;
  limit: number;
  // Keyset anchor: the PUBLICATION tuple, both parts chain/content-derived.
  // NOT (first_seen_at, id) — see the ORDER BY note below.
  after_height: NumberOrString | null;
  after_hash: string | null;
}
export interface IGetOpenOffersPageResult {
  id: number;
  celestia_height: NumberOrString;
  offer_hash: string | null;
  blob_chars: number;
  metadata_created_at: DateOrString | null;
  metadata_expires_at: DateOrString | null;
  first_seen_at: DateOrString | null;
  ttl_seconds: NumberOrString | null;
  created_at: DateOrString | null;
}
// Keyset pagination on (celestia_height, offer_hash) — the PUBLICATION tuple.
//
// Two earlier keys were wrong for the same underlying reason, that the sort key
// must be a fact every replica agrees on:
//
//   created_at  — DEFAULT NOW(), node-local wall clock. Page order was decided
//     by when THIS node inserted each row, so two replicas served the same book
//     in different orders. Invisible to the determinism replay BY CONSTRUCTION,
//     since created_at is in DIFF_EXCLUDED_COLUMNS.
//
//   first_seen_at — chain-derived, but for a SHIELDED offer it comes from
//     known_roots.first_seen_ms: the block in which THIS NODE first observed
//     the proof root. A replica started at a later MIDNIGHT_START_BLOCK records
//     a later value and orders the book differently. The determinism suite
//     cannot see this either — main.grand-b.ts uses startBlockHeight 1 on every
//     primitive, so both instances agree by construction, not by guarantee.
//     It is also proof-root age, not publication time, so "newest first" did
//     not mean what the API says it means.
//
// celestia_height is the DA height the offer was published at, and offer_hash
// is the sha256 of its canonical bytes (the MIP-0006 offerId). Neither depends
// on sync start, insertion order or SERIAL assignment, both are NOT NULL, and
// ties break identically on every node — so `id` is no longer needed as the
// tiebreaker. This tuple is what "newest first" should have meant all along.
export const getOpenOffersPage = prepared<IGetOpenOffersPageParams, IGetOpenOffersPageResult>(
      `SELECT o.id, o.celestia_height, o.offer_hash,
              LENGTH(o.transaction_hex)::int AS blob_chars,
              o.metadata_created_at, o.metadata_expires_at, o.first_seen_at,
              o.ttl_seconds, o.created_at
       FROM offer_file o
       WHERE
         (:token! = '' OR EXISTS (
           SELECT 1 FROM offer_file_tokens oft
           WHERE oft.offer_file_id = o.id
             AND oft.token_color = :token!
             AND (:direction! = 'ANY' OR oft.direction = :direction!)))
         AND (:after_hash!::text IS NULL
              OR (o.celestia_height, o.offer_hash) < (:after_height!::bigint, :after_hash!::text))
       ORDER BY o.celestia_height DESC, o.offer_hash DESC
       LIMIT :limit!`,
);

// Resolve an `after_hash` cursor to its keyset anchor. Checks history too: if
// the anchor offer was consumed/expired mid-pagination its row moved tables,
// but (celestia_height, offer_hash) is copied on archive, so the cursor stays
// valid and the reader continues exactly where they left off.
export interface IResolveOfferCursorParams { offer_hash: string }
export interface IResolveOfferCursorResult {
  celestia_height: string;
  offer_hash: string;
}
export const resolveOfferCursor = prepared<IResolveOfferCursorParams, IResolveOfferCursorResult>(
      `SELECT celestia_height, offer_hash FROM offer_file WHERE offer_hash = :offer_hash!
       UNION ALL
       SELECT celestia_height, offer_hash FROM offer_file_history WHERE offer_hash = :offer_hash!
       LIMIT 1`,
);

// The DELETE returns the content address alongside the row id so the archiving
// transition can put it on the lifecycle event. Nullable because rows inserted
// out-of-band before migration 005 have no hash.
export interface IArchiveOfferResult { id: number; offer_hash: string | null }

export interface IArchiveOfferByNullifierWithHashParams { nullifier: string; archived_at: DateOrString }
export const archiveOfferByNullifierWithHash = prepared<IArchiveOfferByNullifierWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT DISTINCT offer_file_id
    FROM offer_file_nullifiers
    WHERE nullifier = :nullifier!`,
        "CONSUMED",
      ),
);

export interface IArchiveOfferByUnshieldedSpendWithHashParams {
  owner: string;
  intent_hash: string;
  output_no: number;
  archived_at: DateOrString;
}
export const archiveOfferByUnshieldedSpendWithHash = prepared<IArchiveOfferByUnshieldedSpendWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT DISTINCT offer_file_id
    FROM offer_file_unshielded_spends
    WHERE owner = :owner!
      AND intent_hash = :intent_hash!
      AND output_no = :output_no!`,
        "CONSUMED",
      ),
);

export interface IArchiveOfferByIdTtlWithHashParams { offer_file_id: number; archived_at: DateOrString }
export const archiveOfferByIdTtlWithHash = prepared<IArchiveOfferByIdTtlWithHashParams, IArchiveOfferResult>(
      archiveOfferSql(
        `    SELECT id AS offer_file_id
    FROM offer_file
    WHERE id = :offer_file_id!
    LIMIT 1`,
        "TTL",
      ),
);

// ── Rejected-blob cleanup (framework table) ────────────────────────────────
//
// The framework persists EVERY blob it fetches from the namespace into
// effectstream.primitive_accounting, permanently — the STM's own scheduled
// input is deleted after processing, but this accounting row is not. Since
// the Celestia namespace is permissionless, that is unbounded,
// attacker-controlled storage: anyone can park megabytes in our DB for the
// price of a blob fee, and every byte is copied again into the generated
// md5(payload) column.
//
// So when the STM rejects an offer, it DELETEs the row in the same block
// transaction that created it. Blanking the body in place was the other
// option; deleting wins because the row's only remaining value would have
// been "a blob was seen here" — which offer_rejections records in bounded,
// aggregated form, along with the reject reason the accounting row never
// carried. Deleting also sidesteps the table's UNIQUE index on
// (primitive_name, height, md5(payload)), which any in-place rewrite has to
// avoid colliding with.
//
// Safe to delete: the insert is ON CONFLICT DO NOTHING, no foreign key
// references the table, and nothing in the framework's production path reads
// it back (only its own reproduction tests do). Deterministic: a replay
// re-fetches, re-rejects, and re-deletes identically.
//
// The table's only usable index is
// (primitive_name, effectstream_block_height, payload_hash), so BOTH leading
// columns must be constrained: filtering on height alone still "uses" the
// index but walks all of it, across every primitive's rows — measured 137×
// the cost, and it grows with total node activity rather than with blob
// volume. With primitive_name it is a two-column prefix seek down to the
// handful of blobs at that height, and only then the body comparison.
// Matched on the body's JSON ENCODING as a substring of payload::text, never
// on the body itself. A blob body is arbitrary bytes and every real Midnight
// transaction contains 0x00, which Postgres cannot represent as text: reading
// the stored value raises "unsupported Unicode escape sequence", and binding
// the raw body as a parameter raises "invalid byte sequence for encoding
// UTF8: 0x00". Either aborts the block transaction, and because the runtime
// routes state-transition errors to telemetry only, that surfaced as an
// unexplained sync exit (25P02 on the next statement) which took the whole
// orchestrator down. It fired on ORDINARY rejections of genuine transactions
// (the live crash was a NOT_A_SWAP), and since reading the stored row is one
// of the failing halves, a single such blob broke the scrub for every blob at
// that height. Found by packages/tests/grand-e2e.
//
// JSON spells the byte as six literal ASCII characters, so payload::text is
// ASCII-escaped, the parameter is ASCII, and nothing is ever unescaped.
// Substring rather than a whole-document/md5 match on purpose: the framework
// owns that document's shape, and an md5 of a re-serialized document passed
// every unit test then silently matched NOTHING live — removing the crash
// while quietly disabling the scrub this DELETE exists for. A needle taken
// from the body alone cannot drift with key order or added fields. The two
// leading index columns still seek to the blobs at that height.
export interface IDeleteRejectedAccountingRowParams {
  primitive_name: string;
  block_height: number;
  supplied_json: string;
}
export type IDeleteRejectedAccountingRowResult = void;
export const deleteRejectedAccountingRow = prepared<IDeleteRejectedAccountingRowParams, IDeleteRejectedAccountingRowResult>(
      `DELETE FROM effectstream.primitive_accounting
       WHERE primitive_name = :primitive_name!
         AND effectstream_block_height = :block_height!
         AND position(:supplied_json! in payload::text) > 0`,
);

// Aggregated rejection counter — what survives a discarded blob. Bounded by
// (heights with a rejection) × (distinct codes), never by blob count, so it
// cannot itself be inflated by spam. See migrations/006-offer-rejections.sql.
export interface IRecordOfferRejectionParams {
  celestia_height: NumberOrString;
  code: string;
}
export type IRecordOfferRejectionResult = void;
export const recordOfferRejection = prepared<IRecordOfferRejectionParams, IRecordOfferRejectionResult>(
      `INSERT INTO offer_rejections (celestia_height, code, count)
       VALUES (:celestia_height!, :code!, 1)
       ON CONFLICT (celestia_height, code)
       DO UPDATE SET count = offer_rejections.count + 1`,
);

// Recent rejection activity, newest height first — the ops view of "is
// something spamming the namespace, and with what?".
export interface IGetRecentRejectionsParams { limit: number }
export interface IGetRecentRejectionsResult {
  celestia_height: NumberOrString;
  code: string;
  count: number;
}
export const getRecentRejections = prepared<IGetRecentRejectionsParams, IGetRecentRejectionsResult>(
      `SELECT celestia_height, code, count
       FROM offer_rejections
       ORDER BY celestia_height DESC, code
       LIMIT :limit!`,
);

// Root upsert that pins first_seen_ms on the FIRST insert and never moves it
// (COALESCE keeps the existing value on conflict) while still advancing
// last_seen_ms for the prune. Supersedes the generated UpsertKnownRoot at the
// STM call site.
export interface IUpsertKnownRootWithFirstSeenParams {
  root: string;
  height: NumberOrString;
  seen_ms: NumberOrString;
}
export type IUpsertKnownRootWithFirstSeenResult = void;
export const upsertKnownRootWithFirstSeen = prepared<IUpsertKnownRootWithFirstSeenParams, IUpsertKnownRootWithFirstSeenResult>(
      `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms)
       VALUES (:root!, :height!, :seen_ms!, :seen_ms!)
       ON CONFLICT (root) DO UPDATE
         SET height = EXCLUDED.height,
             last_seen_ms = EXCLUDED.last_seen_ms,
             first_seen_ms = COALESCE(known_roots.first_seen_ms, EXCLUDED.first_seen_ms)`,
);

// Root-known WITH the window enforced at read time. Supersedes the generated
// IsKnownRoot at both gates (API submit, STM ingestion), which had no age
// predicate — and pruning alone cannot provide one, because pruneKnownRoots
// only runs inside the midnight-zswap-root transition: when the chain stops
// producing roots, nothing prunes, and a quiet chain kept accepting offers
// proving against roots far outside ROOT_WINDOW_SECONDS (measured: rows 23
// minutes stale, none pruned; the "foreign" Lace fixture accepted on a
// 20-minute-old root).
//
// The MAX(height) escape is not a convenience — it is semantic parity with the
// ledger. past_roots is a TimeFilterMap that RE-INSERTS the current root every
// block (see the comment on rootTimingForRoots below), but our zswap-root
// primitive only fires when the root ADVANCES, so on a quiet chain the current
// root's last_seen_ms goes stale even though the real chain still accepts it.
// A bare age predicate would falsely reject offers the chain would settle.
// PruneKnownRoots guards the same edge with `height < MAX(height)`.
//
// :cutoff_ms! must be chain-derived (same clock as last_seen_ms — the L2 block
// timestamp): data.blockTimestamp at the STM gate, the latest processed
// block's ms_timestamp at the API gate. Never wall-clock.
export interface IIsKnownRootLiveParams {
  root: string;
  cutoff_ms: NumberOrString;
}
export interface IIsKnownRootLiveResult { present: number }
export const isKnownRootLive = prepared<IIsKnownRootLiveParams, IIsKnownRootLiveResult>(
      `SELECT 1 AS present
       FROM known_roots
       WHERE root = :root!
         AND (last_seen_ms >= :cutoff_ms!
              OR height >= (SELECT MAX(height) FROM known_roots))`,
);

// Root timing for a set of shielded input roots. Called at ingestion with
// the offer's just-validated inputRoots (all already in known_roots).
// NULL for an unshielded-only offer (empty root list).
//
// TWO DIFFERENT MINIMA, for two different questions — do not conflate them:
//
//   first_seen_ms — when the chain FIRST held this tree state. An offer
//     cannot predate its own proof root, so this is a deterministic lower
//     bound on the offer's age → computed.firstSeenAt.
//
//   last_seen_ms  — when the root was LAST current. This is the expiry
//     basis, because the ledger's `past_roots` is a TimeFilterMap that
//     RE-INSERTS the current root every block and evicts entries older than
//     `tblock − window` (zswap/src/ledger.rs). On a chain segment with no
//     new coin commitments the same root keeps being refreshed, so the
//     window runs from the last block whose tree state the offer proved
//     against — NOT from when the root (or the offer) first appeared.
//     Our pruneKnownRoots already mirrors this (`last_seen_ms < cutoff`).
//
// MIN across the offer's roots either way: the offer dies when the FIRST of
// its roots leaves the window.
//
// THE CURRENT-ROOT ESCAPE, and why it is inside the CASE rather than applied
// to the aggregate. `last_seen_ms` only advances when our midnight-zswap-root
// primitive observes a root ADVANCE, but the ledger re-inserts the CURRENT root
// every block regardless. So on a quiet chain the newest root's stored
// last_seen_ms goes stale while the chain still accepts proofs against it —
// which is how an offer got served `status: live` with an expiry eleven minutes
// in its own past (§2.6). isKnownRootLive already carries this escape for the
// read gate; this is the same rule for the derivation.
//
// The escape is evaluated PER ROW, before MIN. Taking MIN(last_seen_ms) first
// and then deciding "is any of them current?" would let a fresh current root
// lift a SUPERSEDED root's window, extending an offer past the point its oldest
// root actually dies. Per-root anchor, then minimum — never the reverse.
export interface IGetOfferRootTimingParams { roots: string[]; block_ms: NumberOrString }
export interface IGetOfferRootTimingResult {
  first_seen_ms: NumberOrString | null;
  /** MIN over per-root window anchors; + ROOT_WINDOW_SECONDS is the deadline. */
  window_anchor_ms: NumberOrString | null;
}
export const getOfferRootTiming = prepared<IGetOfferRootTimingParams, IGetOfferRootTimingResult>(
      `SELECT MIN(first_seen_ms) AS first_seen_ms,
              MIN(CASE WHEN height >= (SELECT MAX(height) FROM known_roots)
                       THEN GREATEST(last_seen_ms, :block_ms!)
                       ELSE last_seen_ms
                  END) AS window_anchor_ms
       FROM known_roots WHERE root = ANY(:roots!)`,
);

// NOTE: status-by-blob lookups go through offerHashFromBlob() + the
// getOfferStatusByHash index probe — never a literal transaction_hex
// comparison. A TEXT-equality query here would seq-scan both offer tables
// against ~24 KB strings and hand attackers a cheap DoS (POST junk blobs →
// full scans); btree can't index the column anyway (rows exceed the ~2.7 KB
// entry limit). Undecodable blobs must be answered without touching the DB.
