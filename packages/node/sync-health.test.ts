import { expect, test } from "bun:test";

import {
  createOwnedSingleFlightCache,
  createSingleFlightCache,
  createVerdictDamper,
  deriveSyncStatus,
  evaluateSyncVerdict,
  fetchJsonWithDeadline,
  parseCelestiaTip,
  parseMidnightTip,
  parseTipTimeMs,
  runSequentially,
} from "./sync-health.ts";
import {
  DEFAULT_SYNC_HEALTH_CONFIG,
  resolveSyncHealthConfig,
  SYNC_HEALTH_SETTINGS,
} from "./sync-health-config.ts";

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

// A public node between two ten-minute NTP blocks, as measured on preprod: NTP
// at its tip, both tips seconds old, and the applied chain positions standing
// still since the last NTP block while the tips move on.
const publicBetweenNtpBlocks = (midnightBehind: number, celestiaBehind: number) => {
  const nowMs = 1_794_347_760_000;
  return {
    ntpCurrent: 4,
    ntpLagSeconds: 0,
    ntpBlockMs: 600_000,
    midnightCurrent: 3_368_191,
    midnightTip: 3_368_191 + midnightBehind,
    celestiaCurrent: 8_912_004,
    celestiaTip: 8_912_004 + celestiaBehind,
    midnightTipTimeMs: nowMs - 4_000,
    celestiaTipTimeMs: nowMs - 19_000,
    nowMs,
  };
};

test("a public node between NTP blocks is ok however far its applied chain positions trail the tips", () => {
  for (const [midnightBehind, celestiaBehind] of [[53, 76], [100, 100], [130, 130]] as const) {
    const verdict = evaluateSyncVerdict(publicBetweenNtpBlocks(midnightBehind, celestiaBehind));
    expect(verdict.status, `midnight ${midnightBehind} / celestia ${celestiaBehind} behind`).toBe("ok");
    expect(verdict.reasons).toEqual([]);
  }
});

test("a node more than the NTP-lag limit behind is syncing even when the chain positions are at their tips", () => {
  const atTips = publicBetweenNtpBlocks(0, 0);
  // The limit is 2 NTP blocks of 600 s.
  expect(deriveSyncStatus({ ...atTips, ntpLagSeconds: 1_200 })).toBe("ok");
  const behind = evaluateSyncVerdict({ ...atTips, ntpLagSeconds: 1_800 });
  expect(behind.status).toBe("syncing");
  expect(behind.reasons).toEqual([{
    source: "ntp",
    rule: "lag",
    message: "NTP is 1800 s behind wall-clock (limit 1200 s)",
    lag_seconds: 1_800,
    max_lag_seconds: 1_200,
  }]);
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

// ── env thresholds, freshness, hysteresis ──

test("sync-health env: unset or blank takes the defaults 2 NTP blocks, 180 / 180 s, 3 samples", () => {
  expect(resolveSyncHealthConfig({})).toEqual({ config: DEFAULT_SYNC_HEALTH_CONFIG, problems: [] });
  expect(DEFAULT_SYNC_HEALTH_CONFIG).toEqual({
    maxNtpLagBlocks: 2,
    maxMidnightTipAgeSeconds: 180,
    maxCelestiaTipAgeSeconds: 180,
    hysteresisSamples: 3,
  });
  const blank = Object.fromEntries(SYNC_HEALTH_SETTINGS.map((s) => [s.name, "  "]));
  expect(resolveSyncHealthConfig(blank)).toEqual({ config: DEFAULT_SYNC_HEALTH_CONFIG, problems: [] });
});

test("sync-health env: a set value replaces its default", () => {
  const { config, problems } = resolveSyncHealthConfig({
    SYNC_HEALTH_MAX_NTP_LAG_BLOCKS: " 12 ",
    SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS: "600",
    SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS: "900",
    SYNC_HEALTH_HYSTERESIS_SAMPLES: "1",
  });
  expect(problems).toEqual([]);
  expect(config).toEqual({
    maxNtpLagBlocks: 12,
    maxMidnightTipAgeSeconds: 600,
    maxCelestiaTipAgeSeconds: 900,
    hysteresisSamples: 1,
  });
});

test.each(["0", "-1", "1.5", "1e3", "abc", "0x10", "10001"])(
  "sync-health env: %j is refused, naming the variable",
  (value) => {
    const { problems } = resolveSyncHealthConfig({ SYNC_HEALTH_MAX_NTP_LAG_BLOCKS: value });
    expect(problems).toEqual([
      `SYNC_HEALTH_MAX_NTP_LAG_BLOCKS must be an integer from 1 to 10000 (default 2), got "${value}"`,
    ]);
  },
);

test("sync-health env: per-chain block-lag limits are not settings: a leftover value is ignored, even a malformed one", () => {
  expect(resolveSyncHealthConfig({
    SYNC_HEALTH_MAX_MIDNIGHT_LAG_BLOCKS: "four",
    SYNC_HEALTH_MAX_CELESTIA_LAG_BLOCKS: "0",
  })).toEqual({ config: DEFAULT_SYNC_HEALTH_CONFIG, problems: [] });
});

test("the NTP-lag threshold comes from the config, not a constant", () => {
  const config = { ...DEFAULT_SYNC_HEALTH_CONFIG, maxNtpLagBlocks: 5 };
  // NTP limit is the block multiple times the block time: 5 × 1 s.
  expect(deriveSyncStatus({ ...healthy, ntpLagSeconds: 5 }, config)).toBe("ok");
  expect(deriveSyncStatus({ ...healthy, ntpLagSeconds: 6 }, config)).toBe("syncing");
});

test("every failed rule is a reason naming its source and numbers", () => {
  const verdict = evaluateSyncVerdict({
    ...healthy,
    ntpLagSeconds: 3,
    midnightCurrent: null,
    celestiaTip: null,
  });
  expect(verdict.status).toBe("syncing");
  expect(verdict.reasons).toEqual([
    { source: "ntp", rule: "lag", message: "NTP is 3 s behind wall-clock (limit 2 s)", lag_seconds: 3, max_lag_seconds: 2 },
    { source: "midnight", rule: "position_unknown", message: "the node's midnight position is unknown" },
    { source: "celestia", rule: "tip_unknown", message: "the celestia tip could not be read" },
  ]);
  expect(evaluateSyncVerdict({ ...healthy, ntpCurrent: 0 }).reasons.map((r) => r.rule)).toEqual(["no_finalized_block"]);
});

test("a tip older than its age limit is stale and names its source; at the limit it is fresh", () => {
  const nowMs = 1_794_300_000_000;
  const at = (ageS: number) => nowMs - ageS * 1000;
  const fresh = evaluateSyncVerdict({ ...healthy, nowMs, midnightTipTimeMs: at(180), celestiaTipTimeMs: at(180) });
  expect(fresh.status).toBe("ok");
  expect(fresh.freshness.midnight).toEqual({
    state: "fresh",
    tip_height: healthy.midnightTip,
    tip_time: new Date(at(180)).toISOString(),
    age_seconds: 180,
    max_age_seconds: 180,
  });
  const staleMidnight = evaluateSyncVerdict({ ...healthy, nowMs, midnightTipTimeMs: at(181), celestiaTipTimeMs: at(1) });
  expect(staleMidnight.status).toBe("syncing");
  expect(staleMidnight.reasons).toEqual([{
    source: "midnight",
    rule: "stale",
    message: "the midnight tip (height 100) is 181 s old (limit 180 s)",
    age_seconds: 181,
    max_age_seconds: 180,
  }]);
  const staleCelestia = evaluateSyncVerdict(
    { ...healthy, nowMs, midnightTipTimeMs: at(1), celestiaTipTimeMs: at(3_600) },
    { ...DEFAULT_SYNC_HEALTH_CONFIG, maxCelestiaTipAgeSeconds: 600 },
  );
  expect(staleCelestia.reasons.map((r) => [r.source, r.rule, r.age_seconds])).toEqual([["celestia", "stale", 3_600]]);
});

test("an unknown tip time is reported as unknown, not stale", () => {
  const verdict = evaluateSyncVerdict({ ...healthy, nowMs: 1_794_300_000_000, midnightTipTimeMs: null });
  expect(verdict.status).toBe("ok");
  expect(verdict.freshness.midnight).toEqual({
    state: "unknown",
    tip_height: healthy.midnightTip,
    tip_time: null,
    age_seconds: null,
    max_age_seconds: 180,
  });
  expect(verdict.freshness.celestia.state).toBe("unknown");
});

test("a tip time ahead of this host's clock reads as age 0, not negative", () => {
  const nowMs = 1_794_300_000_000;
  const verdict = evaluateSyncVerdict({ ...healthy, nowMs, midnightTipTimeMs: nowMs + 4_000 });
  expect(verdict.freshness.midnight).toMatchObject({ state: "fresh", age_seconds: 0 });
});

test("tip times parse from indexer milliseconds and Celestia RFC 3339; seconds and junk are unknown", () => {
  expect(parseTipTimeMs(1_794_268_314_000)).toBe(1_794_268_314_000);
  expect(parseTipTimeMs("1794268314000")).toBe(1_794_268_314_000);
  expect(parseTipTimeMs("2026-11-10T00:09:54.123456789Z")).toBe(Date.parse("2026-11-10T00:09:54.123Z"));
  expect(parseTipTimeMs(1_794_268_314)).toBeNull();
  for (const junk of [null, undefined, "", "yesterday", Number.NaN, {}, -1]) expect(parseTipTimeMs(junk)).toBeNull();
  expect(parseMidnightTip({ data: { block: { height: 7, timestamp: 1_794_268_314_000 } } }))
    .toEqual({ height: 7, timeMs: 1_794_268_314_000 });
  expect(parseMidnightTip({ data: { block: { height: 7 } } })).toEqual({ height: 7, timeMs: null });
  expect(parseCelestiaTip({ result: { header: { height: "345", time: "2026-11-10T00:09:54Z" } } }))
    .toEqual({ height: 345, timeMs: Date.parse("2026-11-10T00:09:54Z") });
  expect(parseCelestiaTip({ result: { header: { height: "345" } } })).toEqual({ height: 345, timeMs: null });
});

test("hysteresis: the first sample is published as is", () => {
  expect(createVerdictDamper(3).observe("syncing", "a")).toEqual({ status: "syncing", disagreeingSamples: 0 });
  expect(createVerdictDamper(3).current()).toBeNull();
});

test("hysteresis: one disagreeing sample between agreeing ones keeps the verdict", () => {
  const damper = createVerdictDamper(3);
  damper.observe("ok", "1");
  expect(damper.observe("syncing", "2")).toEqual({ status: "ok", disagreeingSamples: 1 });
  expect(damper.observe("ok", "3")).toEqual({ status: "ok", disagreeingSamples: 0 });
  expect(damper.observe("syncing", "4")).toEqual({ status: "ok", disagreeingSamples: 1 });
  expect(damper.observe("syncing", "5")).toEqual({ status: "ok", disagreeingSamples: 2 });
  expect(damper.observe("ok", "6")).toEqual({ status: "ok", disagreeingSamples: 0 });
});

test("hysteresis: N consecutive disagreeing samples change the verdict, both ways", () => {
  const damper = createVerdictDamper(3);
  damper.observe("ok", "1");
  expect(["2", "3", "4"].map((key) => damper.observe("syncing", key).status)).toEqual(["ok", "ok", "syncing"]);
  expect(["5", "6", "7"].map((key) => damper.observe("ok", key).status)).toEqual(["syncing", "syncing", "ok"]);
  // Disagreeing samples count together whatever they say; the latest wins.
  expect(damper.observe("syncing", "8").status).toBe("ok");
  expect(damper.observe("error", "9").status).toBe("ok");
  expect(damper.observe("error", "10")).toEqual({ status: "error", disagreeingSamples: 0 });
});

test("hysteresis: re-reading the same sample replaces it instead of counting again", () => {
  const damper = createVerdictDamper(2);
  damper.observe("ok", "1");
  expect(damper.observe("syncing", "2")).toEqual({ status: "ok", disagreeingSamples: 1 });
  expect(damper.observe("syncing", "2")).toEqual({ status: "ok", disagreeingSamples: 1 });
  expect(damper.observe("ok", "2")).toEqual({ status: "ok", disagreeingSamples: 0 });
  expect(damper.observe("syncing", "2")).toEqual({ status: "ok", disagreeingSamples: 1 });
  expect(damper.observe("syncing", "3")).toEqual({ status: "syncing", disagreeingSamples: 0 });
});

test("hysteresis: one sample to change publishes every sample; zero is refused", () => {
  const damper = createVerdictDamper(1);
  damper.observe("ok", "1");
  expect(damper.observe("syncing", "2").status).toBe("syncing");
  expect(damper.observe("ok", "3").status).toBe("ok");
  expect(() => createVerdictDamper(0)).toThrow("positive integer");
});
