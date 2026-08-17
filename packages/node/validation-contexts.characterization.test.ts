import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bech32m } from "@scure/base";
import { getMigrations } from "@effectstream/db/version";
import { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// V0 characterization: these tests deliberately exercise the three current
// production contexts before V1 extracts a reusable service. Keep the shared
// fixture/state matrix explicit: submission dedup and validate-for-use have
// opposite semantics for an exact, already-indexed live offer.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
process.env["POST_COMMIT_EVENT_BRIDGE_ENABLED"] = "false";

const {
  createAppInputSavepoint,
  deleteRejectedAccountingRow,
  getEarliestRootFirstSeen,
  getOfferStatusByHash,
  insertOfferFileWithHash,
  isKnownRootLive,
  isNullifierSpent,
  migrationTable,
  recordOfferRejection,
  releaseAppInputSavepoint,
} = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/test-pglite.ts");
const { getBlankRefState, validateZswapOffer } = await import("@zswap-da/validator");
const {
  bytesToLatin1,
  offerHashFromBlob,
} = await import("@zswap-da/offer-guard");
const { ZswapCelestiaAdapter } = await import("../batcher/celestia.ts");
const { apiRouter } = await import("./api.ts");
const { gameStateTransitions } = await import("./state-machine.ts");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "validator",
  "fixtures",
  "valid-offer.bech32",
);
const VALID_OFFER = readFileSync(FIXTURE_PATH, "utf8").trim();
const VALID_BYTES = OfferFiles.decode(VALID_OFFER);
const OFFER_ID = offerHashFromBlob(VALID_OFFER);
const BLOCK_TIME_MS = Date.parse("2026-08-14T12:00:00.000Z");
const JUNK_BYTES = new Uint8Array(64).fill(7);
const DECODABLE_JUNK = bech32m.encode(
  OFFER_HRP,
  bech32m.toWords(JUNK_BYTES),
  false,
);

const probe = validateZswapOffer(VALID_OFFER, {
  refState: getBlankRefState("undeployed"),
  tblock: new Date(BLOCK_TIME_MS),
  maxBytes: 1024 * 1024,
  crypto: "defer",
});
if (!probe.ok || !probe.nullifiers?.[0] || !probe.inputRoots?.[0]) {
  throw new Error(`committed valid-offer fixture is unusable: ${probe.code ?? "unknown"}`);
}
const NULLIFIER = probe.nullifiers[0];
const INPUT_ROOTS = probe.inputRoots;

/**
 * Frozen V0 prediction matrix. The endpoint column is the v1 contract target,
 * not an assertion that the not-yet-implemented route exists.
 */
const EXPECTED_MATRIX = {
  transportGarbage: {
    batcher: "BAD_ENCODING",
    api: "BAD_ENCODING",
    stm: "BAD_DESERIALIZE",
    validateForUse: "BAD_ENCODING",
  },
  decodableJunk: {
    batcher: "BAD_DESERIALIZE",
    api: "BAD_DESERIALIZE",
    stm: "BAD_DESERIALIZE",
    validateForUse: "BAD_DESERIALIZE",
  },
  liveUnindexed: {
    batcher: "VALID",
    api: "FORWARDED",
    stm: "INDEXED",
    validateForUse: "NOT_INDEXED",
  },
  indexedLiveDuplicate: {
    batcher: "DUPLICATE_OFFER",
    api: "DUPLICATE_OFFER",
    stm: "DUPLICATE_OFFER",
    validateForUse: "VALID",
  },
  spent: {
    // The batcher has no authoritative chain-state database and therefore
    // cannot distinguish this row from live at its pre-fee boundary.
    batcher: "VALID",
    api: "NULLIFIER_SPENT",
    stm: "NULLIFIER_SPENT",
    validateForUse: "NULLIFIER_SPENT",
  },
  unknownRoot: {
    batcher: "VALID",
    api: "ROOT_UNKNOWN",
    stm: "ROOT_UNKNOWN",
    validateForUse: "ROOT_UNKNOWN",
  },
} as const;

function adapter(): InstanceType<typeof ZswapCelestiaAdapter> {
  return new ZswapCelestiaAdapter(
    {
      rpcUrl: "http://127.0.0.1:1",
      namespace: "000000000000deadbeef",
      authToken: "",
      network: "devnet",
      fee: 2000,
      gasLimit: 100000,
      syncProtocolName: "parallelCelestia",
    } as any,
    "undeployed",
  );
}

const batcherInput = (offer: string) => ({
  address: "characterization",
  addressType: 0,
  input: offer,
  timestamp: "1",
});

async function markPublished(
  instance: InstanceType<typeof ZswapCelestiaAdapter>,
  offer: string,
): Promise<void> {
  (instance as any).rpcCall = async () => ({ txhash: "fixture-tx", height: 7 });
  await instance.submitBatch(
    {
      blob: { namespace: "fixture", data: "ignored", share_version: 0 },
      rawData: offer,
      inputKey: "characterization:1",
    } as any,
    2000n,
  );
}

type StmState = "unindexed" | "indexed-live" | "spent" | "root-unknown";
type StmObservation = {
  queries: Array<{ queryIR: unknown; params: unknown }>;
  events: Array<Record<string, unknown>>;
};

/** Drive the real production STM generator while supplying deterministic DB
 * results at its World.resolve boundary. This observes the actual transition
 * ordering without copying its validation ladder into the test. */
function driveStm(rawBytes: Uint8Array, state: StmState): StmObservation {
  const events: Array<Record<string, unknown>> = [];
  const queries: Array<{ queryIR: unknown; params: unknown }> = [];
  const generator = gameStateTransitions(1, {
    blockHeight: 77,
    blockTimestamp: BLOCK_TIME_MS,
    conciseInput: JSON.stringify([
      "celestia-zswap",
      { suppliedValue: bytesToLatin1(rawBytes) },
    ]),
    randomGenerator: {} as any,
    emit: (_event: unknown, payload: { eventJson?: string }) => {
      if (typeof payload?.eventJson === "string") {
        events.push(JSON.parse(payload.eventJson));
      }
    },
  } as any);

  let next = generator.next();
  while (!next.done) {
    const yielded = next.value as [unknown, unknown];
    if (!Array.isArray(yielded) || yielded.length !== 2) {
      throw new Error(`unexpected STM yield: ${String(yielded)}`);
    }
    const [queryIR, params] = yielded;
    queries.push({ queryIR, params });

    let result: unknown[] = [];
    if (queryIR === (getOfferStatusByHash as any).queryIR) {
      result = state === "indexed-live"
        ? [{ id: 91, status: "live", archive_reason: null }]
        : [];
    } else if (queryIR === (isNullifierSpent as any).queryIR) {
      result = state === "spent" ? [{ spent: 1 }] : [];
    } else if (queryIR === (isKnownRootLive as any).queryIR) {
      result = state === "root-unknown" ? [] : [{ present: 1 }];
    } else if (queryIR === (getEarliestRootFirstSeen as any).queryIR) {
      result = [{ first_seen_ms: BLOCK_TIME_MS, last_seen_ms: BLOCK_TIME_MS }];
    } else if (queryIR === (insertOfferFileWithHash as any).queryIR) {
      result = [{ id: 92 }];
    }
    next = generator.next(result);
  }

  return { queries, events };
}

function rejectionCode(observation: StmObservation): string | null {
  const rejected = observation.events.find((event) => event.type === "offer_rejected");
  return typeof rejected?.code === "string" ? rejected.code : null;
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
  client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);

  for (const root of INPUT_ROOTS) {
    await client.query(
      `INSERT INTO known_roots(root, height, last_seen_ms, first_seen_ms)
       VALUES ($1, 1, $2, $2)`,
      [root, BLOCK_TIME_MS],
    );
  }
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks
       (block_height, ver, main_chain_block_hash, seed, ms_timestamp, effectstream_block_hash)
     VALUES (1, 1, $1, 'validation-contexts', $2, $3)`,
    [Buffer.from("01", "hex"), new Date(BLOCK_TIME_MS), Buffer.from("02", "hex")],
  );

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/send-input")) batcherSubmissions += 1;
    return new Response(JSON.stringify({
      success: true,
      message: "Input processed successfully",
      inputsProcessed: 1,
      transactionHash: "characterization-tx",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

describe("V0 shared validation-context matrix", () => {
  test("batcher pre-fee admission has local dedup but no indexed liveness", async () => {
    const malformed = adapter().validateInput(
      batcherInput("definitely-not-an-offer") as any,
    );
    expect(malformed.error).toContain(EXPECTED_MATRIX.transportGarbage.batcher);

    const junk = adapter().validateInput(batcherInput(DECODABLE_JUNK) as any);
    expect(junk.error).toContain(EXPECTED_MATRIX.decodableJunk.batcher);

    const live = adapter().validateInput(batcherInput(VALID_OFFER) as any);
    expect(live).toEqual({ valid: true });

    // The identical proven bytes remain valid at this context even when the
    // authoritative backend state says their nullifier is spent: this adapter
    // has no DB/indexed liveness input at all.
    const spentButInvisibleHere = adapter().validateInput(
      batcherInput(VALID_OFFER) as any,
    );
    expect(spentButInvisibleHere.valid).toBe(true);

    const published = adapter();
    await markPublished(published, VALID_OFFER);
    const duplicate = published.validateInput(batcherInput(VALID_OFFER) as any);
    expect(duplicate.error).toContain(EXPECTED_MATRIX.indexedLiveDuplicate.batcher);
  });

  test("API submission rejects indexed duplicates/liveness before forwarding", async () => {
    const inject = (offer: string) => server.inject({
      method: "POST",
      url: "/v1/offers",
      payload: { offer },
    });

    let response = await inject("definitely-not-an-offer");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(EXPECTED_MATRIX.transportGarbage.api);

    response = await inject(DECODABLE_JUNK);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(EXPECTED_MATRIX.decodableJunk.api);

    response = await inject(VALID_OFFER);
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
    expect(batcherSubmissions).toBe(1);

    await client!.query(
      `INSERT INTO offer_file(celestia_height, transaction_hex, offer_hash, ttl_seconds)
       VALUES (77, $1, $2, 3600)`,
      [VALID_OFFER, OFFER_ID],
    );
    response = await inject(VALID_OFFER);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(EXPECTED_MATRIX.indexedLiveDuplicate.api);
    expect(batcherSubmissions).toBe(1);

    await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [OFFER_ID]);
    await client!.query(
      `INSERT INTO nullifiers(nullifier, height, offer_matched)
       VALUES ($1, 77, false)`,
      [NULLIFIER],
    );
    response = await inject(VALID_OFFER);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(EXPECTED_MATRIX.spent.api);
    expect(batcherSubmissions).toBe(1);

    await client!.query("DELETE FROM nullifiers WHERE nullifier = $1", [NULLIFIER]);
    await client!.query("DELETE FROM known_roots");
    response = await inject(VALID_OFFER);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(EXPECTED_MATRIX.unknownRoot.api);
    expect(batcherSubmissions).toBe(1);
  });

  test("STM ingestion uses raw bytes and rejects duplicate/liveness before crypto", () => {
    const malformed = driveStm(new TextEncoder().encode("definitely-not-an-offer"), "unindexed");
    expect(rejectionCode(malformed)).toBe(EXPECTED_MATRIX.transportGarbage.stm);
    expect(malformed.queries[0]?.queryIR).toBe((createAppInputSavepoint as any).queryIR);
    expect(malformed.queries.some(({ queryIR }) =>
      queryIR === (deleteRejectedAccountingRow as any).queryIR)).toBe(true);
    expect(malformed.queries.some(({ queryIR }) =>
      queryIR === (recordOfferRejection as any).queryIR)).toBe(true);
    expect(malformed.queries.at(-1)?.queryIR).toBe((releaseAppInputSavepoint as any).queryIR);

    const junk = driveStm(JUNK_BYTES, "unindexed");
    expect(rejectionCode(junk)).toBe(EXPECTED_MATRIX.decodableJunk.stm);

    const duplicate = driveStm(VALID_BYTES, "indexed-live");
    expect(rejectionCode(duplicate)).toBe(EXPECTED_MATRIX.indexedLiveDuplicate.stm);
    expect(duplicate.queries.some(({ queryIR }) =>
      queryIR === (isNullifierSpent as any).queryIR)).toBe(false);

    const spent = driveStm(VALID_BYTES, "spent");
    expect(rejectionCode(spent)).toBe(EXPECTED_MATRIX.spent.stm);
    expect(spent.queries.some(({ queryIR }) =>
      queryIR === (isKnownRootLive as any).queryIR)).toBe(false);

    const unknownRoot = driveStm(VALID_BYTES, "root-unknown");
    expect(rejectionCode(unknownRoot)).toBe(EXPECTED_MATRIX.unknownRoot.stm);

    const accepted = driveStm(VALID_BYTES, "unindexed");
    expect(rejectionCode(accepted)).toBeNull();
    expect(accepted.events.some((event) =>
      event.type === "offer_indexed" && event.offerHash === OFFER_ID)).toBe(true);
  });

  test("validate-for-use predictions preserve the required semantic inversion", () => {
    expect(EXPECTED_MATRIX.liveUnindexed.validateForUse).toBe("NOT_INDEXED");
    expect(EXPECTED_MATRIX.indexedLiveDuplicate.validateForUse).toBe("VALID");
    expect(EXPECTED_MATRIX.spent.validateForUse).toBe("NULLIFIER_SPENT");
    expect(EXPECTED_MATRIX.unknownRoot.validateForUse).toBe("ROOT_UNKNOWN");
  });
});

function productionTypescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

test("guardOffer is not called by a production package", () => {
  const repositoryRoot = resolve(import.meta.dir, "..", "..");
  const callers = ["node", "batcher", "solver", "solver-core"]
    .flatMap((name) => productionTypescriptFiles(join(repositoryRoot, "packages", name)))
    .filter((path) => /\bguardOffer\b/.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path));

  expect(callers).toEqual([]);
  const guardSource = readFileSync(
    join(repositoryRoot, "packages", "offer-guard", "mod.ts"),
    "utf8",
  );
  expect(guardSource).toContain("export async function guardOffer(");
});
