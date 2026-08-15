import { expect, test } from "bun:test";

import {
  armBookReadyDecisionGate,
  createBookReadyDecisionGate,
  createInventoryRefreshController,
  initializeOwnedResource,
} from "./src/run.ts";
import { Stock } from "./src/stock.ts";

const TOKEN = "a".repeat(64);

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
