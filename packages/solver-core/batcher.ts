// Production-pure transaction algebra retained after the solver moved to the
// Midnight Intents relay. No network request or legacy batcher acknowledgement
// parser belongs on this exported surface.

import type { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";

/** Merge N independently-proven offers into one atomic, token-balanced tx.
 *  Each offer must already be finalized (proven + bound) by its own owner —
 *  zswap requires each spend be proven by its key, so we prove per-owner first
 *  and only merge the proven halves. */
export function mergeFinalized(offers: FinalizedTransaction[]): FinalizedTransaction {
  if (offers.length === 0) throw new Error("mergeFinalized: no offers");
  let merged = offers[0];
  for (let i = 1; i < offers.length; i++) {
    merged = (merged as any).merge(offers[i]) as FinalizedTransaction;
  }
  return merged;
}

export interface Imbalance {
  seg: number;
  tag: string;
  raw: string;
  amount: bigint;
}

/** All per-segment token imbalances. A balanced swap leaves only `dust`
 *  (which the batcher fills); any non-dust entry means the merged tx is NOT a
 *  complete swap and must NOT be settled. */
/** Raised when a transaction's imbalances cannot be read at all.
 *
 *  Distinct from "balanced": a missing method, a changed SDK shape, or a thrown
 *  getter means the safety check did not run. Reporting that as an empty
 *  imbalance list made the guard below fail OPEN — it would wave through
 *  exactly the transactions it exists to stop. */
export class ImbalanceUnreadableError extends Error {
  constructor(reason: string) {
    super(`cannot read transaction imbalances: ${reason}`);
    this.name = "ImbalanceUnreadableError";
  }
}

const MAX_LEDGER_SEGMENT = 0xffff;

/** ledger-v8 declares token-bearing segments in three places: guaranteed
 * segment 0, intent keys, and fallible-offer keys. Segment IDs are arbitrary
 * u16 values (they are not a dense 0..N range), so guessing 0/1 is unsafe. */
export function declaredLedgerSegments(tx: FinalizedTransaction): number[] {
  if (!tx || typeof tx !== "object") {
    throw new ImbalanceUnreadableError("transaction is not an object");
  }

  const segments = new Set<number>([0]);
  for (const field of ["intents", "fallibleOffer"] as const) {
    let collection: unknown;
    try {
      collection = (tx as any)[field];
    } catch {
      throw new ImbalanceUnreadableError(`transaction.${field} could not be read`);
    }
    if (collection === undefined || collection === null) continue;
    if (!(collection instanceof Map)) {
      throw new ImbalanceUnreadableError(`transaction.${field} is not a keyed collection`);
    }
    try {
      for (const segment of (collection as any).keys() as Iterable<unknown>) {
        if (
          typeof segment !== "number" ||
          !Number.isInteger(segment) ||
          segment < 0 ||
          segment > MAX_LEDGER_SEGMENT
        ) {
          throw new ImbalanceUnreadableError(
            `transaction.${field} contains an invalid ledger segment`,
          );
        }
        segments.add(segment);
      }
    } catch (err) {
      if (err instanceof ImbalanceUnreadableError) throw err;
      throw new ImbalanceUnreadableError(`transaction.${field} keys could not be enumerated`);
    }
  }
  return [...segments].sort((a, b) => a - b);
}

export function tokenImbalances(tx: FinalizedTransaction): Imbalance[] {
  if (typeof (tx as any)?.imbalances !== "function") {
    throw new ImbalanceUnreadableError("transaction exposes no imbalances()");
  }

  const out: Imbalance[] = [];
  for (const seg of declaredLedgerSegments(tx)) {
    let m: unknown;
    try {
      m = (tx as any).imbalances(seg);
    } catch {
      throw new ImbalanceUnreadableError(`declared segment ${seg} could not be read`);
    }
    if (!(m instanceof Map)) {
      throw new ImbalanceUnreadableError(`declared segment ${seg} returned no imbalance map`);
    }
    try {
      for (const [k, v] of (m as any).entries() as Iterable<[unknown, bigint]>) {
        if (typeof v !== "bigint") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned a non-bigint amount`);
        }
        if (!k || typeof k !== "object") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned an invalid token kind`);
        }
        const tag = (k as any).tag;
        const raw = tag === "dust" ? "dust" : (k as any).raw;
        if (tag !== "dust" && tag !== "shielded" && tag !== "unshielded") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned unknown token tag`);
        }
        if (typeof raw !== "string") {
          throw new ImbalanceUnreadableError(`segment ${seg} returned an invalid token value`);
        }
        if (v !== 0n) out.push({ seg, tag, raw, amount: v });
      }
    } catch (err) {
      if (err instanceof ImbalanceUnreadableError) throw err;
      throw new ImbalanceUnreadableError(`segment ${seg} imbalance map could not be enumerated`);
    }
  }
  return out;
}

/** Non-dust imbalances — these must be empty for a tx to be a settleable swap.
 *  (Dust imbalance is expected; the batcher covers it.) */
export function nonDustImbalances(tx: FinalizedTransaction): Imbalance[] {
  return tokenImbalances(tx).filter((i) => i.tag !== "dust");
}

export function describeImbalances(tx: FinalizedTransaction): string {
  return JSON.stringify(
    tokenImbalances(tx).map((i) => ({ seg: i.seg, tag: i.tag, raw: i.raw.slice(0, 10), amount: i.amount.toString() })),
  );
}
