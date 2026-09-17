import { expect, test } from "bun:test";

import {
  MAX_OFFER_UPDATES_FRAME_BYTES,
  OFFER_UPDATES_PATH,
  OFFER_UPDATES_PROTOCOL,
  OFFER_UPDATES_READY_SEQ,
  OFFER_UPDATES_SCHEMA_VERSION,
  decodeOfferUpdatesFrame,
  encodeOfferUpdatesFrame,
  followsInSequence,
  heightAtLeast,
  parseBlockL2Height,
  parseOfferUpdatesFrame,
  type OfferUpdatesFrame,
} from "./offer-updates-contract.ts";

// The grammar both ends of `GET /v1/offers/updates` parse with. Everything the
// mirror is allowed to believe about a gap, a rewind, or a crossed
// subscription reduces to fields checked here, so the envelope is closed in
// both directions: nothing extra gets in, and nothing noncanonical gets out.

const STREAM = "0123456789abcdef0123456789abcdef";

const ready = (over: Record<string, unknown> = {}): unknown => ({
  protocol: OFFER_UPDATES_PROTOCOL,
  schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
  type: "ready",
  streamId: STREAM,
  seq: OFFER_UPDATES_READY_SEQ,
  ts: 1_750_000_000_000,
  blockL2Height: "42",
  ...over,
});

const update = (over: Record<string, unknown> = {}): unknown => ({
  protocol: OFFER_UPDATES_PROTOCOL,
  schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
  type: "update",
  streamId: STREAM,
  seq: 1,
  ts: 1_750_000_000_001,
  event: {
    type: "offer_indexed",
    offerId: 7,
    offerHash: "a".repeat(64),
    blockHeight: 12,
    gives: [],
    wants: [],
    timestamp: 1_750_000_000_001,
  },
  ...over,
});

test("the wire constants are the ones both ends agree on", () => {
  expect(OFFER_UPDATES_PROTOCOL).toBe("offer-updates-v1");
  expect(OFFER_UPDATES_SCHEMA_VERSION).toBe(1);
  expect(OFFER_UPDATES_PATH).toBe("/v1/offers/updates");
  expect(OFFER_UPDATES_READY_SEQ).toBe(0);
  expect(MAX_OFFER_UPDATES_FRAME_BYTES).toBe(64 * 1024);
});

test("a canonical ready frame parses into exactly its declared fields", () => {
  const parsed = parseOfferUpdatesFrame(ready());
  expect(parsed).toEqual({
    protocol: OFFER_UPDATES_PROTOCOL,
    schemaVersion: OFFER_UPDATES_SCHEMA_VERSION,
    type: "ready",
    streamId: STREAM,
    seq: 0,
    ts: 1_750_000_000_000,
    blockL2Height: "42",
  });
});

test("a ready frame may report no anchor at all", () => {
  const parsed = parseOfferUpdatesFrame(ready({ blockL2Height: null }));
  expect(parsed?.type).toBe("ready");
  expect((parsed as any).blockL2Height).toBe(null);
});

test("a canonical update frame carries the lifecycle event through unchanged", () => {
  const parsed = parseOfferUpdatesFrame(update());
  expect(parsed?.type).toBe("update");
  expect((parsed as any).seq).toBe(1);
  // Byte-identical to the SSE payload: the node's AppEvent plus `timestamp`.
  expect((parsed as any).event).toEqual({
    type: "offer_indexed",
    offerId: 7,
    offerHash: "a".repeat(64),
    blockHeight: 12,
    gives: [],
    wants: [],
    timestamp: 1_750_000_000_001,
  });
});

test("the envelope is closed — an added field is refused, not ignored", () => {
  expect(parseOfferUpdatesFrame(ready({ resumeToken: "x" }))).toBe(null);
  expect(parseOfferUpdatesFrame(update({ replay: true }))).toBe(null);
});

test("every envelope field is load-bearing", () => {
  const cases: Array<[string, unknown]> = [
    ["wrong protocol", ready({ protocol: "offer-updates-v2" })],
    ["wrong schema version", ready({ schemaVersion: 2 })],
    ["unknown frame type", ready({ type: "heartbeat" })],
    ["uppercase stream id", ready({ streamId: STREAM.toUpperCase() })],
    ["short stream id", ready({ streamId: "abc" })],
    ["ready at a nonzero seq", ready({ seq: 1 })],
    ["negative timestamp", ready({ ts: -1 })],
    ["fractional timestamp", ready({ ts: 1.5 })],
    ["numeric height", ready({ blockL2Height: 42 })],
    ["zero-prefixed height", ready({ blockL2Height: "042" })],
    ["zero height", ready({ blockL2Height: "0" })],
    ["over-u64 height", ready({ blockL2Height: "18446744073709551616" })],
    ["update at seq 0", update({ seq: 0 })],
    ["update at a negative seq", update({ seq: -3 })],
    ["update at a fractional seq", update({ seq: 2.5 })],
    ["update with no event", update({ event: null })],
    ["event with no type", update({ event: { timestamp: 1 } })],
    ["event with no timestamp", update({ event: { type: "offer_expired" } })],
    ["array instead of a frame", ["ready"]],
    ["string instead of a frame", "ready"],
    ["null", null],
  ];
  for (const [label, value] of cases) {
    expect([label, parseOfferUpdatesFrame(value)]).toEqual([label, null]);
  }
});

test("u64 heights are compared as tokens, never through Number", () => {
  expect(parseBlockL2Height("18446744073709551615")).toBe("18446744073709551615");
  expect(parseBlockL2Height("18446744073709551616")).toBe(undefined);
  // Both of these lose their distinction the moment they become doubles.
  expect(heightAtLeast("9007199254740993", "9007199254740992")).toBe(true);
  expect(heightAtLeast("9007199254740992", "9007199254740993")).toBe(false);
  expect(heightAtLeast("10", "9")).toBe(true);
  expect(heightAtLeast("9", "10")).toBe(false);
  expect(heightAtLeast("42", "42")).toBe(true);
});

test("sequence continuity is same-stream and exactly plus one", () => {
  expect(followsInSequence({ streamId: STREAM, seq: 4 }, { streamId: STREAM, seq: 5 })).toBe(true);
  expect(followsInSequence({ streamId: STREAM, seq: 4 }, { streamId: STREAM, seq: 6 })).toBe(false);
  expect(followsInSequence({ streamId: STREAM, seq: 4 }, { streamId: STREAM, seq: 4 })).toBe(false);
  expect(followsInSequence({ streamId: STREAM, seq: 4 }, { streamId: STREAM, seq: 3 })).toBe(false);
  // A renumbered stream is a DIFFERENT subscription, not a continuation.
  expect(followsInSequence({ streamId: STREAM, seq: 4 }, { streamId: "f".repeat(32), seq: 5 }))
    .toBe(false);
});

test("encoding refuses to emit anything the parser would reject", () => {
  expect(() => encodeOfferUpdatesFrame({ ...(ready() as any), seq: 9 } as OfferUpdatesFrame))
    .toThrow(/noncanonical/);
  expect(() => encodeOfferUpdatesFrame({ ...(update() as any), event: {} } as OfferUpdatesFrame))
    .toThrow(/noncanonical/);
  const text = encodeOfferUpdatesFrame(parseOfferUpdatesFrame(update()) as OfferUpdatesFrame);
  expect(decodeOfferUpdatesFrame(text)).toEqual(parseOfferUpdatesFrame(update()) as any);
});

test("a text frame that is not JSON is a refusal, never a skip", () => {
  expect(decodeOfferUpdatesFrame("not json")).toBe(null);
  expect(decodeOfferUpdatesFrame("")).toBe(null);
  expect(decodeOfferUpdatesFrame("[]")).toBe(null);
});
