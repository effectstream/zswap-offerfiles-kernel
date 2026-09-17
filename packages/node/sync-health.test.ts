import { expect, test } from "bun:test";

import {
  createOwnedSingleFlightCache,
  createSingleFlightCache,
  deriveSyncStatus,
  fetchJsonWithDeadline,
  MAX_CELESTIA_LAG_BLOCKS,
  MAX_MIDNIGHT_LAG_BLOCKS,
  runSequentially,
} from "./sync-health.ts";

test("tip deadline bounds a signal-ignoring fetch and observes it as a loser", async () => {
  const started = Date.now();
  await expect(fetchJsonWithDeadline(
    (() => new Promise<Response>(() => undefined)) as typeof fetch,
    "http://tip.invalid",
    {},
    25,
  )).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(500);
});

test("tip deadline also bounds a response body that never finishes", async () => {
  const started = Date.now();
  await expect(fetchJsonWithDeadline(
    (async () => new Response(new ReadableStream({
      start() {
        // Keep the JSON body open and independent of the request signal.
      },
    }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    "http://tip.invalid",
    {},
    25,
  )).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(500);
});

const healthy = {
  ntpCurrent: 10,
  ntpLagSeconds: 0,
  ntpBlockMs: 1_000,
  midnightCurrent: 100,
  midnightTip: 100,
  celestiaCurrent: 200,
  celestiaTip: 200,
};

test("overall sync status requires all three protocol positions", () => {
  expect(deriveSyncStatus(healthy)).toBe("ok");
  expect(deriveSyncStatus({ ...healthy, midnightTip: null })).toBe("syncing");
  expect(deriveSyncStatus({ ...healthy, celestiaCurrent: null })).toBe("syncing");
});

test("lagged Midnight or Celestia prevents readiness even when NTP is current", () => {
  expect(deriveSyncStatus({
    ...healthy,
    midnightTip: healthy.midnightCurrent + MAX_MIDNIGHT_LAG_BLOCKS + 1,
  })).toBe("syncing");
  expect(deriveSyncStatus({
    ...healthy,
    celestiaTip: healthy.celestiaCurrent + MAX_CELESTIA_LAG_BLOCKS + 1,
  })).toBe("syncing");
});

test("no finalized NTP block is an error; an NTP lag is syncing", () => {
  expect(deriveSyncStatus({ ...healthy, ntpCurrent: 0 })).toBe("error");
  expect(deriveSyncStatus({ ...healthy, ntpBlockMs: Number.NaN })).toBe("error");
  expect(deriveSyncStatus({ ...healthy, midnightTip: Number.NaN })).toBe("syncing");
  expect(deriveSyncStatus({ ...healthy, ntpLagSeconds: 3 })).toBe("syncing");
});

test("whole-response cache coalesces a polling burst and expires as one unit", async () => {
  let now = 0;
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = createSingleFlightCache<{ sequence: number }>(10, () => now);
  const load = async () => {
    loads += 1;
    await gate;
    return { sequence: loads };
  };

  const first = cache.get(load);
  const concurrent = cache.get(load);
  expect(loads).toBe(1);
  release();
  expect(await first).toEqual({ sequence: 1 });
  expect(await concurrent).toEqual({ sequence: 1 });
  expect(await cache.get(load)).toEqual({ sequence: 1 });
  expect(loads).toBe(1);

  now = 11;
  expect(await cache.get(load)).toEqual({ sequence: 2 });
  expect(loads).toBe(2);
});

test("whole-response caches never cross database owners", async () => {
  const cache = createOwnedSingleFlightCache<{ database: string }>(1_000, () => 0);
  const databaseA = {};
  const databaseB = {};
  let loadsA = 0;
  let loadsB = 0;

  const a = () => {
    loadsA += 1;
    return Promise.resolve({ database: "a" });
  };
  const b = () => {
    loadsB += 1;
    return Promise.resolve({ database: "b" });
  };

  expect(await cache.get(databaseA, a)).toEqual({ database: "a" });
  expect(await cache.get(databaseB, b)).toEqual({ database: "b" });
  expect(await cache.get(databaseA, a)).toEqual({ database: "a" });
  expect(loadsA).toBe(1);
  expect(loadsB).toBe(1);
});

test("health query tasks never overlap on a single pg client", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const task = (name: string) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await Promise.resolve();
    order.push(`end:${name}`);
    active -= 1;
    return name;
  };

  expect(await runSequentially([task("a"), task("b"), task("c")] as const)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(maxActive).toBe(1);
  expect(order).toEqual([
    "start:a", "end:a",
    "start:b", "end:b",
    "start:c", "end:c",
  ]);
});
