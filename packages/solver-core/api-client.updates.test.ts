import { expect, test } from "bun:test";

import {
  offerUpdatesUrl,
  openOfferUpdatesStream,
  type OfferUpdatesSubscription,
  type WebSocketLike,
} from "./api-client.ts";
import {
  OFFER_UPDATES_PROTOCOL,
  OFFER_UPDATES_SCHEMA_VERSION,
} from "./offer-updates-contract.ts";

// The update-stream CLIENT, driven through an explicit socket double.
//
// Everything here is about one property: a mutation this client did not
// deliver must become an OBSERVABLE disconnect, never a quiet hole in the
// consumer's cache. So the interesting cases are all refusals — a skipped
// sequence number, a re-announced subscription, a frame that does not parse —
// and each one has to end the subscription rather than resume from it.

const STREAM_A = "0123456789abcdef0123456789abcdef";
const STREAM_B = "fedcba9876543210fedcba9876543210";

class SocketDouble implements WebSocketLike {
  readyState = 0;
  onopen: ((event?: any) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: any) => void) | null = null;
  onclose: ((event?: any) => void) | null = null;
  closeCalls = 0;
  #ended = false;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver one server frame verbatim. */
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** The peer or the transport ended the socket. */
  remoteClose(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  transportError(): void {
    this.onerror?.({ message: "boom" });
    this.remoteClose();
  }

  close(): void {
    this.closeCalls += 1;
    this.remoteClose();
  }
}

const readyFrame = (
  streamId = STREAM_A,
  blockL2Height: string | null = "7",
): string =>
  JSON.stringify({
    protocol: OFFER_UPDATES_PROTOCOL,
    schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
    type: "ready",
    streamId,
    seq: 0,
    ts: Date.now(),
    blockL2Height,
  });

const updateFrame = (seq: number, offerHash: string, streamId = STREAM_A): string =>
  JSON.stringify({
    protocol: OFFER_UPDATES_PROTOCOL,
    schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
    type: "update",
    streamId,
    seq,
    ts: Date.now(),
    event: { type: "offer_indexed", offerId: seq, offerHash, timestamp: Date.now() },
  });

interface Harness {
  sockets: SocketDouble[];
  events: any[];
  errors: unknown[];
  opens: OfferUpdatesSubscription[];
  disconnects: number;
  handle: ReturnType<typeof openOfferUpdatesStream>;
}

const start = (
  overrides: Parameters<typeof openOfferUpdatesStream>[1] = {},
): Harness => {
  const sockets: SocketDouble[] = [];
  const events: any[] = [];
  const errors: unknown[] = [];
  const opens: OfferUpdatesSubscription[] = [];
  const state = { disconnects: 0 };
  const handle = openOfferUpdatesStream((event) => events.push(event), {
    api: "http://backend:9999",
    baseBackoffMs: 1,
    maxBackoffMs: 2,
    connectTimeoutMs: 100,
    onOpen: (subscription) => opens.push(subscription),
    onDisconnect: () => { state.disconnects += 1; },
    onError: (err) => errors.push(err),
    createWebSocket: () => {
      const socket = new SocketDouble();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });
  return {
    sockets,
    events,
    errors,
    opens,
    get disconnects() { return state.disconnects; },
    handle,
  } as Harness;
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("the API base maps onto the websocket origin", () => {
  expect(offerUpdatesUrl("http://127.0.0.1:9999")).toBe("ws://127.0.0.1:9999/v1/offers/updates");
  expect(offerUpdatesUrl("https://node.example")).toBe("wss://node.example/v1/offers/updates");
  expect(offerUpdatesUrl("http://127.0.0.1:9999/")).toBe("ws://127.0.0.1:9999/v1/offers/updates");
  expect(offerUpdatesUrl("ws://127.0.0.1:9999")).toBe("ws://127.0.0.1:9999/v1/offers/updates");
  expect(() => offerUpdatesUrl("127.0.0.1:9999")).toThrow(/scheme/);
});

test("bounds are validated before a socket is ever created", () => {
  let created = 0;
  const create = () => { created += 1; return new SocketDouble(); };
  for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    expect(() =>
      openOfferUpdatesStream(() => {}, {
        api: "http://backend",
        maxFrameBytes: bad,
        createWebSocket: create,
      }),
    ).toThrow(/positive safe integer/);
  }
  expect(created).toBe(0);
});

test("a socket that opens is not yet a subscription — only the ready frame is", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  h.sockets[0]!.open();
  await settle();
  expect(h.opens).toEqual([]);

  h.sockets[0]!.deliver(readyFrame(STREAM_A, "7"));
  await settle();
  expect(h.opens).toEqual([{ streamId: STREAM_A, blockL2Height: "7" }]);
  await h.handle.close();
});

test("updates arrive in order and are handed over unchanged", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  const socket = h.sockets[0]!;
  socket.open();
  socket.deliver(readyFrame());
  socket.deliver(updateFrame(1, "a".repeat(64)));
  socket.deliver(updateFrame(2, "b".repeat(64)));
  socket.deliver(updateFrame(3, "c".repeat(64)));
  await settle();

  expect(h.events.map((e) => e.offerHash)).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
  expect(h.events[0]).toMatchObject({ type: "offer_indexed", offerId: 1 });
  expect(h.errors).toEqual([]);
  expect(h.disconnects).toBe(0);
  await h.handle.close();
});

test("a skipped sequence number ends the subscription instead of being applied", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  const socket = h.sockets[0]!;
  socket.open();
  socket.deliver(readyFrame());
  socket.deliver(updateFrame(1, "a".repeat(64)));
  // seq 2 never arrives.
  socket.deliver(updateFrame(3, "c".repeat(64)));
  await settle();

  // The gapped frame is NOT applied — applying it would leave a cache that
  // looks whole and is not.
  expect(h.events.map((e) => e.offerHash)).toEqual(["a".repeat(64)]);
  expect(String((h.errors[0] as Error).message)).toContain("update stream gap");
  expect(String((h.errors[0] as Error).message)).toContain("expected seq 2");
  expect(socket.closeCalls).toBeGreaterThan(0);
  await waitFor(() => h.disconnects === 1, "a reported disconnect");
  await h.handle.close();
});

test("a frame from a different subscription is a gap, not a continuation", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  const socket = h.sockets[0]!;
  socket.open();
  socket.deliver(readyFrame(STREAM_A));
  socket.deliver(updateFrame(1, "a".repeat(64), STREAM_B));
  await settle();

  expect(h.events).toEqual([]);
  expect(String((h.errors[0] as Error).message)).toContain("update stream gap");
  await h.handle.close();
});

test("a second ready frame on one subscription is refused", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  const socket = h.sockets[0]!;
  socket.open();
  socket.deliver(readyFrame());
  socket.deliver(readyFrame());
  await settle();

  expect(h.opens.length).toBe(1);
  expect(String((h.errors[0] as Error).message)).toContain("second subscription");
  await h.handle.close();
});

test("a stream that does not open with ready is refused", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  const socket = h.sockets[0]!;
  socket.open();
  socket.deliver(updateFrame(1, "a".repeat(64)));
  await settle();

  expect(h.opens).toEqual([]);
  expect(h.events).toEqual([]);
  expect(String((h.errors[0] as Error).message)).toContain("did not open with a ready frame");
  // Never subscribed, so this is a failed attempt rather than a disconnect.
  expect(h.disconnects).toBe(0);
  await h.handle.close();
});

test("noncanonical, non-text and oversize frames all end the subscription", async () => {
  for (const [label, payload, expected] of [
    ["not json", "}{", "noncanonical"],
    ["wrong protocol", JSON.stringify({ protocol: "other" }), "noncanonical"],
    ["binary", new Uint8Array([1, 2, 3]), "non-text"],
  ] as const) {
    const h = start();
    await waitFor(() => h.sockets.length === 1, `a socket for ${label}`);
    const socket = h.sockets[0]!;
    socket.open();
    socket.deliver(readyFrame());
    socket.deliver(payload);
    await settle();
    expect([label, String((h.errors[0] as Error).message).includes(expected)]).toEqual([label, true]);
    await h.handle.close();
  }

  const big = start({ maxFrameBytes: 64 });
  await waitFor(() => big.sockets.length === 1, "a socket");
  big.sockets[0]!.open();
  big.sockets[0]!.deliver(readyFrame());
  big.sockets[0]!.deliver(updateFrame(1, "a".repeat(64)));
  await settle();
  expect(String((big.errors[0] as Error).message)).toContain("exceeded 64 bytes");
  await big.handle.close();
});

test("a socket that opens but never announces a subscription times out", async () => {
  const h = start({ connectTimeoutMs: 20 });
  await waitFor(() => h.sockets.length === 1, "a socket");
  h.sockets[0]!.open();
  await waitFor(() => h.errors.length > 0, "a handshake timeout");
  expect(String((h.errors[0] as Error).message)).toContain("no ready frame within 20 ms");
  expect(h.opens).toEqual([]);
  expect(h.disconnects).toBe(0);
  await h.handle.close();
});

test("a dropped subscription reconnects and announces a fresh one", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "the first socket");
  h.sockets[0]!.open();
  h.sockets[0]!.deliver(readyFrame(STREAM_A, "7"));
  h.sockets[0]!.deliver(updateFrame(1, "a".repeat(64)));
  await settle();
  h.sockets[0]!.remoteClose();

  await waitFor(() => h.disconnects === 1, "the disconnect report");
  await waitFor(() => h.sockets.length === 2, "a reconnect attempt");
  h.sockets[1]!.open();
  // A new subscription: new identity, new anchor, sequence restarts at 0.
  h.sockets[1]!.deliver(readyFrame(STREAM_B, "9"));
  h.sockets[1]!.deliver(updateFrame(1, "d".repeat(64), STREAM_B));
  await settle();

  expect(h.opens).toEqual([
    { streamId: STREAM_A, blockL2Height: "7" },
    { streamId: STREAM_B, blockL2Height: "9" },
  ]);
  expect(h.events.map((e) => e.offerHash)).toEqual(["a".repeat(64), "d".repeat(64)]);
  await h.handle.close();
});

test("a transport error before ready retries without reporting a disconnect", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "the first socket");
  h.sockets[0]!.transportError();
  await waitFor(() => h.sockets.length === 2, "a retry");
  expect(h.disconnects).toBe(0);
  expect(h.opens).toEqual([]);
  await h.handle.close();
});

test("close stops reconnecting, is idempotent, and reports no disconnect", async () => {
  const h = start();
  await waitFor(() => h.sockets.length === 1, "a socket");
  h.sockets[0]!.open();
  h.sockets[0]!.deliver(readyFrame());
  await settle();

  await h.handle.close();
  await h.handle.close();
  const socketsAtClose = h.sockets.length;
  await settle();
  await settle();
  expect(h.sockets.length).toBe(socketsAtClose);
  // close() is an owner decision, not a stream failure.
  expect(h.disconnects).toBe(0);
});

test("throwing observers cannot break the stream", async () => {
  const seen: string[] = [];
  const sockets: SocketDouble[] = [];
  const errors: unknown[] = [];
  const handle = openOfferUpdatesStream(
    (event: any) => {
      seen.push(event.offerHash);
      throw new Error("consumer exploded");
    },
    {
      api: "http://backend",
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      onOpen: () => { throw new Error("onOpen exploded"); },
      onError: (err) => errors.push(err),
      createWebSocket: () => {
        const socket = new SocketDouble();
        sockets.push(socket);
        return socket;
      },
    },
  );
  await waitFor(() => sockets.length === 1, "a socket");
  sockets[0]!.open();
  sockets[0]!.deliver(readyFrame());
  sockets[0]!.deliver(updateFrame(1, "a".repeat(64)));
  sockets[0]!.deliver(updateFrame(2, "b".repeat(64)));
  await settle();

  // The observer threw on every call and the sequence still advanced.
  expect(seen).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(errors.length).toBe(3);
  await handle.close();
});
