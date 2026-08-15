// Settlement, one fill at a time.
//
// Strictly serialised on purpose: a single wallet's coin selection would race
// itself across concurrent balances, and serialisation plus the Stock claim
// registry makes it impossible for two fills to touch the same offer.
//
// The failure path is the load-bearing part. A balance known not to have been
// submitted leaves its inputs locked in the wallet, so each such attempt MUST
// revert or the solver silently bleeds inventory (verified in
// scripts/probe-settle.ts). Once submission starts, uncertainty is handled in
// the opposite direction: retain the operation and refuse a duplicate.

import {
  assertOfferBlobIdentity,
  getOfferStatus,
  getZswapByHash,
  reconstructOffer,
  type OfferStatus,
} from "@zswap-da/solver-core/api-client";
import {
  describeImbalances,
  mergeFinalized,
  nonDustImbalances,
  settleViaBatcher,
} from "@zswap-da/solver-core/batcher";
import {
  collectNullifiers,
  collectUnshieldedSpends,
  deriveLegs,
  type OfferLeg,
  type UnshieldedSpendRef,
} from "@zswap-da/validator";
import type { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";

import type { BookOffer } from "./book.ts";
import { claimFor, Stock, type Claim } from "./stock.ts";

type FillDecision =
  | { kind: "settled"; offerHash: string }
  | { kind: "skipped"; offerHash: string; reason: string }
  | { kind: "failed"; offerHash: string; reason: string };

/** Whether the reservation was made reusable after the execution attempt.
 * `quarantine` is a safety state, not a retry hint: some remote boundary may
 * have accepted the transaction, so only later durable reconciliation may
 * release it. */
export type ClaimDisposition = "release" | "quarantine";

export type FillOutcome = FillDecision & { claimDisposition: ClaimDisposition };

/** Outcome of settling a merged set. `offerHashes` is every member, so a caller
 *  can release or re-evaluate the whole set rather than one leg. */
type MatchDecision =
  | { kind: "settled"; offerHashes: string[] }
  | { kind: "skipped"; offerHashes: string[]; reason: string }
  | { kind: "failed"; offerHashes: string[]; reason: string };

export type MatchOutcome = MatchDecision & { claimDisposition: ClaimDisposition };

interface ExecutionResult<T> {
  outcome: T;
  claimDisposition: ClaimDisposition;
}

type MaybeExecutionResult<T> = T | ExecutionResult<T>;

const isExecutionResult = <T extends object>(
  value: MaybeExecutionResult<T>,
): value is ExecutionResult<T> =>
  "outcome" in value && "claimDisposition" in value;

const releasable = <T>(outcome: T): ExecutionResult<T> => ({
  outcome,
  claimDisposition: "release",
});

const quarantined = <T>(outcome: T): ExecutionResult<T> => ({
  outcome,
  claimDisposition: "quarantine",
});

/** Remote uncertainty is deliberately not represented as a fake offer state.
 * In particular, an HTTP error must never be coerced to `live`. */
type StatusObservation =
  | { kind: "known"; status: OfferStatus }
  | { kind: "unknown"; reason: string };

type Confirmation =
  | StatusObservation
  | { kind: "timeout"; reason: string };

type RevertResult = { ok: true } | { ok: false; reason: string };

/** A deadline/stop can return ownership to the solver while the underlying
 * wallet promise is still running. That is materially different from a normal
 * rejection: without a cancellation acknowledgement, any inputs it touched
 * remain quarantined. */
class OperationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationBoundaryError";
  }
}

const BATCHER_ATTEMPTS = 3;

/** Take ownership of every mutable collection at admission. Callers are free
 * to reuse/mutate their candidate objects after fill()/settleMatch() returns;
 * queued execution must continue against exactly what Stock reserved. */
const snapshotOffer = (offer: BookOffer): BookOffer => ({
  offerHash: offer.offerHash,
  gives: offer.gives.map((leg) => ({ ...leg })),
  wants: offer.wants.map((leg) => ({ ...leg })),
  expiresAt: offer.expiresAt,
  firstSeenAt: offer.firstSeenAt,
  inputNullifiers: [...offer.inputNullifiers],
  ...(offer.blob !== undefined ? { blob: offer.blob } : {}),
});

export interface WalletLike {
  balanceFinalizedTransaction: (tx: unknown, keys: unknown, opts: unknown) => Promise<any>;
  finalizeRecipe: (recipe: unknown) => Promise<any>;
  submitTransaction: (tx: unknown) => Promise<unknown>;
  revert?: (txOrRecipe: unknown) => Promise<void>;
}

export interface ExecutorApiClient {
  getOfferStatus: typeof getOfferStatus;
  getZswapByHash: typeof getZswapByHash;
  reconstructOffer: typeof reconstructOffer;
  /** Pure transaction inspection seam. Production derives directly from the
   * reconstructed ledger transaction; tests with synthetic transactions may
   * provide an equivalent inspector. */
  deriveOfferSemantics?: (tx: unknown) => DerivedOfferSemantics;
  /** Content-address validation seam for synthetic tests. Production decodes
   * the MIP-0005 bytes and compares their sha256 with the BookOffer hash. */
  assertOfferBlobIdentity?: (blob: string, expectedHash: string) => void;
  /** Scoped fault-test seams; production uses solver-core implementations. */
  mergeFinalized?: typeof mergeFinalized;
  nonDustImbalances?: typeof nonDustImbalances;
  describeImbalances?: typeof describeImbalances;
  settleViaBatcher?: typeof settleViaBatcher;
}

export interface DerivedOfferSemantics {
  gives: OfferLeg[];
  wants: OfferLeg[];
  nullifiers: string[];
  unshieldedSpends: UnshieldedSpendRef[];
}

/** Production transaction inspector, exported so a real serialized-ledger
 * fixture can pin the FinalizedTransaction/UnprovenTransaction SDK shape. */
export function deriveReconstructedOfferSemantics(tx: unknown): DerivedOfferSemantics {
  const ledgerTx = tx as UnprovenTransaction;
  const { gives, wants } = deriveLegs(ledgerTx);
  return {
    gives,
    wants,
    nullifiers: collectNullifiers(ledgerTx),
    unshieldedSpends: collectUnshieldedSpends(ledgerTx),
  };
}

export interface ExecutorOptions {
  wallet: WalletLike;
  keys: unknown;
  stock: Stock;
  /** Injectable finite API boundary; production uses solver-core. */
  apiClient?: ExecutorApiClient;
  api?: string;
  settleTtlMinutes?: number;
  statusPollMs?: number;
  /** Refuse work that has entered this many seconds of its indexed expiry. */
  expiryMarginSeconds?: number;
  /** Clock seam for deterministic dequeue/expiry tests. */
  nowMs?: () => number;
  /** Give up waiting for a settlement to be observed on chain. */
  confirmTimeoutMs?: number;
  /** Absolute deadline for each finite node API request. */
  requestTimeoutMs?: number;
  /** Absolute deadline for one batcher request. */
  batcherTimeoutMs?: number;
  /** Absolute deadline for a wallet/proving operation. A timeout does not
   * prove cancellation; the admitted claim is retained for reconciliation. */
  walletOperationTimeoutMs?: number;
  /** Re-read balances after every terminal outcome. */
  refreshBalances?: (signal: AbortSignal) => Promise<void>;
  /** Global inventory-readiness gate. False refuses both Path A and Path B,
   * including exact crossings that do not otherwise reserve a payout. */
  isReady?: () => boolean;
  /** Build the solver's own half of a merge — supplying `gives`, receiving
   *  `wants` — already proven and finalized, ready to merge. Only called when a
   *  set does not cross exactly. Without it, only exact crossings can settle. */
  buildTopUp?: (gives: Map<string, bigint>, wants: Map<string, bigint>) => Promise<unknown>;
  log?: (msg: string) => void;
  onOutcome?: (outcome: FillOutcome) => void;
  onMatchOutcome?: (outcome: MatchOutcome) => void;
}

const MAX_ATTEMPTS = 2;

export interface ExecutorStopResult {
  /** True when every admitted job reached the contained queue tail before the
   * stop deadline. False means background wallet work may still be running. */
  drained: boolean;
  /** In-memory claims deliberately left reserved. They are not durable restart
   * reconciliation and must never be described as such. */
  retainedClaims: number;
  /** Underlying calls that ignored cancellation and were still pending when
   * this result was produced. Handles are retained/observed only in memory. */
  retainedOperations: number;
}

export class Executor {
  readonly #opts: Required<
    Pick<
      ExecutorOptions,
      | "settleTtlMinutes"
      | "statusPollMs"
      | "expiryMarginSeconds"
      | "confirmTimeoutMs"
      | "requestTimeoutMs"
      | "batcherTimeoutMs"
      | "walletOperationTimeoutMs"
    >
  > &
    ExecutorOptions;
  readonly #stock: Stock;
  readonly #apiClient: ExecutorApiClient;
  readonly #deriveOfferSemantics: (tx: unknown) => DerivedOfferSemantics;
  readonly #assertOfferBlobIdentity: (blob: string, expectedHash: string) => void;
  readonly #mergeFinalized: typeof mergeFinalized;
  readonly #nonDustImbalances: typeof nonDustImbalances;
  readonly #describeImbalances: typeof describeImbalances;
  readonly #settleViaBatcher: typeof settleViaBatcher;
  /** Resolved by the sync layer the moment an offer leaves the book, so a
   *  settlement is usually confirmed by an event rather than a poll. */
  readonly #awaitingConsumption = new Map<string, () => void>();
  readonly #stopOwner = new AbortController();
  readonly #activeClaims = new Set<Claim>();
  readonly #retainedClaims = new Set<Claim>();
  readonly #retainedOperations = new Map<Promise<unknown>, string>();
  #queue: Promise<void> = Promise.resolve();
  #stopping = false;
  #stopPromise: Promise<ExecutorStopResult> | null = null;

  constructor(opts: ExecutorOptions) {
    this.#opts = {
      settleTtlMinutes: 30,
      statusPollMs: 5000,
      expiryMarginSeconds: 120,
      confirmTimeoutMs: 180_000,
      requestTimeoutMs: 15_000,
      batcherTimeoutMs: 240_000,
      walletOperationTimeoutMs: 240_000,
      ...opts,
    };
    this.#stock = opts.stock;
    this.#apiClient = opts.apiClient ?? {
      getOfferStatus,
      getZswapByHash,
      reconstructOffer,
    };
    this.#deriveOfferSemantics =
      this.#apiClient.deriveOfferSemantics ?? deriveReconstructedOfferSemantics;
    this.#assertOfferBlobIdentity =
      this.#apiClient.assertOfferBlobIdentity ?? assertOfferBlobIdentity;
    this.#mergeFinalized = this.#apiClient.mergeFinalized ?? mergeFinalized;
    this.#nonDustImbalances = this.#apiClient.nonDustImbalances ?? nonDustImbalances;
    this.#describeImbalances = this.#apiClient.describeImbalances ?? describeImbalances;
    this.#settleViaBatcher = this.#apiClient.settleViaBatcher ?? settleViaBatcher;
  }

  #log(msg: string): void {
    try {
      this.#opts.log?.(msg);
    } catch {
      // Logging is diagnostic only; it must never poison the settlement queue.
    }
  }

  static #reason(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  static #sameTokenMap(left: Map<string, bigint>, right: Map<string, bigint>): boolean {
    if (left.size !== right.size) return false;
    for (const [token, amount] of left) {
      if (right.get(token.toLowerCase()) !== amount) return false;
    }
    return true;
  }

  static #netOf(offers: readonly BookOffer[]): Map<string, bigint> | null {
    const net = new Map<string, bigint>();
    const add = (token: string, delta: bigint): void => {
      const canonical = token.toLowerCase();
      const next = (net.get(canonical) ?? 0n) + delta;
      if (next === 0n) net.delete(canonical);
      else net.set(canonical, next);
    };
    for (const offer of offers) {
      for (const leg of [...offer.gives, ...offer.wants]) {
        if (
          leg.kind !== "SHIELDED" ||
          !/^[0-9a-f]{64}$/i.test(leg.token) ||
          typeof leg.amount !== "bigint" ||
          leg.amount <= 0n
        ) {
          return null;
        }
      }
      for (const leg of offer.gives) add(leg.token, leg.amount);
      for (const leg of offer.wants) add(leg.token, -leg.amount);
    }
    return net;
  }

  /** Bind the REST/indexed economics used for pricing and reservation to the
   * content-addressed transaction that will actually reach a wallet/batcher.
   * This check deliberately runs even for a cached blob: cache provenance is
   * not proof that its computed row belonged to the same transaction. */
  #validateOfferSemantics(offer: BookOffer, tx: unknown): string | null {
    let derived: DerivedOfferSemantics;
    try {
      derived = this.#deriveOfferSemantics(tx);
    } catch (err) {
      return `could not derive reconstructed transaction semantics: ${Executor.#reason(err)}`;
    }

    const legKey = (leg: {
      token: unknown;
      amount: unknown;
      kind: unknown;
    }): string | null => {
      if (typeof leg.token !== "string" || !/^[0-9a-f]{64}$/i.test(leg.token)) return null;
      if (leg.kind !== "SHIELDED" && leg.kind !== "UNSHIELDED") return null;
      const amount = typeof leg.amount === "bigint" ? leg.amount.toString() : leg.amount;
      if (typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) return null;
      return `${leg.kind}:${leg.token.toLowerCase()}:${amount}`;
    };
    const canonicalLegs = (legs: readonly unknown[]): string[] | null => {
      const keys: string[] = [];
      for (const value of legs) {
        if (typeof value !== "object" || value === null) return null;
        const key = legKey(value as { token: unknown; amount: unknown; kind: unknown });
        if (key === null) return null;
        keys.push(key);
      }
      return keys.sort();
    };
    const canonicalNullifiers = (values: readonly unknown[]): string[] | null => {
      const out: string[] = [];
      for (const value of values) {
        if (typeof value !== "string" || value.length === 0) return null;
        const clean = value.startsWith("0x") || value.startsWith("0X")
          ? value.slice(2)
          : value;
        if (clean.length === 0) return null;
        out.push(clean.toLowerCase());
      }
      return out.sort();
    };
    const same = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((value, index) => value === right[index]);

    const expectedGives = canonicalLegs(offer.gives);
    const expectedWants = canonicalLegs(offer.wants);
    const actualGives = Array.isArray(derived.gives) ? canonicalLegs(derived.gives) : null;
    const actualWants = Array.isArray(derived.wants) ? canonicalLegs(derived.wants) : null;
    const expectedNullifiers = canonicalNullifiers(offer.inputNullifiers);
    const actualNullifiers = Array.isArray(derived.nullifiers)
      ? canonicalNullifiers(derived.nullifiers)
      : null;

    if (
      expectedGives === null ||
      expectedWants === null ||
      expectedNullifiers === null ||
      actualGives === null ||
      actualWants === null ||
      actualNullifiers === null
    ) {
      return "listed or reconstructed semantics are malformed";
    }

    // The supported execution paths are shielded-only. The Book normally
    // receives this gate in Engine too, but Executor is a separate trust
    // boundary and can be called directly. Unshielded spend triples are not
    // represented in BookOffer/Stock, so accepting one would also leave claim
    // collisions untracked.
    if (
      expectedGives.some((leg) => leg.startsWith("UNSHIELDED:")) ||
      expectedWants.some((leg) => leg.startsWith("UNSHIELDED:")) ||
      actualGives.some((leg) => leg.startsWith("UNSHIELDED:")) ||
      actualWants.some((leg) => leg.startsWith("UNSHIELDED:")) ||
      !Array.isArray(derived.unshieldedSpends) ||
      derived.unshieldedSpends.length > 0
    ) {
      return "unshielded offer semantics are unsupported by claim tracking";
    }

    if (!same(expectedGives, actualGives)) return "gives multiset differs from listed economics";
    if (!same(expectedWants, actualWants)) return "wants multiset differs from listed economics";
    if (!same(expectedNullifiers, actualNullifiers)) {
      return "shielded nullifier multiset differs from listed claim identities";
    }
    return null;
  }

  async #bounded<T>(
    label: string,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = new AbortController();
    const abortForStop = (): void => {
      operation.abort(
        new OperationBoundaryError(`${label} interrupted by solver shutdown`),
      );
    };
    if (this.#stopOwner.signal.aborted) abortForStop();
    else this.#stopOwner.signal.addEventListener("abort", abortForStop, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortWait = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        const reason = operation.signal.reason;
        reject(
          reason instanceof OperationBoundaryError
            ? reason
            : new OperationBoundaryError(
                reason instanceof Error ? reason.message : `${label} aborted`,
              ),
        );
      };
      removeAbortWait = () => operation.signal.removeEventListener("abort", rejectAbort);
      if (operation.signal.aborted) rejectAbort();
      else operation.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    // Both the underlying operation and abort waiter can lose Promise.race.
    // Observe them so a late rejection cannot surface as process-global noise.
    void aborted.catch(() => {});

    const task = Promise.resolve().then(() => {
      if (operation.signal.aborted) {
        const reason = operation.signal.reason;
        throw reason instanceof OperationBoundaryError
          ? reason
          : new OperationBoundaryError(
              reason instanceof Error ? reason.message : `${label} aborted`,
            );
      }
      return run(operation.signal);
    });
    let taskSettled = false;
    void task.then(
      () => {
        taskSettled = true;
        this.#retainedOperations.delete(task);
      },
      () => {
        taskSettled = true;
        this.#retainedOperations.delete(task);
      },
    );
    try {
      return await Promise.race([
        task,
        aborted,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new OperationBoundaryError(
              `${label} timed out after ${timeoutMs} ms`,
            );
            operation.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof OperationBoundaryError && !taskSettled) {
        this.#retainedOperations.set(task, label);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbortWait();
      this.#stopOwner.signal.removeEventListener("abort", abortForStop);
    }
  }

  /** Append one job while keeping the queue tail fulfilled. Resolve the caller's
   * result before invoking non-authoritative observers. */
  #schedule<T extends object>(
    claim: Claim,
    run: () => Promise<MaybeExecutionResult<T>>,
    onFailure: (reason: string) => T,
    observe: ((outcome: T & { claimDisposition: ClaimDisposition }) => void) | undefined,
  ): Promise<T & { claimDisposition: ClaimDisposition }> {
    type FinalOutcome = T & { claimDisposition: ClaimDisposition };
    let settle!: (outcome: FinalOutcome) => void;
    const result = new Promise<FinalOutcome>((resolve) => {
      settle = resolve;
    });
    this.#activeClaims.add(claim);

    const job = async (): Promise<void> => {
      let execution: ExecutionResult<T>;
      try {
        const attempted = await run();
        execution = isExecutionResult(attempted) ? attempted : releasable(attempted);
      } catch (err) {
        // An escaped exception has lost its execution-stage information. Do not
        // guess that it happened before submission; quarantine until durable
        // reconciliation proves the claim reusable.
        execution = quarantined(
          onFailure(`unexpected execution failure: ${Executor.#reason(err)}`),
        );
      }

      let outcome = execution.outcome;
      let claimDisposition = execution.claimDisposition;

      // Keep every reservation in place while authoritative balances refresh.
      // Releasing first briefly republishes stale pre-settlement capacity. A
      // successful refresh permits only explicitly releasable executions to
      // release; ambiguous executions remain quarantined across future jobs.
      if (this.#opts.refreshBalances) {
        try {
          await this.#bounded(
            "balance refresh",
            this.#opts.walletOperationTimeoutMs,
            this.#opts.refreshBalances,
          );
        } catch (err) {
          const reason =
            `balance refresh failed; capacity remains reserved: ${Executor.#reason(err)}`;
          this.#log(`[solver] ${reason}`);
          outcome = onFailure(reason);
          claimDisposition = "quarantine";
        }
      }

      // Shutdown aborts finite boundaries, but a wallet implementation may
      // ignore cancellation and resolve later. Once stop owns the lifecycle,
      // no admitted claim is made reusable on the strength of that late work.
      if (this.#stopping) {
        outcome = onFailure(
          "solver shutdown interrupted execution; capacity retained for reconciliation",
        );
        claimDisposition = "quarantine";
      }

      if (claimDisposition === "release") {
        try {
          this.#stock.release(claim);
        } catch (err) {
          const reason = `claim release failed: ${Executor.#reason(err)}`;
          this.#log(`[solver] ${reason}`);
          outcome = onFailure(reason);
          claimDisposition = "quarantine";
        }
      }

      this.#activeClaims.delete(claim);
      if (claimDisposition === "quarantine") this.#retainedClaims.add(claim);

      const finalOutcome = { ...outcome, claimDisposition } as FinalOutcome;

      // Promise resolution itself cannot throw. Do it before callbacks so even
      // a hostile observer cannot strand this result.
      settle(finalOutcome);
      try {
        observe?.(finalOutcome);
      } catch (err) {
        this.#log(`[solver] outcome observer failed: ${Executor.#reason(err)}`);
      }
    };

    const scheduled = this.#queue.catch((err) => {
      this.#log(`[solver] recovered rejected queue tail: ${Executor.#reason(err)}`);
    }).then(job);
    this.#queue = scheduled.catch((err) => {
      // job contains every expected failure, but retain this final containment
      // boundary so a future callback cannot permanently reject the tail.
      this.#log(`[solver] executor job escaped containment: ${Executor.#reason(err)}`);
    });

    return result;
  }

  /** Stop admitting work, interrupt every owned finite wait, and wait only up
   * to `timeoutMs` for the serial queue. Underlying wallet promises need not
   * honour AbortSignal, so a deadline reports retained in-memory claims rather
   * than pretending those operations were cancelled or restart-safe. */
  stop(timeoutMs = 15_000): Promise<ExecutorStopResult> {
    if (this.#stopPromise) return this.#stopPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error(`executor stop timeout must be a positive safe integer, got ${timeoutMs}`),
      );
    }
    this.#stopping = true;
    this.#stopOwner.abort(
      new OperationBoundaryError("solver executor stopped; active operations quarantined"),
    );
    const tail = this.#queue;
    this.#stopPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          tail.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        if (!drained) {
          for (const claim of this.#activeClaims) this.#retainedClaims.add(claim);
          this.#log(
            `[solver] executor stop deadline elapsed; ` +
              `${this.#activeClaims.size} active claim(s) retained in memory`,
          );
        }
        return {
          drained,
          retainedClaims: new Set([
            ...this.#retainedClaims,
            ...this.#activeClaims,
          ]).size,
          retainedOperations: this.#retainedOperations.size,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.#stopPromise;
  }

  /** Tell the executor an offer left the book. Confirmation falls back to
   *  polling, so a missed call costs latency, never correctness. */
  notifyConsumed(offerHash: string): void {
    try {
      this.#awaitingConsumption.get(offerHash)?.();
    } catch (err) {
      this.#log(`[solver] consumption notifier failed: ${Executor.#reason(err)}`);
    }
  }

  /** Admit a Path A fill: the solver takes `offer` from its own inventory,
   *  paying what the offer wants. Returns once the fill reaches a terminal
   *  outcome. Offers already committed elsewhere are refused here, so the
   *  caller may enqueue optimistically. */
  fill(offer: BookOffer, payouts: Map<string, bigint>): Promise<FillOutcome> {
    const admitted = snapshotOffer(offer);
    if (this.#stopping || this.#opts.isReady?.() === false) {
      return Promise.resolve({
        kind: "skipped",
        offerHash: admitted.offerHash,
        reason: this.#stopping ? "executor is stopping" : "solver inventory is unready",
        claimDisposition: "release",
      });
    }
    if (
      admitted.gives.length !== 1 ||
      admitted.wants.length !== 1 ||
      admitted.gives[0].kind !== "SHIELDED" ||
      admitted.wants[0].kind !== "SHIELDED"
    ) {
      return Promise.resolve({
        kind: "failed",
        offerHash: admitted.offerHash,
        reason: "executor supports exactly one shielded give and want for Path A",
        claimDisposition: "release",
      });
    }
    const authoritativePayouts = new Map([
      [admitted.wants[0].token.toLowerCase(), admitted.wants[0].amount],
    ]);
    if (!Executor.#sameTokenMap(payouts, authoritativePayouts)) {
      return Promise.resolve({
        kind: "failed",
        offerHash: admitted.offerHash,
        reason: "caller payout does not match the offer's authoritative want",
        claimDisposition: "release",
      });
    }
    const claim = claimFor([admitted], authoritativePayouts);
    if (!this.#stock.reserve(claim)) {
      return Promise.resolve<FillOutcome>({
        kind: "skipped",
        offerHash: admitted.offerHash,
        reason: "already claimed by an in-flight fill",
        claimDisposition: "release",
      });
    }

    return this.#schedule<FillDecision>(
      claim,
      () => this.#runFill(admitted),
      (reason) => ({ kind: "failed", offerHash: admitted.offerHash, reason }),
      this.#opts.onOutcome,
    );
  }

  /** Admit a Path B settlement: merge `offers` into one transaction and hand it
   *  to the batcher, which adds dust and submits.
   *
   *  `net` is the set's per-token balance from the solver's side — negative
   *  entries are what it must supply. An exactly-crossing set nets to nothing
   *  and costs no inventory; anything else needs a top-up half. */
  settleMatch(offers: BookOffer[], net: Map<string, bigint>): Promise<MatchOutcome> {
    const admitted = offers.map(snapshotOffer);
    const offerHashes = admitted.map((o) => o.offerHash);
    if (this.#stopping || this.#opts.isReady?.() === false) {
      return Promise.resolve({
        kind: "skipped",
        offerHashes,
        reason: this.#stopping ? "executor is stopping" : "solver inventory is unready",
        claimDisposition: "release",
      });
    }
    const authoritativeNet = Executor.#netOf(admitted);
    if (authoritativeNet === null) {
      return Promise.resolve({
        kind: "failed",
        offerHashes,
        reason: "executor supports only well-formed shielded Path B legs",
        claimDisposition: "release",
      });
    }
    if (!Executor.#sameTokenMap(net, authoritativeNet)) {
      return Promise.resolve({
        kind: "failed",
        offerHashes,
        reason: "caller net does not match the offers' authoritative aggregate",
        claimDisposition: "release",
      });
    }
    const payouts = new Map<string, bigint>();
    for (const [token, amount] of authoritativeNet) {
      if (amount < 0n) payouts.set(token, -amount);
    }
    const claim = claimFor(admitted, payouts);
    if (!this.#stock.reserve(claim)) {
      return Promise.resolve<MatchOutcome>({
        kind: "skipped",
        offerHashes,
        reason: "a member is already claimed by an in-flight fill",
        claimDisposition: "release",
      });
    }

    return this.#schedule<MatchDecision>(
      claim,
      () => this.#runMatch(admitted, authoritativeNet),
      (reason) => ({ kind: "failed", offerHashes, reason }),
      this.#opts.onMatchOutcome,
    );
  }

  async #runMatch(
    offers: BookOffer[],
    net: Map<string, bigint>,
  ): Promise<MaybeExecutionResult<MatchDecision>> {
    const offerHashes = offers.map((o) => o.offerHash);
    if (this.#opts.isReady?.() === false) {
      return {
        kind: "skipped",
        offerHashes,
        reason: "solver inventory became unready before execution",
      };
    }

    // Re-check every member at dequeue time: the queue wait may have straddled
    // another taker, and one dead member makes the whole merge unsettleable.
    for (const offer of offers) {
      const now = this.#opts.nowMs?.() ?? Date.now();
      if (
        offer.expiresAt === null ||
        !Number.isFinite(offer.expiresAt) ||
        now >= offer.expiresAt - this.#opts.expiryMarginSeconds * 1000
      ) {
        return {
          kind: "skipped",
          offerHashes,
          reason: `${offer.offerHash.slice(0, 10)} is inside the settlement expiry margin`,
        };
      }
      const observed = await this.#status(offer.offerHash);
      if (observed.kind === "unknown") {
        return {
          kind: "failed",
          offerHashes,
          reason: `${offer.offerHash.slice(0, 10)} status unknown: ${observed.reason}`,
        };
      }
      if (observed.status !== "live") {
        return {
          kind: "skipped",
          offerHashes,
          reason: `${offer.offerHash.slice(0, 10)} is ${observed.status}`,
        };
      }
    }

    const txs = [];
    try {
      for (const offer of offers) {
        const blob = offer.blob ?? (await this.#getOfferBlob(offer.offerHash));
        this.#assertOfferBlobIdentity(blob, offer.offerHash);
        const tx = this.#apiClient.reconstructOffer(blob);
        const mismatch = this.#validateOfferSemantics(offer, tx);
        if (mismatch !== null) {
          return {
            kind: "failed",
            offerHashes,
            reason:
              `${offer.offerHash.slice(0, 10)} reconstructed offer does not match ` +
              `listed economics: ${mismatch}`,
          };
        }
        txs.push(tx);
      }
    } catch (err) {
      return {
        kind: "failed",
        offerHashes,
        reason: `offer reconstruction failed before submission: ${Executor.#reason(err)}`,
      };
    }

    // A set that does not cross exactly needs the solver's own half to close
    // it: supplying every shortfall and taking every surplus. Built like any
    // maker's half — deliberately unbalanced on its own, balanced once merged.
    const gives = new Map<string, bigint>();
    const wants = new Map<string, bigint>();
    for (const [token, amount] of net) {
      if (amount < 0n) gives.set(token, -amount);
      else if (amount > 0n) wants.set(token, amount);
    }
    if (gives.size > 0 || wants.size > 0) {
      if (!this.#opts.buildTopUp) {
        return {
          kind: "skipped",
          offerHashes,
          reason: "set does not cross exactly and no top-up builder is configured",
        };
      }
      try {
        txs.push(
          await this.#bounded(
            "wallet top-up construction",
            this.#opts.walletOperationTimeoutMs,
            () => this.#opts.buildTopUp!(gives, wants),
          ),
        );
      } catch (err) {
        // The wallet-backed builder does not expose a rollback handle here. A
        // throw may therefore have stranded local inputs; retain the claim.
        return quarantined({
          kind: "failed",
          offerHashes,
          reason: `top-up construction failed with unknown wallet state: ${Executor.#reason(err)}`,
        });
      }
    }

    const merged = this.#mergeFinalized(txs as any);

    // The batcher balances dust only — it never supplies counterparty tokens.
    // Handing it a merge with a non-dust imbalance would spend the makers'
    // inputs without delivering what they asked for. settleViaBatcher refuses
    // too; checking here turns a throw into a clean skip.
    //
    // An UNREADABLE imbalance is refused just as firmly as an unbalanced one:
    // the check not running is not evidence that it would have passed.
    let imbalance;
    try {
      imbalance = this.#nonDustImbalances(merged as any);
    } catch (err) {
      return {
        kind: "skipped",
        offerHashes,
        reason: `imbalance guard could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (imbalance.length > 0) {
      return {
        kind: "skipped",
        offerHashes,
        reason: `merge is not a complete swap: ${this.#describeImbalances(merged as any)}`,
      };
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= BATCHER_ATTEMPTS; attempt++) {
      const res = await this.#bounded(
        "batcher settlement",
        this.#opts.batcherTimeoutMs,
        () => this.#settleViaBatcher(merged as any, {
          level: "wait-receipt",
          timeoutMs: this.#opts.batcherTimeoutMs,
          serverTimeoutMs: this.#opts.batcherTimeoutMs,
        }),
      ).catch((err) => ({
        ok: false,
        status: 0,
        body: Executor.#reason(err),
      }));
      if (res.ok) break;

      lastReason = `batcher ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`;
      // 429 is emitted before admission by the batcher's rate limiter. Every
      // other failure class (transport/timeout/5xx/malformed or unbound 2xx)
      // may have crossed the acceptance boundary and must retain the claim.
      const ambiguousSubmission = res.status !== 429;
      const finishFailure = <T extends MatchDecision>(outcome: T): MaybeExecutionResult<T> =>
        ambiguousSubmission ? quarantined(outcome) : releasable(outcome);
      // Retrying requires positive evidence that every member remains live.
      // Consumed is terminal, not a retry state; an unknown state is likewise
      // not permission to submit again.
      for (const offer of offers) {
        const observed = await this.#status(offer.offerHash);
        if (observed.kind === "unknown") {
          return finishFailure({
            kind: "failed",
            offerHashes,
            reason:
              `${lastReason}; ${offer.offerHash.slice(0, 10)} status unknown: ` +
              observed.reason,
          });
        }
        if (observed.status === "consumed") {
          return finishFailure({
            kind: "failed",
            offerHashes,
            reason:
              `${lastReason}; ${offer.offerHash.slice(0, 10)} is consumed; ` +
              "refusing an unbound duplicate submission",
          });
        }
        if (observed.status !== "live") {
          return finishFailure({
            kind: "skipped",
            offerHashes,
            reason: `${offer.offerHash.slice(0, 10)} is ${observed.status}`,
          });
        }
      }

      // Without a stable submission identity, a transport failure or 5xx may
      // mean the batcher accepted the transaction and lost the response. The
      // only retry retained here is an explicit rate-limit rejection while all
      // members are still authoritatively live.
      if (res.status !== 429) {
        return quarantined({
          kind: "failed",
          offerHashes,
          reason: `${lastReason}; response is not safely retryable without an idempotency key`,
        });
      }
      if (attempt === BATCHER_ATTEMPTS) return { kind: "failed", offerHashes, reason: lastReason };
      this.#log(`[solver] batcher attempt ${attempt} failed: ${lastReason}`);
      await new Promise((r) => setTimeout(r, this.#opts.statusPollMs * attempt));
    }

    // The whole set settles atomically, so one member reaching consumed is the
    // settlement; the rest are confirmed for completeness.
    for (const offerHash of offerHashes) {
      const confirmed = await this.#confirm(offerHash);
      if (confirmed.kind !== "known" || confirmed.status !== "consumed") {
        const reason = confirmed.kind === "known" ? confirmed.status : confirmed.reason;
        return quarantined({
          kind: "failed",
          offerHashes,
          reason: `${offerHash.slice(0, 10)} ${reason} after settle`,
        });
      }
    }
    return { kind: "settled", offerHashes };
  }

  async #getOfferBlob(offerHash: string): Promise<string> {
    const detail = await this.#bounded(
      `offer detail ${offerHash.slice(0, 10)}`,
      this.#opts.requestTimeoutMs,
      () => this.#apiClient.getZswapByHash(offerHash, {
        api: this.#opts.api,
        timeoutMs: this.#opts.requestTimeoutMs,
      }),
    );
    return detail.offerBech32;
  }

  async #status(
    offerHash: string,
    timeoutMs = this.#opts.requestTimeoutMs,
  ): Promise<StatusObservation> {
    const boundedTimeout = Math.max(1, Math.min(timeoutMs, this.#opts.requestTimeoutMs));
    try {
      const result = await this.#bounded(
        `offer status ${offerHash.slice(0, 10)}`,
        boundedTimeout,
        () => this.#apiClient.getOfferStatus(offerHash, {
          api: this.#opts.api,
          timeoutMs: boundedTimeout,
        }),
      );
      return { kind: "known", status: result.status };
    } catch (err) {
      return { kind: "unknown", reason: Executor.#reason(err) };
    }
  }

  async #runFill(offer: BookOffer): Promise<MaybeExecutionResult<FillDecision>> {
    const { offerHash } = offer;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.#opts.isReady?.() === false) {
        return {
          kind: "skipped",
          offerHash,
          reason: "solver inventory became unready before execution",
        };
      }
      // Re-check at dequeue time, not admission time: the queue wait may have
      // straddled someone else's fill or the offer's expiry.
      const now = this.#opts.nowMs?.() ?? Date.now();
      if (
        offer.expiresAt === null ||
        !Number.isFinite(offer.expiresAt) ||
        now >= offer.expiresAt - this.#opts.expiryMarginSeconds * 1000
      ) {
        return {
          kind: "skipped",
          offerHash,
          reason: "inside the settlement expiry margin at dequeue",
        };
      }
      const observed = await this.#status(offerHash);
      if (observed.kind === "unknown") {
        return {
          kind: "failed",
          offerHash,
          reason: `status unknown before wallet mutation: ${observed.reason}`,
        };
      }
      if (observed.status !== "live") {
        return { kind: "skipped", offerHash, reason: `no longer live (${observed.status})` };
      }

      let offerTx: unknown;
      try {
        const blob = offer.blob ?? (await this.#getOfferBlob(offerHash));
        this.#assertOfferBlobIdentity(blob, offerHash);
        offerTx = this.#apiClient.reconstructOffer(blob);
      } catch (err) {
        return {
          kind: "failed",
          offerHash,
          reason: `offer reconstruction failed before wallet mutation: ${Executor.#reason(err)}`,
        };
      }
      const mismatch = this.#validateOfferSemantics(offer, offerTx);
      if (mismatch !== null) {
        return {
          kind: "failed",
          offerHash,
          reason: `reconstructed offer does not match listed economics: ${mismatch}`,
        };
      }

      let recipe: unknown;
      let submitStarted = false;
      try {
        recipe = await this.#bounded(
          "wallet balance transaction",
          this.#opts.walletOperationTimeoutMs,
          () => this.#opts.wallet.balanceFinalizedTransaction(offerTx, this.#opts.keys, {
            ttl: new Date(Date.now() + this.#opts.settleTtlMinutes * 60_000),
          }),
        );
        const settleTx = await this.#bounded(
          "wallet finalize recipe",
          this.#opts.walletOperationTimeoutMs,
          () => this.#opts.wallet.finalizeRecipe(recipe),
        );
        let imbalance;
        try {
          imbalance = this.#nonDustImbalances(settleTx as any);
        } catch (err) {
          const reason = `settlement imbalance guard could not run: ${Executor.#reason(err)}`;
          const reverted = await this.#revert(recipe, offerHash);
          if (!reverted.ok) {
            return quarantined({
              kind: "failed",
              offerHash,
              reason: `${reason}; ${reverted.reason}; refusing retry`,
            });
          }
          return { kind: "failed", offerHash, reason };
        }
        if (imbalance.length > 0) {
          const reason =
            `settlement is not a complete swap: ${this.#describeImbalances(settleTx as any)}`;
          const reverted = await this.#revert(recipe, offerHash);
          if (!reverted.ok) {
            return quarantined({
              kind: "failed",
              offerHash,
              reason: `${reason}; ${reverted.reason}; refusing retry`,
            });
          }
          return { kind: "skipped", offerHash, reason };
        }
        // Once this call starts, a thrown transport response is ambiguous: the
        // ledger may have accepted the transaction. Never rebuild/re-submit the
        // same offer without first observing a terminal state.
        submitStarted = true;
        await this.#bounded(
          "wallet submit transaction",
          this.#opts.walletOperationTimeoutMs,
          () => this.#opts.wallet.submitTransaction(settleTx),
        );
      } catch (err) {
        const reason = Executor.#reason(err);

        if (submitStarted) {
          const reconciled = await this.#confirm(offerHash);
          if (reconciled.kind === "known" && reconciled.status === "consumed") {
            return { kind: "settled", offerHash };
          }
          const reconciliationReason =
            reconciled.kind === "known" ? reconciled.status : reconciled.reason;
          return quarantined({
            kind: "failed",
            offerHash,
            reason:
              `${reason}; submission outcome remains unknown (${reconciliationReason}); ` +
              "refusing duplicate submission",
          });
        }

        if (err instanceof OperationBoundaryError) {
          // Timeout/shutdown is not a cancellation acknowledgement. The
          // balance/finalize promise may still lock or finalize inputs after
          // this branch returns, so reverting concurrently would be unsafe.
          return quarantined({
            kind: "failed",
            offerHash,
            reason: `${reason}; wallet operation may still be running`,
          });
        }

        // Failures before submit are locally reversible and may be retried only
        // after an authoritative live observation.
        const reverted = await this.#revert(recipe, offerHash);
        if (!reverted.ok) {
          return quarantined({
            kind: "failed",
            offerHash,
            reason: `${reason}; ${reverted.reason}; refusing retry`,
          });
        }
        const after = await this.#status(offerHash);
        if (after.kind === "unknown") {
          return {
            kind: "failed",
            offerHash,
            reason: `${reason}; status unknown after revert: ${after.reason}`,
          };
        }
        if (after.status !== "live") {
          return { kind: "skipped", offerHash, reason: `${after.status} during settlement` };
        }
        if (attempt === MAX_ATTEMPTS) {
          return { kind: "failed", offerHash, reason };
        }
        this.#log(`[solver] fill ${offerHash.slice(0, 10)} attempt ${attempt} failed: ${reason}`);
        continue;
      }

      const confirmed = await this.#confirm(offerHash);
      if (confirmed.kind === "known" && confirmed.status === "consumed") {
        return { kind: "settled", offerHash };
      }
      const reason = confirmed.kind === "known" ? confirmed.status : confirmed.reason;
      // After submitTransaction begins, no non-consumed offer classification
      // proves this exact transaction was rejected. Expiry/cancellation may race
      // an accepted transaction and status carries no submitted transaction ID.
      // Reverting or releasing here could double-spend local inputs or admit a
      // duplicate; only durable identity-bound reconciliation may do so later.
      return quarantined({
        kind: "failed",
        offerHash,
        reason: `submitted but ${reason}; capacity quarantined pending durable reconciliation`,
      });
    }

    return { kind: "failed", offerHash, reason: "retries exhausted" };
  }

  async #revert(recipe: unknown, offerHash: string): Promise<RevertResult> {
    if (!recipe) return { ok: true };
    if (!this.#opts.wallet.revert) {
      const reason = "wallet exposes no revert operation; inventory may be stranded";
      this.#log(`[solver] revert unavailable for ${offerHash.slice(0, 10)} — ${reason}`);
      return { ok: false, reason };
    }
    try {
      await this.#bounded(
        `wallet revert ${offerHash.slice(0, 10)}`,
        this.#opts.walletOperationTimeoutMs,
        () => this.#opts.wallet.revert!(recipe),
      );
      return { ok: true };
    } catch (err) {
      // Nothing else can free those coins; the next balance attempt will fail
      // for want of funds, so make the cause visible rather than silent.
      const reason = `wallet revert failed; inventory may be stranded: ${Executor.#reason(err)}`;
      this.#log(`[solver] revert failed for ${offerHash.slice(0, 10)} — ${reason}`);
      return { ok: false, reason };
    }
  }

  /** Wait for the chain to show the offer consumed, preferring the event the
   *  sync layer delivers and falling back to polling. */
  async #confirm(offerHash: string): Promise<Confirmation> {
    const deadline = Date.now() + this.#opts.confirmTimeoutMs;

    let wakeOnEvent!: () => void;
    let consumptionEvent = new Promise<void>((resolve) => {
      wakeOnEvent = resolve;
    });
    // An archive event is only a wake-up hint. It may represent maker cancel,
    // expiry, or settlement; the bound REST status below remains authoritative.
    this.#awaitingConsumption.set(offerHash, () => wakeOnEvent());

    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            kind: "timeout",
            reason: `confirmation timed out after ${this.#opts.confirmTimeoutMs} ms`,
          };
        }

        const observed = await this.#status(offerHash, remaining);
        if (observed.kind === "unknown") {
          if (Date.now() >= deadline) {
            return {
              kind: "timeout",
              reason: `confirmation timed out after ${this.#opts.confirmTimeoutMs} ms`,
            };
          }
          return observed;
        }
        if (observed.status !== "live") return observed;

        const waitMs = Math.max(0, Math.min(this.#opts.statusPollMs, deadline - Date.now()));
        const sawArchiveEvent = await Promise.race([
          consumptionEvent.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs)),
        ]);
        if (sawArchiveEvent) {
          // Re-arm before polling so another archive signal cannot be lost
          // while the finite status request is in flight.
          consumptionEvent = new Promise<void>((resolve) => {
            wakeOnEvent = resolve;
          });
        }
      }
    } finally {
      this.#awaitingConsumption.delete(offerHash);
    }
  }
}
