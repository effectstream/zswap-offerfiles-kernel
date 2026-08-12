// §2.4 — cross-layer offers are rejected.
//
// The rule under test is a predicate over DERIVED LEGS, so that is what these
// pin. Building an actual cross-layer transaction needs two real offers and
// Transaction.merge (probe-cross-layer.ts does exactly that, and is what proved
// the gap reachable); that probe is the integration evidence. These tests are
// the rule's own coverage — cheap enough to be exhaustive about the boundaries,
// which is where a set-size check goes wrong.

import { describe, expect, test } from "bun:test";

import { isCrossLayer, layerSummary } from "./validate.ts";
import type { OfferLeg } from "./types.ts";

// Typed as OfferLeg on purpose. The doubles must be the shape the ladder
// really holds — see the `kind`/`type` note on isCrossLayer. Annotating these
// is what makes tsc reject a double that has drifted from production.
const s = (token: string): OfferLeg => ({ token, amount: "1", kind: "SHIELDED" });
const u = (token: string): OfferLeg => ({ token, amount: "1", kind: "UNSHIELDED" });

describe("isCrossLayer", () => {
  test("single-layer offers are not cross-layer", () => {
    expect(isCrossLayer([s("A")], [s("B")])).toBe(false);
    expect(isCrossLayer([u("A")], [u("B")])).toBe(false);
  });

  test("gives on one layer, wants on the other IS cross-layer", () => {
    expect(isCrossLayer([s("A")], [u("B")])).toBe(true);
    expect(isCrossLayer([u("A")], [s("B")])).toBe(true);
  });

  // The shape Transaction.merge actually produces. A merge of a shielded offer
  // and an unshielded one does not tidily put one layer on each side — it
  // concatenates, so a single side carries both. A check that only compared
  // `gives`' layer against `wants`' would miss this, which is why the predicate
  // flattens both sides into one set.
  test("both layers on the SAME side is cross-layer", () => {
    expect(isCrossLayer([s("A"), u("B")], [s("C")])).toBe(true);
    expect(isCrossLayer([s("A")], [s("B"), u("C")])).toBe(true);
  });

  // Same colour on two layers is TWO legs — deriveTokenLegs nets per
  // (colour, layer). That is what makes this a set-size test and not a colour
  // comparison, and it is the case a naive dedupe-by-token would erase.
  test("the same colour on two layers is cross-layer", () => {
    expect(isCrossLayer([s("SAME")], [u("SAME")])).toBe(true);
  });

  // Boundaries. Neither is cross-layer, and reporting CROSS_LAYER for them
  // would put a misleading code on a different defect: an empty or one-layer
  // shape is the two-sided NOT_A_SWAP rule's business, and that rule runs
  // first in the ladder.
  test("empty and one-sided shapes are not cross-layer", () => {
    expect(isCrossLayer([], [])).toBe(false);
    expect(isCrossLayer([s("A")], [])).toBe(false);
    expect(isCrossLayer([], [u("A")])).toBe(false);
  });

  // A give-only tx that carries both layers. The predicate says yes, but the
  // LADDER answers NOT_A_SWAP — the two-sided rule runs first, deliberately.
  // See the ordering note on the check in validate.ts.
  test("a one-sided shape spanning both layers is still cross-layer to the predicate", () => {
    expect(isCrossLayer([s("A"), u("B")], [])).toBe(true);
  });

  test("many legs on one layer stay non-cross-layer", () => {
    expect(isCrossLayer([u("A"), u("B"), u("C")], [u("D"), u("E")])).toBe(false);
  });
});

describe("layerSummary", () => {
  test("names the layer on each side", () => {
    expect(layerSummary([s("A")], [u("B")])).toBe("gives SHIELDED, wants UNSHIELDED");
  });

  test("reports a side that carries both layers", () => {
    expect(layerSummary([s("A"), u("B")], [s("C")])).toBe("gives SHIELDED+UNSHIELDED, wants SHIELDED");
  });

  test("an empty side reads as none, not as an empty string", () => {
    expect(layerSummary([], [u("A")])).toBe("gives none, wants UNSHIELDED");
  });
});
