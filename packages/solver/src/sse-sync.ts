// Keeps the Book in step with the node.
//
// Ordering matters on startup: open the stream FIRST and buffer, then page
// through the list, then replay the buffer. Opening second would lose every
// event between the last page and the subscription.
//
// The stream has no replay and no Last-Event-ID, so a dropped connection means
// permanently missed events. Every (re)connection therefore triggers a full
// page-through, and a periodic one runs regardless.

import {
  ApiRequestError,
  getBackendSyncHealth,
  getZswapByHash,
  getZswapsPage,
  openSseStream,
  reportsBackendProjectionCurrent,
  type CurrentBackendSyncHealth,
  type SseEvent,
  type SseStreamHandle,
} from "@zswap-da/solver-core/api-client";

import { Book, bookOfferFromApi, type BookOffer } from "./book.ts";

export type BookChange =
  | { kind: "added"; offer: BookOffer }
  | { kind: "removed"; offerHash: string; reason: "consumed" | "expired" | "resync" };

export interface SyncDependencies {
  getZswapsPage: typeof getZswapsPage;
  getZswapByHash: typeof getZswapByHash;
  getBackendSyncHealth: typeof getBackendSyncHealth;
  openSseStream: typeof openSseStream;
}

const DEFAULT_DEPENDENCIES: SyncDependencies = {
  getZswapsPage,
  getZswapByHash,
  getBackendSyncHealth,
  openSseStream,
};

export type BackendCurrentnessBlockedReason =
  | "initializing"
  | "stream-disconnected"
  | "stream-generation-changed"
  | "backend-syncing"
  | "backend-error"
  | "health-unavailable"
  | "health-malformed"
  | "health-stale"
  | "generation-superseded"
  | "stopped";

export type BackendCurrentnessState =
  | {
      kind: "blocked";
      reason: BackendCurrentnessBlockedReason;
      streamGeneration: number;
    }
  | {
      kind: "current";
      streamGeneration: number;
      backendBlockL2: string;
      healthTs: number;
    };

export interface SyncOptions {
  api?: string;
  book?: Book;
  resyncIntervalMs?: number;
  expiryMarginSeconds?: number;
  /** Fires after every applied change so the engine can re-evaluate the
   *  touched pairs instead of rescanning the whole book. */
  onChange?: (change: BookChange) => void;
  onError?: (err: unknown) => void;
  log?: (msg: string) => void;
  /** Explicit seam for deterministic tests; production uses the real client. */
  dependencies?: SyncDependencies;
  /** Maximum startup-gap events retained while an authoritative snapshot is
   * in flight. Overflow discards the gap and forces another full snapshot. */
  maxBufferedEvents?: number;
  /** Cumulative encoded size of retained startup events. */
  maxBufferedBytes?: number;
  /** Bounds a malformed/cyclic or unexpectedly huge REST pagination walk. */
  maxSnapshotPages?: number;
  maxSnapshotOffers?: number;
  /** Terminal deadline for the first authoritative snapshot plus buffered SSE
   * gap. Recoverable failures may retry until this deadline; afterward the
   * synchronization owner closes and readiness rejects fail-closed. */
  readinessTimeoutMs?: number;
  /** Cadence for the bounded health probe. A blocked solver first probes health
   * and only performs a full recovery snapshot after a current response. */
  backendHealthCheckIntervalMs?: number;
  /** Maximum accepted absolute server timestamp skew/age and maximum local
   * lifetime of one successful health observation. */
  backendHealthMaxAgeMs?: number;
  /** Absolute fetch-plus-body deadline for one health response. */
  backendHealthRequestTimeoutMs?: number;
  /** Fires only when the usable-currentness boolean changes. */
  onCurrentnessChange?: (state: BackendCurrentnessState) => void;
}

export interface SyncHandle {
  readonly book: Book;
  /** Resolves once the first full page-through and every SSE event buffered
   * during it have been applied. Initial snapshot failures are recoverable. */
  ready: Promise<void>;
  /** True only after one complete snapshot/buffered gap and a fresh health
   * verdict for the currently connected SSE generation. */
  isCurrent: () => boolean;
  currentness: () => BackendCurrentnessState;
  resync: () => Promise<void>;
  /** Cancel new work and wait for already queued synchronization work to
   * observe cancellation. No changes are emitted after this resolves. */
  stop: () => Promise<void>;
}

const PAGE_LIMIT = 100;
export const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_PAGES = 100;
export const DEFAULT_MAX_SNAPSHOT_OFFERS = PAGE_LIMIT * DEFAULT_MAX_SNAPSHOT_PAGES;
export const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
export const DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL_MS = 5_000;
export const DEFAULT_BACKEND_HEALTH_MAX_AGE_MS = 15_000;
export const DEFAULT_BACKEND_HEALTH_REQUEST_TIMEOUT_MS = 5_000;

class BackendCurrentnessError extends Error {
  readonly reason: BackendCurrentnessBlockedReason;

  constructor(reason: BackendCurrentnessBlockedReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackendCurrentnessError";
    this.reason = reason;
  }
}

export interface SnapshotLimits {
  maxPages?: number;
  maxOffers?: number;
}

/** Walk every page of the live book. */
export async function fetchWholeBook(
  api?: string,
  signal?: AbortSignal,
  dependencies: SyncDependencies = DEFAULT_DEPENDENCIES,
  limits: SnapshotLimits = {},
): Promise<BookOffer[]> {
  const maxPages = limits.maxPages ?? DEFAULT_MAX_SNAPSHOT_PAGES;
  const maxOffers = limits.maxOffers ?? DEFAULT_MAX_SNAPSHOT_OFFERS;
  for (const [name, value] of [["maxPages", maxPages], ["maxOffers", maxOffers]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
    }
  }
  const offers: BookOffer[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let rows = 0;
  for (;;) {
    if (pages >= maxPages) {
      throw new Error(`offer snapshot exceeded ${maxPages} pages`);
    }
    const page = await dependencies.getZswapsPage({
      limit: PAGE_LIMIT,
      api,
      signal,
      ...(cursor ? { after_hash: cursor } : {}),
    });
    pages++;
    rows += page.offers.length;
    if (rows > maxOffers) {
      throw new Error(`offer snapshot exceeded ${maxOffers} rows`);
    }
    for (const row of page.offers) {
      const parsed = bookOfferFromApi(row);
      if (parsed) offers.push(parsed);
    }
    if (!page.nextCursor) return offers;
    if (!/^[0-9a-f]{64}$/.test(page.nextCursor)) {
      throw new Error("offer snapshot returned a non-canonical nextCursor");
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`offer snapshot cursor cycle at ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function startBookSync(opts: SyncOptions = {}): SyncHandle {
  const book = opts.book ?? new Book();
  const api = opts.api;
  const dependencies = opts.dependencies ?? DEFAULT_DEPENDENCIES;
  const log = (message: string): void => {
    try {
      opts.log?.(message);
    } catch {
      // Diagnostics cannot own synchronization readiness or shutdown.
    }
  };
  const expiryMarginSeconds = opts.expiryMarginSeconds ?? 120;
  const resyncIntervalMs = opts.resyncIntervalMs ?? 300_000;
  const maxBufferedEvents = opts.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const maxSnapshotPages = opts.maxSnapshotPages ?? DEFAULT_MAX_SNAPSHOT_PAGES;
  const maxSnapshotOffers = opts.maxSnapshotOffers ?? DEFAULT_MAX_SNAPSHOT_OFFERS;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const backendHealthCheckIntervalMs =
    opts.backendHealthCheckIntervalMs ?? DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL_MS;
  const backendHealthMaxAgeMs =
    opts.backendHealthMaxAgeMs ?? DEFAULT_BACKEND_HEALTH_MAX_AGE_MS;
  const backendHealthRequestTimeoutMs =
    opts.backendHealthRequestTimeoutMs ??
    Math.min(DEFAULT_BACKEND_HEALTH_REQUEST_TIMEOUT_MS, backendHealthMaxAgeMs);
  for (const [name, value] of [
    ["resyncIntervalMs", resyncIntervalMs],
    ["maxBufferedEvents", maxBufferedEvents],
    ["maxBufferedBytes", maxBufferedBytes],
    ["maxSnapshotPages", maxSnapshotPages],
    ["maxSnapshotOffers", maxSnapshotOffers],
    ["readinessTimeoutMs", readinessTimeoutMs],
    ["backendHealthCheckIntervalMs", backendHealthCheckIntervalMs],
    ["backendHealthMaxAgeMs", backendHealthMaxAgeMs],
    ["backendHealthRequestTimeoutMs", backendHealthRequestTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
    }
  }
  if (backendHealthCheckIntervalMs >= backendHealthMaxAgeMs) {
    throw new RangeError(
      `backendHealthCheckIntervalMs (${backendHealthCheckIntervalMs}) must be less than ` +
        `backendHealthMaxAgeMs (${backendHealthMaxAgeMs})`,
    );
  }
  if (backendHealthRequestTimeoutMs > backendHealthMaxAgeMs) {
    throw new RangeError(
      `backendHealthRequestTimeoutMs (${backendHealthRequestTimeoutMs}) must not exceed ` +
        `backendHealthMaxAgeMs (${backendHealthMaxAgeMs})`,
    );
  }

  let stopped = false;
  let buffering = true;
  const buffered: SseEvent[] = [];
  let bufferedBytes = 0;
  let bufferOverflowed = false;
  let stream: SseStreamHandle | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  let healthExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> = Promise.resolve();
  let initialAttempt: Promise<void> | null = null;
  let retryInitialAfterAttempt = false;
  let streamOpenGeneration = 0;
  let streamConnected = false;
  let postReadyResyncRunner: Promise<void> | null = null;
  let postReadyResyncRequested = 0;
  let postReadyResyncCompleted = 0;
  let healthCheckRunner: Promise<void> | null = null;
  let readySettled = false;
  let stopPromise: Promise<void> | null = null;
  let readinessTimer: ReturnType<typeof setTimeout> | null = null;
  const owner = new AbortController();
  let currentness: BackendCurrentnessState = {
    kind: "blocked",
    reason: "initializing",
    streamGeneration: 0,
  };
  let currentnessNotified = false;
  let requestCurrentnessRecovery = (): void => {};

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Diagnostics are observers, never part of the synchronization state
      // machine. A throwing observer must not poison the work queue.
    }
  };

  const publishCurrentness = (next: BackendCurrentnessState): void => {
    const changed = currentness.kind !== next.kind ||
      currentness.streamGeneration !== next.streamGeneration ||
      (currentness.kind === "blocked" && next.kind === "blocked" &&
        currentness.reason !== next.reason) ||
      (currentness.kind === "current" && next.kind === "current" &&
        currentness.backendBlockL2 !== next.backendBlockL2);
    currentness = next;
    if (!currentnessNotified || changed) {
      currentnessNotified = true;
      try {
        opts.onCurrentnessChange?.(next);
      } catch (err) {
        reportError(err);
      }
    }
  };

  const setBlocked = (reason: BackendCurrentnessBlockedReason): void => {
    // An in-flight request may observe owner cancellation after stop has
    // published the terminal state. It must not rewrite that state while the
    // lifecycle barrier is joining the request.
    if (stopped && reason !== "stopped") return;
    if (healthExpiryTimer) clearTimeout(healthExpiryTimer);
    healthExpiryTimer = null;
    publishCurrentness({
      kind: "blocked",
      reason,
      streamGeneration: streamOpenGeneration,
    });
  };

  const healthIsFresh = (health: CurrentBackendSyncHealth, now = Date.now()): boolean =>
    health.ts >= now - backendHealthMaxAgeMs && health.ts <= now + backendHealthMaxAgeMs;

  const installCurrent = (
    health: CurrentBackendSyncHealth,
    generation: number,
  ): void => {
    const now = Date.now();
    if (!healthIsFresh(health, now)) {
      throw new BackendCurrentnessError(
        "health-stale",
        `backend health ts ${health.ts} is outside the ${backendHealthMaxAgeMs} ms freshness window`,
      );
    }
    if (!streamConnected || generation !== streamOpenGeneration) {
      throw new BackendCurrentnessError(
        "generation-superseded",
        "backend health belongs to a superseded SSE generation",
      );
    }

    if (healthExpiryTimer) clearTimeout(healthExpiryTimer);
    const expiresAt = Math.min(now + backendHealthMaxAgeMs, health.ts + backendHealthMaxAgeMs);
    const observedHealthTs = health.ts;
    healthExpiryTimer = setTimeout(() => {
      if (
        currentness.kind === "current" &&
        currentness.streamGeneration === generation &&
        currentness.healthTs === observedHealthTs
      ) {
        setBlocked("health-stale");
        requestCurrentnessRecovery();
      }
    }, Math.max(1, expiresAt - now + 1));
    healthExpiryTimer.unref?.();

    publishCurrentness({
      kind: "current",
      streamGeneration: generation,
      backendBlockL2: health.blockL2.height,
      healthTs: health.ts,
    });
  };

  const currentnessFailure = (error: unknown): BackendCurrentnessError => {
    if (error instanceof BackendCurrentnessError) return error;
    if (error instanceof ApiRequestError && error.kind === "malformed") {
      return new BackendCurrentnessError("health-malformed", error.message, error);
    }
    return new BackendCurrentnessError(
      "health-unavailable",
      error instanceof Error ? error.message : String(error),
      error,
    );
  };

  const readFreshHealth = async (generation: number): Promise<CurrentBackendSyncHealth> => {
    let health;
    try {
      health = await dependencies.getBackendSyncHealth({
        ...(api ? { api } : {}),
        timeoutMs: backendHealthRequestTimeoutMs,
        signal: owner.signal,
      });
    } catch (error) {
      throw currentnessFailure(error);
    }
    if (stopped || !streamConnected || generation !== streamOpenGeneration) {
      throw new BackendCurrentnessError(
        "generation-superseded",
        "backend health completed for a superseded SSE generation",
      );
    }
    if (!reportsBackendProjectionCurrent(health)) {
      throw new BackendCurrentnessError(
        health.status === "syncing" ? "backend-syncing" : "backend-error",
        `backend projection is ${health.status}`,
      );
    }
    if (!healthIsFresh(health)) {
      throw new BackendCurrentnessError(
        "health-stale",
        `backend health ts ${health.ts} is outside the ${backendHealthMaxAgeMs} ms freshness window`,
      );
    }
    return health;
  };

  // The runtime must start fail-closed even if its wallet was initialized
  // before the stream/currentness owner was constructed.
  publishCurrentness(currentness);

  const emit = (change: BookChange): void => {
    if (stopped) return;
    try {
      opts.onChange?.(change);
    } catch (err) {
      reportError(err);
    }
  };

  const removeAndEmit = (offerHash: string, reason: "consumed" | "expired" | "resync"): void => {
    if (book.remove(offerHash)) emit({ kind: "removed", offerHash, reason });
  };

  const addByHash = async (offerHash: string): Promise<void> => {
    if (stopped) return;
    if (book.get(offerHash)) return;
    // The detail row is the only one carrying nullifiers, expiry, AND the blob,
    // so one fetch here saves a second round trip at settlement time.
    const detail = await dependencies.getZswapByHash(offerHash, { api, signal: owner.signal });
    if (stopped) return;
    const parsed = bookOfferFromApi(detail);
    if (!parsed) return;
    book.upsert(parsed);
    emit({ kind: "added", offer: parsed });
  };

  const applyEvent = async (ev: SseEvent): Promise<void> => {
    if (stopped) return;
    switch (ev.type) {
      case "offer_indexed":
        await addByHash(ev.offerHash.toLowerCase());
        return;
      case "offer_consumed": {
        if (ev.offerHash) {
          removeAndEmit(ev.offerHash.toLowerCase(), "consumed");
        }
        // A nullifier invalidates every conflicting book row, not only the hash
        // named by a modern event. Pre-offerHash nodes rely on this entirely.
        if (ev.nullifier) {
          for (const hash of book.removeByNullifier(ev.nullifier)) {
            emit({ kind: "removed", offerHash: hash, reason: "consumed" });
          }
        }
        return;
      }
      case "offer_expired": {
        if (ev.offerHash) removeAndEmit(ev.offerHash.toLowerCase(), "expired");
        // Without a hash there is nothing to correlate; the local expiry sweep
        // and the periodic resync cover it.
        return;
      }
      default:
        return;
    }
  };

  // Events are serialised through one chain: applying an indexed event awaits a
  // detail fetch, and two events for the same offer must not interleave.
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const task = pending.then(async () => {
      if (stopped) return;
      await fn();
    });
    // Keep the queue usable after an individual operation fails. Return the
    // original task so callers that own readiness can observe its outcome.
    pending = task.catch(reportError);
    return task;
  };

  const fetchSnapshot = async (): Promise<BookOffer[]> =>
    fetchWholeBook(api, owner.signal, dependencies, {
      maxPages: maxSnapshotPages,
      maxOffers: maxSnapshotOffers,
    });

  const applySnapshot = (offers: BookOffer[]): void => {
    if (stopped) return;
    const diff = book.resync(offers);
    for (const offerHash of diff.removed) emit({ kind: "removed", offerHash, reason: "resync" });
    for (const offerHash of diff.updated) {
      emit({ kind: "removed", offerHash, reason: "resync" });
      const offer = book.get(offerHash);
      if (offer) emit({ kind: "added", offer });
    }
    for (const offerHash of diff.added) {
      const offer = book.get(offerHash);
      if (offer) emit({ kind: "added", offer });
    }
    if (diff.added.length || diff.removed.length) {
      log(`[solver] resync: +${diff.added.length} -${diff.removed.length} (book=${book.size})`);
    }
  };

  const loadCurrentSnapshot = async (
    generation: number,
    preflightHealth: boolean,
  ): Promise<{ offers: BookOffer[]; health: CurrentBackendSyncHealth }> => {
    if (!streamConnected || generation !== streamOpenGeneration) {
      throw new BackendCurrentnessError(
        "generation-superseded",
        "cannot snapshot a disconnected or superseded SSE generation",
      );
    }
    // Startup retries probe the cheap cached health boundary first; a backend
    // that is still syncing must not trigger a full offer-book walk every tick.
    if (preflightHealth) await readFreshHealth(generation);
    const offers = await fetchSnapshot();
    const health = await readFreshHealth(generation);
    return { offers, health };
  };

  const stageCurrentGeneration = async (): Promise<{
    generation: number;
    health: CurrentBackendSyncHealth;
  }> => {
    const generation = streamOpenGeneration;
    try {
      const { offers, health } = await loadCurrentSnapshot(generation, false);
      if (stopped) {
        throw new BackendCurrentnessError(
          "generation-superseded",
          "snapshot completed after synchronization stopped",
        );
      }
      applySnapshot(offers);
      return { generation, health };
    } catch (error) {
      const failure = currentnessFailure(error);
      setBlocked(failure.reason);
      throw failure;
    }
  };

  /** Collapse reconnect, timer, and manual triggers into one active snapshot
   * plus at most one latest follow-up. A reconnect storm can therefore never
   * append an unbounded chain behind a slow REST pagination walk. */
  const schedulePostReadyResync = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const ticket = ++postReadyResyncRequested;

    const startRunner = (): Promise<void> => {
      if (postReadyResyncRunner) return postReadyResyncRunner;
      const runner = (async () => {
        while (!stopped && postReadyResyncCompleted < postReadyResyncRequested) {
          // Every trigger observed before this snapshot starts collapses into
          // this target; triggers while it runs collapse into one next loop.
          const target = postReadyResyncRequested;
          try {
            // Preserve event/snapshot ordering by sharing the same serial queue
            // used for SSE event detail fetches and mutations. Currentness is
            // installed in a SECOND queued task: every SSE event enqueued while
            // the snapshot request was in flight therefore drains before this
            // generation can become usable.
            const stagedResult: {
              value?: Awaited<ReturnType<typeof stageCurrentGeneration>>;
            } = {};
            await enqueue(async () => {
              stagedResult.value = await stageCurrentGeneration();
            });
            const staged = stagedResult.value;
            if (staged === undefined) {
              throw new BackendCurrentnessError(
                "generation-superseded",
                "snapshot staging stopped before producing a generation",
              );
            }
            await enqueue(async () => {
              try {
                installCurrent(staged.health, staged.generation);
              } catch (error) {
                const failure = currentnessFailure(error);
                setBlocked(failure.reason);
                throw failure;
              }
            });
          } catch (error) {
            const failure = currentnessFailure(error);
            if (
              failure.reason !== "generation-superseded" ||
              target >= postReadyResyncRequested
            ) {
              throw failure;
            }
            // A reconnect queued a newer generation while this snapshot was
            // in flight. The latest coalesced iteration is the authoritative
            // result; do not reject waiters on the intentionally stale one.
          } finally {
            // A failed attempt consumes its trigger; a later trigger may retry.
            postReadyResyncCompleted = target;
          }
        }
      })();
      postReadyResyncRunner = runner;
      void runner
        .catch(reportError)
        .finally(() => {
          if (postReadyResyncRunner === runner) postReadyResyncRunner = null;
          if (!stopped && postReadyResyncCompleted < postReadyResyncRequested) {
            void startRunner().catch(() => {});
          }
        });
      return runner;
    };

    return (async () => {
      while (!stopped && postReadyResyncCompleted < ticket) {
        await startRunner();
      }
    })();
  };

  let resolveReady: () => void;
  let rejectReady: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const stopSynchronization = (
    reason = new Error("book synchronization stopped before readiness"),
  ): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    setBlocked("stopped");
    owner.abort(reason);
    const streamStopped = stream?.close() ?? Promise.resolve();
    if (resyncTimer) clearInterval(resyncTimer);
    if (healthCheckTimer) clearInterval(healthCheckTimer);
    if (healthExpiryTimer) clearTimeout(healthExpiryTimer);
    healthCheckTimer = null;
    healthExpiryTimer = null;
    if (sweepTimer) clearInterval(sweepTimer);
    if (readinessTimer) clearTimeout(readinessTimer);
    readinessTimer = null;
    buffered.length = 0;
    bufferedBytes = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(reason);
    }
    stopPromise = Promise.all([
      pending,
      streamStopped,
      healthCheckRunner?.catch(() => {}) ?? Promise.resolve(),
      postReadyResyncRunner?.catch(() => {}) ?? Promise.resolve(),
    ]).then(() => {});
    return stopPromise;
  };

  /** Schedule the recoverable startup barrier. Only one attempt may be queued
   * at once; a reconnect, periodic tick, or explicit resync can retry it. */
  const ensureInitialSync = (): Promise<void> => {
    if (readySettled || stopped) return Promise.resolve();
    // REST-first would recreate the exact snapshot/subscription gap this
    // startup barrier exists to close. Only a confirmed onOpen generation may
    // authorize the first snapshot, including periodic/manual retry paths.
    if (!streamConnected || streamOpenGeneration === 0) return Promise.resolve();
    if (initialAttempt) return initialAttempt;

    const attempt = enqueue(async () => {
      for (;;) {
        const snapshotGeneration = streamOpenGeneration;
        let health: CurrentBackendSyncHealth;
        try {
          const loaded = await loadCurrentSnapshot(snapshotGeneration, true);
          health = loaded.health;
          applySnapshot(loaded.offers);
        } catch (error) {
          const failure = currentnessFailure(error);
          setBlocked(failure.reason);
          throw failure;
        }
        if (stopped) return;

        // A reconnect while this snapshot was in flight creates an uncovered
        // stream gap. Discard events from both sides of that gap and take a
        // newer authoritative snapshot only after the new subscription is up.
        if (!streamConnected || snapshotGeneration !== streamOpenGeneration) {
          buffered.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = false;
          return;
        }

        // An overflow means at least one mutation in the snapshot gap was
        // discarded. The current snapshot cannot repair an event that raced its
        // pagination, so throw away the partial gap and take a newer complete
        // snapshot while the stream remains buffered.
        if (bufferOverflowed) {
          buffered.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = false;
          continue;
        }

        // Drain in batches while KEEPING buffering enabled. Events can arrive
        // while an indexed event awaits its detail fetch; they join the next
        // batch, and ready cannot win that race. The empty check and the final
        // buffering=false flip are synchronous, so no event can slip between.
        while (
          buffered.length > 0 &&
          !bufferOverflowed &&
          streamConnected &&
          snapshotGeneration === streamOpenGeneration
        ) {
          const batch = buffered.splice(0);
          bufferedBytes = 0;
          for (const ev of batch) {
            await applyEvent(ev);
            if (
              stopped ||
              bufferOverflowed ||
              !streamConnected ||
              snapshotGeneration !== streamOpenGeneration
            ) break;
          }
          if (stopped) return;
        }
        if (
          bufferOverflowed ||
          !streamConnected ||
          snapshotGeneration !== streamOpenGeneration
        ) {
          buffered.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = false;
          if (!streamConnected || snapshotGeneration !== streamOpenGeneration) return;
          continue;
        }

        try {
          // A long buffered detail drain can outlive the health observation.
          // Recheck its local freshness before this generation becomes usable.
          installCurrent(health, snapshotGeneration);
        } catch (error) {
          const failure = currentnessFailure(error);
          setBlocked(failure.reason);
          throw failure;
        }
        buffering = false;
        readySettled = true;
        if (readinessTimer) clearTimeout(readinessTimer);
        readinessTimer = null;
        log(`[solver] book ready — ${book.size} live offers`);
        resolveReady();
        return;
      }
    });
    initialAttempt = attempt;
    void attempt
      .catch(() => {
        // The queue reports the concrete error. Preserve the buffer and let a
        // reconnect/periodic/manual resync make a fresh attempt.
        buffering = true;
      })
      .finally(() => {
        if (initialAttempt === attempt) initialAttempt = null;
        if (retryInitialAfterAttempt) {
          retryInitialAfterAttempt = false;
          if (buffering && !stopped && !readySettled) {
            void ensureInitialSync().catch(() => {});
          }
        }
      });
    return attempt;
  };

  stream = dependencies.openSseStream(
    (ev) => {
      if (buffering) {
        if (bufferOverflowed) return;
        let eventBytes: number;
        try {
          eventBytes = new TextEncoder().encode(JSON.stringify(ev)).byteLength;
        } catch {
          eventBytes = maxBufferedBytes + 1;
        }
        if (
          buffered.length >= maxBufferedEvents ||
          eventBytes > maxBufferedBytes - bufferedBytes
        ) {
          bufferOverflowed = true;
          buffered.length = 0;
          bufferedBytes = 0;
          reportError(
            new Error(
              `startup SSE buffer exceeded ${maxBufferedEvents} events or ` +
                `${maxBufferedBytes} bytes; ` +
                "discarding the gap and repeating the authoritative snapshot",
            ),
          );
          return;
        }
        buffered.push(ev);
        bufferedBytes += eventBytes;
        return;
      }
      enqueue(() => applyEvent(ev));
    },
    {
      ...(api ? { api } : {}),
      onOpen: () => {
        streamConnected = true;
        streamOpenGeneration++;
        // Also fires on the first connect. During startup it drives a
        // recoverable initial attempt; afterward it closes any missed-event
        // gap with a full resync.
        if (buffering) {
          if (initialAttempt) retryInitialAfterAttempt = true;
          void ensureInitialSync().catch(() => {});
          return;
        }
        setBlocked("stream-generation-changed");
        log("[solver] SSE (re)connected — resyncing");
        void schedulePostReadyResync().catch(() => {});
      },
      onDisconnect: () => {
        streamConnected = false;
        streamOpenGeneration++;
        setBlocked("stream-disconnected");
        if (buffering) {
          buffered.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = false;
        }
      },
      onError: reportError,
    },
  );

  const scheduleHealthCheck = (): Promise<void> => {
    if (stopped || !streamConnected) return Promise.resolve();
    if (buffering) return ensureInitialSync();
    // A complete resync ends with its own generation-bound health verdict.
    if (postReadyResyncRunner) return postReadyResyncRunner;
    if (healthCheckRunner) return healthCheckRunner;

    const generation = streamOpenGeneration;
    let requestSnapshotRecovery = false;
    const runner = (async () => {
      try {
        const health = await readFreshHealth(generation);
        if (currentness.kind === "current") {
          installCurrent(health, generation);
        } else {
          // Health recovery alone cannot authorize the existing book. Close
          // the outage gap with one full snapshot in this same SSE generation.
          requestSnapshotRecovery = true;
        }
      } catch (error) {
        const failure = currentnessFailure(error);
        // A late health response from an old connection must never revoke a
        // newer generation that has already completed recovery.
        if (generation === streamOpenGeneration) setBlocked(failure.reason);
      }
    })().finally(() => {
      if (healthCheckRunner === runner) healthCheckRunner = null;
      if (requestSnapshotRecovery && !stopped && generation === streamOpenGeneration) {
        void schedulePostReadyResync().catch(() => {});
      }
    });
    healthCheckRunner = runner;
    return runner;
  };

  requestCurrentnessRecovery = (): void => {
    void scheduleHealthCheck().catch(reportError);
  };

  readinessTimer = setTimeout(() => {
    const error = new Error(
      `book synchronization readiness timed out after ${readinessTimeoutMs} ms`,
    );
    void stopSynchronization(error).catch(reportError);
  }, readinessTimeoutMs);

  resyncTimer = setInterval(() => {
    if (stopped) return;
    if (buffering) {
      if (streamConnected && streamOpenGeneration > 0) {
        void ensureInitialSync().catch(() => {});
      }
    }
    else void schedulePostReadyResync().catch(() => {});
  }, resyncIntervalMs);
  resyncTimer.unref?.();

  healthCheckTimer = setInterval(() => {
    if (!stopped) void scheduleHealthCheck().catch(reportError);
  }, backendHealthCheckIntervalMs);
  healthCheckTimer.unref?.();

  sweepTimer = setInterval(() => {
    if (stopped) return;
    for (const offerHash of book.sweepExpired(Date.now(), expiryMarginSeconds)) {
      emit({ kind: "removed", offerHash, reason: "expired" });
    }
  }, 1000);
  sweepTimer.unref?.();

  return {
    book,
    ready,
    isCurrent: () => currentness.kind === "current" && !stopped,
    currentness: () => currentness,
    resync: () => {
      if (buffering) return ensureInitialSync();
      return schedulePostReadyResync();
    },
    stop: () => stopSynchronization(),
  };
}
