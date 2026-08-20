import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { bech32m } from "@scure/base";
import { getMigrations } from "@effectstream/db/version";
import { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// SC-006 parity: one shared fixture and state matrix driven through all four
// production validation contexts — the batcher's pre-fee admission, HTTP
// submission, STM ingestion, and the exact-files read — so the read's answers
// are pinned against the backend's own admission/ingestion decisions rather
// than asserted in isolation.
//
// The inversion is the point and must stay explicit: submission dedup and the
// exact-files read have OPPOSITE semantics for an exact, already-indexed live
// offer. Ingestion refuses it as a duplicate; the read serves its bytes,
// because being indexed and live is precisely what makes it usable.
//
// Upstream PR #47 added a SECOND dedup rule with the same shape, so the matrix
// carries a second inversion: an offer whose declared markers a live offer
// already claims is refused at both ingestion doors as DUPLICATE_MARKERS,
// while the incumbent — whose own markers are, necessarily, claimed by itself —
// must still read VALID and still hand back its exact bytes.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const {
  createAppInputSavepoint,
  deleteRejectedAccountingRow,
  findActiveOfferByCommitment,
  getOfferRootTiming,
  getOfferStatusByHash,
  insertOfferFileWithHash,
  isKnownRootLive,
  isNullifierSpent,
  migrationTable,
  recordOfferRejection,
  releaseAppInputSavepoint,
} = await import("@zswap-da/database");
const { declaredMarkers } = await import("./marker-dedup.ts");
const { closeTestPglite } = await import("../database/test-pglite.ts");
const {
  eventBus,
  markBlockCommitted,
  __resetEventGateForTests,
} = await import("./event-bus.ts");
const { getBlankRefState, validateZswapOffer } = await import("@zswap-da/validator");
const {
  bytesToLatin1,
  offerHashFromBlob,
} = await import("@zswap-da/offer-guard");
const { ZswapCelestiaAdapter } = await import("../batcher/celestia.ts");
const { apiRouter } = await import("./api.ts");
const {
  EXACT_FILES_PROFILE,
  EXACT_FILES_SCHEMA_VERSION,
  parseExactFilesResponse,
} = await import("@zswap-da/solver-core/exact-files-contract");
const { resetSyncHealthCacheForTest } = await import("./sync-health.ts");
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

// The markers this shared fixture DECLARES, derived by the production
// derivation both doors use — never hand-written, so the matrix cannot agree
// with a broken derivation.
const DECLARED_COMMITMENTS = declaredMarkers(probe.tx!)
  .flatMap((marker) => marker.kind === "commitment" ? [marker.commitment] : []);
if (DECLARED_COMMITMENTS.length === 0) {
  throw new Error("shared fixture declares no commitments; the marker row cannot be driven");
}
/** A second, unrelated live offer, standing in for the re-proved incumbent. */
const INCUMBENT_ID = "a".repeat(64);

/**
 * Frozen V0 prediction matrix. The endpoint column is the v1 contract target,
 * not an assertion that the not-yet-implemented route exists.
 */
const EXPECTED_MATRIX = {
  transportGarbage: {
    batcher: "BAD_ENCODING",
    api: "BAD_ENCODING",
    stm: "BAD_DESERIALIZE",
    // Undecodable bytes cannot be ASKED for by identity: an identity that no
    // indexed row carries is simply absent.
    exactFiles: "NOT_INDEXED",
  },
  decodableJunk: {
    batcher: "BAD_DESERIALIZE",
    api: "BAD_DESERIALIZE",
    stm: "BAD_DESERIALIZE",
    // Indexed junk (only reachable through direct row corruption) is refused
    // with the same canonical structural code the other contexts use.
    exactFiles: "BAD_DESERIALIZE",
  },
  liveUnindexed: {
    batcher: "VALID",
    api: "FORWARDED",
    stm: "INDEXED",
    exactFiles: "NOT_INDEXED",
  },
  indexedLiveDuplicate: {
    batcher: "DUPLICATE_OFFER",
    api: "DUPLICATE_OFFER",
    stm: "DUPLICATE_OFFER",
    exactFiles: "VALID",
  },
  // Upstream #47's SECOND dedup rule (9f1f479): an offer whose DECLARED markers
  // are already claimed by an ACTIVE offer is refused, at both ingestion doors,
  // after crypto. The state is "some live offer already claims this
  // commitment" — reached in practice by re-proving one intent against a fresh
  // root, which yields byte-different bytes, a fresh offer_hash and identical
  // markers, so rule (i) relates the two not at all.
  markerClaimedByLiveOffer: {
    // The batcher has no book: its dedup is byte-keyed and process-local, so a
    // re-proved copy is invisible to it, exactly as `spent`/`unknownRoot` are.
    batcher: "VALID",
    api: "DUPLICATE_MARKERS",
    stm: "DUPLICATE_MARKERS",
    // THE INVERSION, again, and the one this phase had to prove: marker dedup
    // is a rule about admitting a SECOND claimant. It is never a statement
    // about the offer that holds the claim, so an indexed, live offer whose own
    // markers are (necessarily) claimed by itself must still read VALID and
    // still hand back its exact bytes. If this were `DUPLICATE_MARKERS` the
    // solver could not fetch settlement bytes for any offer in the book.
    exactFiles: "VALID",
  },
  spent: {
    // The batcher has no authoritative chain-state database and therefore
    // cannot distinguish this row from live at its pre-fee boundary.
    batcher: "VALID",
    api: "NULLIFIER_SPENT",
    stm: "NULLIFIER_SPENT",
    exactFiles: "NULLIFIER_SPENT",
  },
  unknownRoot: {
    batcher: "VALID",
    api: "ROOT_UNKNOWN",
    stm: "ROOT_UNKNOWN",
    exactFiles: "ROOT_UNKNOWN",
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

type StmState =
  | "unindexed"
  | "indexed-live"
  | "spent"
  | "root-unknown"
  | "marker-claimed";
type StmObservation = {
  queries: Array<{ queryIR: unknown; params: unknown }>;
  events: Array<Record<string, unknown>>;
};

/** Drive the real production STM generator while supplying deterministic DB
 * results at its World.resolve boundary. This observes the actual transition
 * ordering without copying its validation ladder into the test. */
const STM_BLOCK_HEIGHT = 77;

function driveStm(rawBytes: Uint8Array, state: StmState): StmObservation {
  const events: Array<Record<string, unknown>> = [];
  const queries: Array<{ queryIR: unknown; params: unknown }> = [];
  // Post-merge the STM publishes via emitAppEvent, which HOLDS each event until
  // its block is observed committed (0358d9e). Record off the bus and release
  // the block below; `data.emit` no longer sees lifecycle events.
  __resetEventGateForTests();
  const onAppEvent = (event: any) => { events.push(event); };
  eventBus.on("app_event", onAppEvent);
  const generator = gameStateTransitions(1, {
    blockHeight: STM_BLOCK_HEIGHT,
    blockTimestamp: BLOCK_TIME_MS,
    conciseInput: JSON.stringify([
      "celestia-zswap",
      { suppliedValue: bytesToLatin1(rawBytes) },
    ]),
    randomGenerator: {} as any,
    emit: () => {
      throw new Error("lifecycle events must go through the event gate, not data.emit");
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
    } else if (queryIR === (findActiveOfferByCommitment as any).queryIR) {
      // Upstream #47's marker-dedup probe. A non-empty answer means some ACTIVE
      // offer already claims this declared commitment.
      result = state === "marker-claimed"
        ? [{ offer_file_id: 91, offer_hash: INCUMBENT_ID }]
        : [];
    } else if (queryIR === (getOfferRootTiming as any).queryIR) {
      // 774b363 renamed getEarliestRootFirstSeen -> getOfferRootTiming, added a
      // required :block_ms! param, and replaced last_seen_ms with the
      // per-root-resolved window_anchor_ms. Re-pinned against the new IR and
      // the new result shape, not just the new name.
      result = [{ first_seen_ms: BLOCK_TIME_MS, window_anchor_ms: BLOCK_TIME_MS }];
    } else if (queryIR === (insertOfferFileWithHash as any).queryIR) {
      result = [{ id: 92 }];
    }
    next = generator.next(result);
  }

  // The block committed: release everything the gate buffered for it.
  markBlockCommitted(STM_BLOCK_HEIGHT);
  eventBus.off("app_event", onAppEvent);
  __resetEventGateForTests();
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

  // Health scaffolding: the exact-files read refuses to answer at all unless
  // this backend can prove its own positions current, so the shared matrix
  // needs a synchronized node. NTP is anchored so the committed block above is
  // the expected one; both chain tips match their merged pagination cursors.
  await client.query(
    `INSERT INTO effectstream.sync_protocol_config_snapshot
       (protocol_name, network_type, immutable_config)
     VALUES ('ntp-validation', 'ntp', $1::jsonb)`,
    [JSON.stringify({ startTime: Date.now() - 60_000, blockTimeMS: 60_000 })],
  );
  await client.query(
    `INSERT INTO effectstream.sync_protocol_pagination(protocol_name, page_number, page)
     VALUES ('parallelMidnight', 100, '{}'::jsonb),
            ('parallelCelestia', 200, '{}'::jsonb)`,
  );

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/send-input")) {
      batcherSubmissions += 1;
      return new Response(JSON.stringify({
        success: true,
        message: "Input processed successfully",
        inputsProcessed: 1,
        transactionHash: "characterization-tx",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = String(init?.body ?? "");
    const json = body.includes("header.NetworkHead")
      ? { jsonrpc: "2.0", id: 1, result: { header: { height: "200" } } }
      : { data: { block: { height: 100 } } };
    return new Response(JSON.stringify(json), {
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

    // Marker overlap is a BOOK question, and this context has no book: its
    // dedup keys on the bytes it has itself published in this process. A blob
    // whose markers the backend's live book already claims is admitted here.
    const markerClaimedButInvisibleHere = adapter().validateInput(
      batcherInput(VALID_OFFER) as any,
    );
    expect(markerClaimedButInvisibleHere.valid).toBe(true);
    expect(EXPECTED_MATRIX.markerClaimedByLiveOffer.batcher).toBe("VALID");

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
      // first_seen_at is NOT NULL as of upstream's collapsed 000-init.sql.
      `INSERT INTO offer_file(celestia_height, transaction_hex, offer_hash, ttl_seconds, first_seen_at)
       VALUES (77, $1, $2, 3600, NOW())`,
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

    // Upstream #47 rule (ii), driven through the real route against real rows:
    // a DIFFERENT live offer already claims a commitment this blob declares.
    // Everything else about the submission is admissible — the bytes are not
    // indexed, the nullifier is unspent, the roots are known, and the crypto
    // verifies — so the only thing left to refuse it is marker overlap.
    for (const root of INPUT_ROOTS) {
      await client!.query(
        `INSERT INTO known_roots(root, height, last_seen_ms, first_seen_ms)
         VALUES ($1, 1, $2, $2)`,
        [root, BLOCK_TIME_MS],
      );
    }
    const incumbent = await client!.query(
      `INSERT INTO offer_file(celestia_height, transaction_hex, offer_hash, ttl_seconds, first_seen_at)
       VALUES (76, 'incumbent-blob', $1, 3600, NOW()) RETURNING id`,
      [INCUMBENT_ID],
    );
    await client!.query(
      `INSERT INTO offer_file_commitments(offer_file_id, commitment) VALUES ($1, $2)`,
      [incumbent.rows[0].id, DECLARED_COMMITMENTS[0]],
    );
    response = await inject(VALID_OFFER);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(EXPECTED_MATRIX.markerClaimedByLiveOffer.api);
    // The reason names the incumbent by CONTENT ADDRESS, so the maker can look
    // up the offer that already owns the marker instead of guessing.
    expect(response.json().activeOfferId).toBe(INCUMBENT_ID);
    expect(response.json().reason).toContain(DECLARED_COMMITMENTS[0]);
    expect(batcherSubmissions).toBe(1);

    await client!.query("DELETE FROM offer_file_commitments WHERE offer_file_id = $1", [
      incumbent.rows[0].id,
    ]);
    await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [INCUMBENT_ID]);
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

    // Upstream #47 rule (ii). The marker probe is the AUTHORITATIVE door — the
    // DA namespace is permissionless, so a blob can arrive having never passed
    // the API — and it refuses before the offer is written.
    const markerClaimed = driveStm(VALID_BYTES, "marker-claimed");
    expect(rejectionCode(markerClaimed)).toBe(EXPECTED_MATRIX.markerClaimedByLiveOffer.stm);
    expect(markerClaimed.queries.some(({ queryIR }) =>
      queryIR === (insertOfferFileWithHash as any).queryIR)).toBe(false);

    // Ordering, asserted rather than assumed: rule (i) is cheaper and runs
    // FIRST, so a byte-identical replay never reaches the marker probe.
    expect(duplicate.queries.some(({ queryIR }) =>
      queryIR === (findActiveOfferByCommitment as any).queryIR)).toBe(false);
    // ...and the marker probe runs AFTER liveness, so neither of the two
    // liveness refusals pays for it either.
    expect(spent.queries.some(({ queryIR }) =>
      queryIR === (findActiveOfferByCommitment as any).queryIR)).toBe(false);
    expect(unknownRoot.queries.some(({ queryIR }) =>
      queryIR === (findActiveOfferByCommitment as any).queryIR)).toBe(false);

    const accepted = driveStm(VALID_BYTES, "unindexed");
    expect(rejectionCode(accepted)).toBeNull();
    expect(accepted.events.some((event) =>
      event.type === "offer_indexed" && event.offerHash === OFFER_ID)).toBe(true);
    // An accepted offer DID pay for the probe — one per declared commitment —
    // which is what makes the refusal above a decision rather than an accident.
    expect(accepted.queries.filter(({ queryIR }) =>
      queryIR === (findActiveOfferByCommitment as any).queryIR).length)
      .toBe(DECLARED_COMMITMENTS.length);
  });

  test("the exact-files read agrees with admission and ingestion on the shared matrix", async () => {
    const readFiles = async (offerIds: string[]) => {
      resetSyncHealthCacheForTest();
      const response = await server.inject({
        method: "POST",
        url: "/v1/offers/files",
        payload: {
          schemaVersion: EXACT_FILES_SCHEMA_VERSION,
          profile: EXACT_FILES_PROFILE,
          offerIds,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Same binding the solver applies, run here so a wrong-identity or
      // byte-substituted answer could not pass as agreement.
      expect(parseExactFilesResponse(body, { hashOffer: offerHashFromBlob })).toEqual(body);
      return body.files;
    };
    const seedRoots = async () => {
      await client!.query("DELETE FROM known_roots");
      for (const root of INPUT_ROOTS) {
        await client!.query(
          `INSERT INTO known_roots(root, height, last_seen_ms, first_seen_ms)
           VALUES ($1, 1, $2, $2)`,
          [root, BLOCK_TIME_MS],
        );
      }
    };
    const indexOffer = async (offer: string, offerHash: string) => {
      await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [offerHash]);
      await client!.query(
        `INSERT INTO offer_file
           (celestia_height, transaction_hex, offer_hash, metadata_expires_at,
            ttl_seconds, first_seen_at)
         VALUES (77, $1, $2, $3, 3600, NOW())`,
        [offer, offerHash, new Date(BLOCK_TIME_MS + 3_600_000)],
      );
    };
    const batcherCallsBefore = batcherSubmissions;
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    eventBus.on("app_event", listener);

    try {
      // transportGarbage: undecodable bytes have no indexable identity at all,
      // so the only thing a caller can name is an identity nothing carries.
      const garbageId = createHash("sha256")
        .update(new TextEncoder().encode("definitely-not-an-offer"))
        .digest("hex");
      // liveUnindexed: the same valid, live bytes every other context accepts.
      await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [OFFER_ID]);
      await client!.query("DELETE FROM nullifiers WHERE nullifier = $1", [NULLIFIER]);
      await seedRoots();

      let [garbage, unindexed] = await readFiles([garbageId, OFFER_ID]);
      expect(garbage.verdict.code).toBe(EXPECTED_MATRIX.transportGarbage.exactFiles);
      expect(garbage.offer).toBeUndefined();
      expect(unindexed.verdict.code).toBe(EXPECTED_MATRIX.liveUnindexed.exactFiles);
      expect(unindexed.offer).toBeUndefined();

      // indexedLiveDuplicate: the exact inversion. Every ingestion context
      // refuses this row as a duplicate; the read serves its bytes.
      await indexOffer(VALID_OFFER, OFFER_ID);
      const [indexedLive] = await readFiles([OFFER_ID]);
      expect(indexedLive.verdict.code).toBe(EXPECTED_MATRIX.indexedLiveDuplicate.exactFiles);
      expect(indexedLive.offer).toBe(VALID_OFFER);
      expect(EXPECTED_MATRIX.indexedLiveDuplicate.api).toBe("DUPLICATE_OFFER");
      expect(EXPECTED_MATRIX.indexedLiveDuplicate.stm).toBe("DUPLICATE_OFFER");

      // markerClaimedByLiveOffer: the SECOND inversion, added by upstream #47.
      // Give the indexed offer above its own marker rows — which is exactly
      // what ingestion writes for every accepted offer — so the live book now
      // genuinely claims every commitment this identity declares. Both
      // ingestion doors would refuse a re-proved copy on that basis
      // (DUPLICATE_MARKERS above); the read must NOT refuse the incumbent its
      // own bytes, or the solver could never fetch a settlement file.
      const indexedRow = await client!.query(
        "SELECT id FROM offer_file WHERE offer_hash = $1",
        [OFFER_ID],
      );
      for (const commitment of DECLARED_COMMITMENTS) {
        await client!.query(
          `INSERT INTO offer_file_commitments(offer_file_id, commitment) VALUES ($1, $2)`,
          [indexedRow.rows[0].id, commitment],
        );
      }
      // Precondition, asserted rather than assumed: the probe both doors run
      // now answers "claimed" for this identity's own markers.
      for (const commitment of DECLARED_COMMITMENTS) {
        const claimed = await findActiveOfferByCommitment.run({ commitment }, client!);
        expect(claimed[0]?.offer_hash).toBe(OFFER_ID);
      }
      const [selfClaimed] = await readFiles([OFFER_ID]);
      expect(selfClaimed.verdict.code).toBe(EXPECTED_MATRIX.markerClaimedByLiveOffer.exactFiles);
      expect(selfClaimed.offer).toBe(VALID_OFFER);
      expect(EXPECTED_MATRIX.markerClaimedByLiveOffer.api).toBe("DUPLICATE_MARKERS");
      expect(EXPECTED_MATRIX.markerClaimedByLiveOffer.stm).toBe("DUPLICATE_MARKERS");

      // The refused re-proved copy, conversely, has no row at all: a blob both
      // doors reject is never indexed, so its identity reads NOT_INDEXED.
      const reProvedId = "b".repeat(64);
      const [reProved] = await readFiles([reProvedId]);
      expect(reProved.verdict.code).toBe("NOT_INDEXED");
      expect(reProved.offer).toBeUndefined();

      await client!.query("DELETE FROM offer_file_commitments WHERE offer_file_id = $1", [
        indexedRow.rows[0].id,
      ]);

      // decodableJunk: only reachable by corrupting the index, and refused
      // with the canonical structural code the other contexts produce.
      const junkId = offerHashFromBlob(DECODABLE_JUNK);
      await indexOffer(DECODABLE_JUNK, junkId);
      const [junk] = await readFiles([junkId]);
      expect(junk.verdict.code).toBe(EXPECTED_MATRIX.decodableJunk.exactFiles);
      expect(junk.offer).toBeUndefined();
      await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [junkId]);

      // spent: identical bytes, authoritative chain state says the nullifier
      // is gone. Same code as HTTP submission and STM ingestion.
      await client!.query(
        `INSERT INTO nullifiers(nullifier, height, offer_matched) VALUES ($1, 77, false)`,
        [NULLIFIER],
      );
      const [spent] = await readFiles([OFFER_ID]);
      expect(spent.verdict.code).toBe(EXPECTED_MATRIX.spent.exactFiles);
      expect(spent.offer).toBeUndefined();
      await client!.query("DELETE FROM nullifiers WHERE nullifier = $1", [NULLIFIER]);

      // unknownRoot: same again for the root-window predicate.
      await client!.query("DELETE FROM known_roots");
      const [unknownRoot] = await readFiles([OFFER_ID]);
      expect(unknownRoot.verdict.code).toBe(EXPECTED_MATRIX.unknownRoot.exactFiles);
      expect(unknownRoot.offer).toBeUndefined();
      await seedRoots();
    } finally {
      eventBus.off("app_event", listener);
      await client!.query("DELETE FROM offer_file WHERE offer_hash = $1", [OFFER_ID]);
      await client!.query("DELETE FROM nullifiers WHERE nullifier = $1", [NULLIFIER]);
    }

    // Reading never publishes, never pays a Celestia fee, never emits.
    expect(batcherSubmissions).toBe(batcherCallsBefore);
    expect(events).toEqual([]);
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
