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
}

export interface SyncHandle {
  readonly book: Book;
  /** Resolves once the first full page-through has been applied. */
  ready: Promise<void>;
  resync: () => Promise<void>;
  stop: () => void;
}

const PAGE_LIMIT = 100;

/** Walk every page of the live book. */
export async function fetchWholeBook(api?: string): Promise<BookOffer[]> {
  const offers: BookOffer[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await getZswapsPage({ limit: PAGE_LIMIT, api, ...(cursor ? { after_hash: cursor } : {}) });
    for (const row of page.offers) {
      const parsed = bookOfferFromApi(row);
      if (parsed) offers.push(parsed);
    }
    if (!page.nextCursor) return offers;
    cursor = page.nextCursor;
  }
}

export function startBookSync(opts: SyncOptions = {}): SyncHandle {
  const book = opts.book ?? new Book();
  const api = opts.api;
  const log = opts.log ?? (() => {});
  const expiryMarginSeconds = opts.expiryMarginSeconds ?? 120;
  const resyncIntervalMs = opts.resyncIntervalMs ?? 300_000;

  let stopped = false;
  let buffering = true;
  const buffered: SseEvent[] = [];
  let stream: SseStreamHandle | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> = Promise.resolve();

  const emit = (change: BookChange): void => {
    try {
      opts.onChange?.(change);
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const removeAndEmit = (offerHash: string, reason: "consumed" | "expired" | "resync"): void => {
    if (book.remove(offerHash)) emit({ kind: "removed", offerHash, reason });
  };

  const addByHash = async (offerHash: string): Promise<void> => {
    if (book.get(offerHash)) return;
    // The detail row is the only one carrying nullifiers, expiry, AND the blob,
    // so one fetch here saves a second round trip at settlement time.
    const detail = await getZswapByHash(offerHash, api);
    const parsed = bookOfferFromApi(detail);
    if (!parsed) return;
    book.upsert(parsed);
    emit({ kind: "added", offer: parsed });
  };

  const applyEvent = async (ev: SseEvent): Promise<void> => {
    switch (ev.type) {
      case "offer_indexed":
        await addByHash(ev.offerHash.toLowerCase());
        return;
      case "offer_consumed": {
        if (ev.offerHash) {
          removeAndEmit(ev.offerHash.toLowerCase(), "consumed");
          return;
        }
        // Pre-offerHash nodes identify a consumption only by the spent
        // nullifier; the numeric offerId in the event has no REST counterpart.
        if (ev.nullifier) {
          const hash = book.removeByNullifier(ev.nullifier);
          if (hash) emit({ kind: "removed", offerHash: hash, reason: "consumed" });
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
  const enqueue = (fn: () => Promise<void>): void => {
    pending = pending.then(fn).catch((err) => opts.onError?.(err));
  };

  const resync = async (): Promise<void> => {
    const offers = await fetchWholeBook(api);
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

  let resolveReady: () => void;
  let rejectReady: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  stream = openSseStream(
    (ev) => {
      if (buffering) {
        buffered.push(ev);
        return;
      }
      enqueue(() => applyEvent(ev));
    },
    {
      ...(api ? { api } : {}),
      onOpen: () => {
        // Also fires on the first connect; the initial page-through below is
        // that first resync, so skip re-running it before we are ready.
        if (buffering) return;
        log("[solver] SSE (re)connected — resyncing");
        enqueue(resync);
      },
      onError: opts.onError ?? (() => {}),
    },
  );

  void (async () => {
    try {
      await resync();
      buffering = false;
      for (const ev of buffered.splice(0)) enqueue(() => applyEvent(ev));
      log(`[solver] book ready — ${book.size} live offers`);
      resolveReady();
    } catch (err) {
      buffering = false;
      rejectReady(err);
    }
  })();

  resyncTimer = setInterval(() => {
    if (!stopped) enqueue(resync);
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
      const done = pending.then(resync);
      pending = done.catch((err) => opts.onError?.(err));
      return done;
    },
    stop: () => {
      stopped = true;
      stream?.close();
      if (resyncTimer) clearInterval(resyncTimer);
      if (sweepTimer) clearInterval(sweepTimer);
    },
  };
}
