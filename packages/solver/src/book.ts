// In-memory mirror of the node's live offer book.
//
// Pure state: no IO, no timers. `book-sync.ts` drives it from the websocket
// update stream and the REST list. Offers are keyed by content hash — the
// node's numeric row id is local to that deployment and appears in events
// only, never in REST.

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exhaustive external-boundary parser. Unknown enum values are rejected;
 * treating a new leg type as SHIELDED would expand execution scope silently. */
export function parseTokenLeg(value: unknown): TokenLeg | null {
  if (!isRecord(value)) return null;
  if (typeof value.token !== "string" || !/^[0-9a-f]{64}$/i.test(value.token)) return null;
  if (typeof value.amount !== "string" || !/^[1-9][0-9]*$/.test(value.amount)) return null;
  if (value.type !== "SHIELDED" && value.type !== "UNSHIELDED") return null;
  return {
    token: value.token.toLowerCase(),
    amount: BigInt(value.amount),
    kind: value.type,
  };
}

const toEpochMs = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

const isOptionalTimestamp = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || isTimestamp(value);

/** Build a BookOffer from a REST list row or detail row. Returns null for a row
 *  with no content hash, which cannot be tracked or acted on. */
export function bookOfferFromApi(row: ApiZswap): BookOffer | null {
  if (
    !isRecord(row) ||
    typeof row.offerId !== "string" ||
    !/^[0-9a-f]{64}$/i.test(row.offerId)
  ) {
    return null;
  }
  if (!isRecord(row.computed) || !Array.isArray(row.computed.gives) || !Array.isArray(row.computed.wants)) {
    return null;
  }
  if (
    !Array.isArray(row.computed.inputNullifiers) ||
    row.computed.inputNullifiers.some(
      (n) => typeof n !== "string" || !/^[0-9a-f]{64}$/i.test(n),
    )
  ) {
    return null;
  }
  if (
    // The generic MIP representation permits an absent expiry, but the node's
    // validated offer API always derives one from root lifetime / intent TTL.
    // Solver execution is intentionally narrower: an unbounded row cannot be
    // kept outside the settlement safety margin.
    !isTimestamp(row.computed.expiresAt) ||
    !isOptionalTimestamp(row.computed.firstSeenAt)
  ) {
    return null;
  }
  const gives = row.computed.gives.map(parseTokenLeg);
  const wants = row.computed.wants.map(parseTokenLeg);
  if (gives.some((leg) => leg === null) || wants.some((leg) => leg === null)) return null;
  return {
    offerHash: row.offerId.toLowerCase(),
    gives: gives as TokenLeg[],
    wants: wants as TokenLeg[],
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
  /** A content-addressed hash should be immutable. If a snapshot changes its
   * indexed projection anyway, surface that as a trust-boundary mutation so
   * cached validation evidence is revoked and rebuilt. */
  updated: string[];
}

const sameOfferProjection = (left: BookOffer, right: BookOffer): boolean => {
  const legs = (values: TokenLeg[]): string =>
    values.map((leg) => `${leg.kind}:${leg.token}:${leg.amount}`).sort().join("|");
  const nullifiers = (values: string[]): string => [...values].sort().join("|");
  return left.offerHash.toLowerCase() === right.offerHash.toLowerCase() &&
    legs(left.gives) === legs(right.gives) &&
    legs(left.wants) === legs(right.wants) &&
    left.expiresAt === right.expiresAt &&
    left.firstSeenAt === right.firstSeenAt &&
    nullifiers(left.inputNullifiers) === nullifiers(right.inputNullifiers) &&
    (left.blob === undefined || right.blob === undefined || left.blob === right.blob);
};

export class Book<T extends BookOffer = BookOffer> {
  readonly #byHash = new Map<string, T>();
  readonly #hashesByNullifier = new Map<string, Set<string>>();
  readonly #byPair = new Map<string, Set<string>>();

  get size(): number {
    return this.#byHash.size;
  }

  get(offerHash: string): T | undefined {
    return this.#byHash.get(offerHash.toLowerCase());
  }

  all(): T[] {
    return [...this.#byHash.values()];
  }

  hashes(): string[] {
    return [...this.#byHash.keys()];
  }

  /** Insert or replace. Replacing re-indexes, so a detail fetch that adds legs
   *  or a blob to a list-sourced row cannot leave a stale index entry. */
  upsert(offer: T): void {
    const hash = offer.offerHash.toLowerCase();
    if (this.#byHash.has(hash)) this.#unindex(hash);
    const stored = {
      ...offer,
      offerHash: hash,
      inputNullifiers: [...new Set(offer.inputNullifiers.map((nullifier) => nullifier.toLowerCase()))],
    } as T;
    this.#byHash.set(hash, stored);
    for (const nullifier of stored.inputNullifiers) {
      let bucket = this.#hashesByNullifier.get(nullifier);
      if (!bucket) {
        bucket = new Set();
        this.#hashesByNullifier.set(nullifier, bucket);
      }
      bucket.add(hash);
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
      const bucket = this.#hashesByNullifier.get(nullifier);
      if (!bucket) continue;
      bucket.delete(hash);
      if (bucket.size === 0) this.#hashesByNullifier.delete(nullifier);
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

  /** Drop every offer that spends `nullifier`. Duplicate-nullifier rows are
   * conflicting views of the same coin, so consumption invalidates all of
   * them rather than whichever one most recently overwrote an index entry. */
  removeByNullifier(nullifier: string): string[] {
    const hashes = [...(this.#hashesByNullifier.get(nullifier.toLowerCase()) ?? [])];
    for (const hash of hashes) this.remove(hash);
    return hashes;
  }

  /** Offers giving `giveToken` and wanting `wantToken`, single-leg only. */
  byPair(giveToken: string, wantToken: string): T[] {
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
  resync(offers: T[]): ResyncDiff {
    const next = new Map<string, T>();
    for (const offer of offers) next.set(offer.offerHash.toLowerCase(), offer);

    const removed = this.hashes().filter((h) => !next.has(h));
    const added = [...next.keys()].filter((h) => !this.#byHash.has(h));
    const updated = [...next].flatMap(([hash, offer]) => {
      const existing = this.#byHash.get(hash);
      return existing && !sameOfferProjection(existing, offer) ? [hash] : [];
    });

    for (const hash of removed) this.remove(hash);
    for (const [hash, offer] of next) {
      const cachedBlob = this.#byHash.get(hash)?.blob;
      this.upsert(
        (cachedBlob && !offer.blob ? { ...offer, blob: cachedBlob } : offer) as T,
      );
    }
    return { added, removed, updated };
  }
}
