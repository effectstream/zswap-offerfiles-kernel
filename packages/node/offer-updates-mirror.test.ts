import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getMigrations } from "@effectstream/db/version";

// THE N2 GATE: a seeded book, mirrored over the websocket update stream,
// through drop / gap / resume.
//
// Both halves are real — the production backend (PGlite, Fastify, the real
// `/v1/offers` pages, `/v1/health/sync` and `/v1/offers/updates`) and the
// production mirror (`startBookSync` with its real HTTP and websocket
// clients). Nothing between them is stubbed except a TCP proxy that can cut a
// connection or swallow exactly one frame, which is how the two failures that
// matter are produced on the wire rather than simulated at a seam:
//
//   DROP   — the subscription dies. Currentness must go blocked immediately,
//            and the resync that follows must repair a mutation that happened
//            while the mirror was blind.
//   GAP    — one update frame is swallowed. This is the failure SSE could not
//            see at all. The mirror's cache is briefly WRONG (it still holds a
//            consumed offer); the test asserts precisely that, then asserts
//            the sequence check catches it, stops treating the cache as
//            current, and converges after the resync.
//   RESUME — an ordinary increment is applied from the stream alone, with no
//            full page-through, which is the whole point of the transport.

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
process.env["EVENT_GATE_POLL_ENABLED"] = "false";
const priorRateMax = process.env["API_RATE_LIMIT_MAX"];
const priorAllowList = process.env["API_RATE_LIMIT_ALLOWLIST"];
process.env["API_RATE_LIMIT_MAX"] = "10000";
process.env["API_RATE_LIMIT_ALLOWLIST"] = "127.0.0.1";

const { migrationTable } = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/test-pglite.ts");
const { startPglite } = await import("@effectstream/db/start-pglite");
// `pg` ships no type declarations and this workspace has no `@types/pg`
// dependency; the mirror harness only needs its Client to seed rows.
// @ts-expect-error — untyped module by dependency policy, not by accident.
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { emitAppEvent } = await import("./event-bus.ts");
const { offerHashFromBlob } = await import("@zswap-da/offer-guard");
const { startBookSync } = await import("../solver/src/book-sync.ts");
const { resetSyncHealthCacheForTest } = await import("./sync-health.ts");

/** These cases drive a real server, a real proxy and a real reconnect cycle. */
const CASE_TIMEOUT_MS = 60_000;

const BLOCK_HEIGHT = 42;
const BLOCK_AT = "2026-08-20T12:34:56.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const TOKEN_A = "aa".repeat(32);
const TOKEN_B = "bb".repeat(32);

const REAL_OFFER = readFileSync(
  join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32"),
  "utf8",
).trim();
const REAL_OFFER_ID = offerHashFromBlob(REAL_OFFER);

const SEEDED_ONE = "11".repeat(32);
const SEEDED_TWO = "22".repeat(32);

let pglite: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client>;
let server: any;
let apiPort = 0;
let proxy: FramingProxy;
let originalFetch: typeof fetch = globalThis.fetch;
let listPageRequests = 0;
let detailRequests = 0;
/** Ports that carry real traffic to the backend under test. */
const passthroughPorts = new Set<number>();

const portOf = (url: string): number => {
  try {
    return Number(new URL(url).port);
  } catch {
    return -1;
  }
};

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
        probe.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
      });
    });
    if (port >= 10_000) return port;
  }
  throw new Error("could not allocate free test port >= 10000");
}

const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * A TCP proxy that understands just enough of the websocket wire to remove one
 * server frame from it.
 *
 * HTTP connections pass through untouched, so the mirror can use one base URL
 * for its REST reads and its subscription. Only a connection whose response
 * head is `101 Switching Protocols` is parsed as frames.
 */
class FramingProxy {
  readonly port: number;
  #server: Server;
  #live = new Set<Socket>();
  /** Server→client text frames still to be swallowed. */
  dropsRemaining = 0;
  droppedFrames = 0;
  upgrades = 0;

  private constructor(server: Server, port: number) {
    this.#server = server;
    this.port = port;
  }

  static async start(targetPort: number): Promise<FramingProxy> {
    const port = await randomFreePortAtLeast10000();
    let instance!: FramingProxy;
    const server = createServer((downstream) => {
      const upstream = connect(targetPort, "127.0.0.1");
      instance.#live.add(downstream);
      instance.#live.add(upstream);
      const end = (): void => {
        instance.#live.delete(downstream);
        instance.#live.delete(upstream);
        try { downstream.destroy(); } catch { /* already gone */ }
        try { upstream.destroy(); } catch { /* already gone */ }
      };
      downstream.on("error", end);
      upstream.on("error", end);
      downstream.on("close", end);
      upstream.on("close", end);
      downstream.on("data", (chunk: Buffer) => {
        try { upstream.write(chunk); } catch { end(); }
      });

      let head: "pending" | "frames" | "passthrough" = "pending";
      // Annotated: `Buffer.alloc` narrows to `Buffer<ArrayBuffer>`, while the
      // framing helper returns the general `Buffer<ArrayBufferLike>`.
      let buffer: Buffer = Buffer.alloc(0);
      upstream.on("data", (chunk: Buffer) => {
        buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
        if (head === "passthrough") {
          try { downstream.write(buffer); } catch { end(); }
          buffer = Buffer.alloc(0);
          return;
        }
        if (head === "pending") {
          const separator = buffer.indexOf("\r\n\r\n");
          if (separator === -1) return;
          const responseHead = buffer.subarray(0, separator + 4);
          try { downstream.write(responseHead); } catch { end(); }
          buffer = buffer.subarray(separator + 4);
          if (responseHead.toString("latin1").startsWith("HTTP/1.1 101 ")) {
            head = "frames";
            instance.upgrades += 1;
          } else {
            head = "passthrough";
            if (buffer.length > 0) {
              try { downstream.write(buffer); } catch { end(); }
              buffer = Buffer.alloc(0);
            }
            return;
          }
        }
        // Frame mode: forward whole frames, minus the ones being swallowed.
        for (;;) {
          const taken = FramingProxy.#takeFrame(buffer);
          if (taken === null) break;
          buffer = taken.rest;
          const isText = (taken.bytes[0]! & 0x0f) === 0x1;
          if (isText && instance.dropsRemaining > 0) {
            instance.dropsRemaining -= 1;
            instance.droppedFrames += 1;
            continue;
          }
          try { downstream.write(taken.bytes); } catch { end(); }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    instance = new FramingProxy(server, port);
    return instance;
  }

  static #takeFrame(buffer: Buffer): { bytes: Buffer; rest: Buffer } | null {
    if (buffer.length < 2) return null;
    let length = buffer[1]! & 0x7f;
    let cursor = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      cursor = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      length = Number(buffer.readBigUInt64BE(2));
      cursor = 10;
    }
    // Server frames are never masked; a masked one would mean this proxy is
    // pointed the wrong way, and silently mis-parsing it would be worse than
    // stopping.
    if ((buffer[1]! & 0x80) !== 0) throw new Error("unexpected masked server frame");
    if (buffer.length < cursor + length) return null;
    return {
      bytes: buffer.subarray(0, cursor + length),
      rest: buffer.subarray(cursor + length),
    };
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Cut every live connection, exactly as a restarted proxy or a dropped
   * network route would. */
  cutAll(): void {
    for (const socket of [...this.#live]) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    this.#live.clear();
  }

  async stop(): Promise<void> {
    this.cutAll();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

async function seedOffer(
  offerHash: string,
  blob: string,
  nullifier: string,
  celestiaHeight = BLOCK_HEIGHT,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO offer_file
       (celestia_height, transaction_hex, offer_hash, metadata_created_at,
        metadata_expires_at, first_seen_at, created_at, ttl_seconds)
     VALUES ($1, $2, $3, $4, $5, $4, $4, 3600)
     RETURNING id`,
    [celestiaHeight, blob, offerHash, BLOCK_AT, EXPIRES_AT],
  );
  const id = inserted.rows[0].id;
  await client.query(
    `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
     VALUES ($1, $2, '1000', 'GIVING', 'SHIELDED'), ($1, $3, '900', 'WANTING', 'SHIELDED')`,
    [id, TOKEN_A, TOKEN_B],
  );
  await client.query(
    `INSERT INTO offer_file_nullifiers (offer_file_id, nullifier) VALUES ($1, $2)`,
    [id, nullifier],
  );
}

async function deleteOffer(offerHash: string): Promise<void> {
  const rows = await client.query("SELECT id FROM offer_file WHERE offer_hash = $1", [offerHash]);
  const id = rows.rows[0]?.id;
  if (id === undefined) return;
  await client.query("DELETE FROM offer_file_nullifiers WHERE offer_file_id = $1", [id]);
  await client.query("DELETE FROM offer_file_tokens WHERE offer_file_id = $1", [id]);
  await client.query("DELETE FROM offer_file WHERE id = $1", [id]);
}

interface Mirror {
  sync: ReturnType<typeof startBookSync>;
  errors: unknown[];
}

const startMirror = (): Mirror => {
  // The chain-tip cache is module-global and lives for 60 s. Another suite in
  // this process may have filled it from its own fixture, which would leave
  // this backend reporting `syncing` for a minute and the mirror correctly —
  // but unhelpfully — refusing to become current.
  resetSyncHealthCacheForTest();
  const errors: unknown[] = [];
  const sync = startBookSync({
    api: proxy.baseUrl,
    resyncIntervalMs: 120_000,
    readinessTimeoutMs: 20_000,
    backendHealthCheckIntervalMs: 200,
    backendHealthMaxAgeMs: 5_000,
    backendHealthRequestTimeoutMs: 2_000,
    expiryMarginSeconds: 60,
    onError: (error) => errors.push(error),
  });
  return { sync, errors };
};

beforeAll(async () => {
  const dbPort = await randomFreePortAtLeast10000();
  pglite = await startPglite(dbPort);
  client = new pg.Client({
    host: "127.0.0.1",
    port: dbPort,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of await getMigrations()) await client.query(migration.sql);
  for (const migration of migrationTable) await client.query(migration.sql);

  const ntpStart = Date.now() - BLOCK_HEIGHT * 60_000;
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks
       (block_height, ver, main_chain_block_hash, seed, ms_timestamp,
        effectstream_block_hash)
     VALUES ($1, 1, $2, 'offer-updates-mirror', $3, $4)`,
    [BLOCK_HEIGHT, Buffer.from("01", "hex"), BLOCK_AT, Buffer.from("02", "hex")],
  );
  await client.query(
    `INSERT INTO effectstream.sync_protocol_config_snapshot
       (protocol_name, network_type, immutable_config)
     VALUES ('ntp-validation', 'ntp', $1::jsonb)`,
    [JSON.stringify({ startTime: ntpStart, blockTimeMS: 60_000 })],
  );
  await client.query(
    `INSERT INTO effectstream.sync_protocol_pagination(protocol_name, page_number, page)
     VALUES ('parallelMidnight', 100, '{}'::jsonb),
            ('parallelCelestia', 200, '{}'::jsonb)`,
  );

  await seedOffer(SEEDED_ONE, `swapoffer1seeded-one-${"0".repeat(40)}`, "1a".repeat(32));
  await seedOffer(SEEDED_TWO, `swapoffer1seeded-two-${"0".repeat(40)}`, "2a".repeat(32), BLOCK_HEIGHT - 1);

  // Only the chain-tip probes are answered locally; everything the mirror does
  // is real HTTP against the real server, through the proxy. The two are told
  // apart by PORT, not by host: the configured Midnight indexer and Celestia
  // RPC are themselves on 127.0.0.1, so a host-based rule would send the tip
  // probes at nothing and leave the backend permanently "syncing".
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (passthroughPorts.has(portOf(url))) return originalFetch(input as any, init);
    const body = String(init?.body ?? "");
    const json = body.includes("header.NetworkHead")
      ? { jsonrpc: "2.0", id: 1, result: { header: { height: "200" } } }
      : { data: { block: { height: 100 } } };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  resetSyncHealthCacheForTest();
  server = fastify();
  await apiRouter(server, client);
  server.addHook("onRequest", async (request: any) => {
    const path = String(request.url ?? "").split("?", 1)[0];
    if (path === "/v1/offers") listPageRequests += 1;
    else if (/^\/v1\/offers\/[0-9a-f]{64}$/.test(path)) detailRequests += 1;
  });
  await server.ready();
  apiPort = await randomFreePortAtLeast10000();
  await server.listen({ host: "127.0.0.1", port: apiPort });
  passthroughPorts.add(apiPort);
  proxy = await FramingProxy.start(apiPort);
  passthroughPorts.add(proxy.port);
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (priorRateMax === undefined) delete process.env["API_RATE_LIMIT_MAX"];
  else process.env["API_RATE_LIMIT_MAX"] = priorRateMax;
  if (priorAllowList === undefined) delete process.env["API_RATE_LIMIT_ALLOWLIST"];
  else process.env["API_RATE_LIMIT_ALLOWLIST"] = priorAllowList;
  try {
    await proxy?.stop();
  } finally {
    try {
      await server?.close();
    } finally {
      await closeTestPglite(pglite, client);
    }
  }
}, CASE_TIMEOUT_MS);

test("the seeded book reaches the mirror and only then is it current", async () => {
  const { sync } = startMirror();
  try {
    // Fail-closed from the first instant: nothing is usable before the first
    // snapshot completes inside a live subscription.
    expect(sync.isCurrent()).toBe(false);
    await sync.ready;
    expect(sync.book.hashes().sort()).toEqual([SEEDED_ONE, SEEDED_TWO].sort());
    await waitFor(() => sync.isCurrent(), "the mirror to become current");
    const state = sync.currentness();
    expect(state.kind).toBe("current");
    expect((state as any).backendBlockL2).toBe(String(BLOCK_HEIGHT));
    // One subscription, one snapshot — not a poll loop.
    expect(proxy.upgrades).toBeGreaterThanOrEqual(1);
  } finally {
    await sync.stop();
  }
}, CASE_TIMEOUT_MS);

test("RESUME — an increment is applied from the stream, with no new page-through", async () => {
  const { sync } = startMirror();
  try {
    await sync.ready;
    await waitFor(() => sync.isCurrent(), "the mirror to become current");
    const pagesAfterSnapshot = listPageRequests;
    const detailsAfterSnapshot = detailRequests;

    await seedOffer(REAL_OFFER_ID, REAL_OFFER, "3a".repeat(32));
    emitAppEvent({
      type: "offer_indexed",
      offerId: 99,
      offerHash: REAL_OFFER_ID,
      blockHeight: BLOCK_HEIGHT,
      gives: [],
      wants: [],
    } as any);

    await waitFor(() => sync.book.get(REAL_OFFER_ID) !== undefined, "the incremental add");
    // Exactly one identity-bound detail read, and NOT a fresh walk of the book.
    expect(detailRequests).toBe(detailsAfterSnapshot + 1);
    expect(listPageRequests).toBe(pagesAfterSnapshot);
    expect(sync.isCurrent()).toBe(true);
    // The blob came back bound to the identity that was asked for.
    expect(sync.book.get(REAL_OFFER_ID)!.blob).toBe(REAL_OFFER);

    // A consumption reaches the cache the same way.
    await deleteOffer(REAL_OFFER_ID);
    emitAppEvent({ type: "offer_consumed", offerId: 99, offerHash: REAL_OFFER_ID } as any);
    await waitFor(() => sync.book.get(REAL_OFFER_ID) === undefined, "the incremental removal");
    expect(listPageRequests).toBe(pagesAfterSnapshot);
  } finally {
    await sync.stop();
  }
}, CASE_TIMEOUT_MS);

test("DROP — a cut subscription blocks currentness, and the resync repairs the book", async () => {
  const { sync } = startMirror();
  try {
    await sync.ready;
    await waitFor(() => sync.isCurrent(), "the mirror to become current");
    expect(sync.book.get(SEEDED_TWO)).toBeDefined();

    // A mutation the mirror will be blind to: no event is emitted for it.
    await deleteOffer(SEEDED_TWO);
    proxy.cutAll();

    await waitFor(() => !sync.isCurrent(), "currentness to go blocked");
    const blocked = sync.currentness();
    expect(blocked.kind).toBe("blocked");
    // Either the drop itself or the health probe that raced it — both are
    // fail-closed, and neither is "current".
    expect([
      "stream-disconnected",
      "generation-superseded",
      "health-unavailable",
      "stream-generation-changed",
    ]).toContain((blocked as any).reason);

    // Resubscribe, resnapshot, converge.
    await waitFor(() => sync.isCurrent(), "the mirror to recover", 20_000);
    expect(sync.book.get(SEEDED_TWO)).toBeUndefined();
    expect(sync.book.hashes()).toEqual([SEEDED_ONE]);
  } finally {
    await sync.stop();
  }
  await seedOffer(SEEDED_TWO, `swapoffer1seeded-two-${"0".repeat(40)}`, "2a".repeat(32), BLOCK_HEIGHT - 1);
}, CASE_TIMEOUT_MS);

test("GAP — a swallowed frame is detected, and the stale cache is not treated as current", async () => {
  const { sync, errors } = startMirror();
  try {
    await sync.ready;
    await waitFor(() => sync.isCurrent(), "the mirror to become current");
    expect(sync.book.get(SEEDED_TWO)).toBeDefined();
    const upgradesBefore = proxy.upgrades;

    // Swallow exactly the next update frame — the consumption of SEEDED_TWO.
    proxy.dropsRemaining = 1;
    await deleteOffer(SEEDED_TWO);
    emitAppEvent({ type: "offer_consumed", offerId: 77, offerHash: SEEDED_TWO } as any);
    await waitFor(() => proxy.droppedFrames === 1, "the frame to be swallowed");

    // The cache is now WRONG and nothing on the wire has said so yet. This is
    // exactly the state SSE could reach and never detect.
    expect(sync.book.get(SEEDED_TWO)).toBeDefined();

    // The next frame carries the skipped sequence number with it.
    emitAppEvent({ type: "offer_expired", offerId: 78, offerHash: "cc".repeat(32) } as any);

    await waitFor(
      () => errors.some((error) => String((error as Error)?.message ?? "").includes("gap")),
      "the sequence gap to be reported",
    );
    await waitFor(() => !sync.isCurrent(), "currentness to go blocked after the gap");

    // Recovery is a fresh subscription plus a fresh snapshot, not a patch.
    await waitFor(() => sync.isCurrent(), "the mirror to recover", 20_000);
    expect(proxy.upgrades).toBeGreaterThan(upgradesBefore);
    expect(sync.book.get(SEEDED_TWO)).toBeUndefined();
    expect(sync.book.hashes()).toEqual([SEEDED_ONE]);
    expect(proxy.droppedFrames).toBe(1);
    expect(proxy.dropsRemaining).toBe(0);
  } finally {
    await sync.stop();
  }
  await seedOffer(SEEDED_TWO, `swapoffer1seeded-two-${"0".repeat(40)}`, "2a".repeat(32), BLOCK_HEIGHT - 1);
}, CASE_TIMEOUT_MS);

test("stopping the mirror leaves nothing running and nothing current", async () => {
  const { sync } = startMirror();
  await sync.ready;
  await waitFor(() => sync.isCurrent(), "the mirror to become current");
  await sync.stop();
  expect(sync.isCurrent()).toBe(false);
  expect(sync.currentness()).toMatchObject({ kind: "blocked", reason: "stopped" });
  // Idempotent, and it does not resurrect a subscription.
  await sync.stop();
  const upgradesAfterStop = proxy.upgrades;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(proxy.upgrades).toBe(upgradesAfterStop);
}, CASE_TIMEOUT_MS);
