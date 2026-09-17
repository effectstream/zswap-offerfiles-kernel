import { expect, test } from "bun:test";

import {
  SOLVER_SHUTDOWN_SIGNALS,
  startWithSignalOwnership,
  type SignalHandledResult,
  type SignalSource,
  type SolverShutdownSignal,
} from "./src/startup-signals.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSignals implements SignalSource {
  readonly #listeners = new Map<SolverShutdownSignal, Set<() => void>>();

  addListener(signal: SolverShutdownSignal, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  removeListener(signal: SolverShutdownSignal, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  emit(signal: SolverShutdownSignal): void {
    for (const listener of [...(this.#listeners.get(signal) ?? [])]) listener();
  }

  listenerCount(): number {
    return SOLVER_SHUTDOWN_SIGNALS.reduce(
      (count, signal) => count + (this.#listeners.get(signal)?.size ?? 0),
      0,
    );
  }
}

test("a signal before handle acquisition is remembered and stops it exactly once", async () => {
  const signals = new FakeSignals();
  const acquisition = deferred<{
    ready: Promise<void>;
    stop: () => Promise<void>;
  }>();
  const readiness = deferred<void>();
  const handled: SignalHandledResult[] = [];
  let stops = 0;

  const startup = startWithSignalOwnership(() => acquisition.promise, {
    signalSource: signals,
    onSignalHandled: (result) => handled.push(result),
  });

  expect(signals.listenerCount()).toBe(2);
  signals.emit("SIGTERM");
  expect(stops).toBe(0);

  acquisition.resolve({
    ready: readiness.promise,
    stop: async () => {
      stops++;
    },
  });

  expect(await startup).toBeUndefined();
  expect(stops).toBe(1);
  expect(handled).toEqual([{ signal: "SIGTERM" }]);
  expect(signals.listenerCount()).toBe(0);
});

test("an abort-aware acquisition is cancelled by the first signal", async () => {
  const signals = new FakeSignals();
  const handled: SignalHandledResult[] = [];
  let acquisitionSignal: AbortSignal | undefined;

  const startup = startWithSignalOwnership(
    async (signal) => {
      acquisitionSignal = signal;
      return await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(signal.reason);
        if (signal.aborted) rejectAbort();
        else signal.addEventListener("abort", rejectAbort, { once: true });
      });
    },
    {
      signalSource: signals,
      acquisitionShutdownGraceMs: 100,
      onSignalHandled: (result) => handled.push(result),
    },
  );
  await Promise.resolve();
  signals.emit("SIGINT");

  expect(await startup).toBeUndefined();
  expect(acquisitionSignal?.aborted).toBe(true);
  expect(handled).toEqual([{ signal: "SIGINT" }]);
  expect(signals.listenerCount()).toBe(0);
});

test("a cancellation-ignoring acquisition cannot hold first-signal shutdown open", async () => {
  const signals = new FakeSignals();
  const acquisition = deferred<{
    ready: Promise<void>;
    stop: () => Promise<void>;
  }>();
  const lateStopped = deferred<void>();
  const handled: SignalHandledResult[] = [];

  const startup = startWithSignalOwnership(() => acquisition.promise, {
    signalSource: signals,
    acquisitionShutdownGraceMs: 5,
    onSignalHandled: (result) => handled.push(result),
  });
  signals.emit("SIGTERM");

  expect(await startup).toBeUndefined();
  expect(handled).toHaveLength(1);
  expect(handled[0]?.signal).toBe("SIGTERM");
  expect(handled[0]?.stopError).toBeInstanceOf(Error);
  expect((handled[0]?.stopError as Error).message).toContain(
    "solver acquisition did not stop within 5 ms",
  );
  expect(signals.listenerCount()).toBe(0);

  acquisition.resolve({
    ready: new Promise<void>(() => {}),
    stop: async () => lateStopped.resolve(),
  });
  await lateStopped.promise;
});

test("a second signal escalates while first-signal acquisition shutdown is pending", async () => {
  const signals = new FakeSignals();
  const acquisition = deferred<{
    ready: Promise<void>;
    stop: () => Promise<void>;
  }>();
  const escalated: SolverShutdownSignal[] = [];
  let stops = 0;

  const startup = startWithSignalOwnership(() => acquisition.promise, {
    signalSource: signals,
    acquisitionShutdownGraceMs: 100,
    onSecondSignal: (signal) => escalated.push(signal),
  });
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  expect(escalated).toEqual(["SIGTERM"]);

  acquisition.resolve({
    ready: new Promise<void>(() => {}),
    stop: async () => {
      stops++;
    },
  });
  expect(await startup).toBeUndefined();
  expect(stops).toBe(1);
  expect(signals.listenerCount()).toBe(0);
});

test("a signal before readiness stops immediately without waiting for ready", async () => {
  const signals = new FakeSignals();
  const readiness = deferred<void>();
  const stopped = deferred<void>();
  const stopStarted = deferred<void>();
  let stops = 0;

  const startup = startWithSignalOwnership(
    async () => ({
      ready: readiness.promise,
      stop: async () => {
        stops++;
        stopStarted.resolve();
        await stopped.promise;
      },
    }),
    { signalSource: signals },
  );

  // Let acquisition finish and the helper enter its readiness race.
  await Promise.resolve();
  signals.emit("SIGINT");
  await stopStarted.promise;
  expect(stops).toBe(1);

  stopped.resolve();
  expect(await startup).toBeUndefined();
  expect(signals.listenerCount()).toBe(0);
});

test("a signal in the same turn as readiness wins shutdown ownership", async () => {
  const signals = new FakeSignals();
  const readiness = deferred<void>();
  const handled: SignalHandledResult[] = [];
  let stops = 0;

  const startup = startWithSignalOwnership(
    async () => ({
      ready: readiness.promise,
      stop: async () => {
        stops++;
      },
    }),
    {
      signalSource: signals,
      onSignalHandled: (result) => handled.push(result),
    },
  );
  await Promise.resolve();
  readiness.resolve();
  signals.emit("SIGTERM");

  expect(await startup).toBeUndefined();
  expect(stops).toBe(1);
  expect(handled).toEqual([{ signal: "SIGTERM" }]);
  expect(signals.listenerCount()).toBe(0);
});

test("the first post-ready signal owns one stop and removes every listener", async () => {
  const signals = new FakeSignals();
  const stopped = deferred<void>();
  const signalHandled = deferred<SignalHandledResult>();
  let stops = 0;

  const handle = {
    ready: Promise.resolve(),
    stop: async () => {
      stops++;
      await stopped.promise;
    },
  };
  expect(
    await startWithSignalOwnership(async () => handle, {
      signalSource: signals,
      onSignalHandled: (result) => signalHandled.resolve(result),
    }),
  ).toBe(handle);
  expect(signals.listenerCount()).toBe(2);

  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  expect(stops).toBe(0);
  await Promise.resolve();
  expect(stops).toBe(1);

  stopped.resolve();
  expect(await signalHandled.promise).toEqual({ signal: "SIGINT" });
  expect(stops).toBe(1);
  expect(signals.listenerCount()).toBe(0);
  signals.emit("SIGTERM");
  expect(stops).toBe(1);
});

test("readiness failure stops the acquired handle, removes listeners, and rethrows", async () => {
  const signals = new FakeSignals();
  const failure = new Error("initial book snapshot failed");
  let stops = 0;

  await expect(
    startWithSignalOwnership(
      async () => ({
        ready: Promise.reject(failure),
        stop: async () => {
          stops++;
        },
      }),
      { signalSource: signals },
    ),
  ).rejects.toBe(failure);
  expect(stops).toBe(1);
  expect(signals.listenerCount()).toBe(0);
});

test("acquisition failure removes handlers without inventing a stop owner", async () => {
  const signals = new FakeSignals();
  const failure = new Error("wallet acquisition failed");

  await expect(
    startWithSignalOwnership(async () => {
      throw failure;
    }, { signalSource: signals }),
  ).rejects.toBe(failure);
  expect(signals.listenerCount()).toBe(0);
});

test("acquisition shutdown grace must be a positive safe integer", async () => {
  const signals = new FakeSignals();
  await expect(
    startWithSignalOwnership(
      async () => ({ ready: Promise.resolve(), stop: async () => {} }),
      { signalSource: signals, acquisitionShutdownGraceMs: 0 },
    ),
  ).rejects.toThrow("acquisitionShutdownGraceMs must be a positive safe integer");
  expect(signals.listenerCount()).toBe(0);
});
