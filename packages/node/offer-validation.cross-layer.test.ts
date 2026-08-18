// S-2 (port of upstream 8244283) — CROSS_LAYER must surface as a VERDICT.
//
// 259bb9c added `CROSS_LAYER` to OfferRejectCode and made
// validateZswapOfferBytes return it at the LEG-SHAPE stage — which is exactly
// where /v1/offers/validate calls the validator, and strictly before its own
// UNSUPPORTED_SHAPE check. Our canonicalValidatorCode() allow-list throws on
// any code it does not name, so before this mapping a cross-layer candidate
// made the endpoint answer "unavailable" instead of returning a verdict. That
// is fail-closed (FR-011 holds — the solver still refuses the candidate) but it
// breaks FR-006's "stable machine-readable verdict and reason code".
//
// Resolution (plan open question 3, option (a)): map to the existing
// UNSUPPORTED_SHAPE code. The v1 profile authorizes only shielded <-> shielded,
// so "spans both layers" IS an unsupported shape for it; OfferValidationCode
// stays a closed enum, so the pinned v1 fixtures stay byte-immutable.
//
// DB-free and blob-free on purpose, following upstream's own precedent in
// cross-layer.test.ts: building a real cross-layer transaction needs two offers
// and Transaction.merge, which lives in probe-cross-layer.ts. What is ours to
// prove is the MAPPING and that its output survives the wire contract, so the
// reason string below is produced by the real validator helpers rather than
// hand-copied.
import { expect, test } from "bun:test";

// Direct file import, as upstream's own cross-layer.test.ts does: these two
// predicates are internal to validate.ts and deliberately not on mod.ts.
const { isCrossLayer, layerSummary } = await import("../validator/validate.ts");
const { canonicalValidatorCode } = await import("./offer-validation.ts");
const {
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  parseOfferValidationVerdict,
} = await import("@zswap-da/solver-core/validation-contract");

const OFFER_ID = "ab".repeat(32);

// The legs a cross-layer offer derives to, and the reason validate.ts builds
// from them. Typed loosely here only because OfferValidation is the validator's
// own union; the leg shapes match validate.ts's OfferLeg.
const GIVES = [{ token: "11".repeat(32), amount: "1", kind: "SHIELDED" as const }];
const WANTS = [{ token: "22".repeat(32), amount: "1", kind: "UNSHIELDED" as const }];

const CROSS_LAYER_REASON =
  `offer legs span both value layers (${layerSummary(GIVES, WANTS)}); ` +
  `no settlement path exists between shielded and unshielded`;

test("the fixture legs really are cross-layer (guards the premise)", () => {
  expect(isCrossLayer(GIVES, WANTS)).toBe(true);
});

test("CROSS_LAYER maps to UNSUPPORTED_SHAPE instead of throwing unavailable", () => {
  const validation = {
    ok: false,
    code: "CROSS_LAYER",
    reason: CROSS_LAYER_REASON,
    gives: GIVES,
    wants: WANTS,
  } as any;
  // The regression this pins: `default:` threw OfferValidationUnavailableError.
  expect(() => canonicalValidatorCode(validation)).not.toThrow();
  expect(canonicalValidatorCode(validation)).toBe("UNSUPPORTED_SHAPE");
});

test("the resulting verdict is accepted by parseOfferValidationVerdict", () => {
  const verdict = {
    schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
    profile: OFFER_VALIDATION_PROFILE,
    valid: false,
    live: false,
    claimedOfferId: OFFER_ID,
    computedOfferId: OFFER_ID,
    stateVersion: "1",
    validatedAt: "2026-08-17T00:00:00.000Z",
    status: "unknown",
    code: canonicalValidatorCode({
      ok: false,
      code: "CROSS_LAYER",
      reason: CROSS_LAYER_REASON,
      gives: GIVES,
      wants: WANTS,
    } as any),
    // The caller forwards structural.reason verbatim, so layerSummary()'s text
    // is what reaches the wire — the diagnostic that survives the mapping.
    reason: CROSS_LAYER_REASON,
  };
  const parsed = parseOfferValidationVerdict(verdict);
  expect(parsed).not.toBeNull();
  expect(parsed!.code).toBe("UNSUPPORTED_SHAPE");
  expect(parsed!.reason).toContain(layerSummary(GIVES, WANTS));
  expect(parsed!.valid).toBe(false);
});
