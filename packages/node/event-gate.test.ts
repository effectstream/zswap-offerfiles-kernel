// The pre-commit publication race, pinned.
//
// Every emit site lives inside an STM transition, i.e. inside the runtime's
// block transaction. Publishing synchronously there let consumers act on state
// that was not committed — and they act on a DIFFERENT connection, so a
// pair-stats upsert could see nothing, write nothing, and never retry, while
// SSE announced a transition a ROLLBACK then erased.
//
// These cases assert the gate's contract directly. They are FAST and DB-free on
// purpose; the integration test that holds a real PostgreSQL block transaction
// open (REMAINING-ISSUES #5(ii)) is still owed and asserts the same properties
// against the real runtime rather than against markBlockCommitted().
import { afterEach, expect, test } from "bun:test";

const {
  eventBus,
  emitAppEvent,
  markBlockCommitted,
  pendingEventCount,
  __resetEventGateForTests,
} = await import("./event-bus.ts");

/** Collect everything the bus publishes, in order. */
function recorder() {
  const seen: any[] = [];
  const fn = (e: any) => seen.push(e);
  eventBus.on("app_event", fn);
  return { seen, stop: () => eventBus.off("app_event", fn) };
}

afterEach(() => __resetEventGateForTests());

test("an event from an uncommitted block is NOT published", () => {
  const r = recorder();
  emitAppEvent({ type: "offer_expired", offerId: 1 }, 10);
  expect(r.seen).toEqual([]);          // the defect: this used to fire immediately
  expect(pendingEventCount()).toBe(1); // held, not dropped
  r.stop();
});

test("it IS published once its block is observed committed", () => {
  const r = recorder();
  emitAppEvent({ type: "offer_expired", offerId: 1 }, 10);
  markBlockCommitted(10);
  expect(r.seen.map((e) => e.offerId)).toEqual([1]);
  expect(pendingEventCount()).toBe(0);
  r.stop();
});

test("KNOWN LIMIT: a rolled-back block's events are NOT dropped", () => {
  // Documenting real behaviour, not asserting a desirable one. This buffer
  // lives in our process, not in the aborted transaction, so it cannot see a
  // ROLLBACK: block 11's events survive and release as soon as a later height
  // is observed. The complete answer is the runtime's per-block buffer, which
  // DOES go out of scope on rollback — REMAINING-ISSUES #5(ii)'s data.emit
  // migration. If that migration lands, this test should start failing and be
  // replaced by its inverse.
  const r = recorder();
  emitAppEvent({ type: "offer_expired", offerId: 11 }, 11);
  markBlockCommitted(12);
  expect(r.seen.map((e) => e.offerId)).toEqual([11]);
  r.stop();
});

test("a block RETRY does not double-publish", () => {
  // The mitigation that makes the limit above survivable: the runtime
  // reprocesses a rolled-back block from BEGIN, so the same events are emitted
  // again at the same height. Without de-duplication both copies would release
  // and pair_stats would count the settlement twice — an extra trade_count
  // increment is the same class of defect as a fabricated fill.
  const r = recorder();
  emitAppEvent({ type: "offer_consumed", offerId: 7 }, 4); // attempt 1
  emitAppEvent({ type: "offer_consumed", offerId: 7 }, 4); // retry, same block
  expect(pendingEventCount()).toBe(1);
  markBlockCommitted(4);
  expect(r.seen.map((e) => e.offerId)).toEqual([7]);
  r.stop();
});

test("de-duplication is per block, not global", () => {
  // The same offer legitimately produces events in different blocks; collapsing
  // those would silently drop real transitions.
  const r = recorder();
  emitAppEvent({ type: "offer_consumed", offerId: 7 }, 4);
  emitAppEvent({ type: "offer_consumed", offerId: 7 }, 5);
  expect(pendingEventCount()).toBe(2);
  markBlockCommitted(5);
  expect(r.seen.length).toBe(2);
  r.stop();
});

test("events release in block order, and only up to the observed height", () => {
  const r = recorder();
  emitAppEvent({ type: "offer_expired", offerId: 1 }, 5);
  emitAppEvent({ type: "offer_expired", offerId: 2 }, 6);
  emitAppEvent({ type: "offer_expired", offerId: 3 }, 7);
  markBlockCommitted(6);
  expect(r.seen.map((e) => e.offerId)).toEqual([1, 2]); // 7 still held
  expect(pendingEventCount()).toBe(1);
  markBlockCommitted(7);
  expect(r.seen.map((e) => e.offerId)).toEqual([1, 2, 3]);
  r.stop();
});

test("multiple events from the SAME block release together", () => {
  // The unshielded-spend transition emits one offer_consumed per archived row;
  // a partial release would let a consumer see one side of a settlement.
  const r = recorder();
  emitAppEvent({ type: "offer_consumed", offerId: 1 }, 9);
  emitAppEvent({ type: "offer_consumed", offerId: 2 }, 9);
  markBlockCommitted(9);
  expect(r.seen.map((e) => e.offerId)).toEqual([1, 2]);
  r.stop();
});

test("the observed height never goes backwards", () => {
  // A lagging read or a reconnect must not re-gate what was already released,
  // nor hold back a later block.
  const r = recorder();
  markBlockCommitted(20);
  markBlockCommitted(5); // ignored
  emitAppEvent({ type: "offer_expired", offerId: 1 }, 15);
  expect(r.seen.map((e) => e.offerId)).toEqual([1]); // 15 <= 20, released at once
  r.stop();
});

test("an event with NO block height publishes immediately", () => {
  // API-path rejections are emitted outside any transition. There is no
  // transaction to outlive, so gating them would hold them forever.
  const r = recorder();
  emitAppEvent({ type: "offer_rejected", code: "MALFORMED", blockHeight: 0 });
  expect(r.seen.length).toBe(1);
  expect(pendingEventCount()).toBe(0);
  r.stop();
});

test("a re-entrant listener cannot see a half-drained buffer", () => {
  // The flush splices before emitting. If it emitted while iterating, a
  // listener that emits during delivery could observe or mutate a partially
  // drained buffer.
  const seen: any[] = [];
  const fn = (e: any) => {
    seen.push(e.offerId);
    if (e.offerId === 1) expect(pendingEventCount()).toBe(0);
  };
  eventBus.on("app_event", fn);
  emitAppEvent({ type: "offer_expired", offerId: 1 }, 3);
  emitAppEvent({ type: "offer_expired", offerId: 2 }, 3);
  markBlockCommitted(3);
  expect(seen).toEqual([1, 2]);
  eventBus.off("app_event", fn);
});

// ── Dedup key: content address, not row id (phase (d), ported from #38) ─────

test("offer_consumed de-duplicates on the offer hash, not the row id", () => {
  // `offerId` is a local SERIAL. A block RETRY that re-inserts the offer row
  // gives the SAME offer a DIFFERENT id, so an id-keyed identity sees two
  // distinct events and releases both — one settlement, two `trade_count`
  // increments. The offer hash is the content address: it is stable across
  // reprocessing, across resyncs, and across deployments, which is exactly
  // what a de-duplication key has to be.
  const r = recorder();
  emitAppEvent({ type: "offer_consumed", offerId: 7, offerHash: "aa11" }, 4);
  emitAppEvent({ type: "offer_consumed", offerId: 9, offerHash: "aa11" }, 4);
  expect(pendingEventCount()).toBe(1);
  markBlockCommitted(4);
  expect(r.seen.length).toBe(1);
  r.stop();
});

test("distinct offers in one block stay distinct even when hashes are present", () => {
  // The guard on the case above: preferring the hash must not collapse two
  // genuinely different offers that happen to share a block.
  const r = recorder();
  emitAppEvent({ type: "offer_consumed", offerId: 1, offerHash: "aa11" }, 6);
  emitAppEvent({ type: "offer_consumed", offerId: 2, offerHash: "bb22" }, 6);
  expect(pendingEventCount()).toBe(2);
  markBlockCommitted(6);
  expect(r.seen.map((e) => e.offerHash)).toEqual(["aa11", "bb22"]);
  r.stop();
});

test("an offer without a hash still de-duplicates on the row id", () => {
  // Rows inserted out-of-band before migration 005 carry no hash; the gate must
  // fall back rather than collapse them all onto one empty-string identity.
  const r = recorder();
  emitAppEvent({ type: "offer_expired", offerId: 3 }, 8);
  emitAppEvent({ type: "offer_expired", offerId: 3 }, 8);
  emitAppEvent({ type: "offer_expired", offerId: 4 }, 8);
  expect(pendingEventCount()).toBe(2);
  markBlockCommitted(8);
  expect(r.seen.map((e) => e.offerId)).toEqual([3, 4]);
  r.stop();
});
