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
} from "@zswap-da/solver-core/admission-policy";
import {
  buildPriceLevelsFrame,
  buildSolverCapabilitiesFrame,
  DEFAULT_LADDER_RESOURCE_LIMITS,
  deriveLadder,
  resolveLadderResourceLimits,
  type DerivedLadder,
  type LadderResourceLimitControls,
  type LadderResourceLimits,
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
  maxParallelSwaps?: number;
  /** Lower-only controls for the canonical exact search and wire encoding. */
  resourceLimits?: Readonly<LadderResourceLimitControls>;
  /** Optional caller cancellation/supersession check. */
  shouldAbort?: () => boolean;
}

export interface LadderPush {
  capabilities: SolverCapabilitiesMessage;
  priceLevels: PriceLevelsMessage;
  derived: DerivedLadder;
  /**
   * Null when the push carries the cache's real ladders; otherwise why it is
   * an empty withdrawal instead.
   *
   * Failed search and runtime freshness checks produce explicit empty frames
   * with a diagnostic cause. `withdrawn` identifies an explicit retirement.
   */
  withheld:
    | "cache-not-current"
    | "derivation-failed"
    | "snapshot-stale"
    | "withdrawn"
    | null;
  /** Human-readable cause for a fail-closed runtime withdrawal. This is data
   *  for status/diagnostics only; no caller may use it to choose another
   *  ladder policy. */
  withheldReason?: string;
}

/** A fresh object every time: a shared frozen singleton would put one caller's
 *  mutation into every other caller's push. */
const nothingDerived = (
  limits: Readonly<LadderResourceLimits> = DEFAULT_LADDER_RESOURCE_LIMITS,
): DerivedLadder => ({
  levels: [],
  tokenIds: [],
  provenance: [],
  excluded: [],
  limits: { ...limits },
  diagnostics: {
    stopReason: null,
    invalidResourceLimit: null,
    sourceOffersScanned: 0,
    visitedSubsets: 0,
    peakStoredExactInputs: 0,
    pairs: [],
  },
});

/** Build the validated empty frame pair used when runtime safety checks cannot
 * publish a real derivation. Keeping this beside `deriveLadderPush` makes every
 * fail-closed path use the same frame builders as ordinary publication. */
export function buildWithheldLadderPush(
  withheld: Exclude<LadderPush["withheld"], null>,
  maxParallelSwaps?: number,
  withheldReason?: string,
  limits?: Readonly<LadderResourceLimits>,
): LadderPush {
  return {
    capabilities: buildSolverCapabilitiesFrame([], maxParallelSwaps),
    priceLevels: buildPriceLevelsFrame([]),
    derived: nothingDerived(limits),
    withheld,
    ...(withheldReason === undefined ? {} : { withheldReason }),
  };
}

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
    return buildWithheldLadderPush("cache-not-current", options.maxParallelSwaps);
  }

  const resolved = resolveLadderResourceLimits(options.resourceLimits);
  // Book.size is O(1). Reject before all() copies an unbounded source or a
  // publication snapshot serializes it. No source was scanned on this path.
  if (resolved.ok && cache.book.size > resolved.limits.maxSourceOffers) {
    const empty = buildWithheldLadderPush(
      "derivation-failed", options.maxParallelSwaps, "source-offer-cap", resolved.limits,
    );
    empty.derived.diagnostics.stopReason = "source-offer-cap";
    return empty;
  }
  const derived = deriveLadder(resolved.ok ? cache.book.all() : [], {
    nowMs: options.nowMs,
    expiryMarginSeconds: options.expiryMarginSeconds,
    ...(options.unavailableOfferHashes === undefined
      ? {}
      : { unavailableOfferHashes: options.unavailableOfferHashes }),
    // FR-002: the whole policy in one hop. Never a field-by-field spread —
    // that is precisely how P4-F02 dropped `supportedPairs`/`minJobOutput`.
    ...forwardAdmissionPolicy(options),
    ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
    shouldAbort: () => !cache.isCurrent() || options.shouldAbort?.() === true,
  });

  return {
    capabilities: buildSolverCapabilitiesFrame(derived.tokenIds, options.maxParallelSwaps),
    priceLevels: buildPriceLevelsFrame(derived.levels),
    derived,
    withheld: derived.levels.length === 0 && derived.diagnostics.stopReason !== null
      ? "derivation-failed" : null,
    ...(derived.levels.length === 0 && derived.diagnostics.stopReason !== null
      ? { withheldReason: derived.diagnostics.stopReason } : {}),
  };
}
