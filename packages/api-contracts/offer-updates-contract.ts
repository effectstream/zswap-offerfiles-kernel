// The `offer-updates-v1` websocket wire contract.
//
// This is the grammar for `GET /v1/offers/updates` (see API.md): the backend's
// client-agnostic, client-initiated update stream. It carries exactly the
// offer-lifecycle events the SSE stream carries, plus the two signals a mirror
// needs to close the snapshot/live-update gap without trusting the transport:
//
//   * `streamId` — identity of ONE subscription. Every frame repeats it. A
//     consumer that sees a different id is looking at a different
//     subscription and must repeat its authoritative snapshot; there is no
//     resume, no replay cursor, and no server-side per-client state.
//   * `seq` — a per-subscription counter. `ready` is always `0` and every
//     following frame is exactly the previous one plus one. A skipped number
//     is a MISSED MUTATION, which the consumer must treat as a lost stream
//     rather than as an absence of news. The backend never renumbers, never
//     back-fills, and never drops a frame silently: when it cannot deliver
//     one it closes the socket instead.
//
// `blockL2Height` on the `ready` frame is the committed Effectstream (L2)
// height observed at or before the moment this subscription was registered. A
// consumer binds its later currentness verdict to it: a backend that reports a
// LOWER height afterwards has rewound (a restore, or a lagging replica behind
// a load balancer), which no snapshot can repair. It is `null` when the height
// could not be read at subscribe time — the stream is still usable, that
// specific check just has no anchor.
//
// Both ends parse through this module. The backend re-parses every frame it is
// about to send, so it cannot emit something a conforming consumer would
// reject, and the solver refuses anything that does not parse.

/** Wire protocol token. A different value is a different protocol. */
export const OFFER_UPDATES_PROTOCOL = "offer-updates-v1";

/** Envelope version. Bumped only for an incompatible envelope change. */
export const OFFER_UPDATES_SCHEMA_VERSION = 1;

/** Path the stream is served at, relative to the API base. */
export const OFFER_UPDATES_PATH = "/v1/offers/updates";

/** Sequence number of the `ready` frame. Updates start at 1. */
export const OFFER_UPDATES_READY_SEQ = 0;

/** Largest encoded frame either end will accept. An update frame carries one
 * lifecycle event, so this is generous; it exists so a peer cannot grow the
 * other end's heap with one enormous frame. */
export const MAX_OFFER_UPDATES_FRAME_BYTES = 64 * 1024;

/** Subscription identity: 32 lowercase hex characters (16 random bytes). */
const STREAM_ID_RE = /^[0-9a-f]{32}$/;

/** Canonical decimal u64, no leading zeros. Matches the health contract's
 * `blockL2.height` token so the two can be compared exactly. */
const HEIGHT_RE = /^[1-9][0-9]*$/;
const MAX_U64 = "18446744073709551615";

/** One lifecycle event, in exactly the shape the SSE stream publishes it:
 * the node's AppEvent plus the server-stamped `timestamp`. Keeping the payload
 * byte-identical to the SSE payload is deliberate — a consumer applies the
 * same event handling to either transport. */
export interface OfferUpdateEventPayload {
  type: string;
  timestamp: number;
  [field: string]: unknown;
}

export interface OfferUpdatesReadyFrame {
  protocol: typeof OFFER_UPDATES_PROTOCOL;
  schemaVersion: typeof OFFER_UPDATES_SCHEMA_VERSION;
  type: "ready";
  streamId: string;
  seq: typeof OFFER_UPDATES_READY_SEQ;
  ts: number;
  blockL2Height: string | null;
}

export interface OfferUpdatesUpdateFrame {
  protocol: typeof OFFER_UPDATES_PROTOCOL;
  schemaVersion: typeof OFFER_UPDATES_SCHEMA_VERSION;
  type: "update";
  streamId: string;
  seq: number;
  ts: number;
  event: OfferUpdateEventPayload;
}

export type OfferUpdatesFrame = OfferUpdatesReadyFrame | OfferUpdatesUpdateFrame;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const isEpochMs = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Canonical decimal u64 height token, or null. */
export const parseBlockL2Height = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  if (!HEIGHT_RE.test(value)) return undefined;
  if (value.length > MAX_U64.length) return undefined;
  if (value.length === MAX_U64.length && value > MAX_U64) return undefined;
  return value;
};

/** Compare two canonical decimal height tokens without a lossy Number step. */
export const heightAtLeast = (observed: string, floor: string): boolean => {
  if (observed.length !== floor.length) return observed.length > floor.length;
  return observed >= floor;
};

const parseEventPayload = (value: unknown): OfferUpdateEventPayload | null => {
  if (!record(value)) return null;
  if (typeof value.type !== "string" || value.type.length === 0) return null;
  if (!isEpochMs(value.timestamp)) return null;
  return value as unknown as OfferUpdateEventPayload;
};

const READY_KEYS = [
  "protocol",
  "schemaVersion",
  "type",
  "streamId",
  "seq",
  "ts",
  "blockL2Height",
] as const;

const UPDATE_KEYS = [
  "protocol",
  "schemaVersion",
  "type",
  "streamId",
  "seq",
  "ts",
  "event",
] as const;

/** Strict, closed-envelope frame parser. Returns null for anything that is not
 * exactly one canonical `offer-updates-v1` frame — including unknown keys, so
 * a field added by a newer backend can never enter a consumer's trusted state
 * unnoticed. */
export function parseOfferUpdatesFrame(value: unknown): OfferUpdatesFrame | null {
  if (!record(value)) return null;
  if (value.protocol !== OFFER_UPDATES_PROTOCOL) return null;
  if (value.schemaVersion !== OFFER_UPDATES_SCHEMA_VERSION) return null;
  if (typeof value.streamId !== "string" || !STREAM_ID_RE.test(value.streamId)) return null;
  if (!isEpochMs(value.ts)) return null;

  if (value.type === "ready") {
    if (!hasExactKeys(value, READY_KEYS)) return null;
    if (value.seq !== OFFER_UPDATES_READY_SEQ) return null;
    const blockL2Height = parseBlockL2Height(value.blockL2Height);
    if (blockL2Height === undefined) return null;
    return {
      protocol: OFFER_UPDATES_PROTOCOL,
      schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
      type: "ready",
      streamId: value.streamId,
      seq: OFFER_UPDATES_READY_SEQ,
      ts: value.ts,
      blockL2Height,
    };
  }

  if (value.type === "update") {
    if (!hasExactKeys(value, UPDATE_KEYS)) return null;
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) <= OFFER_UPDATES_READY_SEQ) {
      return null;
    }
    const event = parseEventPayload(value.event);
    if (event === null) return null;
    return {
      protocol: OFFER_UPDATES_PROTOCOL,
      schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
      type: "update",
      streamId: value.streamId,
      seq: value.seq as number,
      ts: value.ts,
      event,
    };
  }

  return null;
}

/** Serialize a frame, refusing to emit anything the parser above would not
 * accept. The backend uses this so a producer bug becomes a loud local throw
 * rather than a frame a consumer silently discards. */
export function encodeOfferUpdatesFrame(frame: OfferUpdatesFrame): string {
  if (parseOfferUpdatesFrame(frame) === null) {
    throw new TypeError("refusing to emit a noncanonical offer-updates frame");
  }
  return JSON.stringify(frame);
}

/** Parse one received text frame. `null` means "not a canonical frame" and is
 * always a fail-closed condition for a consumer, never something to skip. */
export function decodeOfferUpdatesFrame(text: string): OfferUpdatesFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseOfferUpdatesFrame(parsed);
}

/** True when `next` is the frame that must follow `previous` on one
 * subscription: same stream identity, sequence advanced by exactly one. */
export const followsInSequence = (
  previous: { streamId: string; seq: number },
  next: { streamId: string; seq: number },
): boolean => next.streamId === previous.streamId && next.seq === previous.seq + 1;
