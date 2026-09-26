import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMigrations } from "@effectstream/db/version";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// The root window is the ledger-9 `global_ttl`, 14 days, with no env set
// (network-windows.ts). This file proves that default end to end through the
// production code paths, against a real schema:
//
//   - STM ingestion (`celestia-zswap`): a fill proving against a root 2 h or
//     3 h old — ROOT_UNKNOWN under the old 1 h window — is indexed; a root
//     older than 14 days is rejected ROOT_UNKNOWN.
//   - Offer deadline: the stored expiry (and the scheduled cleanup) is the
//     root's window anchor + 14 days, and ttl_seconds is 14 days.
//   - Prune (`midnight-zswap-root`): roots older than 14 days are deleted,
//     younger ones (2 h, 3 h, 14 d - 1 s) are kept.
//   - The API submit gate and the exact-files read compute their cutoff as
//     `chain now - ROOT_WINDOW_SECONDS` (api.ts, offer-validation.ts); the
//     shared liveness evaluator is driven with that cutoff.
//
// The STM generator is the real one. Each query it yields is executed on
// PGlite exactly as the Effectstream executor does (the yielded queryIR is run
// with its params), inside a transaction that each case rolls back.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const database = await import("@zswap-da/database");
const effectstreamDb = await import("@effectstream/db");
const { migrationTable } = database;
const { closeTestPglite } = await import("../database/test-pglite.ts");
const { eventBus, markBlockCommitted, __resetEventGateForTests } = await import("./event-bus.ts");
const { getBlankRefState, validateZswapOffer } = await import("@zswap-da/validator");
const { bytesToLatin1, offerHashFromBlob } = await import("@zswap-da/offer-guard");
const { gameStateTransitions } = await import("./state-machine.ts");
const { evaluateOfferLivenessFromDatabase } = await import("./offer-liveness.ts");
const { ROOT_WINDOW_SECONDS, OFFER_TTL_SECONDS } = await import("./env.ts");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;

const HOUR_MS = 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * 24 * HOUR_MS;
const BLOCK_TIME_MS = Date.parse("2026-08-14T12:00:00.000Z");
const TIP_HEIGHT = 1_000;

const FIXTURE_PATH = join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32");
const VALID_OFFER = readFileSync(FIXTURE_PATH, "utf8").trim();
const VALID_BYTES = OfferFiles.decode(VALID_OFFER);
const OFFER_ID = offerHashFromBlob(VALID_OFFER);
const probe = validateZswapOffer(VALID_OFFER, {
  refState: getBlankRefState("undeployed"),
  tblock: new Date(BLOCK_TIME_MS),
  maxBytes: 1024 * 1024,
  crypto: "defer",
});
if (!probe.ok || !probe.inputRoots?.[0]) {
  throw new Error(`committed valid-offer fixture is unusable: ${probe.code ?? "unknown"}`);
}
const INPUT_ROOTS = probe.inputRoots;
/** A different root at the chain tip, so the fixture's roots are never "current". */
const TIP_ROOT = "ab".repeat(32);

// Every prepared statement the STM can yield, keyed by its queryIR — the
// executor only ever sees `[queryIR, params]`.
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

beforeAll(async () => {
  const port = await randomFreePortAtLeast10000();
  pglite = await startPglite(port);
  client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);
});

afterAll(async () => {
  await closeTestPglite(pglite, client);
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

async function seedRoot(root: string, height: number, lastSeenMs: number): Promise<void> {
  await client!.query(
    `INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms) VALUES ($1, $2, $3, $3)`,
    [root, height, lastSeenMs],
  );
}

/** The chain tip plus the fixture's proof roots, all last seen `ageMs` ago. */
async function seedFixtureRootsAged(ageMs: number): Promise<void> {
  await seedRoot(TIP_ROOT, TIP_HEIGHT, BLOCK_TIME_MS);
  let height = TIP_HEIGHT - 10;
  for (const root of INPUT_ROOTS) await seedRoot(root, height--, BLOCK_TIME_MS - ageMs);
}

/** Run `body` in a transaction that is always rolled back, so cases are independent. */
async function inRolledBackTransaction(body: () => Promise<void>): Promise<void> {
  await client!.query("BEGIN");
  try {
    await body();
  } finally {
    await client!.query("ROLLBACK");
  }
}

const ingest = () =>
  driveStm(JSON.stringify(["celestia-zswap", { suppliedValue: bytesToLatin1(VALID_BYTES) }]), 77);

const rejectionCode = (o: Observation): string | null =>
  o.events.find((e) => e.type === "offer_rejected")?.code ?? null;

const rootGateCutoffs = (o: Observation): number[] =>
  o.queries
    .filter(({ queryIR }) => queryIR === (database.isKnownRootLive as any).queryIR)
    .map(({ params }) => Number(params.cutoff_ms));

describe("the default root window is the 14-day global_ttl", () => {
  test("env.ts resolves ROOT_WINDOW_SECONDS and OFFER_TTL_SECONDS to 1209600 with no env set", () => {
    expect(process.env["ROOT_WINDOW_SECONDS"]).toBeUndefined();
    expect(process.env["OFFER_TTL_SECONDS"]).toBeUndefined();
    expect(ROOT_WINDOW_SECONDS).toBe(1_209_600);
    expect(OFFER_TTL_SECONDS).toBe(1_209_600);
  });
});

describe("STM ingestion validates proof roots against 14 days", () => {
  for (const [label, ageMs] of [
    ["2 h", 2 * HOUR_MS],
    ["3 h", 3 * HOUR_MS],
    ["14 days - 1 s", FOURTEEN_DAYS_MS - 1_000],
  ] as const) {
    test(`a fill proving against a root ${label} old is indexed, expiring at anchor + 14 days`, async () => {
      await inRolledBackTransaction(async () => {
        await seedFixtureRootsAged(ageMs);
        const observed = await ingest();

        expect(rejectionCode(observed)).toBeNull();
        expect(observed.events.some((e) => e.type === "offer_indexed" && e.offerHash === OFFER_ID)).toBe(true);
        // The STM's root gate used the 14-day cutoff.
        const cutoffs = rootGateCutoffs(observed);
        expect(cutoffs.length).toBeGreaterThan(0);
        for (const cutoff of cutoffs) expect(cutoff).toBe(BLOCK_TIME_MS - FOURTEEN_DAYS_MS);

        // Deadline: the root's window anchor (its last-seen time) + 14 days,
        // under the 14-day OFFER_TTL ceiling; the cleanup is scheduled there.
        const expectedExpiryMs = BLOCK_TIME_MS - ageMs + FOURTEEN_DAYS_MS;
        const row = (await client!.query(
          `SELECT id, ttl_seconds, metadata_expires_at FROM offer_file WHERE offer_hash = $1`,
          [OFFER_ID],
        )).rows[0];
        expect(Number(row.ttl_seconds)).toBe(1_209_600);
        expect(new Date(row.metadata_expires_at).getTime()).toBe(expectedExpiryMs);
        const scheduled = (await client!.query(
          `SELECT f.future_ms_timestamp
             FROM effectstream.rollup_inputs i
             JOIN effectstream.rollup_input_future_timestamp f ON f.id = i.id
            WHERE i.input_data = $1`,
          [JSON.stringify(["zswap-ttl-cleanup", Number(row.id)])],
        )).rows;
        expect(scheduled).toHaveLength(1);
        expect(new Date(scheduled[0].future_ms_timestamp).getTime()).toBe(expectedExpiryMs);
      });
    });
  }

  test("a fill proving against a root older than 14 days is rejected ROOT_UNKNOWN and not indexed", async () => {
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(FOURTEEN_DAYS_MS + 1_000);
      const observed = await ingest();

      expect(rejectionCode(observed)).toBe("ROOT_UNKNOWN");
      expect(rootGateCutoffs(observed)[0]).toBe(BLOCK_TIME_MS - FOURTEEN_DAYS_MS);
      const rows = (await client!.query(`SELECT 1 FROM offer_file WHERE offer_hash = $1`, [OFFER_ID])).rows;
      expect(rows).toHaveLength(0);
    });
  });
});

describe("known_roots prune keeps 14 days", () => {
  test("a new root prunes roots older than 14 days and keeps the 2 h, 3 h and 14 d - 1 s roots", async () => {
    await inRolledBackTransaction(async () => {
      const aged = {
        h2: ["c2".repeat(32), 2 * HOUR_MS],
        h3: ["c3".repeat(32), 3 * HOUR_MS],
        almost14d: ["cd".repeat(32), FOURTEEN_DAYS_MS - 1_000],
        past14d: ["ce".repeat(32), FOURTEEN_DAYS_MS + 1_000],
        d15: ["cf".repeat(32), 15 * 24 * HOUR_MS],
      } as const;
      await seedRoot(TIP_ROOT, TIP_HEIGHT, BLOCK_TIME_MS - 6_000);
      let height = TIP_HEIGHT - 1;
      for (const [root, ageMs] of Object.values(aged)) await seedRoot(root, height--, BLOCK_TIME_MS - ageMs);

      const newRoot = "d0".repeat(32);
      const observed = await driveStm(JSON.stringify(["midnight-zswap-root", { root: newRoot }]), TIP_HEIGHT + 1);

      const prunes = observed.queries.filter(({ queryIR }) => queryIR === (database.pruneKnownRoots as any).queryIR);
      expect(prunes).toHaveLength(1);
      expect(Number(prunes[0]!.params.cutoff_ms)).toBe(BLOCK_TIME_MS - FOURTEEN_DAYS_MS);

      const remaining = new Set(
        (await client!.query(`SELECT root FROM known_roots`)).rows.map((r: { root: string }) => r.root),
      );
      expect(remaining.has(newRoot)).toBe(true);
      expect(remaining.has(TIP_ROOT)).toBe(true);
      expect(remaining.has(aged.h2[0])).toBe(true);
      expect(remaining.has(aged.h3[0])).toBe(true);
      expect(remaining.has(aged.almost14d[0])).toBe(true);
      expect(remaining.has(aged.past14d[0])).toBe(false);
      expect(remaining.has(aged.d15[0])).toBe(false);
    });
  });
});

describe("API submit gate and exact-files read use the same 14-day cutoff", () => {
  // api.ts and offer-validation.ts both call the shared evaluator with
  // `chain now - ROOT_WINDOW_SECONDS * 1000`.
  const gateCutoff = async () => BLOCK_TIME_MS - ROOT_WINDOW_SECONDS * 1000;

  test("a 3 h old proof root is live", async () => {
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(3 * HOUR_MS);
      const verdict = await evaluateOfferLivenessFromDatabase(probe, client, { getRootCutoffMs: gateCutoff });
      expect(verdict.ok).toBe(true);
    });
  });

  test("a proof root older than 14 days is ROOT_UNKNOWN", async () => {
    await inRolledBackTransaction(async () => {
      await seedFixtureRootsAged(FOURTEEN_DAYS_MS + 1_000);
      const verdict = await evaluateOfferLivenessFromDatabase(probe, client, { getRootCutoffMs: gateCutoff });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("ROOT_UNKNOWN");
    });
  });
});
