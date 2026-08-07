// In-memory mirror of the node's live offer book.
//
// Pure state: no IO, no timers. `sse-sync.ts` drives it from the SSE stream and
// the REST list. Offers are keyed by content hash — the node's numeric row id
// is local to that deployment and appears in events only, never in REST.

import type { ApiZswap } from "@zswap-da/solver-core/api-client";

import { pairKey } from "./ladder.ts";

export type LegKind = "SHIELDED" | "UNSHIELDED";

export interface TokenLeg {
  token: string;
  amount: bigint;
  kind: LegKind;
}

export interface BookOffer {
  offerHash: string;
  gives: TokenLeg[];
  wants: TokenLeg[];
  /** Epoch ms, or null when the node published no expiry. A conservative floor:
   *  a shielded offer really dies when its proof's Merkle root leaves the
   *  chain's root window, which can be sooner than this on a quiet chain. */
  expiresAt: number | null;
  firstSeenAt: number | null;
  inputNullifiers: string[];
  /** The bech32m blob, cached on first fetch. Immutable — it is what the hash
   *  addresses — so it never needs refreshing. */
  blob?: string;
}

const toLeg = (leg: { token: string; amount: string; type: string }): TokenLeg => ({
  token: leg.token.toLowerCase(),
  amount: BigInt(leg.amount),
  kind: leg.type === "UNSHIELDED" ? "UNSHIELDED" : "SHIELDED",
});

const toEpochMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** Build a BookOffer from a REST list row or detail row. Returns null for a row
 *  with no content hash, which cannot be tracked or acted on. */
export function bookOfferFromApi(row: ApiZswap): BookOffer | null {
  if (!row.offerId) return null;
  return {
    offerHash: row.offerId.toLowerCase(),
    gives: row.computed.gives.map(toLeg),
    wants: row.computed.wants.map(toLeg),
    expiresAt: toEpochMs(row.computed.expiresAt),
    firstSeenAt: toEpochMs(row.computed.firstSeenAt),
    inputNullifiers: row.computed.inputNullifiers.map((n) => n.toLowerCase()),
    ...(row.offerBech32 ? { blob: row.offerBech32 } : {}),
  };
}

/** Offers with exactly one leg each way are the only ones a directed-pair index
 *  can describe; multi-leg offers stay in the book and are reachable through
 *  `all()`. */
export const isSingleLeg = (offer: BookOffer): boolean =>
  offer.gives.length === 1 && offer.wants.length === 1;

export interface ResyncDiff {
  added: string[];
  removed: string[];
}

export class Book {
  readonly #byHash = new Map<string, BookOffer>();
  readonly #hashByNullifier = new Map<string, string>();
  readonly #byPair = new Map<string, Set<string>>();

  get size(): number {
    return this.#byHash.size;
  }

  get(offerHash: string): BookOffer | undefined {
    return this.#byHash.get(offerHash.toLowerCase());
  }

  all(): BookOffer[] {
    return [...this.#byHash.values()];
  }

  hashes(): string[] {
    return [...this.#byHash.keys()];
  }

  /** Insert or replace. Replacing re-indexes, so a detail fetch that adds legs
   *  or a blob to a list-sourced row cannot leave a stale index entry. */
  upsert(offer: BookOffer): void {
    const hash = offer.offerHash.toLowerCase();
    if (this.#byHash.has(hash)) this.#unindex(hash);
    const stored: BookOffer = { ...offer, offerHash: hash };
    this.#byHash.set(hash, stored);
    for (const nullifier of stored.inputNullifiers) {
      this.#hashByNullifier.set(nullifier, hash);
    }
    if (isSingleLeg(stored)) {
      const key = pairKey(stored.gives[0].token, stored.wants[0].token);
      let bucket = this.#byPair.get(key);
      if (!bucket) {
        bucket = new Set();
        this.#byPair.set(key, bucket);
      }
      bucket.add(hash);
    }
  }

  #unindex(hash: string): void {
    const existing = this.#byHash.get(hash);
    if (!existing) return;
    for (const nullifier of existing.inputNullifiers) {
      if (this.#hashByNullifier.get(nullifier) === hash) {
        this.#hashByNullifier.delete(nullifier);
      }
    }
    if (isSingleLeg(existing)) {
      const key = pairKey(existing.gives[0].token, existing.wants[0].token);
      const bucket = this.#byPair.get(key);
      if (bucket) {
        bucket.delete(hash);
        if (bucket.size === 0) this.#byPair.delete(key);
      }
    }
  }

  remove(offerHash: string): boolean {
    const hash = offerHash.toLowerCase();
    if (!this.#byHash.has(hash)) return false;
    this.#unindex(hash);
    this.#byHash.delete(hash);
    return true;
  }

  /** Drop the offer that spends `nullifier`. The fallback path for a consumed
   *  event that carries no content hash. */
  removeByNullifier(nullifier: string): string | null {
    const hash = this.#hashByNullifier.get(nullifier.toLowerCase());
    if (!hash) return null;
    this.remove(hash);
    return hash;
  }

  /** Offers giving `giveToken` and wanting `wantToken`, single-leg only. */
  byPair(giveToken: string, wantToken: string): BookOffer[] {
    const bucket = this.#byPair.get(pairKey(giveToken.toLowerCase(), wantToken.toLowerCase()));
    if (!bucket) return [];
    return [...bucket].map((h) => this.#byHash.get(h)!).filter(Boolean);
  }

  /** Every directed pair currently holding at least one single-leg offer. */
  pairs(): Array<{ giveToken: string; wantToken: string }> {
    const out: Array<{ giveToken: string; wantToken: string }> = [];
    for (const key of this.#byPair.keys()) {
      const [giveToken, wantToken] = key.split("|");
      out.push({ giveToken, wantToken });
    }
    return out;
  }

  /** Drop offers at or past `expiresAt - marginSeconds`. The node expires
   *  offers on its own schedule; this keeps the solver from starting a
   *  settlement it cannot finish before the real deadline. */
  sweepExpired(nowMs: number, marginSeconds: number): string[] {
    const removed: string[] = [];
    for (const offer of this.all()) {
      if (offer.expiresAt === null) continue;
      if (nowMs >= offer.expiresAt - marginSeconds * 1000) {
        this.remove(offer.offerHash);
        removed.push(offer.offerHash);
      }
    }
    return removed;
  }

  /** Replace the book with `offers`, reporting what changed. Blobs already
   *  cached are carried over — the list endpoint does not serve them, and a
   *  blob is immutable for a given hash. */
  resync(offers: BookOffer[]): ResyncDiff {
    const next = new Map<string, BookOffer>();
    for (const offer of offers) next.set(offer.offerHash.toLowerCase(), offer);

    const removed = this.hashes().filter((h) => !next.has(h));
    const added = [...next.keys()].filter((h) => !this.#byHash.has(h));

    for (const hash of removed) this.remove(hash);
    for (const [hash, offer] of next) {
      const cachedBlob = this.#byHash.get(hash)?.blob;
      this.upsert(cachedBlob && !offer.blob ? { ...offer, blob: cachedBlob } : offer);
    }
    return { added, removed };
  }
}
