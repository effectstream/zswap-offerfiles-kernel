import { expect, test } from "bun:test";

import { LadderBook } from "./src/ladder.ts";
import {
  clipToStock,
  nextPublicationVersion,
  shouldPublishLevels,
  startLevelsPush,
} from "./src/levels-push.ts";
import { Stock } from "./src/stock.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
  { input: "1000000", output: "970000" },
];

const ladders = () =>
  LadderBook.fromPairs([
    { tokenIn: A, tokenOut: B, levels: LEVELS },
    { tokenIn: B, tokenOut: A, levels: LEVELS },
  ]);

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("a fully funded solver publishes every rung", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  const pairs = clipToStock(ladders(), stock);
  expect(pairs.length).toBe(2);
  expect(pairs[0].levels.length).toBe(3);
});

test("rungs the solver cannot pay are dropped, not published", () => {
  const stock = new Stock();
  // Enough for the 99000 rung, not the 970000 one.
  stock.setBalances({ [A]: 100_000n, [B]: 100_000n });
  const pairs = clipToStock(ladders(), stock);
  expect(pairs.every((p) => p.levels.length === 2)).toBe(true);
  expect(pairs.every((p) => p.levels.at(-1)!.output === "99000")).toBe(true);
});

test("a pair with nothing affordable is omitted entirely", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 10n });
  const pairs = clipToStock(ladders(), stock);
  // Paying B is unaffordable at every rung, so A→B goes; B→A stays.
  expect(pairs.length).toBe(1);
  expect(pairs[0].tokenIn).toBe(B);
});

test("an in-flight reservation shrinks what is published", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  stock.reserve({ offerHashes: ["h1"], nullifiers: ["n1"], payouts: new Map([[B, 950_000n]]) });
  const aToB = clipToStock(ladders(), stock).find((p) => p.tokenIn === A)!;
  // 50,000 of B left: only the first rung is honourable.
  expect(aToB.levels.length).toBe(1);
});

test("a solver holding nothing publishes nothing", () => {
  expect(clipToStock(ladders(), new Stock())).toEqual([]);
});

test("clipping keeps rungs strictly ascending, so the result stays valid", () => {
  const stock = new Stock();
  stock.setBalances({ [A]: 100_000n, [B]: 100_000n });
  for (const pair of clipToStock(ladders(), stock)) {
    for (let i = 1; i < pair.levels.length; i++) {
      expect(BigInt(pair.levels[i].input)).toBeGreaterThan(BigInt(pair.levels[i - 1].input));
    }
  }
});

test("pairs sharing one output token cannot collectively over-publish it", () => {
  const C = "c".repeat(64);
  const shared = LadderBook.fromPairs([
    { tokenIn: A, tokenOut: C, levels: LEVELS },
    { tokenIn: B, tokenOut: C, levels: LEVELS },
  ]);
  const stock = new Stock();
  stock.setBalances({ [C]: 100_000n });
  const pairs = clipToStock(shared, stock);
  const committed = pairs.reduce((sum, pair) => sum + BigInt(pair.levels.at(-1)!.output), 0n);
  expect(committed).toBeLessThanOrEqual(100_000n);
});

test("publication versions stay monotonic when the clock repeats or rolls back", () => {
  expect(nextPublicationVersion(0n, 1000)).toBe(1_000_000_000n);
  expect(nextPublicationVersion(1_000_000_000n, 1000)).toBe(1_000_000_001n);
  expect(nextPublicationVersion(1_000_000_001n, 900)).toBe(1_000_000_002n);
});

test("publisher authenticates, uses decimal versions, and sends empty withdrawal", async () => {
  const requests: Array<{ headers: Headers; body: any }> = [];
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    nowMs: () => 1234,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch,
  });
  await handle.push();
  await handle.stop();

  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests[0].headers.get("authorization")).toBe("Bearer secret-token-1234");
  expect(requests[0].body).toEqual({ version: "1234000000", pairs: [] });
  for (let i = 1; i < requests.length; i++) {
    expect(BigInt(requests[i].body.version)).toBeGreaterThan(BigInt(requests[i - 1].body.version));
  }
});

test("a restarted publisher reconciles a live node version tombstone and retries", async () => {
  const versions: string[] = [];
  let calls = 0;
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    nowMs: () => 1_000,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      versions.push(JSON.parse(String(init?.body)).version);
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({
            error: "STALE_VERSION",
            reason: "version must increase",
            lastVersion: "1000000005",
          }), { status: 409 })
        : new Response(JSON.stringify({ accepted: 0 }), { status: 200 });
    }) as typeof fetch,
  });

  await handle.push();
  await handle.stop();

  expect(versions).toEqual(["1000000000", "1000000006"]);
});

test("a malformed stale-version response cannot drive the local version clock", async () => {
  const versions: string[] = [];
  let served!: () => void;
  const firstServed = new Promise<void>((resolve) => {
    served = resolve;
  });
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    nowMs: () => 1_000,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      versions.push(JSON.parse(String(init?.body)).version);
      served();
      return new Response(JSON.stringify({
        error: "STALE_VERSION",
        lastVersion: "18446744073709551616",
      }), { status: 409 });
    }) as typeof fetch,
  });

  // startLevelsPush owns an initial publication. Do not call push() while it is
  // active: that intentionally coalesces one additional fresh publication and
  // would not be evidence of a stale-version retry.
  await firstServed;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await handle.stop();
  expect(versions).toEqual(["1000000000"]);
});

test("graceful stop sends a bounded authenticated full withdrawal", async () => {
  const requests: Array<{ authorization: string | null; body: any }> = [];
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n });
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock,
    intervalMs: 60_000,
    nowMs: () => 1_000,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ accepted: 2 }), { status: 200 });
    }) as typeof fetch,
  });

  await handle.push();
  await handle.stop();

  expect(requests.some((request) => request.body.pairs.length > 0)).toBe(true);
  expect(requests.at(-1)?.body.pairs).toEqual([]);
  expect(requests.at(-1)?.authorization).toBe("Bearer secret-token-1234");
  for (let i = 1; i < requests.length; i++) {
    expect(BigInt(requests[i].body.version)).toBeGreaterThan(BigInt(requests[i - 1].body.version));
  }
});

test("publisher refuses to start without its configured credential", () => {
  expect(() =>
    startLevelsPush({
      api: "http://node.invalid",
      authToken: "",
      ladders: ladders(),
      stock: new Stock(),
      intervalMs: 60_000,
    }),
  ).toThrow(/SOLVER_LEVELS_AUTH_TOKEN/);
});

test("publication is an independent explicit opt-in and dry-run always suppresses it", () => {
  expect(shouldPublishLevels(false, false)).toBe(false);
  expect(shouldPublishLevels(false, true)).toBe(true);
  expect(shouldPublishLevels(true, false)).toBe(false);
  expect(shouldPublishLevels(true, true)).toBe(false);
});

for (const [label, fetchImpl] of [
  ["HTTP rejection", async () => new Response("rejected", { status: 500 })],
  ["network rejection", async () => { throw new Error("offline"); }],
] as const) {
  test(`throwing diagnostics cannot reject publisher lifecycle after ${label}`, async () => {
    const handle = startLevelsPush({
      api: "http://node.invalid",
      authToken: "secret-token-1234",
      ladders: ladders(),
      stock: new Stock(),
      intervalMs: 60_000,
      log: () => {
        throw new Error("logger failed");
      },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(handle.push()).resolves.toBeUndefined();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
}

test("overlapping publication requests are serialized and coalesced", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: Array<() => void> = [];
  const fetchImpl = (async () => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight--;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    fetchImpl,
  });
  const first = handle.push();
  const second = handle.push();
  expect(calls).toBe(1);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(2);
  releases.shift()!();
  await Promise.all([first, second]);
  await handle.stop();

  expect(calls).toBe(2);
  expect(maxInFlight).toBe(1);
});

test("the absolute deadline settles a fetch that ignores AbortSignal", async () => {
  let resolveLogged!: () => void;
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve;
  });
  const messages: string[] = [];
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    requestTimeoutMs: 20,
    log: (message) => {
      messages.push(message);
      resolveLogged();
    },
    fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
  });

  expect(await settlesWithin(logged)).toBe(true);
  expect(messages.some((message) => message.includes("response-and-body deadline"))).toBe(true);
  expect(await settlesWithin(handle.stop())).toBe(true);
});

test("the absolute deadline cancels a response body whose read never settles", async () => {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  let cancelReason: unknown;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
        releaseLock: () => {},
        cancel: async (reason: unknown) => {
          cancelReason = reason;
          resolveCancelled();
        },
      }),
      cancel: async () => {},
    },
  } as unknown as Response;
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    requestTimeoutMs: 20,
    fetchImpl: (async () => response) as typeof fetch,
  });

  expect(await settlesWithin(cancelled)).toBe(true);
  expect(cancelReason).toBeInstanceOf(Error);
  expect(String(cancelReason)).toContain("response-and-body deadline");
  expect(await settlesWithin(handle.stop())).toBe(true);
});

test("publisher drains a response body before a push completes", async () => {
  let reads = 0;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads++;
          return { done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>;
        },
        releaseLock: () => {},
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
  } as unknown as Response;
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    fetchImpl: (async () => response) as typeof fetch,
  });

  await handle.push();
  await handle.stop();
  expect(reads).toBeGreaterThanOrEqual(1);
});

test("stop aborts and joins a fetch even when the transport ignores its signal", async () => {
  let requestSignal: AbortSignal | null = null;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    requestTimeoutMs: 60_000,
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal;
      resolveStarted();
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });

  expect(await settlesWithin(started)).toBe(true);
  expect(await settlesWithin(handle.stop())).toBe(true);
  expect(requestSignal?.aborted).toBe(true);
});

test("stop cancels and joins a response body whose read ignores abort", async () => {
  let resolveReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    resolveReading = resolve;
  });
  let cancelled = false;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          resolveReading();
          return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
        },
        releaseLock: () => {},
        cancel: async () => {
          cancelled = true;
        },
      }),
      cancel: async () => {},
    },
  } as unknown as Response;
  const handle = startLevelsPush({
    api: "http://node.invalid",
    authToken: "secret-token-1234",
    ladders: ladders(),
    stock: new Stock(),
    intervalMs: 60_000,
    requestTimeoutMs: 60_000,
    fetchImpl: (async () => response) as typeof fetch,
  });

  expect(await settlesWithin(reading)).toBe(true);
  expect(await settlesWithin(handle.stop())).toBe(true);
  expect(cancelled).toBe(true);
});
