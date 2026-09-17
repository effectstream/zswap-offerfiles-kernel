export const SOLVER_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type SolverShutdownSignal = (typeof SOLVER_SHUTDOWN_SIGNALS)[number];

export interface SignalSource {
  addListener: (signal: SolverShutdownSignal, listener: () => void) => void;
  removeListener: (signal: SolverShutdownSignal, listener: () => void) => void;
}

export interface StartupHandle {
  ready: Promise<void>;
  stop: () => Promise<void>;
}

export interface SignalHandledResult {
  signal: SolverShutdownSignal;
  /** A bounded stop failure is reported to the entrypoint instead of becoming
   * an unhandled rejection inside the signal callback. */
  stopError?: unknown;
}

export interface SignalOwnershipOptions {
  signalSource?: SignalSource;
  onSignalHandled?: (result: SignalHandledResult) => void;
  /** Maximum grace for an acquisition to observe first-signal cancellation
   * and return an owned handle. */
  acquisitionShutdownGraceMs?: number;
  /** Immediate escalation hook for a second signal while graceful shutdown is
   * still pending. Entrypoints use this to force process termination. */
  onSecondSignal?: (signal: SolverShutdownSignal) => void;
}

const processSignalSource: SignalSource = {
  addListener: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.off(signal, listener);
  },
};

type StartupOutcome =
  | { kind: "ready" }
  | { kind: "ready-error"; error: unknown }
  | { kind: "signal"; signal: SolverShutdownSignal };

/**
 * Install process-signal ownership before starting the solver, then keep that
 * ownership through readiness. A signal received while acquisition is pending
 * aborts acquisition and gives it only a bounded grace to return an owned
 * handle. A signal received while readiness is pending starts stop
 * immediately; a second signal is delegated to the escalation hook.
 *
 * The returned value is undefined when a signal stopped startup before
 * readiness. Once readiness succeeds, signal ownership remains installed and
 * stops the returned handle on the first signal. Startup failures always remove
 * the installed listeners and stop an acquired handle before being rethrown.
 */
export async function startWithSignalOwnership<T extends StartupHandle>(
  acquire: (signal: AbortSignal) => Promise<T>,
  options: SignalOwnershipOptions = {},
): Promise<T | undefined> {
  const source = options.signalSource ?? processSignalSource;
  const acquisitionShutdownGraceMs = options.acquisitionShutdownGraceMs ?? 5_000;
  if (!Number.isSafeInteger(acquisitionShutdownGraceMs) || acquisitionShutdownGraceMs <= 0) {
    throw new RangeError(
      `acquisitionShutdownGraceMs must be a positive safe integer, got ${acquisitionShutdownGraceMs}`,
    );
  }
  const installed = new Map<SolverShutdownSignal, () => void>();
  let listenersRemoved = false;
  let startupPending = true;
  let handle: T | undefined;
  let requestedSignal: SolverShutdownSignal | undefined;
  let resolveSignal!: (signal: SolverShutdownSignal) => void;
  const signalRequested = new Promise<SolverShutdownSignal>((resolve) => {
    resolveSignal = resolve;
  });
  let stopPromise: Promise<void> | undefined;
  let signalCompletion: Promise<void> | undefined;
  const acquisitionOwner = new AbortController();

  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    for (const [signal, listener] of installed) {
      source.removeListener(signal, listener);
    }
    installed.clear();
  };

  const stopOnce = (): Promise<void> => {
    if (!handle) {
      return Promise.reject(new Error("solver shutdown requested before handle acquisition"));
    }
    stopPromise ??= Promise.resolve().then(() => handle!.stop());
    return stopPromise;
  };

  const completeSignal = (signal: SolverShutdownSignal): Promise<void> => {
    signalCompletion ??= (async () => {
      let stopError: unknown;
      try {
        await stopOnce();
      } catch (err) {
        stopError = err;
      }
      removeListeners();
      try {
        options.onSignalHandled?.(
          stopError === undefined ? { signal } : { signal, stopError },
        );
      } catch {
        // The observer cannot regain ownership after resources are stopped.
      }
    })();
    return signalCompletion;
  };

  try {
    for (const signal of SOLVER_SHUTDOWN_SIGNALS) {
      const listener = (): void => {
        if (requestedSignal !== undefined) {
          try {
            options.onSecondSignal?.(signal);
          } catch {
            // Escalation is deliberately observer-owned; a throwing hook does
            // not undo the first signal's graceful cancellation.
          }
          return;
        }
        requestedSignal = signal;
        acquisitionOwner.abort(new Error(`solver startup cancelled by ${signal}`));
        resolveSignal(signal);
        if (!handle) return;
        if (startupPending) {
          // Begin shutdown in the signal turn. The startup path below observes
          // this same memoized promise and owns completion/error reporting.
          void stopOnce().catch(() => {});
        } else {
          void completeSignal(signal);
        }
      };
      source.addListener(signal, listener);
      installed.set(signal, listener);
    }

    // Convert readiness rejection into data so losing a race to a signal still
    // observes the promise and cannot produce an unhandled rejection later. It
    // is armed immediately after acquisition because an earlier signal can make
    // stop reject readiness before the normal race begins.
    const acquisition = Promise.resolve().then(() => acquire(acquisitionOwner.signal));
    void acquisition.catch(() => {});
    const acquired = acquisition.then(
      (value) => ({ kind: "acquired" as const, value }),
      (error: unknown) => ({ kind: "acquire-error" as const, error }),
    );
    const acquisitionOutcome = await Promise.race([
      acquired,
      signalRequested.then((signal) => ({ kind: "signal" as const, signal })),
    ]);

    if (acquisitionOutcome.kind === "signal") {
      // Give the acquisition a short, explicit opportunity to return an owner
      // after observing AbortSignal. If it ignores cancellation, report the
      // signal anyway and observe/stop any late handle without holding process
      // shutdown for the full wallet startup budget.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = await Promise.race([
        acquired,
        new Promise<{ kind: "grace-expired" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "grace-expired" }), acquisitionShutdownGraceMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      let acquisitionStopError: unknown;
      if (grace.kind === "acquired") {
        handle = grace.value;
      } else if (grace.kind === "acquire-error") {
        // Cancellation-induced acquisition failure is successful signal
        // ownership, not a startup error.
      } else {
        acquisitionStopError = new Error(
          `solver acquisition did not stop within ${acquisitionShutdownGraceMs} ms`,
        );
        void acquisition.then(
          async (lateHandle) => {
            try {
              await lateHandle.stop();
            } catch {
              // Process shutdown no longer depends on a cancellation-ignoring
              // acquisition, but its eventual owner is still observed.
            }
          },
          () => {},
        );
      }
      startupPending = false;
      if (handle) await completeSignal(acquisitionOutcome.signal);
      else {
        removeListeners();
        try {
          options.onSignalHandled?.(
            acquisitionStopError === undefined
              ? { signal: acquisitionOutcome.signal }
              : { signal: acquisitionOutcome.signal, stopError: acquisitionStopError },
          );
        } catch {
          // Observer cannot regain startup ownership.
        }
      }
      return undefined;
    }
    if (acquisitionOutcome.kind === "acquire-error") throw acquisitionOutcome.error;
    handle = acquisitionOutcome.value;
    const readiness: Promise<StartupOutcome> = handle.ready.then(
      () => ({ kind: "ready" }),
      (error: unknown) => ({ kind: "ready-error", error }),
    );
    if (requestedSignal !== undefined) {
      startupPending = false;
      await completeSignal(requestedSignal);
      return undefined;
    }

    const outcome = await Promise.race<StartupOutcome>([
      readiness,
      signalRequested.then((signal) => ({ kind: "signal", signal })),
    ]);

    if (outcome.kind === "signal") {
      startupPending = false;
      await completeSignal(outcome.signal);
      return undefined;
    }
    if (outcome.kind === "ready-error") throw outcome.error;

    // Readiness and a process signal can settle in the same turn. Promise.race
    // may choose readiness even though the signal listener has already claimed
    // shutdown. Re-check the synchronous signal latch before handing a live
    // handle back to the entrypoint.
    if (requestedSignal !== undefined) {
      startupPending = false;
      await completeSignal(requestedSignal);
      return undefined;
    }

    startupPending = false;
    return handle;
  } catch (startupError) {
    startupPending = false;
    removeListeners();
    if (handle) {
      try {
        await stopOnce();
      } catch (stopError) {
        throw new AggregateError(
          [startupError, stopError],
          "solver startup failed and acquired-handle cleanup also failed",
        );
      }
    }
    throw startupError;
  }
}
