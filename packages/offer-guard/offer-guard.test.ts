import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bech32m } from "@scure/base";
import { OFFER_HRP } from "@effectstream/mip-zswap-offer/mip5";

import { DedupStore, guardOffer, offerHashFromBlob } from "./mod.ts";

// A syntactically valid bech32m blob wrapping arbitrary bytes: decodes (so it
// hashes) but is not a deserializable Transaction.
function craftBlob(bytes: Uint8Array): string {
  return bech32m.encode(OFFER_HRP, bech32m.toWords(bytes), false);
}

describe("offerHashFromBlob", () => {
  test("hashes the RAW BYTES, not the bech32m string", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i * 3 % 256);
    const blob = craftBlob(bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(offerHashFromBlob(blob)).toBe(expected);
    // Sanity: hashing the string instead would differ.
    const wrong = createHash("sha256").update(blob).digest("hex");
    expect(offerHashFromBlob(blob)).not.toBe(wrong);
  });

  test("throws on undecodable input (callers answer without a store lookup)", () => {
    expect(() => offerHashFromBlob("not-an-offer")).toThrow();
    expect(() => offerHashFromBlob(`${OFFER_HRP}1qqqqqzzzz`)).toThrow();
  });
});

describe("DedupStore", () => {
  test("has/add round trip", () => {
    const store = new DedupStore();
    expect(store.has("a")).toBe(false);
    store.add("a");
    expect(store.has("a")).toBe(true);
    expect(store.size).toBe(1);
  });

  test("bounded: evicts oldest insertion at capacity", () => {
    const store = new DedupStore(3);
    for (const h of ["h1", "h2", "h3", "h4"]) store.add(h);
    expect(store.size).toBe(3);
    expect(store.has("h1")).toBe(false); // oldest evicted
    expect(store.has("h4")).toBe(true);
  });

  test("re-adding an existing hash does not grow or reorder", () => {
    const store = new DedupStore(2);
    store.add("x");
    store.add("y");
    store.add("x"); // no-op
    expect(store.size).toBe(2);
    store.add("z"); // evicts x (still oldest)
    expect(store.has("x")).toBe(false);
    expect(store.has("y")).toBe(true);
  });
});

describe("guardOffer ladder (structure gate, no fixture needed)", () => {
  const opts = { networkId: "undeployed", maxBytes: 10_000 };

  test("junk string → BAD_ENCODING, and no callback is consulted", async () => {
    let consulted = 0;
    const r = await guardOffer("definitely-not-an-offer", {
      ...opts,
      isDuplicate: async () => {
        consulted++;
        return null;
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_ENCODING");
    expect(consulted).toBe(0); // structure rejects before any store lookup
  });

  test("oversized blob → TOO_LARGE before decode", async () => {
    const huge = `${OFFER_HRP}1` + "q".repeat(1_000_000);
    const r = await guardOffer(huge, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOO_LARGE");
  });

  test("decodable junk bytes → BAD_DESERIALIZE (dedup never reached)", async () => {
    let consulted = 0;
    const blob = craftBlob(new Uint8Array(64).fill(9));
    const r = await guardOffer(blob, {
      ...opts,
      isDuplicate: async () => {
        consulted++;
        return "open";
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_DESERIALIZE");
    expect(consulted).toBe(0);
  });
});
