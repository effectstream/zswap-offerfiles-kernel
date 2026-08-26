// A mock Midnight Intents relay: a RAW RFC 6455 server over `node:net`.
//
// Written against the specification rather than against a websocket library,
// for three reasons that all matter to what N4 has to prove:
//
//   1. the relay authenticates at the UPGRADE (`Authorization: Bearer …`) and
//      answers 401 otherwise, so the test has to see the request head itself;
//   2. the relay's liveness check is a protocol PING and it terminates a
//      solver that misses two pongs — a library that answers pings invisibly
//      would make the property untestable; and
//   3. Bun's `node:http` upgrade sockets discard raw writes (measured by N2,
//      recorded as Q-N2-1), so the server side is built on `node:net`, which
//      does not have that behaviour.
//
// This is test infrastructure and is never imported by production code; it is
// named `test-*` like `packages/database/test-pglite.ts`.

import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/** RFC 6455 §4.2.2, computed independently of any library. */
const accept = (key: string): string =>
  createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

/** Encode an UNMASKED server frame — the direction a server writes. */
function serverFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Decode MASKED client frames. Clients MUST mask (RFC 6455 §5.3). */
function decodeClientFrames(buffer: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
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
    let mask: Buffer | null = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const raw = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) for (let i = 0; i < raw.length; i += 1) raw[i] = raw[i]! ^ mask[i % 4]!;
    frames.push({ fin, opcode, payload: raw });
    offset = cursor + length;
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

export interface MockRelayConnection {
  /** Every text frame the client sent, parsed. Unparseable frames are kept
   *  as raw strings so a malformed push is visible rather than swallowed. */
  readonly messages: unknown[];
  /** Payloads of the pongs the client answered our pings with. */
  readonly pongs: string[];
  readonly closedByPeer: boolean;
  /** True once the client sent a websocket CLOSE frame. */
  readonly closeFrameReceived: boolean;
  /** Index into `messages` at which the close frame arrived, so "the
   *  withdrawal was sent BEFORE the close" is checkable, not assumed. */
  readonly messagesAtClose: number | null;
  /** Frames typed `solver-capabilities` / `price-levels` only. */
  frames: (type: string) => Array<Record<string, unknown>>;
  ping: (payload?: string) => void;
  sendText: (value: unknown) => void;
  /** Abrupt drop, the way a relay terminates a solver that missed pongs. */
  terminate: () => void;
}

class Connection implements MockRelayConnection {
  readonly messages: unknown[] = [];
  readonly pongs: string[] = [];
  closedByPeer = false;
  closeFrameReceived = false;
  messagesAtClose: number | null = null;
  #socket: Socket;
  #rest: Buffer = Buffer.alloc(0);
  #fragment: Buffer = Buffer.alloc(0);

  constructor(socket: Socket, initial: Buffer) {
    this.#socket = socket;
    this.#rest = initial;
    this.#drain();
    socket.on("data", (chunk: Buffer) => {
      this.#rest = Buffer.concat([this.#rest, chunk]);
      this.#drain();
    });
    socket.on("close", () => {
      this.closedByPeer = true;
    });
    socket.on("error", () => {
      this.closedByPeer = true;
    });
  }

  #drain(): void {
    const decoded = decodeClientFrames(this.#rest);
    this.#rest = decoded.rest;
    for (const frame of decoded.frames) this.#handle(frame);
  }

  #handle(frame: DecodedFrame): void {
    if (frame.opcode === OPCODE_PONG) {
      this.pongs.push(frame.payload.toString("utf8"));
      return;
    }
    if (frame.opcode === OPCODE_PING) {
      // A server answers a client ping too; not part of the relay's contract
      // but harmless and specification-correct.
      this.#write(serverFrame(OPCODE_PONG, frame.payload));
      return;
    }
    if (frame.opcode === OPCODE_CLOSE) {
      this.closeFrameReceived = true;
      this.messagesAtClose = this.messages.length;
      this.#write(serverFrame(OPCODE_CLOSE));
      this.#socket.end();
      return;
    }
    if (frame.opcode === OPCODE_TEXT || frame.opcode === OPCODE_CONTINUATION) {
      if (frame.opcode === OPCODE_TEXT) {
        this.#fragment = frame.payload;
      } else {
        this.#fragment = Buffer.concat([this.#fragment, frame.payload]);
      }
      if (!frame.fin) return;
      const text = this.#fragment.toString("utf8");
      this.#fragment = Buffer.alloc(0);
      try {
        this.messages.push(JSON.parse(text));
      } catch {
        this.messages.push(text);
      }
    }
  }

  #write(buffer: Buffer): void {
    if (this.#socket.destroyed) return;
    try {
      this.#socket.write(buffer);
    } catch {
      // A peer that vanished mid-write is exactly the case under test.
    }
  }

  frames(type: string): Array<Record<string, unknown>> {
    return this.messages.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null && (message as { type?: unknown }).type === type,
    );
  }

  ping(payload = ""): void {
    this.#write(serverFrame(OPCODE_PING, Buffer.from(payload, "utf8")));
  }

  sendText(value: unknown): void {
    this.#write(serverFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value), "utf8")));
  }

  terminate(): void {
    try {
      this.#socket.destroy();
    } catch {
      // Already gone.
    }
  }
}

export interface MockRelay {
  readonly port: number;
  readonly url: string;
  /** Every accepted connection, oldest first. */
  readonly connections: MockRelayConnection[];
  /** Upgrade attempts the mock refused with 401, with the reason. */
  readonly refusals: string[];
  /** Total upgrade attempts, accepted or not — the reconnect observable. */
  readonly attempts: number;
  /** While false, every upgrade is answered 401 even with the right bearer. */
  accepting: boolean;
  latest: () => MockRelayConnection | undefined;
  stop: () => Promise<void>;
}

async function freePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          probe.close();
          reject(new Error("failed to allocate a test port"));
          return;
        }
        probe.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    if (port >= 10_000) return port;
  }
  throw new Error("could not allocate a free test port >= 10000");
}

/**
 * Start the mock relay.
 *
 * `authToken` is enforced exactly as the pinned relay enforces it: the upgrade
 * request must carry `Authorization: Bearer <token>` or the mock answers 401
 * and drops the connection.
 */
export async function startMockRelay(authToken: string): Promise<MockRelay> {
  const port = await freePortAtLeast10000();
  const connections: Connection[] = [];
  const refusals: string[] = [];
  const sockets = new Set<Socket>();
  const state = { accepting: true, attempts: 0 };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const separator = head.indexOf("\r\n\r\n");
      if (separator === -1) return;
      socket.off("data", onData);
      const raw = head.subarray(0, separator).toString("latin1");
      const rest = Buffer.from(head.subarray(separator + 4));
      state.attempts += 1;

      const headers = new Map<string, string>();
      for (const line of raw.split("\r\n").slice(1)) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
      }
      const authorization = headers.get("authorization") ?? "";
      const key = headers.get("sec-websocket-key") ?? "";
      const refuse = (reason: string): void => {
        refusals.push(reason);
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\ncontent-length: 0\r\n\r\n");
        socket.end();
      };
      if (!state.accepting) {
        refuse("closed");
        return;
      }
      if (authorization !== `Bearer ${authToken}`) {
        refuse(authorization === "" ? "absent" : "wrong");
        return;
      }
      if (key === "") {
        refuse("no key");
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
      );
      connections.push(new Connection(socket, rest));
    };
    socket.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}/`,
    connections,
    refusals,
    get attempts(): number {
      return state.attempts;
    },
    get accepting(): boolean {
      return state.accepting;
    },
    set accepting(value: boolean) {
      state.accepting = value;
    },
    latest: () => connections[connections.length - 1],
    stop: async () => {
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // Already gone.
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Poll until `predicate` holds. Assertions never depend on elapsed time. */
export async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
