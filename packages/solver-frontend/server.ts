/**
 * The COW solver monitor — a LIGHT read-only aggregator (00007 FR-009…FR-011).
 *
 * WHAT IT IS. One Bun process, zero runtime dependencies, no build step, no
 * persistence. It joins three sources into one `MonitorSnapshot` and fans that
 * out to browsers:
 *
 *   solver  `GET /status/stream` (SSE, preferred) and `GET /status/snapshot`
 *           (fallback), both bearer-authenticated with the token from
 *           `SOLVER_FRONTEND_SOLVER_STATUS_TOKEN`.
 *   kernel  `GET /v1/health/sync`, `/v1/offers`, `/v1/known-tokens`,
 *           `/v1/pairs`, and — only where the node has it — `/v1/prices`.
 *   relay   `GET /tokens`, its whole public surface.
 *
 * WHY A SEPARATE PROCESS (Q-S-3 A). The single most important moment for this
 * page is the one where the solver is down, and a page served BY the solver is
 * blank exactly then. This process outlives the solver, keeps the last snapshot
 * it saw, and can therefore say "SOLVER UNREACHABLE, last seen 14:05:10"
 * instead of failing to load.
 *
 * FOUR RULES THIS FILE ENFORCES:
 *
 *  1. **The status bearer never leaves the process.** It is attached to solver
 *     requests and to nothing else; no `/api/*` response, no page, and no log
 *     line contains it. `server.test.ts` greps every response body for it.
 *  2. **No proxying.** There is no route that forwards a caller-chosen path to
 *     the solver or the kernel (FR-011). The five upstream URLs this file can
 *     build are literals; a browser cannot influence any of them except through
 *     the price query, which is built from colours the snapshot already carries
 *     and is bounded at 50 entries.
 *  3. **Bounded in-memory state only.** The transition history is capped by
 *     `SOLVER_FRONTEND_HISTORY_LIMIT`, the book poll is capped at 100 rows by
 *     the kernel's own limit, and the solver snapshot is already capped by the
 *     status contract. Nothing is written to disk.
 *  4. **An ended solver stream is NORMAL.** Bun does not report SSE
 *     disconnects, so the solver closes each `/status/stream` after
 *     `STATUS_STREAM_MAX_LIFETIME_MS` (5 min) to keep its client cap
 *     self-healing (plan Q-A-1). A stream that ends after delivering frames is
 *     reconnected immediately and raises NO alarm and NO transition.
 */
import { join } from "node:path";

import {
  isStatusSectionError,
  statusContractVersion,
  STATUS_STREAM_CLIENT_CAP,
  STATUS_STREAM_COALESCE_MS,
  STATUS_STREAM_HEARTBEAT_MS,
  STATUS_STREAM_MAX_LIFETIME_MS,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

import type { FrontendConfig } from "./env.ts";

// ── the browser's contract ───────────────────────────────────────────────────

/** Bumped by a removal or a meaning change in `MonitorSnapshot`, never by an
 *  additive field. The page refuses to guess at a version it does not know. */
export const monitorContractVersion = 1;

export interface MonitorError {
  error: string;
}

export type MonitorSection<T> = T | MonitorError;

export type SolverReachability = "never-reached" | "reachable" | "unreachable";

export interface MonitorTransition {
  at: number;
  /** `solver` | `relay` | `ladder` | `kernel-sync`. */
  kind: string;
  from: string;
  to: string;
  detail: string;
}

export interface MonitorSolverView {
  /** `never-reached` is the "connection refused at boot" case — a status
   *  listener that is disabled or misconfigured, NOT a solver that went away.
   *  The page words the two differently (spec Edge Cases). */
  state: SolverReachability;
  reachable: boolean;
  /** When the current `state` began. */
  since: number;
  /** The last time a snapshot was received, or null if never. */
  lastSeenAt: number | null;
  /** How the last snapshot arrived. */
  transport: "stream" | "poll" | null;
  /** Successful `/status/stream` connections. A 5-minute lifetime rollover
   *  increments this; it is NOT an outage count — see `outages`. */
  streamConnects: number;
  /** Times the solver went from reachable to unreachable. */
  outages: number;
  /** Consecutive failures since the last successful read. */
  attempts: number;
  /** One line naming the last failure. Never carries the bearer. */
  lastError: string | null;
  /** `host:port` of the status listener, for the operator's own orientation. */
  host: string;
  /** The solver's `contractVersion`, or null before the first snapshot. A
   *  value other than `statusContractVersion` means this page is older or
   *  newer than the solver and says so rather than mis-rendering. */
  contractVersion: number | null;
  expectedContractVersion: number;
  /** The last snapshot received, kept across a solver restart (FR-010). */
  snapshot: StatusSnapshot | null;
}

export interface KernelLeg {
  token: string;
  amount: string;
  type: string;
}

export interface KernelOfferView {
  offerId: string;
  blockHeight: string | null;
  status: string;
  gives: KernelLeg[];
  wants: KernelLeg[];
  expiresAt: string | null;
  firstSeenAt: string | null;
  inputNullifierCount: number;
}

export interface KernelBookView {
  offers: KernelOfferView[];
  count: number;
  limit: number;
  /** Non-null means the kernel has more offers than one page; the page says so
   *  rather than silently showing a prefix. */
  nextCursor: string | null;
}

export interface KernelTokenView {
  color: string;
  name: string;
  kind: string | null;
  /** Base units per coin. 0 (or missing, on an older node) means base units
   *  ARE coins and no coin-denominated value is shown. */
  decimals: number;
}

export interface KernelPairView {
  pairKey: string;
  baseColor: string;
  quoteColor: string;
  tradeCount: number;
  lastPrice: number | null;
  lastTradedAt: string | null;
  openCount: number;
}

export interface KernelPriceView {
  color: string;
  name: string | null;
  decimals: number;
  assetId: string | null;
  /** USD per BASE UNIT, as a decimal string (the column is NUMERIC). */
  priceUsd: string;
  /** `feed` | `seed` | `manual` | `fallback`. `fallback` is NOT a market
   *  price and the page must label it (FR-013b). */
  source: string;
  updatedAt: string | null;
}

export interface KernelPricesView {
  tokens: KernelPriceView[];
  /** When the node has no `/v1/prices` route at all (preprod today), this is
   *  false and the page shows names only, silently. */
  supported: boolean;
}

export interface KernelSyncView {
  /** `ok` | `syncing` | `error`, verbatim from the kernel. */
  status: string;
  ts: number | null;
  ntp: Record<string, unknown> | null;
  midnight: Record<string, unknown> | null;
  celestia: Record<string, unknown> | null;
}

export interface MonitorKernelView {
  api: string;
  fetchedAt: number | null;
  latencyMs: number | null;
  sync: MonitorSection<KernelSyncView> | null;
  book: MonitorSection<KernelBookView> | null;
  knownTokens: MonitorSection<KernelTokenView[]> | null;
  pairs: MonitorSection<KernelPairView[]> | null;
  prices: MonitorSection<KernelPricesView> | null;
}

export interface MonitorRelayView {
  configured: boolean;
  url: string | null;
  fetchedAt: number | null;
  latencyMs: number | null;
  tokens: MonitorSection<string[]> | null;
}

export interface MonitorSelfView {
  startedAt: number;
  uptimeMs: number;
  pollMs: number;
  historyLimit: number;
  contractVersion: number;
  /** Console-observed counters the solver cannot report about itself. */
  withdrawals: number;
  lastWithdrawalAt: number | null;
  lastWithdrawalMs: number | null;
  relayOutages: number;
  feedClients: number;
  feedClientCap: number;
}

export interface MonitorSnapshot {
  /** THE server's clock. Every "N s ago" on the page is computed from this
   *  (FR-013), never from the browser's. */
  now: number;
  monitor: MonitorSelfView;
  solver: MonitorSolverView;
  kernel: MonitorKernelView;
  relay: MonitorRelayView;
  /** Newest first, capped at `monitor.historyLimit`. */
  history: MonitorTransition[];
}

// ── injection seams (tests hand in doubles; production uses the defaults) ────

export interface MonitorTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: MonitorTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MonitorDeps {
  fetch?: typeof fetch;
  nowMs?: () => number;
  timers?: MonitorTimers;
  log?: (message: string) => void;
  /** Directory the whitelisted static files are read from. */
  publicDir?: string;
}

// ── tuning that is not worth an environment variable ────────────────────────

/** Upstream request budget. A kernel that hangs must not stall the poll loop. */
const FETCH_TIMEOUT_MS = 8_000;
/** Hard ceiling on one solver stream, comfortably above the solver's own
 *  5-minute lifetime, so a wedged connection cannot live forever. */
const STREAM_HARD_TIMEOUT_MS = STATUS_STREAM_MAX_LIFETIME_MS + 30_000;
/** After a stream that DELIVERED frames, reconnect essentially at once — the
 *  solver's lifetime rollover must be invisible (Q-A-1). Not zero, so a
 *  pathological "200 with an empty body" cannot become a tight loop. */
const STREAM_RECONNECT_MS = 50;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** A single SSE frame larger than this is a broken peer, not a snapshot. */
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
/** The kernel caps `/v1/offers?limit=` at 100 itself. */
const BOOK_PAGE_LIMIT = 100;
/** `/v1/prices` refuses more than 50 colours. */
const PRICE_TOKEN_CAP = 50;
/** After a 404 on `/v1/prices`, wait this long before probing again — so an
 *  upgraded node is picked up without asking a node that lacks the route on
 *  every poll. */
const PRICES_REPROBE_MS = 300_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// ── the aggregator ──────────────────────────────────────────────────────────

export interface MonitorHandle {
  snapshot: () => MonitorSnapshot;
  subscribe: (listener: (snapshot: MonitorSnapshot) => void) => () => void;
  /** Starts the solver listener and the kernel/relay pollers. */
  start: () => void;
  stop: () => void;
  /** Test seam: run one kernel + relay poll and wait for it. */
  pollOnce: () => Promise<void>;
}

interface ObservedState {
  solver: string;
  relay: string;
  ladder: string;
  kernelSync: string;
}

export function createMonitor(config: FrontendConfig, deps: MonitorDeps = {}): MonitorHandle {
  const fetchImpl = deps.fetch ?? fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const log = (message: string): void => {
    try {
      deps.log?.(message);
    } catch {
      // Diagnostics never own this process's lifecycle.
    }
  };

  const startedAt = nowMs();
  const statusHost = new URL(config.solverStatusUrl).host;

  const solver: MonitorSolverView = {
    state: "never-reached",
    reachable: false,
    since: startedAt,
    lastSeenAt: null,
    transport: null,
    streamConnects: 0,
    outages: 0,
    attempts: 0,
    lastError: null,
    host: statusHost,
    contractVersion: null,
    expectedContractVersion: statusContractVersion,
    snapshot: null,
  };

  const kernel: MonitorKernelView = {
    api: config.zswapApi,
    fetchedAt: null,
    latencyMs: null,
    sync: null,
    book: null,
    knownTokens: null,
    pairs: null,
    prices: null,
  };

  const relay: MonitorRelayView = {
    configured: config.relayHttpUrl !== null,
    url: config.relayHttpUrl,
    fetchedAt: null,
    latencyMs: null,
    tokens: null,
  };

  const counters = {
    withdrawals: 0,
    lastWithdrawalAt: null as number | null,
    lastWithdrawalMs: null as number | null,
    relayOutages: 0,
  };

  const history: MonitorTransition[] = [];
  let observed: ObservedState = {
    solver: "unknown",
    relay: "unknown",
    ladder: "unknown",
    kernelSync: "unknown",
  };
  let withdrawalStartedAt: number | null = null;

  const listeners = new Set<(snapshot: MonitorSnapshot) => void>();
  let feedClients = 0;
  let stopped = false;
  const abort = new AbortController();

  const setFeedClients = (count: number): void => {
    feedClients = count;
  };

  const push = (kind: string, from: string, to: string, detail: string): void => {
    history.push({ at: nowMs(), kind, from, to, detail });
    // Newest kept: an operator debugging a five-minute-old incident needs the
    // recent transitions, and an unbounded array is the one way this process
    // could grow without limit.
    if (history.length > config.historyLimit) {
      history.splice(0, history.length - config.historyLimit);
    }
  };

  const changed = (): void => {
    recordTransitions();
    notify();
  };

  // ── snapshot assembly ─────────────────────────────────────────────────────

  const snapshot = (): MonitorSnapshot => {
    const now = nowMs();
    return {
      now,
      monitor: {
        startedAt,
        uptimeMs: now - startedAt,
        pollMs: config.pollMs,
        historyLimit: config.historyLimit,
        contractVersion: monitorContractVersion,
        withdrawals: counters.withdrawals,
        lastWithdrawalAt: counters.lastWithdrawalAt,
        lastWithdrawalMs: counters.lastWithdrawalMs,
        relayOutages: counters.relayOutages,
        feedClients,
        feedClientCap: STATUS_STREAM_CLIENT_CAP,
      },
      solver: { ...solver },
      kernel: { ...kernel },
      relay: { ...relay },
      // Newest first for the page; the array itself stays oldest-first so the
      // cap trims the oldest end in O(1).
      history: [...history].reverse(),
    };
  };

  // ── transitions (FR-010) ──────────────────────────────────────────────────

  /** What the solver's last snapshot says about the relay socket. */
  const observeRelay = (): string => {
    const status = solver.snapshot;
    if (status === null || !solver.reachable) return "unknown";
    const section = status.relay;
    if (isStatusSectionError(section)) return "error";
    if (section.state === "not-started") return "not-started";
    return section.stats?.connected === true ? "connected" : "disconnected";
  };

  /** What the last derived push says is on the wire. */
  const observeLadder = (): string => {
    const status = solver.snapshot;
    if (status === null || !solver.reachable) return "unknown";
    const section = status.ladder;
    if (isStatusSectionError(section)) return "error";
    if (section.state === "not-started") return "not-started";
    if (section.state === "never-derived" || section.last === null) return "never-derived";
    const withheld = section.last.withheld;
    if (withheld !== null) return withheld === "withdrawn" ? "withdrawn" : `withheld:${withheld}`;
    return section.last.pairs > 0 ? "quoting" : "empty";
  };

  const observeKernelSync = (): string => {
    const section = kernel.sync;
    if (section === null) return "unknown";
    if (isStatusSectionError(section)) return "unreachable";
    return section.status === "" ? "unknown" : section.status;
  };

  function recordTransitions(): void {
    const next: ObservedState = {
      solver: solver.state,
      relay: observeRelay(),
      ladder: observeLadder(),
      kernelSync: observeKernelSync(),
    };

    if (next.solver !== observed.solver) {
      push(
        "solver",
        observed.solver,
        next.solver,
        next.solver === "reachable"
          ? `status listener ${statusHost} answering over ${solver.transport ?? "http"}`
          : solver.lastError ?? "status listener not answering",
      );
    }
    if (next.relay !== observed.relay) {
      push("relay", observed.relay, next.relay, "solver relay socket state changed");
      if (observed.relay === "connected" && next.relay === "disconnected") {
        counters.relayOutages += 1;
      }
    }
    if (next.ladder !== observed.ladder) {
      push("ladder", observed.ladder, next.ladder, ladderDetail(next.ladder));
      const wasLive = observed.ladder === "quoting";
      const isLive = next.ladder === "quoting";
      const isWithdrawal =
        next.ladder === "withdrawn" || next.ladder.startsWith("withheld:") || next.ladder === "empty";
      if (isWithdrawal && !(observed.ladder === "withdrawn" || observed.ladder.startsWith("withheld:"))) {
        counters.withdrawals += 1;
        counters.lastWithdrawalAt = nowMs();
        withdrawalStartedAt = nowMs();
      }
      if (isLive && !wasLive && withdrawalStartedAt !== null) {
        counters.lastWithdrawalMs = nowMs() - withdrawalStartedAt;
        withdrawalStartedAt = null;
      }
    }
    if (next.kernelSync !== observed.kernelSync) {
      push("kernel-sync", observed.kernelSync, next.kernelSync, `kernel ${config.zswapApi}`);
    }
    observed = next;
  }

  const ladderDetail = (state: string): string => {
    if (state === "quoting") return "the solver is publishing real ladders";
    if (state === "withdrawn") return "the solver withdrew its quotes deliberately";
    if (state.startsWith("withheld:")) {
      return `fail-closed withdrawal: ${state.slice("withheld:".length)}`;
    }
    if (state === "empty") return "the last push carried no pair";
    if (state === "not-started") return "no relay client yet — dry-run, or the solver is still coming up";
    if (state === "never-derived") return "no push has been derived yet";
    return "unknown";
  };

  // ── change fan-out (same discipline as the solver's own listener) ──────────

  let notifyTimer: unknown = null;
  let lastNotifyAt = -Infinity;

  const emit = (): void => {
    lastNotifyAt = nowMs();
    if (listeners.size === 0) return;
    const frame = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch {
        // One broken subscriber must not cost the others their frame.
      }
    }
  };

  function notify(): void {
    if (stopped || notifyTimer !== null) return;
    const since = nowMs() - lastNotifyAt;
    if (since >= STATUS_STREAM_COALESCE_MS) {
      emit();
      return;
    }
    notifyTimer = timers.setTimeout(() => {
      notifyTimer = null;
      if (!stopped) emit();
    }, STATUS_STREAM_COALESCE_MS - since);
  }

  // ── solver side: SSE with reconnect, snapshot fallback, reachability ───────

  const authHeaders = (accept: string): Record<string, string> => ({
    authorization: `Bearer ${config.solverStatusToken}`,
    accept,
  });

  const markReachable = (transport: "stream" | "poll"): void => {
    const now = nowMs();
    solver.lastSeenAt = now;
    solver.transport = transport;
    solver.attempts = 0;
    solver.lastError = null;
    if (solver.state !== "reachable") {
      solver.state = "reachable";
      solver.reachable = true;
      solver.since = now;
    }
  };

  const markUnreachable = (error: unknown): void => {
    const now = nowMs();
    solver.attempts += 1;
    solver.lastError = asMessage(error);
    solver.transport = null;
    if (solver.state === "reachable") {
      // "Went away" — distinct from the boot-time refusal below, which keeps
      // `never-reached` so the page can say "status listener disabled?".
      solver.state = "unreachable";
      solver.reachable = false;
      solver.since = now;
      solver.outages += 1;
    } else if (solver.state === "never-reached") {
      solver.reachable = false;
    }
  };

  const applySolverSnapshot = (value: unknown, transport: "stream" | "poll"): boolean => {
    if (!isRecord(value) || typeof value["now"] !== "number") return false;
    const status = value as unknown as StatusSnapshot;
    solver.snapshot = status;
    solver.contractVersion = asNumber(value["contractVersion"], 0) || null;
    markReachable(transport);
    changed();
    return true;
  };

  /** One request with a budget, aborted when the process stops. */
  const withTimeout = async <T>(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    abort.signal.addEventListener("abort", onAbort, { once: true });
    const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      timers.clearTimeout(timer);
      abort.signal.removeEventListener("abort", onAbort);
    }
  };

  const pollSolverSnapshot = async (): Promise<void> => {
    const body = await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetchImpl(`${config.solverStatusUrl}/status/snapshot`, {
        headers: authHeaders("application/json"),
        signal,
      });
      if (!response.ok) throw new Error(describeUpstreamStatus(response.status));
      return await response.json();
    });
    if (!applySolverSnapshot(body, "poll")) {
      throw new Error("status snapshot was not a StatusSnapshot object");
    }
  };

  const describeUpstreamStatus = (status: number): string => {
    if (status === 401) {
      return "401 unauthorized — SOLVER_FRONTEND_SOLVER_STATUS_TOKEN does not match the " +
        "solver's SOLVER_STATUS_AUTH_TOKEN";
    }
    if (status === 503) return "503 — the solver's stream client cap is full";
    return `HTTP ${status}`;
  };

  /**
   * Consume one `/status/stream` connection to its end.
   *
   * Returns how many frames it delivered, which is the whole difference
   * between a healthy 5-minute lifetime rollover (many frames → reconnect at
   * once, silently) and a peer that accepts the connection and says nothing
   * (zero frames → back off like any other failure).
   */
  const consumeSolverStream = async (): Promise<number> => {
    return await withTimeout(STREAM_HARD_TIMEOUT_MS, async (signal) => {
      const response = await fetchImpl(`${config.solverStatusUrl}/status/stream`, {
        headers: authHeaders("text/event-stream"),
        signal,
      });
      if (!response.ok) throw new Error(describeUpstreamStatus(response.status));
      const body = response.body;
      if (body === null) throw new Error("status stream carried no body");
      solver.streamConnects += 1;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let frames = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return frames;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_SSE_BUFFER_BYTES) {
            throw new Error("status stream frame exceeded the 8 MB ceiling");
          }
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = raw
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n");
            if (data !== "") {
              try {
                if (applySolverSnapshot(JSON.parse(data), "stream")) frames += 1;
              } catch {
                // A malformed frame is not a reason to drop a working stream.
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The connection is going away either way.
        }
      }
    });
  };

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      const timer = timers.setTimeout(() => {
        abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      function onAbort(): void {
        timers.clearTimeout(timer);
        resolve();
      }
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });

  const solverLoop = async (): Promise<void> => {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      let frames = -1;
      try {
        frames = await consumeSolverStream();
      } catch (error) {
        if (stopped) return;
        markUnreachable(error);
        changed();
      }
      if (stopped) return;

      if (frames > 0) {
        // The solver closed a healthy stream — its 5-minute lifetime, or a
        // graceful stop. Reconnect at once and raise nothing (Q-A-1).
        backoff = BACKOFF_MIN_MS;
        await delay(STREAM_RECONNECT_MS);
        continue;
      }

      // No stream. Fall back to a single snapshot poll (FR-009): the stream can
      // be refused (client cap) while the snapshot route answers perfectly.
      try {
        await pollSolverSnapshot();
        backoff = BACKOFF_MIN_MS;
      } catch (error) {
        if (stopped) return;
        markUnreachable(error);
        changed();
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
      await delay(backoff);
    }
  };

  // ── kernel side ───────────────────────────────────────────────────────────

  const fetchJson = async (url: string): Promise<unknown> =>
    await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return await response.json();
    });

  const section = async <T>(
    load: () => Promise<T>,
  ): Promise<MonitorSection<T>> => {
    try {
      return await load();
    } catch (error) {
      // FR-005's discipline applied to the kernel: a failing route costs the
      // page that panel, never the whole snapshot.
      return { error: asMessage(error) };
    }
  };

  const mapSync = (value: unknown): KernelSyncView => {
    const row = isRecord(value) ? value : {};
    const part = (name: string): Record<string, unknown> | null =>
      isRecord(row[name]) ? (row[name] as Record<string, unknown>) : null;
    return {
      status: asString(row["status"]) ?? "unknown",
      ts: typeof row["ts"] === "number" ? row["ts"] : null,
      ntp: part("ntp"),
      midnight: part("midnight"),
      celestia: part("celestia"),
    };
  };

  const mapOffers = (value: unknown): KernelBookView => {
    const rows = isRecord(value) && Array.isArray(value["offers"]) ? value["offers"] : [];
    const offers: KernelOfferView[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const computed = isRecord(row["computed"]) ? row["computed"] : {};
      const legs = (side: unknown): KernelLeg[] =>
        (Array.isArray(side) ? side : [])
          .filter(isRecord)
          .map((leg) => ({
            token: asString(leg["token"]) ?? "",
            amount: String(leg["amount"] ?? "0"),
            type: asString(leg["type"]) ?? "UNKNOWN",
          }));
      const nullifiers = computed["inputNullifiers"];
      offers.push({
        offerId: asString(row["offerId"]) ?? "",
        blockHeight: row["blockHeight"] === undefined ? null : String(row["blockHeight"]),
        status: asString(computed["status"]) ?? "unknown",
        gives: legs(computed["gives"]),
        wants: legs(computed["wants"]),
        expiresAt: asString(computed["expiresAt"]),
        firstSeenAt: asString(computed["firstSeenAt"]),
        inputNullifierCount: Array.isArray(nullifiers) ? nullifiers.length : 0,
      });
    }
    return {
      offers,
      count: offers.length,
      limit: BOOK_PAGE_LIMIT,
      nextCursor: isRecord(value) ? asString(value["nextCursor"]) : null,
    };
  };

  const mapTokens = (value: unknown): KernelTokenView[] =>
    (Array.isArray(value) ? value : [])
      .filter(isRecord)
      .map((row) => ({
        color: (asString(row["token_color"]) ?? "").toLowerCase(),
        name: asString(row["name"]) ?? "",
        kind: asString(row["kind"]),
        // Older nodes (preprod today) have no `decimals` column at all; 0 means
        // "base units are coins", which is exactly the safe reading.
        decimals: Math.max(0, Math.trunc(asNumber(row["decimals"], 0))),
      }))
      .filter((row) => row.color !== "");

  const mapPairs = (value: unknown): KernelPairView[] =>
    (Array.isArray(value) ? value : [])
      .filter(isRecord)
      .map((row) => ({
        pairKey: asString(row["pair_key"]) ?? "",
        baseColor: (asString(row["base_color"]) ?? "").toLowerCase(),
        quoteColor: (asString(row["quote_color"]) ?? "").toLowerCase(),
        tradeCount: asNumber(row["trade_count"], 0),
        lastPrice: typeof row["last_price"] === "number" ? row["last_price"] : null,
        lastTradedAt: asString(row["last_traded_at"]),
        openCount: asNumber(row["open_count"], 0),
      }));

  const mapPrices = (value: unknown): KernelPricesView => ({
    supported: true,
    tokens: (isRecord(value) && Array.isArray(value["tokens"]) ? value["tokens"] : [])
      .filter(isRecord)
      .map((row) => ({
        color: (asString(row["token_color"]) ?? "").toLowerCase(),
        name: asString(row["name"]),
        decimals: Math.max(0, Math.trunc(asNumber(row["decimals"], 0))),
        assetId: asString(row["asset_id"]),
        priceUsd: String(row["price_usd"] ?? ""),
        source: asString(row["source"]) ?? "unknown",
        updatedAt: asString(row["updated_at"]),
      })),
  });

  /**
   * Colours worth a price: what the ladder advertises, what the solver holds,
   * and what the kernel book shows — bounded by the route's own 50-entry cap.
   * A browser cannot influence this list, which is why asking the kernel for it
   * is not "proxying" (FR-011).
   */
  const pricedColours = (): string[] => {
    const colours = new Set<string>();
    const add = (value: string | undefined | null): void => {
      if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value.toLowerCase())) {
        colours.add(value.toLowerCase());
      }
    };
    const status = solver.snapshot;
    if (status !== null) {
      if (!isStatusSectionError(status.ladder) && status.ladder.last !== null) {
        for (const token of status.ladder.last.tokenIds) add(token);
      }
      if (!isStatusSectionError(status.inventory)) {
        for (const row of status.inventory.tokens) add(row.token);
      }
    }
    const book = kernel.book;
    if (book !== null && !isStatusSectionError(book)) {
      for (const offer of book.offers) {
        for (const leg of [...offer.gives, ...offer.wants]) add(leg.token);
      }
    }
    return [...colours].slice(0, PRICE_TOKEN_CAP);
  };

  let pricesUnsupportedUntil = 0;

  const pollPrices = async (): Promise<MonitorSection<KernelPricesView> | null> => {
    if (nowMs() < pricesUnsupportedUntil) return { supported: false, tokens: [] };
    const colours = pricedColours();
    if (colours.length === 0) return null;
    try {
      const value = await fetchJson(
        `${config.zswapApi}/v1/prices?tokens=${encodeURIComponent(colours.join(","))}`,
      );
      return mapPrices(value);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) {
        // Preprod today has no such route. Degrade SILENTLY to names only
        // (FR-013b) and re-probe occasionally so an upgrade is picked up.
        pricesUnsupportedUntil = nowMs() + PRICES_REPROBE_MS;
        return { supported: false, tokens: [] };
      }
      return { error: asMessage(error) };
    }
  };

  const pollKernel = async (): Promise<void> => {
    const startedFetchAt = nowMs();
    const [sync, book, tokens, pairs] = await Promise.all([
      section(async () => mapSync(await fetchJson(`${config.zswapApi}/v1/health/sync`))),
      section(async () => mapOffers(await fetchJson(`${config.zswapApi}/v1/offers?limit=${BOOK_PAGE_LIMIT}`))),
      section(async () => mapTokens(await fetchJson(`${config.zswapApi}/v1/known-tokens`))),
      section(async () => mapPairs(await fetchJson(`${config.zswapApi}/v1/pairs`))),
    ]);
    if (stopped) return;
    const fetchedAt = nowMs();
    kernel.sync = sync;
    kernel.book = book;
    kernel.knownTokens = tokens;
    kernel.pairs = pairs;
    kernel.fetchedAt = fetchedAt;
    kernel.latencyMs = fetchedAt - startedFetchAt;
    // Prices depend on the colours the book just produced, so they are asked
    // for after it, never in the same batch.
    kernel.prices = await pollPrices();
    if (stopped) return;
    changed();
  };

  const pollRelay = async (): Promise<void> => {
    const relayBase = config.relayHttpUrl;
    if (relayBase === null) return;
    const startedFetchAt = nowMs();
    const tokens = await section(async () => {
      const value = await fetchJson(`${relayBase}/tokens`);
      const list = isRecord(value) && Array.isArray(value["tokens"]) ? value["tokens"] : [];
      return list.filter((token): token is string => typeof token === "string");
    });
    if (stopped) return;
    const fetchedAt = nowMs();
    relay.tokens = tokens;
    relay.fetchedAt = fetchedAt;
    relay.latencyMs = fetchedAt - startedFetchAt;
    changed();
  };

  const pollOnce = async (): Promise<void> => {
    await Promise.all([
      pollKernel().catch((error) => log(`[solver-frontend] kernel poll failed: ${asMessage(error)}`)),
      pollRelay().catch((error) => log(`[solver-frontend] relay poll failed: ${asMessage(error)}`)),
    ]);
  };

  let pollTimer: unknown = null;
  const schedulePoll = (): void => {
    if (stopped) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void pollOnce().finally(schedulePoll);
    }, config.pollMs);
  };

  return {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      setFeedClients(listeners.size);
      return () => {
        listeners.delete(listener);
        setFeedClients(listeners.size);
      };
    },
    start: () => {
      if (stopped) return;
      void solverLoop();
      void pollOnce().finally(schedulePoll);
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      abort.abort();
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      pollTimer = null;
      if (notifyTimer !== null) timers.clearTimeout(notifyTimer);
      notifyTimer = null;
      listeners.clear();
      setFeedClients(0);
    },
    pollOnce,
  };
}

// ── the HTTP surface (FR-011) ───────────────────────────────────────────────

/**
 * The ONLY files this server will ever read, by basename, with the content type
 * it will claim. A compiled manifest rather than a regexp over the directory:
 * a traversal attempt, an encoded traversal attempt, a dotfile and a stray
 * editor backup all fall through to 404 without a filesystem call.
 */
const STATIC_FILES: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "derive.js": "text/javascript; charset=utf-8",
  "help.js": "text/javascript; charset=utf-8",
};

export interface FrontendServerHandle {
  readonly host: string;
  /** The port actually bound; meaningful when `port: 0` was requested. */
  readonly port: number;
  readonly monitor: MonitorHandle;
  stop: () => void;
}

interface FeedClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  openedAt: number;
}

interface ServerLike {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
  unref?: () => void;
}

const encoder = new TextEncoder();

export function startFrontendServer(
  config: FrontendConfig,
  deps: MonitorDeps = {},
): FrontendServerHandle {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const publicDir = deps.publicDir ?? join(import.meta.dir, "public");
  const log = (message: string): void => {
    try {
      deps.log?.(message);
    } catch {
      /* diagnostics never own the lifecycle */
    }
  };

  const monitor = createMonitor(config, deps);
  const clients = new Set<FeedClient>();
  let lastBroadcastAt = nowMs();
  let heartbeatTimer: unknown = null;
  let stopped = false;

  const frameFor = (snapshot: MonitorSnapshot): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);

  const drop = (client: FeedClient): void => {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    try {
      client.controller.close();
    } catch {
      // Already closed or errored — the state we were asking for.
    }
  };

  const sendTo = (client: FeedClient, frame: Uint8Array): void => {
    if (client.closed) return;
    try {
      const desired = client.controller.desiredSize;
      // Drop rather than await: a slow browser must never apply backpressure
      // to the aggregator's own polling loop (the solver listener's rule).
      if (desired !== null && desired <= 0) return;
      client.controller.enqueue(frame);
    } catch {
      drop(client);
    }
  };

  const broadcast = (snapshot: MonitorSnapshot): void => {
    lastBroadcastAt = nowMs();
    if (clients.size === 0) return;
    const frame = frameFor(snapshot);
    for (const client of [...clients]) sendTo(client, frame);
  };

  const unsubscribe = monitor.subscribe(broadcast);

  /** The solver's own reasoning, one hop down: Bun never reports an SSE
   *  disconnect, so age is the only thing that reclaims a slot (Q-A-1). */
  const reapExpired = (now: number): void => {
    for (const client of [...clients]) {
      if (now - client.openedAt >= STATUS_STREAM_MAX_LIFETIME_MS) drop(client);
    }
  };

  const scheduleHeartbeat = (): void => {
    if (stopped) return;
    const since = nowMs() - lastBroadcastAt;
    const delay = Math.min(
      STATUS_STREAM_HEARTBEAT_MS,
      Math.max(1, STATUS_STREAM_HEARTBEAT_MS - since),
    );
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null;
      if (stopped) return;
      reapExpired(nowMs());
      if (nowMs() - lastBroadcastAt >= STATUS_STREAM_HEARTBEAT_MS) {
        if (clients.size > 0) {
          try {
            broadcast(monitor.snapshot());
          } catch {
            // A failed heartbeat must not stop the next one.
          }
        } else {
          lastBroadcastAt = nowMs();
        }
      }
      scheduleHeartbeat();
    }, delay);
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  const notFound = (): Response =>
    new Response(null, { status: 404, headers: { "cache-control": "no-store" } });

  const openFeed = (request: Request): Response => {
    const openedAt = nowMs();
    reapExpired(openedAt);
    if (clients.size >= STATUS_STREAM_CLIENT_CAP) {
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    }
    let client: FeedClient | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const opened: FeedClient = { controller, closed: false, openedAt };
        client = opened;
        clients.add(opened);
        try {
          if (request.signal.aborted) drop(opened);
          else request.signal.addEventListener("abort", () => drop(opened), { once: true });
        } catch {
          // A runtime without a request signal falls back to the reaper.
        }
        try {
          controller.enqueue(frameFor(monitor.snapshot()));
        } catch {
          drop(opened);
        }
      },
      cancel() {
        if (client !== null) drop(client);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        // Reverse proxies buffer by default and would hold every frame.
        "x-accel-buffering": "no",
      },
    });
  };

  const serveStatic = async (name: string): Promise<Response> => {
    const contentType = STATIC_FILES[name];
    // Belt AND braces: the manifest lookup already excludes traversal, and the
    // shape test keeps a future manifest edit from introducing one.
    if (contentType === undefined || !/^[a-zA-Z0-9._-]+$/.test(name)) return notFound();
    const file = Bun.file(join(publicDir, name));
    if (!(await file.exists())) return notFound();
    return new Response(file, {
      headers: { "content-type": contentType, "cache-control": "no-cache" },
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const readMethod = method === "GET" || method === "HEAD";
    const path = url.pathname;

    const known =
      path === "/" || path === "/health" || path === "/api/snapshot" || path === "/api/stream" ||
      Object.prototype.hasOwnProperty.call(STATIC_FILES, path.slice(1));
    if (known && !readMethod) {
      // The site is strictly read-only: there is no method on any route that
      // changes anything, here or upstream.
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (path === "/health") {
      const view = monitor.snapshot();
      return json({
        status: "ok",
        uptimeMs: view.monitor.uptimeMs,
        solver: { state: view.solver.state, lastSeenAt: view.solver.lastSeenAt },
      });
    }
    if (path === "/api/snapshot") return json(monitor.snapshot());
    if (path === "/api/stream") {
      if (method === "HEAD") {
        return new Response(null, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      return openFeed(request);
    }
    if (path === "/") return await serveStatic("index.html");
    return await serveStatic(path.slice(1));
  };

  const server = (Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handle(request);
      } catch (error) {
        log(`[solver-frontend] request failed: ${asMessage(error)}`);
        return new Response(null, { status: 500, headers: { "cache-control": "no-store" } });
      }
    },
  }) as unknown) as ServerLike;

  scheduleHeartbeat();
  monitor.start();

  return {
    host: config.host,
    port: server.port,
    monitor,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      unsubscribe();
      for (const client of [...clients]) drop(client);
      monitor.stop();
      try {
        // `true`: an SSE body never ends on its own, so a graceful stop that
        // waited for active connections would wait for every open browser tab.
        server.stop(true);
      } catch (error) {
        log(`[solver-frontend] listener stop failed: ${asMessage(error)}`);
      }
    },
  };
}
