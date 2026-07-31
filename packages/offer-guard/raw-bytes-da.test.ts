import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bech32m } from "@scure/base";
import { OfferFiles, OFFER_HRP } from "@effectstream/mip-zswap-offer/mip5";
import {
  bytesToLatin1,
  latin1ToBytes,
  offerBytesToBech32,
  offerHashFromBlob,
  offerHashFromBytes,
} from "./mod.ts";

// Item #5: the DA layer carries RAW MIP-0005 bytes, not the bech32m string.
// The delicate part is binary surviving the wire path, which the framework
// implements as btoa/atob (base64 ↔ latin1). These tests replicate that EXACT
// transport so the byte handling is proven without a live Celestia node.
//
//   publish:  bech32m string → OfferFiles.decode → raw bytes → base64 (blob.data)
//   read:     blob.data → atob → latin1 string (suppliedValue) → latin1ToBytes → raw bytes

// Simulate the batcher's buildBatchData override: base64 of the raw bytes.
function publishToBlobData(bech32: string): string {
  return Buffer.from(OfferFiles.decode(bech32)).toString("base64");
}
// Simulate the framework fetcher: suppliedValue = atob(blob.data).
function fetchSuppliedValue(blobData: string): string {
  return atob(blobData);
}

describe("raw-bytes DA transport — crafted full byte range", () => {
  // Every byte value 0..255 present, so any latin1/UTF-8 mishandling shows up.
  const rawBytes = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
  const bech32 = bech32m.encode(OFFER_HRP, bech32m.toWords(rawBytes), false);

  test("full round trip is byte-identical (publish → Celestia → fetch → bytes)", () => {
    const blobData = publishToBlobData(bech32);
    const supplied = fetchSuppliedValue(blobData);
    const recovered = latin1ToBytes(supplied);
    expect(Buffer.from(recovered).toString("hex")).toBe(
      Buffer.from(rawBytes).toString("hex"),
    );
  });

  test("latin1ToBytes / bytesToLatin1 are exact inverses across all byte values", () => {
    const round = latin1ToBytes(bytesToLatin1(rawBytes));
    expect(Buffer.from(round)).toEqual(Buffer.from(rawBytes));
  });

  test("offer_hash is identical whether computed from the string or the raw bytes", () => {
    expect(offerHashFromBytes(rawBytes)).toBe(offerHashFromBlob(bech32));
    // …and is exactly sha256 of the bytes — the DA blob's own hash now.
    expect(offerHashFromBytes(rawBytes)).toBe(
      createHash("sha256").update(rawBytes).digest("hex"),
    );
  });

  test("bytes re-encode to the SAME bech32m string the maker produced", () => {
    expect(offerBytesToBech32(rawBytes)).toBe(bech32);
  });

  test("bech32m is ~1.6× the raw bytes — the waste this change removes", () => {
    const blobData = publishToBlobData(bech32);
    // base64 is 4/3; raw bytes ≈ bech32.length / 1.6. Published base64 must be
    // well under the bech32 string length (the point of publishing bytes).
    expect(blobData.length).toBeLessThan(bech32.length);
    expect(rawBytes.length).toBeLessThan(bech32.length);
  });
});

// The real thing: a 24 KB Lace-made offer, if present. Proves the transport on
// genuine proof-bearing bytes, not just a crafted array.
const FIXTURE = join(import.meta.dir, "..", "validator", "fixtures", "valid-offer.bech32");
describe.skipIf(!existsSync(FIXTURE))("raw-bytes DA transport — real offer fixture", () => {
  const bech32 = readFileSync(FIXTURE, "utf8").trim();
  const rawBytes = OfferFiles.decode(bech32);

  test("24 KB proven offer survives the wire path byte-identical", () => {
    const supplied = fetchSuppliedValue(publishToBlobData(bech32));
    const recovered = latin1ToBytes(supplied);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(rawBytes));
    // and the STM would re-encode the exact maker string
    expect(offerBytesToBech32(recovered)).toBe(bech32);
    expect(offerHashFromBytes(recovered)).toBe(offerHashFromBlob(bech32));
  });

  test("publishing bytes saves ~1.6× vs the bech32m string on a real offer", () => {
    const bytesB64 = publishToBlobData(bech32);
    const stringB64 = Buffer.from(bech32, "utf8").toString("base64"); // the OLD payload
    expect(bytesB64.length).toBeLessThan(stringB64.length * 0.7);
  });
});
