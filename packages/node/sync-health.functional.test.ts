// The sync verdict end to end: a real PGlite database with the runtime's sync
// tables, a stub Midnight indexer and a stub Celestia RPC over real HTTP, and
// a controllable clock so tip-cache rounds (60 s) pass instantly. The second
// half runs the real /v1/health route in a child process configured through
// SYNC_HEALTH_* env, and the public entries' refusal of a malformed value.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { getMigrations } = await import("@effectstream/db/version");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/pglite.test-support.ts");
const { createSyncHealth } = await import("./sync-health.ts");
const { DEFAULT_SYNC_HEALTH_CONFIG } = await import("./sync-health-config.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const NTP_HEIGHT = 42;
const NTP_BLOCK_MS = 3_600_000;
const MIDNIGHT_CURRENT = 1_000;
const CELESTIA_CURRENT = 2_000;
const TIP_ROUND_MS = 61_000;

async function randomFreePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const probe = createServer();
      probe.once("error", rejectPort);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          probe.close();
          rejectPort(new Error("failed to allocate test port"));
          return;
        }
        probe.close((error) => error ? rejectPort(error) : resolvePort(address.port));
      });
    });
    if (port >= 10_000) return port;
  }
  throw new Error("could not allocate free test port >= 10000");
}

/** What each stub answers; tests mutate it between samples. */
interface StubState {
  height: number;
  /** null: the answer carries no block time. */
  timeMs: number | null;
  /** Non-200: the stub answers this HTTP status with no body. */
  httpStatus: number;
  hits: number;
}

let clockMs = 0;
/** Start time of the seeded NTP chain: block NTP_HEIGHT is current until NTP_BLOCK_MS after its start. */
let ntpAnchorMs = 0;
const indexer: StubState = { height: MIDNIGHT_CURRENT, timeMs: null, httpStatus: 200, hits: 0 };
const celestia: StubState = { height: CELESTIA_CURRENT, timeMs: null, httpStatus: 200, hits: 0 };
let indexerServer: ReturnType<typeof Bun.serve> | undefined;
let celestiaServer: ReturnType<typeof Bun.serve> | undefined;
let pglite: Awaited<ReturnType<typeof startPglite>> | undefined;
let pglitePort = 0;
let client: InstanceType<typeof pg.Client>;

function serveStub(port: number, state: StubState, body: (request: any) => unknown) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      state.hits += 1;
      if (state.httpStatus !== 200) return new Response("unavailable", { status: state.httpStatus });
      return Response.json(body(await req.json()));
    },
  });
}

/** Like a GraphQL server, the stub indexer answers only the selected fields
 * of `block { … }`. */
function indexerAnswer(request: any): unknown {
  const selection = /block\s*\{([^}]*)\}/.exec(String(request?.query ?? ""))?.[1] ?? "";
  const fields = new Set(selection.split(/[\s,]+/).filter(Boolean));
  const block: Record<string, unknown> = {};
  if (fields.has("height")) block["height"] = indexer.height;
  if (fields.has("timestamp")) block["timestamp"] = indexer.timeMs;
  return { data: { block } };
}

function celestiaAnswer(request: any): unknown {
  if (request?.method !== "header.NetworkHead") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32601, message: "method not found" } };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: {
      header: {
        height: String(celestia.height),
        ...(celestia.timeMs === null ? {} : { time: new Date(celestia.timeMs).toISOString() }),
      },
    },
  };
}

function healthy(): void {
  indexer.height = MIDNIGHT_CURRENT;
  indexer.timeMs = clockMs - 10_000;
  indexer.httpStatus = 200;
  celestia.height = CELESTIA_CURRENT;
  celestia.timeMs = clockMs - 5_000;
  celestia.httpStatus = 200;
}

/** One sync-health instance on the shared database, driven by `clockMs`. */
function newSyncHealth(config = DEFAULT_SYNC_HEALTH_CONFIG) {
  return createSyncHealth({
    config,
    midnightIndexerUrl: `http://127.0.0.1:${indexerServer!.port}/api/v4/graphql`,
    celestiaRpcUrl: `http://127.0.0.1:${celestiaServer!.port}`,
    ntpStartTimeMs: 0,
    ntpBlockTimeMs: NTP_BLOCK_MS,
    now: () => clockMs,
  });
}

/** Advance past the tip cache so the next read is a new sample. */
function nextTipRound(): void {
  clockMs += TIP_ROUND_MS;
}

beforeAll(async () => {
  clockMs = Date.parse("2026-11-10T12:00:00.000Z");
  indexerServer = serveStub(await randomFreePortAtLeast10000(), indexer, indexerAnswer);
  celestiaServer = serveStub(await randomFreePortAtLeast10000(), celestia, celestiaAnswer);

  pglitePort = await randomFreePortAtLeast10000();
  pglite = await startPglite(pglitePort);
  client = new pg.Client({ host: "127.0.0.1", port: pglitePort, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);
  // NTP at its tip for hours of fake clock: one-hour blocks anchored so that
  // block 42 is the current one.
  ntpAnchorMs = clockMs - NTP_HEIGHT * NTP_BLOCK_MS;
  await client.query(
    `INSERT INTO effectstream.sync_protocol_config_snapshot
       (protocol_name, network_type, immutable_config)
     VALUES ('ntp-validation', 'ntp', $1::jsonb)`,
    [JSON.stringify({ startTime: ntpAnchorMs, blockTimeMS: NTP_BLOCK_MS })],
  );
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks
       (block_height, ver, main_chain_block_hash, seed, ms_timestamp, effectstream_block_hash)
     VALUES ($1, 1, $2, 'sync-health-functional', $3, $4)`,
    [NTP_HEIGHT, Buffer.from("01", "hex"), new Date(clockMs).toISOString(), Buffer.from("02", "hex")],
  );
  await client.query(
    `INSERT INTO effectstream.sync_protocol_pagination(protocol_name, page_number, page)
     VALUES ('parallelMidnight', $1, '{}'::jsonb), ('parallelCelestia', $2, '{}'::jsonb)`,
    [MIDNIGHT_CURRENT, CELESTIA_CURRENT],
  );
});

afterAll(async () => {
  indexerServer?.stop(true);
  celestiaServer?.stop(true);
  await closeTestPglite(pglite, client);
});

describe("sync verdict over stub upstreams (fake clock)", () => {
  test.serial("a healthy sample is ok, with both tips fresh", async () => {
    healthy();
    const health = newSyncHealth();
    const verdict = await health.getHealthVerdict(client);
    expect(verdict).toMatchObject({ status: "ok", synced: true, raw_status: "ok", reasons: [] });
    expect(verdict.freshness?.midnight).toEqual({
      state: "fresh",
      tip_height: MIDNIGHT_CURRENT,
      tip_time: new Date(clockMs - 10_000).toISOString(),
      age_seconds: 10,
      max_age_seconds: 180,
    });
    expect(verdict.freshness?.celestia.state).toBe("fresh");
    expect(verdict.hysteresis).toEqual({ samples_to_change: 3, disagreeing_samples: 0 });
  });

  test.serial("one failed tip read between good ones keeps /v1/health ok", async () => {
    healthy();
    const health = newSyncHealth();
    expect((await health.getHealthVerdict(client)).status).toBe("ok");

    nextTipRound();
    healthy();
    celestia.httpStatus = 503;
    const bad = await health.getHealthVerdict(client);
    expect(bad.raw_status).toBe("syncing");
    expect(bad.reasons).toEqual([
      { source: "celestia", rule: "tip_unknown", message: "the celestia tip could not be read" },
    ]);
    expect(bad.status).toBe("ok");
    expect(bad.hysteresis.disagreeing_samples).toBe(1);

    nextTipRound();
    healthy();
    const recovered = await health.getHealthVerdict(client);
    expect(recovered).toMatchObject({ status: "ok", raw_status: "ok" });
    expect(recovered.hysteresis.disagreeing_samples).toBe(0);
  });

  test.serial("three consecutive failing samples flip /v1/health to syncing, naming the source", async () => {
    healthy();
    const health = newSyncHealth();
    expect((await health.getHealthVerdict(client)).status).toBe("ok");
    const seen: string[] = [];
    for (let sample = 1; sample <= 3; sample++) {
      nextTipRound();
      healthy();
      celestia.httpStatus = 503;
      const verdict = await health.getHealthVerdict(client);
      seen.push(verdict.status);
      expect(verdict.raw_status).toBe("syncing");
      expect(verdict.reasons).toEqual([
        { source: "celestia", rule: "tip_unknown", message: "the celestia tip could not be read" },
      ]);
    }
    expect(seen).toEqual(["ok", "ok", "syncing"]);

    // Recovery is damped the same way.
    const back: string[] = [];
    for (let sample = 1; sample <= 3; sample++) {
      nextTipRound();
      healthy();
      back.push((await health.getHealthVerdict(client)).status);
    }
    expect(back).toEqual(["syncing", "syncing", "ok"]);
  });

  test.serial("a frozen Midnight tip is not ok: its timestamp ages past the limit and the reason names it", async () => {
    healthy();
    const frozenAt = clockMs - 6_000;
    indexer.timeMs = frozenAt;
    const health = newSyncHealth();
    expect((await health.getHealthVerdict(client)).raw_status).toBe("ok");

    // The indexer keeps answering the same height and block time while
    // wall-clock moves on; heights alone would still read "lag 0".
    clockMs = frozenAt + 181_000;
    healthy();
    indexer.timeMs = frozenAt;
    const verdict = await health.getHealthVerdict(client);
    expect(verdict.raw_status).toBe("syncing");
    expect(verdict.reasons).toEqual([{
      source: "midnight",
      rule: "stale",
      message: `the midnight tip (height ${MIDNIGHT_CURRENT}) is 181 s old (limit 180 s)`,
      age_seconds: 181,
      max_age_seconds: 180,
    }]);
    expect(verdict.freshness?.midnight).toMatchObject({ state: "stale", age_seconds: 181 });
    expect(verdict.freshness?.celestia.state).toBe("fresh");
    // The per-sample verdict that /v1/health/sync and offer validation use
    // is not ok at once; only /v1/health is damped.
    expect((await health.getSyncStatus(client)).status).toBe("syncing");
    expect((await health.getFreshSyncStatus(client)).status).toBe("syncing");
  });

  test.serial("a frozen Celestia head is not ok and names celestia", async () => {
    healthy();
    const health = newSyncHealth();
    expect((await health.getHealthVerdict(client)).status).toBe("ok");
    const frozenAt = clockMs - 5_000;
    const statuses: string[] = [];
    for (let sample = 1; sample <= 3; sample++) {
      clockMs += 70_000;
      healthy();
      celestia.timeMs = frozenAt;
      statuses.push((await health.getHealthVerdict(client)).status);
    }
    const verdict = await health.getHealthVerdict(client);
    expect(verdict.reasons.map((r) => `${r.source}:${r.rule}`)).toEqual(["celestia:stale"]);
    expect(verdict.freshness?.celestia).toMatchObject({ state: "stale", age_seconds: 215 });
    // 75 s and 145 s old are fresh; 215 s is the first stale sample.
    expect(statuses).toEqual(["ok", "ok", "ok"]);
  });

  test.serial("an unknown tip time is reported as unknown and the height rules decide", async () => {
    healthy();
    indexer.timeMs = null;
    celestia.timeMs = null;
    const health = newSyncHealth();
    const verdict = await health.getHealthVerdict(client);
    expect(verdict).toMatchObject({ status: "ok", raw_status: "ok", reasons: [] });
    expect(verdict.freshness?.midnight).toMatchObject({ state: "unknown", tip_time: null, age_seconds: null });
    expect(verdict.freshness?.celestia).toMatchObject({ state: "unknown", tip_time: null, age_seconds: null });
  });

  test.serial("polls within one tip round are one sample, and cost no extra upstream requests", async () => {
    healthy();
    const health = newSyncHealth();
    expect((await health.getHealthVerdict(client)).status).toBe("ok");
    nextTipRound();
    healthy();
    celestia.httpStatus = 503;
    const hitsBefore = { indexer: indexer.hits, celestia: celestia.hits };
    // Twelve polls 5 s apart: each one past the 5 s response cache, all
    // inside one 60 s tip round.
    let last;
    for (let poll = 0; poll < 12; poll++) {
      last = await health.getHealthVerdict(client);
      await health.getSyncStatus(client);
      clockMs += 5_000;
    }
    expect(last!.status).toBe("ok");
    expect(last!.hysteresis.disagreeing_samples).toBe(1);
    expect(indexer.hits - hitsBefore.indexer).toBe(1);
    expect(celestia.hits - hitsBefore.celestia).toBe(1);
  });

  test.serial("thresholds from config replace the defaults", async () => {
    healthy();
    indexer.timeMs = clockMs - 40_000;
    const strict = newSyncHealth({ ...DEFAULT_SYNC_HEALTH_CONFIG, maxMidnightTipAgeSeconds: 30 });
    expect((await strict.getHealthVerdict(client)).reasons.map((r) => `${r.source}:${r.rule}`))
      .toEqual(["midnight:stale"]);

    healthy();
    const immediate = newSyncHealth({ ...DEFAULT_SYNC_HEALTH_CONFIG, hysteresisSamples: 1 });
    expect((await immediate.getHealthVerdict(client)).status).toBe("ok");
    nextTipRound();
    healthy();
    celestia.httpStatus = 503;
    expect((await immediate.getHealthVerdict(client)).status).toBe("syncing");
  });

  test.serial("applied chain positions one NTP block behind their tips read ok on every route; lag_blocks stays a diagnostic", async () => {
    // A public node late in a ten-minute NTP block: both chains have made
    // about 100 blocks since the node last applied them, NTP is current and
    // both tips are seconds old.
    healthy();
    indexer.height = MIDNIGHT_CURRENT + 100;
    celestia.height = CELESTIA_CURRENT + 100;
    const health = newSyncHealth();
    const verdict = await health.getHealthVerdict(client);
    expect(verdict).toMatchObject({ status: "ok", synced: true, raw_status: "ok", reasons: [] });
    const sync = await health.getSyncStatus(client);
    expect(sync.status).toBe("ok");
    expect(sync.midnight).toMatchObject({ current: MIDNIGHT_CURRENT, tip: MIDNIGHT_CURRENT + 100, lag_blocks: 100 });
    expect(sync.celestia).toMatchObject({ current: CELESTIA_CURRENT, tip: CELESTIA_CURRENT + 100, lag_blocks: 100 });
    expect((await health.getFreshSyncStatus(client)).status).toBe("ok");
  });

  test.serial("NTP more than two NTP blocks behind wall-clock is syncing on every route, with the chains at their tips", async () => {
    const start = clockMs;
    try {
      // The stored NTP block stays at its height while wall-clock reaches the
      // start of the second, then the third NTP block after it.
      clockMs = ntpAnchorMs + (NTP_HEIGHT + 2) * NTP_BLOCK_MS;
      healthy();
      const atLimit = newSyncHealth();
      expect((await atLimit.getHealthVerdict(client)).raw_status).toBe("ok");

      clockMs = ntpAnchorMs + (NTP_HEIGHT + 3) * NTP_BLOCK_MS;
      healthy();
      const behind = newSyncHealth();
      const verdict = await behind.getHealthVerdict(client);
      expect(verdict.raw_status).toBe("syncing");
      expect(verdict.reasons).toEqual([{
        source: "ntp",
        rule: "lag",
        message: "NTP is 10800 s behind wall-clock (limit 7200 s)",
        lag_seconds: 10_800,
        max_lag_seconds: 7_200,
      }]);
      expect((await behind.getSyncStatus(client)).status).toBe("syncing");
      expect((await behind.getFreshSyncStatus(client)).status).toBe("syncing");

      healthy();
      const tolerant = newSyncHealth({ ...DEFAULT_SYNC_HEALTH_CONFIG, maxNtpLagBlocks: 3 });
      expect((await tolerant.getHealthVerdict(client)).raw_status).toBe("ok");
    } finally {
      clockMs = start;
    }
  });
});

// ── the real route and the public entries, in child processes ──

const childEnv = (vars: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) out[key] = value;
  return out;
};

async function runChild(file: string, vars: Record<string, string | undefined>) {
  // Async spawn: the stub servers in this process must keep answering.
  const proc = Bun.spawn([process.execPath, "run", join(HERE, file)], {
    cwd: HERE,
    env: childEnv(vars),
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { stdout, stderr, exitCode };
}

describe("GET /v1/health with SYNC_HEALTH_* env (child process)", () => {
  test.serial("the route serves the new fields, and env thresholds apply", async () => {
    const realNow = Date.now();
    indexer.height = MIDNIGHT_CURRENT;
    indexer.timeMs = realNow - 60_000;
    indexer.httpStatus = 200;
    celestia.height = CELESTIA_CURRENT + 3;
    celestia.timeMs = realNow - 2_000;
    celestia.httpStatus = 200;
    const child = await runChild("sync-health.test-child.ts", {
      MIDNIGHT_NETWORK_ID: "undeployed",
      MIDNIGHT_INDEXER_HTTP: `http://127.0.0.1:${indexerServer!.port}/api/v4/graphql`,
      MIDNIGHT_INDEXER_WS: `ws://127.0.0.1:${indexerServer!.port}/api/v4/graphql/ws`,
      MIDNIGHT_NODE_HTTP: `http://127.0.0.1:${indexerServer!.port}`,
      MIDNIGHT_PROOF_SERVER_URL: "http://127.0.0.1:6300",
      CELESTIA_RPC_URL: `http://127.0.0.1:${celestiaServer!.port}`,
      EVENT_GATE_POLL_ENABLED: "false",
      DB_USER: "postgres",
      DB_NAME: "postgres",
      PGLITE_DATA_DIR: "memory://",
      TEST_PGLITE_PORT: String(await randomFreePortAtLeast10000()),
      SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS: "30",
      SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS: "1",
      SYNC_HEALTH_HYSTERESIS_SAMPLES: "5",
      // Not a setting: the node starts and Celestia, 3 blocks behind, is not judged by it.
      SYNC_HEALTH_MAX_CELESTIA_LAG_BLOCKS: "2",
    });
    const line = child.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0);
    const result = JSON.parse(line!.slice("RESULT ".length));
    expect(result.health.status).toBe(200);
    const body = JSON.parse(result.health.body);
    // The first sample after a start is published as is.
    expect(body.status).toBe("syncing");
    expect(body.synced).toBe(false);
    expect(body.raw_status).toBe("syncing");
    expect(body.reasons.map((r: any) => `${r.source}:${r.rule}`)).toEqual(["midnight:stale", "celestia:stale"]);
    expect(body.freshness.midnight).toMatchObject({ state: "stale", tip_height: MIDNIGHT_CURRENT, max_age_seconds: 30 });
    expect(body.freshness.celestia).toMatchObject({ state: "stale", tip_height: CELESTIA_CURRENT + 3, max_age_seconds: 1 });
    expect(body.hysteresis).toEqual({ samples_to_change: 5, disagreeing_samples: 0 });
    // /v1/health/sync keeps its exact grammar: no new keys.
    const sync = JSON.parse(result.healthSync.body);
    expect(Object.keys(sync).sort()).toEqual(
      ["blockL2", "celestia", "midnight", "now", "ntp", "recent_rejections", "sets", "status", "ts"],
    );
    expect(sync.status).toBe("syncing");
    expect(sync.celestia).toMatchObject({ current: CELESTIA_CURRENT, tip: CELESTIA_CURRENT + 3, lag_blocks: 3 });
  });
});

const PUBLIC_ENV = {
  MIDNIGHT_NETWORK_ID: "preprod",
  MIDNIGHT_BLOCKFROST_PROJECT_ID: "syncHealthTestProjectId000000000",
  CELESTIA_START_HEIGHT: "9000000",
  CELESTIA_RPC_URL: "https://celestia.example.invalid:26658",
  CELESTIA_AUTH_TOKEN: "bearer-for-tests",
  PGLITE: "false",
};

describe("a malformed SYNC_HEALTH_* value stops the public node with exit 78", () => {
  test.serial.each([
    ["SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS", "0"],
    ["SYNC_HEALTH_HYSTERESIS_SAMPLES", "-1"],
    ["SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS", "90.5"],
    ["SYNC_HEALTH_MAX_NTP_LAG_BLOCKS", "two"],
  ])("preflight refuses %s=%s, naming it", async (name, value) => {
    const run = await runChild("public-network-profile.ts", { ...PUBLIC_ENV, [name]: value });
    expect(run.exitCode, run.stderr).toBe(78);
    expect(run.stderr).toContain(`${name} must be an integer from 1 to`);
    expect(run.stdout).not.toContain("node configuration OK");
  });

  test.serial("main.public.ts refuses before the node starts", async () => {
    const run = await runChild("main.public.ts", { ...PUBLIC_ENV, SYNC_HEALTH_MAX_NTP_LAG_BLOCKS: "10001" });
    expect(run.exitCode, run.stderr).toBe(78);
    expect(run.stderr).toContain('SYNC_HEALTH_MAX_NTP_LAG_BLOCKS must be an integer from 1 to 10000 (default 2), got "10001"');
    expect(run.stdout).not.toContain("Starting ZSwap DA Node");
  });

  test.serial("valid values are accepted and printed by the preflight", async () => {
    const run = await runChild("public-network-profile.ts", {
      ...PUBLIC_ENV,
      SYNC_HEALTH_MAX_NTP_LAG_BLOCKS: "3",
      SYNC_HEALTH_HYSTERESIS_SAMPLES: "6",
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "[preprod] sync health        : max ntp lag 3 blocks; " +
        "max tip age midnight 180 s / celestia 180 s; hysteresis 6 samples",
    );
  });

  test.serial("a leftover per-chain block-lag limit, even a malformed one, does not stop the preflight", async () => {
    const run = await runChild("public-network-profile.ts", {
      ...PUBLIC_ENV,
      SYNC_HEALTH_MAX_MIDNIGHT_LAG_BLOCKS: "four",
      SYNC_HEALTH_MAX_CELESTIA_LAG_BLOCKS: "0",
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).not.toContain("SYNC_HEALTH_MAX_");
    expect(run.stdout).toContain(
      "[preprod] sync health        : max ntp lag 2 blocks; " +
        "max tip age midnight 180 s / celestia 180 s; hysteresis 3 samples",
    );
  });
});
