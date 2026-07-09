import { describe, expect, test } from "bun:test";
import { bech32m } from "@scure/base";

import {
  OFFER_HRP,
  decodeOffer,
  encodeOffer,
} from "./codec.ts";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + 7) & 0xff;
  return b;
}

describe("MIP-0005 codec", () => {
  test("HRP is swapoffer", () => {
    expect(OFFER_HRP).toBe("swapoffer");
  });

  test("round-trips short payload", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeOffer(bytes);
    expect(encoded.startsWith(`${OFFER_HRP}1`)).toBe(true);
    expect(decodeOffer(encoded)).toEqual(bytes);
  });

  test("round-trips payloads larger than the standard 90-char bech32 limit", () => {
    const bytes = randomBytes(4096);
    const encoded = encodeOffer(bytes);
    expect(encoded.length).toBeGreaterThan(1000);
    expect(decodeOffer(encoded)).toEqual(bytes);
  });

  test("encodes the empty payload", () => {
    const encoded = encodeOffer(new Uint8Array(0));
    expect(decodeOffer(encoded)).toEqual(new Uint8Array(0));
  });

  test("decodeOffer rejects the wrong HRP", () => {
    // Build a checksum-valid bech32m string under a different HRP.
    const words = bech32m.toWords(new Uint8Array([1, 2, 3]));
    const foreign = bech32m.encode(
      "zswapoffer",
      words,
      false as unknown as number,
    );
    expect(() => decodeOffer(foreign)).toThrow(/HRP/);
  });

  test("decodeOffer rejects a corrupted checksum", () => {
    const encoded = encodeOffer(new Uint8Array([1, 2, 3, 4]));
    const last = encoded.at(-1)!;
    const mutated = encoded.slice(0, -1) + (last === "q" ? "p" : "q");
    expect(() => decodeOffer(mutated)).toThrow();
  });

  test("encodeOffer rejects non-Uint8Array input", () => {
    // @ts-expect-error intentional bad input
    expect(() => encodeOffer([1, 2, 3])).toThrow();
  });

  test("decode of foreign bech32m with wrong HRP fails even if checksum valid", () => {
    const words = bech32m.toWords(new Uint8Array([9, 9, 9]));
    const foreign = bech32m.encode("notoffer", words, false as unknown as number);
    expect(() => decodeOffer(foreign)).toThrow(/HRP/);
  });
});
