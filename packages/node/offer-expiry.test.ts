import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  archiveOfferAtExpiry,
  deriveOfferExpiry,
  hasTransactionIntents,
  requireApplicableOfferExpiry,
} from "./state-machine.ts";

const BASE = Date.parse("2026-08-13T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

test("root-only expiry uses the root window", () => {
  expect(deriveOfferExpiry(iso(30_000), null, iso(60_000)).toISOString())
    .toBe(iso(30_000));
});

test("intent-only expiry uses the earliest Intent TTL", () => {
  expect(deriveOfferExpiry(null, iso(20_000), iso(60_000)).toISOString())
    .toBe(iso(20_000));
});

test("mixed expiry chooses a shorter Intent TTL over the root window", () => {
  expect(deriveOfferExpiry(iso(60_000), iso(10_000), iso(120_000)).toISOString())
    .toBe(iso(10_000));
});

test("mixed expiry chooses a shorter root window over the Intent TTL", () => {
  expect(deriveOfferExpiry(iso(10_000), iso(60_000), iso(120_000)).toISOString())
    .toBe(iso(10_000));
});

test("publication fallback is used only when neither ledger constraint applies", () => {
  expect(deriveOfferExpiry(null, undefined, iso(90_000)).toISOString())
    .toBe(iso(90_000));
  // An unused fallback is deliberately not parsed: it cannot shorten or
  // invalidate a transaction that already has an applicable ledger expiry.
  expect(deriveOfferExpiry(iso(10_000), null, "not-a-date").toISOString())
    .toBe(iso(10_000));
});

test("missing or invalid applicable expiry fails closed", () => {
  expect(() => deriveOfferExpiry("not-a-date", null, iso(90_000)))
    .toThrow("invalid root offer expiry");
  expect(() => deriveOfferExpiry(null, "not-a-date", iso(90_000)))
    .toThrow("invalid intent offer expiry");
  expect(() => deriveOfferExpiry(null, null, "not-a-date"))
    .toThrow("invalid fallback offer expiry");
  expect(() => deriveOfferExpiry(null, null, null))
    .toThrow("offer expiry was not derived");
});

test("an applicable root or Intent constraint may not silently fall through", () => {
  expect(requireApplicableOfferExpiry("root", false, null)).toBeNull();
  expect(() => requireApplicableOfferExpiry("root", true, null))
    .toThrow("root offer expiry was not derived");
  expect(() => requireApplicableOfferExpiry("root", true, Number.NaN))
    .toThrow("invalid root offer expiry");
  expect(() => requireApplicableOfferExpiry("intent", true, undefined))
    .toThrow("intent offer expiry was not derived");
  expect(requireApplicableOfferExpiry("intent", true, iso(5_000))?.toISOString())
    .toBe(iso(5_000));
});

test("Intent applicability uses the ledger keyed-map values API", () => {
  expect(hasTransactionIntents({ intents: new Map() })).toBe(false);
  expect(hasTransactionIntents({ intents: new Map([[7, { ttl: iso(5_000) }]]) })).toBe(true);
  expect(hasTransactionIntents({})).toBe(false);
  expect(() => hasTransactionIntents({ intents: { size: 1 } }))
    .toThrow("transaction intents are not iterable");
});

test("the real TTL transition yields an id plus deterministic persisted-expiry cutoff", () => {
  const transition = archiveOfferAtExpiry({
    parsedInput: { offerId: 42 },
    blockTimestamp: BASE,
    emit: () => { throw new Error("an early/no-op cleanup must not emit"); },
  });
  const first = transition.next();
  expect(first.done).toBe(false);
  const [queryIR, params] = first.value as any;
  expect(queryIR.statement).toContain("metadata_expires_at <= :expires_at_cutoff!");
  expect(params.offer_file_id).toBe(42);
  expect(params.expires_at_cutoff).toBeInstanceOf(Date);
  expect(params.expires_at_cutoff.toISOString()).toBe(iso(0));
  expect(params.archived_at).toBeInstanceOf(Date);
  expect(params.archived_at.toISOString()).toBe(iso(0));
  expect(transition.next([]).done).toBe(true);
});

test("state-machine mutation catches propagate into the application savepoint", () => {
  // JavaScript failures must reach withAppInputSavepoint so successful writes
  // earlier in the same input are reverted. SQL execution failures are not
  // injected back into the generator by Effectstream 0.103.1; they abort the
  // PostgreSQL transaction and take the runtime's outer full-block rollback.
  const source = readFileSync(new URL("./state-machine.ts", import.meta.url), "utf8");
  for (const marker of [
    "Failed to record commitment",
    "Failed to archive offer for nullifier",
    "Failed to archive offer for unshielded spend",
    "Failed to record created unshielded UTXO",
    "Failed to record zswap root",
    "Failed to save offer file",
    "Failed to archive offer by TTL",
  ]) {
    const markerAt = source.indexOf(marker);
    expect(markerAt).toBeGreaterThan(-1);
    expect(source.slice(markerAt, markerAt + 300)).toContain("throw e;");
  }
});
