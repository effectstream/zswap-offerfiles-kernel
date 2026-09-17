import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { getMigrations } from "@effectstream/db/version";

// GET /v1/offers/updates over a REAL socket.
//
// The peer below is written against RFC 6455 directly rather than against the
// server's own helpers, so the handshake and the frames are checked against
// the specification instead of against a shared implementation. The two
// properties the mirror's correctness rests on are pinned here: the event
// listener is attached BEFORE `ready` is written, and every frame after it is
// numbered consecutively on one subscription identity.
//
// The end-to-end leg deliberately drives the production client
// (`openOfferUpdatesStream`) against the production endpoint, so a wire
// disagreement between the two halves cannot hide behind a shared test double.

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
// The 1 s event-gate poll would issue its own queries under the assertions
// here and is irrelevant to this transport.
process.env["EVENT_GATE_POLL_ENABLED"] = "false";
// Two concurrent subscriptions, so the capacity refusal is reachable without
// opening a hundred sockets.
const priorUpdatesMax = process.env["API_UPDATES_MAX_CONNECTIONS"];
process.env["API_UPDATES_MAX_CONNECTIONS"] = "2";

const { migrationTable } = await import("@zswap-da/database");
const { closeTestPglite } = await import("../database/test-pglite.ts");
const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");
const { eventBus, emitAppEvent } = await import("./event-bus.ts");
const { apiUpdatesMaxConnections } = await import("./env.ts");
const {
  OFFER_UPDATES_PATH,
  OFFER_UPDATES_PROTOCOL,
  decodeOfferUpdatesFrame,
} = await import("@zswap-da/solver-core/offer-updates-contract");
const { openOfferUpdatesStream } = await import("@zswap-da/solver-core/api-client");

const BLOCK_HEIGHT = 42;
const BLOCK_AT = "2026-08-20T12:34:56.000Z";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

let pglite: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client>;
let server: any;
let apiPort = 0;

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
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** Mask a client frame exactly as RFC 6455 requires of clients. */
function maskedFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
  const header = Buffer.from([0x80 | opcode, 0x80 | masked.length]);
  return Buffer.concat([header, mask, masked]);
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
}

/** Parse UNMASKED server frames — the direction this endpoint writes. */
function decodeServerFrames(buffer: Buffer): { frames: ServerFrame[]; rest: Buffer } {
  const frames: ServerFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (buffer.length - cursor < length) break;
    frames.push({ opcode, payload: buffer.subarray(cursor, cursor + length) });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** A raw websocket peer: no library, so nothing can paper over a wire defect. */
class RawPeer {
  readonly socket: Socket;
  readonly handshake: string;
  readonly key: string;
  readonly frames: ServerFrame[] = [];
  closedByPeer = false;
  #rest: Buffer;

  constructor(socket: Socket, handshake: string, key: string, initial: Buffer) {
    this.socket = socket;
    this.handshake = handshake;
    this.key = key;
    this.#rest = initial;
    this.#drain();
    socket.on("data", (chunk: Buffer) => {
      this.#rest = Buffer.concat([this.#rest, chunk]);
      this.#drain();
    });
    socket.on("close", () => { this.closedByPeer = true; });
    socket.on("error", () => { this.closedByPeer = true; });
  }

  #drain(): void {
    const decoded = decodeServerFrames(this.#rest);
    this.#rest = decoded.rest;
    this.frames.push(...decoded.frames);
  }

  get upgraded(): boolean {
    return this.handshake.startsWith("HTTP/1.1 101 ");
  }

  get texts(): string[] {
    return this.frames
      .filter((frame) => frame.opcode === OPCODE_TEXT)
      .map((frame) => frame.payload.toString("utf8"));
  }

  get closeFrame(): ServerFrame | undefined {
    return this.frames.find((frame) => frame.opcode === OPCODE_CLOSE);
  }

  send(opcode: number, payload?: Buffer): void {
    this.socket.write(maskedFrame(opcode, payload));
  }

  destroy(): void {
    try { this.socket.destroy(); } catch { /* already gone */ }
  }

  /** Send an upgrade request and return once the response head is complete
   * (or the connection is dropped without one). */
  static open(
    port: number,
    path: string = OFFER_UPDATES_PATH,
    headerOverrides: Record<string, string | null> = {},
  ): Promise<RawPeer> {
    const key = randomBytes(16).toString("base64");
    const headers: Record<string, string | null> = {
      Host: `127.0.0.1:${port}`,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
      ...headerOverrides,
    };
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (value !== null) lines.push(`${name}: ${value}`);
    }
    return new Promise<RawPeer>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
      let raw = Buffer.alloc(0);
      let settled = false;
      const settle = (handshake: string, initial: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners("data");
        socket.removeAllListeners("close");
        socket.removeAllListeners("error");
        resolve(new RawPeer(socket, handshake, key, initial));
      };
      const timer = setTimeout(() => settle(raw.toString("latin1"), Buffer.alloc(0)), 2_000);
      socket.on("data", (chunk: Buffer) => {
        raw = Buffer.concat([raw, chunk]);
        const separator = raw.indexOf("\r\n\r\n");
        if (separator === -1) return;
        settle(raw.subarray(0, separator + 4).toString("latin1"), raw.subarray(separator + 4));
      });
      socket.on("close", () => settle(raw.toString("latin1"), Buffer.alloc(0)));
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

/** Listener count once every earlier subscription has finished releasing.
 * Socket teardown is asynchronous, so sampling it eagerly would fold a
 * previous case's listener into the baseline and hide a real regression. */
const quiescentListeners = async (): Promise<number> => {
  let stable = -1;
  let repeats = 0;
  const deadline = Date.now() + 3_000;
  for (;;) {
    const count = eventBus.listenerCount("app_event");
    if (count === stable) {
      repeats += 1;
      if (repeats >= 5) return count;
    } else {
      stable = count;
      repeats = 0;
    }
    if (Date.now() >= deadline) throw new Error("listener count never settled");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** RFC 6455 §4.2.2, computed independently of the server. */
const expectedAccept = (key: string): string =>
  createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

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
  await client.query(
    `INSERT INTO effectstream.effectstream_blocks
       (block_height, ver, main_chain_block_hash, seed, ms_timestamp,
        effectstream_block_hash)
     VALUES ($1, 1, $2, 'offer-updates', $3, $4)`,
    [BLOCK_HEIGHT, Buffer.from("01", "hex"), BLOCK_AT, Buffer.from("02", "hex")],
  );

  server = fastify();
  await apiRouter(server, client);
  await server.ready();
  apiPort = await randomFreePortAtLeast10000();
  await server.listen({ host: "127.0.0.1", port: apiPort });
});

afterAll(async () => {
  if (priorUpdatesMax === undefined) delete process.env["API_UPDATES_MAX_CONNECTIONS"];
  else process.env["API_UPDATES_MAX_CONNECTIONS"] = priorUpdatesMax;
  try {
    await server?.close();
  } finally {
    await closeTestPglite(pglite, client);
  }
});

// ── handshake ────────────────────────────────────────────────────────────────

test("a conforming handshake upgrades and announces one subscription", async () => {
  const peer = await RawPeer.open(apiPort);
  try {
    expect(peer.upgraded).toBe(true);
    expect(peer.handshake.toLowerCase()).toContain("upgrade: websocket");
    expect(peer.handshake).toContain(`Sec-WebSocket-Accept: ${expectedAccept(peer.key)}`);

    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    const frame = decodeOfferUpdatesFrame(peer.texts[0]!);
    expect(frame?.type).toBe("ready");
    expect(frame?.protocol).toBe(OFFER_UPDATES_PROTOCOL);
    expect(frame?.seq).toBe(0);
    expect(frame?.streamId).toMatch(/^[0-9a-f]{32}$/);
    // The anchor is the committed L2 height, verbatim from the database.
    expect((frame as any).blockL2Height).toBe(String(BLOCK_HEIGHT));
  } finally {
    peer.destroy();
  }
});

test("each subscription gets its own identity", async () => {
  const first = await RawPeer.open(apiPort);
  const second = await RawPeer.open(apiPort);
  try {
    await waitFor(() => first.texts.length >= 1 && second.texts.length >= 1, "both ready frames");
    const a = decodeOfferUpdatesFrame(first.texts[0]!)!;
    const b = decodeOfferUpdatesFrame(second.texts[0]!)!;
    expect(a.streamId).not.toBe(b.streamId);
  } finally {
    first.destroy();
    second.destroy();
  }
});

test("an upgrade for another path is dropped, never half-opened", async () => {
  // This runtime cannot write an HTTP body after `upgrade` (see the module
  // header), so the observable contract is: no 101, no frames, no stream.
  const peer = await RawPeer.open(apiPort, "/v1/offers/nope");
  try {
    expect(peer.upgraded).toBe(false);
    expect(peer.texts).toEqual([]);
  } finally {
    peer.destroy();
  }
});

test("a malformed websocket handshake is refused", async () => {
  for (const [label, overrides] of [
    ["wrong protocol version", { "Sec-WebSocket-Version": "8" }],
    ["missing key", { "Sec-WebSocket-Key": null }],
  ] as Array<[string, Record<string, string | null>]>) {
    const peer = await RawPeer.open(apiPort, OFFER_UPDATES_PATH, overrides);
    try {
      expect([label, peer.upgraded]).toEqual([label, false]);
      expect([label, peer.texts.length]).toEqual([label, 0]);
    } finally {
      peer.destroy();
    }
  }
});

test("a plain GET to the stream path is not a stream", async () => {
  // No Upgrade header means the HTTP server never emits `upgrade`, so this
  // reaches Fastify's router, which has no such route.
  const response = await fetch(`http://127.0.0.1:${apiPort}${OFFER_UPDATES_PATH}`);
  // Whatever the HTTP layer answers, it must not be a stream: no upgrade, no
  // success, and nothing a client could mistake for a subscription.
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.get("upgrade")).toBe(null);
  expect((await response.text()).includes(OFFER_UPDATES_PROTOCOL)).toBe(false);
});

test("subscriptions past the configured cap are refused", async () => {
  expect(apiUpdatesMaxConnections()).toBe(2);
  const held = [await RawPeer.open(apiPort), await RawPeer.open(apiPort)];
  try {
    await waitFor(() => held.every((peer) => peer.texts.length >= 1), "both subscriptions");
    const refused = await RawPeer.open(apiPort);
    try {
      // A refusal is a dropped connection under this runtime (see the module
      // header). What matters is that it is never a half-open stream: no
      // handshake, no subscription announcement, nothing to mistake for one.
      expect(refused.upgraded).toBe(false);
      expect(refused.texts).toEqual([]);
    } finally {
      refused.destroy();
    }
  } finally {
    for (const peer of held) peer.destroy();
  }
  // The cap is a live count, not a lifetime budget.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reopened = await RawPeer.open(apiPort);
  try {
    await waitFor(() => reopened.texts.length >= 1, "a reopened subscription");
  } finally {
    reopened.destroy();
  }
});

// ── streaming ────────────────────────────────────────────────────────────────

test("the event listener is attached before ready is written", async () => {
  const baseline = await quiescentListeners();
  const peer = await RawPeer.open(apiPort);
  try {
    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    // `ready` is only written after eventBus.on(...) in the same synchronous
    // step, so observing the frame is proof the subscription already existed.
    expect(eventBus.listenerCount("app_event")).toBe(baseline + 1);
  } finally {
    peer.destroy();
  }
  await waitFor(() => eventBus.listenerCount("app_event") === baseline, "listener release");
});

test("lifecycle events arrive in order with consecutive sequence numbers", async () => {
  const peer = await RawPeer.open(apiPort);
  try {
    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    const ready = decodeOfferUpdatesFrame(peer.texts[0]!)!;

    emitAppEvent({
      type: "offer_indexed",
      offerId: 1,
      offerHash: "a".repeat(64),
      blockHeight: 7,
      gives: [],
      wants: [],
    } as any);
    emitAppEvent({ type: "offer_consumed", offerId: 1, offerHash: "a".repeat(64) } as any);
    emitAppEvent({ type: "offer_expired", offerId: 2, offerHash: "b".repeat(64) } as any);

    await waitFor(() => peer.texts.length >= 4, "three updates");
    const frames = peer.texts.slice(1).map((text) => decodeOfferUpdatesFrame(text)!);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(frames.every((frame) => frame.streamId === ready.streamId)).toBe(true);
    expect(frames.map((frame) => (frame as any).event.type)).toEqual([
      "offer_indexed",
      "offer_consumed",
      "offer_expired",
    ]);
    // Byte-identical payload to the SSE stream: AppEvent plus `timestamp`.
    expect((frames[0] as any).event).toMatchObject({
      type: "offer_indexed",
      offerId: 1,
      offerHash: "a".repeat(64),
      blockHeight: 7,
    });
    expect(typeof (frames[0] as any).event.timestamp).toBe("number");
  } finally {
    peer.destroy();
  }
});

test("a ping is answered and a pong is accepted", async () => {
  const peer = await RawPeer.open(apiPort);
  try {
    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    peer.send(OPCODE_PING, Buffer.from("probe"));
    await waitFor(() => peer.frames.some((f) => f.opcode === OPCODE_PONG), "a pong");
    expect(peer.frames.find((f) => f.opcode === OPCODE_PONG)!.payload.toString("utf8"))
      .toBe("probe");

    // An unsolicited pong is liveness, not an error: the stream survives it.
    peer.send(OPCODE_PONG);
    emitAppEvent({ type: "offer_expired", offerId: 9, offerHash: "c".repeat(64) } as any);
    await waitFor(() => peer.texts.length >= 2, "an update after the pong");
  } finally {
    peer.destroy();
  }
});

test("a client that sends application data loses its subscription", async () => {
  const baseline = await quiescentListeners();
  const peer = await RawPeer.open(apiPort);
  try {
    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    // A "resume from here" negotiation is exactly what this endpoint refuses
    // to offer: there is no server-side per-client state to resume from.
    peer.send(OPCODE_TEXT, Buffer.from(JSON.stringify({ type: "resume", seq: 3 })));
    await waitFor(() => peer.closedByPeer, "the subscription to be dropped");
  } finally {
    peer.destroy();
  }
  await waitFor(() => eventBus.listenerCount("app_event") === baseline, "listener release");
});

test("a client close frame ends the subscription cleanly", async () => {
  const baseline = await quiescentListeners();
  const peer = await RawPeer.open(apiPort);
  try {
    await waitFor(() => peer.texts.length >= 1, "the ready frame");
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000, 0);
    peer.send(OPCODE_CLOSE, code);
    await waitFor(
      () => peer.closedByPeer || peer.closeFrame !== undefined,
      "the close handshake",
    );
  } finally {
    peer.destroy();
  }
  await waitFor(() => eventBus.listenerCount("app_event") === baseline, "listener release");
});

// ── end to end against the production client ─────────────────────────────────

test("the production client subscribes to the production endpoint", async () => {
  const events: any[] = [];
  const opens: any[] = [];
  const errors: unknown[] = [];
  const stream = openOfferUpdatesStream((event) => events.push(event), {
    api: `http://127.0.0.1:${apiPort}`,
    baseBackoffMs: 5,
    maxBackoffMs: 20,
    connectTimeoutMs: 2_000,
    onOpen: (subscription) => opens.push(subscription),
    onError: (error) => errors.push(error),
  });
  try {
    await waitFor(() => opens.length === 1, "the client subscription");
    expect(opens[0].streamId).toMatch(/^[0-9a-f]{32}$/);
    expect(opens[0].blockL2Height).toBe(String(BLOCK_HEIGHT));

    emitAppEvent({
      type: "offer_indexed",
      offerId: 11,
      offerHash: "d".repeat(64),
      blockHeight: 7,
      gives: [],
      wants: [],
    } as any);
    emitAppEvent({ type: "offer_consumed", offerId: 11, nullifier: "e".repeat(64) } as any);
    await waitFor(() => events.length === 2, "two delivered events");
    expect(events.map((event) => event.type)).toEqual(["offer_indexed", "offer_consumed"]);
    expect(events[1].nullifier).toBe("e".repeat(64));
    expect(errors).toEqual([]);
  } finally {
    await stream.close();
  }
});

// ── shutdown (last: it closes the shared server) ─────────────────────────────

test("server shutdown destroys live subscriptions instead of deadlocking", async () => {
  const peer = await RawPeer.open(apiPort);
  await waitFor(() => peer.texts.length >= 1, "the ready frame");
  expect(eventBus.listenerCount("app_event")).toBeGreaterThan(0);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    server.close().then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 3_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  expect(closed).toBe(true);
  await waitFor(() => peer.closedByPeer, "the subscription socket to be released");
  // onClose released both the router's projection listener and the stream's.
  expect(eventBus.listenerCount("app_event")).toBe(0);
  peer.destroy();
  server = null;
});
