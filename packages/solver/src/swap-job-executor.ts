// Midnight Intents swap-job execution (spec R2, FR-010/011/016/018/019).
//
// Numeric job in; exact maker files fetched AFTER arrival; proved inverse half
// out. The relay, never this module, merges the taker's half and submits. Every
// uncertain boundary fails closed with `job-error`. Wallet mutations are kept
// as one solver-owned FinalizedTransaction per job so `submit-failed` and the
// chain-TTL sweeper can revert exactly the solver's contribution.

import type { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";

import {
  getOfferStatus,
  readExactOfferFiles,
  reconstructOffer,
} from "@zswap-da/solver-core/api-client";
import {
  MAX_EXACT_FILES_PER_READ,
  type ExactFilesResponse,
} from "@zswap-da/solver-core/exact-files-contract";
import {
  deriveLadder,
  type LadderPairProvenance,
} from "@zswap-da/solver-core/ladder-derivation";
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
  collectNullifiers,
  deriveLegs,
} from "@zswap-da/validator";

import type { Book, BookOffer } from "./book.ts";
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

const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_U256 = (1n << 256n) - 1n;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

/** The wallet could not acknowledge release of the unfinalized fee-sizing
 * mirror. It must remain an occupied slot/claim and be retried by the sweeper;
 * releasing it would let uncertain wallet state fund another job. */
class WalletMutationUncertain extends JobRefusal {
  readonly rawTransaction: unknown;
  readonly walletTransaction: FinalizedTransaction | undefined;
  readonly ttlExpiresAt: number;

  constructor(
    detail: string,
    rawTransaction: unknown,
    walletTransaction: FinalizedTransaction | undefined,
    ttlExpiresAt: number,
  ) {
    super(JOB_WALLET_FAILED, detail);
    this.name = "WalletMutationUncertain";
    this.rawTransaction = rawTransaction;
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
  readExactOfferFiles: typeof readExactOfferFiles;
  getOfferStatus: typeof getOfferStatus;
  reconstructOffer: typeof reconstructOffer;
  deriveOfferSemantics: (transaction: unknown) => ExactOfferSemantics;
  mergeFinalized: typeof mergeFinalized;
  tokenImbalances: typeof tokenImbalances;
}

const DEFAULT_DEPENDENCIES: SwapJobDependencies = {
  readExactOfferFiles,
  getOfferStatus,
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

export interface SwapJobExecutorOptions {
  cache: SwapJobCache;
  stock: Stock;
  wallet: SwapJobWallet;
  keys: { dustSecretKey: unknown } & Record<string, unknown>;
  api?: string;
  maxParallelSwaps: number;
  expiryMarginSeconds: number;
  settleTtlMinutes: number;
  requestTimeoutMs?: number;
  walletOperationTimeoutMs?: number;
  sweepIntervalMs?: number;
  nowMs?: () => number;
  timers?: SwapJobTimers;
  dependencies?: Partial<SwapJobDependencies>;
  /** Called only after a positive backend status read, so a missed websocket
   * consumption event still retracts the cache and next ladder. */
  onOfferConsumed?: (offerHash: string) => void;
  refreshBalances?: () => Promise<void>;
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
  onTxSubmitted: (message: TxSubmittedMessage) => void;
  onSubmitFailed: (message: SubmitFailedMessage) => void;
  notifyConsumed: (offerHash: string) => void;
  unavailableOfferHashes: () => string[];
  sweep: () => Promise<void>;
  idle: () => Promise<void>;
  stop: () => Promise<void>;
  stats: () => SwapJobExecutorStats;
}

interface ResolvedRoute {
  offers: BookOffer[];
  residualIn: bigint;
  residualOut: bigint;
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
}

interface AwaitingJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  consumed: Set<string>;
  walletTransaction: FinalizedTransaction;
  ttlExpiresAt: number;
  reverting: boolean;
  /** False for a build that returned job-error but whose immediate wallet
   * cleanup failed. Relay lifecycle messages cannot authorize that residue. */
  relayAccepted: boolean;
}

interface ConsumptionJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  consumed: Set<string>;
  ttlExpiresAt: number;
}

interface QuarantinedJob {
  jobId: string;
  claim: Claim;
  offerHashes: string[];
  rawTransaction: unknown;
  walletTransaction?: FinalizedTransaction;
  ttlExpiresAt: number;
  reverting: boolean;
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
  if (amountIn <= 0n || amountOut <= 0n || amountIn > MAX_U256 || amountOut > MAX_U256) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "amount is outside the ledger-v8 u256 domain");
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
  options: { nowMs: number; expiryMarginSeconds: number; unavailableOfferHashes: Iterable<string> },
): ResolvedRoute {
  requireCanonicalJob(job);
  if (!cache.isCurrent()) throw new JobRefusal(JOB_CACHE_NOT_CURRENT);

  const derived = deriveLadder(cache.book.all(), {
    nowMs: options.nowMs,
    expiryMarginSeconds: options.expiryMarginSeconds,
    unavailableOfferHashes: options.unavailableOfferHashes,
    maxRungsPerPair: MAX_EXACT_FILES_PER_READ,
  });
  const pair = matchingPair(derived.levels, derived.provenance, job);
  if (pair === null) throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "directed pair is absent");

  const amountIn = BigInt(job.amountIn);
  const amountOut = BigInt(job.amountOut);
  const quoted = interpolateQuote(pair.levels.levels, amountIn);
  if (quoted === null || quoted !== amountOut) {
    throw new JobRefusal(
      JOB_ROUTE_NOT_CURRENT,
      quoted === null ? "size is outside the current ladder" : `current output is ${quoted}`,
    );
  }

  const selected = pair.provenance.rungs.filter((rung) => BigInt(rung.input) <= amountIn);
  if (selected.length === 0) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "size is below the first whole offer");
  }
  if (selected.length > MAX_EXACT_FILES_PER_READ) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "route exceeds the exact-files batch bound");
  }
  const prefix = selected[selected.length - 1]!;
  const residualIn = amountIn - BigInt(prefix.input);
  const residualOut = amountOut - BigInt(prefix.output);
  if (residualIn < 0n || residualOut < 0n || (residualIn === 0n) !== (residualOut === 0n)) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "route residual is inconsistent");
  }
  if (residualOut > BigInt(pair.provenance.residualBound)) {
    throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "route residual exceeds its published bound");
  }

  const offers = selected.map((rung) => {
    const offer = cache.book.get(rung.offerHash);
    if (offer === undefined) throw new JobRefusal(JOB_ROUTE_NOT_CURRENT, "route offer disappeared");
    return snapshotOffer(offer);
  });
  const payouts = new Map<string, bigint>();
  if (residualOut > 0n) payouts.set(job.tokenOut.toLowerCase(), residualOut);
  const claim = claimFor(offers, payouts);
  if (residualOut > stock.available(job.tokenOut.toLowerCase())) {
    throw new JobRefusal(JOB_ROUTE_UNAVAILABLE, "residual solver inventory is insufficient");
  }
  if (!stock.reserve(claim)) {
    throw new JobRefusal(JOB_ROUTE_UNAVAILABLE, "route is already claimed or inventory changed");
  }
  return { offers, residualIn, residualOut, claim };
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

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
  }
}

export function startSwapJobExecutor(options: SwapJobExecutorOptions): SwapJobExecutorHandle {
  requirePositiveInteger("maxParallelSwaps", options.maxParallelSwaps);
  requirePositiveInteger("expiryMarginSeconds", options.expiryMarginSeconds);
  requirePositiveInteger("settleTtlMinutes", options.settleTtlMinutes);
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const walletOperationTimeoutMs = options.walletOperationTimeoutMs ?? 240_000;
  const sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
  requirePositiveInteger("requestTimeoutMs", requestTimeoutMs);
  requirePositiveInteger("walletOperationTimeoutMs", walletOperationTimeoutMs);
  requirePositiveInteger("sweepIntervalMs", sweepIntervalMs);

  const dependencies: SwapJobDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const now = options.nowMs ?? (() => Date.now());
  const timers = options.timers ?? DEFAULT_TIMERS;
  const building = new Map<string, BuildingJob>();
  const awaiting = new Map<string, AwaitingJob>();
  const confirmations = new Map<string, ConsumptionJob>();
  const quarantined = new Map<string, QuarantinedJob>();
  const tombstones = new Map<string, number>();
  /** Bridges the narrow race where the mirror removes an offer after build
   * starts but before the awaiting record is installed. Entries age out with
   * the job TTL so a long-lived solver does not retain every chain event. */
  const consumedAt = new Map<string, number>();
  const tasks = new Set<Promise<unknown>>();
  let sweepTimer: unknown = null;
  let sweeping: Promise<void> | null = null;
  let stopped = false;
  let stopping: Promise<void> | null = null;

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
    try {
      options.log?.(`[solver-job] ${message}`);
    } catch {
      // Diagnostics never participate in execution authority.
    }
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

  const unavailableOfferHashes = (): string[] => [
    ...new Set([
      ...[...building.values()].flatMap((record) => record.offerHashes),
      ...[...awaiting.values()].flatMap((record) => record.offerHashes),
      ...[...confirmations.values()].flatMap((record) => record.offerHashes),
      ...[...quarantined.values()].flatMap((record) => record.offerHashes),
    ]),
  ].sort();

  const isSeen = (jobId: string): boolean =>
    building.has(jobId) || awaiting.has(jobId) || confirmations.has(jobId) ||
    quarantined.has(jobId) || tombstones.has(jobId);

  const terminalError = (jobId: string, reason: string, detail?: string): JobErrorMessage => {
    stats.refused += 1;
    if (detail !== undefined) log(`refused ${jobId}: ${reason} (${detail})`);
    return { type: "job-error", jobId, reason };
  };

  const release = (claim: Claim): void => {
    options.stock.release(claim);
    void options.refreshBalances?.().catch((error) => log(`inventory refresh failed: ${errorMessage(error)}`));
  };

  const revertWallet = async (record: AwaitingJob): Promise<boolean> => {
    if (record.reverting) return false;
    record.reverting = true;
    try {
      await options.wallet.revert(record.walletTransaction);
      awaiting.delete(record.jobId);
      tombstones.set(record.jobId, record.ttlExpiresAt);
      release(record.claim);
      stats.reverted += 1;
      log(`reverted solver-owned transaction for ${record.jobId}`);
      return true;
    } catch (error) {
      record.reverting = false;
      stats.revertFailures += 1;
      log(`revert failed for ${record.jobId}: ${errorMessage(error)}`);
      return false;
    } finally {
      refreshStats();
    }
  };

  const allConsumed = (record: { offerHashes: string[]; consumed: Set<string> }): boolean =>
    record.offerHashes.every((offerHash) => record.consumed.has(offerHash));

  const completeConsumed = (jobId: string): void => {
    // Maker consumption is only submission evidence after the relay has sent
    // tx-submitted. Before that signal, the same maker offer may have been
    // consumed by another actor after our response socket disappeared. Keep
    // our solver-owned half cached so submit-failed or the TTL sweeper can
    // still roll it back fail-closed.
    const confirmation = confirmations.get(jobId);
    if (confirmation && allConsumed(confirmation)) {
      confirmations.delete(jobId);
      tombstones.set(jobId, confirmation.ttlExpiresAt);
      release(confirmation.claim);
      stats.completed += 1;
      log(`backend confirmed submitted maker consumption for ${jobId}`);
    }
    refreshStats();
  };

  const notifyConsumed = (offerHash: string): void => {
    const canonical = offerHash.toLowerCase();
    consumedAt.set(canonical, now());
    for (const record of awaiting.values()) {
      if (record.offerHashes.includes(canonical)) {
        record.consumed.add(canonical);
      }
    }
    for (const record of confirmations.values()) {
      if (record.offerHashes.includes(canonical)) {
        record.consumed.add(canonical);
        completeConsumed(record.jobId);
      }
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

    const transactions: FinalizedTransaction[] = [];
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
      transactions.push(transaction);
    }
    return transactions;
  };

  const buildHalf = async (
    job: SwapMessage,
    route: ResolvedRoute,
    offerTransactions: FinalizedTransaction[],
  ): Promise<BuiltHalf> => {
    const ttlExpiresAt = now() + options.settleTtlMinutes * 60_000;
    const ttl = new Date(ttlExpiresAt);
    const receiverAddress = await options.wallet.shielded.getAddress();
    const walletTransactions: FinalizedTransaction[] = [];
    let mirrorReverted = false;

    // Fee sizing needs the taker's half too. Build an equivalent local mirror,
    // immediately revert its token reservation, and pass its bytes only to the
    // DUST estimator — the pinned reference solver uses the same strategy.
    let mirrorTransaction: unknown;
    try {
      const mirror = await options.wallet.initSwap(
        { shielded: { [job.tokenIn.toLowerCase()]: BigInt(job.amountIn) } },
        [{
          type: "shielded",
          outputs: [{
            type: job.tokenOut.toLowerCase(),
            amount: BigInt(job.amountOut),
            receiverAddress,
          }],
        }],
        options.keys,
        { ttl, payFees: false },
      );
      mirrorTransaction = mirror.transaction;
      await options.wallet.revertTransaction(mirrorTransaction);
      mirrorReverted = true;

      if (route.residualOut > 0n) {
        const residual = await options.wallet.initSwap(
          { shielded: { [job.tokenOut.toLowerCase()]: route.residualOut } },
          [{
            type: "shielded",
            outputs: [{
              type: job.tokenIn.toLowerCase(),
              amount: route.residualIn,
              receiverAddress,
            }],
          }],
          options.keys,
          { ttl, payFees: false },
        );
        walletTransactions.push(await options.wallet.finalizeTransaction(residual.transaction));
      }

      const base = dependencies.mergeFinalized([
        ...offerTransactions,
        ...walletTransactions,
      ]);
      const dustTransaction = await options.wallet.dust.balanceTransactions(
        options.keys.dustSecretKey,
        [base, mirrorTransaction],
        ttl,
      );
      const finalizedDust = await options.wallet.finalizeTransaction(dustTransaction);
      walletTransactions.push(finalizedDust);

      const walletTransaction = dependencies.mergeFinalized(walletTransactions);
      const relayTransaction = dependencies.mergeFinalized([base, finalizedDust]);
      assertInverseHalf(job, relayTransaction, dependencies.tokenImbalances);
      return { relayTransaction, walletTransaction, ttlExpiresAt };
    } catch (error) {
      // Any locally finalized contribution must be rolled back before a
      // job-error can be called mutation-free. Revert failures are folded into
      // the error so the caller quarantines the claim rather than releasing it.
      const cleanup = await Promise.allSettled(
        walletTransactions.map((transaction) => options.wallet.revert(transaction)),
      );
      const failedTransactions = walletTransactions.filter(
        (_transaction, index) => cleanup[index]?.status === "rejected",
      );
      const failedCleanup = cleanup.find((result) => result.status === "rejected");
      let mirrorCleanupError: unknown = null;
      if (mirrorTransaction !== undefined && !mirrorReverted) {
        try {
          await options.wallet.revertTransaction(mirrorTransaction);
          mirrorReverted = true;
        } catch (cleanupError) {
          mirrorCleanupError = cleanupError;
        }
      }
      const failedWalletTransaction = failedTransactions.length === 0
        ? undefined
        : dependencies.mergeFinalized(failedTransactions);
      if (!mirrorReverted && mirrorTransaction !== undefined) {
        throw new WalletMutationUncertain(
          `${errorMessage(error)}; mirror cleanup failed: ${errorMessage(mirrorCleanupError)}`,
          mirrorTransaction,
          failedWalletTransaction,
          ttlExpiresAt,
        );
      }
      if (failedCleanup?.status === "rejected" && failedTransactions.length > 0) {
        throw new WalletCleanupFailure(
          `${errorMessage(error)}; cleanup failed: ${errorMessage(failedCleanup.reason)}`,
          failedWalletTransaction!,
          ttlExpiresAt,
        );
      }
      if (error instanceof JobRefusal) throw error;
      throw new JobRefusal(JOB_WALLET_FAILED, errorMessage(error));
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
    jobId: string,
    claim: Claim,
    offerHashes: string[],
    error: unknown,
  ): boolean => {
    if (error instanceof WalletMutationUncertain) {
      quarantined.set(jobId, {
        jobId,
        claim,
        offerHashes,
        rawTransaction: error.rawTransaction,
        ...(error.walletTransaction === undefined
          ? {}
          : { walletTransaction: error.walletTransaction }),
        ttlExpiresAt: error.ttlExpiresAt,
        reverting: false,
      });
      log(`quarantined uncertain wallet mutation for ${jobId}`);
      return true;
    }
    if (error instanceof WalletCleanupFailure) {
      awaiting.set(jobId, {
        jobId,
        claim,
        offerHashes,
        consumed: new Set(),
        walletTransaction: error.walletTransaction,
        ttlExpiresAt: error.ttlExpiresAt,
        reverting: false,
        relayAccepted: false,
      });
      log(`quarantined failed wallet cleanup for ${jobId}`);
      return true;
    }
    return false;
  };

  const executeSwap = async (job: SwapMessage): Promise<SwapTxMessage | JobErrorMessage> => {
    if (stopped) return terminalError(job.jobId, JOB_CACHE_NOT_CURRENT, "executor stopped");
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
      });
    } catch (error) {
      const refusal = error instanceof JobRefusal ? error : new JobRefusal(JOB_ROUTE_NOT_CURRENT);
      tombstones.set(job.jobId, now() + options.settleTtlMinutes * 60_000);
      return terminalError(job.jobId, refusal.reason, refusal.message);
    }

    const record: BuildingJob = {
      job,
      claim: route.claim,
      offerHashes: route.offers.map((offer) => offer.offerHash),
      timedOut: false,
    };
    building.set(job.jobId, record);
    refreshStats();

    try {
      const exactTransactions = await readAndReconstruct(route);
      if (!options.cache.isCurrent()) throw new JobRefusal(JOB_CACHE_NOT_CURRENT);
      const walletWork = buildHalf(job, route, exactTransactions);
      let built: BuiltHalf;
      try {
        built = await awaitWithDeadline(walletWork, walletOperationTimeoutMs);
      } catch (error) {
        if (!(error instanceof WalletBuildTimeout)) throw error;
        record.timedOut = true;
        stats.timedOutBuilds += 1;
        // The wallet API has no cancellation acknowledgement. Keep the claim
        // and capacity slot until the late operation settles, then revert any
        // produced transaction before releasing either.
        void track(walletWork.then(
          async (late) => {
            const lateRecord: AwaitingJob = {
              jobId: job.jobId,
              claim: route.claim,
              offerHashes: record.offerHashes,
              consumed: new Set(),
              walletTransaction: late.walletTransaction,
              ttlExpiresAt: late.ttlExpiresAt,
              reverting: false,
              relayAccepted: false,
            };
            awaiting.set(job.jobId, lateRecord);
            building.delete(job.jobId);
            await revertWallet(lateRecord);
          },
          (lateError) => {
            building.delete(job.jobId);
            if (!retainCleanupFailure(job.jobId, route.claim, record.offerHashes, lateError)) {
              release(route.claim);
              tombstones.set(job.jobId, now() + options.settleTtlMinutes * 60_000);
            }
            refreshStats();
          },
        ));
        return terminalError(job.jobId, JOB_WALLET_TIMEOUT, error.message);
      }

      building.delete(job.jobId);
      awaiting.set(job.jobId, {
        jobId: job.jobId,
        claim: route.claim,
        offerHashes: record.offerHashes,
        consumed: new Set(record.offerHashes.filter((hash) => consumedAt.has(hash))),
        walletTransaction: built.walletTransaction,
        ttlExpiresAt: built.ttlExpiresAt,
        reverting: false,
        relayAccepted: true,
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
        if (!retainCleanupFailure(job.jobId, route.claim, record.offerHashes, error)) {
          release(route.claim);
          tombstones.set(job.jobId, now() + options.settleTtlMinutes * 60_000);
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

  const onTxSubmitted = (message: TxSubmittedMessage): void => {
    const record = awaiting.get(message.jobId);
    if (!record || record.reverting || !record.relayAccepted) return;
    awaiting.delete(message.jobId);
    // Clear the cached wallet transaction exactly as the relay protocol says,
    // but retain the claim until backend plain reads confirm maker consumption.
    confirmations.set(message.jobId, {
      jobId: message.jobId,
      claim: record.claim,
      offerHashes: record.offerHashes,
      consumed: record.consumed,
      ttlExpiresAt: record.ttlExpiresAt,
    });
    completeConsumed(message.jobId);
    refreshStats();
    log(`relay submitted ${message.jobId} as ${message.txId}; awaiting backend consumption`);
  };

  const onSubmitFailed = (message: SubmitFailedMessage): void => {
    const record = awaiting.get(message.jobId);
    if (!record || !record.relayAccepted) return;
    log(`relay submit failed for ${message.jobId}: ${message.reason}`);
    void track(revertWallet(record));
  };

  const pollConsumption = async (
    record: AwaitingJob | ConsumptionJob,
  ): Promise<boolean> => {
    for (const offerHash of record.offerHashes) {
      if (record.consumed.has(offerHash)) continue;
      try {
        const status = await dependencies.getOfferStatus(offerHash, {
          ...(options.api === undefined ? {} : { api: options.api }),
          timeoutMs: requestTimeoutMs,
        });
        if (status.status === "consumed") {
          record.consumed.add(offerHash);
          consumedAt.set(offerHash, now());
          try {
            options.onOfferConsumed?.(offerHash);
          } catch {
            // The positive status remains authority even if the observer fails.
          }
        }
      } catch (error) {
        log(`status read failed for ${offerHash.slice(0, 10)}: ${errorMessage(error)}`);
      }
    }
    completeConsumed(record.jobId);
    return allConsumed(record);
  };

  const retryQuarantine = async (record: QuarantinedJob): Promise<boolean> => {
    if (record.reverting) return false;
    record.reverting = true;
    try {
      await options.wallet.revertTransaction(record.rawTransaction);
      if (record.walletTransaction !== undefined) await options.wallet.revert(record.walletTransaction);
      quarantined.delete(record.jobId);
      tombstones.set(record.jobId, record.ttlExpiresAt);
      release(record.claim);
      stats.reverted += 1;
      log(`released quarantined wallet mutation for ${record.jobId}`);
      return true;
    } catch (error) {
      stats.revertFailures += 1;
      log(`quarantine cleanup failed for ${record.jobId}: ${errorMessage(error)}`);
      return false;
    } finally {
      record.reverting = false;
      refreshStats();
    }
  };

  const runSweep = async (): Promise<void> => {
    const at = now();
    for (const [jobId, expiry] of tombstones) if (expiry <= at) tombstones.delete(jobId);
    const consumedRetentionMs = options.settleTtlMinutes * 60_000;
    for (const [offerHash, observedAt] of consumedAt) {
      if (observedAt + consumedRetentionMs <= at) consumedAt.delete(offerHash);
    }

    for (const record of [...quarantined.values()]) await retryQuarantine(record);

    for (const record of [...awaiting.values()]) {
      if (record.relayAccepted) await pollConsumption(record);
      // A tx-submitted frame can move this exact object to confirmations
      // while the status request above is in flight. Re-check ownership before
      // TTL rollback so the sweeper can never revert a submitted transaction.
      if (record.ttlExpiresAt <= at && awaiting.get(record.jobId) === record) {
        await revertWallet(record);
      }
    }
    for (const record of [...confirmations.values()]) await pollConsumption(record);
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
  scheduleSweep();

  const idle = async (): Promise<void> => {
    while (tasks.size > 0) await Promise.allSettled([...tasks]);
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
    sweepTimer = null;
    stopping = (async () => {
      await idle();
      await Promise.allSettled([...quarantined.values()].map((record) => retryQuarantine(record)));
      await Promise.allSettled([...awaiting.values()].map((record) => revertWallet(record)));
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
    sweep,
    idle,
    stop,
    stats: () => ({ ...stats }),
  };
}
