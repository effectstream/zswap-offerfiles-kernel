// A fixed-rate, never-overlapping scheduler with the counters `/health` and
// `/metrics` report. Pure: the clock and the timer are injected, so every
// behaviour below (cadence, overrun, no overlap, p95) is a unit test with no
// real time passing (spec FR-011, FR-013, US3 scenario 3).
//
// FIXED RATE, NOT FIXED DELAY. Tick N+1 is due at `startedAt(N) + intervalMs`,
// not at `finishedAt(N) + intervalMs`, so a 12-second tick on a 60-second
// interval still runs at 0:00, 1:00, 2:00 — the operator's "one offer a minute"
// stays true. A tick that OVERRUNS its interval makes the next one due in the
// past; the scheduler then warns, counts an overrun, and starts the next tick
// IMMEDIATELY. It never queues and never runs two ticks at once: the next timer
// is armed only after the current tick has settled, which is the property that
// makes the exact-coin guarantee safe (two concurrent ticks would race over the
// module-level coin pin).
//
// The scheduler owns no domain knowledge. It calls `tick()`, reads the outcome
// it returns, and counts. A tick that THROWS is counted as a failure with the
// error's message — the loop must survive any single bad tick (US3).

/** What one tick did. `mode` mirrors FR-010's three outcomes plus `idle`
 *  (nothing to do — reserved; the poster always mints or degrades today). */
export type TickMode = "mint" | "reoffer" | "degraded" | "idle";

export interface TickOutcome {
  /** False when the tick failed. A `degraded` tick that did nothing wrong is
   *  still `ok: true` — it is a state of the world, not a fault. */
  ok: boolean;
  mode: TickMode;
  /** The offer this tick posted, when it posted one. */
  offerId?: string;
  /** The coin this tick used. */
  nonce?: string;
  /** A mint transaction actually landed in this tick. Counted separately from
   *  `mode` because a `mint` tick can fail AFTER the mint (the coin is then on
   *  chain and journaled, and SC-003's "mints < ticks" must still be truthful). */
  minted?: boolean;
  /** Failure taxonomy label (FR-015), e.g. `insufficient_dust`. */
  failure?: string;
  /** One-line message for the log and `/health`. */
  error?: string;
}

export interface SchedulerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real time. Named so a test can see what it is replacing. */
export const systemTimers: SchedulerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  intervalMs: number;
  /** Runs one tick. Must resolve; a rejection is caught and counted. */
  tick(): Promise<TickOutcome>;
  timers?: SchedulerTimers;
  /** Structured warning sink (overruns). Defaults to `console.warn`. */
  warn?(msg: string): void;
  /** How many tick durations the p95 window keeps. */
  durationWindow?: number;
}

export interface SchedulerStats {
  /** Ticks that have STARTED. */
  ticks: number;
  mints: number;
  reoffers: number;
  degraded: number;
  success: number;
  failure: number;
  overruns: number;
  /** Consecutive failing ticks — what `HEALTH_STALE_TICKS` compares against. */
  consecutiveFailures: number;
  startedAt: number;
  lastTickAt: number | null;
  lastTickMs: number | null;
  lastMode: TickMode | null;
  lastOfferId: string | null;
  lastError: string | null;
  lastFailure: string | null;
  p95TickMs: number | null;
  p50TickMs: number | null;
}

/** Nearest-rank percentile over a sorted copy. `p95` of 1 sample is that
 *  sample — deliberately, so `/health` says something from the first tick. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

export class PosterScheduler {
  readonly intervalMs: number;
  #tick: () => Promise<TickOutcome>;
  #timers: SchedulerTimers;
  #warn: (msg: string) => void;
  #window: number;
  #durations: number[] = [];
  #handle: unknown = null;
  #running = false;
  #stopped = true;
  /** Resolves when the in-flight tick settles; `null` when idle. */
  #inFlight: Promise<void> | null = null;

  #stats: SchedulerStats;

  constructor(opts: SchedulerOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error(`PosterScheduler: intervalMs must be > 0, got ${opts.intervalMs}`);
    }
    this.intervalMs = opts.intervalMs;
    this.#tick = opts.tick;
    this.#timers = opts.timers ?? systemTimers;
    this.#warn = opts.warn ?? ((msg: string) => console.warn(`[offer-poster] ${msg}`));
    this.#window = opts.durationWindow ?? 100;
    this.#stats = {
      ticks: 0,
      mints: 0,
      reoffers: 0,
      degraded: 0,
      success: 0,
      failure: 0,
      overruns: 0,
      consecutiveFailures: 0,
      startedAt: this.#timers.now(),
      lastTickAt: null,
      lastTickMs: null,
      lastMode: null,
      lastOfferId: null,
      lastError: null,
      lastFailure: null,
      p95TickMs: null,
      p50TickMs: null,
    };
  }

  /** A snapshot — mutating it does not touch the scheduler. */
  stats(): SchedulerStats {
    return { ...this.#stats };
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Arm the loop. The FIRST tick runs immediately (a service that waits a
   *  whole interval before doing anything looks broken on `docker logs`). */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#stats.startedAt = this.#timers.now();
    this.#arm(0);
  }

  /**
   * Stop scheduling and wait for the in-flight tick to settle.
   *
   * Resolves as soon as the current tick finishes; the caller bounds the total
   * wait with `SHUTDOWN_GRACE_MS` (FR-012 / US3 scenario 2). Idempotent.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== null) {
      this.#timers.clearTimeout(this.#handle);
      this.#handle = null;
    }
    if (this.#inFlight !== null) await this.#inFlight;
  }

  /** Run exactly one tick now, counting it like a scheduled one. Used by the
   *  dry run and by tests; does not touch the timer. */
  async runOnce(): Promise<TickOutcome> {
    return await this.#runTick();
  }

  #arm(delayMs: number): void {
    if (this.#stopped) return;
    this.#handle = this.#timers.setTimeout(() => {
      this.#handle = null;
      // The promise is intentionally not awaited here: this is the timer
      // callback. `#inFlight` is what `stop()` waits on.
      void this.#cycle();
    }, delayMs);
  }

  async #cycle(): Promise<void> {
    const startedAt = this.#timers.now();
    const settled = this.#runTick().then(
      () => undefined,
      () => undefined,
    );
    this.#inFlight = settled;
    await settled;
    this.#inFlight = null;

    const dueAt = startedAt + this.intervalMs;
    const now = this.#timers.now();
    if (now >= dueAt) {
      // Overrun: the tick took at least a whole interval. Warn with the measured
      // duration (Edge Cases: "no queueing") and go again at once.
      this.#stats.overruns += 1;
      this.#warn(
        `tick overran the interval: took ${now - startedAt}ms with POST_INTERVAL_MS=${this.intervalMs}; ` +
          `next tick starts immediately (overruns=${this.#stats.overruns})`,
      );
      this.#arm(0);
    } else {
      this.#arm(dueAt - now);
    }
  }

  async #runTick(): Promise<TickOutcome> {
    if (this.#running) {
      // Unreachable through the timer path (the next timer is armed only after
      // the tick settles) but `runOnce` is public, so make the invariant real.
      throw new Error("PosterScheduler: a tick is already running (ticks never overlap)");
    }
    this.#running = true;
    const startedAt = this.#timers.now();
    this.#stats.ticks += 1;
    let outcome: TickOutcome;
    try {
      outcome = await this.#tick();
    } catch (err) {
      outcome = {
        ok: false,
        mode: "degraded",
        failure: "tick_threw",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.#running = false;
    }

    const elapsed = Math.max(0, this.#timers.now() - startedAt);
    this.#durations.push(elapsed);
    if (this.#durations.length > this.#window) this.#durations.shift();

    const s = this.#stats;
    s.lastTickAt = startedAt;
    s.lastTickMs = elapsed;
    s.lastMode = outcome.mode;
    s.lastError = outcome.error ?? null;
    s.lastFailure = outcome.failure ?? null;
    if (outcome.offerId !== undefined) s.lastOfferId = outcome.offerId;
    if (outcome.minted === true) s.mints += 1;
    if (outcome.mode === "reoffer") s.reoffers += 1;
    if (outcome.mode === "degraded") s.degraded += 1;
    if (outcome.ok) {
      s.success += 1;
      s.consecutiveFailures = 0;
    } else {
      s.failure += 1;
      s.consecutiveFailures += 1;
    }
    s.p95TickMs = percentile(this.#durations, 95);
    s.p50TickMs = percentile(this.#durations, 50);
    return outcome;
  }
}
