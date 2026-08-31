// Solver orchestration. Exported as `runSolver` so an e2e can own its lifecycle
// instead of shelling out to an entrypoint.

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { forwardAdmissionPolicy } from "@zswap-da/solver-core/admission-policy";
import { buildWallet, shieldedBalances, shieldedKeys, waitForSync } from "@zswap-da/solver-core/wallet";
import { MAX_EXACT_FILES_PER_READ } from "@zswap-da/solver-core/exact-files-contract";

import {
  isDryRun,
  loadRelayClientEnv,
  loadSolverAdmissionEnv,
  loadSolverFeeSizingTakerInputs,
  loadSolverRelayHttpEnv,
  loadSolverJournalEnv,
  parseSolverRelayHttpUrl,
  SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS,
  SOLVER_BACKEND_HEALTH_MAX_AGE_MS,
  SOLVER_EXPIRY_MARGIN_SECONDS,
  SOLVER_LADDER_CONFIG,
  SOLVER_RELAY_AUTH_TOKEN,
  SOLVER_RELAY_WS_URL,
  SOLVER_RESYNC_INTERVAL_MS,
  SOLVER_SEED,
  SOLVER_SETTLE_TTL_MINUTES,
  SOLVER_STATUS_POLL_MS,
  ZSWAP_API,
  type SolverAdmissionEnv,
} from "../env.ts";
import { startAdmissionWarnings, type AdmissionWarningTimers } from "./admission.ts";
import { SOLVER_NETWORK_IDS } from "./launch.ts";
import { Book, type BookOffer } from "./book.ts";
import { loadLadderConfig, type LoadedLadders } from "./config.ts";
import {
  startBookSync,
  type BookChange,
  type SyncDependencies,
  type SyncHandle,
} from "./book-sync.ts";
import { Stock } from "./stock.ts";
import {
  SolverOperationJournal,
  type SolverOperationJournalOptions,
} from "./operation-journal.ts";
import {
  startRelayClient,
  type CreateRelayWebSocket,
  type RelayClientHandle,
  type RelayClientTimers,
} from "./relay-client.ts";
import {
  startSwapJobExecutor,
  type SwapJobDependencies,
  type SwapJobExecutorHandle,
  type SwapJobTimers,
} from "./swap-job-executor.ts";

export interface SolverWalletDependencies {
  buildWallet: typeof buildWallet;
  waitForSync: typeof waitForSync;
  shieldedBalances: typeof shieldedBalances;
  shieldedKeys: typeof shieldedKeys;
}

const DEFAULT_WALLET_DEPENDENCIES: SolverWalletDependencies = {
  buildWallet,
  waitForSync,
  shieldedBalances,
  shieldedKeys,
};

export interface SolverOptions {
  /** Cancels startup acquisition. Once a handle is returned, callers own
   * shutdown through `SolverHandle.stop()`. */
  signal?: AbortSignal;
  /** Defaults to SOLVER_LADDER_CONFIG. */
  ladderConfigPath?: string;
  /** Defaults to ZSWAP_API. */
  api?: string;
  /** Read-only mirror and real inventory without starting relay jobs. */
  dryRun?: boolean;
  /** Explicit test-only escape hatch lacking Path-A inventory parity. */
  dryRunWalletMode?: "real" | "skip-test-only";
  seed?: string;
  resyncIntervalMs?: number;
  backendHealthCheckIntervalMs?: number;
  backendHealthMaxAgeMs?: number;
  expiryMarginSeconds?: number;
  /** R2 relay boundary. Live mode requires both; dry-run deliberately starts
   * neither the wallet job executor nor the relay client. */
  relayUrl?: string;
  /** Explicit HTTP base for GET /jobs/:jobId. Never derived from relayUrl. */
  relayHttpUrl?: string;
  relayAuthToken?: string;
  relayPushIntervalMs?: number;
  relayReconnectDelayMs?: number;
  relayConnectTimeoutMs?: number;
  relayWithdrawTimeoutMs?: number;
  maxParallelSwaps?: number;
  jobSweepIntervalMs?: number;
  /** Deterministic boundary seams for lifecycle/integration tests. Production
   * entrypoints never provide these. */
  syncDependencies?: SyncDependencies;
  walletDependencies?: SolverWalletDependencies;
  relayCreateWebSocket?: CreateRelayWebSocket;
  relayTimers?: RelayClientTimers;
  jobTimers?: SwapJobTimers;
  jobDependencies?: Partial<SwapJobDependencies>;
  /** Explicit harness seam. Production omits this and must provide the
   * mandatory SOLVER_JOURNAL_PATH environment boundary. */
  journalOptions?: SolverOperationJournalOptions;
  journalOpen?: typeof SolverOperationJournal.open;
  admission?: SolverAdmissionEnv;
  /** 00006 FR-001. Defaults to SOLVER_FEE_SIZING_TAKER_INPUTS (1). */
  feeSizingTakerInputs?: number;
  admissionWarningTimers?: AdmissionWarningTimers;
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
}

export interface SolverHandle {
  readonly ladders: LoadedLadders;
  readonly book: Book;
  /** Compatibility alias. R2 removed pre-match validation; settlement bytes
   * come only from the job-time exact-files read. */
  readonly validatedBook: Book;
  readonly stock: Stock;
  /** Resolves only after a fresh backend-current generation has closed the
   * snapshot/SSE gap and (outside dry-run) authoritative inventory has
   * refreshed. */
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
  /** Immediately revoke executable/published balance authority and supersede
   * an in-flight read. Retained late reads remain observed but cannot install. */
  invalidate: (reason?: unknown) => void;
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
 * execution admission fails closed. */
export function createInventoryRefreshController(
  opts: InventoryRefreshOptions,
): InventoryRefreshController {
  let generation = 0;
  let ready = false;
  let stopped = false;
  let active: AbortController | null = null;
  const retainedReads = new Set<Promise<Balances>>();

  const notify = (next: boolean): void => {
    if (ready === next) return;
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
    invalidate: (reason = new Error("inventory authority invalidated")): void => {
      if (stopped) return;
      generation++;
      active?.abort(reason);
      active = null;
      withdraw();
    },
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
  const walletDependencies = opts.walletDependencies ?? DEFAULT_WALLET_DEPENDENCIES;
  const api = opts.api ?? ZSWAP_API;
  const dryRun = opts.dryRun ?? isDryRun();
  const dryRunWalletMode = opts.dryRunWalletMode ?? "real";
  if (!dryRun && dryRunWalletMode !== "real") {
    throw new Error("dryRunWalletMode=skip-test-only is valid only in dry-run");
  }
  const walletRequired = !dryRun || dryRunWalletMode === "real";
  const admission = opts.admission ?? loadSolverAdmissionEnv();
  const feeSizingTakerInputs = opts.feeSizingTakerInputs ?? loadSolverFeeSizingTakerInputs();
  // 00006 FR-001. `net.id` is the SINGLE source the wallet facade
  // (`solver-core/wallet.ts` → `buildWalletFacade(…, net.id)`) and the fee-sizing
  // stand-in both read, so they cannot disagree — but an unrecognized value is
  // still a misconfiguration, and the ledger accepts ANY string as a network id
  // and only refuses at merge time. Assert it here so every entrypoint fails at
  // boot with one message instead of refusing each job as
  // `wallet_build_failed`. `start:solver` checks the same thing earlier and more
  // loudly; direct `runSolver` callers (solver.dev.ts, e2e harnesses) get it here.
  if (!(SOLVER_NETWORK_IDS as readonly string[]).includes(net.id)) {
    throw new Error(
      `MIDNIGHT_NETWORK_ID resolved to ${JSON.stringify(net.id)}, which is not ` +
        `one of ${SOLVER_NETWORK_IDS.join(", ")}; the wallet and the fee-sizing ` +
        "stand-in would be built for a network that does not exist",
    );
  }
  const relayEnv = loadRelayClientEnv();
  const relayUrl = opts.relayUrl ?? SOLVER_RELAY_WS_URL;
  const relayHttpUrl = opts.relayHttpUrl === undefined
    ? loadSolverRelayHttpEnv(undefined, { relayExecutionEnabled: !dryRun })
    : parseSolverRelayHttpUrl(opts.relayHttpUrl);
  const relayAuthToken = opts.relayAuthToken ?? SOLVER_RELAY_AUTH_TOKEN;
  const maxParallelSwaps = opts.maxParallelSwaps ?? relayEnv.maxParallelSwaps;
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
  if (!dryRun && (relayUrl === "" || relayAuthToken === "" || relayHttpUrl === null)) {
    throw new Error(
      "live solver requires SOLVER_RELAY_WS_URL, SOLVER_RELAY_HTTP_URL, and SOLVER_RELAY_AUTH_TOKEN",
    );
  }
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
  const journalConfig = dryRun
    ? null
    : opts.journalOptions ?? loadSolverJournalEnv(undefined, {
      relayExecutionEnabled: true,
      warn: log,
    });
  let operationJournal: SolverOperationJournal | null = null;
  if (journalConfig) {
    operationJournal = (opts.journalOpen ?? SolverOperationJournal.open)({
      ...journalConfig,
      warn: log,
    });
    // Force canonical row hydration before the wallet is even acquired. SQLite
    // integrity alone cannot detect malformed canonical JSON or claim fields.
    try {
      operationJournal.list();
    } catch (error) {
      operationJournal.close();
      operationJournal = null;
      throw error;
    }
  }
  const admissionWarnings = startAdmissionWarnings(admission, log, opts.admissionWarningTimers);

  log(
    `[solver] network=${net.id} api=${api}${dryRun
      ? dryRunWalletMode === "real"
        ? " DRY-RUN (read-only real wallet/inventory; relay jobs disabled)"
        : " DRY-RUN TEST-ONLY (wallet skipped; NO Path-A parity)"
      : " RFQ relay mode"}`,
  );

  type SolverWallet = Awaited<ReturnType<typeof walletDependencies.buildWallet>>;
  let wallet: SolverWallet | null = null;
  let balanceWallet: SolverWallet | null = null;
  let jobExecutor: SwapJobExecutorHandle | null = null;
  let relayClient: RelayClientHandle | null = null;
  let backendCurrent = false;
  let inventoryChanged = (_ready: boolean): void => {};
  const book = new Book();
  const inventory = createInventoryRefreshController({
    stock,
    readBalances: async (signal) => {
      if (signal.aborted) throw asError(signal.reason, "inventory refresh aborted");
      if (!balanceWallet) throw new Error("wallet is unavailable for inventory refresh");
      return walletDependencies.shieldedBalances(balanceWallet);
    },
    onReadinessChange: (ready) => inventoryChanged(ready),
  });
  const refreshBalances = async (signal: AbortSignal): Promise<void> => {
    if (!backendCurrent) {
      throw new Error("backend book authority is unavailable");
    }
    await inventory.refresh(signal);
  };

  if (walletRequired) {
    try {
      wallet = await initializeOwnedResource<SolverWallet>({
        build: () => walletDependencies.buildWallet(opts.seed ?? SOLVER_SEED),
        initialize: async (owned, signal) => {
          balanceWallet = owned;
          await walletDependencies.waitForSync(owned, { timeoutMs: startupTimeoutMs });
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
      operationJournal?.close();
      admissionWarnings.stop();
      throw err;
    }
    log(
      `[solver] inventory: ` +
        stock.tokens().map((t) => `${t.slice(0, 8)}=${stock.balance(t)}`).join(" ") || "[solver] inventory: empty",
    );
  }

  const onChange = (change: BookChange): void => {
    if (change.kind === "removed") {
      log(`[solver] − ${change.offerHash.slice(0, 10)} (${change.reason})`);
      if (change.reason === "consumed") jobExecutor?.notifyConsumed(change.offerHash);
      return;
    }
    log(`[solver] + ${describeOffer(change.offer)}`);
  };

  let sync: SyncHandle | null = null;
  let recoveryRunning = false;
  let recoveryRequested = false;
  let initialSyncReady = false;
  let solverReadySettled = false;
  let resolveSolverReady!: () => void;
  let rejectSolverReady!: (error: unknown) => void;
  const solverReady = new Promise<void>((resolve, reject) => {
    resolveSolverReady = resolve;
    rejectSolverReady = reject;
  });
  observe(solverReady);

  const maybeResolveSolverReady = (): void => {
    if (
      !solverReadySettled &&
      initialSyncReady &&
      backendCurrent &&
      (dryRunWalletMode === "skip-test-only" || inventory.isReady())
    ) {
      solverReadySettled = true;
      resolveSolverReady();
    }
  };

  /** Publish NOW instead of waiting for the next tick. Used where inventory
   *  authority changes, so a withdrawal is not delayed by up to one push
   *  interval and a recovery is not either. Never throws and never blocks: the
   *  relay client coalesces this into any push already in flight. */
  const republishLadder = (reason: string): void => {
    void relayClient?.push().catch((error) => {
      log(`[solver] ${reason} republication failed: ${asError(error, "unknown error").message}`);
    });
  };

  // A failed/started refresh empties Stock, which withdraws residual inventory
  // authority. Maker-backed rungs still come from the current book cache — but
  // FR-003/FR-004 bound the PUBLISHED rungs by that same authority, so an
  // emptied Stock now also withdraws every rung whose interpolation interval
  // needs a residual payout and every rung above what the fee-sizing mirror can
  // spend. Both directions are republished immediately rather than at the next
  // tick: withdrawing late would keep advertising liquidity the executor has
  // already started refusing, and recovering late would strand the solver
  // unquotable for a full interval after each settlement (every terminal
  // outcome triggers a refresh).
  inventoryChanged = (ready): void => {
    if (ready && !backendCurrent) {
      inventory.invalidate(new Error("inventory read completed outside backend readiness"));
      return;
    }
    republishLadder(ready ? "inventory readiness" : "inventory withdrawal");
    if (ready && backendCurrent) maybeResolveSolverReady();
  };

  const retryInventory = async (): Promise<void> => {
    if (!walletRequired || !backendCurrent || inventory.isReady()) return;
    if (recoveryRunning) {
      recoveryRequested = true;
      return;
    }
    if (inventory.isRefreshing()) return;
    recoveryRunning = true;
    recoveryRequested = false;
    const owner = new AbortController();
    const timer = setTimeout(() => {
      owner.abort(
        new Error(`balance refresh timed out after ${walletOperationTimeoutMs} ms`),
      );
    }, walletOperationTimeoutMs);
    try {
      await inventory.refresh(owner.signal);
      if (backendCurrent) {
        log("[solver] authoritative inventory readiness restored");
      }
    } catch (err) {
      log(`[solver] inventory reconciliation failed: ${asError(err, "unknown error").message}`);
    } finally {
      clearTimeout(timer);
      recoveryRunning = false;
      if (recoveryRequested && backendCurrent && !inventory.isReady()) {
        observe(retryInventory());
      }
    }
  };

  const onCurrentnessChange = (state: ReturnType<SyncHandle["currentness"]>): void => {
    if (state.kind !== "current") {
      backendCurrent = false;
      if (walletRequired) {
        inventory.invalidate(
          new Error(`backend projection unavailable: ${state.reason}`),
        );
      }
      log(`[solver] backend projection blocked — ${state.reason}`);
      return;
    }
    const wasCurrent = backendCurrent;
    backendCurrent = true;
    if (walletRequired && !wasCurrent) {
      inventory.invalidate(new Error("backend projection restored; refreshing inventory"));
      recoveryRequested = true;
      observe(retryInventory());
    }
    log(
      `[solver] backend projection current at L2 ${state.backendBlockL2} ` +
        `(stream generation ${state.streamGeneration})`,
    );
    maybeResolveSolverReady();
  };

  try {
    sync = startBookSync({
      book,
      ...(opts.api ? { api: opts.api } : {}),
      resyncIntervalMs: opts.resyncIntervalMs ?? SOLVER_RESYNC_INTERVAL_MS,
      backendHealthCheckIntervalMs:
        opts.backendHealthCheckIntervalMs ?? SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS,
      backendHealthMaxAgeMs:
        opts.backendHealthMaxAgeMs ?? SOLVER_BACKEND_HEALTH_MAX_AGE_MS,
      expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
      onChange,
      onCurrentnessChange,
      ...(opts.syncDependencies ? { dependencies: opts.syncDependencies } : {}),
      onError: (err) => log(`[solver] sync error: ${err instanceof Error ? err.message : String(err)}`),
      log,
    });

    void sync.ready.then(
      () => {
        initialSyncReady = true;
        maybeResolveSolverReady();
      },
      (error) => {
        if (!solverReadySettled) {
          solverReadySettled = true;
          rejectSolverReady(error);
        }
      },
    );
  } catch (err) {
    if (!solverReadySettled) {
      solverReadySettled = true;
      rejectSolverReady(err);
    }
    inventory.stop();
    const cleanups: Promise<boolean>[] = [];
    if (sync) cleanups.push(cleanupWithin(sync, stopTimeoutMs, (owned) => owned.stop()));
    if (wallet) {
      cleanups.push(cleanupWithin(wallet, stopTimeoutMs, async (owned) => {
        await (owned.wallet as any)?.stop?.();
      }));
    }
    await Promise.all(cleanups);
    balanceWallet = null;
    operationJournal?.close();
    admissionWarnings.stop();
    throw err;
  }
  if (!sync) throw new Error("book synchronization failed to initialize");
  const activeSync = sync;

  // Durable claims must be rebuilt against a current authoritative balance,
  // not the deliberately emptied Stock used while backend currentness is
  // unknown. The relay is connected only after these upstream authorities are
  // ready; its cache remains gated empty through journal reconciliation.
  if (!dryRun) {
    try {
      await solverReady;
    } catch (error) {
      inventory.stop();
      await Promise.allSettled([
        activeSync.stop(),
        Promise.resolve().then(() => (wallet?.wallet as any)?.stop?.()),
      ]);
      balanceWallet = null;
      operationJournal?.close();
      admissionWarnings.stop();
      throw error;
    }
  }

  // Q-N4-1 option A: one deployable process, two independent lifecycles. The
  // relay client consumes `activeSync` only through the cache interface and
  // cannot start, stop or resnapshot the mirror.
  if (!dryRun) {
    if (!wallet) throw new Error("wallet initialization did not produce a wallet");
    if (!operationJournal) throw new Error("live solver did not open its operation journal");
    const ownedWallet = wallet;
    jobExecutor = startSwapJobExecutor({
      cache: activeSync,
      stock,
      wallet: ownedWallet.wallet as any,
      journal: operationJournal,
      keys: walletDependencies.shieldedKeys(ownedWallet) as any,
      // FR-001: the same network id `buildWallet` handed the facade, so the
      // fee-sizing stand-in can merge with the wallet's own half.
      networkId: net.id,
      modelledTakerInputs: feeSizingTakerInputs,
      api,
      relayHttpUrl: relayHttpUrl!,
      maxParallelSwaps,
      expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
      settleTtlMinutes: SOLVER_SETTLE_TTL_MINUTES,
      // FR-002: the same policy object publication gets, forwarded whole.
      ...forwardAdmissionPolicy(admission),
      dustAdmission: admission.dust,
      walletOperationTimeoutMs,
      sweepIntervalMs: opts.jobSweepIntervalMs ?? SOLVER_STATUS_POLL_MS,
      ...(opts.jobTimers ? { timers: opts.jobTimers } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.jobDependencies ? { dependencies: opts.jobDependencies } : {}),
      onOfferConsumed: (offerHash) => {
        if (activeSync.book.remove(offerHash)) {
          log(`[solver] − ${offerHash.slice(0, 10)} (consumed by status sweeper)`);
        }
      },
      refreshBalances: async () => {
        if (!backendCurrent || inventory.isRefreshing()) return;
        const owner = new AbortController();
        await refreshBalances(owner.signal);
      },
      onDustWindowBlocked: () => {
        log("[ADMISSION] rolling DUST window refused a routed job; withdrawing every ladder");
        void relayClient?.push().catch((error) => {
          log(`[ADMISSION] immediate DUST withdrawal failed: ${asError(error, "unknown error").message}`);
        });
      },
      log,
    });

    const activeJobs = jobExecutor;
    let journalReconciled = false;
    try {
      relayClient = startRelayClient({
        url: relayUrl,
        authToken: relayAuthToken,
        cache: {
          book: activeSync.book,
          isCurrent: () => journalReconciled && activeSync.isCurrent() && activeJobs.dustAvailable(),
        },
        ladder: {
          expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
          maxParallelSwaps,
          // One swap job is one bounded exact-files read. Never advertise a rung
          // whose whole-offer prefix cannot fit that read.
          maxRungsPerPair: MAX_EXACT_FILES_PER_READ,
          unavailableOfferHashes: activeJobs.unavailableOfferHashes,
          // FR-002: ONE policy object, the same one the executor admits with, so
          // a field cannot reach admission without reaching the wire (P4-F02).
          ...forwardAdmissionPolicy(admission),
          // FR-003/FR-004: never advertise a rung this solver could not pay the
          // residual for, or whose fee-sizing mirror it could not fund. Read per
          // push, so an inventory refresh — including the deliberate emptying
          // that follows a lost backend authority — withdraws the affected rungs
          // on the very next push.
          spendableInventory: () => stock.spendable(),
        },
        pushIntervalMs: opts.relayPushIntervalMs ?? relayEnv.pushIntervalMs,
        reconnectDelayMs: opts.relayReconnectDelayMs ?? relayEnv.reconnectDelayMs,
        connectTimeoutMs: opts.relayConnectTimeoutMs ?? relayEnv.connectTimeoutMs,
        withdrawTimeoutMs: opts.relayWithdrawTimeoutMs ?? relayEnv.withdrawTimeoutMs,
        ...(opts.relayCreateWebSocket ? { createWebSocket: opts.relayCreateWebSocket } : {}),
        ...(opts.relayTimers ? { timers: opts.relayTimers } : {}),
        onSwap: activeJobs.onSwap,
        onTxSubmitted: activeJobs.onTxSubmitted,
        onSubmitFailed: activeJobs.onSubmitFailed,
        log,
      });
      await jobExecutor.ready;
      journalReconciled = true;
      await relayClient.push();
    } catch (error) {
      await Promise.allSettled([relayClient?.stop(), jobExecutor.stop()]);
      await Promise.allSettled([
        activeSync.stop(),
        Promise.resolve().then(() => (ownedWallet.wallet as any)?.stop?.()),
      ]);
      balanceWallet = null;
      operationJournal.close();
      admissionWarnings.stop();
      throw error;
    }
  }

  const balanceRetryTimer = !walletRequired
    ? null
    : setInterval(() => {
      if (backendCurrent && !inventory.isReady() && !inventory.isRefreshing()) {
        recoveryRequested = true;
        observe(retryInventory());
      }
    }, balanceRefreshRetryMs);
  balanceRetryTimer?.unref?.();

  const idle = async (): Promise<void> => {
    await relayClient?.idle();
    await jobExecutor?.idle();
  };

  let stopPromise: Promise<void> | null = null;

  return {
    ladders,
    book: activeSync.book,
    validatedBook: activeSync.book,
    stock,
    ready: solverReady,
    idle,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      backendCurrent = false;
      if (!solverReadySettled) {
        solverReadySettled = true;
        rejectSolverReady(new Error("solver stopped before combined readiness"));
      }
      if (balanceRetryTimer) clearInterval(balanceRetryTimer);
      admissionWarnings.stop();
      inventory.stop();
      const retainedInventoryOperations = inventory.retainedOperations();
      if (retainedInventoryOperations > 0) {
        log(
          `[solver] shutdown retained ${retainedInventoryOperations} balance read(s) ` +
            "that ignored cancellation; late results cannot reinstall Stock",
        );
      }

      const ownedWallet = wallet;
      const ownedJobs = jobExecutor;
      const ownedRelay = relayClient;
      const ownedJournal = operationJournal;
      // Withdraw first while the socket is still open. Only after the client
      // can no longer accept jobs do we settle/revert executor state, then
      // release the mirror and wallet in parallel.
      const shutdown = (async (): Promise<void> => {
        await Promise.allSettled([Promise.resolve().then(() => ownedRelay?.stop())]);
        await Promise.allSettled([Promise.resolve().then(() => ownedJobs?.stop())]);
        try { ownedJournal?.close(); } catch (error) {
          log(`[solver] journal close failed: ${asError(error, "unknown error").message}`);
        }
        await Promise.allSettled([
          Promise.resolve().then(() => activeSync.stop()),
          Promise.resolve().then(() => (ownedWallet?.wallet as any)?.stop?.()),
        ]);
      })();
      const tasks: Promise<unknown>[] = [shutdown];
      for (const task of tasks) observe(task);
      balanceWallet = null;

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
              "unacknowledged wallet work remains quarantined in the durable journal",
          );
        }
      })();
      return stopPromise;
    },
  };
}
