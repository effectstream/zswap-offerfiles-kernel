import { expect, test } from "bun:test";

// Two paths that only bite in production: a book bigger than one page, and a
// dropped stream. Both are invisible in a small, stable dev book — the mirror
// just looks right — so they are pinned here rather than left to a live run.

interface StubPage {
  offers: unknown[];
  nextCursor: string | null;
}

const pagesByCursor = new Map<string, StubPage>();
const detailByHash = new Map<string, unknown>();
let pageRequests: Array<string | undefined> = [];
let sseHandlers: {
  onEvent: (ev: unknown) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
} | null = null;
let sseOpens = 0;
let pageFailures = 0;
let pageLoader: ((params: { after_hash?: string }) => Promise<StubPage>) | null = null;
let detailLoader: ((hash: string) => Promise<unknown>) | null = null;
let closeStream: () => Promise<void> = async () => {};
let openImmediately = true;

const dependencies = {
  getZswapsPage: async (params: { after_hash?: string }) => {
    pageRequests.push(params.after_hash);
    if (pageFailures > 0) {
      pageFailures--;
      throw new Error("snapshot unavailable");
    }
    if (pageLoader) return pageLoader(params);
    return pagesByCursor.get(params.after_hash ?? "") ?? { offers: [], nextCursor: null };
  },
  getZswapByHash: async (hash: string) =>
    detailLoader ? detailLoader(hash) : detailByHash.get(hash),
  openSseStream: (
    onEvent: (ev: unknown) => void,
    opts: { onOpen?: () => void; onDisconnect?: () => void },
  ) => {
    sseHandlers = {
      onEvent,
      ...(opts.onOpen ? { onOpen: opts.onOpen } : {}),
      ...(opts.onDisconnect ? { onDisconnect: opts.onDisconnect } : {}),
    };
    sseOpens++;
    // Most tests model the real client's first successful connection. A few
    // hold this callback to prove REST readiness cannot outrun subscription.
    if (openImmediately) opts.onOpen?.();
    return { close: () => closeStream() };
  },
} as any;

const { startBookSync, fetchWholeBook } = await import("./src/sse-sync.ts");

const A = "a".repeat(64);
const B = "b".repeat(64);

const id = (label: string): string => {
  if (/^[0-9a-f]{64}$/i.test(label)) return label.toLowerCase();
  const hex = [...new TextEncoder().encode(label)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hex.padEnd(64, "0").slice(0, 64);
};

const row = (hash: string, nullifier = id(`n-${hash}`)) => ({
  version: 1,
  offerId: id(hash),
  computed: {
    gives: [{ token: A, amount: "1000", type: "SHIELDED" }],
    wants: [{ token: B, amount: "900", type: "SHIELDED" }],
    expiresAt: "2099-01-01T00:00:00.000Z",
    firstSeenAt: null,
    inputNullifiers: [nullifier],
    status: "live",
  },
});

const reset = () => {
  pagesByCursor.clear();
  detailByHash.clear();
  pageRequests = [];
  sseHandlers = null;
  sseOpens = 0;
  pageFailures = 0;
  pageLoader = null;
  detailLoader = null;
  closeStream = async () => {};
  openImmediately = true;
};

const settle = () => new Promise((r) => setTimeout(r, 5));

test("fetchWholeBook follows the cursor across every page", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1"), row("h2")], nextCursor: id("h2") });
  pagesByCursor.set(id("h2"), { offers: [row("h3")], nextCursor: id("h3") });
  pagesByCursor.set(id("h3"), { offers: [row("h4")], nextCursor: null });

  const offers = await fetchWholeBook(undefined, undefined, dependencies);
  expect(offers.map((o) => o.offerHash)).toEqual([id("h1"), id("h2"), id("h3"), id("h4")]);
  // The first request carries no cursor; each later one carries the previous
  // page's nextCursor. A truncated walk would silently hide most of the book.
  expect(pageRequests).toEqual([undefined, id("h2"), id("h3")]);
});

test("fetchWholeBook stops at a page that reports no successor", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });
  expect((await fetchWholeBook(undefined, undefined, dependencies)).map((o) => o.offerHash)).toEqual([id("h1")]);
  expect(pageRequests).toEqual([undefined]);
});

test("fetchWholeBook skips rows with no content hash rather than aborting", async () => {
  reset();
  const headless = { ...row("h1"), offerId: null };
  pagesByCursor.set("", { offers: [headless, row("h2")], nextCursor: null });
  expect((await fetchWholeBook(undefined, undefined, dependencies)).map((o) => o.offerHash)).toEqual([id("h2")]);
});

test("fetchWholeBook rejects a cursor cycle after bounded requests", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: id("cycle") });
  pagesByCursor.set(id("cycle"), { offers: [], nextCursor: id("cycle") });

  await expect(fetchWholeBook(undefined, undefined, dependencies)).rejects.toThrow(/cursor cycle/);
  expect(pageRequests).toEqual([undefined, id("cycle")]);
});

test("fetchWholeBook enforces page and row caps", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("a1"), row("a2")], nextCursor: id("next") });
  pagesByCursor.set(id("next"), { offers: [row("a3")], nextCursor: null });
  await expect(
    fetchWholeBook(undefined, undefined, dependencies, { maxPages: 1, maxOffers: 10 }),
  ).rejects.toThrow(/exceeded 1 pages/);
  expect(pageRequests.length).toBe(1);

  reset();
  pagesByCursor.set("", { offers: [row("a1"), row("a2")], nextCursor: null });
  await expect(
    fetchWholeBook(undefined, undefined, dependencies, { maxPages: 10, maxOffers: 1 }),
  ).rejects.toThrow(/exceeded 1 rows/);
  expect(pageRequests.length).toBe(1);
});

test("startBookSync rejects a non-positive resync interval before opening a stream", () => {
  reset();
  expect(() => startBookSync({ resyncIntervalMs: 0, dependencies })).toThrow(
    "resyncIntervalMs must be a positive safe integer",
  );
  expect(sseOpens).toBe(0);
});

test("the initial page-through seeds the book before ready resolves", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1"), row("h2")], nextCursor: null });

  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;
  expect(sync.book.hashes().sort()).toEqual([id("h1"), id("h2")].sort());
  await sync.stop();
});

test("readiness cannot outrun the first confirmed SSE subscription", async () => {
  reset();
  openImmediately = false;
  pagesByCursor.set("", { offers: [row("after-open")], nextCursor: null });

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 1_000,
    dependencies,
  });
  let ready = false;
  void sync.ready.then(() => {
    ready = true;
  });
  await settle();
  expect(ready).toBe(false);
  expect(pageRequests).toEqual([]);

  sseHandlers!.onOpen!();
  await sync.ready;
  expect(sync.book.hashes()).toEqual([id("after-open")]);
  await sync.stop();
});

test("a reconnect during the initial snapshot forces a post-reconnect snapshot", async () => {
  reset();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let snapshots = 0;
  pageLoader = async () => {
    snapshots++;
    if (snapshots === 1) {
      firstStarted();
      await first;
      return { offers: [row("stale-before-gap")], nextCursor: null };
    }
    return { offers: [row("authoritative-after-gap")], nextCursor: null };
  };

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 1_000,
    dependencies,
  });
  await started;
  sseHandlers!.onOpen!();
  releaseFirst();

  await sync.ready;
  expect(snapshots).toBe(2);
  expect(sync.book.hashes()).toEqual([id("authoritative-after-gap")]);
  await sync.stop();
});

test("clean disconnect during the initial snapshot cannot resolve readiness in the outage", async () => {
  reset();
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let snapshots = 0;
  pageLoader = async () => {
    snapshots++;
    if (snapshots === 1) {
      firstStarted();
      await first;
      return { offers: [row("stale-before-disconnect")], nextCursor: null };
    }
    return { offers: [row("authoritative-after-reconnect")], nextCursor: null };
  };

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 1_000,
    dependencies,
  });
  await started;
  sseHandlers!.onDisconnect!();
  releaseFirst();
  let ready = false;
  void sync.ready.then(() => {
    ready = true;
  });
  await settle();
  expect(ready).toBe(false);
  expect(snapshots).toBe(1);

  sseHandlers!.onOpen!();
  await sync.ready;
  expect(snapshots).toBe(2);
  expect(sync.book.hashes()).toEqual([id("authoritative-after-reconnect")]);
  await sync.stop();
});

test("a stream that never opens fails readiness without taking a gap-prone snapshot", async () => {
  reset();
  openImmediately = false;
  pagesByCursor.set("", { offers: [row("must-not-load")], nextCursor: null });
  let closeCalls = 0;
  closeStream = async () => {
    closeCalls++;
  };

  const sync = startBookSync({
    // The periodic retry fires before the readiness deadline; it must still
    // not authorize a REST-first snapshot without a confirmed subscription.
    resyncIntervalMs: 5,
    readinessTimeoutMs: 20,
    dependencies,
  });
  await expect(sync.ready).rejects.toThrow(
    "book synchronization readiness timed out after 20 ms",
  );
  expect(pageRequests).toEqual([]);
  await sync.stop();
  expect(closeCalls).toBe(1);
});

test("ready waits until events buffered during page-through are applied", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });
  detailByHash.set(id("h2"), row("h2"));

  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  // Fired before the page-through completes — the real stream opens first
  // precisely so this window is covered.
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });

  await sync.ready;
  expect(sync.book.hashes().sort()).toEqual([id("h1"), id("h2")].sort());
  await sync.stop();
});

test("ready drains an event that arrives during a slow buffered detail fetch", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: null });
  let detailStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    detailStarted = resolve;
  });
  const firstDetail = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  detailLoader = async (hash) => {
    if (hash === id("h1")) {
      detailStarted();
      await firstDetail;
    }
    return row(hash);
  };

  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 1, offerHash: id("h1") });
  await firstStarted;
  // This arrives while h1's buffered event is awaiting its detail. It must
  // remain part of the startup barrier rather than being queued behind ready.
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });
  releaseFirst();

  await sync.ready;
  expect(sync.book.hashes().sort()).toEqual([id("h1"), id("h2")].sort());
  await sync.stop();
});

test("startup buffer overflow stays bounded and forces a newer snapshot", async () => {
  reset();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let snapshots = 0;
  pageLoader = async () => {
    snapshots++;
    if (snapshots === 1) {
      firstStarted();
      await first;
      return { offers: [], nextCursor: null };
    }
    return { offers: [row("authoritative")], nextCursor: null };
  };
  const errors: string[] = [];

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    maxBufferedEvents: 1,
    onError: (err) => errors.push(err instanceof Error ? err.message : String(err)),
  });
  await started;
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 1, offerHash: id("discarded-1") });
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("discarded-2") });
  releaseFirst();

  await sync.ready;
  expect(snapshots).toBe(2);
  expect(errors.some((message) => message.includes("buffer exceeded 1"))).toBe(true);
  expect(sync.book.hashes()).toEqual([id("authoritative")]);
  await sync.stop();
});

test("startup buffer has a cumulative byte budget independent of event count", async () => {
  reset();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let snapshots = 0;
  pageLoader = async () => {
    snapshots++;
    if (snapshots === 1) {
      firstStarted();
      await first;
      return { offers: [], nextCursor: null };
    }
    return { offers: [row("byte-authoritative")], nextCursor: null };
  };
  const errors: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    maxBufferedEvents: 100,
    maxBufferedBytes: 32,
    onError: (err) => errors.push(String(err)),
  });
  await started;
  sseHandlers!.onEvent({
    type: "offer_rejected",
    reason: "x".repeat(128),
    blockHeight: 1,
    timestamp: 1,
  });
  releaseFirst();

  await sync.ready;
  expect(snapshots).toBe(2);
  expect(errors.some((message) => message.includes("32 bytes"))).toBe(true);
  expect(sync.book.hashes()).toEqual([id("byte-authoritative")]);
  await sync.stop();
});

test("an initial snapshot failure is recoverable on reconnect", async () => {
  reset();
  pageFailures = 1;
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });
  const errors: unknown[] = [];

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onError: (err) => errors.push(err),
  });
  await settle();
  expect(errors.length).toBe(1);

  sseHandlers!.onOpen!();
  await sync.ready;
  expect(sync.book.hashes()).toEqual([id("h1")]);
  await sync.stop();
});

test("permanent initial snapshot failure rejects readiness and closes at its deadline", async () => {
  reset();
  pageLoader = async () => {
    throw new Error("snapshot permanently unavailable");
  };
  let closeCalls = 0;
  closeStream = async () => {
    closeCalls++;
  };

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 20,
    dependencies,
  });
  await expect(sync.ready).rejects.toThrow(
    "book synchronization readiness timed out after 20 ms",
  );
  await sync.stop();
  expect(closeCalls).toBe(1);
});

test("stop drains an in-flight detail fetch and suppresses its late change", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: null });
  let releaseDetail: ((value: unknown) => void) | undefined;
  detailLoader = () => new Promise((resolve) => {
    releaseDetail = resolve;
  });
  const changes: string[] = [];

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onChange: (change) => changes.push(change.kind),
  });
  await sync.ready;
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });
  await Promise.resolve();

  const stopped = sync.stop();
  releaseDetail?.(row("h2"));
  await stopped;
  expect(changes).toEqual([]);
  expect(sync.book.hashes()).toEqual([]);
});

test("stop awaits the underlying SSE lifecycle barrier", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: null });
  let releaseClose!: () => void;
  closeStream = () => new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;

  let stopped = false;
  const stopping = sync.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  releaseClose();
  await stopping;
  expect(stopped).toBe(true);
});

test("a reconnect triggers a full resync, picking up what the gap missed", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });

  const changes: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onChange: (c) => changes.push(c.kind === "added" ? `+${c.offer.offerHash}` : `-${c.offerHash}`),
  });
  await sync.ready;
  expect(sync.book.hashes()).toEqual([id("h1")]);
  expect(sseOpens).toBe(1);

  // While the stream was down: h1 was consumed and h2 appeared. No events for
  // either — the stream has no replay, so only a resync can recover them.
  pagesByCursor.set("", { offers: [row("h2")], nextCursor: null });
  sseHandlers!.onOpen!();
  await settle();

  expect(sync.book.hashes()).toEqual([id("h2")]);
  expect(changes).toContain(`-${id("h1")}`);
  expect(changes).toContain(`+${id("h2")}`);
  await sync.stop();
});

test("post-ready reconnect storms coalesce to one active and one latest snapshot", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: null });
  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;

  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let postReadySnapshots = 0;
  pageLoader = async () => {
    postReadySnapshots++;
    if (postReadySnapshots === 1) {
      started();
      await held;
    }
    return { offers: [], nextCursor: null };
  };

  sseHandlers!.onOpen!();
  await active;
  for (let i = 0; i < 100; i++) sseHandlers!.onOpen!();
  const manual = sync.resync();
  release();
  await manual;
  expect(postReadySnapshots).toBe(2);
  await sync.stop();
});

test("resync reports removals with the resync reason, not a fabricated consumption", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });

  const reasons: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onChange: (c) => {
      if (c.kind === "removed") reasons.push(c.reason);
    },
  });
  await sync.ready;

  pagesByCursor.set("", { offers: [], nextCursor: null });
  await sync.resync();
  // The offer left the book, but this node never saw why — claiming
  // "consumed" would tell the executor a settlement succeeded.
  expect(reasons).toEqual(["resync"]);
  await sync.stop();
});

test("a nullifier-only consumed event removes every conflicting offer", async () => {
  reset();
  pagesByCursor.set("", {
    offers: [row("h1", id("shared-nullifier")), row("h2", id("shared-nullifier"))],
    nextCursor: null,
  });
  const removed: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onChange: (change) => {
      if (change.kind === "removed") removed.push(change.offerHash);
    },
  });
  await sync.ready;
  sseHandlers!.onEvent({
    type: "offer_consumed",
    offerId: 1,
    offerHash: id("h1"),
    nullifier: id("shared-nullifier").toUpperCase(),
  });
  await settle();

  expect(sync.book.hashes()).toEqual([]);
  expect(removed.sort()).toEqual([id("h1"), id("h2")].sort());
  await sync.stop();
});
