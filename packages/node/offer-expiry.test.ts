import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  archiveOfferAtExpiry,
  deriveOfferExpiry,
  earliestDustSpendDeadline,
  hasTransactionIntents,
  offerLifetimeSeconds,
  requireApplicableOfferExpiry,
} from "./state-machine.ts";

const BASE = Date.parse("2026-08-13T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

// 00056 FR-002: expiry = the earliest REAL ledger limit that applies —
// root deadline (shielded inputs; they carry no TTL), earliest intent TTL
// (intents), ctime + DUST grace (DUST spends) — and the fallback only when
// none applies. No cap on top.

test("shielded-only expiry is the root deadline", () => {
  expect(deriveOfferExpiry({ root: iso(30_000), fallback: iso(60_000) }).toISOString())
    .toBe(iso(30_000));
});

test("unshielded-only expiry is the earliest Intent TTL", () => {
  expect(deriveOfferExpiry({ intent: iso(20_000), fallback: iso(60_000) }).toISOString())
    .toBe(iso(20_000));
});

test("mixed expiry chooses a shorter Intent TTL over the root deadline", () => {
  expect(deriveOfferExpiry({ root: iso(60_000), intent: iso(10_000), fallback: iso(120_000) }).toISOString())
    .toBe(iso(10_000));
});

test("mixed expiry chooses a shorter root deadline over the Intent TTL", () => {
  expect(deriveOfferExpiry({ root: iso(10_000), intent: iso(60_000), fallback: iso(120_000) }).toISOString())
    .toBe(iso(10_000));
});

test("a DUST spend's grace deadline applies when it is the earliest limit", () => {
  expect(deriveOfferExpiry({
    root: iso(60_000),
    intent: iso(50_000),
    dust: iso(40_000),
    fallback: iso(120_000),
  }).toISOString()).toBe(iso(40_000));
  expect(deriveOfferExpiry({ intent: iso(5_000), dust: iso(40_000), fallback: iso(120_000) }).toISOString())
    .toBe(iso(5_000));
});

test("the fallback never caps a ledger limit (no OFFER_TTL_SECONDS ceiling any more)", () => {
  // Before 00056 every offer was also capped at block + OFFER_TTL_SECONDS.
  const fourteenDaysMs = 14 * 24 * 3_600_000;
  expect(deriveOfferExpiry({ intent: iso(fourteenDaysMs - 60_000), fallback: iso(600_000) }).toISOString())
    .toBe(iso(fourteenDaysMs - 60_000));
  expect(deriveOfferExpiry({ root: iso(fourteenDaysMs), fallback: iso(1_000) }).toISOString())
    .toBe(iso(fourteenDaysMs));
});

test("the fallback is used only when no ledger limit applies", () => {
  expect(deriveOfferExpiry({ root: null, intent: undefined, dust: null, fallback: iso(90_000) }).toISOString())
    .toBe(iso(90_000));
  // An unused fallback is deliberately not parsed: it cannot shorten or
  // invalidate a transaction that already has an applicable ledger expiry.
  expect(deriveOfferExpiry({ root: iso(10_000), fallback: "not-a-date" }).toISOString())
    .toBe(iso(10_000));
});

test("missing or invalid applicable expiry fails closed", () => {
  expect(() => deriveOfferExpiry({ root: "not-a-date", fallback: iso(90_000) }))
    .toThrow("invalid root offer expiry");
  expect(() => deriveOfferExpiry({ intent: "not-a-date", fallback: iso(90_000) }))
    .toThrow("invalid intent offer expiry");
  expect(() => deriveOfferExpiry({ dust: "not-a-date", fallback: iso(90_000) }))
    .toThrow("invalid dust offer expiry");
  expect(() => deriveOfferExpiry({ fallback: "not-a-date" }))
    .toThrow("invalid fallback offer expiry");
  expect(() => deriveOfferExpiry({ fallback: null }))
    .toThrow("offer expiry was not derived");
});

test("earliestDustSpendDeadline: min over intents with DUST spends of ctime + grace", () => {
  const GRACE_S = 10_800;
  const ctime = (offsetMs: number) => new Date(BASE + offsetMs);
  const tx = {
    intents: new Map<number, unknown>([
      [1, { ttl: iso(0), dustActions: { ctime: ctime(20_000), spends: [{}] } }],
      [2, { ttl: iso(0), dustActions: { ctime: ctime(5_000), spends: [{}, {}] } }],
      // Registration only: no spend, no deadline.
      [3, { ttl: iso(0), dustActions: { ctime: ctime(-1_000_000), spends: [], registrations: [{}] } }],
      [4, { ttl: iso(0) }],
    ]),
  };
  expect(earliestDustSpendDeadline(tx, GRACE_S)?.toISOString()).toBe(iso(5_000 + GRACE_S * 1000));
  expect(earliestDustSpendDeadline({ intents: new Map([[1, { ttl: iso(0) }]]) }, GRACE_S)).toBeNull();
  expect(earliestDustSpendDeadline({}, GRACE_S)).toBeNull();
  expect(() => earliestDustSpendDeadline(
    { intents: new Map([[1, { dustActions: { ctime: "not-a-date", spends: [{}] } }]]) },
    GRACE_S,
  )).toThrow("invalid dust offer expiry");
});

test("offerLifetimeSeconds: whole seconds from creation to expiry, never negative", () => {
  expect(offerLifetimeSeconds(BASE + 7_200_000, BASE)).toBe(7_200);
  expect(offerLifetimeSeconds(BASE + 7_200_999, BASE)).toBe(7_200); // rounded down
  expect(offerLifetimeSeconds(BASE + 1_209_600_000, BASE)).toBe(1_209_600);
  expect(offerLifetimeSeconds(BASE - 5_000, BASE)).toBe(0);
  expect(() => offerLifetimeSeconds(Number.NaN, BASE)).toThrow("invalid offer lifetime bounds");
});

test("an applicable root or Intent constraint may not silently fall through", () => {
  expect(requireApplicableOfferExpiry("root", false, null)).toBeNull();
  expect(() => requireApplicableOfferExpiry("root", true, null))
    .toThrow("root offer expiry was not derived");
  expect(() => requireApplicableOfferExpiry("root", true, Number.NaN))
    .toThrow("invalid root offer expiry");
  expect(() => requireApplicableOfferExpiry("intent", true, undefined))
    .toThrow("intent offer expiry was not derived");
  expect(() => requireApplicableOfferExpiry("dust", true, null))
    .toThrow("dust offer expiry was not derived");
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
