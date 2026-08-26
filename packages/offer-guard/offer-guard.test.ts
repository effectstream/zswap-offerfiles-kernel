import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("guardOffer shared liveness evaluator (real proven fixture)", () => {
  const fixture = readFileSync(
    join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32"),
    "utf8",
  ).trim();
  const opts = { networkId: "undeployed", maxBytes: 1024 * 1024 };

  test("keeps submission dedup before ordered nullifier/root liveness", async () => {
    const probes: string[] = [];
    const verdict = await guardOffer(fixture, {
      ...opts,
      isDuplicate: async () => {
        probes.push("duplicate");
        return null;
      },
      isNullifierSpent: async () => {
        probes.push("nullifier");
        return false;
      },
      isKnownRoot: async () => {
        probes.push("root");
        return false;
      },
    });

    expect(verdict).toMatchObject({ ok: false, code: "ROOT_UNKNOWN" });
    expect(probes).toEqual(["duplicate", "nullifier", "root"]);
  });

  test("returns the shared NULLIFIER_SPENT verdict and short-circuits", async () => {
    let rootProbes = 0;
    const verdict = await guardOffer(fixture, {
      ...opts,
      isNullifierSpent: async () => true,
      isKnownRoot: async () => {
        rootProbes += 1;
        return true;
      },
    });

    expect(verdict).toMatchObject({ ok: false, code: "NULLIFIER_SPENT" });
    expect(rootProbes).toBe(0);
  });

  test("all configured liveness probes plus crypto produce one valid verdict", async () => {
    const verdict = await guardOffer(fixture, {
      ...opts,
      isDuplicate: async () => null,
      isNullifierSpent: async () => false,
      isUnshieldedLive: async () => true,
      isKnownRoot: async () => true,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.offerHash).toBe(offerHashFromBlob(fixture));
  });
});

describe("MIP-0006 shared namespace", () => {
  test("suffix is exactly ASCII mn-swap-v1, 10 bytes", async () => {
    const { MIP6_NAMESPACE_ID_SUFFIX_HEX } = await import("./mod.ts");
    expect(MIP6_NAMESPACE_ID_SUFFIX_HEX.length).toBe(20); // 10 bytes
    const ascii = Buffer.from(MIP6_NAMESPACE_ID_SUFFIX_HEX, "hex").toString("ascii");
    expect(ascii).toBe("mn-swap-v1");
  });

  test("full 29-byte namespace: version 0x00 + 18 zero bytes + suffix (the MIP-mandated layout)", async () => {
    const { mip6NamespaceBytes, MIP6_NAMESPACE_ID_SUFFIX_HEX } = await import("./mod.ts");
    const bytes = mip6NamespaceBytes();
    expect(bytes.length).toBe(29);
    expect(bytes[0]).toBe(0); // version
    for (let i = 1; i <= 18; i++) expect(bytes[i]).toBe(0); // required zeros
    expect(Buffer.from(bytes.slice(19)).toString("hex")).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
  });

  test("matches the sync layer's right-aligned expansion byte-for-byte", async () => {
    // Replicates celestiaNamespaceToBase64 (@effectstream/sync): pad the hex
    // to 28 bytes, right-aligned, prepend version 0. If the framework's
    // expansion of our 10-byte suffix ever diverged from the MIP layout, the
    // node would silently read/write a DIFFERENT namespace.
    const { mip6NamespaceBytes, MIP6_NAMESPACE_ID_SUFFIX_HEX } = await import("./mod.ts");
    const cleanHex = MIP6_NAMESPACE_ID_SUFFIX_HEX.padStart(56, "0");
    const framework = new Uint8Array(29);
    for (let i = 0; i < 28; i++) {
      framework[i + 1] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
    }
    expect(Buffer.from(framework).toString("hex")).toBe(
      Buffer.from(mip6NamespaceBytes()).toString("hex"),
    );
  });

  test("node and batcher defaults both resolve to the shared namespace", async () => {
    delete process.env["CELESTIA_NAMESPACE"];
    const { MIP6_NAMESPACE_ID_SUFFIX_HEX } = await import("./mod.ts");
    const { CELESTIA_NAMESPACE } = await import("../node/env.ts");
    expect(CELESTIA_NAMESPACE).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
  });
});
