// Canonical whole-offer ladder derivation.
//
// Each eligible maker file is indivisible. For every directed pair this module
// exhaustively visits every compatible nonempty subset allowed by the maker
// limit, retains the deterministic best witness at each exact input total, and
// turns the running output maximum into a staircase the unchanged relay can
// interpolate exactly. Incomplete searches publish nothing for the affected
// pair. No solver inventory participates in either prices or witnesses.

import {
  admissionPairKey,
  type JobAdmissionPolicy,
} from "./admission-policy.ts";
import {
  MAX_PAIRS_PER_PUSH,
  MAX_RUNGS_PER_PAIR,
  pairKey,
  rejectPair,
  type LadderRejection,
} from "./ladder-schema.ts";
import {
  isCapabilityTokenId,
  isPriceLevelsPair,
  parsePriceLevels,
  parseSolverCapabilities,
  type PriceLevel,
  type PriceLevelsMessage,
  type PriceLevelsPair,
  type SolverCapabilitiesMessage,
} from "./relay-ws-contract.ts";

/** Largest positive ledger-v9 zswap delta. Coins are u128 and the relay wire
 * accepts u256, but merged transaction imbalances and receipts are signed i128. */
export const MAX_SETTLEMENT_AMOUNT = (1n << 127n) - 1n;

export interface LadderResourceLimits {
  maxSourceOffers: number;
  maxVisitedSubsetsPerPair: number;
  maxVisitedSubsetsTotal: number;
  maxMakersPerCombination: number;
  maxWirePointsPerPair: number;
  maxPairs: number;
}

/** Measured defaults and absolute ceilings. Controls may only lower them. */
export const HARD_LADDER_RESOURCE_LIMITS: Readonly<LadderResourceLimits> = Object.freeze({
  maxSourceOffers: 4_096,
  maxVisitedSubsetsPerPair: 100_000,
  maxVisitedSubsetsTotal: 200_000,
  maxMakersPerCombination: 8,
  maxWirePointsPerPair: MAX_RUNGS_PER_PAIR,
  maxPairs: MAX_PAIRS_PER_PUSH,
});

export const DEFAULT_LADDER_RESOURCE_LIMITS: Readonly<LadderResourceLimits> =
  HARD_LADDER_RESOURCE_LIMITS;

export type LadderResourceLimitControls = Partial<LadderResourceLimits>;
export type LadderResourceLimitName = keyof LadderResourceLimits;

export type LadderResourceLimitResolution =
  | { ok: true; limits: LadderResourceLimits }
  | {
      ok: false;
      field: LadderResourceLimitName;
      value: unknown;
      maximum: number;
    };

const RESOURCE_LIMIT_NAMES = [
  "maxSourceOffers",
  "maxVisitedSubsetsPerPair",
  "maxVisitedSubsetsTotal",
  "maxMakersPerCombination",
  "maxWirePointsPerPair",
  "maxPairs",
] as const satisfies readonly LadderResourceLimitName[];

/** Resolve lower resource controls without silently clamping unsafe values. */
export function resolveLadderResourceLimits(
  controls: Readonly<LadderResourceLimitControls> | undefined,
): LadderResourceLimitResolution {
  const limits = { ...DEFAULT_LADDER_RESOURCE_LIMITS };
  if (controls === undefined) return { ok: true, limits };
  for (const field of RESOURCE_LIMIT_NAMES) {
    const value = controls[field];
    if (value === undefined) continue;
    const maximum = HARD_LADDER_RESOURCE_LIMITS[field];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      return { ok: false, field, value, maximum };
    }
    limits[field] = value;
  }
  return { ok: true, limits };
}

export interface LadderSourceLeg {
  token: string;
  amount: bigint;
  kind: "SHIELDED" | "UNSHIELDED";
}

export interface LadderSourceOffer {
  offerHash: string;
  gives: readonly LadderSourceLeg[];
  wants: readonly LadderSourceLeg[];
  expiresAt: number | null;
  inputNullifiers: readonly string[];
}

export type LadderExclusionReason =
  | "multi-leg"
  | "non-shielded-leg"
  | "non-positive-amount"
  | "same-token"
  | "malformed-token"
  | "malformed-hash"
  | "malformed-nullifier"
  | "no-expiry"
  | "expiring"
  | "unavailable"
  | "duplicate-offer"
  | "shared-coin"
  | "settlement-amount-cap"
  | "source-offer-cap"
  | "pair-search-cap"
  | "global-search-cap"
  | "wire-point-cap"
  | "pair-cap"
  | "unsupported-pair"
  | "minimum-output"
  | "aborted"
  | "abort-check-failed"
  | "invalid-pair";

export interface LadderExclusion {
  offerHash: string;
  reason: LadderExclusionReason;
  detail?: LadderRejection | "bad-tokens";
}

export interface LadderCombinationProvenance {
  /** Exact maker total, never a plateau endpoint. */
  input: string;
  /** Exact maker total supplied by this witness. */
  output: string;
  /** Sorted full content hashes; every file executes once and in full. */
  offerHashes: string[];
}

export type LadderTerminalCapReason =
  | "wire-point-cap"
  | "next-omitted-improvement"
  | "settlement-amount-cap";

export interface LadderPairProvenance {
  tokenIn: string;
  tokenOut: string;
  /** Genuine retained improving thresholds only; synthetic points are absent. */
  combinations: LadderCombinationProvenance[];
  /** Actual inclusive end of the published final plateau. */
  terminalInput: string;
  /** Ten times the final genuine combination input, before safety caps. */
  nominalTerminalInput: string;
  /** Empty only when terminalInput equals nominalTerminalInput. */
  capReasons: LadderTerminalCapReason[];
}

export type LadderPairWithholdReason =
  | "unsupported-pair"
  | "minimum-output"
  | "pair-search-cap"
  | "global-search-cap"
  | "wire-point-cap"
  | "settlement-amount-cap"
  | "pair-cap"
  | "aborted"
  | "abort-check-failed"
  | "invalid-pair";

export interface LadderPairDiagnostic {
  tokenIn: string;
  tokenOut: string;
  status: "published" | "withheld";
  reason: LadderPairWithholdReason | null;
  candidateOffers: number;
  visitedSubsets: number;
  storedExactInputs: number;
  amountCappedSubsets: number;
  frontierCombinations: number;
  wirePoints: number;
}

export type LadderDerivationStopReason =
  | "source-offer-cap"
  | "global-search-cap"
  | "aborted"
  | "abort-check-failed"
  | "invalid-resource-limit";

export interface LadderDerivationDiagnostics {
  stopReason: LadderDerivationStopReason | null;
  invalidResourceLimit: {
    field: LadderResourceLimitName;
    value: unknown;
    maximum: number;
  } | null;
  sourceOffersScanned: number;
  visitedSubsets: number;
  peakStoredExactInputs: number;
  pairs: LadderPairDiagnostic[];
}

export interface DeriveLadderOptions extends JobAdmissionPolicy {
  nowMs: number;
  expiryMarginSeconds: number;
  unavailableOfferHashes?: Iterable<string>;
  /** Lower-only controls. Invalid or raised controls withdraw the full result. */
  resourceLimits?: Readonly<LadderResourceLimitControls>;
  /** Checked before scanning, for each source offer, and every 256 subsets. */
  shouldAbort?: () => boolean;
}

export interface DerivedLadder {
  levels: PriceLevelsPair[];
  tokenIds: string[];
  provenance: LadderPairProvenance[];
  excluded: LadderExclusion[];
  limits: LadderResourceLimits;
  diagnostics: LadderDerivationDiagnostics;
}

interface Crossable {
  offerHash: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  nullifiers: string[];
}

interface CombinationState {
  input: bigint;
  output: bigint;
  offerHashes: string[];
}

interface SearchResult {
  exact: Map<string, CombinationState>;
  visitedSubsets: number;
  amountCappedSubsets: number;
  reason: "pair-search-cap" | "global-search-cap" | "aborted" | "abort-check-failed" | null;
}

interface EncodedFrontier {
  levels: PriceLevel[];
  combinations: LadderCombinationProvenance[];
  terminalInput: bigint;
  nominalTerminalInput: bigint;
  capReasons: LadderTerminalCapReason[];
}

type FrontierCapReason = Exclude<LadderTerminalCapReason, "next-omitted-improvement">;

const HEX64 = /^[0-9a-f]{64}$/i;

const byOfferHash = (a: { offerHash: string }, b: { offerHash: string }): number =>
  a.offerHash < b.offerHash ? -1 : a.offerHash > b.offerHash ? 1 : 0;

const compareHashes = (a: readonly string[], b: readonly string[]): number => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return a.length - b.length;
};

const betterExactInputWitness = (
  candidate: CombinationState,
  incumbent: CombinationState,
): boolean => {
  if (candidate.output !== incumbent.output) return candidate.output > incumbent.output;
  if (candidate.offerHashes.length !== incumbent.offerHashes.length) {
    return candidate.offerHashes.length < incumbent.offerHashes.length;
  }
  return compareHashes(candidate.offerHashes, incumbent.offerHashes) < 0;
};

function toCrossable(
  offer: LadderSourceOffer,
  options: DeriveLadderOptions,
  unavailable: ReadonlySet<string>,
): Crossable | LadderExclusionReason {
  if (typeof offer.offerHash !== "string" || !HEX64.test(offer.offerHash)) return "malformed-hash";
  const offerHash = offer.offerHash.toLowerCase();
  if (unavailable.has(offerHash)) return "unavailable";
  if (offer.gives.length !== 1 || offer.wants.length !== 1) return "multi-leg";

  const give = offer.gives[0]!;
  const want = offer.wants[0]!;
  if (give.kind !== "SHIELDED" || want.kind !== "SHIELDED") return "non-shielded-leg";
  if (typeof give.token !== "string" || !HEX64.test(give.token)) return "malformed-token";
  if (typeof want.token !== "string" || !HEX64.test(want.token)) return "malformed-token";
  if (typeof give.amount !== "bigint" || typeof want.amount !== "bigint") return "non-positive-amount";
  if (give.amount <= 0n || want.amount <= 0n) return "non-positive-amount";
  if (give.amount > MAX_SETTLEMENT_AMOUNT || want.amount > MAX_SETTLEMENT_AMOUNT) {
    return "settlement-amount-cap";
  }

  const tokenOut = give.token.toLowerCase();
  const tokenIn = want.token.toLowerCase();
  if (tokenIn === tokenOut) return "same-token";
  if (offer.inputNullifiers.some((value) => typeof value !== "string" || !HEX64.test(value))) {
    return "malformed-nullifier";
  }
  if (offer.expiresAt === null) return "no-expiry";
  if (options.nowMs >= offer.expiresAt - options.expiryMarginSeconds * 1_000) return "expiring";

  return {
    offerHash,
    tokenIn,
    tokenOut,
    amountIn: want.amount,
    amountOut: give.amount,
    nullifiers: [...new Set(offer.inputNullifiers.map((value) => value.toLowerCase()))].sort(),
  };
}

const abortReason = (
  shouldAbort: (() => boolean) | undefined,
): "aborted" | "abort-check-failed" | null => {
  if (shouldAbort === undefined) return null;
  try {
    return shouldAbort() ? "aborted" : null;
  } catch {
    return "abort-check-failed";
  }
};

function enumeratePair(
  bucket: readonly Crossable[],
  limits: Readonly<LadderResourceLimits>,
  diagnostics: LadderDerivationDiagnostics,
  shouldAbort: (() => boolean) | undefined,
): SearchResult {
  const exact = new Map<string, CombinationState>();
  let visitedSubsets = 0;
  let amountCappedSubsets = 0;
  let reason: SearchResult["reason"] = null;

  const visit = (
    start: number,
    input: bigint,
    output: bigint,
    offerHashes: readonly string[],
  ): void => {
    for (let index = start; index < bucket.length && reason === null; index += 1) {
      if (visitedSubsets >= limits.maxVisitedSubsetsPerPair) {
        reason = "pair-search-cap";
        return;
      }
      if (diagnostics.visitedSubsets >= limits.maxVisitedSubsetsTotal) {
        reason = "global-search-cap";
        return;
      }

      visitedSubsets += 1;
      diagnostics.visitedSubsets += 1;
      if ((diagnostics.visitedSubsets & 255) === 0) {
        const stopped = abortReason(shouldAbort);
        if (stopped !== null) {
          reason = stopped;
          return;
        }
      }

      const candidate = bucket[index]!;
      const nextInput = input + candidate.amountIn;
      const nextOutput = output + candidate.amountOut;
      if (nextInput > MAX_SETTLEMENT_AMOUNT || nextOutput > MAX_SETTLEMENT_AMOUNT) {
        amountCappedSubsets += 1;
        continue;
      }

      const nextHashes = [...offerHashes, candidate.offerHash];
      const state: CombinationState = {
        input: nextInput,
        output: nextOutput,
        offerHashes: nextHashes,
      };
      const key = nextInput.toString();
      const incumbent = exact.get(key);
      if (incumbent === undefined || betterExactInputWitness(state, incumbent)) exact.set(key, state);

      if (nextHashes.length < limits.maxMakersPerCombination) {
        visit(index + 1, nextInput, nextOutput, nextHashes);
      }
    }
  };

  visit(0, 0n, 0n, []);
  return { exact, visitedSubsets, amountCappedSubsets, reason };
}

const bestOutputFrontier = (exact: ReadonlyMap<string, CombinationState>): CombinationState[] => {
  const ordered = [...exact.values()].sort((a, b) =>
    a.input < b.input ? -1 : a.input > b.input ? 1 : compareHashes(a.offerHashes, b.offerHashes));
  const frontier: CombinationState[] = [];
  let bestOutput = 0n;
  for (const candidate of ordered) {
    if (candidate.output <= bestOutput) continue;
    frontier.push(candidate);
    bestOutput = candidate.output;
  }
  return frontier;
};

function encodePrefix(
  frontier: readonly CombinationState[],
  retainedCount: number,
  maxWirePoints: number,
): EncodedFrontier | { failureReasons: LadderTerminalCapReason[] } {
  const retained = frontier.slice(0, retainedCount);
  const final = retained[retained.length - 1]!;

  const nominalTerminalInput = final.input * 10n;
  let terminalInput = nominalTerminalInput;
  const capReasons: LadderTerminalCapReason[] = [];
  if (terminalInput > MAX_SETTLEMENT_AMOUNT) {
    terminalInput = MAX_SETTLEMENT_AMOUNT;
    capReasons.push("settlement-amount-cap");
  }
  const nextOmitted = frontier[retainedCount];
  if (nextOmitted !== undefined) {
    const beforeNext = nextOmitted.input - 1n;
    if (terminalInput > beforeNext) {
      terminalInput = beforeNext;
      capReasons.push("next-omitted-improvement");
    }
  }
  const levels: PriceLevel[] = [];
  for (let index = 0; index < retained.length; index += 1) {
    const threshold = retained[index]!;
    levels.push({ input: threshold.input.toString(), output: threshold.output.toString() });
    const next = retained[index + 1];
    if (next === undefined) continue;
    const plateauEnd = next.input - 1n;
    if (plateauEnd > threshold.input) {
      levels.push({ input: plateauEnd.toString(), output: threshold.output.toString() });
    }
  }
  levels.push({ input: terminalInput.toString(), output: final.output.toString() });
  const failureReasons: LadderTerminalCapReason[] = [];
  if (levels.length > maxWirePoints) failureReasons.push("wire-point-cap");
  if (terminalInput <= final.input) {
    failureReasons.push(final.input >= MAX_SETTLEMENT_AMOUNT
      ? "settlement-amount-cap"
      : "next-omitted-improvement");
  }
  if (failureReasons.length > 0) return { failureReasons };

  return {
    levels,
    combinations: retained.map((entry) => ({
      input: entry.input.toString(),
      output: entry.output.toString(),
      offerHashes: [...entry.offerHashes],
    })),
    terminalInput,
    nominalTerminalInput,
    capReasons: [...new Set(capReasons)],
  };
}

function longestEncodableFrontier(
  frontier: readonly CombinationState[],
  maxWirePoints: number,
): { encoded: EncodedFrontier | null; truncationReasons: FrontierCapReason[] } {
  let best: EncodedFrontier | null = null;
  const truncationReasons = new Set<FrontierCapReason>();
  // Every genuine threshold consumes at least one point and the terminal
  // consumes one more, so no longer prefix can fit. This also bounds encoding
  // work when the exact frontier itself is large.
  const mostThresholdsThatCanFit = Math.min(frontier.length, maxWirePoints - 1);
  for (let retained = 1; retained <= mostThresholdsThatCanFit; retained += 1) {
    const encoded = encodePrefix(frontier, retained, maxWirePoints);
    if ("failureReasons" in encoded) {
      for (const reason of encoded.failureReasons) {
        // An adjacent omitted improvement may become encodable by retaining
        // more thresholds. Only an actual resource cap explains truncation.
        if (reason !== "next-omitted-improvement") truncationReasons.add(reason);
      }
    } else {
      best = encoded;
      truncationReasons.clear();
    }
  }
  if (frontier.length > mostThresholdsThatCanFit) {
    truncationReasons.add("wire-point-cap");
  }
  if (best !== null) {
    best.capReasons = [...new Set([...truncationReasons, ...best.capReasons])];
  }
  return { encoded: best, truncationReasons: [...truncationReasons] };
}

const excludedHash = (offer: LadderSourceOffer): string =>
  typeof offer.offerHash === "string" ? offer.offerHash.toLowerCase() : "";

const addPairExclusions = (
  excluded: LadderExclusion[],
  bucket: readonly Crossable[],
  reason: LadderExclusionReason,
): void => {
  for (const offer of bucket) excluded.push({ offerHash: offer.offerHash, reason });
};

const emptyDiagnostics = (): LadderDerivationDiagnostics => ({
  stopReason: null,
  invalidResourceLimit: null,
  sourceOffersScanned: 0,
  visitedSubsets: 0,
  peakStoredExactInputs: 0,
  pairs: [],
});

function emptyDerived(
  limits: LadderResourceLimits,
  diagnostics: LadderDerivationDiagnostics,
  excluded: LadderExclusion[] = [],
): DerivedLadder {
  return { levels: [], tokenIds: [], provenance: [], excluded, limits, diagnostics };
}

/** Pure, deterministic, exact derivation under explicit finite resource bounds. */
export function deriveLadder(
  offers: Iterable<LadderSourceOffer>,
  options: DeriveLadderOptions,
): DerivedLadder {
  const resolved = resolveLadderResourceLimits(options.resourceLimits);
  const diagnostics = emptyDiagnostics();
  if (!resolved.ok) {
    diagnostics.stopReason = "invalid-resource-limit";
    diagnostics.invalidResourceLimit = {
      field: resolved.field,
      value: resolved.value,
      maximum: resolved.maximum,
    };
    return emptyDerived({ ...DEFAULT_LADDER_RESOURCE_LIMITS }, diagnostics);
  }
  const limits = resolved.limits;
  const initiallyAborted = abortReason(options.shouldAbort);
  if (initiallyAborted !== null) {
    diagnostics.stopReason = initiallyAborted;
    return emptyDerived(limits, diagnostics);
  }

  const unavailable = new Set(
    [...(options.unavailableOfferHashes ?? [])].map((value) => value.toLowerCase()),
  );
  const excluded: LadderExclusion[] = [];
  const crossable: Crossable[] = [];

  for (const offer of offers) {
    diagnostics.sourceOffersScanned += 1;
    if (diagnostics.sourceOffersScanned > limits.maxSourceOffers) {
      diagnostics.stopReason = "source-offer-cap";
      excluded.push({ offerHash: excludedHash(offer), reason: "source-offer-cap" });
      return emptyDerived(limits, diagnostics, excluded);
    }
    const stopped = abortReason(options.shouldAbort);
    if (stopped !== null) {
      diagnostics.stopReason = stopped;
      excluded.push({ offerHash: excludedHash(offer), reason: stopped });
      return emptyDerived(limits, diagnostics, excluded);
    }
    const reduced = toCrossable(offer, options, unavailable);
    if (typeof reduced === "string") {
      excluded.push({ offerHash: excludedHash(offer), reason: reduced });
    } else {
      crossable.push(reduced);
    }
  }

  const hashCounts = new Map<string, number>();
  for (const offer of crossable) {
    hashCounts.set(offer.offerHash, (hashCounts.get(offer.offerHash) ?? 0) + 1);
  }
  const unique: Crossable[] = [];
  for (const offer of [...crossable].sort(byOfferHash)) {
    if ((hashCounts.get(offer.offerHash) ?? 0) > 1) {
      excluded.push({ offerHash: offer.offerHash, reason: "duplicate-offer" });
    } else {
      unique.push(offer);
    }
  }

  // Preserve the existing global shared-coin policy: the lowest full hash owns
  // each source nullifier across every pair; conflicting later files are out of
  // the eligible universe before pair optimization begins.
  const claimedCoins = new Set<string>();
  const retained: Crossable[] = [];
  for (const offer of unique) {
    if (offer.nullifiers.some((nullifier) => claimedCoins.has(nullifier))) {
      excluded.push({ offerHash: offer.offerHash, reason: "shared-coin" });
      continue;
    }
    for (const nullifier of offer.nullifiers) claimedCoins.add(nullifier);
    retained.push(offer);
  }

  const byPair = new Map<string, Crossable[]>();
  for (const offer of retained) {
    const key = pairKey(offer.tokenIn, offer.tokenOut);
    const bucket = byPair.get(key);
    if (bucket === undefined) byPair.set(key, [offer]);
    else bucket.push(offer);
  }

  const levels: PriceLevelsPair[] = [];
  const provenance: LadderPairProvenance[] = [];
  let globalStop: "global-search-cap" | "aborted" | "abort-check-failed" | null = null;

  for (const key of [...byPair.keys()].sort()) {
    const bucket = [...byPair.get(key)!].sort(byOfferHash);
    const tokenIn = bucket[0]!.tokenIn;
    const tokenOut = bucket[0]!.tokenOut;
    const diagnostic: LadderPairDiagnostic = {
      tokenIn,
      tokenOut,
      status: "withheld",
      reason: null,
      candidateOffers: bucket.length,
      visitedSubsets: 0,
      storedExactInputs: 0,
      amountCappedSubsets: 0,
      frontierCombinations: 0,
      wirePoints: 0,
    };
    diagnostics.pairs.push(diagnostic);

    if (globalStop !== null) {
      diagnostic.reason = globalStop;
      addPairExclusions(excluded, bucket, globalStop);
      continue;
    }
    if (levels.length >= limits.maxPairs) {
      diagnostic.reason = "pair-cap";
      addPairExclusions(excluded, bucket, "pair-cap");
      continue;
    }
    if (
      options.supportedPairs != null &&
      !options.supportedPairs.has(admissionPairKey(tokenIn, tokenOut))
    ) {
      diagnostic.reason = "unsupported-pair";
      addPairExclusions(excluded, bucket, "unsupported-pair");
      continue;
    }
    const minimum = options.minJobOutput?.get(tokenOut);
    if (options.minJobOutput != null && minimum === undefined) {
      diagnostic.reason = "minimum-output";
      addPairExclusions(excluded, bucket, "minimum-output");
      continue;
    }

    const stopped = abortReason(options.shouldAbort);
    if (stopped !== null) {
      globalStop = stopped;
      diagnostics.stopReason = stopped;
      diagnostic.reason = stopped;
      addPairExclusions(excluded, bucket, stopped);
      continue;
    }

    const search = enumeratePair(bucket, limits, diagnostics, options.shouldAbort);
    diagnostic.visitedSubsets = search.visitedSubsets;
    diagnostic.storedExactInputs = search.exact.size;
    diagnostic.amountCappedSubsets = search.amountCappedSubsets;
    diagnostics.peakStoredExactInputs = Math.max(
      diagnostics.peakStoredExactInputs,
      search.exact.size,
    );
    if (search.reason !== null) {
      diagnostic.reason = search.reason;
      addPairExclusions(excluded, bucket, search.reason);
      if (search.reason !== "pair-search-cap") {
        globalStop = search.reason;
        diagnostics.stopReason = search.reason;
      }
      continue;
    }

    const stoppedAfterSearch = abortReason(options.shouldAbort);
    if (stoppedAfterSearch !== null) {
      globalStop = stoppedAfterSearch;
      diagnostics.stopReason = stoppedAfterSearch;
      diagnostic.reason = stoppedAfterSearch;
      addPairExclusions(excluded, bucket, stoppedAfterSearch);
      continue;
    }

    let frontier = bestOutputFrontier(search.exact);
    if (minimum !== undefined) {
      frontier = frontier.filter((entry) => entry.output >= minimum);
    }
    if (frontier.length === 0) {
      diagnostic.reason = search.amountCappedSubsets > 0
        ? "settlement-amount-cap"
        : "minimum-output";
      addPairExclusions(excluded, bucket, diagnostic.reason);
      continue;
    }

    const { encoded, truncationReasons } = longestEncodableFrontier(
      frontier, limits.maxWirePointsPerPair,
    );
    if (encoded === null) {
      diagnostic.reason = truncationReasons[0]!;
      for (const reason of truncationReasons) addPairExclusions(excluded, bucket, reason);
      continue;
    }

    const stoppedAfterEncoding = abortReason(options.shouldAbort);
    if (stoppedAfterEncoding !== null) {
      globalStop = stoppedAfterEncoding;
      diagnostics.stopReason = stoppedAfterEncoding;
      diagnostic.reason = stoppedAfterEncoding;
      addPairExclusions(excluded, bucket, stoppedAfterEncoding);
      continue;
    }

    const pair: PriceLevelsPair = { tokenIn, tokenOut, levels: encoded.levels };
    const rejection = rejectPair(pair);
    if (rejection !== null || !isPriceLevelsPair(pair)) {
      diagnostic.reason = "invalid-pair";
      for (const offer of bucket) {
        excluded.push({
          offerHash: offer.offerHash,
          reason: "invalid-pair",
          ...(rejection === null ? {} : { detail: rejection }),
        });
      }
      continue;
    }

    levels.push(pair);
    provenance.push({
      tokenIn,
      tokenOut,
      combinations: encoded.combinations,
      terminalInput: encoded.terminalInput.toString(),
      nominalTerminalInput: encoded.nominalTerminalInput.toString(),
      capReasons: encoded.capReasons,
    });
    diagnostic.status = "published";
    diagnostic.frontierCombinations = encoded.combinations.length;
    diagnostic.wirePoints = encoded.levels.length;
    if (encoded.combinations.length < frontier.length) {
      const used = new Set(encoded.combinations.flatMap((entry) => entry.offerHashes));
      for (const offer of bucket) {
        if (!used.has(offer.offerHash)) {
          for (const reason of truncationReasons) {
            excluded.push({ offerHash: offer.offerHash, reason });
          }
        }
      }
    }
  }

  // Cancellation invalidates the whole snapshot, including completed pairs.
  if (globalStop === "aborted" || globalStop === "abort-check-failed") {
    for (const diagnostic of diagnostics.pairs) {
      if (diagnostic.status !== "published") continue;
      diagnostic.status = "withheld";
      diagnostic.reason = globalStop;
      diagnostic.frontierCombinations = 0;
      diagnostic.wirePoints = 0;
      addPairExclusions(
        excluded,
        byPair.get(pairKey(diagnostic.tokenIn, diagnostic.tokenOut))!,
        globalStop,
      );
    }
    levels.length = 0;
    provenance.length = 0;
  }

  const tokenIds = [...new Set(levels.flatMap((pair) => [pair.tokenIn, pair.tokenOut]))].sort();
  excluded.sort((a, b) =>
    byOfferHash(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  return { levels, tokenIds, provenance, excluded, limits, diagnostics };
}

/** Build a frame only when both the strict local schema and relay admit it. */
export function buildPriceLevelsFrame(pairs: readonly PriceLevelsPair[]): PriceLevelsMessage {
  for (const pair of pairs) {
    const rejection = rejectPair(pair);
    if (rejection !== null) {
      throw new Error(
        `refusing to build price-levels: ${pair?.tokenIn ?? "?"}→${pair?.tokenOut ?? "?"} is ${rejection}`,
      );
    }
  }
  const frame: PriceLevelsMessage = {
    type: "price-levels",
    levels: pairs.map((pair) => ({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      levels: pair.levels.map((level) => ({ input: level.input, output: level.output })),
    })),
  };
  if (parsePriceLevels(frame) === null) {
    throw new Error("refusing to build price-levels: the relay would discard this frame");
  }
  return frame;
}

export const withdrawalPriceLevelsFrame = (): PriceLevelsMessage => buildPriceLevelsFrame([]);

export function buildSolverCapabilitiesFrame(
  tokenIds: readonly string[],
  maxParallelSwaps?: number,
): SolverCapabilitiesMessage {
  for (const tokenId of tokenIds) {
    if (!isCapabilityTokenId(tokenId)) {
      throw new Error(`refusing to build solver-capabilities: ${String(tokenId)} is not a token id`);
    }
  }
  const frame: SolverCapabilitiesMessage = {
    type: "solver-capabilities",
    tokenIds: tokenIds.map((tokenId) => tokenId.toLowerCase()),
  };
  if (
    typeof maxParallelSwaps === "number" &&
    Number.isInteger(maxParallelSwaps) &&
    maxParallelSwaps > 0
  ) {
    frame.maxParallelSwaps = maxParallelSwaps;
  }
  if (parseSolverCapabilities(frame) === null) {
    throw new Error("refusing to build solver-capabilities: the relay would discard this frame");
  }
  return frame;
}
