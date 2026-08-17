import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { OfferValidationVerdict } from "@zswap-da/solver-core/validation-contract";

import {
  armBookReadyDecisionGate,
  createBookReadyDecisionGate,
  createInventoryRefreshController,
  initializeOwnedResource,
  runSolver,
} from "./src/run.ts";
import type { SyncDependencies } from "./src/sse-sync.ts";
import { Stock } from "./src/stock.ts";

const TOKEN = "a".repeat(64);
const LEVELS_STOCK_TOKEN = "b3ca74538249b3d8c57cb464968f14735fda823d9a3a16ea13d881fab964a803";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("partial snapshot changes cannot execute before ready and coalesce afterward", async () => {
  let executorCalls = 0;
  const gate = createBookReadyDecisionGate(() => {
    executorCalls++;
  });

  // These model onChange callbacks from early pages of the initial snapshot.
  gate.request();
  gate.request();
  await Promise.resolve();
  expect(executorCalls).toBe(0);

  // Readiness itself schedules one full-book decision. More changes in the same
  // turn are coalesced into that decision rather than duplicating executor work.
  gate.markReady();
  gate.request();
  gate.request();
  expect(executorCalls).toBe(0);
  await Promise.resolve();
  expect(executorCalls).toBe(1);
});

test("stop before rejected readiness neither executes nor leaks rejection", async () => {
  let executorCalls = 0;
  const gate = createBookReadyDecisionGate(() => {
    executorCalls++;
  });
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((_resolve, reject) => {
    rejectReady = reject;
  });
  armBookReadyDecisionGate(ready, gate);

  gate.request();
  gate.stop();
  rejectReady(new Error("book synchronization stopped before readiness"));
  await Promise.resolve();
  await Promise.resolve();
  expect(executorCalls).toBe(0);
});

test("removal-triggered redecisions coalesce and can unlock the next candidate", async () => {
  let decisions = 0;
  const gate = createBookReadyDecisionGate(() => {
    decisions++;
  });
  gate.markReady();
  await Promise.resolve();
  expect(decisions).toBe(1);

  // Models a hash removal plus a same-nullifier fan-out in one stream turn.
  gate.request();
  gate.request();
  gate.request();
  expect(decisions).toBe(1);
  await Promise.resolve();
  expect(decisions).toBe(2);
});

test("a superseded late balance read cannot overwrite a newer zero balance", async () => {
  const stock = new Stock();
  const first = deferred<Record<string, bigint>>();
  const second = deferred<Record<string, bigint>>();
  const reads = [first, second];
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => reads.shift()!.promise,
  });

  const oldRefresh = controller.refresh();
  const oldObserved = oldRefresh.catch((error) => error);
  await Promise.resolve();
  const newRefresh = controller.refresh();
  await Promise.resolve();
  second.resolve({ [TOKEN]: 0n });
  await newRefresh;
  expect(controller.isReady()).toBe(true);
  expect(stock.balance(TOKEN)).toBe(0n);

  first.resolve({ [TOKEN]: 9_999n });
  expect(await oldObserved).toBeInstanceOf(Error);
  await Promise.resolve();
  expect(stock.balance(TOKEN)).toBe(0n);
  expect(controller.isReady()).toBe(true);
});

test("a failed authoritative refresh withdraws all Stock and blocks decisions until recovery", async () => {
  const stock = new Stock();
  const reads: Array<Promise<Record<string, bigint>>> = [
    Promise.resolve({ [TOKEN]: 1_000n }),
    Promise.reject(new Error("wallet unavailable")),
    Promise.resolve({ [TOKEN]: 250n }),
  ];
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => reads.shift()!,
  });
  let decisions = 0;
  const gate = createBookReadyDecisionGate(
    () => {
      decisions++;
    },
    controller.isReady,
  );

  await controller.refresh();
  gate.markReady();
  await Promise.resolve();
  expect(decisions).toBe(1);
  expect(stock.available(TOKEN)).toBe(1_000n);

  await expect(controller.refresh()).rejects.toThrow("wallet unavailable");
  expect(controller.isReady()).toBe(false);
  expect(stock.available(TOKEN)).toBe(0n);
  expect(stock.tokens()).toEqual([]);
  gate.request();
  await Promise.resolve();
  expect(decisions).toBe(1);

  await controller.refresh();
  gate.request();
  await Promise.resolve();
  expect(controller.isReady()).toBe(true);
  expect(stock.available(TOKEN)).toBe(250n);
  expect(decisions).toBe(2);
});

test("currentness invalidation withdraws once and only a newer inventory read restores", async () => {
  const stock = new Stock();
  const late = deferred<Record<string, bigint>>();
  const reads: Array<Promise<Record<string, bigint>>> = [
    Promise.resolve({ [TOKEN]: 1_000n }),
    late.promise,
    Promise.resolve({ [TOKEN]: 250n }),
  ];
  const readiness: boolean[] = [];
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => reads.shift()!,
    onReadinessChange: (ready) => readiness.push(ready),
  });

  await controller.refresh();
  expect(stock.available(TOKEN)).toBe(1_000n);

  const staleRefresh = controller.refresh();
  const staleObserved = staleRefresh.catch((error) => error);
  await Promise.resolve();
  controller.invalidate(new Error("backend currentness lost"));
  controller.invalidate(new Error("duplicate stale signal"));
  expect(await staleObserved).toBeInstanceOf(Error);
  expect(stock.tokens()).toEqual([]);
  expect(controller.isReady()).toBe(false);

  await controller.refresh();
  expect(stock.available(TOKEN)).toBe(250n);
  expect(readiness).toEqual([true, false, true]);

  late.resolve({ [TOKEN]: 9_999n });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stock.available(TOKEN)).toBe(250n);
  expect(readiness).toEqual([true, false, true]);
});

test("stop retains and observes a balance read that ignores cancellation", async () => {
  const stock = new Stock();
  const read = deferred<Record<string, bigint>>();
  const controller = createInventoryRefreshController({
    stock,
    readBalances: async () => read.promise,
  });

  const refresh = controller.refresh();
  const observed = refresh.catch((error) => error);
  await Promise.resolve();
  controller.stop();
  expect(await observed).toBeInstanceOf(Error);
  expect(controller.retainedOperations()).toBe(1);
  expect(controller.isReady()).toBe(false);
  expect(stock.tokens()).toEqual([]);

  read.resolve({ [TOKEN]: 500n });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.retainedOperations()).toBe(0);
  expect(stock.tokens()).toEqual([]);
});

test("wallet startup timeout cleans up an already-built owner within a separate deadline", async () => {
  let cleanupCalls = 0;
  const startedAt = Date.now();
  await expect(
    initializeOwnedResource({
      build: async () => ({ wallet: true }),
      initialize: async () => new Promise<void>(() => {}),
      cleanup: async () => {
        cleanupCalls++;
      },
      startupTimeoutMs: 10,
      cleanupTimeoutMs: 20,
    }),
  ).rejects.toThrow("wallet startup timed out after 10 ms");

  expect(cleanupCalls).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(500);
});

test("a wallet that finishes building after startup timeout is still cleaned up", async () => {
  const built = deferred<{ wallet: true }>();
  const cleaned = deferred<void>();
  const startup = initializeOwnedResource({
    build: () => built.promise,
    initialize: async () => {},
    cleanup: async () => {
      cleaned.resolve();
    },
    startupTimeoutMs: 10,
    cleanupTimeoutMs: 20,
  });

  await expect(startup).rejects.toThrow("wallet startup timed out after 10 ms");
  built.resolve({ wallet: true });
  await Promise.race([
    cleaned.promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late wallet cleanup did not run")), 100);
    }),
  ]);
});

test("external startup cancellation aborts initialization and cleans the acquired owner", async () => {
  const outer = new AbortController();
  const initializing = deferred<void>();
  let initializationSignal: AbortSignal | undefined;
  let cleanupCalls = 0;
  const reason = new Error("startup cancelled by SIGTERM");

  const startup = initializeOwnedResource({
    build: async () => ({ wallet: true }),
    initialize: async (_resource, signal) => {
      initializationSignal = signal;
      initializing.resolve();
      await new Promise<void>(() => {});
    },
    cleanup: async () => {
      cleanupCalls++;
    },
    startupTimeoutMs: 1_000,
    cleanupTimeoutMs: 100,
    signal: outer.signal,
  });
  await initializing.promise;
  outer.abort(reason);

  await expect(startup).rejects.toBe(reason);
  expect(initializationSignal?.aborted).toBe(true);
  expect(cleanupCalls).toBe(1);
});

test("external cancellation observes and cleans a wallet that builds late", async () => {
  const outer = new AbortController();
  const built = deferred<{ wallet: true }>();
  const cleaned = deferred<void>();
  const reason = new Error("startup cancelled before wallet build");
  const startup = initializeOwnedResource({
    build: () => built.promise,
    initialize: async () => {},
    cleanup: async () => cleaned.resolve(),
    startupTimeoutMs: 1_000,
    cleanupTimeoutMs: 100,
    signal: outer.signal,
  });
  await Promise.resolve();
  outer.abort(reason);

  await expect(startup).rejects.toBe(reason);
  built.resolve({ wallet: true });
  await cleaned.promise;
});

const OFFER_HASH = "d".repeat(64);
const GIVE = "b".repeat(64);
const WANT = "c".repeat(64);
const NULLIFIER = "1".repeat(64);
const OFFER_EXPIRES = "2099-01-01T00:00:00.000Z";

const runtimeDetail = {
  version: 1 as const,
  offerId: OFFER_HASH,
  offerBech32: `blob-${OFFER_HASH}`,
  computed: {
    gives: [{ token: GIVE, amount: "10", type: "SHIELDED" }],
    wants: [{ token: WANT, amount: "9", type: "SHIELDED" }],
    expiresAt: OFFER_EXPIRES,
    firstSeenAt: "2026-08-14T00:00:00.000Z",
    inputNullifiers: [NULLIFIER],
    status: "live",
  },
};

const runtimeVerdict = (stateVersion = "7"): OfferValidationVerdict => ({
  schemaVersion: 1,
  profile: "offer-files-solver-v1",
  valid: true,
  live: true,
  claimedOfferId: OFFER_HASH,
  computedOfferId: OFFER_HASH,
  stateVersion,
  validatedAt: new Date(Date.now() - 60_000).toISOString(),
  status: "live",
  code: "VALID",
  computed: {
    gives: [{ token: GIVE, amount: "10", kind: "SHIELDED" }],
    wants: [{ token: WANT, amount: "9", kind: "SHIELDED" }],
    inputNullifiers: [NULLIFIER],
    expiresAt: OFFER_EXPIRES,
  },
});

function runtimeHarness(options: {
  detail?: typeof runtimeDetail;
  verdict?: (stateVersion: string) => OfferValidationVerdict;
} = {}) {
  let onEvent: ((event: any) => void) | null = null;
  let closeCalls = 0;
  let healthCalls = 0;
  let validationCalls = 0;
  let healthHeight = "7";
  const detail = options.detail ?? runtimeDetail;
  const syncDependencies: SyncDependencies = {
    getZswapsPage: async () => ({ offers: [], nextCursor: null }),
    getZswapByHash: async () => detail,
    getBackendSyncHealth: async () => {
      healthCalls++;
      return {
        ts: Date.now(),
        status: "ok",
        blockL2: { height: healthHeight },
        ntp: { current: 7, tip: 7, pct: 100, lagBlocks: 0, lagSeconds: 0 },
        midnight: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
        celestia: { current: 7, fetched: 7, tip: 7, pct: 100, lagBlocks: 0 },
      };
    },
    openSseStream: (handler, options) => {
      onEvent = handler;
      queueMicrotask(() => options.onOpen?.());
      return {
        close: async () => { closeCalls++; },
      };
    },
  };
  return {
    syncDependencies,
    validationDependencies: {
      getZswapByHash: async () => detail,
      validateOfferForUse: async () => {
        validationCalls++;
        return options.verdict?.(healthHeight) ?? runtimeVerdict(healthHeight);
      },
    },
    emitOffer: () => onEvent?.({
      type: "offer_indexed",
      offerId: 1,
      offerHash: detail.offerId,
      blockHeight: 7,
      gives: [],
      wants: [],
      timestamp: Date.now(),
    }),
    emitConsumed: () => onEvent?.({
      type: "offer_consumed",
      offerId: 1,
      offerHash: detail.offerId,
      nullifier: detail.computed.inputNullifiers[0],
      timestamp: Date.now(),
    }),
    healthCalls: () => healthCalls,
    validationCalls: () => validationCalls,
    closeCalls: () => closeCalls,
    setHealthHeight: (height: string) => { healthHeight = height; },
  };
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("initial empty readiness stays pending, then the first real offer recovers without restart", async () => {
  const harness = runtimeHarness();
  const logs: string[] = [];
  const handle = await runSolver({
    dryRun: true,
    api: "http://backend.test",
    levelsAuthToken: "v".repeat(16),
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 100,
    syncDependencies: harness.syncDependencies,
    validationDependencies: harness.validationDependencies,
    log: (message) => logs.push(message),
  });
  let ready = false;
  void handle.ready.then(() => { ready = true; });
  await waitFor(
    () => logs.some((message) => message.includes("initially empty raw book")),
    "initial empty validation block",
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ready).toBe(false);
  expect(harness.healthCalls()).toBeGreaterThanOrEqual(2);
  expect(harness.validationCalls()).toBe(0);
  expect(handle.validatedBook.size).toBe(0);

  harness.emitOffer();
  await handle.ready;
  expect(ready).toBe(true);
  expect(harness.validationCalls()).toBe(1);
  expect(handle.book.size).toBe(1);
  expect(handle.validatedBook.size).toBe(1);
  await handle.stop();
  expect(harness.closeCalls()).toBe(1);
});

test("stop before initial-empty combined readiness rejects ready and joins sync/validation", async () => {
  const harness = runtimeHarness();
  const logs: string[] = [];
  const handle = await runSolver({
    dryRun: true,
    api: "http://backend.test",
    levelsAuthToken: "v".repeat(16),
    resyncIntervalMs: 60_000,
    backendHealthCheckIntervalMs: 30_000,
    backendHealthMaxAgeMs: 60_000,
    startupTimeoutMs: 1_000,
    stopTimeoutMs: 100,
    syncDependencies: harness.syncDependencies,
    validationDependencies: harness.validationDependencies,
    log: (message) => logs.push(message),
  });
  const observedReady = handle.ready.catch((error) => error);
  await waitFor(
    () => logs.some((message) => message.includes("initially empty raw book")),
    "pending combined readiness",
  );
  await handle.stop();
  expect(await observedReady).toBeInstanceOf(Error);
  expect(harness.validationCalls()).toBe(0);
  expect(harness.closeCalls()).toBe(1);
});

test("runtime exposes contained validate-before-admit-and-execute trace ordering", async () => {
  const traceHash = "e".repeat(64);
  const traceGive = "ea536508097b4d5c33e444c0e15f2b0b50e3d6277b6a5535ad877b7595098b64";
  const traceNullifier = "2".repeat(64);
  const traceDetail: typeof runtimeDetail = {
    version: 1,
    offerId: traceHash,
    offerBech32: `blob-${traceHash}`,
    computed: {
      gives: [{ token: traceGive, amount: "1000", type: "SHIELDED" }],
      wants: [{ token: LEVELS_STOCK_TOKEN, amount: "900", type: "SHIELDED" }],
      expiresAt: OFFER_EXPIRES,
      firstSeenAt: "2026-08-14T00:00:00.000Z",
      inputNullifiers: [traceNullifier],
      status: "live",
    },
  };
  const harness = runtimeHarness({
    detail: traceDetail,
    verdict: (stateVersion) => ({
      schemaVersion: 1,
      profile: "offer-files-solver-v1",
      valid: true,
      live: true,
      claimedOfferId: traceHash,
      computedOfferId: traceHash,
      stateVersion,
      validatedAt: new Date(Date.now() - 60_000).toISOString(),
      status: "live",
      code: "VALID",
      computed: {
        gives: [{ token: traceGive, amount: "1000", kind: "SHIELDED" }],
        wants: [{ token: LEVELS_STOCK_TOKEN, amount: "900", kind: "SHIELDED" }],
        inputNullifiers: [traceNullifier],
        expiresAt: OFFER_EXPIRES,
      },
    }),
  });
  const traceKinds: string[] = [];
  let outcomes = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/v1/offers/${traceHash}/status`)) {
      return new Response(JSON.stringify({ offerId: traceHash, status: "live" }));
    }
    return new Response(JSON.stringify({ error: "unexpected test request" }), { status: 500 });
  }) as typeof fetch;
  const fakeWallet = {
    wallet: {
      stop: async () => {},
      shielded: { getAddress: async () => ({}) },
      initSwap: async () => ({ transaction: {} }),
      finalizeTransaction: async () => ({}),
      balanceFinalizedTransaction: async () => ({}),
      finalizeRecipe: async () => ({}),
      submitTransaction: async () => ({}),
    },
    zswapSecretKeys: {},
    dustSecretKey: {},
  } as any;
  let handle: Awaited<ReturnType<typeof runSolver>> | null = null;
  try {
    handle = await runSolver({
      dryRun: false,
      api: "http://backend.test",
      levelsAuthToken: "v".repeat(16),
      resyncIntervalMs: 60_000,
      backendHealthCheckIntervalMs: 30_000,
      backendHealthMaxAgeMs: 60_000,
      startupTimeoutMs: 1_000,
      walletOperationTimeoutMs: 1_000,
      balanceRefreshRetryMs: 100,
      stopTimeoutMs: 100,
      syncDependencies: harness.syncDependencies,
      validationDependencies: harness.validationDependencies,
      walletDependencies: {
        buildWallet: async () => fakeWallet,
        waitForSync: async () => {},
        shieldedBalances: async () => ({ [LEVELS_STOCK_TOKEN]: 5_000n }),
        shieldedKeys: () => ({}),
      } as any,
      onValidationTrace: (event) => {
        traceKinds.push(event.kind);
        throw new Error("diagnostic observer failure must be contained");
      },
      onOutcome: () => {
        outcomes++;
        harness.emitConsumed();
      },
      log: () => {},
    });
    harness.emitOffer();
    await handle.ready;
    await waitFor(() => outcomes > 0, "executor outcome after throwing trace observer");

    const admissionVerdict = traceKinds.indexOf("verdict");
    const admitted = traceKinds.indexOf("admitted");
    const executionStart = traceKinds.indexOf("execution-start");
    const executionVerdict = traceKinds.findIndex(
      (kind, index) => index > executionStart && kind === "verdict",
    );
    const executionValid = traceKinds.indexOf("execution-valid");
    expect(admissionVerdict).toBeGreaterThanOrEqual(0);
    expect(admitted).toBeGreaterThan(admissionVerdict);
    expect(executionStart).toBeGreaterThan(admitted);
    expect(executionVerdict).toBeGreaterThan(executionStart);
    expect(executionValid).toBeGreaterThan(executionVerdict);
    expect(harness.validationCalls()).toBeGreaterThanOrEqual(2);
    await waitFor(() => handle!.book.size === 0, "consumed trace-test offer removal");
  } finally {
    await handle?.stop();
    globalThis.fetch = originalFetch;
  }
});

test("a same-stream L2 advance preserves validated offers but rotates authoritative Stock", async () => {
  const harness = runtimeHarness();
  const thirdBalance = deferred<Record<string, bigint>>();
  const balances: Array<Promise<Record<string, bigint>>> = [
    Promise.resolve({ [LEVELS_STOCK_TOKEN]: 3_000n }),
    Promise.resolve({ [LEVELS_STOCK_TOKEN]: 2_000n }),
    thirdBalance.promise,
  ];
  const publications: Array<{ pairs: unknown[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    publications.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  let balanceReads = 0;
  const fakeWallet = {
    wallet: {
      stop: async () => {},
      shielded: { getAddress: async () => ({}) },
      initSwap: async () => ({ transaction: {} }),
      finalizeTransaction: async () => ({}),
      balanceFinalizedTransaction: async () => ({}),
      finalizeRecipe: async () => ({}),
      submitTransaction: async () => ({}),
    },
    zswapSecretKeys: {},
    dustSecretKey: {},
  } as any;
  let handle: Awaited<ReturnType<typeof runSolver>> | null = null;
  try {
    handle = await runSolver({
      dryRun: false,
      api: "http://backend.test",
      levelsAuthToken: "v".repeat(16),
      enableLevelsPublication: true,
      levelsPushIntervalMs: 60_000,
      resyncIntervalMs: 60_000,
      backendHealthCheckIntervalMs: 5,
      backendHealthMaxAgeMs: 1_000,
      startupTimeoutMs: 1_000,
      walletOperationTimeoutMs: 1_000,
      balanceRefreshRetryMs: 100,
      stopTimeoutMs: 100,
      syncDependencies: harness.syncDependencies,
      validationDependencies: harness.validationDependencies,
      walletDependencies: {
        buildWallet: async () => fakeWallet,
        waitForSync: async () => {},
        shieldedBalances: async () => {
          balanceReads++;
          return await balances.shift()!;
        },
        shieldedKeys: () => ({}),
      } as any,
      log: () => {},
    });
    harness.emitOffer();
    await handle.ready;
    await waitFor(
      () => publications.some((publication) => publication.pairs.length > 0),
      "non-empty levels publication",
    );
    expect(balanceReads).toBe(2);
    expect(handle.stock.available(LEVELS_STOCK_TOKEN)).toBe(2_000n);
    expect(handle.validatedBook.size).toBe(1);
    expect(harness.validationCalls()).toBe(1);
    const evidence = handle.validatedBook.get(OFFER_HASH)!.validation;
    const lastNonEmpty = publications.findLastIndex(
      (publication) => publication.pairs.length > 0,
    );

    harness.setHealthHeight("8");
    await waitFor(() => balanceReads === 3, "height-8 inventory refresh");
    expect(handle.stock.tokens()).toEqual([]);
    expect(handle.validatedBook.size).toBe(1);
    expect(handle.validatedBook.get(OFFER_HASH)!.validation).toBe(evidence);
    expect(harness.validationCalls()).toBe(1);
    expect(publications.slice(lastNonEmpty + 1).some(
      (publication) => publication.pairs.length === 0,
    )).toBe(true);

    thirdBalance.resolve({ [LEVELS_STOCK_TOKEN]: 1_500n });
    await waitFor(
      () => handle!.stock.available(LEVELS_STOCK_TOKEN) === 1_500n,
      "height-8 inventory restore",
    );
    expect(handle.validatedBook.size).toBe(1);
    expect(harness.validationCalls()).toBe(1);
  } finally {
    await handle?.stop();
    globalThis.fetch = originalFetch;
  }
});

test("runtime source feeds Engine only from the ephemeral validated book", () => {
  const source = readFileSync(new URL("./src/run.ts", import.meta.url), "utf8");
  expect(source).toContain("findCandidates(validationGate.book");
  expect(source).not.toMatch(/findCandidates\(book\s*,/);
});
