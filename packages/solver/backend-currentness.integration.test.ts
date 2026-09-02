import { expect, test } from "bun:test";

import {
  ApiRequestError,
  type BackendSyncHealth,
  type OfferUpdatesStreamOpts,
} from "@zswap-da/solver-core/api-client";
import { createInventoryRefreshController } from "./src/run.ts";
import {
  startBookSync,
  type BackendCurrentnessState,
  type SyncDependencies,
} from "./src/book-sync.ts";
import { Stock } from "./src/stock.ts";

const TOKEN = "a".repeat(64);

const healthy = (height = "1", ts = Date.now()): BackendSyncHealth => ({
  ts,
  status: "ok",
  blockL2: { height },
  ntp: { current: 10, tip: 10, pct: 100, lagBlocks: 0, lagSeconds: 0 },
  midnight: { current: 20, fetched: 20, tip: 20, pct: 100, lagBlocks: 0 },
  celestia: { current: 30, fetched: 30, tip: 30, pct: 100, lagBlocks: 0 },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const waitUntil = async (condition: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

function harness(
  loadHealth: SyncDependencies["getBackendSyncHealth"],
  onCurrentnessChange?: (state: BackendCurrentnessState) => void,
) {
  // The real option shape, so a test double cannot drift from what
  // `openOfferUpdatesStream` actually hands the book mirror.
  let handlers!: OfferUpdatesStreamOpts;
  let pageCalls = 0;
  const dependencies: SyncDependencies = {
    getZswapsPage: async () => {
      pageCalls++;
      return { offers: [], nextCursor: null };
    },
    getZswapByHash: async () => {
      throw new Error("empty book must not fetch offer detail");
    },
    getBackendSyncHealth: loadHealth,
    openUpdatesStream: (_onEvent, options = {}) => {
      handlers = options;
      options.onOpen?.({ streamId: "0".repeat(32), blockL2Height: null });
      return { close: async () => {} };
    },
  };
  const sync = startBookSync({
    api: "http://backend",
    dependencies,
    resyncIntervalMs: 60_000,
    readinessTimeoutMs: 500,
    backendHealthCheckIntervalMs: 10,
    backendHealthMaxAgeMs: 100,
    backendHealthRequestTimeoutMs: 50,
    ...(onCurrentnessChange ? { onCurrentnessChange } : {}),
  });
  return { sync, handlers: () => handlers, pageCalls: () => pageCalls };
}

for (const [name, error] of [
  [
    "malformed health",
    new ApiRequestError("malformed", "GET /v1/health/sync", "unknown response field"),
  ],
  [
    "health timeout",
    new ApiRequestError("timeout", "GET /v1/health/sync", "timed out after 50 ms"),
  ],
] as const) {
  test(`${name} cannot start a snapshot or settle readiness`, async () => {
    const seen: BackendCurrentnessState[] = [];
    const { sync, pageCalls } = harness(async () => { throw error; }, (state) => seen.push(state));
    let readySettled = false;
    const observedReady = sync.ready.then(
      () => { readySettled = true; },
      (reason) => { readySettled = true; return reason; },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sync.isCurrent()).toBe(false);
    expect(readySettled).toBe(false);
    expect(pageCalls()).toBe(0);
    expect(sync.currentness()).toMatchObject({
      kind: "blocked",
      reason: name === "malformed health" ? "health-malformed" : "health-unavailable",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: "blocked", reason: "initializing" });
    expect(seen[1]).toMatchObject({
      kind: "blocked",
      reason: name === "malformed health" ? "health-malformed" : "health-unavailable",
    });

    await sync.stop();
    expect(await observedReady).toBeInstanceOf(Error);
  });
}

test("a stale health transition withdraws executable Stock immediately", async () => {
  let healthCalls = 0;
  const stock = new Stock();
  const readiness: boolean[] = [];
  const inventory = createInventoryRefreshController({
    stock,
    readBalances: async () => ({ [TOKEN]: 500n }),
    onReadinessChange: (ready) => readiness.push(ready),
  });
  const states: BackendCurrentnessState[] = [];
  const { sync } = harness(
    async () => {
      healthCalls++;
      return healthCalls <= 2 ? healthy("1") : healthy("1", Date.now() - 1_000);
    },
    (state) => {
      states.push(state);
      if (state.kind === "current") void inventory.refresh();
      else inventory.invalidate(new Error(state.reason));
    },
  );

  await sync.ready;
  await waitUntil(() => inventory.isReady(), "initial inventory authority");
  expect(stock.available(TOKEN)).toBe(500n);

  await waitUntil(
    () => states.some((state) => state.kind === "blocked" && state.reason === "health-stale"),
    "stale health withdrawal",
  );
  expect(sync.isCurrent()).toBe(false);
  expect(inventory.isReady()).toBe(false);
  expect(stock.tokens()).toEqual([]);
  expect(readiness).toEqual([true, false]);

  await sync.stop();
  inventory.stop();
});

test("a late old-generation health result cannot revoke exactly-once recovery", async () => {
  const oldHealth = deferred<BackendSyncHealth>();
  let healthCalls = 0;
  let inventoryReads = 0;
  const stock = new Stock();
  const inventoryTransitions: boolean[] = [];
  const inventory = createInventoryRefreshController({
    stock,
    readBalances: async () => ({ [TOKEN]: BigInt(++inventoryReads * 100) }),
    onReadinessChange: (ready) => inventoryTransitions.push(ready),
  });
  const states: BackendCurrentnessState[] = [];
  const { sync, handlers } = harness(
    async () => {
      healthCalls++;
      if (healthCalls === 3) return oldHealth.promise;
      // Ordinary health renewal at the same L2 does not rotate authority. The
      // reconnect advances it exactly once to a new validation/inventory
      // generation.
      return healthy(healthCalls < 3 ? "1" : "2");
    },
    (state) => {
      states.push(state);
      if (state.kind === "current") void inventory.refresh();
      else inventory.invalidate(new Error(state.reason));
    },
  );

  await sync.ready;
  await waitUntil(() => inventory.isReady(), "initial inventory refresh");
  await waitUntil(() => healthCalls >= 3, "old generation health request");

  handlers().onDisconnect?.();
  // Resubscribed with a fresh subscription, exactly as the stream client does.
  // `blockL2Height: null` keeps the anchor absent, which is what the previous
  // argument-less call produced (`subscription?.blockL2Height ?? null`).
  handlers().onOpen?.({ streamId: "1".repeat(32), blockL2Height: null });
  await waitUntil(
    () => sync.currentness().kind === "current" && sync.currentness().streamGeneration === 3,
    "new generation recovery",
  );
  await waitUntil(() => inventoryReads === 2 && inventory.isReady(), "recovery inventory refresh");
  expect(stock.available(TOKEN)).toBe(200n);

  oldHealth.resolve({ ...healthy("stale"), status: "syncing" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(sync.currentness()).toMatchObject({ kind: "current", streamGeneration: 3 });
  expect(states.map((state) => state.kind)).toEqual([
    "blocked",
    "current",
    "blocked",
    "blocked",
    "current",
  ]);
  expect(inventoryTransitions).toEqual([true, false, true]);
  expect(inventoryReads).toBe(2);

  await sync.stop();
  inventory.stop();
});

test("stop cancels and joins an active health check and clears its cadence", async () => {
  let healthCalls = 0;
  let activeHealthStarted = false;
  const { sync } = harness(async (target) => {
    healthCalls++;
    if (healthCalls <= 2) return healthy("1");
    activeHealthStarted = true;
    return await new Promise<BackendSyncHealth>((_resolve, reject) => {
      const signal = typeof target === "object" ? target?.signal : undefined;
      const abort = () => reject(signal?.reason ?? new Error("health owner stopped"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });

  await sync.ready;
  await waitUntil(() => activeHealthStarted, "active health check");
  const started = Date.now();
  await sync.stop();
  expect(Date.now() - started).toBeLessThan(200);
  const stoppedAt = healthCalls;
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(healthCalls).toBe(stoppedAt);
  expect(sync.isCurrent()).toBe(false);
  expect(sync.currentness()).toMatchObject({ kind: "blocked", reason: "stopped" });
});
