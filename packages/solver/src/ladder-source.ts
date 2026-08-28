// The book cache as a ladder source: cache in, relay frames out.
//
// The derivation itself is pure and lives in
// `@zswap-da/solver-core/ladder-derivation`. This file is the only place that
// knows both the mirror and the relay's frames, and it is deliberately thin:
// no socket, no timer, no push loop — those are N4. Nothing here reaches back
// into `book-sync.ts`, so the mirror stays free of relay coupling.
//
// FR-005's downstream half is enforced here: when the cache is not CURRENT the
// solver must not publish ladders it cannot honour. Withholding is not
// silence — the relay drops nothing on its own and has no version or tombstone
// concept, so a stale ladder would keep quoting. The withheld push is an
// explicit EMPTY publication: empty capabilities, empty levels. That is the
// fail-closed withdrawal (Q-R2-3), and it is what N4 sends.

import {
  forwardAdmissionPolicy,
  type JobAdmissionPolicy,
  type SpendableInventory,
} from "@zswap-da/solver-core/admission-policy";
import {
  buildPriceLevelsFrame,
  buildSolverCapabilitiesFrame,
  deriveLadder,
  type DerivedLadder,
} from "@zswap-da/solver-core/ladder-derivation";
import type {
  PriceLevelsMessage,
  SolverCapabilitiesMessage,
} from "@zswap-da/solver-core/relay-ws-contract";

import type { Book, BookOffer } from "./book.ts";

/** The mirror's surface this needs — `SyncHandle` satisfies it structurally. */
export interface LadderCache {
  readonly book: Book<BookOffer>;
  isCurrent: () => boolean;
}

export interface LadderPushOptions extends JobAdmissionPolicy {
  /** Passed in, never read from the clock: same cache + same `nowMs` ⇒ same
   *  bytes. The caller (N4's push loop) owns the clock. */
  nowMs: number;
  expiryMarginSeconds: number;
  /** Offers claimed by an in-flight fill, from `Stock`. Kept as a parameter so
   *  derivation stays pure and this file stays free of executor state. */
  unavailableOfferHashes?: Iterable<string>;
  /** FR-003/FR-004: what the solver can actually move (`Stock.available`), so
   *  publication cannot advertise a rung it would refuse. Same reason it is a
   *  parameter: no executor or wallet state reaches this file. */
  spendableInventory?: SpendableInventory | null;
  maxParallelSwaps?: number;
  maxPairs?: number;
  maxRungsPerPair?: number;
}

export interface LadderPush {
  capabilities: SolverCapabilitiesMessage;
  priceLevels: PriceLevelsMessage;
  derived: DerivedLadder;
  /** Null when the push carries the cache's real ladders; otherwise why it is
   *  an empty withdrawal instead. */
  withheld: "cache-not-current" | null;
}

/** A fresh object every time: a shared frozen singleton would put one caller's
 *  mutation into every other caller's push. */
const nothingDerived = (): DerivedLadder => ({
  levels: [],
  tokenIds: [],
  provenance: [],
  excluded: [],
});

/**
 * Derive the pair of frames the relay client should send for the cache's
 * current state.
 *
 * Both frames are built through the validating builders, so a malformed frame
 * cannot leave this function: it throws instead. That matters more here than
 * usual — the relay DISCARDS a frame it dislikes silently and keeps the
 * previous ladder live, so an invalid push freezes the solver stale rather
 * than withdrawing it.
 */
export function deriveLadderPush(cache: LadderCache, options: LadderPushOptions): LadderPush {
  if (!cache.isCurrent()) {
    return {
      capabilities: buildSolverCapabilitiesFrame([], options.maxParallelSwaps),
      priceLevels: buildPriceLevelsFrame([]),
      derived: nothingDerived(),
      withheld: "cache-not-current",
    };
  }

  const derived = deriveLadder(cache.book.all(), {
    nowMs: options.nowMs,
    expiryMarginSeconds: options.expiryMarginSeconds,
    ...(options.unavailableOfferHashes === undefined
      ? {}
      : { unavailableOfferHashes: options.unavailableOfferHashes }),
    // FR-002: the whole policy in one hop. Never a field-by-field spread —
    // that is precisely how P4-F02 dropped `supportedPairs`/`minJobOutput`.
    ...forwardAdmissionPolicy(options),
    ...(options.spendableInventory === undefined
      ? {}
      : { spendableInventory: options.spendableInventory }),
    ...(options.maxPairs === undefined ? {} : { maxPairs: options.maxPairs }),
    ...(options.maxRungsPerPair === undefined ? {} : { maxRungsPerPair: options.maxRungsPerPair }),
  });

  return {
    capabilities: buildSolverCapabilitiesFrame(derived.tokenIds, options.maxParallelSwaps),
    priceLevels: buildPriceLevelsFrame(derived.levels),
    derived,
    withheld: null,
  };
}
