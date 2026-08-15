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
  getZswapByHash,
  getZswapsPage,
  openSseStream,
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
  openSseStream: typeof openSseStream;
}

const DEFAULT_DEPENDENCIES: SyncDependencies = { getZswapsPage, getZswapByHash, openSseStream };

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
}

export interface SyncHandle {
  readonly book: Book;
  /** Resolves once the first full page-through and every SSE event buffered
   * during it have been applied. Initial snapshot failures are recoverable. */
  ready: Promise<void>;
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
  for (const [name, value] of [
    ["resyncIntervalMs", resyncIntervalMs],
    ["maxBufferedEvents", maxBufferedEvents],
    ["maxBufferedBytes", maxBufferedBytes],
    ["maxSnapshotPages", maxSnapshotPages],
    ["maxSnapshotOffers", maxSnapshotOffers],
    ["readinessTimeoutMs", readinessTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
    }
  }

  let stopped = false;
  let buffering = true;
  const buffered: SseEvent[] = [];
  let bufferedBytes = 0;
  let bufferOverflowed = false;
  let stream: SseStreamHandle | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> = Promise.resolve();
  let initialAttempt: Promise<void> | null = null;
  let retryInitialAfterAttempt = false;
  let streamOpenGeneration = 0;
  let streamConnected = false;
  let postReadyResyncRunner: Promise<void> | null = null;
  let postReadyResyncRequested = 0;
  let postReadyResyncCompleted = 0;
  let readySettled = false;
  let stopPromise: Promise<void> | null = null;
  let readinessTimer: ReturnType<typeof setTimeout> | null = null;
  const owner = new AbortController();

  const reportError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch {
      // Diagnostics are observers, never part of the synchronization state
      // machine. A throwing observer must not poison the work queue.
    }
  };

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

  const resync = async (): Promise<void> => {
    const offers = await fetchWholeBook(api, owner.signal, dependencies, {
      maxPages: maxSnapshotPages,
      maxOffers: maxSnapshotOffers,
    });
    if (stopped) return;
    const diff = book.resync(offers);
    for (const offerHash of diff.removed) emit({ kind: "removed", offerHash, reason: "resync" });
    for (const offerHash of diff.added) {
      const offer = book.get(offerHash);
      if (offer) emit({ kind: "added", offer });
    }
    if (diff.added.length || diff.removed.length) {
      log(`[solver] resync: +${diff.added.length} -${diff.removed.length} (book=${book.size})`);
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
            // used for SSE event detail fetches and mutations.
            await enqueue(resync);
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
    owner.abort(reason);
    const streamStopped = stream?.close() ?? Promise.resolve();
    if (resyncTimer) clearInterval(resyncTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    if (readinessTimer) clearTimeout(readinessTimer);
    readinessTimer = null;
    buffered.length = 0;
    bufferedBytes = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(reason);
    }
    stopPromise = Promise.all([pending, streamStopped]).then(() => {});
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
        await resync();
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
        log("[solver] SSE (re)connected — resyncing");
        void schedulePostReadyResync().catch(() => {});
      },
      onDisconnect: () => {
        streamConnected = false;
        streamOpenGeneration++;
        if (buffering) {
          buffered.length = 0;
          bufferedBytes = 0;
          bufferOverflowed = false;
        }
      },
      onError: reportError,
    },
  );

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
    resync: () => {
      if (buffering) return ensureInitialSync();
      return schedulePostReadyResync();
    },
    stop: () => stopSynchronization(),
  };
}
