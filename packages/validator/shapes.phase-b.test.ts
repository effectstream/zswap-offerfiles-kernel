// #5 phase (b) — judge the six wire shapes phase (a) constructed.
//
// These fixtures are mock-proven, so an ACCEPT below means the shape survives
// every deterministic pre-crypto ladder step. It is not a claim that the mock
// proof or its fabricated inputs are chain-valid; those belong to phase (c).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import {
  allShapes,
  decodeShape,
  GIVE_TOKEN,
  structuralShapes,
  WANT_TOKEN,
} from "./shapes.testkit.ts";
import {
  bytesOrStringToHex,
  collectUnshieldedOutputs,
  deriveLegs,
} from "./derive.ts";
import { getBlankRefState } from "./refstate.ts";
import { validateZswapOfferBytes } from "./validate.ts";

const shapes = allShapes();
const byId = new Map(shapes.map((shape) => [shape.id, shape]));
const offerHashFromBlob = (blob: string) =>
  createHash("sha256").update(OfferFiles.decode(blob)).digest("hex");

function verdict(id: string) {
  return validateZswapOfferBytes(OfferFiles.decode(byId.get(id)!.blob), {
    refState: getBlankRefState("undeployed" as any),
    tblock: new Date(),
    maxBytes: 1 << 20,
    crypto: "defer",
  });
}

describe("phase (b) — the ladder makes an explicit decision for every shape", () => {
  const accepted = [
    ["guaranteed-single", "the wallet-built control is a two-sided offer"],
    ["fallible-single", "fallible placement is legal on the wire"],
    ["same-intent-wrapper-a", "content-addressed dedup has not seen these bytes"],
    ["same-intent-wrapper-b", "a different wrapper is a second offer by ruling"],
    ["multi-intent", "multiple intents aggregate into one two-sided offer"],
  ] as const;

  for (const [id, why] of accepted) {
    test(`${id}: ACCEPT — ${why}`, () => {
      expect(verdict(id)).toMatchObject({ ok: true });
    });
  }

  test("no-spendable-input: REJECT — a payout-only transaction is not an offer", () => {
    expect(verdict("no-spendable-input")).toMatchObject({
      ok: false,
      code: "NO_SPENDABLE_INPUT",
    });
  });
});

describe("phase (b) — deriveTokenLegs is correct for every shape", () => {
  // Typed as what `deriveLegs` returns, not `as const`: a deeply readonly
  // literal is not comparable to the mutable leg arrays the deriver produces.
  const oneIntent: ReturnType<typeof deriveLegs> = {
    gives: [{ token: GIVE_TOKEN, amount: "100", kind: "UNSHIELDED" }],
    wants: [{ token: WANT_TOKEN, amount: "125", kind: "UNSHIELDED" }],
  };

  for (const id of [
    "guaranteed-single",
    "fallible-single",
    "same-intent-wrapper-a",
    "same-intent-wrapper-b",
  ]) {
    test(`${id}: one 100/125 unshielded swap`, () => {
      expect(deriveLegs(decodeShape(byId.get(id)!.blob))).toEqual(oneIntent);
    });
  }

  test("multi-intent: both intents contribute to the aggregate legs", () => {
    expect(deriveLegs(decodeShape(byId.get("multi-intent")!.blob))).toEqual({
      gives: [{ token: GIVE_TOKEN, amount: "200", kind: "UNSHIELDED" }],
      wants: [{ token: WANT_TOKEN, amount: "250", kind: "UNSHIELDED" }],
    });
  });

  test("no-spendable-input: derivation exposes its one-sided payout", () => {
    expect(deriveLegs(decodeShape(byId.get("no-spendable-input")!.blob))).toEqual({
      gives: [],
      wants: [{ token: WANT_TOKEN, amount: "125", kind: "UNSHIELDED" }],
    });
  });
});

type ExpectedOutput = {
  owner: string;
  intentHash: string;
  outputNo: number;
  tokenType: string;
  value: string;
};

/**
 * Mirror the two ledger apply_offer call sites directly from the decoded blob:
 * guaranteed passes segment 0; fallible passes the intent map's physical key.
 */
function ledgerStampedOutputs(tx: any): ExpectedOutput[] {
  const outputs: ExpectedOutput[] = [];
  for (const [physicalSegment, intent] of tx.intents.entries()) {
    const sections = [
      [intent.guaranteedUnshieldedOffer, 0],
      [intent.fallibleUnshieldedOffer, Number(physicalSegment)],
    ] as const;
    for (const [offer, hashSegment] of sections) {
      if (!offer) continue;
      const intentHash = bytesOrStringToHex(intent.intentHash(hashSegment));
      for (const [outputNo, output] of offer.outputs.entries()) {
        outputs.push({
          owner: bytesOrStringToHex(output.owner),
          intentHash,
          outputNo,
          tokenType: bytesOrStringToHex(output.type),
          value: String(output.value),
        });
      }
    }
  }
  return outputs;
}

describe("phase (b) — ingestion precomputes the exact ledger output identity", () => {
  for (const shape of shapes) {
    test(`${shape.id}: every output equals the identity the ledger will stamp`, () => {
      const tx = decodeShape(shape.blob) as any;
      expect(collectUnshieldedOutputs(tx)).toEqual(ledgerStampedOutputs(tx));
    });
  }

  test("guaranteed uses intentHash(0), not its physical map key", () => {
    const tx: any = decodeShape(byId.get("guaranteed-single")!.blob);
    const [physicalSegment, intent] = [...tx.intents.entries()][0]! as [number, any];
    const [output] = collectUnshieldedOutputs(tx) as any[];
    expect(physicalSegment).not.toBe(0);
    expect(output.intentHash).toBe(bytesOrStringToHex(intent.intentHash(0)));
    expect(output.intentHash).not.toBe(
      bytesOrStringToHex(intent.intentHash(physicalSegment)),
    );
  });

  test("fallible uses intentHash(physicalSegment), never intentHash(0)", () => {
    const tx: any = decodeShape(byId.get("fallible-single")!.blob);
    const [physicalSegment, intent] = [...tx.intents.entries()][0]! as [number, any];
    const [output] = collectUnshieldedOutputs(tx) as any[];
    expect(output.intentHash).toBe(
      bytesOrStringToHex(intent.intentHash(physicalSegment)),
    );
    expect(output.intentHash).not.toBe(bytesOrStringToHex(intent.intentHash(0)));
  });

  test("multi-intent outputs retain two distinct parent-intent identities", () => {
    const outputs = collectUnshieldedOutputs(
      decodeShape(byId.get("multi-intent")!.blob),
    ) as any[];
    const identities = outputs.map(
      (output) => `${output.owner}/${output.intentHash}/${output.outputNo}`,
    );
    expect(outputs).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
  });
});

describe("phase (b) — dedup remains byte-identical by ruling", () => {
  test("same-intent-wrapper-a and -b are two accepted offers", () => {
    const a = byId.get("same-intent-wrapper-a")!;
    const b = byId.get("same-intent-wrapper-b")!;

    expect(offerHashFromBlob(a.blob)).not.toBe(offerHashFromBlob(b.blob));
    expect(collectUnshieldedOutputs(decodeShape(a.blob))).toEqual(
      collectUnshieldedOutputs(decodeShape(b.blob)),
    );
    expect(verdict(a.id)).toMatchObject({ ok: true });
    expect(verdict(b.id)).toMatchObject({ ok: true });
  });

  test("the structural set still contains exactly the five ruled-valid shapes", () => {
    expect(structuralShapes()).toHaveLength(5);
  });
});
