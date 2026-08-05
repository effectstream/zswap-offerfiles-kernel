import type { SyncStateUpdateStream } from "@effectstream/coroutine";
import { World } from "@effectstream/coroutine";
import { Stm } from "@effectstream/sm";
import type { BaseStfInput } from "@effectstream/sm";
import type { StartConfigGameStateTransitions } from "@effectstream/runtime";
import { MidnightBech32m } from "@midnight-ntwrk/wallet-sdk-address-format";
import { Buffer } from "node:buffer";
import { newScheduledTimestampData } from "@effectstream/db";
import { AddressType } from "@effectstream/utils";
import { getBlankRefState, validateZswapOfferBytes, verifyOfferCrypto, collectOutputCommitments } from "@zswap-da/validator";
import { latin1ToBytes, offerBytesToBech32, offerHashFromBytes } from "@zswap-da/offer-guard";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";

import {
  insertOfferFileWithHash,
  getOfferStatusByHash,
  deleteRejectedAccountingRow,
  recordOfferRejection,
  insertOfferFileNullifier,
  insertCommitment,
  insertOfferFileCommitment,
  insertOfferFileUnshieldedSpend,
  insertOfferFileTokenWithKind,
  archiveOfferByNullifierWithHash,
  archiveOfferByUnshieldedSpendWithHash,
  archiveOfferByIdTtlWithHash,
  insertNullifierWithTx,
  markNullifierMatched,
  findUnmatchedNullifier,
  isNullifierSpent,
  insertCreatedUnshielded,
  deleteCreatedUnshielded,
  isUnshieldedCreated,
  upsertKnownRootWithFirstSeen,
  getEarliestRootFirstSeen,
  isKnownRootLive,
  pruneKnownRoots,
} from "@zswap-da/database";

// ─── Indexer scope and known limitations ─────────────────────────────────────
//
// This template indexes published ZSwap offers and decides whether each is
// still *open* by watching the on-chain nullifiers (shielded) and
// unshielded UTXO refs of its inputs. Two limits are intentional:
//
//   1. Fill vs cancel is classified at READ time (cancelledPredicate in the
//      database package). Split/partial nullifier spends are definitive
//      cancels (settlement is atomic); and for offers with stored fill
//      markers (their output commitments, captured at ingestion) the
//      converse is exact too: the single spending tx must have created
//      those commitments, else it was a cancel — single-input included.
//      Only marker-less offers (pre-migration rows, unshielded-only wants)
//      keep the all-in-one-tx heuristic.
//
//   2. Archival is destructive (rows are DELETEd into history). If a
//      consuming Midnight/Celestia block is later reorged out, the offer
//      cannot be restored without a full resync. Only safe when
//      archive-triggering events come from finalized blocks; the
//      confirmation depth lives in the sync layer.
// ─────────────────────────────────────────────────────────────────────────────

import { canonicalRootHex } from "@zswap-da/validator";

import { grammar } from "./grammar.ts";
import { extractMidnightLedgerSnapshot } from "./zswap-logic.ts";
import { emitAppEvent } from "./event-bus.ts";
import {
  CELESTIA_PRIMITIVE_NAME,
  MIDNIGHT_NETWORK_ID,
  OFFER_MAX_BYTES,
  OFFER_TTL_SECONDS,
  ROOT_WINDOW_SECONDS,
} from "./env.ts";

// Normalize a value that may be a Uint8Array or a hex string into lowercase
// hex (no `0x` prefix). Used at offer-indexing for nullifiers, owner keys,
// and intent hashes — ledger-v8 returns these as either form depending on
// the field.
function bytesOrStringToHex(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex").toLowerCase();
  }
  if (typeof value === "string") {
    const clean = value.startsWith("0x") || value.startsWith("0X")
      ? value.slice(2)
      : value;
    return clean.toLowerCase();
  }
  return String(value).toLowerCase();
}

// The Midnight indexer returns unshielded `owner` as a Bech32m-encoded
// `UnshieldedAddress` string (e.g. `mn_addr_undeployed1...`). Decode it to
// the canonical 32-byte hex form so it matches the indexing-side
// `UtxoSpend.owner` (already hex). Pass-through for already-hex inputs.
function unshieldedOwnerToCanonicalHex(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex").toLowerCase();
  }
  if (typeof value === "string") {
    if (value.includes("1")) {
      try {
        const parsed = MidnightBech32m.parse(value);
        return parsed.data.toString("hex").toLowerCase();
      } catch {
        // Not bech32m; fall through to plain hex normalization.
      }
    }
    return bytesOrStringToHex(value);
  }
  return bytesOrStringToHex(value);
}

const stm = new Stm<typeof grammar, {}>(grammar);

/**
 * Register a transition whose failures are VISIBLE.
 *
 * The runtime catches state-transition errors and reports them to telemetry
 * only (`log.remote` in process-blocks.ts), so on a dev box a failing
 * transition produces no console output at all — the block transaction just
 * aborts and the next statement dies with a Postgres 25P02, surfacing as an
 * unexplained process exit. That is precisely how the 0x00 scrub crash
 * presented: hours of bisecting a silent death whose cause was a one-line SQL
 * error the engine had already caught and hidden.
 *
 * This wrapper logs and RETHROWS, so the runtime's rollback semantics are
 * unchanged — the only difference is that the operator can see what broke.
 * Kept in our code rather than as a node_modules patch so it survives
 * `bun install`.
 */
function addTransition(
  name: string,
  fn: (data: any) => Generator<any, any, any>,
): void {
  stm.addStateTransition(name as any, function* (data: any) {
    try {
      return yield* fn(data);
    } catch (err) {
      console.error(
        `[STF] transition "${name}" FAILED (block ${data?.blockHeight ?? "?"}) — ` +
          `this aborts the block transaction:`,
        err,
      );
      throw err;
    }
  } as any);
}

// Midnight:NullifierAndCommitment (effectstream#838) — one input per zswap
// ledger event, discriminated on payload.kind:
//   "nullifier"  → a shielded coin was SPENT  (ZswapInput)
//   "commitment" → a shielded coin was CREATED (ZswapOutput)
// Both kinds carry the ledger txHash. Together they are the exact
// fill-vs-cancel evidence: a fill's single settlement tx spends ALL of an
// offer's nullifiers AND creates the offer's output commitments; see
// cancelledPredicate in the database package.
addTransition("midnight-zswap-event", function* (data) {
  const { payload } = data.parsedInput;

  if (payload?.kind === "commitment") {
    // Coin created. Record it permanently (mirrors the nullifiers table —
    // globally unique, first-seen tx wins, replays are no-ops). No offer
    // matching happens here: commitments are consulted read-time by the
    // classification predicate, keyed on the spending tx's hash.
    try {
      yield* World.resolve(insertCommitment, {
        commitment: bytesOrStringToHex(payload.commitment),
        tx_hash: payload?.txHash ? bytesOrStringToHex(payload.txHash) : null,
        mt_index: payload?.mtIndex != null ? String(payload.mtIndex) : null,
        height: data.blockHeight,
      });
    } catch (e) {
      console.error("[MIDNIGHT] Failed to record commitment", payload?.commitment, e);
    }
    return;
  }

  const { nullifier } = payload;
  // The spending transaction's hash — the fill-vs-cancel discriminator.
  const txHash = payload?.txHash ? bytesOrStringToHex(payload.txHash) : null;

  try {
    // Insert into the unified nullifiers table. offer_matched=false initially;
    // if the offer was already indexed (or is indexed later), it gets flipped
    // to true via markNullifierMatched. First-seen tx_hash wins on conflict —
    // a nullifier spends once; a repeat event is a replay.
    yield* World.resolve(insertNullifierWithTx, {
      nullifier,
      height: data.blockHeight,
      tx_hash: txHash,
    });

    const archived = yield* World.resolve(archiveOfferByNullifierWithHash, {
      nullifier,
      archived_at: new Date(data.blockTimestamp),
    });
    if (archived.length === 0) {
      // No offer indexed yet — early-arrival race. The row stays in
      // nullifiers with offer_matched=false; celestia-zswap will flip it
      // when the offer arrives. Either way the row is kept permanently.
      console.log(
        "[MIDNIGHT] Nullifier not matched yet — buffered in nullifiers",
        nullifier,
      );
    } else {
      // Flip to matched so the early-arrival lookup stops finding it.
      yield* World.resolve(markNullifierMatched, { nullifier });
      console.log("[MIDNIGHT] Archived offer(s) for nullifier", nullifier, archived);
      for (const row of archived) {
        emitAppEvent({ type: "offer_consumed", offerId: row.id, nullifier });
      }
    }

    // NOTE: nullifiers are NEVER pruned. A spend is permanent, and this table
    // is the double-spend record `isNullifierSpent` consults at ingestion, so
    // it has to stay complete — the same invariant the ledger itself holds.
    // A TTL used to prune `offer_matched = false` rows here; because the table
    // records every nullifier on Midnight (most belonging to unrelated users,
    // so unmatched forever), that TTL was deleting exactly the history the
    // check depends on, letting long-spent coins back freshly published
    // offers that can never settle. See known_roots for the opposite case: a
    // root's validity really does expire, so that set IS TTL-limited.
  } catch (e) {
    console.error("[MIDNIGHT] Failed to archive offer for nullifier", nullifier, e);
  }
});

// Fires once per unshielded UTXO spend observed on chain (sourced from the
// indexer's per-tx `unshieldedSpentOutputs`). Match against the
// (owner, intent_hash, output_no) triples captured at offer-publication
// time and archive any matched offer.
addTransition("midnight-unshielded-spend", function* (data) {
  const { payload } = data.parsedInput;
  const owner = unshieldedOwnerToCanonicalHex(payload?.owner);
  const intentHash = bytesOrStringToHex(payload?.intentHash);
  const outputNoRaw = payload?.outputIndex ?? payload?.outputNo;
  const outputNo = typeof outputNoRaw === "number"
    ? outputNoRaw
    : Number(outputNoRaw);

  if (!owner || !intentHash || !Number.isFinite(outputNo)) {
    console.warn(
      "[MIDNIGHT] Skipping malformed unshielded-spend payload",
      payload,
    );
    return;
  }

  try {
    // Delete from created_unshielded — the row's absence is the "spent" signal.
    // If no offer is currently indexed for this UTXO, the delete is still
    // correct: a later Celestia offer will see no row and be rejected.
    yield* World.resolve(deleteCreatedUnshielded, {
      owner,
      intent_hash: intentHash,
      output_no: outputNo,
    });

    const archived = yield* World.resolve(archiveOfferByUnshieldedSpendWithHash, {
      owner,
      intent_hash: intentHash,
      output_no: outputNo,
      archived_at: new Date(data.blockTimestamp),
    });
    if (archived.length === 0) {
      console.log(
        "[MIDNIGHT] Unshielded spend — no active offer matched",
        { owner, intentHash, outputNo },
      );
    } else {
      console.log(
        "[MIDNIGHT] Archived offer(s) for unshielded spend",
        { owner, intentHash, outputNo },
        archived,
      );
      for (const row of archived) {
        emitAppEvent({
          type: "offer_consumed",
          offerId: row.id,
          unshieldedSpend: { owner, intentHash, outputNo },
        });
      }
    }
  } catch (e) {
    console.error(
      "[MIDNIGHT] Failed to archive offer for unshielded spend",
      { owner, intentHash, outputNo },
      e,
    );
  }
});

// Fires once per unshielded UTXO *created* on chain (regular AND system txs).
// Records the (owner, intent_hash, output_no) triple in the permanent
// created_unshielded set so the offer validator can reject offers that
// reference a UTXO the chain never created (existence check).
addTransition("midnight-unshielded-create", function* (data) {
  const { payload } = data.parsedInput;
  const owner = unshieldedOwnerToCanonicalHex(payload?.owner);
  const intentHash = bytesOrStringToHex(payload?.intentHash);
  const outputNoRaw = payload?.outputIndex ?? payload?.outputNo;
  const outputNo = typeof outputNoRaw === "number"
    ? outputNoRaw
    : Number(outputNoRaw);

  if (!owner || !intentHash || !Number.isFinite(outputNo)) {
    console.warn("[MIDNIGHT] Skipping malformed unshielded-create payload", payload);
    return;
  }

  try {
    yield* World.resolve(insertCreatedUnshielded, {
      owner,
      intent_hash: intentHash,
      output_no: outputNo,
      height: data.blockHeight,
    });
  } catch (e) {
    console.error(
      "[MIDNIGHT] Failed to record created unshielded UTXO",
      { owner, intentHash, outputNo },
      e,
    );
  }
});

// Fires once per block whose coin-commitment tree root advanced. Records the
// root in the windowed known_roots set and prunes roots older than the root
// window, mirroring the ledger's `past_roots`. The offer validator checks an
// offer's input root against this set (root-known liveness). Deterministic:
// keyed on the block timestamp, never wall-clock.
addTransition("midnight-zswap-root", function* (data) {
  const root = canonicalRootHex(String(data.parsedInput.payload?.root ?? ""));
  if (!root) {
    console.warn("[MIDNIGHT] Skipping empty zswap-root payload");
    return;
  }
  try {
    yield* World.resolve(upsertKnownRootWithFirstSeen, {
      root,
      height: data.blockHeight,
      seen_ms: data.blockTimestamp,
    });
    yield* World.resolve(pruneKnownRoots, {
      cutoff_ms: data.blockTimestamp - ROOT_WINDOW_SECONDS * 1000,
    });
  } catch (e) {
    console.error("[MIDNIGHT] Failed to record zswap root", root, e);
  }
});

addTransition("celestia-zswap", function* (data) {
  const { payload } = data.parsedInput;
  // MIP-0006: the DA blob is the RAW MIP-0005 transaction bytes, not the
  // bech32m string. The framework fetcher sets suppliedValue = atob(blob.data),
  // a latin1 string whose char codes are those bytes; latin1ToBytes recovers
  // them. `raw` (the latin1 string) is still the accounting-table key used by
  // rejectOffer's scrub, so keep it as-is for that match.
  const raw = payload.suppliedValue;
  const rawBytes = latin1ToBytes(raw);

  // Anyone can post any bytes to the public Celestia namespace for the price
  // of a blob fee, so this transition is the real gate — /api/zswap/submit and
  // the batcher can both be bypassed. It is ordered cheapest-first so that a
  // blob which was never going to be indexed costs as little as possible:
  //
  //   HRP → length bound → bech32m → size → deserialize → two-sided → roots
  //   → dedup (indexed) → liveness (indexed) → wellFormed (crypto, LAST)
  //
  // Crypto is deferred to the end deliberately: it is orders of magnitude more
  // expensive than every other step, so a replayed or stale blob must never
  // reach it. Nothing is skipped — an offer is only indexed once wellFormed
  // passes — so this ordering can change which rejection fires, never turn a
  // rejection into an acceptance.
  //
  // Rejected blobs are also deleted from the framework's accounting table (see
  // rejectOffer): it persists every fetched blob forever, which is otherwise
  // unbounded, attacker-controlled storage. The rejection itself survives as a
  // bounded per-(height, code) counter in offer_rejections.
  //
  // Deterministic throughout: the verdict is a pure function of
  // (raw, refState, tblock, indexed sets). `tblock` is the Celestia block time
  // and `refState` is a blank ledger state for the configured network, so it
  // replays identically.
  const rejectOffer = function* (code: string, reason: string, extra: object = {}) {
    console.warn("[ZSWAP] Rejected offer", {
      code,
      reason,
      blockHeight: data.blockHeight,
      ...extra,
    });
    // Same block, same transaction as the accounting INSERT — atomic. The
    // body goes; the fact and reason survive as an aggregated counter.
    yield* World.resolve(deleteRejectedAccountingRow, {
      primitive_name: CELESTIA_PRIMITIVE_NAME,
      block_height: data.blockHeight,
      // The body's JSON encoding, not the body: raw bytes contain 0x00,
      // which has no text representation. See deleteRejectedAccountingRow.
      supplied_json: JSON.stringify(raw),
    });
    yield* World.resolve(recordOfferRejection, {
      celestia_height: data.blockHeight,
      code,
    });
    emitAppEvent({
      type: "offer_rejected",
      code,
      reason,
      blockHeight: data.blockHeight,
      ...extra,
    });
  };

  const result = validateZswapOfferBytes(rawBytes, {
    refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
    tblock: new Date(data.blockTimestamp),
    maxBytes: OFFER_MAX_BYTES,
    crypto: "defer", // verified below, after the indexed checks
  });
  if (!result.ok) {
    yield* rejectOffer(result.code ?? "INVALID", result.reason ?? "");
    return;
  }

  const nullifierStrs = result.nullifiers ?? [];
  const unshieldedSpends = (result.unshieldedSpends ?? []).map((s) => ({
    owner: s.owner,
    intent_hash: s.intentHash,
    output_no: s.outputNo,
  }));
  const gives = result.gives ?? [];
  const wants = result.wants ?? [];

  // ── Dedup (MIP-0006: duplicates SHOULD be rejected) ── FIRST of the DB
  // checks: one indexed probe on a hash we already have to compute, and the
  // single most likely rejection under attack (replaying a valid blob is the
  // cheapest way to make an indexer work). Never let a replay reach crypto.
  //
  // offer_hash is content-addressed (sha256 of the raw tx bytes), so the same
  // offer re-published — same maker retrying, or a relay replaying the blob —
  // resolves to the same hash on every node regardless of local ids. Checks
  // history too: a consumed/expired offer must not be resurrected by replay.
  const offerHash = offerHashFromBytes(rawBytes);
  const existing = yield* World.resolve(getOfferStatusByHash, {
    offer_hash: offerHash,
  });
  if (existing.length > 0) {
    yield* rejectOffer(
      "DUPLICATE_OFFER",
      `offer already indexed with status '${existing[0].status}'`,
      { offerHash },
    );
    return;
  }

  // ── Liveness: drop offers whose coins are already spent on chain ──
  // The midnight-* handlers ingest every consumed nullifier / unshielded UTXO
  // into the permanent spent_* sets, so these are a plain existence check. We
  // do NOT compare heights across chains (Midnight height ≠ Celestia height);
  // determinism comes from the rollup's fixed input ordering. An already-spent
  // coin means the offer can never settle, so it must not be indexed.
  for (const nullifier of nullifierStrs) {
    const spent = yield* World.resolve(isNullifierSpent, { nullifier });
    if (spent.length > 0) {
      yield* rejectOffer(
        "NULLIFIER_SPENT",
        `nullifier already spent: ${nullifier}`,
        { offerHash },
      );
      return;
    }
  }
  // ── Existence + liveness for unshielded UTXOs ──
  // created_unshielded is a live-set: midnight-unshielded-create inserts,
  // midnight-unshielded-spend deletes. A missing row means either the UTXO
  // was never created OR it has already been spent — both mean reject.
  for (const s of unshieldedSpends) {
    const created = yield* World.resolve(isUnshieldedCreated, s);
    if (created.length === 0) {
      yield* rejectOffer(
        "UTXO_NOT_LIVE",
        `unshielded UTXO not live (spent or never created): ${s.owner}/${s.intent_hash}/${s.output_no}`,
        { offerHash },
      );
      return;
    }
  }

  // ── Root-known: drop offers whose shielded input proves against a root the
  // chain never held / that has aged out (midnight-zswap-root populates
  // known_roots). inputRoots are canonical hex == the indexer's root form.
  // The window is enforced HERE, at read time, with this block's own
  // timestamp as the cutoff — pruning is event-driven and stops on a quiet
  // chain, so presence in known_roots alone is not recency. ──
  for (const root of result.inputRoots ?? []) {
    const known = yield* World.resolve(isKnownRootLive, {
      root,
      cutoff_ms: data.blockTimestamp - ROOT_WINDOW_SECONDS * 1000,
    });
    if (known.length === 0) {
      yield* rejectOffer(
        "ROOT_UNKNOWN",
        `input merkle root not a known recent chain root: ${root}`,
        { offerHash },
      );
      return;
    }
  }

  // ── Cryptographic verification — LAST, and mandatory ──
  // Everything above read *claimed* data out of an unverified transaction;
  // this is what makes it trustworthy. Deferred to here so that malformed,
  // duplicate, and stale blobs are all discarded before paying for proof
  // verification — but nothing is indexed without it.
  const crypto = verifyOfferCrypto(result.tx!, {
    refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
    tblock: new Date(data.blockTimestamp),
  });
  if (!crypto.ok) {
    yield* rejectOffer(crypto.code, crypto.reason, { offerHash });
    return;
  }

  // ── Derive expires_at (MIP-0006) ──
  // Computed once at ingestion. The two paths have genuinely different
  // ledger semantics:
  //
  // SHIELDED (offer has input roots) → earliest root last_seen + ROOT_WINDOW.
  //   A Zswap offer carries NO ttl field: `ttl_check_weak` only iterates
  //   intents, so a pure Zswap partial tx passes well-formedness forever.
  //   It dies at APPLY time, when `apply_input` rejects an input whose
  //   merkle root is no longer in `past_roots` (UnknownMerkleRoot) — or
  //   sooner if a nullifier lands first. `past_roots` is a TimeFilterMap
  //   that re-inserts the CURRENT root every block and evicts entries older
  //   than `tblock − window`, so the clock runs from the last block whose
  //   tree state the offer proved against, not from offer creation.
  //   NOTE: this value is therefore a conservative FLOOR — on a quiet chain
  //   segment the same root keeps refreshing and the real expiry extends.
  //   Serving the exact current value would mean persisting each offer's
  //   roots and recomputing at read time; the floor never over-promises
  //   fillability, and our own TTL cleanup archives at OFFER_TTL anyway.
  //
  // UNSHIELDED → the earliest intent TTL. Not a fallback: `UnshieldedOffer`
  //   exists only inside `Intent`, and `Intent.ttl` is non-optional, so an
  //   unshielded offer structurally ALWAYS has a TTL (bounded by the
  //   on-chain `global_ttl`, 1 h by default, so the inclusion window is
  //   [ttl − global_ttl, ttl]). The indexer-TTL branch below is defensive
  //   only — it should be unreachable for a well-formed offer.
  //
  // The two windows are INDEPENDENT despite both defaulting to 1 h: the
  // root window is fixed in the zswap crate (parameterized from node 2.x),
  // while `global_ttl` is an on-chain LedgerParameters field changeable by
  // governance. Moving one does not move the other.
  let expiresAt: string | null = null;
  // firstSeenAt (MIP-0006): shielded → the moment the offer became provable
  // on this chain (earliest proof-root first-seen); otherwise the Celestia
  // block time. Deterministic on replay — never wall-clock.
  let firstSeenAt = new Date(data.blockTimestamp).toISOString();
  const inputRoots = result.inputRoots ?? [];
  if (inputRoots.length > 0) {
    const fs = yield* World.resolve(getEarliestRootFirstSeen, { roots: inputRoots });
    const firstSeenMs = fs[0]?.first_seen_ms;
    const lastSeenMs = fs[0]?.last_seen_ms;
    // firstSeenAt: the offer cannot predate its own proof root.
    if (firstSeenMs != null) {
      firstSeenAt = new Date(Number(firstSeenMs)).toISOString();
    }
    // expiresAt: from LAST-seen — the refresh semantics above.
    if (lastSeenMs != null) {
      expiresAt = new Date(Number(lastSeenMs) + ROOT_WINDOW_SECONDS * 1000).toISOString();
    }
  }
  if (expiresAt == null) {
    const intentTtl = P2pAtomicSwaps.earliestIntentTtl(result.tx!);
    expiresAt = intentTtl
      ? new Date(intentTtl).toISOString()
      : new Date(data.blockTimestamp + OFFER_TTL_SECONDS * 1000).toISOString();
  }

  try {
    // ── Insert offer ──
    const offerFileRes = yield* World.resolve(insertOfferFileWithHash, {
      celestia_height: data.blockHeight,
      transaction_hex: offerBytesToBech32(rawBytes), // bech32m for storage/API
      offer_hash: offerHash,
      metadata_created_at: new Date(data.blockTimestamp).toISOString(),
      metadata_expires_at: expiresAt,
      first_seen_at: firstSeenAt,
      ttl_seconds: OFFER_TTL_SECONDS,
    });

    const offerFileId = offerFileRes[0].id;

    // ── Persist spend refs (derived + validated above) ──
    // nullifierStrs covers guaranteed + fallible segments, inputs + transients;
    // unshieldedSpends carries the (owner, intentHash, outputNo) triples with
    // owner already normalized via addressFromKey so the midnight-* consumption
    // events match. Both must be inserted before the early-arrival
    // reconciliation, which copies them into the history tables in one shot.
    for (const nullifier of nullifierStrs) {
      yield* World.resolve(insertOfferFileNullifier, {
        offer_file_id: offerFileId,
        nullifier,
      });
    }
    for (const s of unshieldedSpends) {
      yield* World.resolve(insertOfferFileUnshieldedSpend, {
        offer_file_id: offerFileId,
        ...s,
      });
    }
    // Fill markers: the offer's own shielded output commitments, plaintext in
    // the published blob. A settling tx must create ALL of them (merging
    // preserves outputs verbatim) — cancelledPredicate uses their presence in
    // the spending tx to classify fill vs cancel exactly.
    for (const commitment of collectOutputCommitments(result.tx!)) {
      yield* World.resolve(insertOfferFileCommitment, {
        offer_file_id: offerFileId,
        commitment,
      });
    }

    // ── Insert derived gives/wants ──
    // Must come before the early-arrival reconciliation below: the archive
    // queries copy these into offer_file_tokens_history in one statement,
    // so they have to exist when the archive runs.
    for (const g of gives) {
      yield* World.resolve(insertOfferFileTokenWithKind, {
        offer_file_id: offerFileId,
        token_color: g.token,
        amount: g.amount,
        direction: "GIVING",
        kind: g.kind,
      });
    }
    for (const w of wants) {
      yield* World.resolve(insertOfferFileTokenWithKind, {
        offer_file_id: offerFileId,
        token_color: w.token,
        amount: w.amount,
        direction: "WANTING",
        kind: w.kind,
      });
    }

    // NOTE: token colors are deliberately NOT auto-registered here. Indexing an
    // offer used to write a placeholder row into known_tokens named
    // `abc...def` and typed `shielded` unconditionally — a guess on both
    // counts, since a color appearing in an offer says nothing about its name
    // and unshielded legs are typed wrong by construction. Unverified names in
    // a table clients read to label trades is exactly the kind of fabricated
    // data a financial UI must not carry. Unknown colors now render as their
    // raw color until a name is registered deliberately (see
    // ENABLE_TOKEN_REGISTRY) or the Midnight token-metadata standard lands.

    // ── Reconcile against early-arrival buffer ──
    // If a Midnight consumption event was processed before this offer was
    // indexed (race during re-sync / replay), the nullifier row exists with
    // offer_matched=false. Archive immediately and flip to matched so the
    // row persists as a permanent validator record.
    let archivedEarly = false;
    for (const nullifierStr of nullifierStrs) {
      const seen = yield* World.resolve(findUnmatchedNullifier, { nullifier: nullifierStr });
      if (seen.length === 0) continue;
      const archived = yield* World.resolve(archiveOfferByNullifierWithHash, {
        nullifier: nullifierStr,
        archived_at: new Date(data.blockTimestamp),
      });
      yield* World.resolve(markNullifierMatched, { nullifier: nullifierStr });
      for (const row of archived) {
        emitAppEvent({ type: "offer_consumed", offerId: row.id, nullifier: nullifierStr });
      }
      if (archived.length > 0) archivedEarly = true;
    }
    if (archivedEarly) {
      console.log(
        `[ZSWAP] Offer ${offerFileId} archived at index-time (early-arrival consumption)`,
      );
      return;
    }

    // Schedule a follow-up STM input to run after the TTL expires.
    yield* World.resolve(newScheduledTimestampData, {
      from_address: "0x0",
      from_address_type: AddressType.NONE,
      future_ms_timestamp: new Date(data.blockTimestamp + OFFER_TTL_SECONDS * 1000),
      input_data: JSON.stringify(["zswap-ttl-cleanup", offerFileId]),
    });

    console.log(`[ZSWAP] Saved at Celestia block ${data.blockHeight}`);
    emitAppEvent({ type: "offer_indexed", offerId: offerFileId, offerHash, blockHeight: data.blockHeight, gives, wants });
  } catch (e) {
    console.error("[ZSWAP] Failed to save offer file", e);
  }
});

addTransition("midnight-zswap", function* (data) {
  const snapshot = extractMidnightLedgerSnapshot(data.parsedInput.payload);
  if (!snapshot) return;

  console.log(
    `[MIDNIGHT] Ledger snapshot at block ${data.blockHeight}`,
    snapshot,
  );
});

// Scheduled TTL cleanup: if the offer is still active in the main table,
// move it to history and mark it as archived due to TTL.
addTransition("zswap-ttl-cleanup", function* (data) {
  const { offerId } = data.parsedInput;

  try {
    const archived = yield* World.resolve(archiveOfferByIdTtlWithHash, {
      offer_file_id: offerId,
      // The scheduled input executes inside an L2 block like any other
      // transition, so this is the deterministic expiry time, not wall-clock.
      archived_at: new Date(data.blockTimestamp),
    });

    if (archived.length === 0) {
      console.log(
        "[ZSWAP] TTL cleanup: offer already consumed or missing",
        offerId,
      );
      return;
    }

    console.log(
      "[ZSWAP] TTL cleanup archived offer",
      offerId,
      archived,
    );
    emitAppEvent({ type: "offer_expired", offerId });
  } catch (e) {
    console.error(
      "[ZSWAP] Failed to archive offer by TTL",
      offerId,
      e,
    );
  }
});

export const gameStateTransitions: StartConfigGameStateTransitions = function* (
  _blockHeight: number,
  input: BaseStfInput,
): SyncStateUpdateStream<void> {
  yield* stm.processInput(input);
};
