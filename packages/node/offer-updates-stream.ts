// GET /v1/offers/updates — the client-initiated websocket update stream.
//
// WHY THIS EXISTS ALONGSIDE SSE. `/v1/offers/stream` stays exactly as it is for
// browsers and every other consumer. This endpoint serves a consumer that
// mirrors the book and must be able to PROVE it has missed nothing: it adds a
// per-subscription sequence number and a subscription identity to the very
// same lifecycle events, so a missed mutation is detectable rather than
// invisible. See `@zswap-da/solver-core/offer-updates-contract` for the wire
// grammar and the reasoning behind each field.
//
// WHAT THIS ENDPOINT IS NOT. It keeps NO per-client state beyond the socket
// itself: no registry, no cursor, no replay buffer, no credentials, no idea
// who is connected. Nothing here is solver-specific — any client may open it,
// and the backend never initiates a connection to anybody. Closing a socket
// forgets the subscription entirely; the client re-subscribes and takes a
// fresh full-book read.
//
// TWO ORDERING PROPERTIES ARE LOAD-BEARING.
//
//   1. The event listener is attached BEFORE the `ready` frame is written, in
//      the same synchronous step. A consumer that treats `ready` as "I am
//      subscribed, now take my snapshot" is therefore telling the truth: no
//      event can occur between subscription and `ready`. (The SSE route writes
//      its `connected` frame first and subscribes afterwards, which leaves a
//      one-turn hole; that transport has no sequence numbers to notice it,
//      and this one closes it.)
//   2. A frame is NEVER silently dropped. When this node cannot deliver an
//      update — the peer applies backpressure, the event will not encode, the
//      frame is too large — it CLOSES THE SOCKET. A gap the consumer cannot
//      see is the one failure this design refuses to have; a disconnect is
//      loud and the consumer already knows how to recover from it.
//
// EVERY REFUSAL IS A DISCONNECT — a runtime constraint worth stating plainly,
// because it is not what a reader would assume. This backend runs on Bun, and
// two of its behaviours decide the shape of this endpoint:
//
//   * `node:http` upgrade sockets discard raw writes. The only bytes that
//     reach a peer after `upgrade` are the ones the websocket implementation
//     itself emits, so an HTTP `503` written here would go into a void and be
//     read by the client as a bare connection drop anyway.
//   * A server-initiated websocket close (`ws.close()` or `ws.terminate()`)
//     leaves the HTTP server permanently unable to finish `server.close()` —
//     measured, not assumed. A node that had ever politely refused one client
//     could therefore never shut down cleanly again.
//
// So this endpoint refuses by DESTROYING the connection: no close code, no
// reason string. That costs diagnosability and is worth naming as a cost. It
// costs no safety: a consumer's recovery from "refused" and from "dropped" is
// the same — resubscribe with backoff, resnapshot, and stay fail-closed until
// the snapshot completes — and every such consumer already implements it.

import { WebSocketServer } from "ws";

import { getLatestEffectstreamBlock } from "@zswap-da/database";
import {
  MAX_OFFER_UPDATES_FRAME_BYTES,
  OFFER_UPDATES_PATH,
  OFFER_UPDATES_PROTOCOL,
  OFFER_UPDATES_READY_SEQ,
  OFFER_UPDATES_SCHEMA_VERSION,
  encodeOfferUpdatesFrame,
  type OfferUpdatesFrame,
} from "@zswap-da/solver-core/offer-updates-contract";

import { apiUpdatesMaxConnections } from "./env.ts";
import { eventBus, type AppEvent } from "./event-bus.ts";

/** Keepalive cadence. Matches the SSE route's heartbeat so both transports
 * traverse the same idle-connection middleboxes. */
export const OFFER_UPDATES_PING_INTERVAL_MS = 30_000;

/** A client of this endpoint sends nothing at all, so anything it does send is
 * bounded hard and costs it the subscription. */
export const MAX_OFFER_UPDATES_INBOUND_BYTES = 4 * 1024;

/** Outgoing bytes this node will hold for one peer before deciding the peer
 * has stopped reading. Frames here are small; a backlog past this is a slow
 * consumer, and the socket goes rather than the events. */
export const MAX_OFFER_UPDATES_BUFFERED_BYTES = 1024 * 1024;

/** Why this node ended a subscription. These names never reach the wire — see
 * the header — but they are the vocabulary the code and the docs use, and the
 * complete list of reasons a healthy client can be disconnected. */
export type OfferUpdatesRefusal =
  /** The concurrency cap was already reached; retry with backoff. */
  | "capacity"
  /** The client sent data on a push-only stream. */
  | "push-only"
  /** The peer stopped reading and a backlog formed. */
  | "slow-consumer"
  /** One frame would not encode, or was too large to deliver intact. */
  | "undeliverable-frame"
  /** No pong across two keepalive intervals. */
  | "no-pong"
  /** This node is shutting down. */
  | "shutdown";

const WS_OPEN = 1;

/** Latest committed Effectstream (L2) height as a canonical decimal token, or
 * null when it cannot be read. Deliberately best-effort: a transient database
 * hiccup must not make the update stream unavailable — it only costs this
 * subscription its rewind anchor, which the contract models explicitly. */
async function readSubscriptionAnchor(dbConn: any): Promise<string | null> {
  try {
    const rows = await getLatestEffectstreamBlock.run(undefined, dbConn);
    const height = rows[0]?.block_height;
    if (height === null || height === undefined) return null;
    const token = String(height);
    return /^[1-9][0-9]*$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Attach the update stream to the Fastify instance's HTTP server.
 *
 * The stream lives on the `upgrade` event rather than on a route because an
 * upgrade request never reaches Fastify's router. That also means the
 * router-wide rate limiter does not see it, so the concurrency cap below —
 * not the request budget — is this endpoint's resource boundary, exactly as
 * `API_SSE_MAX_CONNECTIONS` is for SSE.
 */
export function registerOfferUpdatesStream(server: any, dbConn: any): void {
  const httpServer = server.server;
  if (!httpServer || typeof httpServer.on !== "function") {
    throw new TypeError("offer-updates stream requires a Fastify instance with an HTTP server");
  }
  const maxConnections = apiUpdatesMaxConnections();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_OFFER_UPDATES_INBOUND_BYTES,
  });
  const openSockets = new Set<any>();
  /** Per-subscription teardown, so shutdown can release listeners and timers
   * without depending on a close event arriving first. */
  const subscriptionCleanups = new Map<any, () => void>();
  /** The underlying TCP sockets, kept only so shutdown can release them: the
   * HTTP server counts an upgraded connection as its own, so closing the
   * websocket layer alone would leave server.close() waiting forever. */
  const rawSockets = new Set<any>();

  const subscribe = (socket: any, raw: any): void => {
    openSockets.add(socket);

    /** Identity of this subscription, fixed for its whole lifetime. */
    const streamId = crypto.randomUUID().replace(/-/g, "");
    let seq = OFFER_UPDATES_READY_SEQ;
    let listener: ((event: AppEvent) => void) | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let awaitingPong = false;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (listener !== null) eventBus.off("app_event", listener);
      listener = null;
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = null;
      openSockets.delete(socket);
      subscriptionCleanups.delete(socket);
    };
    subscriptionCleanups.set(socket, cleanup);

    /** End this subscription. LOUD, never quiet: the peer loses the socket, so
     * it resubscribes and resnapshots rather than continuing on a book with a
     * hole in it. The reason is documentation here, not wire data — see the
     * runtime note in the header for why no close code is sent. */
    const endSubscription = (_reason: OfferUpdatesRefusal): void => {
      cleanup();
      try { raw.destroy(); } catch { /* already gone */ }
    };

    const send = (frame: OfferUpdatesFrame): boolean => {
      if (closed || socket.readyState !== WS_OPEN) {
        cleanup();
        return false;
      }
      let text: string;
      try {
        text = encodeOfferUpdatesFrame(frame);
      } catch {
        // A producer bug must not become a silent hole in the sequence.
        endSubscription("undeliverable-frame");
        return false;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_OFFER_UPDATES_FRAME_BYTES) {
        endSubscription("undeliverable-frame");
        return false;
      }
      try {
        socket.send(text);
      } catch {
        endSubscription("undeliverable-frame");
        return false;
      }
      // A backlog means a peer that stopped reading. Retaining events for it
      // would be an unbounded memory primitive, and dropping one would be an
      // invisible gap — so the socket goes instead.
      if (Number(socket.bufferedAmount ?? 0) > MAX_OFFER_UPDATES_BUFFERED_BYTES) {
        endSubscription("slow-consumer");
        return false;
      }
      return true;
    };

    socket.on("message", () => {
      // Push-only. A client that speaks is either confused about the protocol
      // or trying to negotiate a resume this endpoint deliberately does not
      // offer; either way it does not get to hold a subscription.
      endSubscription("push-only");
    });
    socket.on("pong", () => { awaitingPong = false; });
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    void (async () => {
      const blockL2Height = await readSubscriptionAnchor(dbConn);
      if (closed || socket.readyState !== WS_OPEN) {
        cleanup();
        return;
      }

      // SUBSCRIBE, THEN ANNOUNCE — with no await between the two statements,
      // so no event can be emitted in the window. This is what makes `ready`
      // an honest "everything from here on reaches you" marker.
      listener = (event: AppEvent): void => {
        seq += 1;
        send({
          protocol: OFFER_UPDATES_PROTOCOL,
          schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
          type: "update",
          streamId,
          seq,
          ts: Date.now(),
          // Byte-identical to the SSE payload: the node's AppEvent plus the
          // server-stamped timestamp.
          event: { ...(event as Record<string, unknown>), timestamp: Date.now() } as any,
        });
      };
      eventBus.on("app_event", listener);
      if (
        !send({
          protocol: OFFER_UPDATES_PROTOCOL,
          schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
          type: "ready",
          streamId,
          seq: OFFER_UPDATES_READY_SEQ,
          ts: Date.now(),
          blockL2Height,
        })
      ) {
        return;
      }

      pingTimer = setInterval(() => {
        if (closed) return;
        if (awaitingPong) {
          // Two intervals without a pong: the peer is gone or wedged.
          endSubscription("no-pong");
          return;
        }
        awaitingPong = true;
        try {
          socket.ping();
        } catch {
          endSubscription("undeliverable-frame");
        }
      }, OFFER_UPDATES_PING_INTERVAL_MS);
      pingTimer.unref?.();
    })();
  };

  const onUpgrade = (request: any, socket: any, head: Buffer): void => {
    const drop = (): void => {
      // No websocket client of this endpoint sends a malformed handshake, and
      // this runtime cannot deliver an HTTP body here anyway (header note), so
      // the only honest answer is to refuse the connection.
      try { socket.destroy(); } catch { /* already gone */ }
    };
    const path = String(request?.url ?? "").split("?", 1)[0];
    if (path !== OFFER_UPDATES_PATH) {
      drop();
      return;
    }
    // Validate the handshake here rather than relying on the websocket
    // implementation to do it: under this runtime the native upgrade path
    // accepts a request that names a protocol version we did not agree to,
    // and an unnegotiated version is exactly the kind of "it mostly works"
    // ambiguity this stream must not have.
    const headers = request?.headers ?? {};
    if (String(headers.upgrade ?? "").toLowerCase() !== "websocket") {
      drop();
      return;
    }
    if (String(headers["sec-websocket-version"] ?? "") !== "13") {
      drop();
      return;
    }
    // 16 random bytes, base64 — 22 characters plus one pad group.
    if (!/^[A-Za-z0-9+/]{22}==$/.test(String(headers["sec-websocket-key"] ?? ""))) {
      drop();
      return;
    }
    if (openSockets.size >= maxConnections) {
      // Capacity is checked BEFORE the handshake so a refused caller never
      // costs this node a websocket, a subscription identity, or a database
      // read. It sees a dropped connection; see the header for why that is
      // the only refusal this runtime can deliver.
      drop();
      return;
    }
    rawSockets.add(socket);
    socket.once?.("close", () => rawSockets.delete(socket));
    wss.handleUpgrade(request, socket, head, (ws: any) => subscribe(ws, socket));
  };

  httpServer.on("upgrade", onUpgrade);

  // Fastify's preClose runs before it waits for in-flight work. An upgraded
  // socket is still one of the HTTP server's connections, so leaving these
  // open would deadlock server.close() exactly as a live SSE response does.
  // Shutdown DESTROYS the underlying connections rather than performing a
  // websocket close handshake. That is not impatience: under this runtime a
  // graceful `ws.close()` hands the connection to the websocket layer and the
  // HTTP server then waits on it forever, so a polite goodbye is exactly what
  // turns `server.close()` into a hang. Peers observe an abnormal closure and
  // resubscribe — the same recovery path as any other drop, and fail-closed
  // until the snapshot that follows it completes.
  const closeAll = (): void => {
    for (const cleanup of [...subscriptionCleanups.values()]) cleanup();
    subscriptionCleanups.clear();
    openSockets.clear();
    for (const raw of [...rawSockets]) {
      try { raw.destroy(); } catch { /* already closed */ }
    }
    rawSockets.clear();
  };
  server.addHook("preClose", async () => { closeAll(); });
  server.addHook("onClose", async () => {
    httpServer.off("upgrade", onUpgrade);
    closeAll();
    try { wss.close(); } catch { /* already closed */ }
  });
}
