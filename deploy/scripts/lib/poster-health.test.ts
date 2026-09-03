// Health-surface unit tests (FR-013 / US3 scenario 3).
//
// The policy — which state, 200 or 503 — is a pure function, so it is tested
// directly. The server itself is exercised once over a real socket on an
// ephemeral port (port 0), because the routing and the content types are the
// other half of the contract and they are cheap to check.

import { describe, expect, test } from "bun:test";

import {
  healthSnapshot,
  renderMetrics,
  startHealthServer,
  type HealthInputs,
} from "./poster-health.ts";
import type { SchedulerStats } from "./poster-scheduler.ts";

const stats = (over: Partial<SchedulerStats> = {}): SchedulerStats => ({
  ticks: 10,
  mints: 4,
  reoffers: 6,
  degraded: 0,
  success: 10,
  failure: 0,
  overruns: 1,
  consecutiveFailures: 0,
  startedAt: 1_000,
  lastTickAt: 61_000,
  lastTickMs: 812,
  lastMode: "mint",
  lastOfferId: "abc",
  lastError: null,
  lastFailure: null,
  p95TickMs: 1_200,
  p50TickMs: 800,
  ...over,
});

const inputs = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  stats: stats(),
  staleTicks: 3,
  dustBalance: 123_456_789_012_345_678_901n,
  liveOffers: 6,
  freeCoins: 2,
  candidates: 1,
  journalSummary: null,
  startedAt: 1_000,
  now: 601_000,
  shuttingDown: false,
  ready: true,
  ...over,
});

describe("state machine", () => {
  test("a healthy, ticking poster is 200 ok", () => {
    const { status, body } = healthSnapshot(inputs());
    expect(status).toBe(200);
    expect(body["state"]).toBe("ok");
  });

  test("before the first tick it is starting, not ok", () => {
    expect(healthSnapshot(inputs({ stats: stats({ ticks: 0 }) })).body["state"]).toBe("starting");
    expect(healthSnapshot(inputs({ ready: false })).body["state"]).toBe("starting");
    // …and still a 200, so compose's start_period does not kill a syncing wallet.
    expect(healthSnapshot(inputs({ ready: false })).status).toBe(200);
  });

  test("HEALTH_STALE_TICKS consecutive failures flip it to 503", () => {
    expect(healthSnapshot(inputs({ stats: stats({ consecutiveFailures: 2 }) })).status).toBe(200);
    const at3 = healthSnapshot(inputs({ stats: stats({ consecutiveFailures: 3 }) }));
    expect(at3.status).toBe(503);
    expect(at3.body["state"]).toBe("unhealthy");
    expect(healthSnapshot(inputs({ staleTicks: 1, stats: stats({ consecutiveFailures: 1 }) })).status).toBe(
      503,
    );
  });

  test("a DEGRADED tick is visible but not unhealthy (US1 scenario 6)", () => {
    const answer = healthSnapshot(
      inputs({
        stats: stats({ lastMode: "degraded", lastFailure: "insufficient_dust", degraded: 4 }),
        dustBalance: 0n,
      }),
    );
    expect(answer.status).toBe(200);
    expect(answer.body["state"]).toBe("degraded");
    expect(answer.body["lastFailure"]).toBe("insufficient_dust");
    expect(answer.body["dustBalance"]).toBe("0");
  });

  test("shutting down wins over everything, and is not an error", () => {
    const answer = healthSnapshot(
      inputs({ shuttingDown: true, stats: stats({ lastMode: "degraded" }) }),
    );
    expect(answer.body["state"]).toBe("stopping");
    expect(answer.status).toBe(200);
    // …except a genuinely unhealthy poster, which stays a 503 while it stops.
    const unhealthy = healthSnapshot(
      inputs({ shuttingDown: true, stats: stats({ consecutiveFailures: 5 }) }),
    );
    expect(unhealthy.status).toBe(503);
  });
});

describe("payload", () => {
  test("carries every field US3 scenario 3 names", () => {
    const { body } = healthSnapshot(inputs());
    for (const key of [
      "state",
      "ticks",
      "mints",
      "reoffers",
      "lastTickAt",
      "lastOfferId",
      "lastError",
      "dustBalance",
      "liveOffers",
      "freeCoins",
      "p95TickMs",
    ]) {
      expect(body).toHaveProperty(key);
    }
  });

  test("DUST is a decimal string, so values above 2^53 survive JSON", () => {
    const { body } = healthSnapshot(inputs());
    expect(body["dustBalance"]).toBe("123456789012345678901");
    expect(JSON.parse(JSON.stringify(body))["dustBalance"]).toBe("123456789012345678901");
    expect(healthSnapshot(inputs({ dustBalance: null })).body["dustBalance"]).toBeNull();
  });

  test("lastTickAt is an ISO timestamp, or null before the first tick", () => {
    expect(healthSnapshot(inputs()).body["lastTickAt"]).toBe(new Date(61_000).toISOString());
    expect(healthSnapshot(inputs({ stats: stats({ lastTickAt: null }) })).body["lastTickAt"]).toBeNull();
  });
});

describe("metrics", () => {
  test("emits HELP/TYPE/value triples and an `up` that follows /health", () => {
    const text = renderMetrics(inputs());
    expect(text).toContain("# TYPE offer_poster_ticks_total counter");
    expect(text).toContain("offer_poster_ticks_total 10");
    expect(text).toContain("offer_poster_reoffers_total 6");
    expect(text).toContain("offer_poster_overruns_total 1");
    expect(text).toContain("offer_poster_tick_ms_p95 1200");
    expect(text).toContain("offer_poster_up 1");
    expect(text.endsWith("\n")).toBe(true);

    const down = renderMetrics(inputs({ stats: stats({ consecutiveFailures: 9 }) }));
    expect(down).toContain("offer_poster_up 0");
  });

  test("a null percentile is NaN, not a missing line", () => {
    const text = renderMetrics(inputs({ stats: stats({ p95TickMs: null, p50TickMs: null }) }));
    expect(text).toContain("offer_poster_tick_ms_p95 NaN");
  });

  test("DUST is printed unrounded", () => {
    expect(renderMetrics(inputs())).toContain("offer_poster_dust_balance 123456789012345678901");
    expect(renderMetrics(inputs({ dustBalance: null }))).not.toContain("dust_balance");
  });
});

describe("the server", () => {
  test("routes /health, /metrics and /journal, and 404s the rest", async () => {
    let current = inputs();
    const server = startHealthServer({
      // Port 0 = an ephemeral port the OS picks, so this cannot collide with
      // anything else on a shared machine.
      port: 0,
      hostname: "127.0.0.1",
      snapshot: () => current,
      journal: () => ({ version: 1, coins: {} }),
      log: () => undefined,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("content-type")).toContain("application/json");
      expect((await health.json())["state"]).toBe("ok");

      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toContain("offer_poster_ticks_total");

      const journal = await fetch(`${base}/journal`);
      expect(journal.status).toBe(200);
      expect(await journal.json()).toEqual({ version: 1, coins: {} });

      expect((await fetch(`${base}/nope`)).status).toBe(404);
      // `/` is an alias for `/health` so a bare curl says something useful.
      expect((await fetch(`${base}/`)).status).toBe(200);

      // The snapshot is read PER REQUEST, so the answer tracks the loop.
      current = inputs({ stats: stats({ consecutiveFailures: 4 }) });
      const stale = await fetch(`${base}/health`);
      expect(stale.status).toBe(503);
      expect((await stale.json())["state"]).toBe("unhealthy");
    } finally {
      await server.stop();
    }
  });
});

describe("give range on /health and /metrics (00027 FR-003)", () => {
  const range = { minBase: 100_000n, maxBase: 10_000_000n };

  test("absent when no range is configured — the fixed-size body is unchanged (SC-003)", () => {
    const { body } = healthSnapshot(inputs());
    expect(body).not.toHaveProperty("giveRange");
    expect(body).not.toHaveProperty("lastGiveAmount");
    expect(renderMetrics(inputs())).not.toContain("last_give_amount");
  });

  test("the range and the last drawn size are decimal strings, never bigints", () => {
    const { body } = healthSnapshot(inputs({ giveRange: range, lastGiveAmount: 2_345_678n }));
    expect(body["giveRange"]).toEqual({ minBase: "100000", maxBase: "10000000" });
    expect(body["lastGiveAmount"]).toBe("2345678");
    // The whole body must survive JSON.stringify — a stray bigint throws.
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  test("before the first draw the last size is null, not 0", () => {
    const { body } = healthSnapshot(inputs({ giveRange: range, lastGiveAmount: null }));
    expect(body["giveRange"]).toBeDefined();
    expect(body["lastGiveAmount"]).toBeNull();
  });

  test("/metrics gauges the last drawn size unrounded, NaN before the first draw", () => {
    expect(renderMetrics(inputs({ giveRange: range, lastGiveAmount: 9_999_999n }))).toContain(
      "offer_poster_last_give_amount 9999999",
    );
    expect(renderMetrics(inputs({ giveRange: range, lastGiveAmount: null }))).toContain(
      "offer_poster_last_give_amount NaN",
    );
  });
});
