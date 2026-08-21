import { afterEach, describe, expect, test } from "bun:test";

import type { ApiZswap } from "@zswap-da/solver-core/api-client";
import {
  parsePriceLevels,
  parseSolverCapabilities,
} from "@zswap-da/solver-core/relay-ws-contract";

import { Book, bookOfferFromApi } from "./src/book.ts";
import { deriveLadderPush, type LadderCache } from "./src/ladder-source.ts";
import {
  JOB_EXECUTION_UNAVAILABLE,
  RELAY_WS_OPEN,
  startRelayClient,
  type RelayClientEvent,
  type RelayClientHandle,
  type RelayClientTimers,
  type RelayWebSocketLike,
} from "./src/relay-client.ts";
import { startMockRelay, waitUntil, type MockRelay } from "./test-relay-mock.ts";

// The N4 relay client, proven in two ways on purpose.
//
//   1. Against a RAW RFC 6455 mock relay, driven by the PRODUCTION socket
//      factory. Bearer-at-the-upgrade, the heartbeat pong, reconnect, the
//      re-push and the withdrawal-before-close ordering are wire facts; a
//      test double cannot establish any of them.
//   2. Against an injected socket double on a manual clock, for the loop's
//      own properties — serialization/coalescing (R-07), observer containment
//      (R-37), the bounded withdrawal (R-41) and the cap-truncation signal
//      (Q-N3-1) — where determinism matters more than the wire.
//
// Nothing here asserts on elapsed wall-clock time: the derivation's `nowMs` is
// injected, part 2 owns its clock outright, and part 1 polls for observable
// state exactly as the mirror's own socket tests do.

// ── the seeded book, identical to `ladder-source.test.ts` ───────────────────

const A = `01${"00".repeat(31)}`;
const B = `02${"00".repeat(31)}`;
const C = `03${"00".repeat(31)}`;

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const EXPIRES = "2026-06-01T13:00:00.000Z";
const EXPIRY_MARGIN_SECONDS = 60;
const MAX_PARALLEL_SWAPS = 8;
/** The relay refuses a token shorter than 32 characters. */
const TOKEN = `n4${"0".repeat(62)}`;

const hash = (byte: string): string => byte.repeat(32);
const O1 = hash("11");
const O2 = hash("22");
const O3 = hash("33");
const O4 = hash("44");

const row = (
  offerId: string,
  gives: { token: string; amount: string },
  wants: { token: string; amount: string },
): ApiZswap =>
  ({
    version: 1,
    offerId,
    computed: {
      gives: [{ token: gives.token, amount: gives.amount, type: "SHIELDED" }],
      wants: [{ token: wants.token, amount: wants.amount, type: "SHIELDED" }],
      expiresAt: EXPIRES,
      firstSeenAt: "2026-06-01T11:00:00.000Z",
      inputNullifiers: [offerId],
      status: "live",
    },
  }) as ApiZswap;

/** `-10A +10B`, `-5A +5B`, `-20A +10B` — the canonical Q-R2-3 book. */
const CANONICAL_ROWS: ApiZswap[] = [
  row(O1, { token: A, amount: "10" }, { token: B, amount: "10" }),
  row(O2, { token: A, amount: "5" }, { token: B, amount: "5" }),
  row(O3, { token: A, amount: "20" }, { token: B, amount: "10" }),
];

const seed = (rows: ApiZswap[]): Book => {
  const book = new Book();
  for (const entry of rows) book.upsert(bookOfferFromApi(entry)!);
  return book;
};

interface MutableCache extends LadderCache {
  current: boolean;
}

const cacheOf = (book: Book): MutableCache => {
  const state = { current: true };
  return {
    book,
    isCurrent: () => state.current,
    get current(): boolean {
      return state.current;
    },
    set current(value: boolean) {
      state.current = value;
    },
  };
};

const expectedPush = (cache: LadderCache, overrides: { maxPairs?: number } = {}) =>
  deriveLadderPush(cache, {
    nowMs: NOW,
    expiryMarginSeconds: EXPIRY_MARGIN_SECONDS,
    maxParallelSwaps: MAX_PARALLEL_SWAPS,
    ...overrides,
  });

// ── lifecycle bookkeeping ───────────────────────────────────────────────────

const relays: MockRelay[] = [];
const clients: RelayClientHandle[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const relay of relays.splice(0)) await relay.stop();
});

async function liveRelay(): Promise<MockRelay> {
  const relay = await startMockRelay(TOKEN);
  relays.push(relay);
  return relay;
}

function connectTo(
  relay: MockRelay,
  cache: LadderCache,
  overrides: Partial<Parameters<typeof startRelayClient>[0]> = {},
): RelayClientHandle {
  const client = startRelayClient({
    url: relay.url,
    authToken: TOKEN,
    cache,
    ladder: {
      expiryMarginSeconds: EXPIRY_MARGIN_SECONDS,
      maxParallelSwaps: MAX_PARALLEL_SWAPS,
    },
    nowMs: () => NOW,
    pushIntervalMs: 40,
    reconnectDelayMs: 25,
    connectTimeoutMs: 4_000,
    withdrawTimeoutMs: 2_000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

const pushesOn = (relay: MockRelay, index = 0): number =>
  relay.connections[index]?.frames("price-levels").length ?? 0;

describe("relay client — against a raw RFC 6455 mock relay", () => {
  test("connects with the shared Bearer and pushes capabilities then levels", async () => {
    const relay = await liveRelay();
    const cache = cacheOf(seed(CANONICAL_ROWS));
    const client = connectTo(relay, cache);

    await waitUntil(() => pushesOn(relay) >= 1, "the first ladder push");
    const connection = relay.connections[0]!;
    const expected = expectedPush(cache);

    // Capabilities FIRST, then the ladder that prices them.
    expect(connection.messages[0]).toEqual(expected.capabilities as unknown as Record<string, unknown>);
    expect(connection.messages[1]).toEqual(expected.priceLevels as unknown as Record<string, unknown>);
    // And both are frames the real relay admits, checked with its own predicates.
    expect(parseSolverCapabilities(connection.messages[0])).not.toBeNull();
    expect(parsePriceLevels(connection.messages[1])).not.toBeNull();
    expect(relay.refusals).toEqual([]);
    expect(client.stats().connections).toBe(1);
  });

  test("a refused upgrade is retried until the relay accepts it", async () => {
    const relay = await liveRelay();
    relay.accepting = false;
    const cache = cacheOf(seed(CANONICAL_ROWS));
    const client = connectTo(relay, cache);

    await waitUntil(() => relay.attempts >= 3, "the client to keep retrying a refused upgrade");
    expect(relay.connections.length).toBe(0);
    expect(client.stats().connections).toBe(0);

    relay.accepting = true;
    await waitUntil(() => pushesOn(relay) >= 1, "the accepted connection to push");
    expect(client.stats().connections).toBe(1);
  });

  test("a wrong bearer is refused by the relay and never registers", async () => {
    const relay = await liveRelay();
    const cache = cacheOf(seed(CANONICAL_ROWS));
    connectTo(relay, cache, { authToken: `wrong${"0".repeat(59)}` });

    await waitUntil(() => relay.refusals.length >= 2, "the relay to refuse the wrong bearer twice");
    expect(relay.refusals.every((reason) => reason === "wrong")).toBe(true);
    expect(relay.connections.length).toBe(0);
  });

  test("answers the relay's heartbeat ping with a pong", async () => {
    // The relay pings every 30 s and TERMINATES a solver that misses two
    // pongs, so this is the property that keeps the socket alive at all.
    const relay = await liveRelay();
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)));
    await waitUntil(() => relay.connections.length >= 1, "the connection");
    const connection = relay.connections[0]!;

    connection.ping("n4-heartbeat");
    await waitUntil(() => connection.pongs.includes("n4-heartbeat"), "the pong");
  });

  test("a dropped socket reconnects and re-pushes BOTH capabilities and levels", async () => {
    const relay = await liveRelay();
    const cache = cacheOf(seed(CANONICAL_ROWS));
    const client = connectTo(relay, cache);
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");

    // Terminated the way a relay drops a solver that missed its pongs.
    relay.connections[0]!.terminate();

    await waitUntil(() => relay.connections.length >= 2, "the reconnection");
    await waitUntil(() => pushesOn(relay, 1) >= 1, "the re-push");
    const second = relay.connections[1]!;
    const expected = expectedPush(cache);
    // A COMPLETE republication, not a delta: the relay dropped both with the
    // socket, so both have to come back (R-34's reconnect trigger).
    expect(second.frames("solver-capabilities")[0]).toEqual(
      expected.capabilities as unknown as Record<string, unknown>,
    );
    expect(second.frames("price-levels")[0]).toEqual(
      expected.priceLevels as unknown as Record<string, unknown>,
    );
    expect(client.stats().connections).toBeGreaterThanOrEqual(2);
  });

  test("a book change reaches the relay in the next push", async () => {
    const relay = await liveRelay();
    const book = seed(CANONICAL_ROWS);
    const cache = cacheOf(book);
    connectTo(relay, cache);
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const connection = relay.connections[0]!;
    const rungs = (frame: Record<string, unknown>): number =>
      ((frame["levels"] as Array<{ levels: unknown[] }>)[0]?.levels.length ?? 0);
    expect(rungs(connection.frames("price-levels")[0]!)).toBe(3);

    book.upsert(bookOfferFromApi(row(O4, { token: A, amount: "40" }, { token: B, amount: "10" }))!);

    await waitUntil(
      () => connection.frames("price-levels").some((frame) => rungs(frame) === 4),
      "the changed book to reach the relay",
    );
    const latest = connection.frames("price-levels").at(-1)!;
    expect(latest).toEqual(expectedPush(cache).priceLevels as unknown as Record<string, unknown>);
  });

  test("a cache that stops being current publishes the EMPTY pair on the wire", async () => {
    const relay = await liveRelay();
    const cache = cacheOf(seed(CANONICAL_ROWS));
    connectTo(relay, cache);
    await waitUntil(() => pushesOn(relay) >= 1, "the first real push");
    const connection = relay.connections[0]!;

    cache.current = false;

    // FR-005's downstream half: withholding would leave the previous ladder
    // quoting, because the relay has no version or tombstone concept.
    await waitUntil(
      () =>
        connection
          .frames("price-levels")
          .some((frame) => (frame["levels"] as unknown[]).length === 0),
      "the fail-closed empty ladder",
    );
    await waitUntil(
      () =>
        connection
          .frames("solver-capabilities")
          .some((frame) => (frame["tokenIds"] as unknown[]).length === 0),
      "the fail-closed empty capabilities",
    );

    // And it recovers without a resnapshot.
    cache.current = true;
    await waitUntil(
      () =>
        connection
          .frames("price-levels")
          .slice(-1)
          .every((frame) => (frame["levels"] as unknown[]).length === 1),
      "the ladder to come back",
    );
  });

  test("graceful stop sends the withdrawal BEFORE the close frame", async () => {
    const relay = await liveRelay();
    const client = connectTo(relay, cacheOf(seed(CANONICAL_ROWS)));
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const connection = relay.connections[0]!;

    await client.stop();
    await waitUntil(() => connection.closeFrameReceived, "the close frame");

    // R-41: the retraction is an explicit frame on a still-open socket, not a
    // side effect of the disconnect. Ordering is the whole proof.
    const beforeClose = connection.messages.slice(0, connection.messagesAtClose!);
    expect(beforeClose.at(-2)).toEqual({ type: "price-levels", levels: [] });
    expect(beforeClose.at(-1)).toEqual({
      type: "solver-capabilities",
      tokenIds: [],
      maxParallelSwaps: MAX_PARALLEL_SWAPS,
    });
    expect(client.stats().withdrawn).toBe(true);
  });

  test("withdraw() retracts on a socket that stays open, and stops pushing", async () => {
    const relay = await liveRelay();
    const client = connectTo(relay, cacheOf(seed(CANONICAL_ROWS)));
    await waitUntil(() => pushesOn(relay) >= 2, "two pushes, so the loop is definitely running");
    const connection = relay.connections[0]!;

    await client.withdraw();
    // `withdraw()` resolves when the frames are on the socket; the mock still
    // has to decode them, so wait for the wire rather than for the caller.
    await waitUntil(
      () =>
        connection.frames("solver-capabilities").some(
          (frame) => (frame["tokenIds"] as unknown[]).length === 0,
        ),
      "the withdrawal to arrive",
    );
    expect(connection.messages.at(-2)).toEqual({ type: "price-levels", levels: [] });
    expect(connection.messages.at(-1)).toEqual({
      type: "solver-capabilities",
      tokenIds: [],
      maxParallelSwaps: MAX_PARALLEL_SWAPS,
    });
    expect(connection.closedByPeer).toBe(false);
    expect(connection.closeFrameReceived).toBe(false);

    // "No further pushes" measured by a completed round trip rather than by a
    // sleep: the pong proves the socket lived through more than one push
    // interval, and nothing was published in that time.
    const settled = connection.messages.length;
    connection.ping("after-withdraw");
    await waitUntil(() => connection.pongs.includes("after-withdraw"), "the post-withdrawal pong");
    expect(connection.messages.length).toBe(settled);
  });

  test("a routed swap job is answered with a fail-closed job-error", async () => {
    const relay = await liveRelay();
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)));
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const connection = relay.connections[0]!;

    connection.sendText({
      type: "swap",
      jobId: "5f5b2b0e-0f1f-4a3b-9e1a-2f5c8d7a1b23",
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });

    await waitUntil(() => connection.frames("job-error").length >= 1, "the job-error");
    expect(connection.frames("job-error")[0]).toEqual({
      type: "job-error",
      jobId: "5f5b2b0e-0f1f-4a3b-9e1a-2f5c8d7a1b23",
      reason: JOB_EXECUTION_UNAVAILABLE,
    });
    // Never answered as a capacity refusal, which would tell the relay to
    // retry the same proved transaction.
    expect(JOB_EXECUTION_UNAVAILABLE.startsWith("solver_at_capacity")).toBe(false);
    expect(JOB_EXECUTION_UNAVAILABLE.startsWith("solver_saturated")).toBe(false);
  });

  test("an async job result is returned on the socket generation that delivered it", async () => {
    const relay = await liveRelay();
    const jobId = "8e4cbbac-05cf-4943-95fb-7e193e7f6df4";
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onSwap: async (job) => ({ type: "swap-tx", jobId: job.jobId, txBytes: "00" }),
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const connection = relay.connections[0]!;
    connection.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });
    await waitUntil(() => connection.frames("swap-tx").length === 1, "the async swap-tx");
    expect(connection.frames("swap-tx")[0]).toEqual({ type: "swap-tx", jobId, txBytes: "00" });
  });

  test("a handler that resolves undefined gets a stable job-error on its source socket", async () => {
    const relay = await liveRelay();
    const jobId = "064e2561-1c89-4df6-a409-5f5373167c24";
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      // Runtime hardening: an untyped/injected handler can violate the closed
      // contract even though TypeScript callers cannot.
      onSwap: (async () => undefined) as unknown as NonNullable<
        Parameters<typeof startRelayClient>[0]["onSwap"]
      >,
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const source = relay.connections[0]!;
    source.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });

    await waitUntil(() => source.frames("job-error").length === 1, "the undefined-result job-error");
    expect(source.frames("job-error")[0]).toEqual({
      type: "job-error",
      jobId,
      reason: JOB_EXECUTION_UNAVAILABLE,
    });
    expect(source.frames("swap-tx")).toEqual([]);
  });

  test("an asynchronously rejecting handler gets a stable job-error on its source socket", async () => {
    const relay = await liveRelay();
    const jobId = "bf704e4e-e041-4f4b-a165-af7aa6669f90";
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onSwap: async () => {
        await Promise.resolve();
        throw new Error("async execution failed");
      },
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const source = relay.connections[0]!;
    source.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });

    await waitUntil(() => source.frames("job-error").length === 1, "the rejected-handler job-error");
    expect(source.frames("job-error")[0]).toEqual({
      type: "job-error",
      jobId,
      reason: JOB_EXECUTION_UNAVAILABLE,
    });
    expect(source.frames("swap-tx")).toEqual([]);
  });

  test("a synchronously throwing handler gets a stable job-error on its source socket", async () => {
    const relay = await liveRelay();
    const jobId = "d9309f8d-5ec4-4e19-8d34-4df47b72a824";
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onSwap: () => {
        throw new Error("synchronous execution failed");
      },
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const source = relay.connections[0]!;
    source.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });

    await waitUntil(() => source.frames("job-error").length === 1, "the thrown-handler job-error");
    expect(source.frames("job-error")[0]).toEqual({
      type: "job-error",
      jobId,
      reason: JOB_EXECUTION_UNAVAILABLE,
    });
    expect(source.frames("swap-tx")).toEqual([]);
  });

  test("a malformed terminal result gets a stable job-error on its source socket", async () => {
    const relay = await liveRelay();
    const jobId = "b5fcbec5-bc1f-452d-881b-80d6feec3777";
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onSwap: (async () => ({
        type: "swap-tx",
        jobId: "d1614d69-da7f-4351-8d13-3872f7cb8770",
        txBytes: "00",
      })) as NonNullable<Parameters<typeof startRelayClient>[0]["onSwap"]>,
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const source = relay.connections[0]!;
    source.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });

    await waitUntil(() => source.frames("job-error").length === 1, "the malformed-result job-error");
    expect(source.frames("job-error")[0]).toEqual({
      type: "job-error",
      jobId,
      reason: JOB_EXECUTION_UNAVAILABLE,
    });
    expect(source.frames("swap-tx")).toEqual([]);
  });

  test("a mid-job socket drop never sends the late proof on the replacement socket", async () => {
    const relay = await liveRelay();
    const jobId = "4d858b1b-b00f-492e-ae48-593edb130a81";
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onSwap: async (job) => {
        started();
        await gate;
        return { type: "swap-tx", jobId: job.jobId, txBytes: "00" };
      },
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    relay.connections[0]!.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });
    await didStart;
    relay.connections[0]!.terminate();
    await waitUntil(() => relay.connections.length >= 2, "the replacement connection");
    await waitUntil(() => pushesOn(relay, 1) >= 1, "the replacement re-push");

    release();
    const replacement = relay.connections[1]!;
    replacement.ping("late-proof-barrier");
    await waitUntil(() => replacement.pongs.includes("late-proof-barrier"), "the post-proof pong");
    expect(replacement.frames("swap-tx")).toEqual([]);
    expect(replacement.frames("job-error")).toEqual([]);
  });

  test("a late handler rejection never sends job-error on the replacement socket", async () => {
    const relay = await liveRelay();
    const jobId = "d07500c1-e531-44bd-8f90-014494f82baa";
    const events: RelayClientEvent[] = [];
    let reject!: (error: Error) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const result = new Promise<never>((_resolve, rejectResult) => {
      reject = rejectResult;
    });
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onEvent: (event) => events.push(event),
      onSwap: () => {
        started();
        return result;
      },
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    relay.connections[0]!.sendText({
      type: "swap",
      jobId,
      tokenIn: B,
      tokenOut: A,
      amountIn: "12",
      amountOut: "22",
    });
    await didStart;
    relay.connections[0]!.terminate();
    await waitUntil(() => relay.connections.length >= 2, "the replacement connection");
    await waitUntil(() => pushesOn(relay, 1) >= 1, "the replacement re-push");

    reject(new Error("late async execution failed"));
    await waitUntil(
      () => events.some((event) => event.kind === "job-refused" && event.detail?.jobId === jobId),
      "the rejected handler diagnostic",
    );
    const replacement = relay.connections[1]!;
    replacement.ping("late-error-barrier");
    await waitUntil(() => replacement.pongs.includes("late-error-barrier"), "the post-error pong");
    expect(replacement.frames("job-error")).toEqual([]);
    expect(replacement.frames("swap-tx")).toEqual([]);
  });

  test("tx-submitted and submit-failed are forwarded to their lifecycle handlers", async () => {
    const relay = await liveRelay();
    const submitted: string[] = [];
    const failed: string[] = [];
    connectTo(relay, cacheOf(seed(CANONICAL_ROWS)), {
      onTxSubmitted: async (message) => {
        submitted.push(`${message.jobId}:${message.txId}`);
      },
      onSubmitFailed: async (message) => {
        failed.push(`${message.jobId}:${message.reason}`);
      },
    });
    await waitUntil(() => pushesOn(relay) >= 1, "the first push");
    const connection = relay.connections[0]!;
    connection.sendText({ type: "tx-submitted", jobId: "job-1", txId: "tx-1" });
    connection.sendText({ type: "submit-failed", jobId: "job-2", reason: "rejected" });
    await waitUntil(() => submitted.length === 1 && failed.length === 1, "both lifecycle handlers");
    expect(submitted).toEqual(["job-1:tx-1"]);
    expect(failed).toEqual(["job-2:rejected"]);
  });
});

// ── part 2: the loop's own properties, on a manual clock ────────────────────

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
};

class ManualClock {
  #entries: Array<{ id: number; at: number; fn: () => void }> = [];
  #nextId = 1;
  #now = 0;

  readonly timers: RelayClientTimers = {
    setTimeout: (fn, ms) => {
      const id = this.#nextId++;
      this.#entries.push({ id, at: this.#now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      this.#entries = this.#entries.filter((entry) => entry.id !== handle);
    },
  };

  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (;;) {
      const due = this.#entries
        .filter((entry) => entry.at <= this.#now)
        .sort((left, right) => left.at - right.at || left.id - right.id);
      if (due.length === 0) break;
      const fired = new Set(due.map((entry) => entry.id));
      this.#entries = this.#entries.filter((entry) => !fired.has(entry.id));
      for (const entry of due) {
        entry.fn();
        await flushMicrotasks();
      }
    }
    await flushMicrotasks();
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class FakeSocket implements RelayWebSocketLike {
  readyState = RELAY_WS_OPEN;
  onopen: ((event?: any) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: any) => void) | null = null;
  onclose: ((event?: any) => void) | null = null;
  readonly sent: string[] = [];
  /** While true, each send stays pending until `release()`. */
  hold = false;
  /** While true, each send rejects. */
  failSends = false;
  #pending: Deferred[] = [];

  send(data: string): void | Promise<void> {
    this.sent.push(data);
    if (this.failSends) return Promise.reject(new Error("socket write failed"));
    if (!this.hold) return;
    const gate = deferred();
    this.#pending.push(gate);
    return gate.promise;
  }

  release(): void {
    this.hold = false;
    for (const gate of this.#pending.splice(0)) gate.resolve();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  get frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  get types(): string[] {
    return this.frames.map((frame) => String(frame["type"]));
  }
}

interface Harness {
  socket: FakeSocket;
  clock: ManualClock;
  client: RelayClientHandle;
  events: RelayClientEvent[];
}

function harness(
  cache: LadderCache,
  overrides: Partial<Parameters<typeof startRelayClient>[0]> = {},
): Harness {
  const socket = new FakeSocket();
  const clock = new ManualClock();
  const events: RelayClientEvent[] = [];
  const client = startRelayClient({
    url: "ws://relay.invalid/",
    authToken: TOKEN,
    cache,
    ladder: {
      expiryMarginSeconds: EXPIRY_MARGIN_SECONDS,
      maxParallelSwaps: MAX_PARALLEL_SWAPS,
    },
    nowMs: () => NOW,
    pushIntervalMs: 1_000,
    reconnectDelayMs: 2_000,
    withdrawTimeoutMs: 500,
    timers: clock.timers,
    createWebSocket: () => socket,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { socket, clock, client, events };
}

describe("relay client — push loop properties", () => {
  test("R-07: a tick during a push coalesces into ONE follow-up, never interleaved", async () => {
    const book = seed(CANONICAL_ROWS);
    const cache = cacheOf(book);
    const { socket, clock, client } = harness(cache);

    socket.hold = true;
    socket.onopen!();
    await flushMicrotasks();
    // The connect push is stuck on its first frame.
    expect(socket.types).toEqual(["solver-capabilities"]);

    // Three ticks arrive while it is in flight, and the book changes in the
    // middle of them. The follow-up must carry the NEWEST derivation.
    await clock.advance(1_000);
    book.upsert(bookOfferFromApi(row(O4, { token: A, amount: "40" }, { token: B, amount: "10" }))!);
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(client.stats().coalesced).toBe(3);
    expect(client.stats().pushes).toBe(0);

    socket.release();
    await flushMicrotasks();

    // Exactly two pushes for four requests, and the frames never interleave:
    // one whole derivation at a time.
    expect(client.stats().pushes).toBe(2);
    expect(socket.types).toEqual([
      "solver-capabilities",
      "price-levels",
      "solver-capabilities",
      "price-levels",
    ]);
    const first = socket.frames[1]!;
    const second = socket.frames[3]!;
    expect((first["levels"] as Array<{ levels: unknown[] }>)[0]!.levels.length).toBe(3);
    // Derived AFTER the ticks, not when the tick fired.
    expect(second).toEqual(expectedPush(cache).priceLevels as unknown as Record<string, unknown>);
    expect((second["levels"] as Array<{ levels: unknown[] }>)[0]!.levels.length).toBe(4);
  });

  test("R-07: a manual push while one is in flight resolves with the coalesced push", async () => {
    const { socket, client } = harness(cacheOf(seed(CANONICAL_ROWS)));
    socket.hold = true;
    socket.onopen!();
    await flushMicrotasks();

    let settled = false;
    const second = client.push().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    socket.release();
    await second;
    expect(settled).toBe(true);
    expect(client.stats().pushes).toBe(2);
  });

  test("R-37: a throwing observer cannot break the loop, push(), or stop()", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { socket, clock, client } = harness(cacheOf(seed(CANONICAL_ROWS)), {
        onEvent: () => {
          throw new Error("hostile observer");
        },
        log: () => {
          throw new Error("hostile logger");
        },
      });

      socket.onopen!();
      await flushMicrotasks();
      expect(client.stats().pushes).toBe(1);

      // The loop keeps running after the observer threw on every event.
      await clock.advance(1_000);
      expect(client.stats().pushes).toBe(2);

      // And a transport failure with a throwing observer still leaves both
      // push() and stop() FULFILLED — the deleted publisher's exact defect.
      socket.failSends = true;
      await client.push();
      await client.stop();
      expect(client.stats().stopped).toBe(true);

      await flushMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a send failure is contained and the loop recovers", async () => {
    const { socket, clock, client, events } = harness(cacheOf(seed(CANONICAL_ROWS)));
    socket.failSends = true;
    socket.onopen!();
    await flushMicrotasks();
    expect(client.stats().pushes).toBe(0);
    expect(client.stats().pushFailures).toBe(1);
    expect(events.some((event) => event.kind === "push-failed")).toBe(true);

    socket.failSends = false;
    await clock.advance(1_000);
    expect(client.stats().pushes).toBe(1);
  });

  test("a cache read that throws never reaches the socket", async () => {
    let explode = true;
    const book = seed(CANONICAL_ROWS);
    const cache: LadderCache = {
      get book(): Book {
        if (explode) throw new Error("cache read exploded");
        return book;
      },
      isCurrent: () => true,
    };
    const { socket, clock, client, events } = harness(cache);

    socket.onopen!();
    await flushMicrotasks();
    // Nothing may be published on the strength of a failed derivation: the
    // relay would keep quoting the previous ladder either way, so silence is
    // the only honest answer here.
    expect(socket.sent).toEqual([]);
    expect(client.stats().pushFailures).toBe(1);
    expect(events.filter((event) => event.kind === "push-failed")[0]?.severity).toBe("error");

    explode = false;
    await clock.advance(1_000);
    expect(client.stats().pushes).toBe(1);
  });

  test("Q-N3-1: a cap that drops real liquidity is a loud, non-repeating signal", async () => {
    // Two directed pairs, each backed by exactly one offer, published under a
    // one-pair cap. Pairs are published in lexicographic key order, so
    // `A→C` survives and the single offer behind `B→A` is the casualty.
    const book = seed([
      row(O1, { token: A, amount: "10" }, { token: B, amount: "10" }),
      row(O4, { token: C, amount: "7" }, { token: A, amount: "7" }),
    ]);
    const cache = cacheOf(book);
    const { socket, clock, client, events } = harness(cache, {
      ladder: {
        expiryMarginSeconds: EXPIRY_MARGIN_SECONDS,
        maxParallelSwaps: MAX_PARALLEL_SWAPS,
        maxPairs: 1,
      },
    });

    socket.onopen!();
    await flushMicrotasks();
    const truncated = events.filter((event) => event.kind === "ladder-truncated");
    expect(truncated.length).toBe(1);
    expect(truncated[0]!.severity).toBe("error");
    expect(truncated[0]!.detail).toEqual({ pairCapOffers: 1, rungCapOffers: 0 });
    // The published frame really is short one pair — the signal is not
    // reporting something that did not happen.
    expect((socket.frames[1]!["levels"] as unknown[]).length).toBe(1);

    // An unchanged truncation does not repeat once a second forever.
    await clock.advance(1_000);
    expect(events.filter((event) => event.kind === "ladder-truncated").length).toBe(1);

    // Recovery is reported, so a cleared truncation does not look permanent.
    book.remove(O1);
    await clock.advance(1_000);
    expect(events.some((event) => event.kind === "ladder-truncation-cleared")).toBe(true);
    expect(client.stats().pushes).toBe(3);
  });

  test("the fail-closed empty publication is reported at error severity", async () => {
    const cache = cacheOf(seed(CANONICAL_ROWS));
    const { socket, clock, events } = harness(cache);
    socket.onopen!();
    await flushMicrotasks();

    cache.current = false;
    await clock.advance(1_000);
    const withheld = events.filter((event) => event.kind === "cache-not-current");
    expect(withheld.length).toBe(1);
    expect(withheld[0]!.severity).toBe("error");
    expect(socket.frames.at(-1)).toEqual({ type: "price-levels", levels: [] });
    expect(socket.frames.at(-2)).toEqual({
      type: "solver-capabilities",
      tokenIds: [],
      maxParallelSwaps: MAX_PARALLEL_SWAPS,
    });

    cache.current = true;
    await clock.advance(1_000);
    expect(events.some((event) => event.kind === "cache-current")).toBe(true);
  });

  test("R-41: a withdrawal the relay never accepts is bounded, and stop still finishes", async () => {
    const { socket, clock, client } = harness(cacheOf(seed(CANONICAL_ROWS)));
    socket.onopen!();
    await flushMicrotasks();

    socket.hold = true;
    let done = false;
    const stopped = client.stop().then(() => {
      done = true;
    });
    await flushMicrotasks();
    expect(done).toBe(false);

    // Only the deadline can release it — the socket never will.
    await clock.advance(500);
    await clock.advance(500);
    await stopped;
    expect(done).toBe(true);
    expect(client.stats().withdrawn).toBe(false);
    expect(client.stats().stopped).toBe(true);
  });

  test("stop() is idempotent and a second stop resolves", async () => {
    const { socket, client } = harness(cacheOf(seed(CANONICAL_ROWS)));
    socket.onopen!();
    await flushMicrotasks();
    await client.stop();
    await client.stop();
    expect(client.stats().stopped).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  test("a disconnected client publishes nothing and reconnects on its own", async () => {
    const sockets: FakeSocket[] = [];
    const clock = new ManualClock();
    const cache = cacheOf(seed(CANONICAL_ROWS));
    const client = startRelayClient({
      url: "ws://relay.invalid/",
      authToken: TOKEN,
      cache,
      ladder: { expiryMarginSeconds: EXPIRY_MARGIN_SECONDS, maxParallelSwaps: MAX_PARALLEL_SWAPS },
      nowMs: () => NOW,
      pushIntervalMs: 1_000,
      reconnectDelayMs: 2_000,
      timers: clock.timers,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    clients.push(client);

    sockets[0]!.onopen!();
    await flushMicrotasks();
    expect(client.stats().pushes).toBe(1);

    sockets[0]!.readyState = 3;
    sockets[0]!.onclose!();
    await flushMicrotasks();

    // Offline: a tick publishes nothing, and asking for a push is not an error.
    await clock.advance(1_000);
    await client.push();
    expect(sockets[0]!.sent.length).toBe(2);
    expect(sockets.length).toBe(1);

    // The 2 s reconnect brings a new socket, which is fully republished to.
    await clock.advance(2_000);
    expect(sockets.length).toBe(2);
    sockets[1]!.onopen!();
    await flushMicrotasks();
    expect(sockets[1]!.types).toEqual(["solver-capabilities", "price-levels"]);
    expect(client.stats().connections).toBe(2);
  });
});
