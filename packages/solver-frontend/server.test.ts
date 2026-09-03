// The aggregator, against three REAL loopback sources (00007 SC-002).
//
// Everything here runs over sockets rather than a stubbed `fetch`, because the
// behaviours under test are transport behaviours: a connection refused before
// the solver ever answered, a stream that ends without an error, a solver that
// goes away and comes back at the same address, a bearer that does not match.
// A `fetch` double proves none of those.

import { afterEach, describe, expect, test } from "bun:test";

import { resolveFrontendConfig, type FrontendConfig } from "./env.ts";
import { startFrontendServer, type FrontendServerHandle } from "./server.ts";
import {
  buildStatusSnapshot,
  freePort,
  startFakeKernel,
  startFakeRelay,
  startFakeSolver,
  TKA,
  TKB,
  waitFor,
  type FakeKernel,
  type FakeRelay,
  type FakeSolver,
} from "./test-helpers/fixtures.ts";

const TOKEN = "monitor-status-bearer-that-is-long-enough-01";

const cleanups: Array<() => void> = [];
const track = <T extends { stop: () => void }>(handle: T): T => {
  cleanups.push(() => handle.stop());
  return handle;
};

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      // A fixture that is already stopped must not fail the next test.
    }
  }
});

function configFor(
  overrides: Partial<Record<string, string>> & { solver: string; kernel: string; relay?: string },
): FrontendConfig {
  const values: Record<string, string | undefined> = {
    SOLVER_FRONTEND_HOST: "127.0.0.1",
    SOLVER_FRONTEND_SOLVER_STATUS_URL: overrides.solver,
    SOLVER_FRONTEND_SOLVER_STATUS_TOKEN: TOKEN,
    SOLVER_FRONTEND_ZSWAP_API: overrides.kernel,
    SOLVER_FRONTEND_RELAY_HTTP_URL: overrides.relay,
    SOLVER_FRONTEND_POLL_MS: overrides["SOLVER_FRONTEND_POLL_MS"] ?? "250",
    SOLVER_FRONTEND_HISTORY_LIMIT: overrides["SOLVER_FRONTEND_HISTORY_LIMIT"],
  };
  // `SOLVER_FRONTEND_PORT=0` is deliberately NOT accepted from the environment
  // (a deployment that asks for "any port" cannot be reached), so the ephemeral
  // bind the tests want is applied to the resolved config instead.
  return { ...resolveFrontendConfig({ read: (name) => values[name] }), port: 0 };
}

interface Stack {
  site: FrontendServerHandle;
  solver: FakeSolver;
  kernel: FakeKernel;
  relay: FakeRelay;
  base: string;
}

async function startStack(
  options: {
    solverPort?: number;
    withSolver?: boolean;
    prices?: boolean;
    decimals?: number;
    historyLimit?: string;
    relay?: boolean;
  } = {},
): Promise<Stack> {
  const solverPort = options.solverPort ?? freePort();
  const solver = track(
    startFakeSolver({ token: TOKEN, port: solverPort, snapshot: buildStatusSnapshot() }),
  );
  if (options.withSolver === false) solver.stop();
  const kernel = track(startFakeKernel({ prices: options.prices, decimals: options.decimals }));
  const relay = track(startFakeRelay());
  const site = track(
    startFrontendServer(
      configFor({
        solver: `http://127.0.0.1:${solverPort}`,
        kernel: kernel.url,
        relay: options.relay === false ? undefined : relay.url,
        SOLVER_FRONTEND_HISTORY_LIMIT: options.historyLimit,
      }),
    ),
  );
  return { site, solver, kernel, relay, base: `http://127.0.0.1:${site.port}` };
}

const snapshotOf = async (stack: Stack): Promise<any> =>
  await (await fetch(`${stack.base}/api/snapshot`)).json();

describe("aggregation from three sources", () => {
  test("joins solver, kernel and relay into one MonitorSnapshot", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();

    const snapshot = await snapshotOf(stack);
    expect(snapshot.monitor.contractVersion).toBe(1);
    expect(typeof snapshot.now).toBe("number");

    // solver
    expect(snapshot.solver.state).toBe("reachable");
    expect(snapshot.solver.reachable).toBe(true);
    expect(snapshot.solver.contractVersion).toBe(1);
    expect(snapshot.solver.snapshot.ladder.last.pairs).toBe(2);
    expect(snapshot.solver.host).toBe(new URL(stack.solver.url).host);

    // kernel — four sectioned reads
    expect(snapshot.kernel.sync.status).toBe("ok");
    expect(snapshot.kernel.book.count).toBe(2);
    expect(snapshot.kernel.book.offers[0].gives[0].amount).toBe("500000");
    expect(snapshot.kernel.knownTokens.map((row: any) => row.name).sort()).toEqual([
      "NIGHT",
      "TKA",
      "TKB",
    ]);
    expect(snapshot.kernel.pairs[0].openCount).toBe(2);

    // relay
    expect(snapshot.relay.configured).toBe(true);
    expect(snapshot.relay.tokens).toEqual([TKA, TKB]);
  });

  test("a kernel route that fails degrades to that section only", async () => {
    const kernel = track(startFakeKernel());
    const solverPort = freePort();
    const solver = track(startFakeSolver({ token: TOKEN, port: solverPort }));
    const site = track(
      startFrontendServer(
        // A kernel base that resolves to nothing: every kernel section becomes
        // `{ error }` and the solver half of the page still renders.
        configFor({ solver: solver.url, kernel: `http://127.0.0.1:${freePort()}` }),
      ),
    );
    const stack: Stack = {
      site,
      solver,
      kernel,
      relay: track(startFakeRelay()),
      base: `http://127.0.0.1:${site.port}`,
    };
    await waitFor(() => site.monitor.snapshot().kernel.sync !== null);
    const snapshot = await snapshotOf(stack);
    expect(typeof snapshot.kernel.sync.error).toBe("string");
    expect(typeof snapshot.kernel.book.error).toBe("string");
    expect(snapshot.solver.state).toBe("reachable");
  });

  test("a node without /v1/prices degrades silently to names only (FR-013b)", async () => {
    const stack = await startStack({ prices: false });
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();
    const snapshot = await snapshotOf(stack);
    expect(snapshot.kernel.prices).toEqual({ supported: false, tokens: [] });
    expect(snapshot.kernel.knownTokens.length).toBe(3);
  });

  test("a node WITH /v1/prices carries the source so `fallback` can be labelled", async () => {
    const stack = await startStack({ prices: true, decimals: 6 });
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();
    const snapshot = await snapshotOf(stack);
    expect(snapshot.kernel.prices.supported).toBe(true);
    expect(snapshot.kernel.prices.tokens[0]).toMatchObject({
      color: TKA,
      source: "fallback",
      decimals: 6,
    });
  });
});

describe("solver reachability (FR-010)", () => {
  test("a solver that never answered is `never-reached`, not `unreachable`", async () => {
    // "Connection refused at boot" usually means the status listener is
    // disabled or misconfigured — a different operator action from "the solver
    // I was watching went away" (spec Edge Cases).
    const stack = await startStack({ withSolver: false });
    await waitFor(() => stack.site.monitor.snapshot().solver.attempts > 0);
    const snapshot = await snapshotOf(stack);
    expect(snapshot.solver.state).toBe("never-reached");
    expect(snapshot.solver.lastSeenAt).toBeNull();
    expect(snapshot.solver.snapshot).toBeNull();
    expect(snapshot.solver.outages).toBe(0);
    expect(typeof snapshot.solver.lastError).toBe("string");
    // The page still renders: the kernel read is ours, not the solver's.
    await stack.site.monitor.pollOnce();
    expect((await snapshotOf(stack)).kernel.sync.status).toBe("ok");
  });

  test("up → down → up keeps the last snapshot and the last-seen time", async () => {
    const port = freePort();
    const stack = await startStack({ solverPort: port });
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    const seenAt = stack.site.monitor.snapshot().solver.lastSeenAt;
    expect(seenAt).not.toBeNull();

    // down
    stack.solver.stop();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "unreachable", 15_000);
    const down = stack.site.monitor.snapshot();
    expect(down.solver.reachable).toBe(false);
    expect(down.solver.outages).toBe(1);
    // The last good snapshot survives so the page can grey it rather than blank.
    expect(down.solver.snapshot).not.toBeNull();
    expect(down.solver.lastSeenAt).toBe(seenAt);
    expect(down.history.some((entry: any) => entry.kind === "solver" && entry.to === "unreachable")).toBe(true);

    // up again, at the same address
    track(startFakeSolver({ token: TOKEN, port, snapshot: buildStatusSnapshot({ now: 1_770_000_100_000 }) }));
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable", 15_000);
    const up = stack.site.monitor.snapshot();
    expect(up.solver.snapshot?.now).toBe(1_770_000_100_000);
    expect(up.solver.outages).toBe(1);
    expect(up.history.filter((entry: any) => entry.kind === "solver").length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("a stream that ENDS after delivering frames is normal: reconnect, no outage", async () => {
    // The solver closes each /status/stream after five minutes so its client
    // cap can self-heal on a runtime that never reports disconnects (Q-A-1).
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    const firstConnects = stack.site.monitor.snapshot().solver.streamConnects;

    stack.solver.endStreams();
    await waitFor(() => stack.site.monitor.snapshot().solver.streamConnects > firstConnects, 10_000);

    const after = stack.site.monitor.snapshot();
    expect(after.solver.state).toBe("reachable");
    expect(after.solver.outages).toBe(0);
    expect(after.history.some((entry: any) => entry.to === "unreachable")).toBe(false);

    // and the new stream carries live data
    stack.solver.publish(buildStatusSnapshot({ now: 1_770_000_200_000 }));
    await waitFor(() => stack.site.monitor.snapshot().solver.snapshot?.now === 1_770_000_200_000, 10_000);
  }, 30_000);

  test("falls back to /status/snapshot when the stream is refused", async () => {
    const solver = track(startFakeSolver({ token: TOKEN, noStream: true }));
    const kernel = track(startFakeKernel());
    const site = track(startFrontendServer(configFor({ solver: solver.url, kernel: kernel.url })));
    cleanups.push(() => site.stop());
    await waitFor(() => site.monitor.snapshot().solver.state === "reachable", 10_000);
    expect(site.monitor.snapshot().solver.transport).toBe("poll");
    expect(solver.counts.snapshot).toBeGreaterThan(0);
  }, 20_000);

  test("a wrong bearer is reported as a credential problem, not a mystery outage", async () => {
    const solver = track(startFakeSolver({ token: "a-different-bearer-value-of-sufficient-length" }));
    const kernel = track(startFakeKernel());
    const site = track(startFrontendServer(configFor({ solver: solver.url, kernel: kernel.url })));
    await waitFor(() => site.monitor.snapshot().solver.attempts > 0, 10_000);
    const view = site.monitor.snapshot().solver;
    expect(view.state).toBe("never-reached");
    expect(view.lastError).toContain("401");
    expect(view.lastError).toContain("SOLVER_STATUS_AUTH_TOKEN");
    expect(solver.counts.unauthorized).toBeGreaterThan(0);
  }, 20_000);
});

describe("transition history (FR-010)", () => {
  test("records the first observations and is bounded by the configured limit", async () => {
    // The very first successful cycle produces four transitions (solver, relay,
    // ladder, kernel-sync); with a limit of 2 the oldest two must be dropped.
    const stack = await startStack({ historyLimit: "2" });
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();
    await waitFor(() => stack.site.monitor.snapshot().history.length === 2);
    const snapshot = await snapshotOf(stack);
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.monitor.historyLimit).toBe(2);
    // Newest first, so the page's event log needs no reordering.
    expect(snapshot.history[0].at).toBeGreaterThanOrEqual(snapshot.history[1].at);
  });

  test("names the ladder and relay states it observed", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();
    const kinds = stack.site.monitor.snapshot().history.map((entry: any) => `${entry.kind}:${entry.to}`);
    expect(kinds).toContain("solver:reachable");
    expect(kinds).toContain("relay:connected");
    expect(kinds).toContain("ladder:quoting");
    expect(kinds).toContain("kernel-sync:ok");
  });

  test("distinguishes a fail-closed withhold from a deliberate withdrawal", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");

    stack.solver.publish(buildStatusSnapshot({ withheld: "cache-not-current", blockedReason: "backend-syncing" }));
    await waitFor(() =>
      stack.site.monitor.snapshot().history.some((entry: any) => entry.to === "withheld:cache-not-current"),
    );

    stack.solver.publish(buildStatusSnapshot({ withheld: "withdrawn" }));
    await waitFor(() => stack.site.monitor.snapshot().history.some((entry: any) => entry.to === "withdrawn"));

    const history = stack.site.monitor.snapshot().history;
    expect(history.some((entry: any) => entry.to === "withheld:cache-not-current")).toBe(true);
    expect(history.some((entry: any) => entry.to === "withdrawn")).toBe(true);
  }, 20_000);
});

describe("routes (FR-011)", () => {
  test("serves the page and every whitelisted static file", async () => {
    const stack = await startStack();
    const page = await fetch(`${stack.base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("COW Solver");

    for (const [name, type] of [
      ["index.html", "text/html"],
      ["styles.css", "text/css"],
      ["app.js", "text/javascript"],
      ["derive.js", "text/javascript"],
      ["help.js", "text/javascript"],
    ] as const) {
      const response = await fetch(`${stack.base}/${name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
    }
  });

  test("refuses everything outside the whitelist, traversal included", async () => {
    const stack = await startStack();
    for (const path of [
      "/../env.ts",
      "/../../package.json",
      "/%2e%2e%2fenv.ts",
      "/..%2fserver.ts",
      "/public/index.html",
      "/.env",
      "/index.html.bak",
      "/nope.js",
      "/api/",
      "/api/other",
      "/status/snapshot",
    ]) {
      const response = await fetch(`${stack.base}${path}`, { redirect: "manual" });
      expect(`${path} → ${response.status}`).toBe(`${path} → 404`);
    }
  });

  test("is read-only: a write method on a known route is 405", async () => {
    const stack = await startStack();
    for (const path of ["/", "/api/snapshot", "/api/stream", "/health", "/app.js"]) {
      const response = await fetch(`${stack.base}${path}`, { method: "POST" });
      expect(`${path} → ${response.status}`).toBe(`${path} → 405`);
    }
  });

  test("/health answers without any internal data", async () => {
    const stack = await startStack();
    const body = await (await fetch(`${stack.base}/health`)).json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeMs).toBe("number");
    expect(Object.keys(body).sort()).toEqual(["solver", "status", "uptimeMs"]);
  });

  test("/api/stream sends one snapshot immediately", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    const response = await fetch(`${stack.base}/api/stream`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text.startsWith("data: ")).toBe(true);
    const frame = JSON.parse(text.slice(6, text.indexOf("\n\n")));
    expect(frame.monitor.contractVersion).toBe(1);
    expect(frame.solver.state).toBe("reachable");
    await reader.cancel();
  });
});

describe("the status bearer never leaves this process (FR-009)", () => {
  test("is absent from every response body and header the site serves", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    await stack.site.monitor.pollOnce();

    const bodies: string[] = [];
    for (const path of ["/", "/index.html", "/app.js", "/derive.js", "/help.js", "/styles.css", "/api/snapshot", "/health"]) {
      const response = await fetch(`${stack.base}${path}`);
      bodies.push(await response.text());
      bodies.push(JSON.stringify([...response.headers.entries()]));
    }

    const stream = await fetch(`${stack.base}/api/stream`);
    const reader = stream.body!.getReader();
    bodies.push(new TextDecoder().decode((await reader.read()).value));
    await reader.cancel();

    for (const body of bodies) {
      expect(body.includes(TOKEN)).toBe(false);
      expect(body.toLowerCase().includes("authorization")).toBe(false);
    }
  });

  test("is not reachable through a solver error message either", async () => {
    // A failure path is the classic place a secret escapes: an error built from
    // the request that carried the header.
    const stack = await startStack({ withSolver: false });
    await waitFor(() => stack.site.monitor.snapshot().solver.attempts > 0);
    const body = await (await fetch(`${stack.base}/api/snapshot`)).text();
    expect(body.includes(TOKEN)).toBe(false);
    expect(JSON.parse(body).solver.lastError.length).toBeGreaterThan(0);
  });
});

describe("shutdown", () => {
  test("stop() closes the listener and the aggregator's own timers", async () => {
    const stack = await startStack();
    await waitFor(() => stack.site.monitor.snapshot().solver.state === "reachable");
    stack.site.stop();
    await expect(fetch(`${stack.base}/health`)).rejects.toBeDefined();
  });
});
