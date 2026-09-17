import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bech32m } from "@scure/base";
import { getMigrations } from "@effectstream/db/version";
import { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
// This file asserts EXACT query counts on the API's connection, so upstream's
// 1 s event-gate poll (0358d9e) must not issue queries underneath it.
process.env["EVENT_GATE_POLL_ENABLED"] = "false";

const priorRateMax = process.env["API_RATE_LIMIT_MAX"];
const priorAllowList = process.env["API_RATE_LIMIT_ALLOWLIST"];
const priorTimeout = process.env["OFFER_FILES_READ_TIMEOUT_MS"];
process.env["API_RATE_LIMIT_MAX"] = "1000";
process.env["API_RATE_LIMIT_ALLOWLIST"] = "127.0.0.1";

const {
  isNullifierSpent,
  migrationTable,
} = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/test-pglite.ts");
const {
  getBlankRefState,
  validateZswapOffer,
} = await import("@zswap-da/validator");
const { offerHashFromBlob } = await import("@zswap-da/offer-guard");
const {
  EXACT_FILES_PROFILE,
  EXACT_FILES_SCHEMA_VERSION,
  MAX_EXACT_FILES_PER_READ,
  parseExactFilesResponse,
} = await import("@zswap-da/solver-core/exact-files-contract");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { eventBus } = await import("./event-bus.ts");
const { validationStateAnchorFromRow } = await import("./offer-validation.ts");
const { MAX_CONCURRENT_EXACT_FILES_READS } = await import("./offer-files-read.ts");
const { OFFER_MAX_BYTES } = await import("./env.ts");
const { resetSyncHealthCacheForTest } = await import("./sync-health.ts");

const FIXTURE = readFileSync(
  join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32"),
  "utf8",
).trim();
const OFFER_ID = offerHashFromBlob(FIXTURE);
const BLOCK_HEIGHT = 42;
const BLOCK_AT = "2026-08-14T12:34:56.000Z";
const BLOCK_AT_MS = Date.parse(BLOCK_AT);
const EXPIRES_AT = "2026-08-14T13:34:56.000Z";
const UNKNOWN_ID = "ab".repeat(32);

const deferred = validateZswapOffer(FIXTURE, {
  refState: getBlankRefState("undeployed"),
  tblock: new Date(BLOCK_AT),
  maxBytes: OFFER_MAX_BYTES,
  crypto: "defer",
});
if (!deferred.ok || !deferred.nullifiers?.[0] || !deferred.inputRoots?.[0]) {
  throw new Error(`valid fixture cannot seed the exact-files read: ${deferred.code}`);
}
const NULLIFIER = deferred.nullifiers[0];
const ROOTS = deferred.inputRoots;

const tamperedBytes = Uint8Array.from(OfferFiles.decode(FIXTURE));
tamperedBytes[Math.floor(tamperedBytes.length * 0.8)]! ^= 0xff;
const TAMPERED = bech32m.encode(
  OFFER_HRP,
  bech32m.toWords(tamperedBytes),
  false,
);
const TAMPERED_ID = offerHashFromBlob(TAMPERED);
const tamperedDeferred = validateZswapOffer(TAMPERED, {
  refState: getBlankRefState("undeployed"),
  tblock: new Date(BLOCK_AT),
  maxBytes: OFFER_MAX_BYTES,
  crypto: "defer",
});
if (!tamperedDeferred.ok) {
  throw new Error(`tampered proof fixture lost its structural shape: ${tamperedDeferred.code}`);
}

async function randomFreePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
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

let pglite: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client>;
let raceClient: InstanceType<typeof pg.Client>;
let server: any;
let apiPort = 0;
let latestApiSocket: any = null;
let originalFetch: typeof fetch = globalThis.fetch;
let batcherSubmissions = 0;
let midnightTip = 100;
let celestiaTip = 200;
let raceArmed = false;
let boundOfferReads = 0;
let proxiedQueryCount = 0;
let heldQueryEntries = 0;
let heldQuery: Promise<void> | null = null;

function holdNextApiQuery(): () => void {
  if (heldQuery !== null) throw new Error("an API query is already held");
  let release!: () => void;
  heldQuery = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

const requestFor = (
  offerIds: string[] = [OFFER_ID],
  profile = EXACT_FILES_PROFILE,
) => ({
  schemaVersion: EXACT_FILES_SCHEMA_VERSION,
  profile,
  offerIds,
});

async function seedRoots(): Promise<void> {
  await raceClient.query("DELETE FROM known_roots");
  for (const root of ROOTS) {
    await raceClient.query(
      `INSERT INTO known_roots(root, height, first_seen_ms, last_seen_ms)
       VALUES ($1, $2, $3, $3)`,
      [root, BLOCK_HEIGHT, BLOCK_AT_MS],
    );
  }
}

async function seedLiveOffer(
  offer = FIXTURE,
  offerId = offerHashFromBlob(offer),
  expiresAt = EXPIRES_AT,
): Promise<void> {
  await raceClient.query("DELETE FROM offer_file_history WHERE offer_hash = $1", [offerId]);
  await raceClient.query("DELETE FROM offer_file WHERE offer_hash = $1", [offerId]);
  await raceClient.query(
    `INSERT INTO offer_file
       (celestia_height, transaction_hex, offer_hash, metadata_created_at,
        metadata_expires_at, first_seen_at, created_at, ttl_seconds)
     VALUES ($1, $2, $3, $4, $5, $4, $4, 3600)`,
    [BLOCK_HEIGHT, offer, offerId, BLOCK_AT, expiresAt],
  );
}

async function removeOffer(offerId = OFFER_ID): Promise<void> {
  await raceClient.query("DELETE FROM offer_file_history WHERE offer_hash = $1", [offerId]);
  await raceClient.query("DELETE FROM offer_file WHERE offer_hash = $1", [offerId]);
}

async function archiveOffer(offerId = OFFER_ID, reason = "TTL"): Promise<void> {
  await raceClient.query(
    `WITH moved AS (
       DELETE FROM offer_file WHERE offer_hash = $1
       RETURNING id, celestia_height, transaction_hex, offer_hash,
         metadata_created_at, metadata_expires_at, first_seen_at, created_at,
         ttl_seconds
     )
     INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, metadata_created_at,
        metadata_expires_at, first_seen_at, created_at, ttl_seconds,
        archive_reason, archived_at)
     SELECT id, celestia_height, transaction_hex, offer_hash,
       metadata_created_at, metadata_expires_at, first_seen_at, created_at,
       ttl_seconds, $2, $3
     FROM moved`,
    [offerId, reason, BLOCK_AT],
  );
}

function isBoundOfferRead(args: unknown[]): boolean {
  const first = args[0] as any;
  const text = typeof first === "string" ? first : String(first?.text ?? "");
  return text.includes("SELECT id, celestia_height, transaction_hex, offer_hash") &&
    text.includes("WHERE offer_hash = $1") &&
    text.includes("FROM offer_file_history");
}

async function readFiles(payload: unknown): Promise<any> {
  return server.inject({
    method: "POST",
    url: "/v1/offers/files",
    payload,
  });
}

/** Assert the response is canonical under the shared contract, INCLUDING the
 * byte-to-identity binding, and hand back its parsed body. */
function expectCanonicalRead(response: any): any {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(parseExactFilesResponse(body, { hashOffer: offerHashFromBlob })).toEqual(body);
  return body;
}

function onlyEntry(response: any): any {
  const body = expectCanonicalRead(response);
  expect(body.files).toHaveLength(1);
  return body.files[0];
}

async function setHealthyPagination(): Promise<void> {
  await raceClient.query(
    `INSERT INTO effectstream.sync_protocol_pagination(protocol_name, page_number, page)
     VALUES ('parallelMidnight', 100, '{}'::jsonb),
            ('parallelCelestia', 200, '{}'::jsonb)
     ON CONFLICT (protocol_name, page_number) DO UPDATE SET page = EXCLUDED.page`,
  );
}

beforeAll(async () => {
  const port = await randomFreePortAtLeast10000();
  pglite = await startPglite(port);
  client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
  });
  raceClient = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  await raceClient.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);

  const ntpStart = Date.now() - BLOCK_HEIGHT * 60_000;
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks
       (block_height, ver, main_chain_block_hash, seed, ms_timestamp,
        effectstream_block_hash)
     VALUES ($1, 1, $2, 'offer-files-read', $3, $4)`,
    [BLOCK_HEIGHT, Buffer.from("01", "hex"), BLOCK_AT, Buffer.from("02", "hex")],
  );
  await client.query(
    `INSERT INTO effectstream.sync_protocol_config_snapshot
       (protocol_name, network_type, immutable_config)
     VALUES ('ntp-validation', 'ntp', $1::jsonb)`,
    [JSON.stringify({ startTime: ntpStart, blockTimeMS: 60_000 })],
  );
  await setHealthyPagination();
  await seedRoots();
  await seedLiveOffer();

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/send-input")) {
      batcherSubmissions += 1;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = String(init?.body ?? "");
    const json = body.includes("header.NetworkHead")
      ? { jsonrpc: "2.0", id: 1, result: { header: { height: String(celestiaTip) } } }
      : { data: { block: { height: midnightTip } } };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const proxiedClient = new Proxy(client as any, {
    get(target, property, receiver) {
      if (property !== "query") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        proxiedQueryCount += 1;
        const gate = heldQuery;
        if (gate !== null) {
          heldQuery = null;
          heldQueryEntries += 1;
          await gate;
        }
        if (raceArmed && isBoundOfferRead(args)) {
          boundOfferReads += 1;
          if (boundOfferReads === 2) {
            raceArmed = false;
            await archiveOffer(OFFER_ID, "TTL");
          }
        }
        return target.query(...args);
      };
    },
  });

  resetSyncHealthCacheForTest();
  server = fastify();
  await apiRouter(server, proxiedClient);
  await server.ready();
  apiPort = await randomFreePortAtLeast10000();
  server.server.on("connection", (socket: any) => {
    latestApiSocket = socket;
  });
  await server.listen({ host: "127.0.0.1", port: apiPort });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (priorRateMax === undefined) delete process.env["API_RATE_LIMIT_MAX"];
  else process.env["API_RATE_LIMIT_MAX"] = priorRateMax;
  if (priorAllowList === undefined) delete process.env["API_RATE_LIMIT_ALLOWLIST"];
  else process.env["API_RATE_LIMIT_ALLOWLIST"] = priorAllowList;
  if (priorTimeout === undefined) delete process.env["OFFER_FILES_READ_TIMEOUT_MS"];
  else process.env["OFFER_FILES_READ_TIMEOUT_MS"] = priorTimeout;
  try {
    await server?.close();
  } finally {
    await raceClient?.end().catch(() => undefined);
    await closeTestPglite(pglite, client);
  }
});

describe("POST /v1/offers/files transport boundary", () => {
  test.serial("rejects non-exact request envelopes with 400", async () => {
    const malformed: unknown[] = [
      null,
      {},
      { ...requestFor(), extra: true },
      { ...requestFor(), schemaVersion: 2 },
      { schemaVersion: EXACT_FILES_SCHEMA_VERSION, profile: EXACT_FILES_PROFILE },
      requestFor([]),
      requestFor([OFFER_ID, OFFER_ID]),
      requestFor([OFFER_ID.toUpperCase()]),
      requestFor(Array.from(
        { length: MAX_EXACT_FILES_PER_READ + 1 },
        (_value, index) => index.toString(16).padStart(64, "0"),
      )),
    ];
    const queriesBefore = proxiedQueryCount;
    for (const payload of malformed) {
      const response = await readFiles(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("VALIDATION");
    }
    // A refused envelope never reaches the database.
    expect(proxiedQueryCount).toBe(queriesBefore);

    const wrongMedia = await server.inject({
      method: "POST",
      url: "/v1/offers/files",
      headers: { "content-type": "application/xml" },
      payload: "<files />",
    });
    expect(wrongMedia.statusCode).toBe(400);
    expect(wrongMedia.json().error).toBe("VALIDATION");
  });

  test.serial("bounds the transport body well below any offer payload", async () => {
    const oversize = await server.inject({
      method: "POST",
      url: "/v1/offers/files",
      headers: { "content-type": "application/json" },
      payload: `{"schemaVersion":1,"profile":"${EXACT_FILES_PROFILE}","offerIds":["${
        "x".repeat(16 * 1024)
      }"]}`,
    });
    expect(oversize.statusCode).toBe(413);
    expect(oversize.json().error).toBe("TOO_LARGE");
  });

  test.serial("the router-wide request budget throttles the read", async () => {
    const previousMax = process.env["API_RATE_LIMIT_MAX"];
    const previousAllow = process.env["API_RATE_LIMIT_ALLOWLIST"];
    process.env["API_RATE_LIMIT_MAX"] = "1";
    process.env["API_RATE_LIMIT_ALLOWLIST"] = "";
    const limited = fastify();
    try {
      await apiRouter(limited, client);
      await limited.ready();
    } finally {
      if (previousMax === undefined) delete process.env["API_RATE_LIMIT_MAX"];
      else process.env["API_RATE_LIMIT_MAX"] = previousMax;
      if (previousAllow === undefined) delete process.env["API_RATE_LIMIT_ALLOWLIST"];
      else process.env["API_RATE_LIMIT_ALLOWLIST"] = previousAllow;
    }
    try {
      const first = await limited.inject({
        method: "POST",
        url: "/v1/offers/files",
        payload: { ...requestFor(), extra: true },
      });
      expect(first.statusCode).toBe(400);
      const throttled = await limited.inject({
        method: "POST",
        url: "/v1/offers/files",
        payload: { ...requestFor(), extra: true },
      });
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json().error).toBe("RATE_LIMITED");
    } finally {
      await limited.close();
    }
  });
});

describe("POST /v1/offers/files exact bytes and stable refusals", () => {
  test.serial("serves the exact indexed bytes for a live valid identity", async () => {
    const entry = onlyEntry(await readFiles(requestFor()));
    expect(entry.offerId).toBe(OFFER_ID);
    // FR-006/FR-008: the bytes are the indexed ones, bound to the identity.
    expect(entry.offer).toBe(FIXTURE);
    expect(offerHashFromBlob(entry.offer)).toBe(OFFER_ID);
    expect(entry.verdict).toMatchObject({
      valid: true,
      live: true,
      status: "live",
      code: "VALID",
      claimedOfferId: OFFER_ID,
      computedOfferId: OFFER_ID,
      stateVersion: String(BLOCK_HEIGHT),
      validatedAt: BLOCK_AT,
      computed: {
        gives: deferred.gives,
        wants: deferred.wants,
        inputNullifiers: deferred.nullifiers,
        expiresAt: EXPIRES_AT,
      },
    });
  });

  test.serial("answers several identities in request order, one entry each", async () => {
    await removeOffer(TAMPERED_ID);
    const body = expectCanonicalRead(
      await readFiles(requestFor([UNKNOWN_ID, OFFER_ID, TAMPERED_ID])),
    );
    expect(body.files.map((file: any) => file.offerId)).toEqual([
      UNKNOWN_ID,
      OFFER_ID,
      TAMPERED_ID,
    ]);
    expect(body.files[0].verdict.code).toBe("NOT_INDEXED");
    expect(body.files[0].offer).toBeUndefined();
    expect(body.files[1].verdict.code).toBe("VALID");
    expect(body.files[1].offer).toBe(FIXTURE);
    expect(body.files[2].verdict.code).toBe("NOT_INDEXED");
    expect(body.files[2].offer).toBeUndefined();
  });

  test.serial("an unknown identity is NOT_INDEXED, never an empty success", async () => {
    await removeOffer();
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "not_indexed",
        code: "NOT_INDEXED",
        computedOfferId: null,
      });
    } finally {
      await seedLiveOffer();
    }
  });

  test.serial("an unknown profile is a stable verdict, not a transport error", async () => {
    const entry = onlyEntry(
      await readFiles(requestFor([OFFER_ID], "future-profile-v2")),
    );
    expect(entry.offer).toBeUndefined();
    expect(entry.verdict).toMatchObject({
      valid: false,
      live: false,
      profile: "future-profile-v2",
      status: "unknown",
      code: "UNSUPPORTED_PROFILE",
      computedOfferId: null,
    });
  });

  test.serial("keeps current liveness independent from stored live lifecycle status", async () => {
    await raceClient.query(
      "INSERT INTO nullifiers(nullifier, height, offer_matched) VALUES ($1, 1, false)",
      [NULLIFIER],
    );
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "live",
        code: "NULLIFIER_SPENT",
      });
    } finally {
      await raceClient.query("DELETE FROM nullifiers WHERE nullifier = $1", [NULLIFIER]);
    }

    await raceClient.query("DELETE FROM known_roots");
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "live",
        code: "ROOT_UNKNOWN",
      });
    } finally {
      await seedRoots();
    }
  });

  test.serial("reports EXPIRED while cleanup still leaves the stored row live", async () => {
    await raceClient.query(
      "UPDATE offer_file SET metadata_expires_at = $1 WHERE offer_hash = $2",
      [new Date(BLOCK_AT_MS - 1), OFFER_ID],
    );
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "live",
        code: "EXPIRED",
      });

      await raceClient.query(
        "UPDATE offer_file SET metadata_expires_at = $1 WHERE offer_hash = $2",
        [new Date(-1), OFFER_ID],
      );
      const noncanonical = await readFiles(requestFor());
      expect(noncanonical.statusCode).toBe(503);
      expect(noncanonical.json().error).toBe("FILES_UNAVAILABLE");
    } finally {
      await raceClient.query(
        "UPDATE offer_file SET metadata_expires_at = $1 WHERE offer_hash = $2",
        [EXPIRES_AT, OFFER_ID],
      );
    }
  });

  test.serial("an archived offer returns its lifecycle state and no bytes", async () => {
    await archiveOffer();
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "expired",
        code: "NOT_LIVE",
      });
    } finally {
      await seedLiveOffer();
    }
  });

  test.serial("reuses canonical crypto: an indexed invalid proof serves no bytes", async () => {
    await seedLiveOffer(TAMPERED, TAMPERED_ID);
    try {
      const entry = onlyEntry(await readFiles(requestFor([TAMPERED_ID])));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: true,
        status: "live",
        code: "PROOF_INVALID",
      });
    } finally {
      await removeOffer(TAMPERED_ID);
    }
  });

  test.serial("an identity whose stored bytes are someone else's serves nothing", async () => {
    // Index corruption: the row keyed by OFFER_ID holds the tampered bytes,
    // which hash to a different identity. The read must refuse rather than
    // return bytes under the requested identity.
    await raceClient.query(
      "UPDATE offer_file SET transaction_hex = $1 WHERE offer_hash = $2",
      [TAMPERED, OFFER_ID],
    );
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        code: "HASH_MISMATCH",
        claimedOfferId: OFFER_ID,
        computedOfferId: TAMPERED_ID,
      });
    } finally {
      await raceClient.query(
        "UPDATE offer_file SET transaction_hex = $1 WHERE offer_hash = $2",
        [FIXTURE, OFFER_ID],
      );
    }
  });
});

describe("POST /v1/offers/files currentness, races, and side effects", () => {
  test.serial("fails unavailable when the backend cannot prove its positions current", async () => {
    resetSyncHealthCacheForTest();
    await raceClient.query("DELETE FROM effectstream.sync_protocol_pagination");
    try {
      const response = await readFiles(requestFor());
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("FILES_UNAVAILABLE");

      // An unsynchronized node must not answer "not indexed" either.
      const unknown = await readFiles(requestFor([UNKNOWN_ID]));
      expect(unknown.statusCode).toBe(503);
    } finally {
      await setHealthyPagination();
      resetSyncHealthCacheForTest();
    }
  });

  test.serial("rechecks uncached aggregate currentness after proof verification", async () => {
    expect(onlyEntry(await readFiles(requestFor())).verdict.code).toBe("VALID");
    midnightTip = 10_000;
    celestiaTip = 20_000;
    try {
      const response = await readFiles(requestFor());
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("FILES_UNAVAILABLE");
    } finally {
      midnightTip = 100;
      celestiaTip = 200;
      resetSyncHealthCacheForTest();
    }
  });

  test.serial("retries a stale health-cache height against the direct committed anchor", async () => {
    expect(onlyEntry(await readFiles(requestFor())).verdict.stateVersion).toBe("42");
    const nextAt = new Date(BLOCK_AT_MS + 60_000).toISOString();
    await raceClient.query(
      `INSERT INTO effectstream.effectstream_blocks
         (block_height, ver, main_chain_block_hash, seed, ms_timestamp,
          effectstream_block_hash)
       VALUES (43, 1, $1, 'offer-files-read-next', $2, $3)`,
      [Buffer.from("03", "hex"), nextAt, Buffer.from("04", "hex")],
    );
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(entry.offer).toBe(FIXTURE);
      expect(entry.verdict).toMatchObject({
        code: "VALID",
        stateVersion: "43",
        validatedAt: nextAt,
      });
    } finally {
      await raceClient.query(
        "DELETE FROM effectstream.effectstream_blocks WHERE block_height = 43",
      );
      resetSyncHealthCacheForTest();
    }
  });

  test.serial("an offer archived between index and read serves no bytes", async () => {
    // The liveness race the spec's edge cases name: live when the read starts,
    // archived by the time the post-proof state read runs.
    await seedLiveOffer();
    boundOfferReads = 0;
    raceArmed = true;
    try {
      const entry = onlyEntry(await readFiles(requestFor()));
      expect(boundOfferReads).toBe(2);
      expect(entry.offer).toBeUndefined();
      expect(entry.verdict).toMatchObject({
        valid: false,
        live: false,
        status: "expired",
        code: "NOT_LIVE",
        stateVersion: String(BLOCK_HEIGHT),
      });
    } finally {
      raceArmed = false;
      await seedLiveOffer();
    }
  });

  const SNAPSHOT_TABLES = [
    "offer_file",
    "offer_file_history",
    "offer_file_tokens",
    "offer_file_tokens_history",
    "offer_file_nullifiers",
    "offer_file_nullifiers_history",
    "offer_file_unshielded_spends",
    "offer_file_unshielded_spends_history",
    "offer_file_commitments",
    "offer_file_commitments_history",
    "nullifiers",
    "created_unshielded",
    "known_roots",
    "offer_rejections",
    "effectstream.rollup_inputs",
    "effectstream.rollup_input_future_block",
    "effectstream.rollup_input_future_timestamp",
    "effectstream.primitive_accounting",
    "effectstream.event",
  ] as const;

  const databaseSnapshot = async (): Promise<Record<string, string>> => {
    const snapshot: Record<string, string> = {};
    for (const table of SNAPSHOT_TABLES) {
      const rows = await raceClient.query(`SELECT * FROM ${table} ORDER BY 1`);
      snapshot[table] = JSON.stringify(rows.rows, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      );
    }
    return snapshot;
  };

  test.serial("served and refused reads alike cause zero DB/event/batcher effects", async () => {
    await seedLiveOffer();
    await seedRoots();
    const before = await databaseSnapshot();
    const beforeBatcher = batcherSubmissions;
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    eventBus.on("app_event", listener);
    try {
      expect(onlyEntry(await readFiles(requestFor())).verdict.code).toBe("VALID");
      const mixed = expectCanonicalRead(await readFiles(requestFor([OFFER_ID, UNKNOWN_ID])));
      expect(mixed.files.map((file: any) => file.verdict.code)).toEqual([
        "VALID",
        "NOT_INDEXED",
      ]);
    } finally {
      eventBus.off("app_event", listener);
    }
    // FR-009: no publication, no Celestia fee, no lifecycle mutation.
    expect(await databaseSnapshot()).toEqual(before);
    expect(batcherSubmissions).toBe(beforeBatcher);
    expect(events).toEqual([]);
  });

  test.serial("concurrent reads past the window are refused, never queued", async () => {
    await seedLiveOffer();
    const before = await databaseSnapshot();
    const responses = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_EXACT_FILES_READS + 8 }, () =>
        readFiles(requestFor())
      ),
    );
    const served = responses.filter((response) => response.statusCode === 200);
    const busy = responses.filter((response) => response.statusCode === 503);
    expect(served.length).toBeGreaterThan(0);
    expect(served.length).toBeLessThanOrEqual(MAX_CONCURRENT_EXACT_FILES_READS);
    expect(served.length + busy.length).toBe(responses.length);
    for (const response of served) {
      expect(onlyEntry(response).verdict.code).toBe("VALID");
    }
    for (const response of busy) {
      expect(response.json().error).toBe("FILES_UNAVAILABLE");
      expect(response.json().reason).toContain("already active");
    }
    expect(await databaseSnapshot()).toEqual(before);
  });

  test.serial("the deadline retains its slot until held read work actually settles", async () => {
    const before = await databaseSnapshot();
    expect(onlyEntry(await readFiles(requestFor())).verdict.code).toBe("VALID");
    process.env["OFFER_FILES_READ_TIMEOUT_MS"] = "100";
    const entriesBefore = heldQueryEntries;
    const release = holdNextApiQuery();
    const first = readFiles(requestFor());
    try {
      // Readiness wait, not a speed assertion: the `expect` below is what
      // proves the query registered. A loaded container needs time to get the
      // in-flight request that far.
      for (let attempt = 0; attempt < 1000 && heldQueryEntries === entriesBefore; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(heldQueryEntries).toBe(entriesBefore + 1);

      const timedOut = await first;
      expect(timedOut.statusCode).toBe(503);
      expect(timedOut.json().error).toBe("FILES_UNAVAILABLE");
      expect(timedOut.json().reason).toContain("timed out");

      // The slot is still held by the physically unfinished read, so the
      // window is one narrower than its nominal size until it settles.
      const countWithPhysicalReadHeld = proxiedQueryCount;
      const afterDeadline = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_EXACT_FILES_READS }, () => readFiles(requestFor())),
      );
      expect(afterDeadline.filter((response) => response.statusCode === 503).length)
        .toBeGreaterThan(0);
      expect(proxiedQueryCount).toBeGreaterThanOrEqual(countWithPhysicalReadHeld);
    } finally {
      release();
      if (priorTimeout === undefined) delete process.env["OFFER_FILES_READ_TIMEOUT_MS"];
      else process.env["OFFER_FILES_READ_TIMEOUT_MS"] = priorTimeout;
    }

    let recovered: any;
    for (let attempt = 0; attempt < 200; attempt++) {
      recovered = await readFiles(requestFor());
      if (recovered.statusCode === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(onlyEntry(recovered).verdict.code).toBe("VALID");
    expect(await databaseSnapshot()).toEqual(before);
  });

  test.serial("a lost response socket cancels further read work", async () => {
    expect(onlyEntry(await readFiles(requestFor())).verdict.code).toBe("VALID");
    const entriesBefore = heldQueryEntries;
    const release = holdNextApiQuery();
    const body = JSON.stringify(requestFor());
    latestApiSocket = null;
    const wireRequest =
      "POST /v1/offers/files HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${apiPort}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: keep-alive\r\n\r\n" +
      body;
    // Keep the socket in a separate process. SIGKILL then forces a real
    // kernel-level peer disconnect rather than only cancelling a fetch
    // consumer while its pooled connection remains open.
    const socketClient = Bun.spawn([
      "bun",
      "-e",
      `const { createConnection } = require("node:net");
       const socket = createConnection({ host: "127.0.0.1", port: ${apiPort} }, () => {
         socket.write(${JSON.stringify(wireRequest)});
       });
       socket.on("error", () => {});
       setInterval(() => {}, 1000);`,
    ], { stdout: "ignore", stderr: "ignore" });

    try {
      for (
        let attempt = 0;
        attempt < 1000 && (heldQueryEntries === entriesBefore || latestApiSocket === null);
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(heldQueryEntries).toBe(entriesBefore + 1);
      expect(latestApiSocket).not.toBeNull();
      const countWithPhysicalReadHeld = proxiedQueryCount;

      const closed = new Promise<void>((resolve) => latestApiSocket.once("close", resolve));
      latestApiSocket.destroy();
      socketClient.kill("SIGKILL");
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("HTTP test socket did not close")), 1_000)
        ),
      ]);
      await socketClient.exited;
      await new Promise((resolve) => setTimeout(resolve, 50));

      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The response-close AbortSignal is checked immediately after the held
      // query. No proof or subsequent state probe may run for the dead client.
      expect(proxiedQueryCount).toBe(countWithPhysicalReadHeld);
    } finally {
      release();
      socketClient.kill("SIGKILL");
    }

    let recovered: any;
    for (let attempt = 0; attempt < 200; attempt++) {
      recovered = await readFiles(requestFor());
      if (recovered.statusCode === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(onlyEntry(recovered).verdict.code).toBe("VALID");
  });
});

test.serial("the DB adapter still issues the canonical nullifier probe", () => {
  expect((isNullifierSpent as any).queryIR.statement).toContain("FROM nullifiers");
});

test.serial("state anchors accept only positive u64 plus nonnegative numeric epoch-ms", () => {
  expect(validationStateAnchorFromRow({
    block_height: "42",
    ms_timestamp: String(BLOCK_AT_MS),
  })).toEqual({ version: "42", atMs: BLOCK_AT_MS, atIso: BLOCK_AT });
  expect(validationStateAnchorFromRow({
    block_height: 42,
    ms_timestamp: new Date(BLOCK_AT_MS),
  }).atIso).toBe(BLOCK_AT);
  expect(() => validationStateAnchorFromRow({
    block_height: "42",
    ms_timestamp: null,
  })).toThrow("timestamp is unavailable");
  expect(() => validationStateAnchorFromRow({
    block_height: "42",
    ms_timestamp: BLOCK_AT,
  })).toThrow("timestamp is unavailable");
  expect(() => validationStateAnchorFromRow({
    block_height: "0",
    ms_timestamp: BLOCK_AT_MS,
  })).toThrow("version is not canonical");
});
