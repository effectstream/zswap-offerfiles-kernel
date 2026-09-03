// The solver's read-only status listener (00007 FR-001, FR-002, FR-005, FR-007).
//
// THREE ROUTES, NO FOURTH, AND NOTHING THAT MUTATES.
//
//   GET /health           200 `{status, ready, mode, contractVersion}`.
//                         UNAUTHENTICATED and deliberately empty of internal
//                         data: a Compose healthcheck must not need the secret,
//                         so this route may not carry hosts, counters, token
//                         lengths, or anything else an unauthenticated caller
//                         could learn from.
//   GET /status/snapshot  the whole `StatusSnapshot`, `cache-control: no-store`.
//   GET /status/stream    SSE: one snapshot on connect, then a frame per
//                         coalesced state change, and one at least every
//                         `STATUS_STREAM_HEARTBEAT_MS` so a dead connection is
//                         detectable from the browser.
//
// Everything under `/status/` REQUIRES `Authorization: Bearer <token>` (Q-S-3):
// the snapshot carries the solver's whole internal state, so the listener can
// never come up open — `launch.ts` makes the token mandatory whenever the port
// is set, and this module has no code path that serves `/status/*` without a
// match. The comparison is constant-time over SHA-256 digests rather than a
// string `===`, because `===` on secrets returns at the first differing byte
// and hands a local attacker a byte-at-a-time oracle. Digests are used instead
// of raw `timingSafeEqual` so tokens of DIFFERENT lengths still compare in
// fixed time. Every refusal is counted (`unauthorizedRequests`), so credential
// drift after a redeploy shows up on the page instead of as a silent blank.
//
// FR-005's fan-out half lives here: at most `STATUS_STREAM_CLIENT_CAP`
// concurrent stream clients, and a client whose buffer is already full has its
// frame DROPPED rather than awaited. A status endpoint that could apply
// backpressure to the solver would be a way to slow trading from a browser tab.
//
// FR-007: `stop()` closes the listener and every open stream, and the server is
// `unref`'d — enabling the status port must not turn a process that would have
// exited into one that hangs.

import { createHash, timingSafeEqual } from "node:crypto";

import {
  STATUS_STREAM_CLIENT_CAP,
  STATUS_STREAM_HEARTBEAT_MS,
  STATUS_STREAM_MAX_LIFETIME_MS,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

import type { StatusCollector, StatusTimers } from "./status.ts";

const DEFAULT_TIMERS: StatusTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface StatusServerOptions {
  host: string;
  port: number;
  /** Mandatory. `launch.ts` refuses a port without one, and refuses one shorter
   *  than `SOLVER_STATUS_MIN_TOKEN_LENGTH`. */
  authToken: string;
  collector: StatusCollector;
  heartbeatMs?: number;
  clientCap?: number;
  /** See `STATUS_STREAM_MAX_LIFETIME_MS`: the only reliable way to reclaim a
   *  slot from a browser that went away, because Bun does not report the
   *  disconnect. */
  maxStreamLifetimeMs?: number;
  timers?: StatusTimers;
  nowMs?: () => number;
  log?: (message: string) => void;
}

export interface StatusServerHandle {
  readonly host: string;
  /** The port actually bound. Meaningful when `port: 0` was requested, which is
   *  how the tests get a free port without racing another suite. */
  readonly port: number;
  stop: () => void;
}

/** The minimal slice of `Bun.serve`'s return this module uses, declared
 *  structurally so the file needs no ambient server type. */
interface ServerLike {
  port: number;
  hostname?: string;
  stop: (closeActiveConnections?: boolean) => void;
  unref?: () => void;
}

const encoder = new TextEncoder();

const sha256 = (value: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(value, "utf8").digest());

/**
 * Constant-time bearer comparison.
 *
 * Both sides are hashed first, so the comparison is over two fixed 32-byte
 * digests: `timingSafeEqual` refuses unequal lengths, and comparing raw tokens
 * would otherwise leak the secret's length through which requests error out
 * early. Hashing costs a few microseconds and removes the whole class.
 */
function bearerMatches(presented: string, expectedDigest: Uint8Array): boolean {
  try {
    return timingSafeEqual(sha256(presented), expectedDigest);
  } catch {
    return false;
  }
}

/** `Authorization: Bearer <token>` → the token, or null. Case-insensitive on
 *  the scheme, as RFC 7235 requires. */
function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const space = header.indexOf(" ");
  if (space < 0) return null;
  if (header.slice(0, space).toLowerCase() !== "bearer") return null;
  return header.slice(space + 1).trim();
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

interface StreamClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  openedAt: number;
}

export function startStatusServer(options: StatusServerOptions): StatusServerHandle {
  const heartbeatMs = options.heartbeatMs ?? STATUS_STREAM_HEARTBEAT_MS;
  const clientCap = options.clientCap ?? STATUS_STREAM_CLIENT_CAP;
  const maxStreamLifetimeMs = options.maxStreamLifetimeMs ?? STATUS_STREAM_MAX_LIFETIME_MS;
  const timers = options.timers ?? DEFAULT_TIMERS;
  const nowMs = options.nowMs ?? (() => Date.now());
  const log = (message: string): void => {
    try {
      options.log?.(message);
    } catch {
      // Diagnostics never own the listener's lifecycle.
    }
  };
  for (const [name, value] of [
    ["heartbeatMs", heartbeatMs],
    ["clientCap", clientCap],
    ["maxStreamLifetimeMs", maxStreamLifetimeMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`status server ${name} must be a positive safe integer, got ${value}`);
    }
  }
  if (options.authToken === "") {
    // Defence in depth: `launch.ts` already refuses this, and the listener must
    // not be constructible into an open state even by a direct caller.
    throw new RangeError("status server authToken must not be empty");
  }

  const expectedDigest = sha256(options.authToken);
  const counters = options.collector.listenerCounters;
  const clients = new Set<StreamClient>();
  // Initialised to "now", not -Infinity: an idle listener with no client must
  // tick once per interval, not spin because it is permanently overdue.
  let lastBroadcastAt = nowMs();
  let heartbeatTimer: unknown = null;
  let stopped = false;

  const frameFor = (snapshot: StatusSnapshot): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);

  /** Send to one client, DROPPING rather than awaiting when its buffer is full
   *  (FR-005). `desiredSize <= 0` is the stream's own backpressure signal. */
  const sendTo = (client: StreamClient, frame: Uint8Array): void => {
    if (client.closed) return;
    try {
      const desired = client.controller.desiredSize;
      if (desired !== null && desired <= 0) {
        counters.streamFramesDropped += 1;
        return;
      }
      client.controller.enqueue(frame);
    } catch {
      // A controller that will not take a frame is a connection that is gone.
      drop(client);
    }
  };

  const drop = (client: StreamClient): void => {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    counters.streamClients = clients.size;
    try {
      client.controller.close();
    } catch {
      // Already closed or errored: the state we were asking for.
    }
  };

  const broadcast = (snapshot: StatusSnapshot): void => {
    lastBroadcastAt = nowMs();
    if (clients.size === 0) return;
    const frame = frameFor(snapshot);
    for (const client of [...clients]) sendTo(client, frame);
  };

  const unsubscribe = options.collector.subscribe(broadcast);

  /**
   * Close streams that have had their turn.
   *
   * Bun 1.3.11 does not tell a server that an SSE client disconnected — the
   * request signal never aborts, the stream's `cancel` never runs, and
   * `enqueue` keeps succeeding into a dead socket (measured 2026-09-03). So the
   * ONLY thing that reclaims a slot from a closed browser tab is age. Without
   * this, `clientCap` would be a one-way ratchet and the 33rd page load of a
   * deployment's lifetime would be refused forever.
   */
  const reapExpired = (now: number): void => {
    for (const client of [...clients]) {
      if (now - client.openedAt >= maxStreamLifetimeMs) drop(client);
    }
  };

  /**
   * "At least every `heartbeatMs`" (FR-002), measured from the LAST frame
   * rather than on a fixed cadence: a plain interval would let a change frame
   * sent one millisecond ago push the next heartbeat out to nearly twice the
   * declared bound, and a browser's own liveness check would then be wrong
   * about a healthy connection.
   */
  const scheduleHeartbeat = (): void => {
    if (stopped) return;
    const since = nowMs() - lastBroadcastAt;
    const delay = Math.min(heartbeatMs, Math.max(1, heartbeatMs - since));
    heartbeatTimer = timers.setTimeout(() => {
      heartbeatTimer = null;
      if (stopped) return;
      reapExpired(nowMs());
      if (nowMs() - lastBroadcastAt >= heartbeatMs) {
        if (clients.size > 0) {
          try {
            broadcast(options.collector.snapshot());
          } catch {
            // A failed heartbeat must not stop the next one.
          }
        } else {
          // No one to tell. Move the reference forward so an idle listener
          // ticks once per interval instead of being permanently overdue.
          lastBroadcastAt = nowMs();
        }
      }
      scheduleHeartbeat();
    }, delay);
  };

  const unauthorized = (): Response => {
    counters.unauthorizedRequests += 1;
    // No body detail: a caller with the wrong token learns only that it is
    // wrong, never whether the route or the resource exists behind it.
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": "Bearer", "cache-control": "no-store" },
    });
  };

  const refused = (status: 404 | 405, allow?: string): Response => {
    counters.notFoundRequests += 1;
    return new Response(null, {
      status,
      headers: { "cache-control": "no-store", ...(allow === undefined ? {} : { allow }) },
    });
  };

  const openStream = (request: Request): Response => {
    counters.streamRequests += 1;
    const openedAt = nowMs();
    // Reclaim before refusing: a slot held by a tab that closed an hour ago
    // must not cost a live browser its connection.
    reapExpired(openedAt);
    if (clients.size >= clientCap) {
      counters.streamClientsRejected += 1;
      // 503 rather than 429: the listener is not rate-limiting this caller, it
      // is at its declared concurrent-client ceiling.
      return new Response(null, { status: 503, headers: { "cache-control": "no-store" } });
    }
    let client: StreamClient | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const opened: StreamClient = { controller, closed: false, openedAt };
        client = opened;
        clients.add(opened);
        counters.streamClients = clients.size;
        // Belt to the lifetime reaper's braces. Bun 1.3.11 never fires this,
        // but a runtime that DOES report the disconnect should reclaim the slot
        // at once rather than waiting out `maxStreamLifetimeMs`.
        try {
          if (request.signal.aborted) drop(opened);
          else request.signal.addEventListener("abort", () => drop(opened), { once: true });
        } catch {
          // A runtime without a request signal falls back to enqueue failure.
        }
        // FR-002: one snapshot on connect, so a page renders immediately
        // instead of waiting for the first state change.
        try {
          controller.enqueue(frameFor(options.collector.snapshot()));
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

  const handle = (request: Request): Response => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const readMethod = method === "GET" || method === "HEAD";

    if (url.pathname === "/health") {
      if (!readMethod) return refused(405, "GET, HEAD");
      counters.healthRequests += 1;
      return json(options.collector.health());
    }

    if (url.pathname === "/status/snapshot" || url.pathname === "/status/stream") {
      // Authorization is checked BEFORE the method, so an unauthenticated
      // caller cannot use method probing to map the surface.
      const presented = bearerOf(request);
      if (presented === null || !bearerMatches(presented, expectedDigest)) return unauthorized();
      if (!readMethod) return refused(405, "GET");
      if (url.pathname === "/status/snapshot") {
        counters.snapshotRequests += 1;
        return json(options.collector.snapshot());
      }
      if (method === "HEAD") {
        // A HEAD on a never-ending stream would hang; answer the headers only.
        counters.streamRequests += 1;
        return new Response(null, {
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return openStream(request);
    }

    return refused(404);
  };

  const server = (Bun.serve({
    hostname: options.host,
    port: options.port,
    // Never let a slow browser hold a request open indefinitely; the stream
    // handler returns immediately and the body is the long-lived part.
    fetch: (request: Request): Response => {
      try {
        return handle(request);
      } catch (error) {
        // FR-005: a collector that somehow throws outside its own sections
        // still must not take the listener down.
        log(`[solver] status request failed: ${error instanceof Error ? error.message : String(error)}`);
        return new Response(null, { status: 500, headers: { "cache-control": "no-store" } });
      }
    },
  }) as unknown) as ServerLike;

  // FR-007: enabling the status port must not be the reason the process stays
  // alive. Bun added `unref` to its server after the runtime this repo pins was
  // first cut, so it is called defensively.
  try {
    server.unref?.();
  } catch {
    // A runtime without it simply keeps today's liveness behaviour.
  }

  counters.bound = true;
  counters.host = options.host;
  counters.port = server.port;
  counters.startedAt = nowMs();
  counters.streamClientCap = clientCap;
  scheduleHeartbeat();

  return {
    host: options.host,
    port: server.port,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer !== null) timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
      unsubscribe();
      for (const client of [...clients]) drop(client);
      counters.streamClients = 0;
      counters.bound = false;
      try {
        // `true`: an SSE body never ends on its own, so a graceful stop that
        // waited for active connections would wait for every open browser tab.
        server.stop(true);
      } catch (error) {
        log(`[solver] status listener stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
