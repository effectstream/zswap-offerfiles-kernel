// Solver orchestration. Exported as `runSolver` so an e2e can own its lifecycle
// instead of shelling out to an entrypoint.

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { buildWallet, shieldedBalances, shieldedKeys, waitForSync } from "@zswap-da/solver-core/wallet";

import {
  isCyclesEnabled,
  isDryRun,
  isLevelsPublicationEnabled,
  isPathBEnabled,
  isResidualTopUpsEnabled,
  SOLVER_EXPIRY_MARGIN_SECONDS,
  SOLVER_LADDER_CONFIG,
  SOLVER_LEVELS_AUTH_TOKEN,
  SOLVER_LEVELS_PUSH_INTERVAL_MS,
  SOLVER_MAX_CYCLE_LEN,
  SOLVER_RESYNC_INTERVAL_MS,
  SOLVER_SEED,
  SOLVER_SETTLE_TTL_MINUTES,
  SOLVER_STATUS_POLL_MS,
  ZSWAP_API,
} from "../env.ts";
import { Book, type BookOffer } from "./book.ts";
import { loadLadderConfig, type LoadedLadders } from "./config.ts";
import { findCandidates, type Candidate, type EngineConfig } from "./engine.ts";
import { Executor, type FillOutcome, type MatchOutcome } from "./executor.ts";
import {
  shouldPublishLevels,
  startLevelsPush,
  type LevelsPushHandle,
  validateLevelsAuthToken,
} from "./levels-push.ts";
import { startBookSync, type BookChange, type SyncHandle } from "./sse-sync.ts";
import { Stock } from "./stock.ts";

export interface SolverOptions {
  /** Cancels startup acquisition. Once a handle is returned, callers own
   * shutdown through `SolverHandle.stop()`. */
  signal?: AbortSignal;
  /** Defaults to SOLVER_LADDER_CONFIG. */
  ladderConfigPath?: string;
  /** Defaults to ZSWAP_API. */
  api?: string;
  /** Mirror without building or submitting a transaction. Defaults to
   * SOLVER_DRY_RUN. Current dry-run intentionally opens no wallet, so its empty
   * Stock is not Path-A admission parity; tracked by release gate R-18. */
  dryRun?: boolean;
  seed?: string;
  resyncIntervalMs?: number;
  expiryMarginSeconds?: number;
  maxCycleLen?: number;
  enableCycles?: boolean;
  enablePathB?: boolean;
  enableResidualTopUps?: boolean;
  /** Authenticated quote publication is independent from execution and
   * defaults off. Enabling it requires levelsAuthToken. */
  enableLevelsPublication?: boolean;
  levelsAuthToken?: string;
  levelsPushIntervalMs?: number;
  /** Deadline applied to wallet build/sync/first balance and, separately, to
   * the initial authoritative book snapshot plus buffered SSE drain. */
  startupTimeoutMs?: number;
  /** Deadline for proving/wallet mutations and balance reads. */
  walletOperationTimeoutMs?: number;
  /** Retry interval while authoritative inventory is globally unready. */
  balanceRefreshRetryMs?: number;
  /** Whole shutdown deadline, including wallet stop. */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
  onOutcome?: (outcome: FillOutcome) => void;
  onMatchOutcome?: (outcome: MatchOutcome) => void;
}

export interface SolverHandle {
  readonly ladders: LoadedLadders;
  readonly book: Book;
  readonly stock: Stock;
  /** Resolves once the first full page-through and buffered gap are applied;
   * rejects at the configured terminal startup deadline. */
  ready: Promise<void>;
  /** Resolves when nothing is queued or in flight — for tests that must not
   *  race a settlement. */
  idle: () => Promise<void>;
  stop: () => Promise<void>;
}

const describeOffer = (offer: BookOffer): string => {
  const leg = (l: { token: string; amount: bigint }) => `${l.amount} ${l.token.slice(0, 8)}`;
  return `${offer.offerHash.slice(0, 10)} gives ${offer.gives.map(leg).join("+")} ` +
    `wants ${offer.wants.map(leg).join("+")}`;
};

export interface BookReadyDecisionGate {
  /** Coalesce a change into the next decision, but only after readiness. */
  request: () => void;
  /** Open the gate and schedule exactly one decision over the complete book. */
  markReady: () => void;
  /** Permanently close the gate, including an already queued microtask. */
  stop: () => void;
}

/** Keep partial snapshot rows from reaching the executor. `startBookSync`
 * intentionally emits diffs while it builds the initial book; execution starts
 * only after snapshot plus the complete buffered SSE gap reaches readiness. */
export function createBookReadyDecisionGate(
  decide: () => void,
  canDecide: () => boolean = () => true,
): BookReadyDecisionGate {
  let ready = false;
  let stopped = false;
  let queued = false;

  const request = (): void => {
    if (!ready || stopped || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!stopped && ready && canDecide()) decide();
    });
  };

  return {
    request,
    markReady: () => {
      if (ready || stopped) return;
      ready = true;
      request();
    },
    stop: () => {
      stopped = true;
    },
  };
}

type Balances = Record<string, bigint> | Map<string, bigint>;

export interface InventoryRefreshController {
  refresh: (signal?: AbortSignal) => Promise<void>;
  isReady: () => boolean;
  isRefreshing: () => boolean;
  /** Balance reads that ignored supersession/stop and are still observed in
   * memory. They cannot install Stock, but may still own SDK resources. */
  retainedOperations: () => number;
  stop: () => void;
}

interface InventoryRefreshOptions {
  stock: Stock;
  readBalances: (signal: AbortSignal) => Promise<Balances>;
  onReadinessChange?: (ready: boolean) => void;
}

const asError = (reason: unknown, fallback: string): Error =>
  reason instanceof Error ? reason : new Error(reason === undefined ? fallback : String(reason));

/** Own asynchronous balance reads by generation. Superseded, timed-out, or
 * stopped reads can resolve late but can never reinstall stale inventory. The
 * visible Stock is emptied for the whole read/failure window, which makes both
 * execution admission and levels publication fail closed. */
export function createInventoryRefreshController(
  opts: InventoryRefreshOptions,
): InventoryRefreshController {
  let generation = 0;
  let ready = false;
  let stopped = false;
  let active: AbortController | null = null;
  const retainedReads = new Set<Promise<Balances>>();

  const notify = (next: boolean): void => {
    ready = next;
    try {
      opts.onReadinessChange?.(next);
    } catch {
      // Readiness diagnostics/observers cannot own inventory state.
    }
  };
  const withdraw = (): void => {
    opts.stock.setBalances({});
    notify(false);
  };

  return {
    isReady: () => ready && !stopped,
    isRefreshing: () => active !== null,
    retainedOperations: () => retainedReads.size,
    refresh: async (outerSignal?: AbortSignal): Promise<void> => {
      if (stopped) throw new Error("inventory refresh controller is stopped");

      const id = ++generation;
      active?.abort(new Error("inventory refresh superseded by a newer generation"));
      const owner = new AbortController();
      active = owner;
      const abortForOuter = (): void => owner.abort(outerSignal?.reason);
      if (outerSignal?.aborted) abortForOuter();
      else outerSignal?.addEventListener("abort", abortForOuter, { once: true });
      withdraw();

      let removeAbortWait = (): void => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void => {
          reject(asError(owner.signal.reason, "inventory refresh aborted"));
        };
        removeAbortWait = () => owner.signal.removeEventListener("abort", rejectAbort);
        if (owner.signal.aborted) rejectAbort();
        else owner.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      void aborted.catch(() => {});
      const read = Promise.resolve().then(() => opts.readBalances(owner.signal));
      retainedReads.add(read);
      void read.then(
        () => retainedReads.delete(read),
        () => retainedReads.delete(read),
      );

      try {
        const balances = await Promise.race([read, aborted]);
        if (stopped || id !== generation || owner.signal.aborted) {
          throw asError(owner.signal.reason, "inventory refresh superseded");
        }
        opts.stock.setBalances(balances);
        notify(true);
      } catch (err) {
        if (id === generation && !stopped) withdraw();
        throw err;
      } finally {
        removeAbortWait();
        outerSignal?.removeEventListener("abort", abortForOuter);
        if (active === owner) active = null;
      }
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      generation++;
      active?.abort(new Error("inventory refresh controller stopped"));
      active = null;
      withdraw();
    },
  };
}

interface OwnedStartupOptions<T> {
  build: () => Promise<T>;
  initialize: (resource: T, signal: AbortSignal) => Promise<void>;
  cleanup: (resource: T) => Promise<void>;
  startupTimeoutMs: number;
  cleanupTimeoutMs: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const observe = (promise: Promise<unknown>): void => {
  void promise.catch(() => {});
};

async function cleanupWithin<T>(
  resource: T,
  timeoutMs: number,
  cleanup: (resource: T) => Promise<void>,
): Promise<boolean> {
  const task = Promise.resolve().then(() => cleanup(resource));
  observe(task);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bound startup even before a wallet owner exists. If build resolves after
 * the deadline, its late resource is still observed and best-effort stopped;
 * if sync/initial refresh fails, the already-built wallet is stopped before
 * the rejection returns (within its own cleanup deadline). */
export async function initializeOwnedResource<T>(opts: OwnedStartupOptions<T>): Promise<T> {
  for (const [name, value] of [
    ["startupTimeoutMs", opts.startupTimeoutMs],
    ["cleanupTimeoutMs", opts.cleanupTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer, got ${value}`);
    }
  }

  const owner = new AbortController();
  const abortForOuter = (): void => {
    owner.abort(asError(opts.signal?.reason, "solver startup aborted"));
  };
  if (opts.signal?.aborted) abortForOuter();
  else opts.signal?.addEventListener("abort", abortForOuter, { once: true });

  let removeAbortWait = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(asError(owner.signal.reason, "solver startup aborted"));
    };
    removeAbortWait = () => owner.signal.removeEventListener("abort", rejectAbort);
    if (owner.signal.aborted) rejectAbort();
    else owner.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  observe(aborted);

  if (owner.signal.aborted) {
    opts.signal?.removeEventListener("abort", abortForOuter);
    removeAbortWait();
    throw asError(owner.signal.reason, "solver startup aborted");
  }

  const build = Promise.resolve().then(opts.build);
  observe(build);
  let resource: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`solver wallet startup timed out after ${opts.startupTimeoutMs} ms`);
      owner.abort(error);
      reject(error);
    }, opts.startupTimeoutMs);
  });
  observe(deadline);

  try {
    resource = await Promise.race([build, deadline, aborted]);
    const initialization = Promise.resolve().then(() => opts.initialize(resource!, owner.signal));
    observe(initialization);
    await Promise.race([initialization, deadline, aborted]);
    if (owner.signal.aborted) {
      throw asError(owner.signal.reason, "solver startup aborted");
    }
    return resource;
  } catch (err) {
    owner.abort(err);
    if (resource !== undefined) {
      const cleaned = await cleanupWithin(resource, opts.cleanupTimeoutMs, opts.cleanup);
      if (!cleaned) {
        try {
          opts.log?.("[solver] wallet startup cleanup did not complete before its deadline");
        } catch {
          // Diagnostic only.
        }
      }
    } else {
      // Build can ignore our deadline. Take ownership if it eventually resolves
      // and clean it without keeping startup or the process alive.
      void build.then(async (lateResource) => {
        await cleanupWithin(lateResource, opts.cleanupTimeoutMs, opts.cleanup);
      }, () => {});
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abortForOuter);
    removeAbortWait();
  }
}

/** Observe the readiness promise internally so stop-before-ready rejection does
 * not become an unhandled process error. Callers still receive the same promise
 * on SolverHandle.ready and may observe the rejection themselves. */
export function armBookReadyDecisionGate(
  ready: Promise<void>,
  gate: BookReadyDecisionGate,
): void {
  void ready.then(
    () => gate.markReady(),
    () => {},
  );
}

export async function runSolver(opts: SolverOptions = {}): Promise<SolverHandle> {
  const api = opts.api ?? ZSWAP_API;
  const dryRun = opts.dryRun ?? isDryRun();
  const enableCycles = opts.enableCycles ?? isCyclesEnabled();
  const enablePathB = opts.enablePathB ?? isPathBEnabled();
  const enableResidualTopUps = opts.enableResidualTopUps ?? isResidualTopUpsEnabled();
  const enableLevelsPublication =
    opts.enableLevelsPublication ?? isLevelsPublicationEnabled();
  const levelsAuthToken = opts.levelsAuthToken ?? SOLVER_LEVELS_AUTH_TOKEN;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 180_000;
  const walletOperationTimeoutMs = opts.walletOperationTimeoutMs ?? 240_000;
  const balanceRefreshRetryMs = opts.balanceRefreshRetryMs ?? 5_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 15_000;
  for (const [name, value] of [
    ["startupTimeoutMs", startupTimeoutMs],
    ["walletOperationTimeoutMs", walletOperationTimeoutMs],
    ["balanceRefreshRetryMs", balanceRefreshRetryMs],
    ["stopTimeoutMs", stopTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer, got ${value}`);
    }
  }
  const publishLevels = shouldPublishLevels(dryRun, enableLevelsPublication);
  if (publishLevels) validateLevelsAuthToken(levelsAuthToken);
  const rawLog = opts.log ?? ((msg: string) => console.log(msg));
  const log = (message: string): void => {
    try {
      rawLog(message);
    } catch {
      // Diagnostics cannot own readiness, execution, or shutdown lifecycle.
    }
  };
  if (opts.signal?.aborted) {
    throw asError(opts.signal.reason, "solver startup aborted");
  }
  const ladders = await loadLadderConfig(opts.ladderConfigPath ?? SOLVER_LADDER_CONFIG);
  if (opts.signal?.aborted) {
    throw asError(opts.signal.reason, "solver startup aborted");
  }
  const stock = new Stock();

  log(
    `[solver] network=${net.id} api=${api}${dryRun ? " DRY-RUN (no transactions)" : ""} ` +
      `path-b=${enablePathB ? "on" : "off"} cycles=${enableCycles ? "on" : "off"} ` +
      `residual-topups=${enableResidualTopUps ? "on" : "off"} ` +
      `levels-publication=${publishLevels ? "on" : "off"}`,
  );
  for (const pair of ladders.ladders.pairs()) {
    const top = pair.levels[pair.levels.length - 1];
    log(
      `[solver] posting ${pair.tokenIn.slice(0, 8)}→${pair.tokenOut.slice(0, 8)} ` +
        `${pair.levels.length} rungs, up to ${top.input} in / ${top.output} out`,
    );
  }

  type SolverWallet = Awaited<ReturnType<typeof buildWallet>>;
  let wallet: SolverWallet | null = null;
  let balanceWallet: SolverWallet | null = null;
  let executor: Executor | null = null;
  let inventoryChanged = (_ready: boolean): void => {};
  let withdrawalBarrier: Promise<void> = Promise.resolve();
  const inventory = createInventoryRefreshController({
    stock,
    readBalances: async (signal) => {
      // If publication was already in flight when inventory became unknown,
      // wait for its coalesced empty snapshot attempt before installing a new
      // ready balance. This prevents a fast recovery from overtaking its own
      // withdrawal on the wire.
      await withdrawalBarrier;
      if (signal.aborted) throw asError(signal.reason, "inventory refresh aborted");
      if (!balanceWallet) throw new Error("wallet is unavailable for inventory refresh");
      return shieldedBalances(balanceWallet);
    },
    onReadinessChange: (ready) => inventoryChanged(ready),
  });
  const refreshBalances = (signal: AbortSignal): Promise<void> => inventory.refresh(signal);

  if (!dryRun) {
    try {
      wallet = await initializeOwnedResource<SolverWallet>({
        build: () => buildWallet(opts.seed ?? SOLVER_SEED),
        initialize: async (owned, signal) => {
          balanceWallet = owned;
          await waitForSync(owned, { timeoutMs: startupTimeoutMs });
          if (signal.aborted) throw asError(signal.reason, "wallet startup aborted");
          await inventory.refresh(signal);
        },
        cleanup: async (owned) => {
          await (owned.wallet as any)?.stop?.();
        },
        startupTimeoutMs,
        cleanupTimeoutMs: stopTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        log,
      });
    } catch (err) {
      inventory.stop();
      balanceWallet = null;
      throw err;
    }
    log(
      `[solver] inventory: ` +
        stock.tokens().map((t) => `${t.slice(0, 8)}=${stock.balance(t)}`).join(" ") || "[solver] inventory: empty",
    );
    const solverWallet = wallet;
    // The solver's half of a non-exact merge. Same shape as a maker's offer —
    // unbalanced alone, balanced once merged — and it pays no dust, because the
    // batcher covers the whole merged transaction.
    const buildTopUp = async (
      gives: Map<string, bigint>,
      wants: Map<string, bigint>,
    ): Promise<unknown> => {
      const address = await (solverWallet.wallet as any).shielded.getAddress();
      const recipe = await (solverWallet.wallet as any).initSwap(
        { shielded: Object.fromEntries(gives) },
        wants.size === 0
          ? []
          : [
              {
                type: "shielded",
                outputs: [...wants].map(([token, amount]) => ({
                  type: token,
                  amount,
                  receiverAddress: address,
                })),
              },
            ],
        shieldedKeys(solverWallet),
        { ttl: new Date(Date.now() + SOLVER_SETTLE_TTL_MINUTES * 60_000), payFees: false },
      );
      return (solverWallet.wallet as any).finalizeTransaction(recipe.transaction);
    };

    executor = new Executor({
      wallet: wallet.wallet as any,
      keys: shieldedKeys(wallet),
      stock,
      ...(opts.api ? { api: opts.api } : {}),
      settleTtlMinutes: SOLVER_SETTLE_TTL_MINUTES,
      statusPollMs: SOLVER_STATUS_POLL_MS,
      expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
      readinessTimeoutMs: startupTimeoutMs,
      walletOperationTimeoutMs,
      refreshBalances,
      isReady: inventory.isReady,
      ...(enableResidualTopUps ? { buildTopUp } : {}),
      log,
      onOutcome: (outcome) => {
        const tag = outcome.kind === "settled" ? "FILLED" : outcome.kind.toUpperCase();
        log(
          `[solver] ${tag} ${outcome.offerHash.slice(0, 10)}` +
            ("reason" in outcome ? ` — ${outcome.reason}` : ""),
        );
        if (outcome.claimDisposition === "release") {
          requestDecision();
        } else {
          log(
            `[solver] QUARANTINED ${outcome.offerHash.slice(0, 10)} — ` +
              "capacity remains reserved pending durable reconciliation",
          );
        }
        opts.onOutcome?.(outcome);
      },
      onMatchOutcome: (outcome) => {
        const tag = outcome.kind === "settled" ? "MATCHED" : outcome.kind.toUpperCase();
        log(
          `[solver] ${tag} ${outcome.offerHashes.map((h) => h.slice(0, 10)).join(" + ")}` +
            ("reason" in outcome ? ` — ${outcome.reason}` : ""),
        );
        if (outcome.claimDisposition === "release") {
          requestDecision();
        } else {
          log(
            `[solver] QUARANTINED ` +
              `${outcome.offerHashes.map((h) => h.slice(0, 10)).join(" + ")} — ` +
              "capacity remains reserved pending durable reconciliation",
          );
        }
        opts.onMatchOutcome?.(outcome);
      },
    });
  }

  const pending = new Set<Promise<unknown>>();
  // Owned here rather than left to startBookSync, so `decide` can read it
  // without closing over a binding declared later.
  const book = new Book();
  const engineConfig = (): EngineConfig => ({
    ladders: ladders.ladders,
    refPricesUsd: ladders.refPricesUsd,
    stock,
    expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
    maxCycleLen: opts.maxCycleLen ?? SOLVER_MAX_CYCLE_LEN,
    enablePathB,
    enableCycles,
    enableResidualTopUps,
  });

  const describeCandidate = (candidate: Candidate): string =>
    candidate.kind === "pathA"
      ? `(A) ${candidate.offers[0].offerHash.slice(0, 10)} at posted ${candidate.maxPay}`
      : `(B) ${candidate.offers.map((o) => o.offerHash.slice(0, 10)).join(" + ")}` +
        (candidate.payouts.size === 0 ? " exact crossing, no inventory" : "");

  const track = (task: Promise<unknown>): void => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };

  /** Re-decide over the whole book. Cheap: the engine is pure and the book is
   *  in memory, and it keeps a new arrival from being judged in isolation when
   *  it could cross with something already sitting there. */
  const decide = (): void => {
    const candidates = findCandidates(book, engineConfig(), Date.now());
    for (const candidate of candidates) {
      if (dryRun) {
        log(`[solver]     WOULD FILL ${describeCandidate(candidate)}`);
        continue;
      }
      log(`[solver]     FILL ${describeCandidate(candidate)}`);
      track(
        candidate.kind === "pathA"
          ? executor!.fill(candidate.offers[0], candidate.payouts)
          : executor!.settleMatch(candidate.offers, candidate.net),
      );
    }
  };

  const decisionGate = createBookReadyDecisionGate(
    decide,
    () => dryRun || inventory.isReady(),
  );

  // Events and terminal executor callbacks can arrive in the same turn. The
  // gate waits for the complete initial snapshot and coalesces later changes.
  function requestDecision(): void {
    decisionGate.request();
  }

  const onChange = (change: BookChange): void => {
    if (change.kind === "removed") {
      log(`[solver] − ${change.offerHash.slice(0, 10)} (${change.reason})`);
      if (change.reason === "consumed") executor?.notifyConsumed(change.offerHash);
      // A removal can unblock a lower-ranked candidate or dissolve a claimed
      // crossing choice. Re-evaluate the whole current book for every removal;
      // the gate coalesces duplicate/nullifier fan-out and pre-ready changes.
      requestDecision();
      return;
    }
    log(`[solver] + ${describeOffer(change.offer)}`);
    requestDecision();
  };

  let sync!: SyncHandle;
  let levels: LevelsPushHandle | null = null;
  try {
    sync = startBookSync({
      book,
      ...(opts.api ? { api: opts.api } : {}),
      resyncIntervalMs: opts.resyncIntervalMs ?? SOLVER_RESYNC_INTERVAL_MS,
      expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
      onChange,
      onError: (err) => log(`[solver] sync error: ${err instanceof Error ? err.message : String(err)}`),
      log,
    });
    armBookReadyDecisionGate(sync.ready, decisionGate);

    // A dry run must not advertise prices it will not honour.
    levels = publishLevels
      ? startLevelsPush({
          api,
          authToken: levelsAuthToken,
          ladders: ladders.ladders,
          stock,
          intervalMs: opts.levelsPushIntervalMs ?? SOLVER_LEVELS_PUSH_INTERVAL_MS,
          log,
        })
      : null;
  } catch (err) {
    decisionGate.stop();
    inventory.stop();
    const cleanups: Promise<boolean>[] = [];
    if (levels) cleanups.push(cleanupWithin(levels, stopTimeoutMs, (owned) => owned.stop()));
    if (sync) cleanups.push(cleanupWithin(sync, stopTimeoutMs, (owned) => owned.stop()));
    if (executor) {
      cleanups.push(cleanupWithin(executor, stopTimeoutMs, async (owned) => {
        await owned.stop(stopTimeoutMs);
      }));
    }
    if (wallet) {
      cleanups.push(cleanupWithin(wallet, stopTimeoutMs, async (owned) => {
        await (owned.wallet as any)?.stop?.();
      }));
    }
    await Promise.all(cleanups);
    balanceWallet = null;
    throw err;
  }

  // A failed/started refresh empties Stock, causing an immediate authenticated
  // withdrawal. A successful newer generation republishes and re-decides over
  // the current complete book. Both callbacks are non-authoritative.
  inventoryChanged = (ready): void => {
    if (levels) {
      const publication = levels.push();
      observe(publication);
      if (!ready) withdrawalBarrier = publication;
    }
    if (ready) requestDecision();
  };

  let recoveryRunning = false;
  const retryInventory = async (): Promise<void> => {
    if (dryRun || inventory.isReady() || inventory.isRefreshing() || recoveryRunning) return;
    recoveryRunning = true;
    const owner = new AbortController();
    const timer = setTimeout(() => {
      owner.abort(
        new Error(`balance refresh timed out after ${walletOperationTimeoutMs} ms`),
      );
    }, walletOperationTimeoutMs);
    try {
      await inventory.refresh(owner.signal);
      log("[solver] authoritative inventory readiness restored");
    } catch (err) {
      log(`[solver] inventory reconciliation failed: ${asError(err, "unknown error").message}`);
    } finally {
      clearTimeout(timer);
      recoveryRunning = false;
    }
  };
  const balanceRetryTimer = dryRun
    ? null
    : setInterval(() => {
        if (!inventory.isReady() && !inventory.isRefreshing()) observe(retryInventory());
      }, balanceRefreshRetryMs);
  balanceRetryTimer?.unref?.();

  const idle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  let stopPromise: Promise<void> | null = null;

  return {
    ladders,
    book: sync.book,
    stock,
    ready: sync.ready,
    idle,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      decisionGate.stop();
      if (balanceRetryTimer) clearInterval(balanceRetryTimer);
      inventory.stop();
      const retainedInventoryOperations = inventory.retainedOperations();
      if (retainedInventoryOperations > 0) {
        log(
          `[solver] shutdown retained ${retainedInventoryOperations} balance read(s) ` +
            "that ignored cancellation; late results cannot reinstall Stock",
        );
      }

      const ownedLevels = levels;
      const ownedWallet = wallet;
      const ownedExecutor = executor;
      const tasks: Promise<unknown>[] = [
        Promise.resolve().then(() => sync.stop()),
        Promise.resolve().then(() => ownedLevels?.stop()),
        Promise.resolve().then(async () => {
          const result = await ownedExecutor?.stop(stopTimeoutMs);
          if (result && (result.retainedClaims > 0 || result.retainedOperations > 0)) {
            log(
              `[solver] shutdown retained ${result.retainedClaims} in-memory claim(s) and ` +
                `${result.retainedOperations} operation handle(s); ` +
                "durable restart reconciliation is not implemented",
            );
          }
        }),
        Promise.resolve().then(() => (ownedWallet?.wallet as any)?.stop?.()),
      ];
      for (const task of tasks) observe(task);
      balanceWallet = null;
      levels = null;

      stopPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([
          Promise.allSettled(tasks).then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), stopTimeoutMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (!completed) {
          log(
            `[solver] stop deadline elapsed after ${stopTimeoutMs} ms; ` +
              "unacknowledged wallet work remains quarantined in memory only",
          );
        }
      })();
      return stopPromise;
    },
  };
}
