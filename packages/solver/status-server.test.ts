/**
 * 00007 FR-002 / FR-005 / FR-007 — the read-only status listener.
 *
 * Driven over a REAL loopback socket with `fetch`, not against a handler
 * function, because every property under test is an HTTP fact: the bearer is
 * carried in a header, the 401 must have no body, the SSE frames must arrive on
 * an unbuffered chunked response, and the listener must actually close.
 *
 * The bearer gate is the one to read first (Q-S-3). `/status/*` serves the
 * solver's entire internal state, so:
 *
 *   - a missing bearer, a wrong bearer, a bearer of a DIFFERENT LENGTH, and a
 *     bearer sent under the wrong scheme are each 401 with no body;
 *   - the check runs BEFORE the method check, so an unauthenticated caller
 *     cannot use method probing to map the surface;
 *   - every refusal is counted, so credential drift after a redeploy shows on
 *     the page instead of as a silent blank;
 *   - `/health` is the ONLY open route and carries no internal data at all,
 *     because a container healthcheck must not need the secret.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  statusContractVersion,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

import { createStatusCollector, type StatusCollectorDependencies } from "./src/status.ts";
import { startStatusServer, type StatusServerHandle } from "./src/status-server.ts";
import { Stock } from "./src/stock.ts";

const TOKEN = `status-bearer-${"s".repeat(24)}`;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");

const deps = (
  overrides: Partial<StatusCollectorDependencies> = {},
): StatusCollectorDependencies => ({
  process: {
    startedAt: NOW - 1_000,
    network: "undeployed",
    api: "http://kernel:9999",
    relayWsUrl: "ws://relay:8080/solver",
    relayHttpUrl: "http://relay:8080/api/v1",
    relayAuthTokenLength: 40,
    mode: "live",
    solverEnabled: true,
    gitCommit: null,
    runtime: null,
  },
  admission: {
    supportedPairs: null,
    minJobOutput: null,
    dust: null,
    openGroups: ["SOLVER_SUPPORTED_PAIRS"],
    feeSizingTakerInputs: 1,
    expiryMarginSeconds: 120,
    pushIntervalMs: 1_000,
    maxParallelSwaps: 8,
    maxRungsPerPair: 20,
    maxPairs: null,
    settleTtlMinutes: 30,
  },
  sync: () => null,
  stock: () => new Stock(),
  inventory: () => null,
  relay: () => null,
  executor: () => null,
  journal: () => null,
  ready: () => true,
  ...overrides,
});

const servers: StatusServerHandle[] = [];
const streams: Array<{ cancel: () => void }> = [];

afterEach(() => {
  for (const stream of streams.splice(0)) {
    try {
      stream.cancel();
    } catch {
      // Already closed by the server's own teardown.
    }
  }
  for (const server of servers.splice(0)) server.stop();
});

interface Listener {
  base: string;
  server: StatusServerHandle;
  collector: ReturnType<typeof createStatusCollector>;
}

function listener(
  collectorOverrides: Partial<StatusCollectorDependencies> = {},
  serverOverrides: Partial<Parameters<typeof startStatusServer>[0]> = {},
): Listener {
  const collector = createStatusCollector(deps(collectorOverrides));
  const server = startStatusServer({
    host: "127.0.0.1",
    // Port 0 so the OS picks a free one: this suite must not race another.
    port: 0,
    authToken: TOKEN,
    collector,
    // Far enough out that only the heartbeat test sees it.
    heartbeatMs: 60_000,
    ...serverOverrides,
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, server, collector };
}

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}` },
});

/** Read Server-Sent Event `data:` payloads until `count` have arrived. */
async function readFrames(
  response: Response,
  count: number,
  timeoutMs = 5_000,
): Promise<StatusSnapshot[]> {
  const reader = response.body!.getReader();
  streams.push({ cancel: () => void reader.cancel().catch(() => {}) });
  const decoder = new TextDecoder();
  const frames: StatusSnapshot[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  while (frames.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${frames.length}/${count} SSE frame(s)`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (chunk.startsWith("data: ")) {
        frames.push(JSON.parse(chunk.slice("data: ".length)) as StatusSnapshot);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return frames;
}

// ── the bearer gate (FR-002 / Q-S-3) ────────────────────────────────────────

describe("status listener — the bearer gate", () => {
  test("/status/snapshot is 401 without a bearer, and the 401 has no body", async () => {
    const { base, collector } = listener();
    const response = await fetch(`${base}/status/snapshot`);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    // Counted, so credential drift is visible on the page rather than silent.
    expect(collector.listenerCounters.unauthorizedRequests).toBe(1);
    expect(collector.listenerCounters.snapshotRequests).toBe(0);
  });

  test("a wrong bearer of the same length is 401", async () => {
    const { base, collector } = listener();
    const wrong = `x${TOKEN.slice(1)}`;
    expect(wrong.length).toBe(TOKEN.length);
    const response = await fetch(`${base}/status/snapshot`, {
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(response.status).toBe(401);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(1);
  });

  test("bearers of every wrong shape are refused", async () => {
    const { base, collector } = listener();
    const wrongOnes = [
      `Bearer ${TOKEN}extra`,          // longer
      `Bearer ${TOKEN.slice(0, 10)}`,  // shorter
      `Bearer `,                       // empty
      `Basic ${TOKEN}`,                // wrong scheme
      TOKEN,                           // no scheme
      `Bearer  ${TOKEN}`,              // the token is trimmed, so this one PASSES
    ];
    const statuses: number[] = [];
    for (const header of wrongOnes) {
      const response = await fetch(`${base}/status/snapshot`, {
        headers: { authorization: header },
      });
      statuses.push(response.status);
      await response.body?.cancel();
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 200]);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(5);
  });

  test("the right bearer serves the snapshot, uncached", async () => {
    const { base, collector } = listener();
    const response = await fetch(`${base}/status/snapshot`, authed());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");

    const snapshot = await response.json() as StatusSnapshot;
    expect(snapshot.contractVersion).toBe(statusContractVersion);
    expect(typeof snapshot.now).toBe("number");
    // The listener reports its own counters through the snapshot it serves.
    expect((snapshot.listener as { port: number }).port).toBeGreaterThan(0);
    expect(collector.listenerCounters.snapshotRequests).toBe(1);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(0);
  });

  test("the served snapshot never contains the status bearer (FR-006)", async () => {
    const { base } = listener();
    const body = await (await fetch(`${base}/status/snapshot`, authed())).text();
    expect(body).not.toContain(TOKEN);
    // Not even its length: the status bearer is never handed to the collector.
    expect(body).not.toContain("statusAuthToken");
  });

  test("a listener cannot be constructed without a bearer", () => {
    // Defence in depth behind `launch.ts`: the listener must not be
    // constructible into an open state even by a direct caller.
    expect(() => startStatusServer({
      host: "127.0.0.1", port: 0, authToken: "", collector: createStatusCollector(deps()),
    })).toThrow(RangeError);
  });
});

// ── /health is the only open route, and carries nothing (FR-002) ────────────

describe("status listener — /health", () => {
  test("/health is open and reports only status, readiness, mode and version", async () => {
    const { base, collector } = listener({ ready: () => false });
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    // EXACTLY these keys. A container healthcheck must not need the secret, so
    // anything internal added here would be readable by anyone who can reach
    // the port.
    expect(Object.keys(body).sort()).toEqual(["contractVersion", "mode", "ready", "status"]);
    expect(body).toEqual({
      status: "ok", ready: false, mode: "live", contractVersion: statusContractVersion,
    });
    expect(collector.listenerCounters.healthRequests).toBe(1);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(0);
  });

  test("/health answers during startup, which is the point of binding early", async () => {
    // FR-007: the listener binds BEFORE the wallet, so `/health` must answer
    // `ready: false` rather than refusing the connection.
    const { base } = listener({ ready: () => false });
    expect(((await (await fetch(`${base}/health`)).json()) as { ready: boolean }).ready).toBe(false);

    const ready = listener({ ready: () => true });
    expect(((await (await fetch(`${ready.base}/health`)).json()) as { ready: boolean }).ready)
      .toBe(true);
  });
});

// ── routing: three routes, no fourth, nothing that mutates ──────────────────

describe("status listener — routing", () => {
  test("an unknown path is 404 whether or not a bearer is presented", async () => {
    const { base, collector } = listener();
    for (const path of ["/", "/status", "/status/", "/metrics", "/status/snapshot/x", "/../etc"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
      expect((await fetch(`${base}${path}`, authed())).status).toBe(404);
    }
    expect(collector.listenerCounters.notFoundRequests).toBe(12);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(0);
  });

  test("no route mutates: every write method is refused", async () => {
    const { base } = listener();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      // Authorization is checked BEFORE the method, so an unauthenticated
      // caller cannot map the surface by probing methods.
      expect((await fetch(`${base}/status/snapshot`, { method })).status).toBe(401);
      // With the bearer, it is a plain 405 and still changes nothing.
      const authorized = await fetch(`${base}/status/snapshot`, authed({ method }));
      expect(authorized.status).toBe(405);
      expect(authorized.headers.get("allow")).toBe("GET");
      expect((await fetch(`${base}/health`, { method })).status).toBe(405);
    }
  });

  test("HEAD is served without hanging on the stream", async () => {
    const { base } = listener();
    const head = await fetch(`${base}/status/stream`, authed({ method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/event-stream");
  });
});

// ── the SSE feed (FR-002 / FR-005) ──────────────────────────────────────────

describe("status listener — /status/stream", () => {
  test("requires the bearer like every other /status route", async () => {
    const { base, collector } = listener();
    const response = await fetch(`${base}/status/stream`);
    expect(response.status).toBe(401);
    expect(collector.listenerCounters.unauthorizedRequests).toBe(1);
    expect(collector.listenerCounters.streamRequests).toBe(0);
  });

  test("sends one snapshot on connect, then a frame per coalesced change", async () => {
    const { base, collector } = listener({ coalesceMs: 1 });
    const response = await fetch(`${base}/status/stream`, authed());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Proxies buffer by default and would hold every frame.
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const first = readFrames(response, 3);
    // A burst: the coalescing floor turns these into far fewer frames than
    // notifications, which is the property that keeps a 1 Hz push loop from
    // fanning out hundreds of snapshots a second.
    for (let index = 0; index < 20; index += 1) collector.notify();
    await Bun.sleep(30);
    for (let index = 0; index < 20; index += 1) collector.notify();
    const frames = await first;

    expect(frames.length).toBe(3);
    for (const frame of frames) expect(frame.contractVersion).toBe(statusContractVersion);
    expect(collector.listenerCounters.streamRequests).toBe(1);
    expect(collector.listenerCounters.streamClients).toBe(1);
  });

  test("a heartbeat frame arrives even when nothing changes", async () => {
    const { base } = listener({}, { heartbeatMs: 25 });
    const response = await fetch(`${base}/status/stream`, authed());
    // No `notify()` at all: the second and third frames are heartbeats, which
    // is what makes a dead connection detectable from the browser.
    const frames = await readFrames(response, 3);
    expect(frames.length).toBe(3);
    expect(frames[2]!.now).toBeGreaterThanOrEqual(frames[0]!.now);
  });

  test("the client cap is enforced, and refusals are counted", async () => {
    const { base, collector } = listener({}, { clientCap: 2 });
    const first = await fetch(`${base}/status/stream`, authed());
    const second = await fetch(`${base}/status/stream`, authed());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    for (const response of [first, second]) {
      const reader = response.body!.getReader();
      streams.push({ cancel: () => void reader.cancel().catch(() => {}) });
      await reader.read();
    }
    expect(collector.listenerCounters.streamClients).toBe(2);

    // FR-005: the fan-out is bounded, so a browser cannot open connections
    // until the solver's memory is the problem.
    const third = await fetch(`${base}/status/stream`, authed());
    expect(third.status).toBe(503);
    await third.body?.cancel();
    expect(collector.listenerCounters.streamClientsRejected).toBe(1);
    expect(collector.listenerCounters.streamClients).toBe(2);
  });

  test("a stale slot is reclaimed by the stream lifetime, so the cap is not a ratchet",
    async () => {
      // Bun 1.3.11 tells the server NOTHING when an SSE client disconnects
      // (measured 2026-09-03: the request signal never aborts, `cancel` never
      // runs, `enqueue` keeps succeeding into a dead socket). So the property
      // that actually keeps `clientCap` from becoming a one-way ratchet is the
      // bounded stream lifetime, and that is what this test pins.
      const { base, collector } = listener({}, { clientCap: 1, maxStreamLifetimeMs: 40 });
      const response = await fetch(`${base}/status/stream`, authed());
      const reader = response.body!.getReader();
      streams.push({ cancel: () => void reader.cancel().catch(() => {}) });
      await reader.read();
      expect(collector.listenerCounters.streamClients).toBe(1);

      // Full right now: a second live client is correctly refused.
      const refused = await fetch(`${base}/status/stream`, authed());
      expect(refused.status).toBe(503);
      await refused.body?.cancel();
      expect(collector.listenerCounters.streamClientsRejected).toBe(1);

      // Once the first connection has had its turn, the slot comes back — the
      // page reconnects (FR-015) and nothing is stuck.
      const deadline = Date.now() + 5_000;
      let again = await fetch(`${base}/status/stream`, authed());
      while (again.status === 503) {
        await again.body?.cancel();
        if (Date.now() >= deadline) throw new Error("the expired stream never freed its slot");
        await Bun.sleep(10);
        again = await fetch(`${base}/status/stream`, authed());
      }
      expect(again.status).toBe(200);
      await again.body?.cancel();
    });
});

// ── lifecycle (FR-007) ──────────────────────────────────────────────────────

describe("status listener — lifecycle", () => {
  test("stop() closes the listener and its open streams", async () => {
    const { base, server, collector } = listener();
    const stream = await fetch(`${base}/status/stream`, authed());
    const reader = stream.body!.getReader();
    await reader.read();
    expect(collector.listenerCounters.streamClients).toBe(1);

    server.stop();
    // The stream TERMINATES rather than hanging: an SSE body never completes on
    // its own, so a graceful stop that waited for it would wait for every open
    // tab. `stop(true)` force-closes the connection, which the client sees
    // either as end-of-stream or as a reset — both are termination, and which
    // one arrives is a runtime detail this test must not pin.
    // Drain: a frame may already be buffered client-side when stop() lands.
    const deadline = Date.now() + 5_000;
    let outcome = "open";
    while (outcome === "open") {
      if (Date.now() >= deadline) throw new Error("the stream never terminated after stop()");
      outcome = await reader.read().then(
        (result) => (result.done ? "done" : "open"),
        () => "reset",
      );
    }
    expect(["done", "reset"]).toContain(outcome);
    expect(collector.listenerCounters.streamClients).toBe(0);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  test("stop() is idempotent", () => {
    const { server } = listener();
    server.stop();
    expect(() => server.stop()).not.toThrow();
  });

  test("a port already in use throws at construction, not later (FR-007)", () => {
    const first = listener();
    // The bind failure is what `run.ts` turns into a listed launch problem, and
    // it must happen synchronously — before the wallet is acquired.
    expect(() => startStatusServer({
      host: "127.0.0.1",
      port: first.server.port,
      authToken: TOKEN,
      collector: createStatusCollector(deps()),
    })).toThrow();
  });

  test("the bound port and host are reported back to the collector", () => {
    const { server, collector } = listener();
    expect(collector.listenerCounters.bound).toBe(true);
    expect(collector.listenerCounters.host).toBe("127.0.0.1");
    expect(collector.listenerCounters.port).toBe(server.port);
    expect(collector.listenerCounters.streamClientCap).toBe(32);
    server.stop();
    expect(collector.listenerCounters.bound).toBe(false);
  });

  test("a collector that throws outside its sections becomes a 500, not a dead listener",
    async () => {
      const broken = createStatusCollector(deps());
      const server = startStatusServer({
        host: "127.0.0.1",
        port: 0,
        authToken: TOKEN,
        collector: {
          ...broken,
          snapshot: () => { throw new Error("collector exploded"); },
        },
      });
      servers.push(server);
      const base = `http://127.0.0.1:${server.port}`;

      expect((await fetch(`${base}/status/snapshot`, authed())).status).toBe(500);
      // Still serving: one bad request may not take the listener down.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
});
