import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getMigrations } from "@effectstream/db/version";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// 00056 — the kernel's offer-expiry model matches the ledger, end to end
// through the production code paths:
//
//   T1  an unshielded intent TTL of +2 h / +3 d / +14 d − 1 min is accepted
//       and +14 d + 1 s / expired are refused with INTENT_TTL_TOO_FAR /
//       INTENT_TTL_EXPIRED — at STM ingestion, the API submit gate, the
//       batcher's pre-fee gate and offer-guard (they all validate against the
//       network's pinned reference parameters, global_ttl = 14 days);
//   T2  expiry = min(root deadline, earliest intent TTL) for shielded-only,
//       unshielded-only and mixed offers, with no OFFER_TTL_SECONDS cap;
//   T3  ttl_seconds / ttlSeconds is the per-offer lifetime;
//   T4  replaying an input gives an identical verdict and row, and a network
//       without reference parameters fails at startup.
//
// The offers are real: the unshielded ones are signed and bound
// (packages/validator/signed-offer.testkit.ts), the shielded one is the
// committed proven fixture, and a mixed one is that fixture merged with a
// bound intent. The STM generator is the production one; every query it yields
// runs on PGlite inside a transaction each case rolls back.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const database = await import("@zswap-da/database");
const effectstreamDb = await import("@effectstream/db");
const { migrationTable } = database;
const { closeTestPglite } = await import("../database/test-pglite.ts");
const { eventBus, markBlockCommitted, __resetEventGateForTests } = await import("./event-bus.ts");
const { getReferenceState, validateZswapOffer } = await import("@zswap-da/validator");
const { signedUnshieldedOffer, withIntent } = await import("../validator/signed-offer.testkit.ts");
const { bytesToLatin1, guardOffer, offerHashFromBytes } = await import("@zswap-da/offer-guard");
const { gameStateTransitions } = await import("./state-machine.ts");
const { canonicalValidatorCode, checkedVerdict } = await import("./offer-validation.ts");
const { ZswapCelestiaAdapter } = await import("../batcher/celestia.ts");
const { UnknownNetworkParametersError } = await import("@zswap-da/validator");
const { apiRouter } = await import("./api.ts");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;

const HOUR_S = 3_600;
const DAY_S = 86_400;
const GLOBAL_TTL_S = 14 * DAY_S;
const BLOCK_TIME_MS = Date.parse("2026-08-14T12:00:00.000Z");
const TIP_HEIGHT = 1_000;
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const FIXTURE_BYTES = OfferFiles.decode(
  readFileSync(join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32"), "utf8").trim(),
);
const fixtureProbe = validateZswapOffer(OfferFiles.encode(FIXTURE_BYTES), {
  refState: getReferenceState("undeployed"),
  tblock: new Date(BLOCK_TIME_MS),
  maxBytes: 1 << 21,
  crypto: "defer",
});
if (!fixtureProbe.ok || !fixtureProbe.inputRoots?.[0]) {
  throw new Error(`committed valid-offer fixture is unusable: ${fixtureProbe.code ?? "unknown"}`);
}
const FIXTURE_ROOTS = fixtureProbe.inputRoots;
const TIP_ROOT = "ab".repeat(32);

const PREPARED_BY_IR = new Map<unknown, { run(params: unknown, conn: unknown): Promise<unknown[]> }>();
for (const mod of [database, effectstreamDb] as Record<string, any>[]) {
  for (const value of Object.values(mod)) {
    if (value && typeof value === "object" && "queryIR" in value && typeof value.run === "function") {
      PREPARED_BY_IR.set(value.queryIR, value);
    }
  }
}

async function randomFreePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const probeServer = createServer();
      probeServer.once("error", rejectPort);
      probeServer.listen(0, "127.0.0.1", () => {
        const address = probeServer.address();
        if (!address || typeof address === "string") {
          probeServer.close();
          rejectPort(new Error("failed to allocate a TCP test port"));
          return;
        }
        probeServer.close((error) => error ? rejectPort(error) : resolvePort(address.port));
      });
    });
    if (port >= 10_000) return port;
  }
  throw new Error("could not allocate a free test port >= 10000");
}

let pglite: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client> | undefined;
let server: any;
let originalFetch: typeof fetch = globalThis.fetch;
let batcherSubmissions = 0;

beforeAll(async () => {
  const port = await randomFreePortAtLeast10000();
  pglite = await startPglite(port);
  client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/send-input")) {
      batcherSubmissions += 1;
      return new Response(JSON.stringify({
        success: true,
        message: "Input processed successfully",
        inputsProcessed: 1,
        transactionHash: "offer-expiry-model-tx",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Anything else (the Celestia adapter's readiness probe) is unavailable.
    return new Response("unavailable in offer-expiry-model.test.ts", { status: 503 });
  }) as typeof fetch;

  server = fastify();
  await apiRouter(server, client);
  await server.ready();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  try {
    await server?.close();
  } finally {
    await closeTestPglite(pglite, client);
  }
});

type Observation = {
  events: Array<Record<string, any>>;
  queries: Array<{ queryIR: any; params: any }>;
};

/** Drive the production STM for one input, executing every yielded query on PGlite. */
async function driveStm(conciseInput: string, blockHeight: number): Promise<Observation> {
  const events: Array<Record<string, any>> = [];
  const queries: Array<{ queryIR: any; params: any }> = [];
  __resetEventGateForTests();
  const onAppEvent = (event: any) => { events.push(event); };
  eventBus.on("app_event", onAppEvent);
  try {
    const generator = gameStateTransitions(1, {
      blockHeight,
      blockTimestamp: BLOCK_TIME_MS,
      conciseInput,
      randomGenerator: {} as any,
      emit: () => {
        throw new Error("lifecycle events must go through the event gate, not data.emit");
      },
    } as any);
    let next = generator.next();
    while (!next.done) {
      const value = next.value as any;
      let result: unknown[];
      if (Array.isArray(value) && value.length === 2) {
        const [queryIR, params] = value;
        const query = PREPARED_BY_IR.get(queryIR);
        if (!query) throw new Error(`STM yielded an unmapped query: ${String(queryIR?.statement).slice(0, 120)}`);
        queries.push({ queryIR, params });
        result = await query.run(params, client);
      } else if (value && typeof value === "object" && "promise" in value) {
        result = [await value.promise];
      } else {
        throw new Error(`unexpected STM yield: ${String(value)}`);
      }
      next = generator.next(result);
    }
    markBlockCommitted(blockHeight);
  } finally {
    eventBus.off("app_event", onAppEvent);
    __resetEventGateForTests();
  }
  return { events, queries };
}

const ingest = (bytes: Uint8Array) =>
  driveStm(JSON.stringify(["celestia-zswap", { suppliedValue: bytesToLatin1(bytes) }]), 77);

const rejectionCode = (o: Observation): string | null =>
  o.events.find((e) => e.type === "offer_rejected")?.code ?? null;

async function inRolledBackTransaction(body: () => Promise<void>): Promise<void> {
  await client!.query("BEGIN");
  try {
    await body();
  } finally {
    await client!.query("ROLLBACK");
  }
}

/** The spent UTXO exists and is unspent (the offer's liveness input). */
async function seedLiveUtxo(spend: { owner: string; intentHash: string; outputNo: number }): Promise<void> {
  await client!.query(
    `INSERT INTO created_unshielded (owner, intent_hash, output_no, height) VALUES ($1, $2, $3, 1)`,
    [spend.owner, spend.intentHash, spend.outputNo],
  );
}

/** The chain tip plus the fixture's proof roots, all last seen `ageS` ago. */
async function seedFixtureRootsAged(ageS: number): Promise<void> {
  const seed = (root: string, height: number, lastSeenMs: number) => client!.query(
    `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms) VALUES ($1, $2, $3, $3)`,
    [root, height, lastSeenMs],
  );
  await seed(TIP_ROOT, TIP_HEIGHT, BLOCK_TIME_MS);
  let height = TIP_HEIGHT - 10;
  for (const root of FIXTURE_ROOTS) await seed(root, height--, BLOCK_TIME_MS - ageS * 1000);
}

type Row = { id: number; ttl_seconds: string; metadata_expires_at: Date; metadata_created_at: Date; first_seen_at: Date };
async function offerRow(bytes: Uint8Array): Promise<Row | undefined> {
  return (await client!.query(
    `SELECT id, ttl_seconds, metadata_expires_at, metadata_created_at, first_seen_at
       FROM offer_file WHERE offer_hash = $1`,
    [offerHashFromBytes(bytes)],
  )).rows[0];
}

const atBlock = (seconds: number) => new Date(BLOCK_TIME_MS + seconds * 1000);

// ── T1 ────────────────────────────────────────────────────────────────────

describe("T1 — STM ingestion: unshielded intent TTL within the 14-day window", () => {
  for (const [label, seconds] of [
    ["+2 h", 2 * HOUR_S],
    ["+3 days", 3 * DAY_S],
    ["+14 days − 1 min", GLOBAL_TTL_S - 60],
  ] as const) {
    test(`${label}: indexed, expiring at the intent TTL, ttl_seconds = ${seconds}`, async () => {
      const offer = await signedUnshieldedOffer(atBlock(seconds));
      await inRolledBackTransaction(async () => {
        await seedLiveUtxo(offer.spend);
        const observed = await ingest(offer.bytes);
        expect(rejectionCode(observed)).toBeNull();
        expect(observed.events.some((e) => e.type === "offer_indexed")).toBe(true);
        const row = (await offerRow(offer.bytes))!;
        expect(new Date(row.metadata_expires_at).getTime()).toBe(offer.ttl.getTime());
        expect(Number(row.ttl_seconds)).toBe(seconds);
      });
    });
  }

  for (const [label, seconds, code] of [
    ["+14 days + 1 s", GLOBAL_TTL_S + 1, "INTENT_TTL_TOO_FAR"],
    ["expired (−1 s)", -1, "INTENT_TTL_EXPIRED"],
  ] as const) {
    test(`${label}: rejected ${code}, not indexed`, async () => {
      const offer = await signedUnshieldedOffer(atBlock(seconds));
      await inRolledBackTransaction(async () => {
        await seedLiveUtxo(offer.spend);
        const observed = await ingest(offer.bytes);
        expect(rejectionCode(observed)).toBe(code);
        expect(await offerRow(offer.bytes)).toBeUndefined();
        const counted = (await client!.query(
          `SELECT code, count FROM offer_rejections WHERE code = $1`,
          [code],
        )).rows;
        expect(counted.length).toBe(1);
      });
    });
  }
});

describe("T1 — API submit gate (wall-clock tblock)", () => {
  const nowPlus = (seconds: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000);
  const submit = (blob: string) => server.inject({ method: "POST", url: "/v1/offers", payload: { offer: blob } });

  test("+2 h, +3 days and +14 days − 1 min are forwarded to the batcher", async () => {
    for (const seconds of [2 * HOUR_S, 3 * DAY_S, GLOBAL_TTL_S - 60]) {
      const offer = await signedUnshieldedOffer(nowPlus(seconds));
      await inRolledBackTransaction(async () => {
        await seedLiveUtxo(offer.spend);
        const before = batcherSubmissions;
        const response = await submit(offer.blob);
        expect({ seconds, status: response.statusCode, body: response.json() })
          .toMatchObject({ seconds, status: 200, body: { success: true } });
        expect(batcherSubmissions).toBe(before + 1);
      });
    }
  });

  test("beyond tblock + global_ttl → 400 INTENT_TTL_TOO_FAR; expired → 400 INTENT_TTL_EXPIRED", async () => {
    // A minute of slack either side: the route reads the wall clock itself.
    for (const [seconds, code] of [[GLOBAL_TTL_S + 60, "INTENT_TTL_TOO_FAR"], [-60, "INTENT_TTL_EXPIRED"]] as const) {
      const offer = await signedUnshieldedOffer(nowPlus(seconds));
      await inRolledBackTransaction(async () => {
        await seedLiveUtxo(offer.spend);
        const before = batcherSubmissions;
        const response = await submit(offer.blob);
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe(code);
        expect(response.json().reason).toContain("Intent TTL");
        expect(batcherSubmissions).toBe(before);
      });
    }
  });
});

describe("T1 — batcher pre-fee gate and offer-guard (wall-clock tblock)", () => {
  const nowPlus = (seconds: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000);
  const CELESTIA_CONFIG = {
    rpcUrl: "http://127.0.0.1:1",
    namespace: "000000000000deadbeef",
    authToken: "",
    network: "devnet",
    fee: 2000,
    gasLimit: 100000,
    syncProtocolName: "parallelCelestia",
  } as any;
  const adapter = (networkId = "undeployed") => new ZswapCelestiaAdapter(CELESTIA_CONFIG, networkId);
  const batcherInput = (blob: string) => ({ address: "offer-expiry-model", addressType: 0, input: blob, timestamp: "1" });

  test("accepted within the window; refused with the new codes outside it", async () => {
    for (const seconds of [2 * HOUR_S, 3 * DAY_S, GLOBAL_TTL_S - 60]) {
      const offer = await signedUnshieldedOffer(nowPlus(seconds));
      expect(await adapter().validateInput(batcherInput(offer.blob) as any)).toEqual({ valid: true });
      const guarded = await guardOffer(offer.blob, {
        networkId: "undeployed",
        maxBytes: 1 << 21,
        isUnshieldedLive: async () => true,
      });
      expect(guarded.ok).toBe(true);
    }
    for (const [seconds, code] of [[GLOBAL_TTL_S + 60, "INTENT_TTL_TOO_FAR"], [-60, "INTENT_TTL_EXPIRED"]] as const) {
      const offer = await signedUnshieldedOffer(nowPlus(seconds));
      const verdict = await adapter().validateInput(batcherInput(offer.blob) as any);
      expect(verdict.valid).toBe(false);
      expect(verdict.error).toStartWith(`${code}: `);
      const guarded = await guardOffer(offer.blob, {
        networkId: "undeployed",
        maxBytes: 1 << 21,
        isUnshieldedLive: async () => true,
      });
      expect(guarded.ok).toBe(false);
      if (!guarded.ok) expect(guarded.code).toBe(code);
    }
  });

  test("the batcher refuses to start for a network without reference parameters", () => {
    expect(() => adapter("preview")).toThrow(UnknownNetworkParametersError);
    expect(() => adapter("preview")).toThrow("supported: stagenet, undeployed");
    expect(() => adapter("stagenet")).not.toThrow();
  });
});

// ── T2 / T3 ───────────────────────────────────────────────────────────────

describe("T2/T3 — STM expiry is the earliest real limit; ttl_seconds is per offer", () => {
  test("shielded-only: root last-seen + 14 days (no TTL of its own)", async () => {
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(2 * HOUR_S);
      const observed = await ingest(FIXTURE_BYTES);
      expect(rejectionCode(observed)).toBeNull();
      const row = (await offerRow(FIXTURE_BYTES))!;
      const expected = BLOCK_TIME_MS - 2 * HOUR_S * 1000 + GLOBAL_TTL_S * 1000;
      expect(new Date(row.metadata_expires_at).getTime()).toBe(expected);
      expect(Number(row.ttl_seconds)).toBe(GLOBAL_TTL_S - 2 * HOUR_S);
    });
  });

  test("mixed, intent earlier: the intent TTL (1 day) wins over the root deadline", async () => {
    const mixed = await withIntent(FIXTURE_BYTES, atBlock(DAY_S));
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(2 * HOUR_S);
      const observed = await ingest(mixed.bytes);
      expect(rejectionCode(observed)).toBeNull();
      const row = (await offerRow(mixed.bytes))!;
      expect(new Date(row.metadata_expires_at).getTime()).toBe(mixed.ttl.getTime());
      expect(Number(row.ttl_seconds)).toBe(DAY_S);
    });
  });

  test("mixed, root earlier: the root deadline wins over a 14 d − 1 min intent TTL", async () => {
    const mixed = await withIntent(FIXTURE_BYTES, atBlock(GLOBAL_TTL_S - 60));
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(2 * HOUR_S);
      const observed = await ingest(mixed.bytes);
      expect(rejectionCode(observed)).toBeNull();
      const row = (await offerRow(mixed.bytes))!;
      expect(new Date(row.metadata_expires_at).getTime())
        .toBe(BLOCK_TIME_MS - 2 * HOUR_S * 1000 + GLOBAL_TTL_S * 1000);
      expect(Number(row.ttl_seconds)).toBe(GLOBAL_TTL_S - 2 * HOUR_S);
    });
  });

  test("mixed with an intent TTL past the window is refused at ingestion (INTENT_TTL_TOO_FAR)", async () => {
    const mixed = await withIntent(FIXTURE_BYTES, atBlock(GLOBAL_TTL_S + 1));
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(2 * HOUR_S);
      expect(rejectionCode(await ingest(mixed.bytes))).toBe("INTENT_TTL_TOO_FAR");
    });
  });

  test("the API serves each offer's own ttlSeconds and expiresAt (field names unchanged)", async () => {
    const short = await signedUnshieldedOffer(atBlock(2 * HOUR_S));
    const long = await signedUnshieldedOffer(atBlock(3 * DAY_S));
    await inRolledBackTransaction(async () => {
      await seedLiveUtxo(short.spend);
      await seedLiveUtxo(long.spend);
      expect(rejectionCode(await ingest(short.bytes))).toBeNull();
      expect(rejectionCode(await ingest(long.bytes))).toBeNull();
      for (const [offer, seconds] of [[short, 2 * HOUR_S], [long, 3 * DAY_S]] as const) {
        const response = await server.inject({ method: "GET", url: `/v1/offers/${offerHashFromBytes(offer.bytes)}` });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.ttlSeconds).toBe(String(seconds));
        expect(new Date(body.computed.expiresAt).getTime()).toBe(offer.ttl.getTime());
      }
    });
  });
});

// ── T4 ────────────────────────────────────────────────────────────────────

describe("T4 — determinism: replay gives an identical verdict and row", () => {
  const replayTwice = async (bytes: Uint8Array, seed: () => Promise<void>) => {
    const runs: Array<{ code: string | null; row: Omit<Row, "id"> | null; insert: unknown }> = [];
    for (let i = 0; i < 2; i++) {
      await inRolledBackTransaction(async () => {
        await seed();
        const observed = await ingest(bytes);
        const row = await offerRow(bytes);
        const insert = observed.queries.find(({ queryIR }) =>
          queryIR === (database.insertOfferFileWithHash as any).queryIR)?.params ?? null;
        runs.push({
          code: rejectionCode(observed),
          row: row
            ? {
              ttl_seconds: row.ttl_seconds,
              metadata_expires_at: new Date(row.metadata_expires_at),
              metadata_created_at: new Date(row.metadata_created_at),
              first_seen_at: new Date(row.first_seen_at),
            }
            : null,
          insert,
        });
      });
    }
    return runs;
  };

  test("an accepted unshielded +3 d offer", async () => {
    const offer = await signedUnshieldedOffer(atBlock(3 * DAY_S));
    const [a, b] = await replayTwice(offer.bytes, () => seedLiveUtxo(offer.spend));
    expect(a!.code).toBeNull();
    expect(a!.row).not.toBeNull();
    expect(b).toEqual(a!);
  });

  test("a refused +14 d + 1 s offer", async () => {
    const offer = await signedUnshieldedOffer(atBlock(GLOBAL_TTL_S + 1));
    const [a, b] = await replayTwice(offer.bytes, () => seedLiveUtxo(offer.spend));
    expect(a!.code).toBe("INTENT_TTL_TOO_FAR");
    expect(b).toEqual(a!);
  });

  test("a mixed offer", async () => {
    const mixed = await withIntent(FIXTURE_BYTES, atBlock(DAY_S));
    const [a, b] = await replayTwice(mixed.bytes, () => seedFixtureRootsAged(2 * HOUR_S));
    expect(a!.code).toBeNull();
    expect(b).toEqual(a!);
  });

  test("the verdict follows the block clock, not the wall clock", async () => {
    // BLOCK_TIME_MS is weeks before the wall clock; an offer whose TTL is
    // block + 2 h is long expired by the wall clock, yet ingestion (block
    // time) indexes it. The API and batcher, which use the wall clock, refuse
    // the same bytes as expired.
    const offer = await signedUnshieldedOffer(atBlock(2 * HOUR_S));
    expect(offer.ttl.getTime()).toBeLessThan(Date.now());
    await inRolledBackTransaction(async () => {
      await seedLiveUtxo(offer.spend);
      expect(rejectionCode(await ingest(offer.bytes))).toBeNull();
    });
    await inRolledBackTransaction(async () => {
      await seedLiveUtxo(offer.spend);
      const response = await server.inject({ method: "POST", url: "/v1/offers", payload: { offer: offer.blob } });
      expect(response.json().error).toBe("INTENT_TTL_EXPIRED");
    });
  });
});

describe("T4 — startup: the node's env resolves reference parameters or fails", () => {
  const child = (env: Record<string, string>, mode = "env") => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "packages/node/test-support/offer-expiry-env-child.ts", mode],
      cwd: REPO_ROOT,
      env: { ...process.env, DB_USER: "postgres", DB_NAME: "postgres", PGLITE_DATA_DIR: "memory://", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };

  test("undeployed and stagenet start (14-day window, 3 h DUST grace)", () => {
    for (const network of ["undeployed", "stagenet"]) {
      const run = child({ MIDNIGHT_NETWORK_ID: network, OFFER_TTL_SECONDS: "", ROOT_WINDOW_SECONDS: "" });
      expect({ network, exitCode: run.exitCode, stderr: run.stderr }).toMatchObject({ network, exitCode: 0 });
      const out = JSON.parse(run.stdout.trim().split("\n").pop()!);
      expect(out).toMatchObject({
        network,
        rootWindowSeconds: GLOBAL_TTL_S,
        offerTtlSeconds: GLOBAL_TTL_S,
        dustGracePeriodSeconds: 10_800,
      });
      expect(run.stderr).not.toContain("OFFER_TTL_SECONDS=");
    }
  });

  test("a network without reference parameters (preview) fails at startup, naming the supported ids", () => {
    const run = child({ MIDNIGHT_NETWORK_ID: "preview" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("no reference ledger parameters for MIDNIGHT_NETWORK_ID='preview'");
    expect(run.stderr).toContain("supported: stagenet, undeployed");
  });

  test("an explicit OFFER_TTL_SECONDS warns and no longer caps offers", () => {
    const run = child({ MIDNIGHT_NETWORK_ID: "undeployed", OFFER_TTL_SECONDS: "600", ROOT_WINDOW_SECONDS: "" }, "ingest");
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toMatchObject({ exitCode: 0 });
    expect(run.stderr).toContain("OFFER_TTL_SECONDS=600 no longer caps offer lifetimes (00056)");
    const out = JSON.parse(run.stdout.trim().split("\n").pop()!);
    expect(out.offerTtlSeconds).toBe(600);
    expect(out.rejected).toBeNull();
    // Before 00056 this offer was capped at block time + 600 s.
    expect(out.inserted.metadata_expires_at).toBe(out.ttl);
    expect(out.inserted.ttl_seconds).toBe(2 * HOUR_S);
  });
});

// ── validate-for-use: the closed v1 wire enum ─────────────────────────────

describe("validate-for-use maps the new codes onto the closed v1 enum", () => {
  test("INTENT_TTL_EXPIRED → EXPIRED (not live); INTENT_TTL_TOO_FAR → PROOF_INVALID", () => {
    expect(canonicalValidatorCode({ ok: false, code: "INTENT_TTL_EXPIRED" })).toBe("EXPIRED");
    expect(canonicalValidatorCode({ ok: false, code: "INTENT_TTL_TOO_FAR" })).toBe("PROOF_INVALID");
    const anchor = { version: "7", atMs: BLOCK_TIME_MS, atIso: new Date(BLOCK_TIME_MS).toISOString() };
    const verdict = checkedVerdict("offer-files-solver-v1", "a".repeat(64), anchor, {
      valid: false,
      live: false,
      computedOfferId: "a".repeat(64),
      status: "live",
      code: "EXPIRED",
      reason: "wellFormed failed: Intent TTL has expired",
    });
    expect(verdict.code).toBe("EXPIRED");
  });
});
