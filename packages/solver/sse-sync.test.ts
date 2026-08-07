import { expect, mock, test } from "bun:test";

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
let sseHandlers: { onEvent: (ev: unknown) => void; onOpen?: () => void } | null = null;
let sseOpens = 0;

mock.module("@zswap-da/solver-core/api-client", () => ({
  getZswapsPage: async (params: { after_hash?: string }) => {
    pageRequests.push(params.after_hash);
    return pagesByCursor.get(params.after_hash ?? "") ?? { offers: [], nextCursor: null };
  },
  getZswapByHash: async (hash: string) => detailByHash.get(hash),
  openSseStream: (onEvent: (ev: unknown) => void, opts: { onOpen?: () => void }) => {
    sseHandlers = { onEvent, ...(opts.onOpen ? { onOpen: opts.onOpen } : {}) };
    sseOpens++;
    // The real client fires onOpen on the first connect too.
    opts.onOpen?.();
    return { close: () => {} };
  },
}));

const { startBookSync, fetchWholeBook } = await import("./src/sse-sync.ts");

const A = "a".repeat(64);
const B = "b".repeat(64);

const row = (hash: string) => ({
  version: 1,
  offerId: hash,
  computed: {
    gives: [{ token: A, amount: "1000", type: "SHIELDED" }],
    wants: [{ token: B, amount: "900", type: "SHIELDED" }],
    expiresAt: null,
    firstSeenAt: null,
    inputNullifiers: [`n-${hash}`],
    status: "live",
  },
});

const reset = () => {
  pagesByCursor.clear();
  detailByHash.clear();
  pageRequests = [];
  sseHandlers = null;
  sseOpens = 0;
};

const settle = () => new Promise((r) => setTimeout(r, 5));

test("fetchWholeBook follows the cursor across every page", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1"), row("h2")], nextCursor: "h2" });
  pagesByCursor.set("h2", { offers: [row("h3")], nextCursor: "h3" });
  pagesByCursor.set("h3", { offers: [row("h4")], nextCursor: null });

  const offers = await fetchWholeBook();
  expect(offers.map((o) => o.offerHash)).toEqual(["h1", "h2", "h3", "h4"]);
  // The first request carries no cursor; each later one carries the previous
  // page's nextCursor. A truncated walk would silently hide most of the book.
  expect(pageRequests).toEqual([undefined, "h2", "h3"]);
});

test("fetchWholeBook stops at a page that reports no successor", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });
  expect((await fetchWholeBook()).map((o) => o.offerHash)).toEqual(["h1"]);
  expect(pageRequests).toEqual([undefined]);
});

test("fetchWholeBook skips rows with no content hash rather than aborting", async () => {
  reset();
  const headless = { ...row("h1"), offerId: null };
  pagesByCursor.set("", { offers: [headless, row("h2")], nextCursor: null });
  expect((await fetchWholeBook()).map((o) => o.offerHash)).toEqual(["h2"]);
});

test("the initial page-through seeds the book before ready resolves", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1"), row("h2")], nextCursor: null });

  const sync = startBookSync({ resyncIntervalMs: 60_000 });
  await sync.ready;
  expect(sync.book.hashes().sort()).toEqual(["h1", "h2"]);
  sync.stop();
});

test("events arriving during the page-through are replayed, not lost", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });
  detailByHash.set("h2", row("h2"));

  const sync = startBookSync({ resyncIntervalMs: 60_000 });
  // Fired before the page-through completes — the real stream opens first
  // precisely so this window is covered.
  sseHandlers!.onEvent({ type: "offer_indexed", offerId: 2, offerHash: "h2" });

  await sync.ready;
  await settle();
  expect(sync.book.hashes().sort()).toEqual(["h1", "h2"]);
  sync.stop();
});

test("a reconnect triggers a full resync, picking up what the gap missed", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });

  const changes: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
    onChange: (c) => changes.push(c.kind === "added" ? `+${c.offer.offerHash}` : `-${c.offerHash}`),
  });
  await sync.ready;
  expect(sync.book.hashes()).toEqual(["h1"]);
  expect(sseOpens).toBe(1);

  // While the stream was down: h1 was consumed and h2 appeared. No events for
  // either — the stream has no replay, so only a resync can recover them.
  pagesByCursor.set("", { offers: [row("h2")], nextCursor: null });
  sseHandlers!.onOpen!();
  await settle();

  expect(sync.book.hashes()).toEqual(["h2"]);
  expect(changes).toContain("-h1");
  expect(changes).toContain("+h2");
  sync.stop();
});

test("resync reports removals with the resync reason, not a fabricated consumption", async () => {
  reset();
  pagesByCursor.set("", { offers: [row("h1")], nextCursor: null });

  const reasons: string[] = [];
  const sync = startBookSync({
    resyncIntervalMs: 60_000,
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
  sync.stop();
});
