import { expect, test } from "bun:test";

// Two paths that only bite in production: a book bigger than one page, and a
// dropped stream. Both are invisible in a small, stable dev book — the mirror
// just looks right — so they are pinned here rather than left to a live run.
//
// The stream here is the websocket update stream. Its client is stubbed at the
// dependency seam, so these cases pin the MIRROR's behaviour: which triggers
// authorize a snapshot, what a drop does to currentness, and how the
// subscription's L2 anchor gates it. The transport itself (frames, sequence
// gaps, reconnects) is pinned in solver-core's api-client tests, and the two
// halves are exercised together against a real backend in the node package's
// offer-updates-mirror suite.

interface StubPage {
  offers: unknown[];
  nextCursor: string | null;
}

/** One stub subscription announcement — the `ready` frame's payload. */
const STUB_STREAM_ID = "0".repeat(32);

const pagesByCursor = new Map<string, StubPage>();
const detailByHash = new Map<string, unknown>();
let pageRequests: Array<string | undefined> = [];
let streamHandlers: {
  onEvent: (ev: unknown) => void;
  onOpen?: (subscription: { streamId: string; blockL2Height: string | null }) => void;
  onDisconnect?: () => void;
} | null = null;
let streamOpens = 0;
/** Anchor the stub subscription reports at `ready`. */
let subscriptionAnchor: string | null = null;
let pageFailures = 0;
let pageLoader: ((params: { after_hash?: string }) => Promise<StubPage>) | null = null;
let detailLoader: ((hash: string) => Promise<unknown>) | null = null;
let closeStream: () => Promise<void> = async () => {};
let openImmediately = true;
let healthRequests = 0;
let healthLoader: (() => Promise<any>) | null = null;

const subscription = (): { streamId: string; blockL2Height: string | null } => ({
  streamId: STUB_STREAM_ID,
  blockL2Height: subscriptionAnchor,
});

const healthySync = () => ({
  ts: Date.now(),
  status: "ok" as const,
  blockL2: { height: "1" },
  ntp: { current: 1, tip: 1, pct: 100, lagBlocks: 0, lagSeconds: 0 },
  midnight: { current: 1, fetched: 1, tip: 1, pct: 100, lagBlocks: 0 },
  celestia: { current: 1, fetched: 1, tip: 1, pct: 100, lagBlocks: 0 },
});

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
  getBackendSyncHealth: async () => {
    healthRequests++;
    return healthLoader ? healthLoader() : healthySync();
  },
  openUpdatesStream: (
    onEvent: (ev: unknown) => void,
    opts: {
      onOpen?: (subscription: { streamId: string; blockL2Height: string | null }) => void;
      onDisconnect?: () => void;
    },
  ) => {
    streamHandlers = {
      onEvent,
      ...(opts.onOpen ? { onOpen: opts.onOpen } : {}),
      ...(opts.onDisconnect ? { onDisconnect: opts.onDisconnect } : {}),
    };
    streamOpens++;
    // Most tests model the real client's first successful subscription. A few
    // hold this callback to prove REST readiness cannot outrun subscription.
    if (openImmediately) opts.onOpen?.(subscription());
    return { close: () => closeStream() };
  },
} as any;

const { startBookSync, fetchWholeBook } = await import("./src/book-sync.ts");

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
  streamHandlers = null;
  streamOpens = 0;
  subscriptionAnchor = null;
  pageFailures = 0;
  pageLoader = null;
  detailLoader = null;
  closeStream = async () => {};
  openImmediately = true;
  healthRequests = 0;
  healthLoader = null;
};

const settle = () => new Promise((r) => setTimeout(r, 5));

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

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
  expect(streamOpens).toBe(0);
});

test("the initial page-through seeds the book before ready resolves", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1"), row("h2")], nextCursor: null });

  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;
  expect(sync.book.hashes().sort()).toEqual([id("h1"), id("h2")].sort());
  await sync.stop();
});

test("readiness cannot outrun the first confirmed subscription", async () => {
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

  streamHandlers!.onOpen!(subscription());
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
  streamHandlers!.onOpen!(subscription());
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
  streamHandlers!.onDisconnect!();
  releaseFirst();
  let ready = false;
  void sync.ready.then(() => {
    ready = true;
  });
  await settle();
  expect(ready).toBe(false);
  expect(snapshots).toBe(1);

  streamHandlers!.onOpen!(subscription());
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
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });

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
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 1, offerHash: id("h1") });
  await firstStarted;
  // This arrives while h1's buffered event is awaiting its detail. It must
  // remain part of the startup barrier rather than being queued behind ready.
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });
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
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 1, offerHash: id("discarded-1") });
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("discarded-2") });
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
  streamHandlers!.onEvent({
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

  streamHandlers!.onOpen!(subscription());
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
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });
  await Promise.resolve();

  const stopped = sync.stop();
  releaseDetail?.(row("h2"));
  await stopped;
  expect(changes).toEqual([]);
  expect(sync.book.hashes()).toEqual([]);
});

test("stop awaits the underlying stream lifecycle barrier", async () => {
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
  expect(streamOpens).toBe(1);

  // While the stream was down: h1 was consumed and h2 appeared. No events for
  // either — the stream has no replay, so only a resync can recover them.
  pagesByCursor.set("", { offers: [row("h2")], nextCursor: null });
  streamHandlers!.onOpen!(subscription());
  await settle();

  expect(sync.book.hashes()).toEqual([id("h2")]);
  expect(changes).toContain(`-${id("h1")}`);
  expect(changes).toContain(`+${id("h2")}`);
  await sync.stop();
});

test("post-ready recovery drains events queued during the snapshot before restoring currentness", async () => {
  reset();
  pagesByCursor.set("", { offers: [], nextCursor: null });
  const states: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    dependencies,
    onCurrentnessChange: (state) => states.push(state.kind),
  });
  await sync.ready;
  expect(sync.isCurrent()).toBe(true);

  let releaseSnapshot!: () => void;
  let snapshotStarted!: () => void;
  const snapshotHeld = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const sawSnapshot = new Promise<void>((resolve) => { snapshotStarted = resolve; });
  pageLoader = async () => {
    snapshotStarted();
    await snapshotHeld;
    return { offers: [], nextCursor: null };
  };

  let releaseDetail!: (value: unknown) => void;
  let detailStarted!: () => void;
  const detailHeld = new Promise<unknown>((resolve) => { releaseDetail = resolve; });
  const sawDetail = new Promise<void>((resolve) => { detailStarted = resolve; });
  detailLoader = async () => {
    detailStarted();
    return detailHeld;
  };

  streamHandlers!.onOpen!(subscription());
  await sawSnapshot;
  streamHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: id("h2") });
  releaseSnapshot();
  await sawDetail;

  // The snapshot has completed and its health response is current, but the
  // mutation that raced it is still waiting for detail. Recovery must remain
  // blocked until that queued gap is fully applied.
  expect(sync.isCurrent()).toBe(false);
  expect(states).toEqual(["blocked", "current", "blocked"]);

  releaseDetail(row("h2"));
  await waitUntil(() => sync.isCurrent(), "post-snapshot event drain");
  expect(sync.book.hashes()).toEqual([id("h2")]);
  expect(states).toEqual(["blocked", "current", "blocked", "current"]);
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

  streamHandlers!.onOpen!(subscription());
  await active;
  for (let i = 0; i < 100; i++) streamHandlers!.onOpen!(subscription());
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
  streamHandlers!.onEvent({
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

// ── the subscription's rewind anchor ─────────────────────────────────────────
//
// The `ready` frame reports the committed L2 height the backend had when the
// subscription was registered. Heights only advance, so a later health verdict
// BELOW that floor is proof the backend's projection moved backwards — a
// restore, or a lagging replica behind a load balancer. No snapshot can repair
// that: every row such a backend serves is consistent with a past the solver
// has already left, so the cache must stop being treated as current.

test("a backend that reports a height below the subscription anchor is not current", async () => {
  reset();
  subscriptionAnchor = "100";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "99" } });
  const states: any[] = [];

  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 300,
    dependencies,
    onCurrentnessChange: (state) => states.push(state),
  });
  await expect(sync.ready).rejects.toThrow();
  expect(sync.isCurrent()).toBe(false);
  expect(states.some((state) => state.reason === "backend-rewound")).toBe(true);
  await sync.stop();
});

test("an anchor the backend has reached or passed is current", async () => {
  reset();
  subscriptionAnchor = "100";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "100" } });
  const equal = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await equal.ready;
  expect(equal.isCurrent()).toBe(true);
  await equal.stop();

  reset();
  subscriptionAnchor = "100";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "101" } });
  const ahead = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await ahead.ready;
  expect(ahead.isCurrent()).toBe(true);
  await ahead.stop();
});

test("anchors are compared as u64 tokens, not as doubles", async () => {
  reset();
  // These two are the same number once either becomes a JavaScript double.
  subscriptionAnchor = "9007199254740993";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "9007199254740992" } });
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 300,
    dependencies,
  });
  await expect(sync.ready).rejects.toThrow();
  expect(sync.currentness()).toMatchObject({ kind: "blocked" });
  await sync.stop();
});

test("a subscription that reports no anchor imposes no rewind constraint", async () => {
  reset();
  subscriptionAnchor = null;
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "1" } });
  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;
  expect(sync.isCurrent()).toBe(true);
  await sync.stop();
});

test("a resubscription installs its own anchor rather than inheriting the old one", async () => {
  reset();
  subscriptionAnchor = "10";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "10" } });
  const sync = startBookSync({ resyncIntervalMs: 60_000, dependencies });
  await sync.ready;
  expect(sync.isCurrent()).toBe(true);

  // The backend advanced, then the stream dropped and came back with a newer
  // floor. The old, lower anchor must not keep authorizing it.
  streamHandlers!.onDisconnect!();
  subscriptionAnchor = "20";
  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "15" } });
  streamHandlers!.onOpen!(subscription());
  await waitUntil(
    () => sync.currentness().kind === "blocked" &&
      (sync.currentness() as any).reason === "backend-rewound",
    "the new anchor to refuse a stale height",
  );

  healthLoader = async () => ({ ...healthySync(), blockL2: { height: "20" } });
  await sync.resync();
  expect(sync.isCurrent()).toBe(true);
  await sync.stop();
});
