import { EventEmitter } from "node:events";

// App events, published to in-process consumers ONLY AFTER the block that
// produced them has committed.
//
// THE BUG THIS EXISTS TO PREVENT. Every emit site is inside an STM transition,
// which runs inside the runtime's block transaction (`BEGIN` … `COMMIT` in
// process-blocks.ts). A synchronous `eventBus.emit` there published state that
// was not yet committed — and the consumers act on a DIFFERENT connection:
// api.ts's pair-stats listener runs `upsertPairStatsByOfferId` on its own pool,
// and the SSE route forwards to clients immediately. So a consumer could read
// through its own connection, see nothing (the archive and same-block create
// rows are still invisible), write nothing, and never retry — while SSE
// announced a lifecycle transition that a `ROLLBACK` then erased.
//
// It is not hypothetical ordering pedantry: `Midnight-UnshieldedSpend` is
// configured before `Midnight-UnshieldedCreate` (config.dev.ts), so the spend's
// archive and its event precede the same block's create rows by construction,
// and PGlite's scheduling can hide the whole thing on a dev box while
// PostgreSQL does not.
//
// THE GATE. Events are buffered with the block height that produced them and
// released only once a SEPARATE connection can see that block. The runtime
// writes the block record inside the same transaction (process-blocks.ts STEP
// 1, `saveLastBlock`), so a reader observing height N is proof that N's
// `COMMIT` returned — which is precisely the signal we need, and it needs no
// framework change.
//
// WHAT THIS GATE DOES NOT DO, stated plainly: it cannot observe a ROLLBACK.
// The buffer lives in this process, not in the aborted transaction, so a
// rolled-back block's events survive and are released once a LATER height is
// seen. The runtime reprocesses such a block, so the practical failure is
// DUPLICATES rather than phantoms; `identity` below de-duplicates a retry that
// re-emits the same events, which covers it in the ordinary case. The exact
// answer is the runtime's own per-block buffer — see the migration note below.
//
// LONGER TERM (REMAINING-ISSUES #5(ii)). effectstream already offers this as a
// first-class mechanism: `data.emit(...)` on every STF input, buffered per
// input, promoted per block, and flushed by the runtime only after `COMMIT`
// (its own invariants I1/I2/I5). That path publishes to MQTT, which is what an
// OUT-OF-PROCESS consumer — the posted-price solver in PR #38 — actually needs.
// This module is the in-process correctness fix; migrating the transport to
// `data.emit` is the follow-up, and the two compose: the gate below becomes
// redundant the moment every consumer reads from the runtime's feed.
export type AppEvent =
  | { type: "offer_indexed"; offerId: number; offerHash: string; blockHeight: number | string; gives: unknown[]; wants: unknown[] }
  // `offerId` is the local SERIAL row id, which diverges across deployments and
  // across a resync; `offerHash` is the content address the REST API exposes,
  // and the only key with which a consumer can correlate an event to an offer.
  // It is optional because rows inserted out-of-band carry no hash (migration
  // 005), not because emitters may omit it — the archive queries return it.
  | {
      type: "offer_consumed";
      offerId: number;
      offerHash?: string;
      nullifier?: string;
      unshieldedSpend?: { owner: string; intentHash: string; outputNo: number };
    }
  | { type: "offer_expired"; offerId: number; offerHash?: string }
  | { type: "token_minted"; name: string; color: string; kind?: string }
  | {
      type: "offer_rejected";
      code?: string;
      reason?: string;
      offerHash?: string;
      blockHeight: number | string;
    };

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

/** Events awaiting proof that their block committed, oldest first. */
const pending: { atHeight: number; key: string; event: AppEvent }[] = [];

/**
 * Identity of an event within its block, for retry de-duplication.
 *
 * The runtime REPROCESSES a rolled-back block from `BEGIN` (process-blocks.ts).
 * This buffer lives in our process, not in that transaction, so it cannot see
 * the rollback: the first attempt's events stay queued and the retry appends
 * its own. Releasing both would double-count — an extra `offer_consumed` is an
 * extra `trade_count` increment, the same class of defect as a fabricated fill.
 * Keying by (height, type, subject) makes a retry that produces the SAME events
 * idempotent.
 *
 * RESIDUAL, stated rather than hidden: if a retry produces DIFFERENT events for
 * the same height — a classification that changed between attempts — the stale
 * ones are still released. Only the runtime's own per-block buffer can be exact
 * there, because only it knows the transaction aborted. That is the argument
 * for finishing the `data.emit` migration (#5(ii)), not a reason to trust this
 * gate less than it deserves: it closes the uncommitted-read defect outright.
 */
function identity(e: AppEvent): string {
  // The hash is preferred over the row id because a retry that RE-INSERTS the
  // offer hands the same offer a different SERIAL, and an id-keyed identity
  // would then read the two attempts as two settlements. The id remains the
  // fallback for events that carry no hash — collapsing those onto one empty
  // subject would de-duplicate unrelated offers into a single release.
  const subject = "offerHash" in e && e.offerHash ? e.offerHash
    : "offerId" in e ? String(e.offerId)
    : "color" in e ? String(e.color)
    : "";
  return `${e.type}:${subject}`;
}
/** Highest block height a separate connection has confirmed committed. */
let committedHeight = -1;

function flush(): void {
  // Splice before emitting: a listener that emits re-entrantly must not see a
  // half-drained buffer, and must not have its own event released early.
  const ready: AppEvent[] = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]!.atHeight <= committedHeight) ready.unshift(...pending.splice(i, 1).map((p) => p.event));
  }
  for (const e of ready) eventBus.emit("app_event", e);
}

/**
 * Publish an app event once block `atHeight` is known committed.
 *
 * Callers are STM transitions, where `data.blockHeight` is the producing block.
 * Anything emitted OUTSIDE a transition (an API-path rejection, say) has no
 * block to wait for and is published immediately — there is no transaction to
 * outlive, so gating it would delay it forever.
 */
export function emitAppEvent(event: AppEvent, atHeight?: number | string): void {
  const h = atHeight === undefined ? NaN : Number(atHeight);
  if (!Number.isFinite(h)) {
    eventBus.emit("app_event", event);
    return;
  }
  if (h <= committedHeight) {
    eventBus.emit("app_event", event);
    return;
  }
  const key = identity(event);
  // Idempotent under block retry — see `identity`.
  if (pending.some((p) => p.atHeight === h && p.key === key)) return;
  pending.push({ atHeight: h, key, event });
}

/**
 * Report the highest block height observed as committed, from a connection
 * OTHER than the one running the block transaction. Monotonic: a lower reading
 * (a lagging replica read, a reconnect) never retracts a release.
 */
export function markBlockCommitted(height: number | string): void {
  const h = Number(height);
  if (!Number.isFinite(h) || h <= committedHeight) return;
  committedHeight = h;
  flush();
}

/** Buffered-event count — for tests and diagnostics. */
export function pendingEventCount(): number {
  return pending.length;
}

/** Test-only: restore module state between cases. */
export function __resetEventGateForTests(): void {
  pending.length = 0;
  committedHeight = -1;
}
