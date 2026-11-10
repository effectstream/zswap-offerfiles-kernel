import { describe, expect, test } from "bun:test";

import {
  EXACT_FILES_PROFILE,
  EXACT_FILES_SCHEMA_VERSION,
  MAX_EXACT_FILES_PER_READ,
  exactFileEntry,
  parseExactFilesRequest,
  parseExactFilesResponse,
} from "./exact-files-contract.ts";
import { OFFER_VALIDATION_SCHEMA_VERSION } from "./validation-contract.ts";

const ID_A = "aa".repeat(32);
const ID_B = "bb".repeat(32);
const OFFER_A = "swapoffer1aaaa";
const STATE = { stateVersion: "42", validatedAt: "2026-08-14T12:34:56.000Z" };

const hashOffer = (offer: string): string => {
  if (offer === OFFER_A) return ID_A;
  if (offer === "swapoffer1bbbb") return ID_B;
  throw new Error("unhashable fixture blob");
};

const validVerdict = (offerId: string) => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile: EXACT_FILES_PROFILE,
  valid: true,
  live: true,
  claimedOfferId: offerId,
  computedOfferId: offerId,
  ...STATE,
  status: "live",
  code: "VALID",
  computed: {
    gives: [{ token: "11".repeat(32), amount: "1000", kind: "SHIELDED" }],
    wants: [{ token: "22".repeat(32), amount: "990", kind: "SHIELDED" }],
    inputNullifiers: ["33".repeat(32)],
    expiresAt: "2026-08-14T13:34:56.000Z",
  },
});

const refusedVerdict = (offerId: string, code = "NOT_INDEXED", status = "not_indexed") => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile: EXACT_FILES_PROFILE,
  valid: false,
  live: false,
  claimedOfferId: offerId,
  computedOfferId: null,
  ...STATE,
  status,
  code,
  reason: "the requested offer identity is not indexed by this backend",
});

const response = (files: unknown[]) => ({
  schemaVersion: EXACT_FILES_SCHEMA_VERSION,
  profile: EXACT_FILES_PROFILE,
  files,
});

describe("exact-files request grammar", () => {
  test("accepts one to MAX distinct canonical identities", () => {
    const one = { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [ID_A] };
    expect(parseExactFilesRequest(one)).toEqual(one as any);

    const many = {
      schemaVersion: 1,
      profile: EXACT_FILES_PROFILE,
      offerIds: Array.from(
        { length: MAX_EXACT_FILES_PER_READ },
        (_value, index) => index.toString(16).padStart(64, "0"),
      ),
    };
    expect(parseExactFilesRequest(many)).toEqual(many as any);
  });

  test("rejects everything outside the exact envelope", () => {
    const rejected: unknown[] = [
      null,
      [],
      "request",
      { schemaVersion: 2, profile: EXACT_FILES_PROFILE, offerIds: [ID_A] },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [ID_A], extra: true },
      { schemaVersion: 1, profile: "Not A Profile", offerIds: [ID_A] },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [] },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [ID_A, ID_A] },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [ID_A.toUpperCase()] },
      { schemaVersion: 1, profile: EXACT_FILES_PROFILE, offerIds: [`0x${ID_A.slice(2)}`] },
      {
        schemaVersion: 1,
        profile: EXACT_FILES_PROFILE,
        offerIds: Array.from(
          { length: MAX_EXACT_FILES_PER_READ + 1 },
          (_value, index) => index.toString(16).padStart(64, "0"),
        ),
      },
    ];
    for (const value of rejected) expect(parseExactFilesRequest(value)).toBeNull();
  });

  test("an unknown but well-formed profile is a request, not a syntax error", () => {
    const request = { schemaVersion: 1, profile: "future-profile-v2", offerIds: [ID_A] };
    expect(parseExactFilesRequest(request)).toEqual(request as any);
  });
});

describe("exact-files response binding", () => {
  test("accepts served bytes bound to their identity", () => {
    const body = response([{ offerId: ID_A, verdict: validVerdict(ID_A), offer: OFFER_A }]);
    expect(parseExactFilesResponse(body, { hashOffer })).toEqual(body as any);
    expect(exactFileEntry(parseExactFilesResponse(body)!, ID_A)?.offer).toBe(OFFER_A);
    expect(exactFileEntry(parseExactFilesResponse(body)!, ID_B)).toBeNull();
  });

  test("accepts a refusal that carries no bytes", () => {
    const body = response([{ offerId: ID_B, verdict: refusedVerdict(ID_B) }]);
    expect(parseExactFilesResponse(body, { hashOffer })).toEqual(body as any);
  });

  test("a VALID verdict without bytes is not a response", () => {
    const body = response([{ offerId: ID_A, verdict: validVerdict(ID_A) }]);
    expect(parseExactFilesResponse(body)).toBeNull();
  });

  test("a refusal may never smuggle bytes", () => {
    const body = response([{ offerId: ID_A, verdict: refusedVerdict(ID_A), offer: OFFER_A }]);
    expect(parseExactFilesResponse(body)).toBeNull();
  });

  test("bytes must hash to the identity they are served under", () => {
    const body = response([{ offerId: ID_A, verdict: validVerdict(ID_A), offer: "swapoffer1bbbb" }]);
    // Without a hash function the structural shape is acceptable; with one the
    // substitution is caught. Consumers must always supply it.
    expect(parseExactFilesResponse(body)).toEqual(body as any);
    expect(parseExactFilesResponse(body, { hashOffer })).toBeNull();

    const undecodable = response([
      { offerId: ID_A, verdict: validVerdict(ID_A), offer: "not-a-blob" },
    ]);
    expect(parseExactFilesResponse(undecodable, { hashOffer })).toBeNull();
  });

  test("a verdict claimed for another identity is refused", () => {
    const body = response([{ offerId: ID_A, verdict: validVerdict(ID_B), offer: OFFER_A }]);
    expect(parseExactFilesResponse(body, { hashOffer })).toBeNull();
  });

  test("HASH_MISMATCH keeps its differing computed identity", () => {
    const mismatch = {
      ...refusedVerdict(ID_A, "HASH_MISMATCH", "unknown"),
      computedOfferId: ID_B,
      reason: "claimed offerId does not match the decoded offer bytes",
    };
    const body = response([{ offerId: ID_A, verdict: mismatch }]);
    expect(parseExactFilesResponse(body, { hashOffer })).toEqual(body as any);
  });

  test("rejects envelope, cardinality, and duplicate-identity violations", () => {
    const entry = { offerId: ID_A, verdict: validVerdict(ID_A), offer: OFFER_A };
    const rejected: unknown[] = [
      null,
      response([]),
      { ...response([entry]), extra: true },
      { schemaVersion: 2, profile: EXACT_FILES_PROFILE, files: [entry] },
      { schemaVersion: 1, profile: "Not A Profile", files: [entry] },
      response([entry, entry]),
      response([{ offerId: ID_A }]),
      response([{ ...entry, extra: true }]),
      response([{ offerId: ID_A.toUpperCase(), verdict: validVerdict(ID_A), offer: OFFER_A }]),
      response(Array.from({ length: MAX_EXACT_FILES_PER_READ + 1 }, (_value, index) => {
        const id = index.toString(16).padStart(64, "0");
        return { offerId: id, verdict: refusedVerdict(id) };
      })),
    ];
    for (const value of rejected) {
      expect(parseExactFilesResponse(value, { hashOffer })).toBeNull();
    }
  });

  test("every verdict must echo the response profile", () => {
    const body = {
      schemaVersion: 1,
      profile: "future-profile-v2",
      files: [{ offerId: ID_A, verdict: refusedVerdict(ID_A) }],
    };
    expect(parseExactFilesResponse(body, { hashOffer })).toBeNull();
  });
});
