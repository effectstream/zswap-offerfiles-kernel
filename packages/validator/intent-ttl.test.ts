import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerState } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import { getReferenceState } from "./refstate.ts";
import { signedUnshieldedOffer, withIntent, type SignedOffer } from "./signed-offer.testkit.ts";
import { validateZswapOfferBytes, wellFormedFailureCode } from "./validate.ts";

// 00056 T1 at the validator: offers that pass the FULL crypto step (proofs,
// signatures, binding) are accepted or refused on their intent TTL alone, with
// the network's reference parameters (global_ttl = 14 days), and a TTL failure
// gets its own code instead of PROOF_INVALID.

const TBLOCK = new Date("2026-09-26T12:00:00.000Z");
const at = (seconds: number) => new Date(TBLOCK.getTime() + seconds * 1000);
const DAY = 86_400;
const GLOBAL_TTL = 14 * DAY;

function verdict(bytes: Uint8Array, refState: LedgerState): string {
  const result = validateZswapOfferBytes(bytes, { refState, tblock: TBLOCK, maxBytes: 1 << 21 });
  return result.ok ? "OK" : `${result.code}`;
}

const CASES = [
  ["+2 h", 2 * 3_600, "OK"],
  ["+3 days", 3 * DAY, "OK"],
  ["+14 days − 1 min", GLOBAL_TTL - 60, "OK"],
  ["+14 days (inclusive)", GLOBAL_TTL, "OK"],
  ["+14 days + 1 s", GLOBAL_TTL + 1, "INTENT_TTL_TOO_FAR"],
  ["expired (−1 s)", -1, "INTENT_TTL_EXPIRED"],
] as const;

const NETWORKS = ["undeployed", "preprod"] as const;
/** Offers per network id: the reference state checks the tx's network id too. */
const offers = new Map<string, SignedOffer>();
const key = (network: string, label: string) => `${network}|${label}`;
beforeAll(async () => {
  for (const network of NETWORKS) {
    for (const [label, seconds] of CASES) {
      offers.set(key(network, label), await signedUnshieldedOffer(at(seconds), network));
    }
  }
});

describe("unshielded offer intent TTL at the validator (reference parameters)", () => {
  for (const network of NETWORKS) {
    for (const [label, , expected] of CASES) {
      test(`${network}: ${label} → ${expected}`, () => {
        expect(verdict(offers.get(key(network, label))!.bytes, getReferenceState(network))).toBe(expected);
      });
    }
  }

  test("the TTL-refused offers are otherwise genuine: accepted when the clock allows", () => {
    // Same bytes, a block time at which the TTL is inside the window: the
    // refusals above are the TTL rule, not a broken signature or binding.
    const tooFar = offers.get(key("undeployed", "+14 days + 1 s"))!;
    const later = new Date(TBLOCK.getTime() + 2_000);
    const r1 = validateZswapOfferBytes(tooFar.bytes, {
      refState: getReferenceState("undeployed"),
      tblock: later,
      maxBytes: 1 << 21,
    });
    expect(r1.ok).toBe(true);
    const expired = offers.get(key("undeployed", "expired (−1 s)"))!;
    const earlier = new Date(TBLOCK.getTime() - 2_000);
    const r2 = validateZswapOfferBytes(expired.bytes, {
      refState: getReferenceState("undeployed"),
      tblock: earlier,
      maxBytes: 1 << 21,
    });
    expect(r2.ok).toBe(true);
  });

  test("before 00056 (blank state): anything past +1 h was refused", () => {
    const blank = LedgerState.blank("undeployed");
    expect(verdict(offers.get(key("undeployed", "+2 h"))!.bytes, blank)).toBe("INTENT_TTL_TOO_FAR");
    expect(verdict(offers.get(key("undeployed", "+3 days"))!.bytes, blank)).toBe("INTENT_TTL_TOO_FAR");
  });
});

describe("mixed offer: shielded legs plus an intent", () => {
  const fixture = OfferFiles.decode(
    readFileSync(join(import.meta.dir, "fixtures", "valid-offer.bech32"), "utf8").trim(),
  );

  test("its intent TTL is bounded by the same window; the shielded part adds none", async () => {
    const accepted = await withIntent(fixture, at(3 * DAY));
    const tooFar = await withIntent(fixture, at(GLOBAL_TTL + 1));
    const expired = await withIntent(fixture, at(-1));
    const ref = getReferenceState("undeployed");
    expect(verdict(accepted.bytes, ref)).toBe("OK");
    expect(verdict(tooFar.bytes, ref)).toBe("INTENT_TTL_TOO_FAR");
    expect(verdict(expired.bytes, ref)).toBe("INTENT_TTL_EXPIRED");
    // The shielded-only fixture itself carries no TTL: any block time passes.
    expect(verdict(fixture, ref)).toBe("OK");
  });
});

describe("wellFormedFailureCode", () => {
  test("maps the ledger's TTL messages to their own codes", () => {
    expect(wellFormedFailureCode(
      "transaction application error detected during verification: Intent TTL has expired. TTL: Timestamp(1), Current block: Timestamp(2)",
    )).toBe("INTENT_TTL_EXPIRED");
    expect(wellFormedFailureCode(
      "transaction application error detected during verification: Intent TTL is too far in the future. TTL: Timestamp(9), Maximum allowed: Timestamp(3)",
    )).toBe("INTENT_TTL_TOO_FAR");
  });

  test("keeps SIGNATURE_INVALID and PROOF_INVALID for everything else", () => {
    expect(wellFormedFailureCode("invalid signature for input 0")).toBe("SIGNATURE_INVALID");
    expect(wellFormedFailureCode("proof verification failed")).toBe("PROOF_INVALID");
    expect(wellFormedFailureCode("")).toBe("PROOF_INVALID");
  });
});
