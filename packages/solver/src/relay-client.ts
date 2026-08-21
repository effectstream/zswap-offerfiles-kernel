// The COW solver's Midnight Intents relay client (spec R2, FR-012).
//
// The relay is consumed as-is. The solver is an OUTBOUND WebSocket client of
// it: it connects with the shared Bearer, registers `solver-capabilities`,
// pushes `price-levels` once per second, re-pushes BOTH on every reconnect
// (the relay drops all per-solver state with the socket — proven at the real
// relay by the N0 gate), and withdraws explicitly before a graceful stop.
//
// Three boundaries this module keeps, deliberately:
//
//   1. **It consumes the book cache; it never drives it.** FR-005/FR-012 make
//      the mirror and the relay client independent processes: nothing here
//      reaches into `book-sync.ts`, nothing here can make the mirror
//      resnapshot, reconnect, or fail, and a relay outage changes nothing
//      about the cache. The only coupling is a read of `LadderCache`.
//   2. **It answers no quotes.** There is no per-quote solver contact in this
//      protocol: the relay interpolates `POST /quote` locally from the pushed
//      ladder. What this client publishes IS the quote.
//   3. **It executes no jobs itself.** `runSolver` wires N5's executor through
//      the handlers below. Without a handler, an arriving job is answered with
//      a fail-closed `job-error` — never dropped, because the relay is holding
//      a taker's job open waiting for a terminal answer.
//
// The four push-side halves N3 recorded are implemented here:
//
//   R-07  pushes are serialized and coalesced. One push is ever in flight; a
//         tick that arrives during one does not queue a second copy of the
//         ladder it was derived from — it coalesces to ONE follow-up push,
//         derived fresh when the barrier clears. Frames from two derivations
//         can never interleave on the socket.
//   R-34  every push is a complete, self-contained replacement (N3's property)
//         and `onopen` re-pushes capabilities AND levels before anything else.
//   R-37  every diagnostic consumer is invoked inside a catch. A throwing
//         observer cannot reject a push, cannot reject `stop()`, and cannot
//         produce an unhandled rejection; the loop keeps running.
//   R-41  `withdraw()` sends the explicit validated empty pair on a socket
//         that is still open, bounded by a deadline, and `stop()` performs it
//         before closing. Disconnecting also withdraws at the relay, but only
//         the explicit frame withdraws while the process is still connected.
//
// Fail-closed: when the cache is not current, `deriveLadderPush` returns the
// explicit EMPTY capabilities+levels pair, and this loop SENDS it. Silence
// would be the unsafe choice — the relay has no version or tombstone concept,
// so a withheld push leaves the previous ladder quoting.

import {
  buildSolverCapabilitiesFrame,
  withdrawalPriceLevelsFrame,
  type LadderExclusion,
} from "@zswap-da/solver-core/ladder-derivation";
import {
  parseJobError,
  parseSubmitFailed,
  parseSwap,
  parseSwapTx,
  parseTxSubmitted,
  type RelayToSolverMessage,
  type SolverToRelayMessage,
} from "@zswap-da/solver-core/relay-ws-contract";

import { deriveLadderPush, type LadderCache, type LadderPush } from "./ladder-source.ts";

/** WHATWG `WebSocket.readyState` OPEN. Declared rather than imported so this
 *  module needs no DOM lib and can be driven by an explicit test double. */
export const RELAY_WS_OPEN = 1;

/** Default cadences. The relay contract fixes the first two (FR-012). */
export const DEFAULT_PUSH_INTERVAL_MS = 1_000;
export const DEFAULT_RECONNECT_DELAY_MS = 2_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Bound on the graceful withdrawal. A relay that will not take the frame must
 *  not be able to hold shutdown open; the disconnect withdraws us anyway. */
export const DEFAULT_WITHDRAW_TIMEOUT_MS = 2_000;
/** A peer must not be able to grow the solver heap with one enormous frame. */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

/**
 * Terminal `job-error` reason used when a caller starts this reusable client
 * without wiring the production N5 executor.
 *
 * Deliberately NOT one of the relay's capacity refusals
 * (`solver_at_capacity` / `solver_saturated`): those tell a caller to retry
 * the same proved transaction after a backoff, which would be a lie here. The
 * relay copies the reason verbatim into job state, so it must read as what it
 * is — this solver cannot execute the job at all.
 */
export const JOB_EXECUTION_UNAVAILABLE = "solver_job_execution_unavailable";

/** The slice of the WebSocket surface this client uses, declared structurally
 *  (the `openOfferUpdatesStream` idiom) so tests can drive it exactly.
 *
 *  `send` may return a promise: any transport that reports completion (or
 *  backpressure) keeps the R-07 serialization real rather than nominal. The
 *  production WHATWG socket returns void, which simply resolves at once. */
export interface RelayWebSocketLike {
  readyState: number;
  onopen: ((event?: any) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: any) => void) | null;
  onclose: ((event?: any) => void) | null;
  send(data: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
}

export type CreateRelayWebSocket = (url: string, authToken: string) => RelayWebSocketLike;

/** Timer seam, so reconnect delay and push cadence are testable without the
 *  wall clock. Production uses globals and unrefs, matching the reference
 *  solver: price pushes must not keep the process alive on their own. */
export interface RelayClientTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: RelayClientTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Production socket factory.
 *
 * The relay authenticates at the UPGRADE with `Authorization: Bearer <token>`
 * and answers 401 otherwise — there is no in-band handshake to fall back on,
 * so the header has to be on the request itself. Bun's `WebSocket` accepts the
 * options bag; the cast is the same one the N0 fixture harness uses.
 */
export const createRelayWebSocket: CreateRelayWebSocket = (url, authToken) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  } as unknown as string[]) as unknown as RelayWebSocketLike;

export type RelayClientEventKind =
  | "connecting"
  | "connected"
  | "disconnected"
  | "connect-timeout"
  | "socket-error"
  | "push"
  | "push-failed"
  | "cache-not-current"
  | "cache-current"
  | "ladder-truncated"
  | "ladder-truncation-cleared"
  | "job-refused"
  | "message-refused"
  | "withdrawn"
  | "withdraw-failed"
  | "stopped";

/**
 * A diagnostic, as DATA.
 *
 * The derivation returns its diagnostics as data and calls no observer (N3's
 * half of R-37); this loop keeps that shape and adds the containment the
 * deleted publisher lacked — every consumer call below sits inside a catch.
 */
export interface RelayClientEvent {
  kind: RelayClientEventKind;
  severity: "info" | "warn" | "error";
  message: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface RelayLadderOptions {
  /** Same margin the engine/executor enforce at dequeue (R-38). */
  expiryMarginSeconds: number;
  /** Advertised capacity. N5 is what actually enforces it (FR-019). */
  maxParallelSwaps?: number;
  maxPairs?: number;
  maxRungsPerPair?: number;
  /** Read per push, so an in-flight claim taken between two pushes is honoured
   *  by the next one. A function, not a snapshot, precisely because the loop
   *  outlives any single view of executor state. */
  unavailableOfferHashes?: () => Iterable<string>;
}

type RelaySwapTerminalMessage = Extract<
  SolverToRelayMessage,
  { type: "swap-tx" | "job-error" }
>;

export interface RelayClientOptions {
  /** `ws://` / `wss://` endpoint of the relay's solver socket. */
  url: string;
  /** Shared Bearer. The relay refuses anything shorter than 32 characters. */
  authToken: string;
  /** Consumed, never driven: the mirror owns this and knows nothing of us. */
  cache: LadderCache;
  ladder: RelayLadderOptions;
  pushIntervalMs?: number;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  withdrawTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Injected clock: same cache + same `nowMs` ⇒ same bytes. */
  nowMs?: () => number;
  createWebSocket?: CreateRelayWebSocket;
  timers?: RelayClientTimers;
  /** Untrusted diagnostic consumer. Contained (R-37). */
  onEvent?: (event: RelayClientEvent) => void;
  /** Untrusted string logger, the `runSolver` idiom. Contained (R-37). */
  log?: (message: string) => void;
  /** N5's seam. Without it, every routed job is answered `job-error`. */
  onSwap?: (
    job: Extract<RelayToSolverMessage, { type: "swap" }>,
  ) => RelaySwapTerminalMessage | Promise<RelaySwapTerminalMessage>;
  onTxSubmitted?: (
    message: Extract<RelayToSolverMessage, { type: "tx-submitted" }>,
  ) => void | Promise<void>;
  onSubmitFailed?: (
    message: Extract<RelayToSolverMessage, { type: "submit-failed" }>,
  ) => void | Promise<void>;
}

export interface RelayClientStats {
  connected: boolean;
  /** Successful (re)connections, so a reconnect is countable. */
  connections: number;
  /** Completed pushes, whatever they carried. */
  pushes: number;
  /** Ticks that coalesced into an already-running push rather than starting
   *  one of their own — R-07's observable. */
  coalesced: number;
  pushFailures: number;
  withdrawn: boolean;
  stopped: boolean;
}

export interface RelayClientHandle {
  /** Derive and send one push now, coalescing with any push in flight.
   *  Resolves when the resulting push (and any push it coalesced into) is
   *  done. Never rejects: a transport or observer failure is reported. */
  push: () => Promise<void>;
  /**
   * R-41: send the explicit validated empty capabilities+levels pair on the
   * still-open socket, bounded by `withdrawTimeoutMs`, and stop pushing.
   *
   * Separate from `stop()` on purpose: it makes the withdrawal observable at
   * the relay INDEPENDENTLY of the disconnect, which is the only way to prove
   * the frame did the work rather than the socket closing. Terminal — the
   * loop does not resume afterwards.
   */
  withdraw: () => Promise<void>;
  /** Withdraw (bounded, best-effort) and then close. Idempotent; never
   *  rejects. */
  stop: () => Promise<void>;
  stats: () => RelayClientStats;
}

const isOpen = (socket: RelayWebSocketLike | null): socket is RelayWebSocketLike =>
  socket !== null && socket.readyState === RELAY_WS_OPEN;

/** Caps that dropped real liquidity, as counts — Q-N3-1 option D's input. */
interface TruncationSignal {
  pairCapOffers: number;
  rungCapOffers: number;
}

const truncationOf = (excluded: readonly LadderExclusion[]): TruncationSignal => {
  let pairCapOffers = 0;
  let rungCapOffers = 0;
  for (const exclusion of excluded) {
    if (exclusion.reason === "pair-cap") pairCapOffers += 1;
    else if (exclusion.reason === "rung-cap") rungCapOffers += 1;
  }
  return { pairCapOffers, rungCapOffers };
};

const truncates = (signal: TruncationSignal): boolean =>
  signal.pairCapOffers > 0 || signal.rungCapOffers > 0;

const sameTruncation = (a: TruncationSignal, b: TruncationSignal): boolean =>
  a.pairCapOffers === b.pairCapOffers && a.rungCapOffers === b.rungCapOffers;

const rungCount = (push: LadderPush): number =>
  push.priceLevels.levels.reduce((total, pair) => total + pair.levels.length, 0);

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`relay client ${name} must be a positive safe integer, got ${value}`);
  }
}

/**
 * Start the relay client. It connects immediately and reconnects on its own
 * until `stop()`.
 *
 * Independent of the mirror by construction: the only thing shared is the
 * cache it reads. It never awaits, cancels, or restarts anything the mirror
 * owns, and a permanently unreachable relay changes nothing about the cache.
 */
export function startRelayClient(options: RelayClientOptions): RelayClientHandle {
  const pushIntervalMs = options.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const withdrawTimeoutMs = options.withdrawTimeoutMs ?? DEFAULT_WITHDRAW_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  requirePositiveInteger("pushIntervalMs", pushIntervalMs);
  requirePositiveInteger("reconnectDelayMs", reconnectDelayMs);
  requirePositiveInteger("connectTimeoutMs", connectTimeoutMs);
  requirePositiveInteger("withdrawTimeoutMs", withdrawTimeoutMs);
  requirePositiveInteger("maxFrameBytes", maxFrameBytes);
  if (options.url === "") throw new RangeError("relay client url must not be empty");
  if (options.authToken === "") throw new RangeError("relay client authToken must not be empty");

  const timers = options.timers ?? DEFAULT_TIMERS;
  const createSocket = options.createWebSocket ?? createRelayWebSocket;
  const now = options.nowMs ?? (() => Date.now());

  let socket: RelayWebSocketLike | null = null;
  let reconnectTimer: unknown = null;
  let pushTimer: unknown = null;
  let connectTimer: unknown = null;
  /** Set by `withdraw()`/`stop()`: no more pushes, no more reconnects. */
  let retired = false;
  let withdrawing: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let lastTruncation: TruncationSignal = { pairCapOffers: 0, rungCapOffers: 0 };
  let lastCurrent: boolean | null = null;

  const stats: RelayClientStats = {
    connected: false,
    connections: 0,
    pushes: 0,
    coalesced: 0,
    pushFailures: 0,
    withdrawn: false,
    stopped: false,
  };

  /** Every diagnostic goes through here. Both consumers are untrusted and a
   *  throw from either is swallowed: R-37 is exactly the property that a
   *  logging failure cannot become a push or shutdown failure. */
  const emit = (
    kind: RelayClientEventKind,
    severity: RelayClientEvent["severity"],
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    const event: RelayClientEvent = detail === undefined
      ? { kind, severity, message }
      : { kind, severity, message, detail: Object.freeze({ ...detail }) };
    try {
      options.onEvent?.(event);
    } catch {
      // A diagnostic consumer never participates in transport authority.
    }
    try {
      options.log?.(`[relay] ${message}`);
    } catch {
      // Same, for the string-logger idiom.
    }
  };

  const clearTimer = (handle: unknown): null => {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  };

  const send = async (frame: SolverToRelayMessage): Promise<void> => {
    const target = socket;
    if (!isOpen(target)) throw new Error(`relay socket is not open for ${frame.type}`);
    await target.send(JSON.stringify(frame));
  };

  /** A job response belongs to the socket that delivered that job. Sending a
   * late proof on a replacement socket after a mid-job drop could attach it to
   * a relay generation that never owned the intent. The wallet-side executor
   * retains the proved half and its TTL sweeper reverts it instead. */
  const sendOn = async (
    expectedSocket: RelayWebSocketLike,
    frame: SolverToRelayMessage,
  ): Promise<void> => {
    if (socket !== expectedSocket || !isOpen(expectedSocket)) {
      throw new Error(`relay socket generation changed before ${frame.type}`);
    }
    await expectedSocket.send(JSON.stringify(frame));
  };

  /** One complete push: derive fresh, then send the pair in a fixed order.
   *  Capabilities first, so a relay that has just forgotten us knows our
   *  tokens before the ladder that prices them arrives. */
  const runPush = async (cause: string): Promise<void> => {
    if (retired || !isOpen(socket)) return;
    let push: LadderPush;
    try {
      push = deriveLadderPush(options.cache, {
        nowMs: now(),
        expiryMarginSeconds: options.ladder.expiryMarginSeconds,
        ...(options.ladder.maxParallelSwaps === undefined
          ? {}
          : { maxParallelSwaps: options.ladder.maxParallelSwaps }),
        ...(options.ladder.maxPairs === undefined ? {} : { maxPairs: options.ladder.maxPairs }),
        ...(options.ladder.maxRungsPerPair === undefined
          ? {}
          : { maxRungsPerPair: options.ladder.maxRungsPerPair }),
        ...(options.ladder.unavailableOfferHashes === undefined
          ? {}
          : { unavailableOfferHashes: options.ladder.unavailableOfferHashes() }),
      });
    } catch (error) {
      // A frame the builders refuse is NEVER sent: the relay discards a bad
      // frame silently and would keep quoting the previous ladder.
      stats.pushFailures += 1;
      emit("push-failed", "error", `could not derive a ladder to push: ${String(error)}`, {
        cause,
      });
      return;
    }

    reportCurrentness(push);
    reportTruncation(push.derived.excluded);

    try {
      await send(push.capabilities);
      await send(push.priceLevels);
    } catch (error) {
      stats.pushFailures += 1;
      emit("push-failed", "warn", `push failed on the wire: ${String(error)}`, { cause });
      return;
    }

    stats.pushes += 1;
    emit("push", "info", `pushed ${push.priceLevels.levels.length} pair(s)`, {
      cause,
      pairs: push.priceLevels.levels.length,
      rungs: rungCount(push),
      tokenIds: push.capabilities.tokenIds.length,
      withheld: push.withheld,
    });
  };

  /** FR-005's downstream half, made observable. The withheld push is not
   *  silence — the empty pair above IS the withdrawal, and it goes out. */
  const reportCurrentness = (push: LadderPush): void => {
    const current = push.withheld === null;
    if (lastCurrent === current) return;
    lastCurrent = current;
    if (current) {
      emit("cache-current", "info", "book cache is current again; publishing real ladders");
    } else {
      emit(
        "cache-not-current",
        "error",
        "book cache is not current: publishing the EMPTY capabilities+levels pair",
      );
    }
  };

  /**
   * Q-N3-1 option D: a cap that trims real liquidity is a LOUD operational
   * signal, not a silent trim.
   *
   * Emitted at error severity with counts, on every CHANGE of the signal
   * rather than on every push — the loop runs once a second and an
   * unconditional error per second is noise an operator learns to ignore,
   * which is the failure mode this signal exists to prevent. Recovery is
   * reported too, so a cleared truncation is not left looking permanent.
   */
  const reportTruncation = (excluded: readonly LadderExclusion[]): void => {
    const signal = truncationOf(excluded);
    if (sameTruncation(signal, lastTruncation)) return;
    const wasTruncating = truncates(lastTruncation);
    lastTruncation = signal;
    if (truncates(signal)) {
      emit(
        "ladder-truncated",
        "error",
        `publication caps dropped real liquidity: ${signal.pairCapOffers} offer(s) past ` +
          `maxPairs, ${signal.rungCapOffers} past maxRungsPerPair`,
        { pairCapOffers: signal.pairCapOffers, rungCapOffers: signal.rungCapOffers },
      );
    } else if (wasTruncating) {
      emit(
        "ladder-truncation-cleared",
        "info",
        "publication caps no longer drop any offer",
      );
    }
  };

  /**
   * R-07: one push in flight, and at most ONE follow-up queued behind it.
   *
   * A tick arriving during a push does not enqueue that tick's ladder — it
   * sets a flag, and the follow-up derives FRESH when the barrier clears, so
   * what goes out is always the newest state and two derivations' frames can
   * never interleave on the socket.
   */
  const requestPush = (cause: string): Promise<void> => {
    if (inFlight) {
      queued = true;
      stats.coalesced += 1;
      return inFlight;
    }
    const barrier = (async () => {
      try {
        let reason = cause;
        for (;;) {
          await runPush(reason);
          if (!queued || retired || !isOpen(socket)) break;
          queued = false;
          reason = "coalesced";
        }
      } catch (error) {
        // Nothing in `runPush` should escape, but a push must never become an
        // unhandled rejection or a rejected `push()`.
        stats.pushFailures += 1;
        emit("push-failed", "error", `push loop threw: ${String(error)}`, { cause });
      } finally {
        // Released INSIDE the body, not in a trailing `.finally`: a caller that
        // arrived in the gap between the two would have coalesced into an
        // already-finished push and lost its tick.
        inFlight = null;
        queued = false;
      }
    })();
    inFlight = barrier;
    return barrier;
  };

  const scheduleTick = (): void => {
    pushTimer = clearTimer(pushTimer);
    if (retired) return;
    pushTimer = timers.setTimeout(() => {
      pushTimer = null;
      if (retired || !isOpen(socket)) return;
      void requestPush("tick");
      scheduleTick();
    }, pushIntervalMs);
  };

  const scheduleReconnect = (): void => {
    if (retired || reconnectTimer !== null) return;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  /** Detach a dead socket exactly once and start the reconnect timer. */
  const handleClosed = (reason: string): void => {
    const dead = socket;
    if (dead === null) return;
    dead.onopen = null;
    dead.onmessage = null;
    dead.onerror = null;
    dead.onclose = null;
    socket = null;
    connectTimer = clearTimer(connectTimer);
    pushTimer = clearTimer(pushTimer);
    if (stats.connected) {
      stats.connected = false;
      emit("disconnected", "warn", `relay socket closed (${reason})`);
    }
    scheduleReconnect();
  };

  const handleMessage = (data: unknown, sourceSocket: RelayWebSocketLike): void => {
    const text = typeof data === "string" ? data : null;
    if (text === null) {
      emit("message-refused", "warn", "ignoring a non-text relay frame");
      return;
    }
    if (text.length > maxFrameBytes) {
      emit("message-refused", "warn", `ignoring a ${text.length}-byte relay frame`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      emit("message-refused", "warn", "ignoring an unparseable relay frame");
      return;
    }

    const swap = parseSwap(parsed);
    if (swap !== null) {
      if (options.onSwap === undefined) {
        // Fail closed, LOUDLY, and answer: the relay is holding a taker's job
        // open until it gets a terminal message. Dropping it would strand the
        // job until its own timeout.
        emit(
          "job-refused",
          "error",
          `refusing swap job ${swap.jobId}: job execution is not wired`,
          { jobId: swap.jobId, reason: JOB_EXECUTION_UNAVAILABLE },
        );
        void sendJobError(sourceSocket, swap.jobId, JOB_EXECUTION_UNAVAILABLE);
        return;
      }
      try {
        const handled = Promise.resolve(options.onSwap(swap));
        void handled.then(
          async (response) => {
            const terminal = parseSwapTx(response) ?? parseJobError(response);
            if (terminal === null || terminal.jobId !== swap.jobId) {
              const outcome = response === undefined ? "no terminal result" : "a malformed terminal result";
              emit(
                "job-refused",
                "error",
                `swap handler returned ${outcome} for ${swap.jobId}`,
                { jobId: swap.jobId, reason: JOB_EXECUTION_UNAVAILABLE },
              );
              await sendJobError(sourceSocket, swap.jobId, JOB_EXECUTION_UNAVAILABLE);
              return;
            }
            try {
              await sendOn(sourceSocket, terminal);
            } catch (error) {
              emit("job-refused", "warn", `could not answer job ${swap.jobId}: ${String(error)}`, {
                jobId: swap.jobId,
              });
            }
          },
          async (error) => {
            emit(
              "job-refused",
              "error",
              `swap handler rejected for ${swap.jobId}: ${String(error)}`,
              { jobId: swap.jobId, reason: JOB_EXECUTION_UNAVAILABLE },
            );
            await sendJobError(sourceSocket, swap.jobId, JOB_EXECUTION_UNAVAILABLE);
          },
        );
      } catch (error) {
        emit("job-refused", "error", `swap handler threw for ${swap.jobId}: ${String(error)}`, {
          jobId: swap.jobId, reason: JOB_EXECUTION_UNAVAILABLE,
        });
        void sendJobError(sourceSocket, swap.jobId, JOB_EXECUTION_UNAVAILABLE);
      }
      return;
    }

    const submitted = parseTxSubmitted(parsed);
    if (submitted !== null) {
      try {
        void Promise.resolve(options.onTxSubmitted?.(submitted)).catch((error) => {
          emit("message-refused", "error", `tx-submitted handler rejected: ${String(error)}`);
        });
      } catch (error) {
        emit("message-refused", "error", `tx-submitted handler threw: ${String(error)}`);
      }
      return;
    }

    const failed = parseSubmitFailed(parsed);
    if (failed !== null) {
      try {
        void Promise.resolve(options.onSubmitFailed?.(failed)).catch((error) => {
          emit("message-refused", "error", `submit-failed handler rejected: ${String(error)}`);
        });
      } catch (error) {
        emit("message-refused", "error", `submit-failed handler threw: ${String(error)}`);
      }
      return;
    }

    // The relay ignores unknown types; so do we, but visibly.
    emit("message-refused", "warn", "ignoring an unrecognised relay frame");
  };

  const sendJobError = async (
    sourceSocket: RelayWebSocketLike,
    jobId: string,
    reason: string,
  ): Promise<void> => {
    try {
      await sendOn(sourceSocket, { type: "job-error", jobId, reason });
    } catch (error) {
      emit("message-refused", "warn", `could not answer job ${jobId}: ${String(error)}`);
    }
  };

  function connect(): void {
    if (retired || socket !== null) return;
    emit("connecting", "info", `connecting to ${options.url}`);
    let created: RelayWebSocketLike;
    try {
      created = createSocket(options.url, options.authToken);
    } catch (error) {
      emit("disconnected", "warn", `could not open a relay socket: ${String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = created;

    connectTimer = timers.setTimeout(() => {
      connectTimer = null;
      if (socket !== created) return;
      emit("connect-timeout", "warn", `no relay socket within ${connectTimeoutMs} ms`);
      try {
        created.close();
      } catch {
        // A socket that will not close is a socket we simply abandon.
      }
      handleClosed("connect timeout");
    }, connectTimeoutMs);

    created.onopen = (): void => {
      if (socket !== created) return;
      connectTimer = clearTimer(connectTimer);
      stats.connected = true;
      stats.connections += 1;
      emit("connected", "info", "relay socket open; re-pushing capabilities and ladders");
      // R-34's replacement property: the relay dropped BOTH with the socket,
      // so a reconnect is a full republication, not a delta.
      void requestPush("connect");
      scheduleTick();
    };

    created.onmessage = (event: { data: unknown }): void => {
      if (socket !== created) return;
      handleMessage(event.data, created);
    };

    created.onerror = (): void => {
      if (socket !== created) return;
      emit("socket-error", "warn", "relay socket reported an error");
      // Treated as a close rather than merely noted. A REFUSED upgrade (the
      // relay's 401 for a bad bearer) surfaces on some runtimes as `error`
      // with no `close` at all; a client that only reconnected on `close`
      // would then stop reconnecting forever after one bad token. `close`
      // arriving afterwards is a no-op, because this detaches the socket.
      handleClosed("socket error");
    };

    created.onclose = (): void => {
      if (socket !== created) return;
      handleClosed("peer closed");
    };
  }

  /** Bound a promise without letting the loser reject anything. */
  const bounded = async (work: Promise<void>, ms: number, label: string): Promise<boolean> => {
    let timer: unknown = null;
    const deadline = new Promise<boolean>((resolve) => {
      timer = timers.setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([
        work.then(
          () => true,
          (error) => {
            emit("withdraw-failed", "warn", `${label} failed: ${String(error)}`);
            return false;
          },
        ),
        deadline,
      ]);
    } finally {
      timer = clearTimer(timer);
    }
  };

  const runWithdraw = async (): Promise<void> => {
    // Let an in-flight push finish first, bounded: a withdrawal overtaken by
    // the ladder it raced would leave the solver quotable.
    if (inFlight) await bounded(inFlight, withdrawTimeoutMs, "waiting for the in-flight push");

    if (!isOpen(socket)) {
      // Already disconnected — the relay has forgotten us, which is the same
      // outcome. Recorded rather than silently skipped.
      emit("withdrawn", "info", "no open socket to withdraw on; the relay already dropped us");
      stats.withdrawn = true;
      return;
    }
    // Levels first: quoting needs a live ladder, so this is the frame that
    // stops quotes. Capabilities second, so `GET /tokens` empties too.
    const work = (async () => {
      await send(withdrawalPriceLevelsFrame());
      await send(buildSolverCapabilitiesFrame([], options.ladder.maxParallelSwaps));
    })();
    const sent = await bounded(work, withdrawTimeoutMs, "withdrawal");
    stats.withdrawn = sent;
    if (sent) emit("withdrawn", "info", "explicit empty capabilities+levels withdrawal sent");
    else emit("withdraw-failed", "warn", "withdrawal did not complete within its deadline");
  };

  const withdraw = (): Promise<void> => {
    if (withdrawing) return withdrawing;
    // Retire FIRST and synchronously: no tick scheduled after this point can
    // republish the ladder the withdrawal is about to retract.
    retired = true;
    pushTimer = clearTimer(pushTimer);
    reconnectTimer = clearTimer(reconnectTimer);
    withdrawing = runWithdraw();
    return withdrawing;
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await withdraw();
      } catch (error) {
        emit("withdraw-failed", "warn", `withdrawal threw: ${String(error)}`);
      }
      const dead = socket;
      socket = null;
      connectTimer = clearTimer(connectTimer);
      pushTimer = clearTimer(pushTimer);
      reconnectTimer = clearTimer(reconnectTimer);
      if (dead !== null) {
        dead.onopen = null;
        dead.onmessage = null;
        dead.onerror = null;
        dead.onclose = null;
        try {
          dead.close();
        } catch {
          // A closing/closed socket is exactly the state being asked for.
        }
      }
      stats.connected = false;
      stats.stopped = true;
      emit("stopped", "info", "relay client stopped");
    })();
    return stopping;
  };

  connect();

  return {
    push: () => requestPush("manual"),
    withdraw,
    stop,
    stats: () => ({ ...stats }),
  };
}
