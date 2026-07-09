/**
 * MIP-0006 — derive gives/wants from a proven Transaction's imbalances.
 *
 * For each token type, net imbalance `delta = inputs − outputs`:
 *   delta > 0 ⇒ give; delta < 0 ⇒ want (amount −delta).
 * Each leg is tagged SHIELDED or UNSHIELDED from the token's value layer.
 */

import type { TokenType, UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";

import type { TokenKind, TokenLeg } from "./types.ts";

export class UnknownTokenTagError extends Error {
  constructor(public readonly tag: string) {
    super(`Unknown token tag "${tag}"`);
    this.name = "UnknownTokenTagError";
  }
}

function tagToKind(tag: string): TokenKind {
  if (tag === "shielded") return "SHIELDED";
  if (tag === "unshielded") return "UNSHIELDED";
  throw new UnknownTokenTagError(tag);
}

/**
 * Derive give/want legs from the transaction's per-segment imbalances, merged
 * across the guaranteed segment + every intent/fallible segment.
 * `dust` is ignored; any other unexpected tag throws UnknownTokenTagError.
 *
 * Same token color on different layers is kept separate (keyed by color+kind).
 */
export function deriveTokenLegs(
  tx: UnprovenTransaction,
): { gives: TokenLeg[]; wants: TokenLeg[] } {
  const intentKeys = (tx as any).intents
    ? Array.from((tx as any).intents.keys() as Iterable<number>)
    : [];
  const fallibleKeys = tx.fallibleOffer
    ? Array.from(tx.fallibleOffer.keys() as Iterable<number>)
    : [];
  const segmentIds = Array.from(
    new Set<number>([0, ...intentKeys, ...fallibleKeys]),
  );

  // key = `${kind}:${token}` so shielded and unshielded of the same color
  // do not cancel each other.
  const merged = new Map<string, { token: string; kind: TokenKind; delta: bigint }>();

  for (const segId of segmentIds) {
    for (const [tokenType, delta] of tx.imbalances(segId)) {
      const tt = tokenType as TokenType;
      if (tt.tag === "dust") continue;
      if (tt.tag !== "shielded" && tt.tag !== "unshielded") {
        throw new UnknownTokenTagError(String((tt as any).tag));
      }
      const kind = tagToKind(tt.tag);
      const token = tt.raw.toLowerCase();
      const key = `${kind}:${token}`;
      const prev = merged.get(key);
      if (prev) {
        prev.delta += delta;
      } else {
        merged.set(key, { token, kind, delta });
      }
    }
  }

  const gives: TokenLeg[] = [];
  const wants: TokenLeg[] = [];
  for (const { token, kind, delta } of merged.values()) {
    if (delta > 0n) {
      gives.push({ token, amount: delta.toString(), type: kind });
    } else if (delta < 0n) {
      wants.push({ token, amount: (-delta).toString(), type: kind });
    }
  }
  return { gives, wants };
}
