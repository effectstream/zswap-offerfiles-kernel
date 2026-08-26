import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  parseOfferValidationRequest,
  parseOfferValidationVerdict,
} from "./validation-contract.ts";

const HASH = "ab".repeat(32);
const TOKEN_A = "01".repeat(32);
const TOKEN_B = "02".repeat(32);
const FIXTURE_ROOT = new URL("./fixtures/offer-validation/v1/", import.meta.url);
const fixtureRaw = (name: string): string =>
  readFileSync(new URL(name, FIXTURE_ROOT), "utf8");
const fixture = (name: string): any => JSON.parse(fixtureRaw(name));
const request = () => fixture("request.json");
const validVerdict = () => fixture("verdict-valid.json");

describe("validate-for-use v1 request", () => {
  test("pins the shared wire fixtures byte-for-byte", () => {
    const hashes: Record<string, string> = {
      "request.json": "0e9732b9cff1fcadc842d2458cd8038eeff121dbd523bded814e8cc824ef21cb",
      "verdict-expired-before-archive.json":
        "4fb3ff264ccfb60ca85e90868ad923b17a2356c39c0f136d131b06f3c026a0fe",
      "verdict-live-but-invalid.json":
        "2f0b83a105a7829053bb469a4c005041cd66a428fd3a3bfed21a3fc68225e3f9",
      "verdict-not-indexed.json":
        "d38082dcf62dec9c735f60b05c1b41da14bdd129a6b18a626c096d65eaf9d1cd",
      "verdict-unsupported-profile.json":
        "0b460b7e98cd7b50da7b615a376ceda7aa7e27945322282e80de4ceae3e01de6",
      "verdict-valid.json":
        "255a96cf3a79bbde78a76c992a173d6bf1eb0e0bb360bcd4f669b12eb91e6c24",
    };
    for (const [name, expected] of Object.entries(hashes)) {
      expect(createHash("sha256").update(fixtureRaw(name)).digest("hex")).toBe(expected);
    }
    expect(parseOfferValidationRequest(request())).not.toBeNull();
    for (const name of Object.keys(hashes).filter((name) => name.startsWith("verdict-"))) {
      expect(parseOfferValidationVerdict(fixture(name))).not.toBeNull();
    }
  });

  test("freezes the exact request envelope while allowing a bounded unknown profile", () => {
    expect(parseOfferValidationRequest(request())).toEqual(request());
    expect(parseOfferValidationRequest({ ...request(), profile: "future-profile-v2" })).not.toBeNull();
    expect(parseOfferValidationRequest({ ...request(), extra: true })).toBeNull();
    expect(parseOfferValidationRequest({ ...request(), schemaVersion: 2 })).toBeNull();
    expect(parseOfferValidationRequest({ ...request(), offerId: HASH.toUpperCase() })).toBeNull();
    expect(parseOfferValidationRequest({ ...request(), offer: "" })).toBeNull();
    expect(parseOfferValidationRequest({ ...request(), profile: "contains whitespace" })).toBeNull();
  });
});

describe("validate-for-use v1 verdict", () => {
  test("accepts the frozen valid fixture", () => {
    expect(parseOfferValidationVerdict(validVerdict())).toEqual(validVerdict());
  });

  test("accepts a bound indexed-state negative verdict", () => {
    const verdict = {
      ...validVerdict(),
      valid: false,
      live: false,
      computedOfferId: HASH,
      status: "cancelled",
      code: "NOT_LIVE",
      reason: "offer is no longer live",
      computed: undefined,
    };
    expect(parseOfferValidationVerdict(verdict)?.code).toBe("NOT_LIVE");
  });

  test("keeps lifecycle status, current liveness, and profile validity distinct", () => {
    const unsupportedShape = {
      ...validVerdict(),
      valid: false,
      live: true,
      status: "live",
      code: "UNSUPPORTED_SHAPE",
      computed: undefined,
    };
    expect(parseOfferValidationVerdict(unsupportedShape)?.live).toBe(true);

    const staleRoot = fixture("verdict-live-but-invalid.json");
    expect(parseOfferValidationVerdict(staleRoot)?.status).toBe("live");
    const expiredBeforeArchive = fixture("verdict-expired-before-archive.json");
    expect(parseOfferValidationVerdict(expiredBeforeArchive)?.code).toBe("EXPIRED");
    expect(expiredBeforeArchive.status).toBe("live");
    expect(parseOfferValidationVerdict({
      ...staleRoot,
      status: "cancelled",
      live: true,
    })).toBeNull();
  });

  test("accepts NOT_INDEXED only with the not_indexed status", () => {
    const verdict = {
      ...validVerdict(),
      valid: false,
      live: false,
      computedOfferId: HASH,
      status: "not_indexed",
      code: "NOT_INDEXED",
      computed: undefined,
    };
    expect(parseOfferValidationVerdict(verdict)).not.toBeNull();
    expect(parseOfferValidationVerdict({ ...verdict, status: "unknown" })).toBeNull();
  });

  test("represents an unknown bounded profile as a domain verdict", () => {
    const verdict = {
      ...validVerdict(),
      profile: "future-profile-v2",
      valid: false,
      live: false,
      computedOfferId: HASH,
      status: "unknown",
      code: "UNSUPPORTED_PROFILE",
      computed: undefined,
    };
    expect(parseOfferValidationVerdict(verdict)?.profile).toBe("future-profile-v2");
    expect(parseOfferValidationVerdict({
      ...verdict,
      profile: OFFER_VALIDATION_PROFILE,
    })).toBeNull();
  });

  test("fails closed on unknown fields, codes, noncanonical identity, or inconsistent success", () => {
    expect(parseOfferValidationVerdict({ ...validVerdict(), extra: true })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), code: "MAYBE" })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), claimedOfferId: HASH.toUpperCase() })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), valid: false })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), computedOfferId: TOKEN_A })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), stateVersion: "01" })).toBeNull();
  });

  test("rejects malformed computed economics and timestamps", () => {
    expect(parseOfferValidationVerdict({
      ...validVerdict(),
      computed: { ...validVerdict().computed, gives: [] },
    })).toBeNull();
    expect(parseOfferValidationVerdict({
      ...validVerdict(),
      computed: {
        ...validVerdict().computed,
        gives: [{ token: TOKEN_A, amount: "0", kind: "SHIELDED" }],
      },
    })).toBeNull();
    expect(parseOfferValidationVerdict({
      ...validVerdict(),
      computed: {
        ...validVerdict().computed,
        inputNullifiers: [],
      },
    })).toBeNull();
    expect(parseOfferValidationVerdict({
      ...validVerdict(),
      computed: {
        ...validVerdict().computed,
        wants: [{ token: TOKEN_B, amount: "200", kind: "UNSHIELDED" }],
      },
    })).toBeNull();
    expect(parseOfferValidationVerdict({ ...validVerdict(), validatedAt: "yesterday" })).toBeNull();
  });
});
