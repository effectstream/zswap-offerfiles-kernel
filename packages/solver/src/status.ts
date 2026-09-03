// The solver's read-only status collector (00007 FR-003, FR-005, FR-006).
//
// WHAT THIS IS. One function, `createStatusCollector`, that turns the solver's
// already-existing in-memory seams into the versioned `StatusSnapshot` declared
// by `@zswap-da/solver-core/status-contract`. It is the whole of the read side:
// `status-server.ts` only serves what this produces, and knows nothing about
// books, ladders or journals.
//
// THREE PROPERTIES IT IS BUILT AROUND, each of which is a spec requirement and
// not a nicety:
//
//   FR-005 — **it cannot touch trading.** Every source below is a synchronous
//   in-memory read: `Book`, `Stock`, `SyncHandle.currentness()`,
//   `RelayClientHandle.stats()/lastPush()`, `SwapJobExecutorHandle.stats()`,
//   and SQLite queries against the local journal. No wallet call, no proof, no
//   kernel or relay request, no `await` anywhere in `snapshot()`. A status
//   endpoint that could block on the network would be a way to stall the
//   trading process from outside it.
//
//   FR-005 — **sectioned degradation.** Each of the ten sections is collected
//   inside its own try/catch. A journal whose SQLite handle is closed, or a
//   relay handle mid-teardown, costs the operator that one section as
//   `{ error }` and nothing else. The whole point of the page is that it works
//   when things are broken, so a snapshot that 500s because one seam threw
//   would fail exactly when it is needed.
//
//   FR-006 — **secret-free.** The contract has no field for the seed, a bearer
//   value, wallet keys or journal artifact bytes, so the redaction is
//   structural rather than a filter that a later edit could forget: the relay
//   bearer is reported as `relayAuthTokenLength`, journal rows come from
//   `listRecent`, which does not even SELECT the artifact column, and the claim
//   inputs (coin nullifiers) arrive already reduced to a count. The status
//   bearer itself is never handed to this module at all.
//
// BOUNDEDNESS. The caps are the contract's (`STATUS_BOOK_OFFER_CAP` &c.), not
// this file's, because the page must be able to say "500 of 12 480" rather than
// silently render a prefix. Every unbounded seam is capped here and reports how
// much it dropped.
//
// CHANGE NOTIFICATION. `subscribe` exists for `/status/stream`. The solver
// already emits everything worth reacting to — book changes, currentness
// changes, inventory readiness, relay events, executor terminal outcomes — so
// `run.ts` calls `notify()` from those observers and this module coalesces the
// burst into at most one frame per `STATUS_STREAM_COALESCE_MS`. A push loop
// running at 1 Hz next to a busy book would otherwise fan out hundreds of
// snapshots a second to every connected browser.

import {
  STATUS_BOOK_OFFER_CAP,
  STATUS_EVENT_RING_CAP,
  STATUS_JOURNAL_ROW_CAP,
  STATUS_STREAM_COALESCE_MS,
  statusContractVersion,
  type DecimalString,
  type Section,
  type SolverRunMode,
  type StatusAdmission,
  type StatusBackend,
  type StatusBook,
  type StatusBookOffer,
  type StatusExecutor,
  type StatusHealth,
  type StatusInventory,
  type StatusJournal,
  type StatusJournalDustUsage,
  type StatusJournalRow,
  type StatusLadder,
  type StatusLadderPush,
  type StatusListener,
  type StatusProcess,
  type StatusRelay,
  type StatusRelayEvent,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

import type { BookOffer } from "./book.ts";
import type { BackendCurrentnessState } from "./book-sync.ts";
import type {
  DustReservation,
  JournalOperationSummary,
  JournalStateCounts,
} from "./operation-journal.ts";
import type {
  RelayClientEvent,
  RelayClientStats,
  RelayLadderPushRecord,
} from "./relay-client.ts";
import type { SwapJobExecutorStats } from "./swap-job-executor.ts";

// ── the seams this collector reads, declared structurally ───────────────────
//
// Structural, not by importing the concrete classes, for the same reason
// `LadderCache` is: a test must be able to hand in a two-field double without
// standing up a wallet, and this module must not be able to reach anything the
// interfaces below do not name.

export interface StatusBookLike {
  readonly size: number;
  all: () => readonly BookOffer[];
  pairs: () => ReadonlyArray<{ giveToken: string; wantToken: string }>;
  byPair: (giveToken: string, wantToken: string) => readonly BookOffer[];
}

export interface StatusSyncLike {
  readonly book: StatusBookLike;
  isCurrent: () => boolean;
  currentness: () => BackendCurrentnessState;
}

export interface StatusStockLike {
  tokens: () => readonly string[];
  balance: (token: string) => bigint;
  reserved: (token: string) => bigint;
  available: (token: string) => bigint;
}

export interface StatusInventoryLike {
  isReady: () => boolean;
  isRefreshing: () => boolean;
  retainedOperations: () => number;
}

export interface StatusRelayLike {
  stats: () => RelayClientStats;
  lastPush: () => RelayLadderPushRecord | null;
}

export interface StatusExecutorLike {
  stats: () => SwapJobExecutorStats;
  unavailableOfferHashes: () => readonly string[];
  dustAvailable: () => boolean;
}

export interface StatusJournalLike {
  readonly path: string;
  listRecent: (limit: number) => readonly JournalOperationSummary[];
  countsByState: () => JournalStateCounts;
  dustUsage: (windowMs: number, nowMs?: number) => bigint;
  listDustReservations: () => readonly DustReservation[];
}

/** The static half of the process section, resolved once at startup. */
export interface StatusProcessInfo {
  startedAt: number;
  network: string;
  api: string;
  relayWsUrl: string | null;
  relayHttpUrl: string | null;
  /** FR-006: the LENGTH of the relay bearer. The value is never passed here. */
  relayAuthTokenLength: number;
  mode: SolverRunMode;
  solverEnabled: boolean;
  gitCommit: string | null;
  runtime: string | null;
}

/** The admission policy as configured, in its native (bigint) form. The
 *  decimal-string projection is this module's job, in one place. */
export interface StatusAdmissionInfo {
  supportedPairs: ReadonlySet<string> | null;
  minJobOutput: ReadonlyMap<string, bigint> | null;
  dust: { maxPerJob: bigint; maxPerWindow: bigint; windowMs: number } | null;
  openGroups: readonly string[];
  feeSizingTakerInputs: number;
  expiryMarginSeconds: number;
  pushIntervalMs: number;
  maxParallelSwaps: number;
  maxRungsPerPair: number | null;
  maxPairs: number | null;
  settleTtlMinutes: number | null;
}

/** Counters the listener owns and the snapshot reports. Mutable on purpose:
 *  `status-server.ts` increments these fields in place, so there is exactly one
 *  copy of each number rather than a request-path/reporting-path pair that can
 *  drift. */
export interface StatusListenerCounters {
  bound: boolean;
  host: string;
  port: number;
  startedAt: number;
  healthRequests: number;
  snapshotRequests: number;
  streamRequests: number;
  unauthorizedRequests: number;
  notFoundRequests: number;
  streamClients: number;
  streamClientCap: number;
  streamFramesDropped: number;
  streamClientsRejected: number;
}

export interface StatusTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: StatusTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    // FR-007: the status surface must not be the reason a process stays alive.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface StatusCollectorDependencies {
  process: StatusProcessInfo;
  admission: StatusAdmissionInfo;
  /** Null until the mirror is started, and in a snapshot taken during startup. */
  sync: () => StatusSyncLike | null;
  stock: () => StatusStockLike | null;
  inventory: () => StatusInventoryLike | null;
  /** Null in dry-run — reported as `not-started`, not as an error. */
  relay: () => StatusRelayLike | null;
  executor: () => StatusExecutorLike | null;
  journal: () => StatusJournalLike | null;
  /** The solver's combined readiness, for `/health`. */
  ready: () => boolean;
  nowMs?: () => number;
  timers?: StatusTimers;
  coalesceMs?: number;
}

export interface StatusCollector {
  snapshot: () => StatusSnapshot;
  health: () => StatusHealth;
  /** Fold one relay diagnostic into the ring and wake the subscribers. */
  recordRelayEvent: (event: RelayClientEvent) => void;
  /** Mark the solver's observable state as changed. Coalesced. */
  notify: () => void;
  /** Returns an unsubscribe function. Listeners are untrusted and contained. */
  subscribe: (listener: (snapshot: StatusSnapshot) => void) => () => void;
  readonly listenerCounters: StatusListenerCounters;
  stop: () => void;
}

const asMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Collect one section, or record why it could not be collected (FR-005). */
function section<T>(collect: () => T): Section<T> {
  try {
    return collect();
  } catch (error) {
    return { error: asMessage(error) };
  }
}

const decimal = (value: bigint): DecimalString => value.toString();

/** A relay event's `detail` is `Record<string, unknown>` by declaration. Only
 *  JSON scalars survive; a bigint becomes its decimal string and anything else
 *  becomes a bounded `String(...)`, so one odd detail cannot make the whole
 *  snapshot unserialisable. */
function flattenDetail(
  detail: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (detail === undefined) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : String(value);
    else if (typeof value === "string") out[key] = value.slice(0, 512);
    else if (typeof value === "bigint") out[key] = value.toString();
    else if (value === undefined) continue;
    else {
      try {
        out[key] = String(value).slice(0, 512);
      } catch {
        out[key] = "[unserialisable]";
      }
    }
  }
  return out;
}

/**
 * Book offers, NEWEST FIRST, capped.
 *
 * Newest first because an operator watching a live book is asking about what
 * just arrived; the offer that has been sitting there for an hour is not the
 * one being diagnosed. The tie-break is the content address, so the order is
 * total and a page does not reshuffle rows between two snapshots of an
 * unchanged book.
 */
function projectBook(book: StatusBookLike): StatusBook {
  const all = [...book.all()];
  all.sort((left, right) => {
    const l = left.firstSeenAt ?? -1;
    const r = right.firstSeenAt ?? -1;
    if (l !== r) return r - l;
    return left.offerHash < right.offerHash ? -1 : left.offerHash > right.offerHash ? 1 : 0;
  });
  const offers: StatusBookOffer[] = all.slice(0, STATUS_BOOK_OFFER_CAP).map((offer) => ({
    offerHash: offer.offerHash,
    gives: offer.gives.map((leg) => ({
      token: leg.token,
      amount: decimal(leg.amount),
      kind: leg.kind,
    })),
    wants: offer.wants.map((leg) => ({
      token: leg.token,
      amount: decimal(leg.amount),
      kind: leg.kind,
    })),
    expiresAt: offer.expiresAt,
    firstSeenAt: offer.firstSeenAt,
    inputNullifierCount: offer.inputNullifiers.length,
  }));
  const pairs = book.pairs()
    .map((pair) => ({
      giveToken: pair.giveToken,
      wantToken: pair.wantToken,
      offers: book.byPair(pair.giveToken, pair.wantToken).length,
    }))
    .sort((left, right) =>
      left.giveToken === right.giveToken
        ? (left.wantToken < right.wantToken ? -1 : left.wantToken > right.wantToken ? 1 : 0)
        : (left.giveToken < right.giveToken ? -1 : 1),
    );
  return {
    size: book.size,
    pairs,
    offers,
    cap: STATUS_BOOK_OFFER_CAP,
    truncated: Math.max(0, book.size - offers.length),
  };
}

function projectLadderPush(record: RelayLadderPushRecord): StatusLadderPush {
  const { push } = record;
  const levels = push.priceLevels.levels.map((pair) => ({
    tokenIn: pair.tokenIn,
    tokenOut: pair.tokenOut,
    levels: pair.levels.map((level) => ({ input: level.input, output: level.output })),
  }));
  return {
    derivedAt: record.derivedAt,
    cause: record.cause,
    withheld: push.withheld,
    tokenIds: [...push.capabilities.tokenIds],
    maxParallelSwaps: push.capabilities.maxParallelSwaps ?? null,
    levels,
    provenance: push.derived.provenance.map((pair) => ({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      rungs: pair.rungs.map((rung) => ({
        input: rung.input,
        output: rung.output,
        offerHash: rung.offerHash,
      })),
      residualBound: pair.residualBound,
    })),
    excluded: push.derived.excluded.map((exclusion) => ({
      offerHash: exclusion.offerHash,
      reason: exclusion.reason,
      ...(exclusion.detail === undefined ? {} : { detail: String(exclusion.detail) }),
    })),
    pairs: levels.length,
    rungs: levels.reduce((total, pair) => total + pair.levels.length, 0),
  };
}

function projectJournalRow(row: JournalOperationSummary): StatusJournalRow {
  return {
    id: row.id,
    operationKey: row.operationKey,
    jobId: row.jobId,
    generation: row.generation,
    operationKind: row.operationKind,
    lifecycleState: row.lifecycleState,
    offerHashes: [...row.offerHashes],
    claimInputCount: row.claim.inputCount,
    payouts: { ...row.claim.payouts },
    walletArtifactKind: row.walletArtifactKind ?? null,
    walletArtifactByteLength: row.walletArtifactByteLength,
    receipt: { ...row.receipt },
    errorCode: row.errorCode ?? null,
    // Bounded: an error detail is a message, and a page renders it inline.
    errorDetail: row.errorDetail === undefined ? null : row.errorDetail.slice(0, 512),
    retryCount: row.retryCount,
    nextRetryAtMs: row.nextRetryAtMs ?? null,
    ttlExpiresAtMs: row.ttlExpiresAtMs,
    deadlineAtMs: row.deadlineAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function projectDust(
  journal: StatusJournalLike,
  admission: StatusAdmissionInfo,
  nowMs: number,
): StatusJournalDustUsage {
  const reservations = { reserved: 0, spent: 0, released: 0 };
  for (const reservation of journal.listDustReservations()) {
    if (reservation.state === "RESERVED") reservations.reserved += 1;
    else if (reservation.state === "SPENT") reservations.spent += 1;
    else reservations.released += 1;
  }
  if (admission.dust === null) {
    // The DUST admission group is intentionally OPEN (Q-RF-2): there is no
    // window to measure usage against, so usage is absent rather than 0.
    return {
      configured: false,
      maxPerJob: null,
      maxPerWindow: null,
      windowMs: null,
      usage: null,
      reservations,
    };
  }
  return {
    configured: true,
    maxPerJob: decimal(admission.dust.maxPerJob),
    maxPerWindow: decimal(admission.dust.maxPerWindow),
    windowMs: admission.dust.windowMs,
    usage: decimal(journal.dustUsage(admission.dust.windowMs, nowMs)),
    reservations,
  };
}

export function createStatusCollector(deps: StatusCollectorDependencies): StatusCollector {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const coalesceMs = deps.coalesceMs ?? STATUS_STREAM_COALESCE_MS;
  if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 0) {
    throw new RangeError(`status coalesceMs must be a non-negative safe integer, got ${coalesceMs}`);
  }

  const listenerCounters: StatusListenerCounters = {
    bound: false,
    host: "",
    port: 0,
    startedAt: 0,
    healthRequests: 0,
    snapshotRequests: 0,
    streamRequests: 0,
    unauthorizedRequests: 0,
    notFoundRequests: 0,
    streamClients: 0,
    streamClientCap: 0,
    streamFramesDropped: 0,
    streamClientsRejected: 0,
  };

  // The relay event ring. A plain array with a shift at the cap: 200 entries is
  // small enough that the copy is irrelevant and the code stays obvious.
  const events: StatusRelayEvent[] = [];
  const lastEventByKind = new Map<string, StatusRelayEvent>();
  let eventsObserved = 0;
  let eventSeq = 0;

  const subscribers = new Set<(snapshot: StatusSnapshot) => void>();
  let coalesceTimer: unknown = null;
  let dirty = false;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const snapshot = (): StatusSnapshot => {
    const now = nowMs();
    return {
      contractVersion: statusContractVersion,
      now,
      process: section<StatusProcess>(() => ({
        startedAt: deps.process.startedAt,
        uptimeMs: Math.max(0, now - deps.process.startedAt),
        network: deps.process.network,
        api: deps.process.api,
        relayWsUrl: deps.process.relayWsUrl,
        relayHttpUrl: deps.process.relayHttpUrl,
        relayAuthTokenLength: deps.process.relayAuthTokenLength,
        mode: deps.process.mode,
        solverEnabled: deps.process.solverEnabled,
        gitCommit: deps.process.gitCommit,
        runtime: deps.process.runtime,
      })),
      backend: section<StatusBackend>(() => {
        const sync = deps.sync();
        if (sync === null) {
          // Before `startBookSync` returns there is no authority to report, and
          // "blocked, because synchronization has not started" is the truth.
          return {
            currentness: { kind: "blocked", reason: "not-started", streamGeneration: 0 },
            isCurrent: false,
          };
        }
        const currentness = sync.currentness();
        return {
          // Verbatim (FR-003), copied so a reader cannot mutate the live object.
          currentness: currentness.kind === "current"
            ? {
              kind: "current",
              streamGeneration: currentness.streamGeneration,
              backendBlockL2: currentness.backendBlockL2,
              healthTs: currentness.healthTs,
            }
            : {
              kind: "blocked",
              reason: currentness.reason,
              streamGeneration: currentness.streamGeneration,
            },
          isCurrent: sync.isCurrent(),
        };
      }),
      book: section<StatusBook>(() => {
        const sync = deps.sync();
        if (sync === null) {
          return { size: 0, pairs: [], offers: [], cap: STATUS_BOOK_OFFER_CAP, truncated: 0 };
        }
        return projectBook(sync.book);
      }),
      inventory: section<StatusInventory>(() => {
        const stock = deps.stock();
        const inventory = deps.inventory();
        const tokens = stock === null
          ? []
          : [...stock.tokens()].sort().map((token) => ({
            token,
            balance: decimal(stock.balance(token)),
            reserved: decimal(stock.reserved(token)),
            available: decimal(stock.available(token)),
          }));
        return {
          ready: inventory?.isReady() ?? false,
          refreshing: inventory?.isRefreshing() ?? false,
          retainedOperations: inventory?.retainedOperations() ?? 0,
          tokens,
        };
      }),
      relay: section<StatusRelay>(() => {
        const relay = deps.relay();
        return {
          state: relay === null ? "not-started" : "running",
          stats: relay === null ? null : { ...relay.stats() },
          lastEventByKind: Object.fromEntries(lastEventByKind),
          events: [...events],
          eventCap: STATUS_EVENT_RING_CAP,
          eventsObserved,
        };
      }),
      ladder: section<StatusLadder>(() => {
        const relay = deps.relay();
        if (relay === null) return { state: "not-started", last: null };
        const record = relay.lastPush();
        if (record === null) return { state: "never-derived", last: null };
        return { state: "derived", last: projectLadderPush(record) };
      }),
      executor: section<StatusExecutor>(() => {
        const executor = deps.executor();
        if (executor === null) {
          return {
            state: "not-started",
            stats: null,
            unavailableOfferHashes: [],
            dustAvailable: null,
          };
        }
        return {
          state: "running",
          stats: { ...executor.stats() },
          unavailableOfferHashes: [...executor.unavailableOfferHashes()],
          dustAvailable: executor.dustAvailable(),
        };
      }),
      journal: section<StatusJournal>(() => {
        const journal = deps.journal();
        if (journal === null) {
          return {
            state: "not-opened",
            path: null,
            rows: [],
            rowCap: STATUS_JOURNAL_ROW_CAP,
            total: 0,
            countsByState: {},
            dust: null,
          };
        }
        const countsByState = journal.countsByState();
        const total = Object.values(countsByState).reduce((sum, count) => sum + count, 0);
        return {
          state: "open",
          path: journal.path,
          rows: journal.listRecent(STATUS_JOURNAL_ROW_CAP).map(projectJournalRow),
          rowCap: STATUS_JOURNAL_ROW_CAP,
          total,
          countsByState: { ...countsByState },
          dust: projectDust(journal, deps.admission, now),
        };
      }),
      admission: section<StatusAdmission>(() => ({
        supportedPairs: deps.admission.supportedPairs === null
          ? null
          : [...deps.admission.supportedPairs].sort(),
        minJobOutput: deps.admission.minJobOutput === null
          ? null
          : Object.fromEntries(
            [...deps.admission.minJobOutput]
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([token, amount]) => [token, decimal(amount)]),
          ),
        dust: deps.admission.dust === null
          ? null
          : {
            maxPerJob: decimal(deps.admission.dust.maxPerJob),
            maxPerWindow: decimal(deps.admission.dust.maxPerWindow),
            windowMs: deps.admission.dust.windowMs,
          },
        openGroups: [...deps.admission.openGroups],
        feeSizingTakerInputs: deps.admission.feeSizingTakerInputs,
        expiryMarginSeconds: deps.admission.expiryMarginSeconds,
        pushIntervalMs: deps.admission.pushIntervalMs,
        maxParallelSwaps: deps.admission.maxParallelSwaps,
        maxRungsPerPair: deps.admission.maxRungsPerPair,
        maxPairs: deps.admission.maxPairs,
        settleTtlMinutes: deps.admission.settleTtlMinutes,
      })),
      listener: section<StatusListener>(() => {
        if (!listenerCounters.bound) {
          throw new Error("status listener is not bound");
        }
        const { bound: _bound, ...rest } = listenerCounters;
        return { ...rest };
      }),
    };
  };

  const flush = (): void => {
    coalesceTimer = null;
    if (stopped || !dirty || subscribers.size === 0) return;
    dirty = false;
    lastEmitAt = nowMs();
    let frame: StatusSnapshot;
    try {
      frame = snapshot();
    } catch {
      // `snapshot()` is sectioned and should not throw; if it somehow does, a
      // dropped frame is strictly better than a broken notification loop.
      return;
    }
    for (const listener of [...subscribers]) {
      try {
        listener(frame);
      } catch {
        // A subscriber never owns the notification loop (the R-37 discipline).
      }
    }
  };

  const notify = (): void => {
    if (stopped || subscribers.size === 0) return;
    dirty = true;
    if (coalesceTimer !== null) return;
    const since = nowMs() - lastEmitAt;
    const delay = since >= coalesceMs ? 0 : coalesceMs - since;
    coalesceTimer = timers.setTimeout(flush, delay);
  };

  return {
    snapshot,
    health: (): StatusHealth => ({
      status: "ok",
      // Liveness is the 200 itself; `ready` is the solver's own combined
      // readiness, which is what a Compose healthcheck should gate on.
      ready: (() => {
        try {
          return deps.ready();
        } catch {
          return false;
        }
      })(),
      mode: deps.process.mode,
      contractVersion: statusContractVersion,
    }),
    recordRelayEvent: (event: RelayClientEvent): void => {
      if (stopped) return;
      eventsObserved += 1;
      const entry: StatusRelayEvent = {
        seq: ++eventSeq,
        at: nowMs(),
        kind: event.kind,
        severity: event.severity,
        message: event.message.slice(0, 1024),
        ...(flattenDetail(event.detail) === undefined
          ? {}
          : { detail: flattenDetail(event.detail)! }),
      };
      events.push(entry);
      while (events.length > STATUS_EVENT_RING_CAP) events.shift();
      lastEventByKind.set(entry.kind, entry);
      notify();
    },
    notify,
    subscribe: (listener): (() => void) => {
      if (stopped) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    listenerCounters,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (coalesceTimer !== null) timers.clearTimeout(coalesceTimer);
      coalesceTimer = null;
      subscribers.clear();
    },
  };
}
