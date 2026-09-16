// Midnight Intents swap-job execution (spec R2, FR-010/011/016/018/019).
//
// Numeric job in; exact maker files fetched AFTER arrival; proved inverse half
// out. The relay, never this module, merges the taker's half and submits. Every
// uncertain boundary fails closed with `job-error`. Wallet mutations are kept
// as one solver-owned FinalizedTransaction per job so `submit-failed` and the
// chain-TTL sweeper can revert exactly the solver's contribution.
//
// ACCEPTANCE (P4-F01, FR-001). The relay dispatches the taker's exact demand,
// which it only guarantees to be AT MOST the interpolated output of the
// published ladder. A job is therefore admitted whenever
// `0 < amountOut <= interpolateQuote(levels, amountIn)`; the taker is paid
// exactly `amountOut`. The canonical affordable whole-offer combination funds
// that payout, and the solver receives any input and output surplus. New jobs
// reserve only offer hashes and nullifiers; they never spend swap-token stock.
// Publication and admission share the same exact search and resource limits.
//
// CAPITAL-FREE FEE SIZING (00006 FR-001/FR-002). Fee sizing used to open with a
// MIRROR: `initSwap` selecting the taker's full `amountIn` of tokenIn out of the
// solver's own wallet, immediately reverted, handed to the DUST balancer as the
// taker-half stand-in. It is now a SYNTHETIC stand-in built from ledger
// primitives (`@zswap-da/solver-core/fee-sizing`), because the DUST fee is a
// function of transaction STRUCTURE only. Consequences:
//   * fee sizing spends, reserves and mutates NOTHING — one fewer
//     mutate-then-revert wallet class per job;
//   * an empty token wallet can quote and settle every whole-maker rung;
//   * new jobs write no `MIRROR_RESERVATION`/`MIRROR_REVERT` journal rows. The
//     recovery filters still READ those kinds so pre-existing rows recover
//     (FR-004).

import { Transaction, type FinalizedTransaction } from "@midnightntwrk/ledger-v9";
import { createHash } from "node:crypto";

import {
  admissionPairKey,
  forwardAdmissionPolicy,
  type JobAdmissionPolicy,
} from "@zswap-da/solver-core/admission-policy";
import {
  readExactOfferFiles,
  reconstructOffer,
} from "@zswap-da/solver-core/api-client";
import {
  canonicalRelayExtrinsicHash,
  getOfferConsumptionEvidence,
  getRelayJobStatus,
  type OfferConsumptionResponse,
  type RelayJobStatus,
} from "@zswap-da/solver-core/receipt-client";
import {
  MAX_EXACT_FILES_PER_READ,
  type ExactFilesResponse,
} from "@zswap-da/solver-core/exact-files-contract";
import {
  deriveLadder,
  MAX_SETTLEMENT_AMOUNT,
  resolveLadderResourceLimits,
  type LadderResourceLimitControls,
  type LadderPairProvenance,
} from "@zswap-da/solver-core/ladder-derivation";
import {
  accountWholeOfferBalances,
  buildWholeOfferReceipts,
  findSafeWholeOfferMergeOrder,
  MAX_SAFE_MERGE_ORDER_WORK,
  serializeWholeOfferTokenBalances,
  type WholeOfferReceipt,
  type WholeOfferTokenBalance,
} from "@zswap-da/solver-core/whole-offer-balance";
import {
  interpolateQuote,
  type JobErrorMessage,
  type SubmitFailedMessage,
  type SwapMessage,
  type SwapTxMessage,
  type TxSubmittedMessage,
} from "@zswap-da/solver-core/relay-ws-contract";
import {
  mergeFinalized,
  tokenImbalances,
  type Imbalance,
} from "@zswap-da/solver-core/batcher";
import {
  buildTakerHalfStandIn,
  DEFAULT_MODELLED_TAKER_INPUTS,
  MAX_MODELLED_TAKER_INPUTS,
  MIN_MODELLED_TAKER_INPUTS,
  takerHalfStandInSpec,
} from "@zswap-da/solver-core/fee-sizing";
import {
  collectNullifiers,
  deriveLegs,
} from "@zswap-da/validator";

import type { Book, BookOffer } from "./book.ts";
import {
  type JournalClaim,
  type JournalLifecycleState,
  type JournalOperation,
  type JournalOperationKind,
  type SolverOperationJournal,
  type WalletArtifactKind,
} from "./operation-journal.ts";
import { claimFor, type Claim, type Stock } from "./stock.ts";

export const JOB_AT_CAPACITY = "solver_at_capacity";
export const JOB_DUPLICATE = "duplicate_job_id";
export const JOB_CACHE_NOT_CURRENT = "book_cache_not_current";
export const JOB_ROUTE_NOT_CURRENT = "route_not_current";
export const JOB_ROUTE_UNAVAILABLE = "route_unavailable";
export const JOB_EXACT_FILES_UNAVAILABLE = "exact_files_unavailable";
export const JOB_EXACT_FILE_REFUSED = "exact_file_refused";
export const JOB_EXACT_FILE_MISMATCH = "exact_file_mismatch";
export const JOB_WALLET_FAILED = "wallet_build_failed";
export const JOB_WALLET_TIMEOUT = "wallet_build_timeout";
export const JOB_RECONCILING = "journal_reconciliation_in_progress";
export const JOB_PAIR_UNSUPPORTED = "pair_not_supported";
export const JOB_MIN_OUTPUT = "minimum_output_not_met";
export const JOB_DUST_PER_JOB = "dust_per_job_limit";
export const JOB_DUST_WINDOW = "dust_window_exhausted";
export const JOB_DUST_ESTIMATE = "dust_estimate_unavailable";

const HEX64 = /^[0-9a-f]{64}$/i;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const abortError = (reason: unknown, fallback: string): Error =>
  reason instanceof Error ? reason : new Error(reason === undefined ? fallback : String(reason));

class JobRefusal extends Error {
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = "JobRefusal";
    this.reason = reason;
  }
}

class WalletBuildTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`wallet build exceeded ${timeoutMs} ms`);
    this.name = "WalletBuildTimeout";
  }
}

/** A job-error may be sent only after wallet mutation is either undone or
 * retained for retry. This carries the exact solver-owned finalized residue
 * into the normal TTL/revert state machine when immediate cleanup failed. */
class WalletCleanupFailure extends JobRefusal {
  readonly walletTransaction: FinalizedTransaction;
  readonly ttlExpiresAt: number;

  constructor(detail: string, walletTransaction: FinalizedTransaction, ttlExpiresAt: number) {
    super(JOB_WALLET_FAILED, detail);
    this.name = "WalletCleanupFailure";
    this.walletTransaction = walletTransaction;
    this.ttlExpiresAt = ttlExpiresAt;
  }
}

/** The wallet could not acknowledge release of an unfinalized mutation it had
 * already applied (the DUST balancing transaction, or a residual leg before it
 * was finalized). It must remain an occupied slot/claim and be retried by the
 * sweeper; releasing it would let uncertain wallet state fund another job.
 *
 * Since 00006 FR-001 fee sizing is NOT one of these: its taker-half stand-in is
 * fabricated from ledger primitives, so it never becomes wallet state and can
 * never be the source of this ambiguity. */
class WalletMutationUncertain extends JobRefusal {
  readonly rawTransactions: unknown[];
  readonly walletTransaction: FinalizedTransaction | undefined;
  readonly ttlExpiresAt: number;

  constructor(
    detail: string,
    rawTransactions: unknown[],
    walletTransaction: FinalizedTransaction | undefined,
    ttlExpiresAt: number,
  ) {
    super(JOB_WALLET_FAILED, detail);
    this.name = "WalletMutationUncertain";
    this.rawTransactions = rawTransactions;
    this.walletTransaction = walletTransaction;
    this.ttlExpiresAt = ttlExpiresAt;
  }
}

export interface SwapJobWallet {
  shielded: { getAddress: () => Promise<unknown> };
  dust: {
    balanceTransactions: (
      dustSecretKey: unknown,
      transactions: unknown[],
      ttl: Date,
    ) => Promise<unknown>;
  };
  initSwap: (
    inputs: unknown,
    outputs: unknown,
    keys: unknown,
    options: { ttl: Date; payFees: boolean },
  ) => Promise<{ transaction: unknown }>;
  finalizeTransaction: (transaction: unknown) => Promise<FinalizedTransaction>;
  revertTransaction: (transaction: unknown) => Promise<void>;
  revert: (transaction: unknown) => Promise<void>;
}

export interface SwapJobCache {
  readonly book: Book<BookOffer>;
  isCurrent: () => boolean;
}

export interface ExactOfferSemantics {
  gives: Array<{ token: string; amount: string | bigint; kind: string }>;
  wants: Array<{ token: string; amount: string | bigint; kind: string }>;
  nullifiers: string[];
}

export interface SwapJobDependencies {
  /** FR-001's taker-half stand-in. A pure ledger call — no wallet, no coin
   * selection, nothing to revert. Injected so the wallet doubles can assert
   * that fee sizing reaches it and never reaches `initSwap`. */
  buildFeeSizingStandIn: typeof buildTakerHalfStandIn;
  readExactOfferFiles: typeof readExactOfferFiles;
  getOfferConsumptionEvidence: typeof getOfferConsumptionEvidence;
  getRelayJobStatus: typeof getRelayJobStatus;
  reconstructOffer: typeof reconstructOffer;
  deriveOfferSemantics: (transaction: unknown) => ExactOfferSemantics;
  mergeFinalized: typeof mergeFinalized;
  tokenImbalances: typeof tokenImbalances;
  serializeUnproven: (transaction: unknown) => Uint8Array;
  deserializeUnproven: (bytes: Uint8Array) => unknown;
  serializeFinalized: (transaction: FinalizedTransaction) => Uint8Array;
  deserializeFinalized: (bytes: Uint8Array) => FinalizedTransaction;
}

const DEFAULT_DEPENDENCIES: SwapJobDependencies = {
  buildFeeSizingStandIn: buildTakerHalfStandIn,
  readExactOfferFiles,
  getOfferConsumptionEvidence,
  getRelayJobStatus,
  reconstructOffer,
  deriveOfferSemantics: (transaction) => {
    const ledgerTransaction = transaction as Parameters<typeof deriveLegs>[0];
    const legs = deriveLegs(ledgerTransaction);
    return {
      gives: legs.gives,
      wants: legs.wants,
      nullifiers: collectNullifiers(ledgerTransaction),
    };
  },
  mergeFinalized,
  tokenImbalances,
  serializeUnproven: (transaction) => (transaction as { serialize: () => Uint8Array }).serialize(),
  deserializeUnproven: (bytes) =>
    Transaction.deserialize("signature", "pre-proof", "pre-binding", bytes),
  serializeFinalized: (transaction) => transaction.serialize(),
  deserializeFinalized: (bytes) =>
    Transaction.deserialize("signature", "proof", "binding", bytes),
};

export interface SwapJobTimers {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: SwapJobTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SwapJobExecutorOptions extends JobAdmissionPolicy {
  cache: SwapJobCache;
  stock: Stock;
  wallet: SwapJobWallet;
  journal: SolverOperationJournal;
  keys: { dustSecretKey: unknown } & Record<string, unknown>;
  /**
   * The network id the WALLET was built with (FR-001).
   *
   * The fee-sizing stand-in is a real ledger transaction, so it carries a
   * network id, and the DUST balancer merges it with the solver's own half. The
   * ledger accepts any string at construction time (measured) and only refuses
   * at the merge — `invalid network ID - expect 'undeployed' found 'testnet'` —
   * so a mis-threaded value would surface as a per-job `wallet_build_failed`
   * rather than a configuration error. It is validated here at startup instead,
   * and threaded from the SAME source the wallet facade reads
   * (`midnightNetworkConfig.id`) rather than imported, so tests stay hermetic.
   */
  networkId: string;
  /**
   * How many taker zswap inputs fee sizing models (FR-001). Defaults to
   * `DEFAULT_MODELLED_TAKER_INPUTS` (1) — the shape 00005's deployed E2E
   * actually observed, which makes the reserved DUST identical to the mirror's.
   * The reservation funds a real taker half of up to `n + 2` inputs; see
   * `@zswap-da/solver-core/fee-sizing`.
   */
  modelledTakerInputs?: number;
  resourceLimits?: Readonly<LadderResourceLimitControls>;
  api?: string;
  /** Explicit relay HTTP authority. Never derived from the websocket URL. */
  relayHttpUrl: string;
  maxParallelSwaps: number;
  expiryMarginSeconds: number;
  dustAdmission?: {
    maxPerJob: bigint;
    maxPerWindow: bigint;
    windowMs: number;
  } | null;
  /** Schedules an immediate relay withdrawal after an atomic window refusal. */
  onDustWindowBlocked?: () => void;
  settleTtlMinutes: number;
  requestTimeoutMs?: number;
  walletOperationTimeoutMs?: number;
  sweepIntervalMs?: number;
  nowMs?: () => number;
  timers?: SwapJobTimers;
  signal?: AbortSignal;
  dependencies?: Partial<SwapJobDependencies>;
  /** Called only after positive tx-bound backend ledger evidence. */
  onOfferConsumed?: (offerHash: string) => void;
  refreshBalances?: () => Promise<void>;
  /** Test-only crash seam. Production must leave this undefined. It runs
   * after a recovered wallet revert returns and before terminal journal CAS. */
  recoveryRevertTestHook?: (event: {
    operationKey: string;
    sourceOperationKeys: readonly string[];
    walletArtifactKind: WalletArtifactKind;
  }) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface SwapJobExecutorStats {
  building: number;
  quarantined: number;
  awaitingRelay: number;
  awaitingConsumption: number;
  completed: number;
  refused: number;
  reverted: number;
  revertFailures: number;
  timedOutBuilds: number;
  stopped: boolean;
}

export interface SwapJobExecutorHandle {
  onSwap: (job: SwapMessage) => Promise<SwapTxMessage | JobErrorMessage>;
  onTxSubmitted: (message: TxSubmittedMessage) => Promise<void>;
  onSubmitFailed: (message: SubmitFailedMessage) => Promise<void>;
  notifyConsumed: (offerHash: string) => void;
  unavailableOfferHashes: () => string[];
  dustAvailable: () => boolean;
  /** Resolves after durable claims have been rebuilt and all locally decidable
   * startup records have been reconciled. Relay startup must await this. */
  ready: Promise<void>;
  sweep: () => Promise<void>;
  idle: () => Promise<void>;
  stop: () => Promise<void>;
  stats: () => SwapJobExecutorStats;
}

/** Exact maker witness and every value received by the solver for one new job.
 * Receipts are outputs, never inventory obligations. Journal recovery reads
 * its persisted claims/artifacts independently of this new-admission route. */
interface ResolvedRoute {
  /** Sorted physical identity used by claims, journals, and exact-file reads. */
  offers: BookOffer[];
  /** Exact canonical maker accounting reconstructed from the current book. */
  tokenBalances: WholeOfferTokenBalance[];
  /** Sorted positive per-token solver outputs; zero balances are absent. */
  receipts: WholeOfferReceipt[];
  /** Deterministic numeric-safe order used only for actual SDK merges. */
  mergeOrder: string[];
  claim: Claim;
}

interface BuiltHalf {
  relayTransaction: FinalizedTransaction;
  /** Only transactions created by this wallet. Maker offer transactions are
   * deliberately excluded so revert cannot walk foreign pending state. */
  walletTransaction: FinalizedTransaction;
  ttlExpiresAt: number;
}

interface BuildingJob {
  job: SwapMessage;
  claim: Claim;
  offerHashes: string[];
  timedOut: boolean;
  generation: number;
  operationKey: string;
  ttlExpiresAt: number;
}

interface AwaitingJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  walletTransaction: FinalizedTransaction;
  ttlExpiresAt: number;
  reverting: boolean;
  /** False for a build that returned job-error but whose immediate wallet
   * cleanup failed. Relay lifecycle messages cannot authorize that residue. */
  relayAccepted: boolean;
  generation: number;
  operationKey: string;
}

interface ConsumptionJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  ttlExpiresAt: number;
  generation: number;
  operationKey: string;
}

interface QuarantinedJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  rawTransaction?: unknown;
  rawTransactions?: unknown[];
  walletTransaction?: FinalizedTransaction;
  ttlExpiresAt: number;
  reverting: boolean;
  generation: number;
  operationKey: string;
  /** Relay/backend ambiguity is intentionally not decided locally in RF1B. */
  locallyRevertible: boolean;
  /** Retry relay HTTP plus backend ledger evidence, never local inference. */
  evidenceReconcile: boolean;
}

const snapshotOffer = (offer: BookOffer): BookOffer => ({
  offerHash: offer.offerHash,
  gives: offer.gives.map((leg) => ({ ...leg })),
  wants: offer.wants.map((leg) => ({ ...leg })),
  expiresAt: offer.expiresAt,
  firstSeenAt: offer.firstSeenAt,
  inputNullifiers: [...offer.inputNullifiers],
});

const requireCanonicalJob = (job: SwapMessage): void => {
  if (!HEX64.test(job.tokenIn) || !HEX64.test(job.tokenOut)) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "token ids must be 64-hex");
  }
  if (job.tokenIn.toLowerCase() === job.tokenOut.toLowerCase()) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "token ids must be distinct");
  }
  const amountIn = BigInt(job.amountIn);
  const amountOut = BigInt(job.amountOut);
  if (amountIn <= 0n || amountOut <= 0n || amountIn > MAX_SETTLEMENT_AMOUNT || amountOut > MAX_SETTLEMENT_AMOUNT) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "amount is outside the supported ledger-v9 signed-delta settlement domain");
  }
};

const matchingPair = (
  levels: ReturnType<typeof deriveLadder>["levels"],
  provenance: ReturnType<typeof deriveLadder>["provenance"],
  job: SwapMessage,
): { levels: (typeof levels)[number]; provenance: LadderPairProvenance } | null => {
  const tokenIn = job.tokenIn.toLowerCase();
  const tokenOut = job.tokenOut.toLowerCase();
  const index = levels.findIndex(
    (pair) => pair.tokenIn === tokenIn && pair.tokenOut === tokenOut,
  );
  return index < 0 ? null : { levels: levels[index]!, provenance: provenance[index]! };
};

/** Resolve exactly the route the current published derivation implies. */
export function resolveSwapJobRoute(
  job: SwapMessage,
  cache: SwapJobCache,
  stock: Stock,
  options: JobAdmissionPolicy & {
    nowMs: number;
    expiryMarginSeconds: number;
    unavailableOfferHashes: Iterable<string>;
    resourceLimits?: Readonly<LadderResourceLimitControls>;
    freshNowMs?: () => number;
    shouldAbort?: () => boolean;
  },
): ResolvedRoute {
  requireCanonicalJob(job);
  if (!cache.isCurrent()) throw new JobRefusal(JOB_CACHE_NOT_CURRENT);
  const tokenIn = job.tokenIn.toLowerCase();
  const tokenOut = job.tokenOut.toLowerCase();
  if (options.supportedPairs != null && !options.supportedPairs.has(admissionPairKey(tokenIn, tokenOut))) {
    throw new JobRefusal(JOB_PAIR_UNSUPPORTED);
  }
  const minimum = options.minJobOutput?.get(tokenOut);
  if (options.minJobOutput != null && (minimum === undefined || BigInt(job.amountOut) < minimum)) {
    throw new JobRefusal(JOB_MIN_OUTPUT);
  }

  const limits = resolveLadderResourceLimits(options.resourceLimits);
  if (!limits.ok || cache.book.size > limits.limits.maxSourceOffers) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "canonical derivation source/resource bound exceeded");
  }
  const sourceOffers = cache.book.all();
  const derived = deriveLadder(sourceOffers, {
    nowMs: options.nowMs,
    expiryMarginSeconds: options.expiryMarginSeconds,
    unavailableOfferHashes: options.unavailableOfferHashes,
    resourceLimits: limits.limits,
    shouldAbort: () => !cache.isCurrent() || options.shouldAbort?.() === true,
    ...forwardAdmissionPolicy(options),
  });
  // Read currentness and elapsed expiry again after synchronous computation.
  const freshNow = options.freshNowMs?.() ?? options.nowMs;
  if (!cache.isCurrent() || options.shouldAbort?.() === true) {
    throw new JobRefusal(JOB_CACHE_NOT_CURRENT);
  }
  if (cache.book.size !== sourceOffers.length || sourceOffers.some((offer) =>
    cache.book.get(offer.offerHash) !== offer ||
    (offer.expiresAt !== null &&
      offer.expiresAt - options.expiryMarginSeconds * 1_000 > options.nowMs &&
      offer.expiresAt - options.expiryMarginSeconds * 1_000 <= freshNow))) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "book changed or expired during derivation");
  }
  const pair = matchingPair(derived.levels, derived.provenance, job);
  if (pair === null) throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "directed pair is absent");

  const amountIn = BigInt(job.amountIn);
  const amountOut = BigInt(job.amountOut);
  // The relay promises the taker AT MOST the interpolated output and dispatches
  // whatever the taker actually demanded, so the honourable admission test is
  // `0 < amountOut <= quoted`, not equality (`amountOut > 0` is already proved
  // by `requireCanonicalJob`). Refusing a lowered demand refused every real
  // reference job (P4-F01); demanding MORE than the published curve is still
  // refused, and that refusal is the negative control the suite pins.
  const quoted = interpolateQuote(pair.levels.levels, amountIn);
  if (quoted === null) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "size is outside the current ladder");
  }
  if (amountOut > quoted) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, `current output is ${quoted}`);
  }

  const witness = pair.provenance.combinations.findLast((entry) => BigInt(entry.input) <= amountIn);
  if (witness === undefined || witness.offerHashes.length === 0 ||
    witness.offerHashes.length > MAX_EXACT_FILES_PER_READ ||
    witness.offerHashes.length > derived.limits.maxMakersPerCombination ||
    new Set(witness.offerHashes).size !== witness.offerHashes.length) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "missing or invalid complete-offer witness");
  }
  const offers = [...witness.offerHashes].sort().map((hash) => {
    const offer = cache.book.get(hash);
    if (offer === undefined) throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "route offer disappeared");
    return snapshotOffer(offer);
  });
  for (const offer of offers) {
    const give = offer.gives[0];
    const want = offer.wants[0];
    if (offer.gives.length !== 1 || offer.wants.length !== 1 ||
      give?.kind !== "SHIELDED" || want?.kind !== "SHIELDED" ||
      give.amount <= 0n || want.amount <= 0n) {
      throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "maker terms no longer match the witness");
    }
  }

  let tokenBalances: WholeOfferTokenBalance[];
  try {
    tokenBalances = accountWholeOfferBalances(offers);
  } catch (error) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, `invalid maker accounting: ${errorMessage(error)}`);
  }
  if (
    JSON.stringify(serializeWholeOfferTokenBalances(tokenBalances)) !==
      JSON.stringify(witness.tokenBalances)
  ) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "current maker accounting differs from the witness");
  }
  const receiptResult = buildWholeOfferReceipts(tokenBalances, {
    tokenIn,
    tokenOut,
    input: amountIn,
    output: amountOut,
  });
  if (!receiptResult.ok ||
    receiptResult.requiredInput !== BigInt(witness.input) ||
    receiptResult.availableOutput !== BigInt(witness.output) ||
    receiptResult.availableOutput !== quoted) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "complete maker totals do not back the exact job");
  }

  const mergeOrder = findSafeWholeOfferMergeOrder(
    offers.map((offer) => ({
      offerHash: offer.offerHash,
      gives: offer.gives,
      wants: offer.wants,
    })),
    {
      maxSources: derived.limits.maxMakersPerCombination,
      maxWork: Math.min(MAX_SAFE_MERGE_ORDER_WORK, derived.limits.maxDiscoveryWork),
    },
  );
  if (!mergeOrder.ok) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, `maker merge order is unavailable: ${mergeOrder.reason}`);
  }
  const claim = claimFor(offers, new Map());
  if (!stock.reserve(claim)) {
    throw new JobRefusal(JOB_ROUTE_UNAVAILABLE, "route is already claimed");
  }
  return {
    offers,
    tokenBalances,
    receipts: receiptResult.receipts,
    mergeOrder: mergeOrder.offerHashes,
    claim,
  };
}

const canonicalAmount = (value: string | bigint): bigint => BigInt(value);

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  [...new Set(left.map((value) => value.toLowerCase()))].sort().join(",") ===
  [...new Set(right.map((value) => value.toLowerCase()))].sort().join(",");

function exactSemanticsMatch(offer: BookOffer, semantics: ExactOfferSemantics): boolean {
  if (semantics.gives.length !== offer.gives.length || semantics.wants.length !== offer.wants.length) {
    return false;
  }
  const legs = (values: Array<{ token: string; amount: string | bigint; kind: string }>) =>
    values.map((leg) => `${leg.kind}:${leg.token.toLowerCase()}:${canonicalAmount(leg.amount)}`).sort();
  const cached = (values: BookOffer["gives"]) =>
    values.map((leg) => `${leg.kind}:${leg.token.toLowerCase()}:${leg.amount}`).sort();
  return legs(semantics.gives).join("|") === cached(offer.gives).join("|") &&
    legs(semantics.wants).join("|") === cached(offer.wants).join("|") &&
    sameSet(semantics.nullifiers, offer.inputNullifiers);
}

const aggregateTokenImbalances = (imbalances: Imbalance[]): Map<string, bigint> => {
  const result = new Map<string, bigint>();
  for (const imbalance of imbalances) {
    if (imbalance.tag === "dust") continue;
    if (imbalance.tag !== "shielded") {
      throw new JobRefusal(JOB_WALLET_FAILED, "solver half contains a non-shielded imbalance");
    }
    const token = imbalance.raw.toLowerCase();
    result.set(token, (result.get(token) ?? 0n) + imbalance.amount);
  }
  for (const [token, amount] of result) if (amount === 0n) result.delete(token);
  return result;
};

const balanceNetMap = (
  balances: Iterable<Pick<WholeOfferTokenBalance, "token" | "net">>,
): Map<string, bigint> => new Map(
  [...balances]
    .filter((balance) => balance.net !== 0n)
    .map((balance) => [balance.token.toLowerCase(), balance.net]),
);

const receiptHalfNetMap = (receipts: readonly WholeOfferReceipt[]): Map<string, bigint> =>
  new Map(receipts.map((receipt) => [receipt.token.toLowerCase(), -receipt.amount]));

/** Inspect the real SDK object after each construction/merge. Exact bigint
 * planning is necessary but cannot detect ledger-v9's unchecked i128 wrap. */
function assertTransactionNet(
  transaction: unknown,
  expected: ReadonlyMap<string, bigint>,
  readImbalances: typeof tokenImbalances,
  refusalReason: string,
  label: string,
): void {
  let actual: Map<string, bigint>;
  try {
    actual = aggregateTokenImbalances(readImbalances(transaction as FinalizedTransaction));
  } catch (error) {
    throw new JobRefusal(refusalReason, `${label} could not be inspected: ${errorMessage(error)}`);
  }
  const outsideDomain = [...actual, ...expected].find(([, amount]) =>
    amount < -MAX_SETTLEMENT_AMOUNT || amount > MAX_SETTLEMENT_AMOUNT
  );
  if (outsideDomain !== undefined || actual.size !== expected.size ||
    [...expected].some(([token, amount]) => actual.get(token) !== amount)) {
    throw new JobRefusal(refusalReason, `${label} has an unexpected shielded delta vector`);
  }
}

/**
 * The half handed to the relay must be exactly the numeric inverse of the job:
 * it supplies `amountOut` tokenOut and claims `amountIn` tokenIn, so merging it
 * with the taker's intent balances to zero.
 *
 * This stays a strict EQUALITY even though a lowered demand now leaves the
 * solver a surplus: retained surplus and retained input are outputs to the
 * solver's OWN address inside the same half, so they cancel there and never
 * reach this aggregate. Widening the expectation to admit them would give up
 * the property that the relay can only ever be handed the exact inverse job.
 */
function assertInverseHalf(
  job: SwapMessage,
  transaction: FinalizedTransaction,
  readImbalances: typeof tokenImbalances,
): void {
  let actual: Map<string, bigint>;
  try {
    actual = aggregateTokenImbalances(readImbalances(transaction));
  } catch (error) {
    if (error instanceof JobRefusal) throw error;
    throw new JobRefusal(JOB_WALLET_FAILED, `could not inspect solver-half imbalance: ${errorMessage(error)}`);
  }
  const expected = new Map([
    [job.tokenOut.toLowerCase(), BigInt(job.amountOut)],
    [job.tokenIn.toLowerCase(), -BigInt(job.amountIn)],
  ]);
  if (
    actual.size !== expected.size ||
    [...expected].some(([token, amount]) => actual.get(token) !== amount)
  ) {
    throw new JobRefusal(JOB_WALLET_FAILED, "proved half does not equal the numeric inverse job");
  }
}

function estimateDustAmount(
  transaction: unknown,
  readImbalances: typeof tokenImbalances,
): bigint {
  let rows: Imbalance[];
  try {
    rows = readImbalances(transaction as FinalizedTransaction);
  } catch (error) {
    throw new JobRefusal(JOB_DUST_ESTIMATE, errorMessage(error));
  }
  const dust = rows.filter((row) => row.tag === "dust" && row.amount !== 0n);
  if (dust.length === 0) throw new JobRefusal(JOB_DUST_ESTIMATE, "no DUST fee contribution exposed");
  // Sum magnitudes conservatively: sign conventions may describe contribution
  // from either side, but under-counting a fee reservation is never acceptable.
  return dust.reduce((sum, row) => sum + (row.amount < 0n ? -row.amount : row.amount), 0n);
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
  }
}

export function startSwapJobExecutor(options: SwapJobExecutorOptions): SwapJobExecutorHandle {
  requirePositiveInteger("maxParallelSwaps", options.maxParallelSwaps);
  requirePositiveInteger("expiryMarginSeconds", options.expiryMarginSeconds);
  requirePositiveInteger("settleTtlMinutes", options.settleTtlMinutes);
  if (options.relayHttpUrl.length === 0) throw new Error("relayHttpUrl is required");
  // FR-001. Both fee-sizing inputs are decided at startup, so a malformed one
  // is a boot error and never a per-job `wallet_build_failed` refusal.
  const networkId = options.networkId;
  if (
    typeof networkId !== "string" || networkId.length === 0 ||
    networkId.trim() !== networkId || networkId.includes("\0")
  ) {
    throw new Error(
      "networkId is required: the fee-sizing stand-in must carry the same " +
        "network id the wallet was built with, and the ledger only refuses a " +
        "mismatch at merge time",
    );
  }
  const modelledTakerInputs = options.modelledTakerInputs ?? DEFAULT_MODELLED_TAKER_INPUTS;
  requirePositiveInteger("modelledTakerInputs", modelledTakerInputs);
  if (
    modelledTakerInputs < MIN_MODELLED_TAKER_INPUTS ||
    modelledTakerInputs > MAX_MODELLED_TAKER_INPUTS
  ) {
    throw new RangeError(
      `modelledTakerInputs must be in [${MIN_MODELLED_TAKER_INPUTS}, ` +
        `${MAX_MODELLED_TAKER_INPUTS}], got ${modelledTakerInputs}`,
    );
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const walletOperationTimeoutMs = options.walletOperationTimeoutMs ?? 240_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
  requirePositiveInteger("requestTimeoutMs", requestTimeoutMs);
  requirePositiveInteger("walletOperationTimeoutMs", walletOperationTimeoutMs);
  requirePositiveInteger("sweepIntervalMs", sweepIntervalMs);
  if (options.dustAdmission != null) {
    if (options.dustAdmission.maxPerJob <= 0n || options.dustAdmission.maxPerWindow <= 0n) {
      throw new RangeError("DUST admission limits must be positive bigints");
    }
    requirePositiveInteger("dustAdmission.windowMs", options.dustAdmission.windowMs);
  }

  const dependencies: SwapJobDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const now = options.nowMs ?? (() => Date.now());
  const timers = options.timers ?? DEFAULT_TIMERS;
  const journal = options.journal;
  const building = new Map<string, BuildingJob>();
  const awaiting = new Map<string, AwaitingJob>();
  const confirmations = new Map<string, ConsumptionJob>();
  const quarantined = new Map<string, QuarantinedJob>();
  const tombstones = new Map<string, number>();
  const tasks = new Set<Promise<unknown>>();
  const terminalChains = new Map<string, Promise<void>>();
  let sweepTimer: unknown = null;
  let sweeping: Promise<void> | null = null;
  let stopped = false;
  let reconciled = false;
  let stopping: Promise<void> | null = null;
  let dustBlockedUsage: bigint | null = null;

  const stats: SwapJobExecutorStats = {
    building: 0,
    quarantined: 0,
    awaitingRelay: 0,
    awaitingConsumption: 0,
    completed: 0,
    refused: 0,
    reverted: 0,
    revertFailures: 0,
    timedOutBuilds: 0,
    stopped: false,
  };

  const log = (message: string): void => {
    try { options.log?.(`[solver-job] ${message}`); } catch { /* diagnostic only */ }
  };
  const refreshStats = (): void => {
    stats.building = building.size;
    stats.quarantined = quarantined.size;
    stats.awaitingRelay = awaiting.size;
    stats.awaitingConsumption = confirmations.size;
  };
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
    return task;
  };
  const enqueueTerminal = (jobId: string, operation: () => Promise<void>): Promise<void> => {
    const prior = terminalChains.get(jobId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    terminalChains.set(jobId, current);
    void current.finally(() => {
      if (terminalChains.get(jobId) === current) terminalChains.delete(jobId);
    }).catch(() => undefined);
    return track(current);
  };
  const terminal = (state: JournalLifecycleState): boolean =>
    state === "SETTLED" || state === "REVERTED" || state === "FAILED";
  const jobKey = (jobId: string, generation: number): string =>
    `job:${jobId}:g${generation}:settlement`;
  const operationKey = (
    jobId: string,
    generation: number,
    kind: JournalOperationKind,
    label: string,
  ): string => `job:${jobId}:g${generation}:${kind}:${label}`;
  const group = (jobId: string, generation: number): JournalOperation[] =>
    journal.list().filter((row) => row.jobId === jobId && row.generation === generation);
  const recoveryRevertPrefix = (jobId: string, generation: number): string =>
    `job:${jobId}:g${generation}:JOB_REVERT:recovery-`;
  const isRecoveryRevert = (row: JournalOperation): boolean =>
    row.operationKind === "JOB_REVERT" &&
      row.operationKey.startsWith(recoveryRevertPrefix(row.jobId, row.generation));
  const recoveryRevertKey = (
    jobId: string,
    generation: number,
    sourceOperationKeys: readonly string[],
    walletArtifactKind: WalletArtifactKind,
    walletArtifactBytes: Uint8Array,
  ): string => {
    const digest = createHash("sha256")
      .update(walletArtifactKind)
      .update("\0")
      .update([...sourceOperationKeys].sort().join("\0"))
      .update("\0")
      .update(walletArtifactBytes)
      .digest("hex");
    const artifact = walletArtifactKind === "FINALIZED_TRANSACTION" ? "finalized" : "unproven";
    return operationKey(jobId, generation, "JOB_REVERT", `recovery-${artifact}-${digest}`);
  };
  const sameBytes = (left: Uint8Array | undefined, right: Uint8Array): boolean =>
    left !== undefined && left.byteLength === right.byteLength &&
      left.every((value, index) => value === right[index]);
  /** The job-level authority is always terminalized last. A crash may leave
   * child rows behind it, but can never expose terminal job authority before
   * the wallet-operation evidence that supports it. */
  const terminalOrder = (rows: JournalOperation[]): JournalOperation[] =>
    [...rows].sort((left, right) =>
      Number(left.operationKind === "JOB_SETTLEMENT") -
      Number(right.operationKind === "JOB_SETTLEMENT"));
  const claimToJournal = (claim: Claim): JournalClaim => ({
    inputs: [...claim.nullifiers].map((value) => value.toLowerCase()).sort(),
    payouts: Object.fromEntries(
      [...claim.payouts].map(([token, amount]) => [token.toLowerCase(), amount.toString()]).sort(),
    ),
  });
  const claimFromJournal = (row: JournalOperation): Claim => ({
    offerHashes: [...row.offerHashes],
    nullifiers: [...row.claim.inputs],
    payouts: new Map(Object.entries(row.claim.payouts).map(([token, amount]) => [token, BigInt(amount)])),
  });
  const detail = (error: unknown): string => errorMessage(error).slice(0, 4096);
  const retention = (record: { operationKey: string; ttlExpiresAt: number }): number =>
    journal.get(record.operationKey)?.retentionUntilMs ?? record.ttlExpiresAt;

  const quarantineRow = (
    row: JournalOperation,
    errorCode: string,
    error: unknown,
  ): JournalOperation => {
    if (terminal(row.lifecycleState) || row.lifecycleState === "QUARANTINED") return row;
    return journal.transition(row.operationKey, row.lifecycleState, "QUARANTINED", {
      errorCode,
      errorDetail: detail(error),
      retryCount: row.retryCount + 1,
    });
  };
  const quarantineGroup = (
    jobId: string,
    generation: number,
    errorCode: string,
    error: unknown,
  ): void => {
    for (const row of group(jobId, generation)) quarantineRow(row, errorCode, error);
  };
  const markReverted = (jobId: string, generation: number): void => {
    for (const initial of terminalOrder(group(jobId, generation))) {
      let row = journal.require(initial.operationKey);
      if (terminal(row.lifecycleState)) continue;
      if (row.lifecycleState === "QUARANTINED") {
        journal.transition(row.operationKey, "QUARANTINED", "REVERTED");
        continue;
      }
      if (row.lifecycleState !== "REVERTING") {
        row = journal.transition(row.operationKey, row.lifecycleState, "REVERTING");
      }
      journal.transition(row.operationKey, "REVERTING", "REVERTED");
    }
    journal.releaseDust(jobKey(jobId, generation));
  };
  const markFailed = (record: BuildingJob, error: unknown): void => {
    for (const initial of terminalOrder(group(record.job.jobId, record.generation))) {
      const row = journal.require(initial.operationKey);
      if (terminal(row.lifecycleState)) continue;
      if (row.lifecycleState !== "PREPARED") {
        throw new Error(`${row.operationKey} cannot be proved mutation-free from ${row.lifecycleState}`);
      }
      journal.transition(row.operationKey, "PREPARED", "FAILED", {
        errorCode: "MUTATION_FREE_FAILURE",
        errorDetail: detail(error),
      });
    }
  };
  const markAwaitingRelay = (record: BuildingJob): void => {
    for (const initial of group(record.job.jobId, record.generation)) {
      let row = journal.require(initial.operationKey);
      if (terminal(row.lifecycleState)) continue;
      if (row.lifecycleState === "PREPARED" && row.operationKind === "JOB_SETTLEMENT") {
        row = journal.transition(row.operationKey, "PREPARED", "APPLIED");
      }
      if (row.lifecycleState === "APPLIED") {
        journal.transition(row.operationKey, "APPLIED", "AWAITING_RELAY");
      } else if (row.lifecycleState !== "AWAITING_RELAY") {
        throw new Error(`${row.operationKey} is not ready for relay ownership`);
      }
    }
  };
  const markRelaySubmitted = (
    record: { jobId: string; generation: number; operationKey: string },
    txId: string,
  ): void => {
    const canonical = canonicalRelayExtrinsicHash(txId);
    if (canonical === null) throw new Error("relay txId is not a canonical 32-byte extrinsic hash");
    journal.recordReceipt(record.operationKey, {
      relayJobId: record.jobId,
      relayState: "done",
      relayExtrinsicHash: canonical,
    });
    for (const initial of terminalOrder(group(record.jobId, record.generation))) {
      let row = journal.require(initial.operationKey);
      if (terminal(row.lifecycleState)) continue;
      if (row.lifecycleState === "AWAITING_RELAY") {
        journal.transition(row.operationKey, "AWAITING_RELAY", "RELAY_SUBMITTED");
      } else if (row.lifecycleState === "QUARANTINED") {
        journal.transition(row.operationKey, "QUARANTINED", "CONFIRMING");
      } else if (row.lifecycleState !== "RELAY_SUBMITTED" && row.lifecycleState !== "CONFIRMING") {
        throw new Error(`${row.operationKey} cannot record relay submission from ${row.lifecycleState}`);
      }
    }
  };
  const markRelayFailed = (
    record: { jobId: string; operationKey: string },
  ): void => {
    journal.recordReceipt(record.operationKey, {
      relayJobId: record.jobId,
      relayState: "error",
    });
  };
  const markSettled = (
    record: ConsumptionJob,
    evidence?: { ledgerTxHash: string; height: number },
  ): void => {
    if (evidence !== undefined) {
      journal.recordReceipt(record.operationKey, {
        ledgerTxHash: evidence.ledgerTxHash,
        ledgerHeight: evidence.height,
      });
    }
    for (const initial of terminalOrder(group(record.jobId, record.generation))) {
      let row = journal.require(initial.operationKey);
      if (terminal(row.lifecycleState)) continue;
      if (row.lifecycleState === "AWAITING_RELAY") {
        row = journal.transition(row.operationKey, "AWAITING_RELAY", "RELAY_SUBMITTED");
      }
      if (row.lifecycleState === "RELAY_SUBMITTED") {
        journal.transition(row.operationKey, "RELAY_SUBMITTED", "SETTLED");
      } else if (row.lifecycleState === "CONFIRMING" || row.lifecycleState === "QUARANTINED") {
        journal.transition(row.operationKey, row.lifecycleState, "SETTLED");
      } else {
        throw new Error(`${row.operationKey} cannot settle from ${row.lifecycleState}`);
      }
    }
    journal.markDustSpent(record.operationKey);
  };

  const unavailableOfferHashes = (): string[] => [
    ...new Set([
      ...[...building.values()].flatMap((record) => record.offerHashes),
      ...[...awaiting.values()].flatMap((record) => record.offerHashes),
      ...[...confirmations.values()].flatMap((record) => record.offerHashes),
      ...[...quarantined.values()].flatMap((record) => record.offerHashes),
    ]),
  ].sort();
  const dustAvailable = (): boolean => {
    if (options.dustAdmission == null) return true;
    try {
      const usage = journal.dustUsage(options.dustAdmission.windowMs, now());
      if (dustBlockedUsage !== null) {
        if (usage < dustBlockedUsage) dustBlockedUsage = null;
        else return false;
      }
      return usage < options.dustAdmission.maxPerWindow;
    } catch {
      return false;
    }
  };
  const isSeen = (jobId: string): boolean =>
    building.has(jobId) || awaiting.has(jobId) || confirmations.has(jobId) ||
    quarantined.has(jobId) || tombstones.has(jobId);
  const owns = (record: { operationKey: string; generation: number }): boolean => {
    const row = journal.get(record.operationKey);
    return row?.generation === record.generation && !terminal(row.lifecycleState);
  };
  const sameGeneration = (record: { operationKey: string; generation: number }): boolean =>
    journal.get(record.operationKey)?.generation === record.generation;
  const terminalError = (jobId: string, reason: string, message?: string): JobErrorMessage => {
    stats.refused += 1;
    if (message !== undefined) log(`refused ${jobId}: ${reason} (${message})`);
    return { type: "job-error", jobId, reason };
  };
  const release = (claim: Claim): void => {
    options.stock.release(claim);
    void options.refreshBalances?.().catch((error) => log(`inventory refresh failed: ${errorMessage(error)}`));
  };

  const prepareMutation = (
    record: BuildingJob,
    kind: JournalOperationKind,
    label: string,
    artifact?: { kind: WalletArtifactKind; bytes: Uint8Array },
  ): string => {
    const key = operationKey(record.job.jobId, record.generation, kind, label);
    journal.createPrepared({
      operationKey: key,
      jobId: record.job.jobId,
      generation: record.generation,
      offerHashes: [...record.offerHashes].sort(),
      claim: claimToJournal(record.claim),
      operationKind: kind,
      ttlExpiresAtMs: record.ttlExpiresAt,
      deadlineAtMs: Math.min(record.ttlExpiresAt, now() + walletOperationTimeoutMs),
      ...(artifact
        ? { walletArtifactKind: artifact.kind, walletArtifactBytes: artifact.bytes }
        : {}),
    });
    return key;
  };
  const applyArtifact = (
    key: string,
    kind: WalletArtifactKind,
    bytes: Uint8Array,
  ): void => {
    journal.transition(key, "PREPARED", "APPLIED", {
      walletArtifactKind: kind,
      walletArtifactBytes: bytes,
    });
  };
  const markOperationReverted = (key: string): void => {
    let row = journal.require(key);
    if (row.lifecycleState === "REVERTED") return;
    if (row.lifecycleState === "QUARANTINED") {
      journal.transition(key, "QUARANTINED", "REVERTED");
      return;
    }
    if (row.lifecycleState !== "REVERTING") {
      row = journal.transition(key, row.lifecycleState, "REVERTING");
    }
    journal.transition(key, "REVERTING", "REVERTED");
  };

  interface RecoveryRevertTarget {
    operationKey: string;
    sourceOperationKeys: string[];
    expectedSourceState: "PREPARED" | "APPLIED";
    walletArtifactKind: WalletArtifactKind;
    walletArtifactBytes: Uint8Array;
    transaction: unknown;
  }

  const restoreRecoveryTargets = (
    jobId: string,
    generation: number,
  ): {
    targets: RecoveryRevertTarget[];
    walletTransaction?: FinalizedTransaction;
    artifactlessMutation: boolean;
    ambiguity?: string;
  } => {
    const rows = group(jobId, generation);
    const recoveryRows = rows.filter(isRecoveryRevert);
    const primaryReverts = rows.filter((row) =>
      row.operationKind === "JOB_REVERT" && !isRecoveryRevert(row));
    if (primaryReverts.length > 1) {
      return {
        targets: [],
        artifactlessMutation: false,
        ambiguity: "multiple primary JOB_REVERT authorities exist for one generation",
      };
    }
    const primaryRevert = primaryReverts[0];
    const finalizedRows = primaryRevert === undefined ? rows.filter((row) =>
      row.operationKind === "FINALIZED_CONTRIBUTION" &&
      row.walletArtifactKind === "FINALIZED_TRANSACTION" && !terminal(row.lifecycleState)) : [primaryRevert];
    const artifactlessMutation = rows.some((row) =>
      row.operationKind !== "JOB_SETTLEMENT" && !isRecoveryRevert(row) &&
      row.lifecycleState === "PREPARED" && row.walletArtifactBytes === undefined);
    if (primaryRevert !== undefined &&
        (primaryRevert.walletArtifactKind !== "FINALIZED_TRANSACTION" ||
          primaryRevert.walletArtifactBytes === undefined)) {
      return {
        targets: [], artifactlessMutation,
        ambiguity: "primary JOB_REVERT has no canonical finalized artifact",
      };
    }
    const finalizedTransactions = finalizedRows.map((row) =>
      dependencies.deserializeFinalized(row.walletArtifactBytes!));
    const walletTransaction = finalizedTransactions.length === 0
      ? undefined
      : dependencies.mergeFinalized(finalizedTransactions);
    const hasResidualFinal = finalizedRows.some((row) => row.operationKey.endsWith(":residual"));
    const hasDustFinal = finalizedRows.some((row) => row.operationKey.endsWith(":dust"));
    // FR-004: the `MIRROR_RESERVATION` arm is LEGACY-ONLY. Jobs built at this
    // head never write that kind (00006-R1 replaced the mirror with a fabricated
    // stand-in that is not wallet state), but a journal written before the
    // upgrade can still hold one, and it is a real reserved coin set that must
    // still be reverted. Do not remove this arm.
    const rawRows = primaryRevert === undefined ? rows.filter((row) =>
      row.walletArtifactKind === "UNPROVEN_TRANSACTION" && !terminal(row.lifecycleState) &&
      (row.operationKind === "MIRROR_RESERVATION" ||
        (row.operationKind === "RESIDUAL_BUILD" && !hasResidualFinal) ||
        (row.operationKind === "DUST_BALANCE" && !hasDustFinal))) : [];
    const targets: RecoveryRevertTarget[] = rawRows.map((row) => ({
      operationKey: recoveryRevertKey(
        jobId, generation, [row.operationKey], "UNPROVEN_TRANSACTION", row.walletArtifactBytes!),
      sourceOperationKeys: [row.operationKey],
      expectedSourceState: "APPLIED",
      walletArtifactKind: "UNPROVEN_TRANSACTION",
      walletArtifactBytes: row.walletArtifactBytes!,
      transaction: dependencies.deserializeUnproven(row.walletArtifactBytes!),
    }));
    if (walletTransaction !== undefined) {
      const bytes = dependencies.serializeFinalized(walletTransaction);
      const sourceOperationKeys = finalizedRows.map((row) => row.operationKey).sort();
      targets.push({
        operationKey: recoveryRevertKey(
          jobId, generation, sourceOperationKeys, "FINALIZED_TRANSACTION", bytes),
        sourceOperationKeys,
        expectedSourceState: primaryRevert === undefined ? "APPLIED" : "PREPARED",
        walletArtifactKind: "FINALIZED_TRANSACTION",
        walletArtifactBytes: bytes,
        transaction: walletTransaction,
      });
    }

    const byKey = new Map(targets.map((target) => [target.operationKey, target]));
    for (const row of recoveryRows) {
      const target = byKey.get(row.operationKey);
      if (target === undefined) {
        return { targets, walletTransaction, artifactlessMutation,
          ambiguity: `recovery authority ${row.operationKey} no longer binds the selected artifact set` };
      }
      if (row.generation !== generation || row.jobId !== jobId ||
          row.walletArtifactKind !== target.walletArtifactKind ||
          !sameBytes(row.walletArtifactBytes, target.walletArtifactBytes)) {
        return { targets, walletTransaction, artifactlessMutation,
          ambiguity: `recovery authority ${row.operationKey} conflicts with its generation/artifact identity` };
      }
      if (row.lifecycleState !== "PREPARED" && row.lifecycleState !== "REVERTED") {
        return { targets, walletTransaction, artifactlessMutation,
          ambiguity: `recovery authority ${row.operationKey} is ${row.lifecycleState}; its wallet-call outcome is unprovable` };
      }
    }
    for (const target of targets) {
      const recovery = journal.get(target.operationKey);
      if (recovery?.lifecycleState === "REVERTED") continue;
      for (const sourceKey of target.sourceOperationKeys) {
        const source = journal.require(sourceKey);
        if (source.lifecycleState !== target.expectedSourceState) {
          return { targets, walletTransaction, artifactlessMutation,
            ambiguity: `${sourceKey} is ${source.lifecycleState}; a prior revert call may have started` };
        }
      }
    }
    return { targets, walletTransaction, artifactlessMutation };
  };

  const retainRecoveryAmbiguity = (
    record: QuarantinedJob,
    reason: unknown,
  ): false => {
    const message = `${detail(reason)}; wallet mutation will not be repeated and Stock/capacity/offers remain unavailable`;
    try {
      quarantineGroup(record.jobId, record.generation, "RECOVERY_REVERT_OUTCOME_UNKNOWN", message);
    } catch { /* every pre-existing non-terminal row remains fail-closed */ }
    record.locallyRevertible = false;
    record.evidenceReconcile = false;
    stats.revertFailures += 1;
    log(`[SAFETY] recovery revert outcome unknown for ${record.jobId}: ${message}`);
    refreshStats();
    return false;
  };

  const revertWallet = async (record: AwaitingJob): Promise<boolean> => {
    if (record.reverting || !owns(record)) return false;
    record.reverting = true;
    const revertKey = operationKey(record.jobId, record.generation, "JOB_REVERT", "wallet");
    try {
      const existing = journal.get(revertKey);
      if (!existing) {
        journal.createPrepared({
          operationKey: revertKey,
          jobId: record.jobId,
          generation: record.generation,
          offerHashes: [...record.offerHashes].sort(),
          claim: claimToJournal(record.claim),
          operationKind: "JOB_REVERT",
          ttlExpiresAtMs: record.ttlExpiresAt,
          deadlineAtMs: Math.min(record.ttlExpiresAt, now() + walletOperationTimeoutMs),
          walletArtifactKind: "FINALIZED_TRANSACTION",
          walletArtifactBytes: dependencies.serializeFinalized(record.walletTransaction),
        });
        journal.transition(revertKey, "PREPARED", "REVERTING");
      } else if (existing.lifecycleState === "QUARANTINED") {
        journal.transition(revertKey, "QUARANTINED", "REVERTING", {
          retryCount: existing.retryCount + 1,
        });
      } else if (existing.lifecycleState !== "REVERTING") {
        throw new Error(`unexpected durable revert state ${existing.lifecycleState}`);
      }
      await options.wallet.revert(record.walletTransaction);
      journal.transition(revertKey, "REVERTING", "REVERTED");
      markReverted(record.jobId, record.generation);
      awaiting.delete(record.jobId);
      quarantined.delete(record.jobId);
      tombstones.set(record.jobId, retention(record));
      release(record.claim);
      stats.reverted += 1;
      log(`reverted solver-owned transaction for ${record.jobId}`);
      return true;
    } catch (error) {
      try { quarantineGroup(record.jobId, record.generation, "LOCAL_REVERT_FAILED", error); } catch { /* retained */ }
      awaiting.delete(record.jobId);
      quarantined.set(record.jobId, {
        ...record,
        locallyRevertible: true,
        evidenceReconcile: false,
      });
      stats.revertFailures += 1;
      log(`revert failed for ${record.jobId}; durable quarantine retained: ${errorMessage(error)}`);
      return false;
    } finally {
      record.reverting = false;
      refreshStats();
    }
  };

  const notifyConsumed = (offerHash: string): void => {
    const canonical = offerHash.toLowerCase();
    // The websocket event is only a wake-up. It is never settlement evidence:
    // the versioned backend read below must still bind every maker offer to one
    // identical inner Midnight ledger transaction and height.
    if ([...awaiting.values(), ...confirmations.values(), ...quarantined.values()]
      .some((record) => record.offerHashes.includes(canonical))) {
      void sweep();
    }
  };

  const readAndReconstruct = async (
    route: ResolvedRoute,
  ): Promise<FinalizedTransaction[]> => {
    let response: ExactFilesResponse;
    try {
      response = await dependencies.readExactOfferFiles(
        route.offers.map((offer) => offer.offerHash),
        {
          ...(options.api === undefined ? {} : { api: options.api }),
          timeoutMs: requestTimeoutMs,
        },
      );
    } catch (error) {
      throw new JobRefusal(JOB_EXACT_FILES_UNAVAILABLE, errorMessage(error));
    }
    if (
      response.files.length !== route.offers.length ||
      response.files.some((entry, index) => entry.offerId !== route.offers[index]?.offerHash)
    ) {
      throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, "response does not match the requested route");
    }

    const transactions = new Map<string, FinalizedTransaction>();
    const exactSources: Array<{
      offerHash: string;
      gives: Array<{ token: string; amount: bigint }>;
      wants: Array<{ token: string; amount: bigint }>;
    }> = [];
    for (let index = 0; index < route.offers.length; index += 1) {
      const cached = route.offers[index]!;
      const exact = response.files[index]!;
      if (!exact.verdict.valid || exact.offer === undefined) {
        throw new JobRefusal(JOB_EXACT_FILE_REFUSED, exact.verdict.code);
      }
      const validated = exact.verdict.computed;
      if (
        validated === undefined ||
        !exactSemanticsMatch(cached, {
          gives: validated.gives,
          wants: validated.wants,
          nullifiers: validated.inputNullifiers,
        }) ||
        Date.parse(validated.expiresAt) !== cached.expiresAt
      ) {
        throw new JobRefusal(
          JOB_EXACT_FILE_MISMATCH,
          `validated projection changed for ${cached.offerHash}`,
        );
      }
      let transaction: FinalizedTransaction;
      try {
        transaction = dependencies.reconstructOffer(exact.offer);
      } catch (error) {
        throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, `deserialize failed: ${errorMessage(error)}`);
      }
      let semantics: ExactOfferSemantics;
      try {
        semantics = dependencies.deriveOfferSemantics(transaction);
      } catch (error) {
        throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, `inspection failed: ${errorMessage(error)}`);
      }
      if (!exactSemanticsMatch(cached, semantics)) {
        throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, cached.offerHash);
      }
      const exactSource = {
        offerHash: cached.offerHash,
        gives: semantics.gives.map((leg) => ({
          token: leg.token,
          amount: canonicalAmount(leg.amount),
        })),
        wants: semantics.wants.map((leg) => ({
          token: leg.token,
          amount: canonicalAmount(leg.amount),
        })),
      };
      const sourceBalances = accountWholeOfferBalances([exactSource]);
      assertTransactionNet(
        transaction,
        balanceNetMap(sourceBalances),
        dependencies.tokenImbalances,
        JOB_EXACT_FILE_MISMATCH,
        `exact maker ${cached.offerHash}`,
      );
      exactSources.push(exactSource);
      transactions.set(cached.offerHash, transaction);
    }

    const exactBalances = accountWholeOfferBalances(exactSources);
    if (
      JSON.stringify(serializeWholeOfferTokenBalances(exactBalances)) !==
        JSON.stringify(serializeWholeOfferTokenBalances(route.tokenBalances))
    ) {
      throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, "exact maker accounting changed");
    }
    const exactOrder = findSafeWholeOfferMergeOrder(exactSources);
    if (!exactOrder.ok ||
      JSON.stringify(exactOrder.offerHashes) !== JSON.stringify(route.mergeOrder)) {
      throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, "exact maker merge order changed");
    }
    return route.mergeOrder.map((offerHash) => {
      const transaction = transactions.get(offerHash);
      if (transaction === undefined) {
        throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, `missing exact maker ${offerHash}`);
      }
      return transaction;
    });
  };

  const assertRouteCurrent = (route: ResolvedRoute): void => {
    if (!options.cache.isCurrent()) throw new JobRefusal(JOB_CACHE_NOT_CURRENT);
    const cutoff = now() + options.expiryMarginSeconds * 1_000;
    for (const selected of route.offers) {
      const current = options.cache.book.get(selected.offerHash);
      if (current === undefined || current.expiresAt !== selected.expiresAt ||
          (selected.expiresAt !== null && selected.expiresAt <= cutoff) ||
          !exactSemanticsMatch(selected, {
            gives: current.gives.map((leg) => ({ ...leg, amount: leg.amount.toString() })),
            wants: current.wants.map((leg) => ({ ...leg, amount: leg.amount.toString() })),
            nullifiers: current.inputNullifiers,
          })) {
        throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "selected maker changed or entered the expiry margin");
      }
    }
  };

  const buildHalf = async (
    job: SwapMessage,
    route: ResolvedRoute,
    offerTransactions: FinalizedTransaction[],
    record: BuildingJob,
  ): Promise<BuiltHalf> => {
    const ttlExpiresAt = record.ttlExpiresAt;
    const ttl = new Date(ttlExpiresAt);
    const receiverAddress = await options.wallet.shielded.getAddress();
    assertRouteCurrent(route);
    const walletTransactions: FinalizedTransaction[] = [];
    const finalized: Array<{ key: string; sourceKey: string; transaction: FinalizedTransaction }> = [];
    const pendingUnproven: Array<{ key: string; transaction: unknown }> = [];
    const transferPendingToFinalized = (
      sourceKey: string,
      key: string,
      transaction: FinalizedTransaction,
    ): void => {
      const pendingIndex = pendingUnproven.findIndex((entry) => entry.key === sourceKey);
      if (pendingIndex < 0) {
        throw new JobRefusal(JOB_WALLET_FAILED, `missing pending artifact for ${sourceKey}`);
      }
      // The finalized artifact is already durable at this point. Update local
      // cleanup ownership without an await: catch must see exactly one form of
      // the wallet mutation and can never double-revert raw + finalized forms.
      finalized.push({ key, sourceKey, transaction });
      pendingUnproven.splice(pendingIndex, 1);
    };

    try {
      assertRouteCurrent(route);
      // FR-001. Fee sizing needs the taker's half too, and the DUST fee depends
      // on the merged transaction's STRUCTURE only — not on any coin's value,
      // token type or owner. So the taker half is modelled by a FABRICATED
      // transaction of the same shape (`modelledTakerInputs` tokenIn inputs, one
      // tokenIn change output, one tokenOut receive output, guaranteed segment
      // only) built over a throwaway keypair inside the call.
      //
      // Nothing here is a wallet mutation: no coin selection, no reservation, no
      // `watchCoins`, and therefore NO JOURNAL ROW and no revert. That is
      // deliberate and load-bearing — the `MIRROR_RESERVATION` arms of the
      // recovery filters (`restoreRecoveryTargets` and startup reconciliation)
      // hand their bytes to `wallet.revertTransaction`, and reverting a
      // transaction full of coins this wallet never owned is exactly the surface
      // 00005 FR-010 wants shrunk. Those arms stay in place unmodified so
      // PRE-EXISTING `MIRROR_*` rows still recover (FR-004); new jobs simply
      // never write them.
      const standInTransaction = dependencies.buildFeeSizingStandIn(
        takerHalfStandInSpec({
          networkId,
          tokenIn: job.tokenIn,
          tokenOut: job.tokenOut,
          modelledTakerInputs,
        }),
      );

      // Complete makers fund the exact taker payout. This leg receives every
      // positive endpoint/intermediate receipt with no swap-token wallet input.
      // Keep RESIDUAL_BUILD/:residual journal identities so historical wallet
      // artifacts recover using their original pairing and commitments.
      const legOutputs = route.receipts.map((receipt) => ({
        type: receipt.token,
        amount: receipt.amount,
        receiverAddress,
      }));
      if (legOutputs.length > 0) {
        const residualKey = prepareMutation(record, "RESIDUAL_BUILD", "residual");
        const residual = await options.wallet.initSwap(
          { shielded: {} },
          [{ type: "shielded", outputs: legOutputs }],
          options.keys,
          { ttl, payFees: false },
        );
        applyArtifact(residualKey, "UNPROVEN_TRANSACTION", dependencies.serializeUnproven(residual.transaction));
        pendingUnproven.push({ key: residualKey, transaction: residual.transaction });
        assertRouteCurrent(route);
        assertTransactionNet(
          residual.transaction,
          receiptHalfNetMap(route.receipts),
          dependencies.tokenImbalances,
          JOB_WALLET_FAILED,
          "unproven residual receipt half",
        );
        const finalizedKey = prepareMutation(record, "FINALIZED_CONTRIBUTION", "residual");
        const residualFinal = await options.wallet.finalizeTransaction(residual.transaction);
        applyArtifact(finalizedKey, "FINALIZED_TRANSACTION", dependencies.serializeFinalized(residualFinal));
        transferPendingToFinalized(residualKey, finalizedKey, residualFinal);
        assertRouteCurrent(route);
        assertTransactionNet(
          residualFinal,
          receiptHalfNetMap(route.receipts),
          dependencies.tokenImbalances,
          JOB_WALLET_FAILED,
          "finalized residual receipt half",
        );
        walletTransactions.push(residualFinal);
      }

      const offersByHash = new Map(route.offers.map((offer) => [offer.offerHash, offer]));
      let base: FinalizedTransaction | undefined;
      const prefixOffers: BookOffer[] = [];
      for (let index = 0; index < route.mergeOrder.length; index += 1) {
        const offerHash = route.mergeOrder[index]!;
        const source = offersByHash.get(offerHash);
        const transaction = offerTransactions[index];
        if (source === undefined || transaction === undefined) {
          throw new JobRefusal(JOB_EXACT_FILE_MISMATCH, "safe maker merge inputs are incomplete");
        }
        prefixOffers.push(source);
        base = base === undefined
          ? transaction
          : dependencies.mergeFinalized([base, transaction]);
        assertTransactionNet(
          base,
          balanceNetMap(accountWholeOfferBalances(prefixOffers)),
          dependencies.tokenImbalances,
          JOB_WALLET_FAILED,
          `maker merge prefix ${index + 1}`,
        );
      }
      if (base === undefined) {
        throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "maker witness is empty");
      }
      for (const receiptTransaction of walletTransactions) {
        base = dependencies.mergeFinalized([base, receiptTransaction]);
      }
      const expectedBase = balanceNetMap(route.tokenBalances);
      for (const receipt of route.receipts) {
        const next = (expectedBase.get(receipt.token) ?? 0n) - receipt.amount;
        if (next === 0n) expectedBase.delete(receipt.token);
        else expectedBase.set(receipt.token, next);
      }
      assertTransactionNet(
        base,
        expectedBase,
        dependencies.tokenImbalances,
        JOB_WALLET_FAILED,
        "maker and receipt half",
      );
      const dustKey = prepareMutation(record, "DUST_BALANCE", "fees");
      const dustTransaction = await options.wallet.dust.balanceTransactions(
        options.keys.dustSecretKey,
        [base, standInTransaction],
        ttl,
      );
      applyArtifact(dustKey, "UNPROVEN_TRANSACTION", dependencies.serializeUnproven(dustTransaction));
      pendingUnproven.push({ key: dustKey, transaction: dustTransaction });
      assertRouteCurrent(route);
      if (options.dustAdmission != null) {
        const amount = estimateDustAmount(dustTransaction, dependencies.tokenImbalances);
        const reserved = journal.reserveDust({
          operationKey: record.operationKey,
          jobId: job.jobId,
          generation: record.generation,
          amount,
          ...options.dustAdmission,
        });
        if (!reserved.accepted) {
          if (reserved.reason === "window") {
            dustBlockedUsage = reserved.usage;
            try { options.onDustWindowBlocked?.(); } catch { /* safety state is durable */ }
            throw new JobRefusal(JOB_DUST_WINDOW);
          }
          throw new JobRefusal(JOB_DUST_PER_JOB);
        }
      }
      const finalizedDustKey = prepareMutation(record, "FINALIZED_CONTRIBUTION", "dust");
      const finalizedDust = await options.wallet.finalizeTransaction(dustTransaction);
      applyArtifact(finalizedDustKey, "FINALIZED_TRANSACTION", dependencies.serializeFinalized(finalizedDust));
      transferPendingToFinalized(dustKey, finalizedDustKey, finalizedDust);
      assertRouteCurrent(route);
      walletTransactions.push(finalizedDust);

      const walletTransaction = dependencies.mergeFinalized(walletTransactions);
      const relayTransaction = dependencies.mergeFinalized([base, finalizedDust]);
      assertInverseHalf(job, relayTransaction, dependencies.tokenImbalances);
      assertRouteCurrent(route);
      return { relayTransaction, walletTransaction, ttlExpiresAt };
    } catch (error) {
      // Any locally finalized contribution must be rolled back before a
      // job-error can be called mutation-free. Revert failures are folded into
      // the error so the caller quarantines the claim rather than releasing it.
      const failedTransactions: FinalizedTransaction[] = [];
      const failedUnproven: unknown[] = [];
      let cleanupError: unknown = null;
      for (const contribution of finalized) {
        try {
          journal.transition(contribution.key, "APPLIED", "REVERTING");
          await options.wallet.revert(contribution.transaction);
          journal.transition(contribution.key, "REVERTING", "REVERTED");
          markOperationReverted(contribution.sourceKey);
        } catch (candidate) {
          failedTransactions.push(contribution.transaction);
          cleanupError ??= candidate;
          try { quarantineRow(journal.require(contribution.key), "LOCAL_REVERT_FAILED", candidate); } catch { /* retained */ }
        }
      }
      for (const pending of pendingUnproven) {
        try {
          journal.transition(pending.key, "APPLIED", "REVERTING");
          await options.wallet.revertTransaction(pending.transaction);
          journal.transition(pending.key, "REVERTING", "REVERTED");
        } catch (candidate) {
          failedUnproven.push(pending.transaction);
          cleanupError ??= candidate;
          try { quarantineRow(journal.require(pending.key), "LOCAL_REVERT_FAILED", candidate); } catch { /* retained */ }
        }
      }
      // FR-001: there is deliberately no fee-sizing cleanup arm any more. The
      // taker-half stand-in is fabricated, so a failure anywhere in this block
      // leaves nothing of it behind to revert, journal or quarantine.
      const failedWalletTransaction = failedTransactions.length === 0
        ? undefined
        : dependencies.mergeFinalized(failedTransactions);
      const remaining = group(job.jobId, record.generation).filter((row) =>
        row.operationKind !== "JOB_SETTLEMENT" && !terminal(row.lifecycleState));
      if (remaining.length === 0) {
        journal.releaseDust(record.operationKey);
        if (journal.require(record.operationKey).lifecycleState === "QUARANTINED") {
          markReverted(job.jobId, record.generation);
        } else {
          markFailed(record, error);
        }
        if (error instanceof JobRefusal) throw error;
        throw new JobRefusal(JOB_WALLET_FAILED, errorMessage(error));
      }
      const combined = [errorMessage(error), cleanupError && `cleanup failed: ${errorMessage(cleanupError)}`]
        .filter(Boolean).join("; ");
      quarantineGroup(job.jobId, record.generation, "LOCAL_MUTATION_UNCERTAIN", combined);
      throw new WalletMutationUncertain(
        combined,
        failedUnproven,
        failedWalletTransaction,
        ttlExpiresAt,
      );
    }
  };

  const awaitWithDeadline = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: unknown = null;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = timers.setTimeout(() => reject(new WalletBuildTimeout(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
    }
  };

  const retainCleanupFailure = (
    record: BuildingJob,
    error: unknown,
  ): boolean => {
    if (error instanceof WalletMutationUncertain) {
      quarantined.set(record.job.jobId, {
        jobId: record.job.jobId,
        claim: record.claim,
        offerHashes: record.offerHashes,
        ...(error.rawTransactions.length === 0 ? {} : { rawTransactions: error.rawTransactions }),
        ...(error.walletTransaction === undefined
          ? {}
          : { walletTransaction: error.walletTransaction }),
        ttlExpiresAt: error.ttlExpiresAt,
        reverting: false,
        generation: record.generation,
        operationKey: record.operationKey,
        locallyRevertible: error.rawTransactions.length > 0 || error.walletTransaction !== undefined,
        evidenceReconcile: false,
      });
      log(`quarantined uncertain wallet mutation for ${record.job.jobId}`);
      return true;
    }
    if (error instanceof WalletCleanupFailure) {
      awaiting.set(record.job.jobId, {
        jobId: record.job.jobId,
        claim: record.claim,
        offerHashes: record.offerHashes,
        walletTransaction: error.walletTransaction,
        ttlExpiresAt: error.ttlExpiresAt,
        reverting: false,
        relayAccepted: false,
        generation: record.generation,
        operationKey: record.operationKey,
      });
      log(`quarantined failed wallet cleanup for ${record.job.jobId}`);
      return true;
    }
    return false;
  };

  const executeSwap = async (job: SwapMessage): Promise<SwapTxMessage | JobErrorMessage> => {
    if (stopped) return terminalError(job.jobId, JOB_CACHE_NOT_CURRENT, "executor stopped");
    if (!reconciled) return terminalError(job.jobId, JOB_RECONCILING);
    if (isSeen(job.jobId)) return terminalError(job.jobId, JOB_DUPLICATE);
    if (building.size + quarantined.size >= options.maxParallelSwaps) {
      return terminalError(job.jobId, JOB_AT_CAPACITY);
    }

    let route: ResolvedRoute;
    try {
      route = resolveSwapJobRoute(job, options.cache, options.stock, {
        nowMs: now(),
        expiryMarginSeconds: options.expiryMarginSeconds,
        unavailableOfferHashes: unavailableOfferHashes(),
        ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
        freshNowMs: now,
        shouldAbort: () => stopped,
        ...forwardAdmissionPolicy(options),
      });
    } catch (error) {
      const refusal = error instanceof JobRefusal ? error : new JobRefusal(JOB_ROUTE_NOT_CURRENT);
      tombstones.set(job.jobId, now() + options.settleTtlMinutes * 60_000);
      return terminalError(job.jobId, refusal.reason, refusal.message);
    }

    const generation = Math.max(0, ...journal.list()
      .filter((row) => row.jobId === job.jobId)
      .map((row) => row.generation)) + 1;
    const ttlExpiresAt = now() + options.settleTtlMinutes * 60_000;
    const record: BuildingJob = {
      job,
      claim: route.claim,
      offerHashes: route.offers.map((offer) => offer.offerHash),
      timedOut: false,
      generation,
      operationKey: jobKey(job.jobId, generation),
      ttlExpiresAt,
    };
    try {
      journal.createPrepared({
        operationKey: record.operationKey,
        jobId: job.jobId,
        generation,
        offerHashes: [...record.offerHashes].sort(),
        claim: claimToJournal(route.claim),
        operationKind: "JOB_SETTLEMENT",
        ttlExpiresAtMs: ttlExpiresAt,
        deadlineAtMs: Math.min(ttlExpiresAt, now() + walletOperationTimeoutMs),
        receipt: { relayJobId: job.jobId },
      });
    } catch (error) {
      release(route.claim);
      return terminalError(job.jobId, JOB_WALLET_FAILED, `journal prepare failed: ${errorMessage(error)}`);
    }
    building.set(job.jobId, record);
    refreshStats();

    try {
      const exactTransactions = await readAndReconstruct(route);
      assertRouteCurrent(route);
      const walletWork = buildHalf(job, route, exactTransactions, record);
      let built: BuiltHalf;
      try {
        built = await awaitWithDeadline(walletWork, walletOperationTimeoutMs);
      } catch (error) {
        if (!(error instanceof WalletBuildTimeout)) throw error;
        record.timedOut = true;
        stats.timedOutBuilds += 1;
        quarantineGroup(job.jobId, generation, "WALLET_TIMEOUT_LATE_PENDING", error);
        // The wallet API has no cancellation acknowledgement. Keep the claim
        // and capacity slot until the late operation settles, then revert any
        // produced transaction before releasing either.
        void track(walletWork.then(
          async (late) => {
            if (building.get(job.jobId) !== record || !sameGeneration(record)) return;
            const lateRecord: AwaitingJob = {
              jobId: job.jobId,
              claim: route.claim,
              offerHashes: record.offerHashes,
              walletTransaction: late.walletTransaction,
              ttlExpiresAt: late.ttlExpiresAt,
              reverting: false,
              relayAccepted: false,
              generation,
              operationKey: record.operationKey,
            };
            awaiting.set(job.jobId, lateRecord);
            building.delete(job.jobId);
            await revertWallet(lateRecord);
          },
          (lateError) => {
            if (building.get(job.jobId) !== record || !sameGeneration(record)) return;
            building.delete(job.jobId);
            if (!retainCleanupFailure(record, lateError)) {
              const nonterminal = group(job.jobId, generation).some((row) => !terminal(row.lifecycleState));
              if (!nonterminal) {
                release(route.claim);
                tombstones.set(job.jobId, retention(record));
              } else {
                quarantineGroup(job.jobId, generation, "LATE_COMPLETION_UNCERTAIN", lateError);
                quarantined.set(job.jobId, {
                  jobId: job.jobId, claim: route.claim, offerHashes: record.offerHashes,
                  ttlExpiresAt, reverting: false, generation, operationKey: record.operationKey,
                  locallyRevertible: false,
                  evidenceReconcile: false,
                });
              }
            }
            refreshStats();
          },
        ));
        return terminalError(job.jobId, JOB_WALLET_TIMEOUT, error.message);
      }

      if (building.get(job.jobId) !== record || !owns(record)) {
        throw new JobRefusal(JOB_WALLET_FAILED, "stale wallet generation completed");
      }
      markAwaitingRelay(record);
      building.delete(job.jobId);
      awaiting.set(job.jobId, {
        jobId: job.jobId,
        claim: route.claim,
        offerHashes: record.offerHashes,
        walletTransaction: built.walletTransaction,
        ttlExpiresAt: built.ttlExpiresAt,
        reverting: false,
        relayAccepted: true,
        generation,
        operationKey: record.operationKey,
      });
      refreshStats();
      log(`proved ${job.jobId} from ${record.offerHashes.length} exact maker file(s)`);
      return {
        type: "swap-tx",
        jobId: job.jobId,
        txBytes: toHex(built.relayTransaction.serialize()),
      };
    } catch (error) {
      if (!record.timedOut) {
        building.delete(job.jobId);
        if (!retainCleanupFailure(record, error)) {
          try {
            const nonterminal = group(job.jobId, generation).some((row) => !terminal(row.lifecycleState));
            if (nonterminal) markFailed(record, error);
          } catch (journalError) {
            quarantineGroup(job.jobId, generation, "FAILURE_STATE_UNCERTAIN", journalError);
            quarantined.set(job.jobId, {
              jobId: job.jobId, claim: route.claim, offerHashes: record.offerHashes,
              ttlExpiresAt, reverting: false, generation, operationKey: record.operationKey,
              locallyRevertible: false,
              evidenceReconcile: false,
            });
          }
          if (!group(job.jobId, generation).some((row) => !terminal(row.lifecycleState))) {
            release(route.claim);
            tombstones.set(job.jobId, retention(record));
          }
        }
      }
      refreshStats();
      const refusal = error instanceof JobRefusal
        ? error
        : new JobRefusal(JOB_WALLET_FAILED, errorMessage(error));
      return terminalError(job.jobId, refusal.reason, refusal.message);
    }
  };

  /** Normal jobs are lifecycle-owned too, not only late timeouts/sweeps. This
   * makes `stop()` wait until an already-accepted build has either installed
   * its rollback record or failed mutation-free before the wallet is stopped. */
  const onSwap = (job: SwapMessage): Promise<SwapTxMessage | JobErrorMessage> =>
    track(executeSwap(job));

  type EvidenceRead =
    | { kind: "uniform"; ledgerTxHash: string; height: number }
    | { kind: "none" }
    | { kind: "unknown"; reason: string };

  const readUniformEvidence = async (
    record: { offerHashes: string[] },
  ): Promise<EvidenceRead> => {
    const results: OfferConsumptionResponse[] = [];
    for (const offerHash of record.offerHashes) {
      try {
        results.push(await dependencies.getOfferConsumptionEvidence(offerHash, {
          baseUrl: options.api ?? "http://127.0.0.1:9999",
          timeoutMs: requestTimeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }));
      } catch (error) {
        return { kind: "unknown", reason: `backend evidence unavailable: ${errorMessage(error)}` };
      }
    }
    const positive = results.filter((result) => result.evidence !== undefined);
    if (positive.length === results.length && positive.length > 0) {
      const first = positive[0]!.evidence!;
      if (positive.every((result) => result.evidence!.ledgerTxHash === first.ledgerTxHash &&
          result.evidence!.height === first.height)) {
        for (const offerHash of record.offerHashes) {
          try { options.onOfferConsumed?.(offerHash); } catch { /* evidence remains authoritative */ }
        }
        return { kind: "uniform", ledgerTxHash: first.ledgerTxHash, height: first.height };
      }
      return { kind: "unknown", reason: "maker offers bind to split ledger transactions or heights" };
    }
    if (positive.length > 0 || results.some((result) => result.status === "consumed")) {
      return { kind: "unknown", reason: "maker consumption evidence is partial or markerless" };
    }
    return { kind: "none" };
  };

  const activeReceiptRecord = (jobId: string): AwaitingJob | ConsumptionJob | QuarantinedJob | undefined =>
    awaiting.get(jobId) ?? confirmations.get(jobId) ?? quarantined.get(jobId);

  const quarantineEvidence = (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
    code: string,
    reason: unknown,
  ): void => {
    try { quarantineGroup(record.jobId, record.generation, code, reason); } catch { /* row remains non-terminal */ }
    awaiting.delete(record.jobId);
    confirmations.delete(record.jobId);
    const prior = quarantined.get(record.jobId);
    quarantined.set(record.jobId, {
      jobId: record.jobId,
      claim: record.claim,
      offerHashes: record.offerHashes,
      ...(prior?.rawTransaction === undefined ? {} : { rawTransaction: prior.rawTransaction }),
      ...(prior?.rawTransactions === undefined ? {} : { rawTransactions: prior.rawTransactions }),
      ...(("walletTransaction" in record && record.walletTransaction !== undefined)
        ? { walletTransaction: record.walletTransaction }
        : prior?.walletTransaction === undefined ? {} : { walletTransaction: prior.walletTransaction }),
      ttlExpiresAt: record.ttlExpiresAt,
      reverting: false,
      generation: record.generation,
      operationKey: record.operationKey,
      locallyRevertible: false,
      evidenceReconcile: true,
    });
    log(`${record.jobId} remains durably quarantined: ${detail(reason)}`);
    refreshStats();
  };

  const finishSettled = (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
    evidence: Extract<EvidenceRead, { kind: "uniform" }>,
  ): void => {
    const confirmation: ConsumptionJob = {
      jobId: record.jobId,
      claim: record.claim,
      offerHashes: record.offerHashes,
      ttlExpiresAt: record.ttlExpiresAt,
      generation: record.generation,
      operationKey: record.operationKey,
    };
    markSettled(confirmation, { ledgerTxHash: evidence.ledgerTxHash, height: evidence.height });
    awaiting.delete(record.jobId);
    confirmations.delete(record.jobId);
    quarantined.delete(record.jobId);
    tombstones.set(record.jobId, retention(record));
    release(record.claim);
    stats.completed += 1;
    log(`backend bound ${record.jobId} to ledger tx ${evidence.ledgerTxHash} at height ${evidence.height}`);
    refreshStats();
  };

  const reconcileRelayDone = async (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
    txId: string,
  ): Promise<void> => {
    try {
      markRelaySubmitted(record, txId);
      awaiting.delete(record.jobId);
      quarantined.delete(record.jobId);
      confirmations.set(record.jobId, {
        jobId: record.jobId,
        claim: record.claim,
        offerHashes: record.offerHashes,
        ttlExpiresAt: record.ttlExpiresAt,
        generation: record.generation,
        operationKey: record.operationKey,
      });
      const evidence = await readUniformEvidence(record);
      if (evidence.kind === "uniform") finishSettled(record, evidence);
      else quarantineEvidence(record, "BACKEND_EVIDENCE_UNKNOWN", evidence.kind === "none"
        ? "relay submission is positive but maker consumption is not yet proven"
        : evidence.reason);
    } catch (error) {
      quarantineEvidence(record, "RELAY_OR_SETTLEMENT_CONFLICT", error);
    }
  };

  const reconcileRelayFailure = async (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
    reason: string,
  ): Promise<void> => {
    try {
      markRelayFailed(record);
      const evidence = await readUniformEvidence(record);
      if (evidence.kind !== "none") {
        quarantineEvidence(record, "RELAY_FAILURE_EVIDENCE_CONFLICT",
          evidence.kind === "uniform" ? "relay failure conflicts with positive ledger evidence" : evidence.reason);
        return;
      }
      if (!("walletTransaction" in record) || record.walletTransaction === undefined) {
        quarantineEvidence(record, "RELAY_FAILURE_ARTIFACT_UNKNOWN",
          "explicit relay failure has no restorable solver wallet transaction");
        return;
      }
      log(`relay submit failed for ${record.jobId}: ${reason}; backend has no consumption proof`);
      // The guard above narrowed the artifact, but the spread of a union whose
      // quarantined member declares `walletTransaction?:` would widen it back
      // to optional. Re-stating the narrowed value keeps the AwaitingJob
      // contract ("an awaiting record always has a restorable artifact") a
      // type-level fact instead of a comment. Every other field, including a
      // quarantined record's `locallyRevertible`/`evidenceReconcile`, is
      // carried through unchanged as before.
      const walletTransaction = record.walletTransaction;
      awaiting.set(record.jobId, { ...record, walletTransaction, relayAccepted: true });
      quarantined.delete(record.jobId);
      confirmations.delete(record.jobId);
      await revertWallet(awaiting.get(record.jobId)!);
    } catch (error) {
      quarantineEvidence(record, "RELAY_FAILURE_RECONCILIATION_UNKNOWN", error);
    }
  };

  const reconcileFromHttp = async (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
  ): Promise<void> => {
    let status: RelayJobStatus;
    try {
      status = await dependencies.getRelayJobStatus(record.jobId, {
        baseUrl: options.relayHttpUrl,
        timeoutMs: requestTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      quarantineEvidence(record, "RELAY_HTTP_OUTCOME_UNKNOWN", error);
      return;
    }
    if (status.status === "done") return reconcileRelayDone(record, status.txId);
    if (status.status === "error") return reconcileRelayFailure(record, status.reason);
    quarantineEvidence(record, "RELAY_HTTP_OUTCOME_UNKNOWN", `relay job is still ${status.status}`);
  };

  const reconcileDurableEvidence = async (
    record: AwaitingJob | ConsumptionJob | QuarantinedJob,
  ): Promise<void> => {
    const receipt = journal.require(record.operationKey).receipt;
    if (receipt.relayState === "done" && receipt.relayExtrinsicHash !== undefined) {
      return reconcileRelayDone(record, receipt.relayExtrinsicHash);
    }
    if (receipt.relayState === "error") {
      return reconcileRelayFailure(record, "durable relay failure receipt");
    }
    if (receipt.relayState !== undefined || receipt.relayExtrinsicHash !== undefined) {
      quarantineEvidence(record, "RELAY_RECEIPT_MALFORMED", "durable relay receipt is incomplete");
      return;
    }
    return reconcileFromHttp(record);
  };

  // `reverting` exists on awaiting and quarantined records but not on a
  // confirmation, where the runtime read was `undefined` (falsy) and the guard
  // therefore fell through. `"reverting" in record` states that exactly, in the
  // same shape as the two guards next to it: a confirmation is never reverting.
  const isReverting = (record: AwaitingJob | ConsumptionJob | QuarantinedJob): boolean =>
    "reverting" in record && record.reverting;

  const onTxSubmitted = (message: TxSubmittedMessage): Promise<void> =>
    enqueueTerminal(message.jobId, async () => {
      const record = activeReceiptRecord(message.jobId);
      if (!record || ("relayAccepted" in record && !record.relayAccepted) ||
          ("locallyRevertible" in record && record.locallyRevertible) || isReverting(record)) return;
      await reconcileRelayDone(record, message.txId);
    });

  const onSubmitFailed = (message: SubmitFailedMessage): Promise<void> =>
    enqueueTerminal(message.jobId, async () => {
      const record = activeReceiptRecord(message.jobId);
      if (!record || ("relayAccepted" in record && !record.relayAccepted) ||
          ("locallyRevertible" in record && record.locallyRevertible) || isReverting(record)) return;
      await reconcileRelayFailure(record, message.reason);
    });

  const retryQuarantine = async (record: QuarantinedJob): Promise<boolean> => {
    if (record.reverting || !record.locallyRevertible || !owns(record)) return false;
    record.reverting = true;
    try {
      const primaryProof = group(record.jobId, record.generation).find((row) =>
        row.operationKind === "JOB_REVERT" && !isRecoveryRevert(row) &&
        row.lifecycleState === "REVERTED");
      if (primaryProof === undefined) {
        const restored = restoreRecoveryTargets(record.jobId, record.generation);
        if (restored.ambiguity !== undefined) return retainRecoveryAmbiguity(record, restored.ambiguity);
        if (restored.artifactlessMutation || restored.targets.length === 0) {
          return retainRecoveryAmbiguity(record, restored.artifactlessMutation
            ? "a PREPARED wallet mutation has no durable public artifact"
            : "no public wallet artifact remains to prove local recovery");
        }
        for (const target of restored.targets) {
          let recovery = journal.get(target.operationKey);
          if (recovery?.lifecycleState === "REVERTED") continue;
          if (recovery === undefined) {
            recovery = journal.createPrepared({
              operationKey: target.operationKey,
              jobId: record.jobId,
              generation: record.generation,
              offerHashes: [...record.offerHashes].sort(),
              claim: claimToJournal(record.claim),
              operationKind: "JOB_REVERT",
              ttlExpiresAtMs: record.ttlExpiresAt,
              deadlineAtMs: Math.min(record.ttlExpiresAt, now() + walletOperationTimeoutMs),
              walletArtifactKind: target.walletArtifactKind,
              walletArtifactBytes: target.walletArtifactBytes,
            });
          }
          // This committed CAS is the authority boundary: after REVERTING,
          // any exit or thrown call is outcome-ambiguous and is never replayed.
          journal.transition(recovery.operationKey, "PREPARED", "REVERTING");
          if (target.walletArtifactKind === "UNPROVEN_TRANSACTION") {
            await options.wallet.revertTransaction(target.transaction);
          } else {
            await options.wallet.revert(target.transaction);
          }
          await options.recoveryRevertTestHook?.({
            operationKey: target.operationKey,
            sourceOperationKeys: target.sourceOperationKeys,
            walletArtifactKind: target.walletArtifactKind,
          });
          journal.transition(recovery.operationKey, "REVERTING", "REVERTED");
        }
      }
      markReverted(record.jobId, record.generation);
      quarantined.delete(record.jobId);
      tombstones.set(record.jobId, retention(record));
      release(record.claim);
      stats.reverted += 1;
      log(`released quarantined wallet mutation for ${record.jobId}`);
      return true;
    } catch (error) {
      return retainRecoveryAmbiguity(record, error);
    } finally {
      record.reverting = false;
      refreshStats();
    }
  };

  const runSweep = async (): Promise<void> => {
    const at = now();
    for (const [jobId, expiry] of tombstones) if (expiry <= at) tombstones.delete(jobId);

    for (const record of [...quarantined.values()]) {
      if (record.locallyRevertible) await retryQuarantine(record);
      else if (record.evidenceReconcile) {
        await enqueueTerminal(record.jobId, () => reconcileDurableEvidence(record));
      }
    }

    for (const record of [...awaiting.values()]) {
      if (record.relayAccepted) {
        await enqueueTerminal(record.jobId, () => reconcileFromHttp(record));
      } else if (record.ttlExpiresAt <= at && awaiting.get(record.jobId) === record) {
        await revertWallet(record);
      }
    }
    for (const record of [...confirmations.values()]) {
      await enqueueTerminal(record.jobId, () => reconcileDurableEvidence(record));
    }
    if (options.dustAdmission != null) {
      journal.pruneDust(options.dustAdmission.windowMs, at);
    }
    journal.pruneTerminal(at);
  };

  const sweep = (): Promise<void> => {
    if (sweeping) return sweeping;
    sweeping = track(runSweep().finally(() => {
      sweeping = null;
      refreshStats();
    }));
    return sweeping;
  };

  const scheduleSweep = (): void => {
    if (stopped) return;
    sweepTimer = timers.setTimeout(() => {
      sweepTimer = null;
      void sweep();
      scheduleSweep();
    }, sweepIntervalMs);
  };
  const reconcileStartup = async (): Promise<void> => {
    const rows = journal.list();
    const settlements = rows.filter((row) => row.operationKind === "JOB_SETTLEMENT");
    const latest = new Map<string, JournalOperation>();
    for (const row of settlements) {
      const prior = latest.get(row.jobId);
      if (!prior || row.generation > prior.generation) latest.set(row.jobId, row);
    }
    for (const settlement of latest.values()) {
      if (options.signal?.aborted) throw abortError(options.signal.reason, "journal reconciliation aborted");
      if (terminal(settlement.lifecycleState)) {
        const terminalClaim = claimFromJournal(settlement);
        if (settlement.lifecycleState === "REVERTED") {
          markReverted(settlement.jobId, settlement.generation);
        } else if (settlement.lifecycleState === "SETTLED") {
          markSettled({
            jobId: settlement.jobId,
            claim: terminalClaim,
            offerHashes: settlement.offerHashes,
            ttlExpiresAt: settlement.ttlExpiresAtMs,
            generation: settlement.generation,
            operationKey: settlement.operationKey,
          });
        } else if (group(settlement.jobId, settlement.generation)
          .some((row) => !terminal(row.lifecycleState))) {
          throw new Error(`FAILED job ${settlement.jobId} has non-terminal wallet evidence`);
        }
        tombstones.set(settlement.jobId, settlement.retentionUntilMs);
        continue;
      }
      const sameJob = settlements.filter((row) => row.jobId === settlement.jobId &&
        row.generation !== settlement.generation && !terminal(row.lifecycleState));
      if (sameJob.length > 0) {
        throw new Error(`multiple non-terminal generations for ${settlement.jobId}`);
      }
      const claim = claimFromJournal(settlement);
      if (!options.stock.reserve(claim)) {
        throw new Error(`could not rebuild durable Stock claim for ${settlement.jobId}`);
      }
      const jobRows = group(settlement.jobId, settlement.generation);
      const provedRevert = jobRows.find((row) =>
        row.operationKind === "JOB_REVERT" && !isRecoveryRevert(row) &&
        row.lifecycleState === "REVERTED");
      if (provedRevert && settlement.lifecycleState !== "RELAY_SUBMITTED" &&
        settlement.lifecycleState !== "CONFIRMING") {
        markReverted(settlement.jobId, settlement.generation);
        tombstones.set(settlement.jobId, settlement.retentionUntilMs);
        release(claim);
        continue;
      }
      const relayAmbiguous = settlement.lifecycleState === "AWAITING_RELAY" ||
        settlement.lifecycleState === "RELAY_SUBMITTED" ||
        settlement.lifecycleState === "CONFIRMING" ||
        settlement.lifecycleState === "QUARANTINED" && (
          settlement.receipt.relayState !== undefined ||
          settlement.errorCode?.startsWith("RELAY_") === true ||
          settlement.errorCode?.startsWith("BACKEND_") === true);
      const artifactlessMutation = jobRows.some((row) =>
        row.operationKind !== "JOB_SETTLEMENT" && row.lifecycleState === "PREPARED" &&
        row.walletArtifactBytes === undefined);
      try {
        const revertArtifact = [...jobRows].reverse().find((row) =>
          row.operationKind === "JOB_REVERT" && !isRecoveryRevert(row) &&
          row.walletArtifactKind === "FINALIZED_TRANSACTION");
        const finalizedRows = revertArtifact ? [revertArtifact] : jobRows.filter((row) =>
          row.operationKind === "FINALIZED_CONTRIBUTION" &&
          row.walletArtifactKind === "FINALIZED_TRANSACTION" && !terminal(row.lifecycleState));
        const finalizedTransactions = finalizedRows.map((row) =>
          dependencies.deserializeFinalized(row.walletArtifactBytes!));
        const hasResidualFinal = finalizedRows.some((row) => row.operationKey.endsWith(":residual"));
        const hasDustFinal = finalizedRows.some((row) => row.operationKey.endsWith(":dust"));
        // FR-004: `MIRROR_RESERVATION` is legacy-only here too — see
        // `restoreRecoveryTargets`. A journal carried across the 00006-R1
        // upgrade may still hold one, and it must still be reverted.
        const rawRows = revertArtifact ? [] : jobRows.filter((row) =>
          row.walletArtifactKind === "UNPROVEN_TRANSACTION" && !terminal(row.lifecycleState) &&
          (row.operationKind === "MIRROR_RESERVATION" ||
            (row.operationKind === "RESIDUAL_BUILD" && !hasResidualFinal) ||
            (row.operationKind === "DUST_BALANCE" && !hasDustFinal)));
        const rawTransactions = rawRows.map((row) =>
          dependencies.deserializeUnproven(row.walletArtifactBytes!));
        if (artifactlessMutation) {
          quarantineGroup(settlement.jobId, settlement.generation, "ARTIFACT_OUTCOME_UNKNOWN",
            "a PREPARED wallet call has no durable public artifact");
          quarantined.set(settlement.jobId, {
            jobId: settlement.jobId, claim, offerHashes: settlement.offerHashes,
            ttlExpiresAt: settlement.ttlExpiresAtMs, generation: settlement.generation,
            operationKey: settlement.operationKey, reverting: false, locallyRevertible: false,
            evidenceReconcile: false,
          });
          continue;
        }
        if (rawTransactions.length === 0 && finalizedTransactions.length === 0) {
          const buildingRecord: BuildingJob = {
            job: { type: "swap", jobId: settlement.jobId, tokenIn: "0".repeat(64),
              tokenOut: "1".repeat(64), amountIn: "1", amountOut: "1" },
            claim, offerHashes: settlement.offerHashes, timedOut: false,
            generation: settlement.generation, operationKey: settlement.operationKey,
            ttlExpiresAt: settlement.ttlExpiresAtMs,
          };
          markFailed(buildingRecord, "reopened before any wallet mutation was prepared");
          tombstones.set(settlement.jobId, settlement.retentionUntilMs);
          release(claim);
          continue;
        }
        const walletTransaction = finalizedTransactions.length > 0
          ? dependencies.mergeFinalized(finalizedTransactions)
          : undefined;
        if (relayAmbiguous) {
          quarantineGroup(settlement.jobId, settlement.generation, "RELAY_OUTCOME_UNKNOWN",
            "startup is reconciling the pinned relay HTTP and backend ledger authorities");
          const evidenceRecord: QuarantinedJob = {
            jobId: settlement.jobId,
            claim,
            offerHashes: settlement.offerHashes,
            ...(walletTransaction === undefined ? {} : { walletTransaction }),
            ttlExpiresAt: settlement.ttlExpiresAtMs,
            generation: settlement.generation,
            operationKey: settlement.operationKey,
            reverting: false,
            locallyRevertible: false,
            evidenceReconcile: true,
          };
          quarantined.set(settlement.jobId, evidenceRecord);
          await enqueueTerminal(settlement.jobId, () => reconcileDurableEvidence(evidenceRecord));
          continue;
        }
        const record: QuarantinedJob = {
          jobId: settlement.jobId, claim, offerHashes: settlement.offerHashes,
          ...(rawTransactions.length === 0 ? {} : { rawTransactions }),
          ...(walletTransaction === undefined ? {} : { walletTransaction }),
          ttlExpiresAt: settlement.ttlExpiresAtMs, generation: settlement.generation,
          operationKey: settlement.operationKey, reverting: false, locallyRevertible: true,
          evidenceReconcile: false,
        };
        quarantined.set(settlement.jobId, record);
        await retryQuarantine(record);
      } catch (error) {
        quarantineGroup(settlement.jobId, settlement.generation, "ARTIFACT_RESTORE_FAILED", error);
        quarantined.set(settlement.jobId, {
          jobId: settlement.jobId, claim, offerHashes: settlement.offerHashes,
          ttlExpiresAt: settlement.ttlExpiresAtMs, generation: settlement.generation,
          operationKey: settlement.operationKey, reverting: false, locallyRevertible: false,
          evidenceReconcile: relayAmbiguous,
        });
        log(`artifact restore failed for ${settlement.jobId}; durable quarantine retained: ${errorMessage(error)}`);
      }
    }
    if (options.signal?.aborted) throw abortError(options.signal.reason, "journal reconciliation aborted");
    if (options.dustAdmission != null) {
      journal.pruneDust(options.dustAdmission.windowMs, now());
    }
    journal.pruneTerminal(now());
    reconciled = true;
    refreshStats();
    scheduleSweep();
  };
  const ready = track(reconcileStartup());
  void ready.catch(() => {});

  const idle = async (): Promise<void> => {
    while (tasks.size > 0) await Promise.allSettled([...tasks]);
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
    sweepTimer = null;
    stopping = (async () => {
      try {
        await awaitWithDeadline(idle(), walletOperationTimeoutMs);
      } catch {
        for (const record of building.values()) {
          try { quarantineGroup(record.job.jobId, record.generation, "SHUTDOWN_IN_FLIGHT",
            "shutdown deadline elapsed before wallet work acknowledged completion"); } catch { /* durable row remains non-terminal */ }
        }
        log("shutdown deadline retained in-flight wallet work in the durable journal");
      }
      await Promise.allSettled([...quarantined.values()].map((record) =>
        record.locallyRevertible
          ? retryQuarantine(record)
          : record.evidenceReconcile ? reconcileDurableEvidence(record) : Promise.resolve()));
      await Promise.allSettled([...awaiting.values()].map((record) =>
        record.relayAccepted ? reconcileFromHttp(record) : revertWallet(record)));
      await Promise.allSettled([...confirmations.values()].map((record) => reconcileDurableEvidence(record)));
      stats.stopped = true;
      refreshStats();
    })();
    return stopping;
  };

  return {
    onSwap,
    onTxSubmitted,
    onSubmitFailed,
    notifyConsumed,
    unavailableOfferHashes,
    dustAvailable,
    ready,
    sweep,
    idle,
    stop,
    stats: () => ({ ...stats }),
  };
}
