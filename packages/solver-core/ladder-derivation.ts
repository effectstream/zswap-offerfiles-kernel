// Canonical whole-offer ladder derivation.
//
// Each eligible maker file is indivisible. For every discovered directed pair
// this module exhaustively visits every nonempty physical subset in the sound
// weak-component-plus-cycles universe allowed by the maker limit, evaluates its
// complete signed net vector, retains the deterministic best witness at each
// exact input, and turns the running output maximum into the one staircase the
// unchanged relay can interpolate exactly. Incomplete searches publish nothing
// for the affected pair. No solver inventory participates in prices or witnesses.

import {
  admissionPairKey,
  type JobAdmissionPolicy,
} from "./admission-policy.ts";
import {
  MAX_PAIRS_PER_PUSH,
  MAX_RUNGS_PER_PAIR,
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
import {
  findSafeWholeOfferMergeOrder,
  MAX_SAFE_MERGE_ORDER_WORK,
  MAX_SETTLEMENT_AMOUNT,
  serializeWholeOfferTokenBalances,
  type SerializedWholeOfferTokenBalance,
  type WholeOfferTokenBalance,
} from "./whole-offer-balance.ts";

export { MAX_COIN_AMOUNT, MAX_SETTLEMENT_AMOUNT } from "./whole-offer-balance.ts";

export interface LadderResourceLimits {
  maxSourceOffers: number;
  maxVisitedSubsetsPerPair: number;
  maxVisitedSubsetsTotal: number;
  maxMakersPerCombination: number;
  maxWirePointsPerPair: number;
  maxPairs: number;
  maxCandidatePairs: number;
  maxDiscoveryWork: number;
}

/** Measured defaults and absolute ceilings. Controls may only lower them. */
export const HARD_LADDER_RESOURCE_LIMITS: Readonly<LadderResourceLimits> = Object.freeze({
  maxSourceOffers: 4_096,
  maxVisitedSubsetsPerPair: 100_000,
  maxVisitedSubsetsTotal: 200_000,
  maxMakersPerCombination: 8,
  maxWirePointsPerPair: MAX_RUNGS_PER_PAIR,
  maxPairs: MAX_PAIRS_PER_PUSH,
  maxCandidatePairs: 4_096,
  maxDiscoveryWork: 1_000_000,
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
  "maxCandidatePairs",
  "maxDiscoveryWork",
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
  | "candidate-pair-cap"
  | "discovery-work-cap"
  | "unsafe-merge-order"
  | "merge-order-work-cap"
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
  /** Sorted JSON-safe gross/net maker accounting, including zero-net tokens. */
  tokenBalances: SerializedWholeOfferTokenBalance[];
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
  | "candidate-pair-cap"
  | "discovery-work-cap"
  | "unsafe-merge-order"
  | "merge-order-work-cap"
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
  discoveryWork: number;
  safeMergeOrderWork: number;
}

export type LadderDerivationStopReason =
  | "source-offer-cap"
  | "global-search-cap"
  | "candidate-pair-cap"
  | "discovery-work-cap"
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
  candidatePairsExamined: number;
  discoveryWork: number;
  safeMergeOrderWork: number;
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
  tokenInIndex: number;
  tokenOutIndex: number;
  amountIn: bigint;
  amountOut: bigint;
  nullifiers: string[];
}

interface CombinationState {
  input: bigint;
  output: bigint;
  offerHashes: string[];
  tokenBalances: WholeOfferTokenBalance[];
}

interface SearchResult {
  exact: Map<string, CombinationState>;
  visitedSubsets: number;
  amountCappedSubsets: number;
  safeMergeOrderWork: number;
  unsafeMergeOrderSubsets: number;
  reason:
    | "pair-search-cap"
    | "global-search-cap"
    | "discovery-work-cap"
    | "merge-order-work-cap"
    | "aborted"
    | "abort-check-failed"
    | null;
}

interface PairSearchScratch {
  gives: Array<bigint | undefined>;
  wants: Array<bigint | undefined>;
  nets: Array<bigint | undefined>;
  activeTokenIndices: number[];
  selected: Crossable[];
}

interface DiscoveryBudget {
  remaining: () => number;
  charge: (
    work?: number,
    kind?: "discovery" | "safe-merge-order",
  ) => "discovery-work-cap" | "aborted" | "abort-check-failed" | null;
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
    tokenInIndex: -1,
    tokenOutIndex: -1,
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
  tokenIn: string,
  tokenOut: string,
  tokenInIndex: number,
  tokenOutIndex: number,
  tokenAt: readonly string[],
  scratch: PairSearchScratch,
  limits: Readonly<LadderResourceLimits>,
  diagnostics: LadderDerivationDiagnostics,
  shouldAbort: (() => boolean) | undefined,
  discoveryBudget: DiscoveryBudget,
): SearchResult {
  const exact = new Map<string, CombinationState>();
  let visitedSubsets = 0;
  let amountCappedSubsets = 0;
  let safeMergeOrderWork = 0;
  let unsafeMergeOrderSubsets = 0;
  let reason: SearchResult["reason"] = null;
  const directBucket = bucket.every((entry) =>
    entry.tokenIn === tokenIn && entry.tokenOut === tokenOut
  );
  const { gives, wants, nets, activeTokenIndices, selected } = scratch;
  if (activeTokenIndices.length !== 0 || selected.length !== 0) {
    throw new Error("pair search scratch is not empty");
  }

  const visit = (
    start: number,
    directInput: bigint,
    directOutput: bigint,
    sortedPrefixSafe: boolean,
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
      if (directBucket) {
        const nextInput = directInput + candidate.amountIn;
        const nextOutput = directOutput + candidate.amountOut;
        if (nextInput > MAX_SETTLEMENT_AMOUNT || nextOutput > MAX_SETTLEMENT_AMOUNT) {
          amountCappedSubsets += 1;
          // Every remaining source in this universe has the same directed pair,
          // so both magnitudes can only increase in descendants.
          continue;
        }
        selected.push(candidate);
        try {
          const state: CombinationState = {
            input: nextInput,
            output: nextOutput,
            offerHashes: selected.map((entry) => entry.offerHash),
            tokenBalances: [
              { token: tokenIn, gives: 0n, wants: nextInput, net: -nextInput },
              { token: tokenOut, gives: nextOutput, wants: 0n, net: nextOutput },
            ].sort((left, right) => left.token < right.token ? -1 : left.token > right.token ? 1 : 0),
          };
          const key = state.input.toString();
          const incumbent = exact.get(key);
          if (incumbent === undefined || betterExactInputWitness(state, incumbent)) exact.set(key, state);
          if (selected.length < limits.maxMakersPerCombination) {
            visit(index + 1, nextInput, nextOutput, true);
          }
        } finally {
          selected.pop();
        }
        continue;
      }

      // DFS depth is at most eight. Reuse the selected stack and graph-indexed
      // bigint balance vectors; a winning state materializes its own rows.
      const candidateInputIndex = candidate.tokenInIndex;
      const candidateOutputIndex = candidate.tokenOutIndex;
      const inputWasAbsent = (gives[candidateInputIndex] ?? 0n) === 0n &&
        (wants[candidateInputIndex] ?? 0n) === 0n;
      const outputWasAbsent = (gives[candidateOutputIndex] ?? 0n) === 0n &&
        (wants[candidateOutputIndex] ?? 0n) === 0n;
      if (inputWasAbsent) activeTokenIndices.push(candidateInputIndex);
      if (outputWasAbsent) activeTokenIndices.push(candidateOutputIndex);
      wants[candidateInputIndex] = (wants[candidateInputIndex] ?? 0n) + candidate.amountIn;
      nets[candidateInputIndex] = (nets[candidateInputIndex] ?? 0n) - candidate.amountIn;
      gives[candidateOutputIndex] = (gives[candidateOutputIndex] ?? 0n) + candidate.amountOut;
      nets[candidateOutputIndex] = (nets[candidateOutputIndex] ?? 0n) + candidate.amountOut;
      selected.push(candidate);
      try {
        // Crossable terms were validated and canonicalized once at eligibility.
        // Only these two rows change when extending the sorted physical prefix.
        const changedInput = nets[candidateInputIndex]!;
        const changedOutput = nets[candidateOutputIndex]!;
        const nextSortedPrefixSafe = sortedPrefixSafe &&
          changedInput >= -MAX_SETTLEMENT_AMOUNT && changedInput <= MAX_SETTLEMENT_AMOUNT &&
          changedOutput >= -MAX_SETTLEMENT_AMOUNT && changedOutput <= MAX_SETTLEMENT_AMOUNT;
        const inputNet = nets[tokenInIndex] ?? 0n;
        const outputNet = nets[tokenOutIndex] ?? 0n;
        let additionalDeficit = false;
        let amountCapped = false;
        if (inputNet < 0n && outputNet > 0n) {
          for (const index of activeTokenIndices) {
            const net = nets[index] ?? 0n;
            if (index !== tokenInIndex && net < 0n) {
              additionalDeficit = true;
              break;
            }
            if (net < -MAX_SETTLEMENT_AMOUNT || net > MAX_SETTLEMENT_AMOUNT) {
              amountCapped = true;
            }
          }
        }
        const economicCandidate = inputNet < 0n && outputNet > 0n && !additionalDeficit;
        if (economicCandidate && !amountCapped) {
          const mergeWorkLimit = Math.min(
            MAX_SAFE_MERGE_ORDER_WORK,
            discoveryBudget.remaining(),
          );
          // This is exactly the helper's sorted-hash fast path, shared along the
          // DFS branch. An unsafe prefix still visits every descendant and uses
          // the bounded alternative-order planner for every feasible candidate.
          const mergeOrder = nextSortedPrefixSafe
            ? { ok: true as const, work: 0 }
            : findSafeWholeOfferMergeOrder(
              selected.map((entry) => ({
                offerHash: entry.offerHash,
                gives: [{ token: entry.tokenOut, amount: entry.amountOut }],
                wants: [{ token: entry.tokenIn, amount: entry.amountIn }],
              })),
              {
                maxWork: mergeWorkLimit,
                shouldAbort,
              },
            );
          if (mergeOrder.work > 0) {
            const budgetReason = discoveryBudget.charge(mergeOrder.work, "safe-merge-order");
            safeMergeOrderWork += mergeOrder.work;
            if (budgetReason !== null) {
              reason = budgetReason;
              return;
            }
          }
          if (mergeOrder.ok) {
            const state: CombinationState = {
              input: -inputNet,
              output: outputNet,
              offerHashes: selected.map((entry) => entry.offerHash),
              tokenBalances: [],
            };
            const key = state.input.toString();
            const incumbent = exact.get(key);
            if (incumbent === undefined || betterExactInputWitness(state, incumbent)) {
              // Rows are already exact, unique and canonical. Materialize their
              // sorted provenance only when this safe witness enters the map.
              state.tokenBalances = activeTokenIndices.map((index) => ({
                token: tokenAt[index]!,
                gives: gives[index] ?? 0n,
                wants: wants[index] ?? 0n,
                net: nets[index] ?? 0n,
              })).sort((a, b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0);
              exact.set(key, state);
            }
          } else if (mergeOrder.reason === "unsafe-merge-order") {
            unsafeMergeOrderSubsets += 1;
          } else if (
            mergeOrder.reason === "aborted" ||
            mergeOrder.reason === "abort-check-failed"
          ) {
            reason = mergeOrder.reason;
            return;
          } else if (mergeOrder.reason === "merge-order-work-cap") {
            reason = mergeWorkLimit < MAX_SAFE_MERGE_ORDER_WORK
              ? "discovery-work-cap"
              : "merge-order-work-cap";
            return;
          }
        } else if (economicCandidate && amountCapped) {
          amountCappedSubsets += 1;
        }

        // Never prune an unbalanced or numerically out-of-range partial set: a
        // later physical maker can repair its deficits and signed net amounts.
        if (selected.length < limits.maxMakersPerCombination) {
          visit(index + 1, 0n, 0n, nextSortedPrefixSafe);
        }
      } finally {
        selected.pop();
        if (outputWasAbsent) {
          gives[candidateOutputIndex] = undefined;
          nets[candidateOutputIndex] = undefined;
          const removed = activeTokenIndices.pop();
          if (removed !== candidateOutputIndex) throw new Error("balance stack corruption");
        } else {
          gives[candidateOutputIndex] = gives[candidateOutputIndex]! - candidate.amountOut;
          nets[candidateOutputIndex] = nets[candidateOutputIndex]! - candidate.amountOut;
        }
        if (inputWasAbsent) {
          wants[candidateInputIndex] = undefined;
          nets[candidateInputIndex] = undefined;
          const removed = activeTokenIndices.pop();
          if (removed !== candidateInputIndex) throw new Error("balance stack corruption");
        } else {
          wants[candidateInputIndex] = wants[candidateInputIndex]! - candidate.amountIn;
          nets[candidateInputIndex] = nets[candidateInputIndex]! + candidate.amountIn;
        }
      }
    }
  };

  visit(0, 0n, 0n, true);
  return {
    exact,
    visitedSubsets,
    amountCappedSubsets,
    safeMergeOrderWork,
    unsafeMergeOrderSubsets,
    reason,
  };
}

const FRONTIER_SORT_ABORT = Symbol("frontier-sort-abort");

function bestOutputFrontier(
  exact: ReadonlyMap<string, CombinationState>,
  shouldAbort: (() => boolean) | undefined,
): {
  frontier: CombinationState[];
  reason: "aborted" | "abort-check-failed" | null;
} {
  const ordered = [...exact.values()];
  let comparisonWork = 0;
  let reason: "aborted" | "abort-check-failed" | null = null;
  try {
    ordered.sort((a, b) => {
      comparisonWork += 1;
      if ((comparisonWork & 255) === 0) {
        reason = abortReason(shouldAbort);
        if (reason !== null) throw FRONTIER_SORT_ABORT;
      }
      return a.input < b.input
        ? -1
        : a.input > b.input
        ? 1
        : compareHashes(a.offerHashes, b.offerHashes);
    });
  } catch (error) {
    if (error !== FRONTIER_SORT_ABORT) throw error;
    return { frontier: [], reason };
  }
  const frontier: CombinationState[] = [];
  let bestOutput = 0n;
  for (let index = 0; index < ordered.length; index += 1) {
    if ((index & 255) === 255) {
      reason = abortReason(shouldAbort);
      if (reason !== null) return { frontier: [], reason };
    }
    const candidate = ordered[index]!;
    if (candidate.output <= bestOutput) continue;
    frontier.push(candidate);
    bestOutput = candidate.output;
  }
  return { frontier, reason: null };
}

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
      tokenBalances: serializeWholeOfferTokenBalances(entry.tokenBalances),
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

const emptyDiagnostics = (): LadderDerivationDiagnostics => ({
  stopReason: null,
  invalidResourceLimit: null,
  sourceOffersScanned: 0,
  candidatePairsExamined: 0,
  discoveryWork: 0,
  safeMergeOrderWork: 0,
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

interface DiscoveryComponent {
  root: number;
  key: string;
  tokens: string[];
  cyclic: boolean;
}

interface DiscoveryGraph {
  componentByToken: Map<string, DiscoveryComponent>;
  components: DiscoveryComponent[];
  indexByToken: Map<string, number>;
  tokenAt: string[];
}

const chargeDeterministicSort = (
  length: number,
  budget: DiscoveryBudget,
): "discovery-work-cap" | "aborted" | "abort-check-failed" | null =>
  length < 2
    ? null
    : budget.charge(length * Math.ceil(Math.log2(length)), "discovery");

class DisjointTokenSets {
  readonly parent: number[] = [];
  readonly rank: number[] = [];

  add(): number {
    const index = this.parent.length;
    this.parent.push(index);
    this.rank.push(0);
    return index;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = value;
    while (this.parent[cursor] !== cursor) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.rank[leftRoot]! < this.rank[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.parent[rightRoot] = leftRoot;
    if (this.rank[leftRoot] === this.rank[rightRoot]) {
      this.rank[leftRoot] = this.rank[leftRoot]! + 1;
    }
  }
}

function buildDiscoveryGraph(
  offers: readonly Crossable[],
  budget: DiscoveryBudget,
): DiscoveryGraph | { reason: "discovery-work-cap" | "aborted" | "abort-check-failed" } {
  const sets = new DisjointTokenSets();
  const indexByToken = new Map<string, number>();
  const tokenAt: string[] = [];
  const indexFor = (
    token: string,
  ):
    | { ok: true; index: number }
    | { ok: false; reason: "discovery-work-cap" | "aborted" | "abort-check-failed" } => {
    const existing = indexByToken.get(token);
    if (existing !== undefined) return { ok: true, index: existing };
    const stopped = budget.charge();
    if (stopped !== null) return { ok: false, reason: stopped };
    const index = sets.add();
    indexByToken.set(token, index);
    tokenAt.push(token);
    return { ok: true, index };
  };

  for (const offer of offers) {
    const input = indexFor(offer.tokenIn);
    if (!input.ok) return input;
    const output = indexFor(offer.tokenOut);
    if (!output.ok) return output;
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    sets.union(input.index, output.index);
  }

  const componentsByRoot = new Map<number, DiscoveryComponent>();
  for (let index = 0; index < tokenAt.length; index += 1) {
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    const root = sets.find(index);
    const token = tokenAt[index]!;
    const component = componentsByRoot.get(root);
    if (component === undefined) {
      componentsByRoot.set(root, { root, key: token, tokens: [token], cyclic: false });
    } else {
      component.tokens.push(token);
      if (token < component.key) component.key = token;
    }
  }

  // Iterative global Kahn removal marks every weak component that contains at
  // least one directed cycle without recursive DFS/Tarjan stack growth.
  const indegree = new Array<number>(tokenAt.length).fill(0);
  const outgoing = Array.from({ length: tokenAt.length }, () => [] as number[]);
  for (const offer of offers) {
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    const input = indexByToken.get(offer.tokenIn)!;
    const output = indexByToken.get(offer.tokenOut)!;
    offer.tokenInIndex = input;
    offer.tokenOutIndex = output;
    outgoing[input]!.push(output);
    indegree[output]! += 1;
  }
  const queue: number[] = [];
  for (let index = 0; index < indegree.length; index += 1) {
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    if (indegree[index] === 0) queue.push(index);
  }
  let cursor = 0;
  while (cursor < queue.length) {
    const vertex = queue[cursor++]!;
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    for (const output of outgoing[vertex]!) {
      const edgeStopped = budget.charge();
      if (edgeStopped !== null) return { reason: edgeStopped };
      indegree[output]! -= 1;
      if (indegree[output] === 0) queue.push(output);
    }
  }
  for (let index = 0; index < indegree.length; index += 1) {
    const stopped = budget.charge();
    if (stopped !== null) return { reason: stopped };
    if (indegree[index]! > 0) {
      componentsByRoot.get(sets.find(index))!.cyclic = true;
    }
  }

  const componentSort = chargeDeterministicSort(componentsByRoot.size, budget);
  if (componentSort !== null) return { reason: componentSort };
  const components = [...componentsByRoot.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const componentByToken = new Map<string, DiscoveryComponent>();
  for (const component of components) {
    const tokenSort = chargeDeterministicSort(component.tokens.length, budget);
    if (tokenSort !== null) return { reason: tokenSort };
    component.tokens.sort();
    for (const token of component.tokens) componentByToken.set(token, component);
  }
  return { componentByToken, components, indexByToken, tokenAt };
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
  const pairExclusionKeys = new Set(
    excluded.map((entry) => `${entry.offerHash}:${entry.reason}`),
  );
  const addPairExclusion = (entry: LadderExclusion): void => {
    const key = `${entry.offerHash}:${entry.reason}`;
    if (pairExclusionKeys.has(key)) return;
    pairExclusionKeys.add(key);
    excluded.push(entry);
  };

  const levels: PriceLevelsPair[] = [];
  const provenance: LadderPairProvenance[] = [];
  type GlobalStop =
    | "global-search-cap"
    | "candidate-pair-cap"
    | "discovery-work-cap"
    | "aborted"
    | "abort-check-failed";
  let globalStop: GlobalStop | null = null;

  const discoveryBudget: DiscoveryBudget = {
    remaining: () => limits.maxDiscoveryWork - diagnostics.discoveryWork,
    charge: (work = 1, kind = "discovery") => {
      if (!Number.isSafeInteger(work) || work < 0) throw new RangeError("invalid discovery work");
      for (let unit = 0; unit < work; unit += 1) {
        if (diagnostics.discoveryWork >= limits.maxDiscoveryWork) {
          return "discovery-work-cap";
        }
        diagnostics.discoveryWork += 1;
        if (kind === "safe-merge-order") diagnostics.safeMergeOrderWork += 1;
        if (
          (diagnostics.discoveryWork & 255) === 0 &&
          globalStop !== "aborted" && globalStop !== "abort-check-failed"
        ) {
          const stopped = abortReason(options.shouldAbort);
          if (stopped !== null) return stopped;
        }
      }
      return null;
    },
  };

  // A universe is immutable and reused across endpoint pairs. Its full
  // exclusion set for a given reason is identical every time; scan it once.
  const excludedUniverses = new Map<readonly Crossable[], Set<LadderExclusionReason>>();
  const exclusionScanStop = Symbol("exclusion-scan-stop");
  const addPairExclusions = (
    bucket: readonly Crossable[],
    reason: LadderExclusionReason,
    detail?: LadderExclusion["detail"],
  ): void => {
    let reasons = excludedUniverses.get(bucket);
    if (reasons?.has(reason)) return;
    if (reasons === undefined) {
      reasons = new Set();
      excludedUniverses.set(bucket, reasons);
    }
    for (const offer of bucket) {
      const stopped = discoveryBudget.charge();
      if (stopped !== null) {
        // Cancellation always invalidates the whole snapshot, including when
        // its final diagnostics use the last discovery work unit.
        if (globalStop !== "aborted" && globalStop !== "abort-check-failed") {
          globalStop = stopped;
          diagnostics.stopReason = stopped;
        }
        throw exclusionScanStop;
      }
      addPairExclusion({ offerHash: offer.offerHash, reason, ...(detail === undefined ? {} : { detail }) });
    }
    reasons.add(reason);
  };

  try {
    const graph = buildDiscoveryGraph(retained, discoveryBudget);
    if ("reason" in graph) {
      globalStop = graph.reason;
      diagnostics.stopReason = graph.reason;
      addPairExclusions(retained, graph.reason);
      return emptyDerived(limits, diagnostics, excluded);
    }

    const cyclicComponents: DiscoveryComponent[] = [];
    for (const component of graph.components) {
      const componentWork = discoveryBudget.charge();
      if (componentWork !== null) {
        globalStop = componentWork;
        diagnostics.stopReason = componentWork;
        addPairExclusions(retained, componentWork);
        return emptyDerived(limits, diagnostics, excluded);
      }
      if (component.cyclic) cyclicComponents.push(component);
    }
    const wantedTokenSet = new Set<string>();
    for (const offer of retained) {
      const wantedWork = discoveryBudget.charge();
      if (wantedWork !== null) {
        globalStop = wantedWork;
        diagnostics.stopReason = wantedWork;
        addPairExclusions(retained, wantedWork);
        return emptyDerived(limits, diagnostics, excluded);
      }
      wantedTokenSet.add(offer.tokenIn);
    }
    const wantedTokens = [...wantedTokenSet];
    const wantedSort = chargeDeterministicSort(wantedTokens.length, discoveryBudget);
    if (wantedSort !== null) {
      globalStop = wantedSort;
      diagnostics.stopReason = wantedSort;
      addPairExclusions(retained, wantedSort);
      return emptyDerived(limits, diagnostics, excluded);
    }
    wantedTokens.sort();
    const universeCache = new Map<number, { offers: Crossable[]; outputs: string[] }>();
    // Pair searches run sequentially. Populate graph-indexed balance slots only
    // for composed branches and reuse them after exact DFS rollback.
    const searchScratch: PairSearchScratch = {
      gives: [],
      wants: [],
      nets: [],
      activeTokenIndices: [],
      selected: [],
    };

    const universeFor = (
      inputComponent: DiscoveryComponent,
    ):
      | { ok: true; offers: Crossable[]; outputs: string[] }
      | { ok: false; reason: "discovery-work-cap" | "aborted" | "abort-check-failed" } => {
      const cached = universeCache.get(inputComponent.root);
      if (cached !== undefined) return { ok: true, ...cached };
      const included = inputComponent.cyclic
        ? cyclicComponents
        : [inputComponent, ...cyclicComponents];
      const componentRoots = new Set<number>();
      for (const component of included) {
        const componentWork = discoveryBudget.charge();
        if (componentWork !== null) return { ok: false, reason: componentWork };
        componentRoots.add(component.root);
      }
      const universeOffers: Crossable[] = [];
      const outputs = new Set<string>();
      // `retained` is already sorted by full hash, so filtering it avoids an
      // additional comparison sort while preserving physical tie order.
      for (const offer of retained) {
        const offerWork = discoveryBudget.charge();
        if (offerWork !== null) return { ok: false, reason: offerWork };
        const component = graph.componentByToken.get(offer.tokenIn)!;
        if (!componentRoots.has(component.root)) continue;
        universeOffers.push(offer);
        outputs.add(offer.tokenOut);
      }
      const outputTokens = [...outputs];
      const outputSort = chargeDeterministicSort(outputTokens.length, discoveryBudget);
      if (outputSort !== null) return { ok: false, reason: outputSort };
      outputTokens.sort();
      const cachedUniverse = { offers: universeOffers, outputs: outputTokens };
      universeCache.set(inputComponent.root, cachedUniverse);
      return { ok: true, ...cachedUniverse };
    };

    pairDiscovery:
    for (const tokenIn of wantedTokens) {
      const universe = universeFor(graph.componentByToken.get(tokenIn)!);
      if (!universe.ok) {
        globalStop = universe.reason;
        diagnostics.stopReason = universe.reason;
        break;
      }
      for (const tokenOut of universe.outputs) {
        if (tokenOut === tokenIn) continue;
        if (diagnostics.candidatePairsExamined >= limits.maxCandidatePairs) {
          globalStop = "candidate-pair-cap";
          diagnostics.stopReason = globalStop;
          break pairDiscovery;
        }
        const pairWorkStart = diagnostics.discoveryWork;
        const pairDiscoveryWork = discoveryBudget.charge();
        if (pairDiscoveryWork !== null) {
          globalStop = pairDiscoveryWork;
          diagnostics.stopReason = pairDiscoveryWork;
          break pairDiscovery;
        }
        diagnostics.candidatePairsExamined += 1;

        const bucket = universe.offers;
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
          discoveryWork: 0,
          safeMergeOrderWork: 0,
        };
        diagnostics.pairs.push(diagnostic);

        try {
          if (levels.length >= limits.maxPairs) {
            diagnostic.reason = "pair-cap";
            addPairExclusions(bucket, "pair-cap");
            continue;
          }
          if (
            options.supportedPairs != null &&
            !options.supportedPairs.has(admissionPairKey(tokenIn, tokenOut))
          ) {
            diagnostic.reason = "unsupported-pair";
            addPairExclusions(bucket, "unsupported-pair");
            continue;
          }
          const minimum = options.minJobOutput?.get(tokenOut);
          if (options.minJobOutput != null && minimum === undefined) {
            diagnostic.reason = "minimum-output";
            addPairExclusions(bucket, "minimum-output");
            continue;
          }

          const stopped = abortReason(options.shouldAbort);
          if (stopped !== null) {
            globalStop = stopped;
            diagnostics.stopReason = stopped;
            diagnostic.reason = stopped;
            addPairExclusions(bucket, stopped);
            break pairDiscovery;
          }

          const search = enumeratePair(
            bucket,
            tokenIn,
            tokenOut,
            graph.indexByToken.get(tokenIn)!,
            graph.indexByToken.get(tokenOut)!,
            graph.tokenAt,
            searchScratch,
            limits,
            diagnostics,
            options.shouldAbort,
            discoveryBudget,
          );
          diagnostic.visitedSubsets = search.visitedSubsets;
          diagnostic.storedExactInputs = search.exact.size;
          diagnostic.amountCappedSubsets = search.amountCappedSubsets;
          diagnostic.safeMergeOrderWork = search.safeMergeOrderWork;
          diagnostics.peakStoredExactInputs = Math.max(
            diagnostics.peakStoredExactInputs,
            search.exact.size,
          );
          if (search.reason !== null) {
            diagnostic.reason = search.reason;
            if (
              search.reason === "global-search-cap" ||
              search.reason === "discovery-work-cap" ||
              search.reason === "aborted" ||
              search.reason === "abort-check-failed"
            ) {
              globalStop = search.reason;
              diagnostics.stopReason = search.reason;
              addPairExclusions(bucket, search.reason);
              break pairDiscovery;
            }
            addPairExclusions(bucket, search.reason);
            continue;
          }

          const stoppedAfterSearch = abortReason(options.shouldAbort);
          if (stoppedAfterSearch !== null) {
            globalStop = stoppedAfterSearch;
            diagnostics.stopReason = stoppedAfterSearch;
            diagnostic.reason = stoppedAfterSearch;
            addPairExclusions(bucket, stoppedAfterSearch);
            break pairDiscovery;
          }

          const frontierResult = bestOutputFrontier(search.exact, options.shouldAbort);
          if (frontierResult.reason !== null) {
            globalStop = frontierResult.reason;
            diagnostics.stopReason = frontierResult.reason;
            diagnostic.reason = frontierResult.reason;
            addPairExclusions(
              bucket,
              frontierResult.reason,
            );
            break pairDiscovery;
          }
          let frontier = frontierResult.frontier;
          if (minimum !== undefined) frontier = frontier.filter((entry) => entry.output >= minimum);
          if (frontier.length === 0) {
            diagnostic.reason = search.amountCappedSubsets > 0
              ? "settlement-amount-cap"
              : search.unsafeMergeOrderSubsets > 0
              ? "unsafe-merge-order"
              : "minimum-output";
            addPairExclusions(bucket, diagnostic.reason);
            continue;
          }

          const { encoded, truncationReasons } = longestEncodableFrontier(
            frontier, limits.maxWirePointsPerPair,
          );
          if (encoded === null) {
            diagnostic.reason = truncationReasons[0]!;
            for (const reason of truncationReasons) {
              addPairExclusions(bucket, reason);
            }
            continue;
          }

          const stoppedAfterEncoding = abortReason(options.shouldAbort);
          if (stoppedAfterEncoding !== null) {
            globalStop = stoppedAfterEncoding;
            diagnostics.stopReason = stoppedAfterEncoding;
            diagnostic.reason = stoppedAfterEncoding;
            addPairExclusions(bucket, stoppedAfterEncoding);
            break pairDiscovery;
          }

          const pair: PriceLevelsPair = { tokenIn, tokenOut, levels: encoded.levels };
          const rejection = rejectPair(pair);
          if (rejection !== null || !isPriceLevelsPair(pair)) {
            diagnostic.reason = "invalid-pair";
            addPairExclusions(bucket, "invalid-pair", rejection ?? undefined);
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
              const stopped = discoveryBudget.charge();
              if (stopped !== null) {
                globalStop = stopped;
                diagnostics.stopReason = stopped;
                throw exclusionScanStop;
              }
              if (!used.has(offer.offerHash)) {
                for (const reason of truncationReasons) {
                  addPairExclusion({ offerHash: offer.offerHash, reason });
                }
              }
            }
          }
        } finally {
          diagnostic.discoveryWork = diagnostics.discoveryWork - pairWorkStart;
        }
      }
    }

  } catch (error) {
    if (error !== exclusionScanStop) throw error;
    const lastPair = diagnostics.pairs.at(-1);
    if (lastPair?.status === "withheld") lastPair.reason = globalStop;
    // Completed pairs remain proved on an auxiliary-work cap. The global stop
    // marks diagnostic collection incomplete; no additional scan runs outside
    // the budget. Cancellation is handled below and clears every publication.
  }

  // Cancellation invalidates the whole snapshot, including completed pairs.
  if (globalStop === "aborted" || globalStop === "abort-check-failed") {
    for (const diagnostic of diagnostics.pairs) {
      if (diagnostic.status !== "published") continue;
      diagnostic.status = "withheld";
      diagnostic.reason = globalStop;
      diagnostic.frontierCombinations = 0;
      diagnostic.wirePoints = 0;
    }
    try {
      addPairExclusions(retained, globalStop);
    } catch (error) {
      if (error !== exclusionScanStop) throw error;
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
