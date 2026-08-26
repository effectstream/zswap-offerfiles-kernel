import { expect, test } from "bun:test";

import type { ApiZswap } from "@zswap-da/solver-core/api-client";

import { Book, bookOfferFromApi, isSingleLeg, type BookOffer } from "./src/book.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const offer = (
  hash: string,
  give: string,
  want: string,
  nullifiers: string[] = [`n-${hash}`],
  expiresAt: number | null = null,
): BookOffer => ({
  offerHash: hash,
  gives: [{ token: give, amount: 100n, kind: "SHIELDED" }],
  wants: [{ token: want, amount: 90n, kind: "SHIELDED" }],
  expiresAt,
  firstSeenAt: null,
  inputNullifiers: nullifiers,
});

test("bookOfferFromApi parses amounts, legs, and timestamps", () => {
  const row: ApiZswap = {
    version: 1,
    offerId: A.toUpperCase(),
    computed: {
      gives: [{ token: A.toUpperCase(), amount: "1000000", type: "UNSHIELDED" }],
      wants: [{ token: B, amount: "500000", type: "SHIELDED" }],
      expiresAt: "2026-06-01T13:00:00.000Z",
      firstSeenAt: "2026-06-01T12:00:00.000Z",
      inputNullifiers: ["7C1D9B".padEnd(64, "0")],
      status: "live",
    },
  };
  const parsed = bookOfferFromApi(row)!;
  expect(parsed.offerHash).toBe(A);
  expect(parsed.gives[0]).toEqual({ token: A, amount: 1000000n, kind: "UNSHIELDED" });
  expect(parsed.wants[0].amount).toBe(500000n);
  expect(parsed.inputNullifiers).toEqual(["7c1d9b".padEnd(64, "0")]);
  expect(parsed.expiresAt).toBe(Date.parse("2026-06-01T13:00:00.000Z"));
});

test("a row without a canonical content hash is untrackable and is dropped", () => {
  const computed = {
    gives: [],
    wants: [],
    expiresAt: "2026-06-01T13:00:00.000Z",
    inputNullifiers: [],
    status: "live",
  };
  expect(bookOfferFromApi({ version: 1, offerId: null, computed } as ApiZswap)).toBeNull();
  expect(bookOfferFromApi({ version: 1, offerId: "abc", computed } as ApiZswap)).toBeNull();
  expect(bookOfferFromApi({ version: 1, offerId: `${"a".repeat(63)}g`, computed } as ApiZswap)).toBeNull();
});

test("consumed by hash removes the offer and its indexes", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B));
  expect(book.size).toBe(1);
  expect(book.remove("h1")).toBe(true);
  expect(book.size).toBe(0);
  expect(book.byPair(A, B)).toEqual([]);
  // The nullifier index must go with it, or a later consumed event removes a
  // hash that is no longer in the book.
  expect(book.removeByNullifier("n-h1")).toEqual([]);
});

test("consumed with only a nullifier still finds the offer", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B, ["null-x"]));
  expect(book.removeByNullifier("NULL-X")).toEqual(["h1"]);
  expect(book.size).toBe(0);
});

test("removing an unknown hash or nullifier is a no-op, not an error", () => {
  const book = new Book();
  expect(book.remove("nope")).toBe(false);
  expect(book.removeByNullifier("nope")).toEqual([]);
});

test("upsert re-indexes rather than leaving a stale pair bucket", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B));
  book.upsert(offer("h1", A, C));
  expect(book.byPair(A, B)).toEqual([]);
  expect(book.byPair(A, C).map((o) => o.offerHash)).toEqual(["h1"]);
  expect(book.size).toBe(1);
});

test("directed pair buckets do not answer the reverse direction", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B));
  expect(book.byPair(A, B).length).toBe(1);
  expect(book.byPair(B, A).length).toBe(0);
  expect(book.pairs()).toEqual([{ giveToken: A, wantToken: B }]);
});

test("multi-leg offers stay in the book but out of the pair index", () => {
  const book = new Book();
  const multi: BookOffer = {
    ...offer("h1", A, B),
    gives: [
      { token: A, amount: 10n, kind: "SHIELDED" },
      { token: C, amount: 20n, kind: "SHIELDED" },
    ],
  };
  expect(isSingleLeg(multi)).toBe(false);
  book.upsert(multi);
  expect(book.size).toBe(1);
  expect(book.byPair(A, B)).toEqual([]);
});

test("the expiry sweep drops offers inside the margin and keeps the rest", () => {
  const book = new Book();
  const now = 1_000_000;
  book.upsert(offer("soon", A, B, ["n1"], now + 60_000));
  book.upsert(offer("later", A, C, ["n2"], now + 600_000));
  book.upsert(offer("never", B, C, ["n3"], null));

  const removed = book.sweepExpired(now, 120);
  expect(removed).toEqual(["soon"]);
  expect(book.hashes().sort()).toEqual(["later", "never"]);
});

test("resync reports the diff and evicts offers the node no longer lists", () => {
  const book = new Book();
  book.upsert(offer("stays", A, B, ["n1"]));
  book.upsert(offer("goes", A, C, ["n2"]));

  const diff = book.resync([offer("stays", A, B, ["n1"]), offer("arrives", B, C, ["n3"])]);
  expect(diff.added).toEqual(["arrives"]);
  expect(diff.removed).toEqual(["goes"]);
  expect(diff.updated).toEqual([]);
  expect(book.hashes().sort()).toEqual(["arrives", "stays"]);
  // The evicted offer's nullifier index went with it.
  expect(book.removeByNullifier("n2")).toEqual([]);
});

test("resync keeps a cached blob the blob-free list cannot resupply", () => {
  const book = new Book();
  book.upsert({ ...offer("h1", A, B), blob: "swapoffer1cached" });
  book.resync([offer("h1", A, B)]);
  expect(book.get("h1")!.blob).toBe("swapoffer1cached");
});

test("resync surfaces an impossible same-hash projection mutation", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B));
  const changed = offer("h1", A, B);
  changed.wants[0].amount = 91n;
  const diff = book.resync([changed]);
  expect(diff).toEqual({ added: [], removed: [], updated: ["h1"] });
  expect(book.get("h1")!.wants[0].amount).toBe(91n);
});

test("an unknown leg kind or malformed amount rejects the complete external row", () => {
  const base = {
    version: 1,
    offerId: A,
    computed: {
      gives: [{ token: A, amount: "10", type: "SHIELDED" }],
      wants: [{ token: B, amount: "9", type: "SHIELDED" }],
      expiresAt: "2026-06-01T13:00:00.000Z",
      inputNullifiers: ["a".repeat(64)],
      status: "live",
    },
  };
  expect(
    bookOfferFromApi({
      ...base,
      computed: { ...base.computed, gives: [{ token: A, amount: "10", type: "FUTURE_KIND" }] },
    } as ApiZswap),
  ).toBeNull();
  expect(
    bookOfferFromApi({
      ...base,
      computed: { ...base.computed, wants: [{ token: B, amount: "1e3", type: "SHIELDED" }] },
    } as ApiZswap),
  ).toBeNull();
  expect(
    bookOfferFromApi({
      ...base,
      computed: { ...base.computed, expiresAt: "not-a-date" },
    } as ApiZswap),
  ).toBeNull();
});

test("solver admission rejects missing expiry and malformed shielded nullifiers", () => {
  const base = {
    version: 1,
    offerId: A,
    computed: {
      gives: [{ token: A, amount: "10", type: "SHIELDED" }],
      wants: [{ token: B, amount: "9", type: "SHIELDED" }],
      expiresAt: "2026-06-01T13:00:00.000Z",
      inputNullifiers: ["c".repeat(64)],
      status: "live",
    },
  };
  expect(
    bookOfferFromApi({
      ...base,
      computed: { ...base.computed, expiresAt: null },
    } as ApiZswap),
  ).toBeNull();
  for (const nullifier of ["abc", `${"a".repeat(63)}g`, `0x${"a".repeat(64)}`]) {
    expect(
      bookOfferFromApi({
        ...base,
        computed: { ...base.computed, inputNullifiers: [nullifier] },
      } as ApiZswap),
    ).toBeNull();
  }
});

test("duplicate-nullifier offers coexist in the index and are removed together", () => {
  const book = new Book();
  book.upsert(offer("h1", A, B, ["SAME"]));
  book.upsert(offer("h2", A, C, ["same"]));
  expect(book.removeByNullifier("SaMe").sort()).toEqual(["h1", "h2"]);
  expect(book.size).toBe(0);
  expect(book.byPair(A, B)).toEqual([]);
  expect(book.byPair(A, C)).toEqual([]);
});
