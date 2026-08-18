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

const AUTH_SECRET = "validation-fixture-secret-00001";
const priorAuthSecret = process.env["SOLVER_LEVELS_AUTH_SECRET"];
const priorAuthKeys = process.env["SOLVER_LEVELS_AUTH_KEYS"];
const priorRateMax = process.env["API_RATE_LIMIT_MAX"];
const priorAllowList = process.env["API_RATE_LIMIT_ALLOWLIST"];
const priorTimeout = process.env["OFFER_VALIDATION_TIMEOUT_MS"];
process.env["SOLVER_LEVELS_AUTH_SECRET"] = AUTH_SECRET;
delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
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
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  parseOfferValidationVerdict,
} = await import("@zswap-da/solver-core/validation-contract");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { eventBus } = await import("./event-bus.ts");
const {
  offerValidationBodyLimit,
  validationStateAnchorFromRow,
} = await import("./offer-validation.ts");
const {
  OFFER_MAX_BYTES,
} = await import("./env.ts");
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
const AUTH = { authorization: `Bearer ${AUTH_SECRET}` };

const deferred = validateZswapOffer(FIXTURE, {
  refState: getBlankRefState("undeployed"),
  tblock: new Date(BLOCK_AT),
  maxBytes: OFFER_MAX_BYTES,
  crypto: "defer",
});
if (!deferred.ok || !deferred.nullifiers?.[0] || !deferred.inputRoots?.[0]) {
  throw new Error(`valid fixture cannot seed validation API: ${deferred.code}`);
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
  offer = FIXTURE,
  offerId = offerHashFromBlob(offer),
  profile = OFFER_VALIDATION_PROFILE,
) => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile,
  offerId,
  offer,
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

async function postValidation(
  payload: unknown,
  headers: Record<string, string> = AUTH,
): Promise<any> {
  return server.inject({
    method: "POST",
    url: "/v1/offers/validate",
    headers,
    payload,
  });
}

function expectCanonicalVerdict(response: any): any {
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(parseOfferValidationVerdict(body)).toEqual(body);
  return body;
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
     VALUES ($1, 1, $2, 'offer-validation', $3, $4)`,
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
  if (priorAuthSecret === undefined) delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
  else process.env["SOLVER_LEVELS_AUTH_SECRET"] = priorAuthSecret;
  if (priorAuthKeys === undefined) delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
  else process.env["SOLVER_LEVELS_AUTH_KEYS"] = priorAuthKeys;
  if (priorRateMax === undefined) delete process.env["API_RATE_LIMIT_MAX"];
  else process.env["API_RATE_LIMIT_MAX"] = priorRateMax;
  if (priorAllowList === undefined) delete process.env["API_RATE_LIMIT_ALLOWLIST"];
  else process.env["API_RATE_LIMIT_ALLOWLIST"] = priorAllowList;
  if (priorTimeout === undefined) delete process.env["OFFER_VALIDATION_TIMEOUT_MS"];
  else process.env["OFFER_VALIDATION_TIMEOUT_MS"] = priorTimeout;
  try {
    await server?.close();
  } finally {
    await raceClient?.end().catch(() => undefined);
    await closeTestPglite(pglite, client);
  }
});

describe("POST /v1/offers/validate transport/auth boundary", () => {
  test.serial("requires configured solver bearer auth independently of levels flags", async () => {
    let response = await postValidation(requestFor(), {});
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");

    response = await postValidation(requestFor(), { authorization: "Bearer wrong-secret" });
    expect(response.statusCode).toBe(401);

    response = await postValidation(
      { ...requestFor(), offer: "x".repeat(offerValidationBodyLimit() + 1) },
      {},
    );
    expect(response.statusCode).toBe(401);

    delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
    try {
      response = await postValidation(requestFor());
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("VALIDATION_DISABLED");
    } finally {
      process.env["SOLVER_LEVELS_AUTH_SECRET"] = AUTH_SECRET;
    }
  });

  test.serial("rejects non-exact request envelopes with 400", async () => {
    let response = await postValidation({ ...requestFor(), extra: true });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION");

    response = await server.inject({
      method: "POST",
      url: "/v1/offers/validate",
      headers: { ...AUTH, "content-type": "application/xml" },
      payload: "<validation />",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("VALIDATION");
  });

  test.serial("bounds decoded offers as a domain verdict and larger transports as 413", async () => {
    const maxEncodedChars = Math.ceil((OFFER_MAX_BYTES * 8) / 5) + OFFER_HRP.length + 7;
    const domainOversize = `${OFFER_HRP}1${"q".repeat(maxEncodedChars)}`;
    let response = await postValidation({
      ...requestFor(),
      offer: domainOversize,
    });
    expect(expectCanonicalVerdict(response).code).toBe("TOO_LARGE");

    const transportOversize = "x".repeat(offerValidationBodyLimit() + 1);
    response = await postValidation({ ...requestFor(), offer: transportOversize });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe("TOO_LARGE");

    const submissionTransportOversize = "x".repeat(Math.ceil(OFFER_MAX_BYTES * 2) + 1);
    const submission = await server.inject({
      method: "POST",
      url: "/v1/offers",
      payload: { offer: submissionTransportOversize },
    });
    expect(submission.statusCode).toBe(413);
    expect(submission.json().error).toBe("BAD_REQUEST");
  });
});

describe("POST /v1/offers/validate frozen domain contract", () => {
  test.serial("returns the canonical unsupported-profile fixture without decoding content", async () => {
    const fixture = JSON.parse(readFileSync(
      join(import.meta.dir, "..", "solver-core", "fixtures", "offer-validation", "v1",
        "verdict-unsupported-profile.json"),
      "utf8",
    ));
    const request = {
      schemaVersion: 1,
      profile: "future-profile-v2",
      offerId: "ab".repeat(32),
      offer: "swapoffer1fixture",
    };
    expect((await postValidation(request)).json()).toEqual(fixture);
  });

  test.serial("preserves canonical structural codes and exact decoded-byte hash binding", async () => {
    let response = await postValidation({
      ...requestFor(),
      offer: "definitely-not-an-offer",
    });
    let verdict = expectCanonicalVerdict(response);
    expect(verdict).toMatchObject({
      code: "BAD_ENCODING",
      computedOfferId: null,
      status: "unknown",
      live: false,
    });

    const junk = bech32m.encode(
      OFFER_HRP,
      bech32m.toWords(new Uint8Array(64).fill(9)),
      false,
    );
    response = await postValidation(requestFor(junk));
    verdict = expectCanonicalVerdict(response);
    expect(verdict.code).toBe("BAD_DESERIALIZE");
    expect(verdict.computedOfferId).toBe(offerHashFromBlob(junk));

    response = await postValidation(requestFor(FIXTURE, "ab".repeat(32)));
    verdict = expectCanonicalVerdict(response);
    expect(verdict).toMatchObject({
      code: "HASH_MISMATCH",
      claimedOfferId: "ab".repeat(32),
      computedOfferId: OFFER_ID,
    });
  });

  test.serial("requires exact indexed presence but treats that presence as VALID, not duplicate", async () => {
    await removeOffer();
    try {
      const unindexed = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(unindexed).toMatchObject({
        valid: false,
        live: false,
        status: "not_indexed",
        code: "NOT_INDEXED",
        computedOfferId: OFFER_ID,
      });
    } finally {
      await seedLiveOffer();
    }

    const live = expectCanonicalVerdict(await postValidation(requestFor()));
    expect(live).toMatchObject({
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

    await raceClient.query(
      "UPDATE offer_file SET transaction_hex = $1 WHERE offer_hash = $2",
      [TAMPERED, OFFER_ID],
    );
    try {
      const mismatchedIndex = await postValidation(requestFor());
      expect(mismatchedIndex.statusCode).toBe(503);
      expect(mismatchedIndex.json().error).toBe("VALIDATION_UNAVAILABLE");
    } finally {
      await raceClient.query(
        "UPDATE offer_file SET transaction_hex = $1 WHERE offer_hash = $2",
        [FIXTURE, OFFER_ID],
      );
    }
  });

  test.serial("keeps current liveness independent from stored live lifecycle status", async () => {
    await raceClient.query(
      "INSERT INTO nullifiers(nullifier, height, offer_matched) VALUES ($1, 1, false)",
      [NULLIFIER],
    );
    try {
      const spent = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(spent).toMatchObject({
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
      const staleRoot = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(staleRoot).toMatchObject({
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
      const expired = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(expired).toMatchObject({
        valid: false,
        live: false,
        status: "live",
        code: "EXPIRED",
      });
      await raceClient.query(
        "UPDATE offer_file SET metadata_expires_at = $1 WHERE offer_hash = $2",
        [new Date(-1), OFFER_ID],
      );
      const noncanonical = await postValidation(requestFor());
      expect(noncanonical.statusCode).toBe(503);
      expect(noncanonical.json().error).toBe("VALIDATION_UNAVAILABLE");
    } finally {
      await raceClient.query(
        "UPDATE offer_file SET metadata_expires_at = $1 WHERE offer_hash = $2",
        [EXPIRES_AT, OFFER_ID],
      );
    }
  });

  test.serial("returns stored archived lifecycle state without proof or duplicate rejection", async () => {
    await archiveOffer();
    try {
      const archived = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(archived).toMatchObject({
        valid: false,
        live: false,
        status: "expired",
        code: "NOT_LIVE",
      });
    } finally {
      await seedLiveOffer();
    }
  });

  test.serial("reuses canonical crypto while retaining independent live/status axes", async () => {
    await seedLiveOffer(TAMPERED, TAMPERED_ID);
    try {
      const proofInvalid = expectCanonicalVerdict(
        await postValidation(requestFor(TAMPERED, TAMPERED_ID)),
      );
      expect(proofInvalid).toMatchObject({
        valid: false,
        live: true,
        status: "live",
        code: "PROOF_INVALID",
      });
    } finally {
      await removeOffer(TAMPERED_ID);
    }
  });
});

describe("POST /v1/offers/validate currentness, race, and side effects", () => {
  test.serial("fails unavailable when the backend cannot prove all sync positions current", async () => {
    resetSyncHealthCacheForTest();
    await raceClient.query("DELETE FROM effectstream.sync_protocol_pagination");
    try {
      const response = await postValidation(requestFor());
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("VALIDATION_UNAVAILABLE");
    } finally {
      await setHealthyPagination();
      resetSyncHealthCacheForTest();
    }
  });

  test.serial("rechecks uncached aggregate currentness after proof verification", async () => {
    // Warm the normal health cache while both external positions are current.
    expect(expectCanonicalVerdict(await postValidation(requestFor())).code).toBe("VALID");
    midnightTip = 10_000;
    celestiaTip = 20_000;
    try {
      const response = await postValidation(requestFor());
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("VALIDATION_UNAVAILABLE");
    } finally {
      midnightTip = 100;
      celestiaTip = 200;
      resetSyncHealthCacheForTest();
    }
  });

  test.serial("retries a stale health-cache height against the direct committed anchor", async () => {
    expect(expectCanonicalVerdict(await postValidation(requestFor())).stateVersion).toBe("42");
    const nextAt = new Date(BLOCK_AT_MS + 60_000).toISOString();
    await raceClient.query(
      `INSERT INTO effectstream.effectstream_blocks
         (block_height, ver, main_chain_block_hash, seed, ms_timestamp,
          effectstream_block_hash)
       VALUES (43, 1, $1, 'offer-validation-next', $2, $3)`,
      [Buffer.from("03", "hex"), nextAt, Buffer.from("04", "hex")],
    );
    try {
      const retried = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(retried).toMatchObject({
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

  test.serial("post-crypto fresh read observes an archive race and cannot answer VALID", async () => {
    await seedLiveOffer();
    boundOfferReads = 0;
    raceArmed = true;
    try {
      const raced = expectCanonicalVerdict(await postValidation(requestFor()));
      expect(boundOfferReads).toBe(2);
      expect(raced).toMatchObject({
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

  test.serial("valid and invalid verdicts cause zero DB/event/batcher side effects", async () => {
    await seedLiveOffer();
    await seedRoots();
    const before = await databaseSnapshot();
    const beforeBatcher = batcherSubmissions;
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    eventBus.on("app_event", listener);
    try {
      expect(expectCanonicalVerdict(await postValidation(requestFor())).code).toBe("VALID");
      expect(expectCanonicalVerdict(await postValidation({
        ...requestFor(),
        offer: "not-an-offer",
      })).code).toBe("BAD_ENCODING");
    } finally {
      eventBus.off("app_event", listener);
    }
    expect(await databaseSnapshot()).toEqual(before);
    expect(batcherSubmissions).toBe(beforeBatcher);
    expect(events).toEqual([]);
  });

  test.serial("two solver identities concurrently revalidate one live offer without effects", async () => {
    await seedLiveOffer();
    await seedRoots();
    const before = await databaseSnapshot();
    const previousSecret = process.env["SOLVER_LEVELS_AUTH_SECRET"];
    const previousKeys = process.env["SOLVER_LEVELS_AUTH_KEYS"];
    const solverASecret = "validation-concurrent-a-00001";
    const solverBSecret = "validation-concurrent-b-00001";
    process.env["SOLVER_LEVELS_AUTH_KEYS"] = JSON.stringify({
      "concurrent-a": solverASecret,
      "concurrent-b": solverBSecret,
    });
    delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
    let responses: any[];
    try {
      responses = await Promise.all([
        postValidation(requestFor(), { authorization: `Bearer ${solverASecret}` }),
        postValidation(requestFor(), { authorization: `Bearer ${solverBSecret}` }),
      ]);
    } finally {
      if (previousSecret === undefined) delete process.env["SOLVER_LEVELS_AUTH_SECRET"];
      else process.env["SOLVER_LEVELS_AUTH_SECRET"] = previousSecret;
      if (previousKeys === undefined) delete process.env["SOLVER_LEVELS_AUTH_KEYS"];
      else process.env["SOLVER_LEVELS_AUTH_KEYS"] = previousKeys;
    }
    for (const response of responses!) {
      expect(expectCanonicalVerdict(response)).toMatchObject({
        valid: true,
        live: true,
        status: "live",
        code: "VALID",
        computedOfferId: OFFER_ID,
      });
    }
    expect(await databaseSnapshot()).toEqual(before);
  });

  test.serial("malformed and proof-invalid request bursts remain bounded and read-only", async () => {
    const malformed = [
      null,
      {},
      { ...requestFor(), schemaVersion: 2 },
      { ...requestFor(), offerId: OFFER_ID.toUpperCase() },
      { ...requestFor(), extra: true },
      { schemaVersion: 1, profile: OFFER_VALIDATION_PROFILE, offerId: OFFER_ID },
    ];
    const queriesBeforeMalformed = proxiedQueryCount;
    const malformedResponses = await Promise.all(
      malformed.map((payload) => postValidation(payload)),
    );
    expect(malformedResponses.map((response) => response.statusCode)).toEqual(
      malformed.map(() => 400),
    );
    expect(proxiedQueryCount).toBe(queriesBeforeMalformed);

    await seedLiveOffer(TAMPERED, TAMPERED_ID);
    const before = await databaseSnapshot();
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          postValidation(requestFor(TAMPERED, TAMPERED_ID))
        ),
      );
      const domain = responses.filter((response) => response.statusCode === 200);
      const busy = responses.filter((response) => response.statusCode === 503);
      expect(domain).toHaveLength(1);
      expect(expectCanonicalVerdict(domain[0]).code).toBe("PROOF_INVALID");
      expect(busy).toHaveLength(7);
      for (const response of busy) {
        expect(response.json().reason).toContain("already active");
      }
      expect(await databaseSnapshot()).toEqual(before);
    } finally {
      await removeOffer(TAMPERED_ID);
    }
  });

  test.serial("deadline retains the active slot until held read work actually settles", async () => {
    const before = await databaseSnapshot();
    expect(expectCanonicalVerdict(await postValidation(requestFor())).code).toBe("VALID");
    process.env["OFFER_VALIDATION_TIMEOUT_MS"] = "100";
    const entriesBefore = heldQueryEntries;
    const release = holdNextApiQuery();
    const first = postValidation(requestFor());
    try {
      // Readiness wait, not a speed assertion: the `expect` below is what
      // proves the query registered. The old 100 ms budget was sized for this
      // file running alone; the eight-path suite now runs it alongside
      // packages/tests/grand-e2e (upstream added it to the CI list), and a
      // loaded container needs longer to get the in-flight request that far.
      for (let attempt = 0; attempt < 1000 && heldQueryEntries === entriesBefore; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(heldQueryEntries).toBe(entriesBefore + 1);
      const countWithPhysicalReadHeld = proxiedQueryCount;

      const concurrent = await Promise.all(
        Array.from({ length: 12 }, () => postValidation(requestFor())),
      );
      for (const response of concurrent) {
        expect(response.statusCode).toBe(503);
        expect(response.json().reason).toContain("already active");
      }
      expect(proxiedQueryCount).toBe(countWithPhysicalReadHeld);

      const timedOut = await first;
      expect(timedOut.statusCode).toBe(503);
      expect(timedOut.json().error).toBe("VALIDATION_UNAVAILABLE");

      const afterDeadline = await Promise.all(
        Array.from({ length: 12 }, () => postValidation(requestFor())),
      );
      for (const response of afterDeadline) {
        expect(response.statusCode).toBe(503);
        expect(response.json().reason).toContain("already active");
      }
      expect(proxiedQueryCount).toBe(countWithPhysicalReadHeld);
    } finally {
      release();
      if (priorTimeout === undefined) delete process.env["OFFER_VALIDATION_TIMEOUT_MS"];
      else process.env["OFFER_VALIDATION_TIMEOUT_MS"] = priorTimeout;
    }

    let recovered: any;
    for (let attempt = 0; attempt < 200; attempt++) {
      recovered = await postValidation(requestFor());
      if (recovered.statusCode === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(expectCanonicalVerdict(recovered).code).toBe("VALID");
    expect(await databaseSnapshot()).toEqual(before);
  });

  test.serial("a completed-body HTTP response socket close cancels further work", async () => {
    expect(expectCanonicalVerdict(await postValidation(requestFor())).code).toBe("VALID");
    const entriesBefore = heldQueryEntries;
    const release = holdNextApiQuery();
    const body = JSON.stringify(requestFor());
    latestApiSocket = null;
    const wireRequest =
      "POST /v1/offers/validate HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${apiPort}\r\n` +
      `Authorization: Bearer ${AUTH_SECRET}\r\n` +
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
      // Same readiness wait as above, and this one additionally covers a
      // `bun` subprocess spawn plus a TCP connect — 200 ms never had margin
      // for that under load.
      //
      // Both conditions, not just the held entry: the connection hook that
      // assigns latestApiSocket and the query hold are separate events with no
      // guaranteed order, so waiting only for the hold left the socket
      // assertion below racing the hook. That is what actually flaked once
      // packages/tests/grand-e2e joined the suite — it failed in ~150 ms,
      // nowhere near any budget.
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

      const busy = await postValidation(requestFor());
      expect(busy.statusCode).toBe(503);
      expect(busy.json().reason).toContain("already active");
      expect(proxiedQueryCount).toBe(countWithPhysicalReadHeld);

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
      recovered = await postValidation(requestFor());
      if (recovered.statusCode === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(expectCanonicalVerdict(recovered).code).toBe("VALID");
  });

  test.serial("the router-wide request budget throttles the validation route", async () => {
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
      expect((await limited.inject({
        method: "POST",
        url: "/v1/offers/validate",
        headers: AUTH,
        payload: { ...requestFor(), extra: true },
      })).statusCode).toBe(400);
      const throttled = await limited.inject({
        method: "POST",
        url: "/v1/offers/validate",
        headers: AUTH,
        payload: { ...requestFor(), extra: true },
      });
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json().error).toBe("RATE_LIMITED");
    } finally {
      await limited.close();
    }
  });
});

test.serial("V2 DB adapter still issues the canonical nullifier probe", () => {
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
