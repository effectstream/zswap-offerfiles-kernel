import { describe, expect, test } from "bun:test";

import {
  evaluateOfferLiveness,
  offerLivenessFailure,
  orderedOfferLivenessDescriptors,
  type OfferLivenessDescriptor,
} from "./mod.ts";

const ref = {
  owner: "aa".repeat(32),
  intentHash: "bb".repeat(32),
  outputNo: 7,
};

const validation = {
  nullifiers: ["n1", "n2"],
  unshieldedSpends: [ref],
  inputRoots: ["r1", "r2"],
};

describe("orderedOfferLivenessDescriptors", () => {
  test("freezes nullifier → unshielded live-set → root ordering", () => {
    expect(orderedOfferLivenessDescriptors(validation)).toEqual([
      { kind: "nullifier", nullifier: "n1" },
      { kind: "nullifier", nullifier: "n2" },
      { kind: "unshielded", ref },
      { kind: "root", root: "r1" },
      { kind: "root", root: "r2" },
    ]);
  });
});

describe("offerLivenessFailure", () => {
  test("normalizes indexed-context codes and exact identity-bearing reasons", () => {
    expect(offerLivenessFailure({ kind: "nullifier", nullifier: "n1" })).toMatchObject({
      code: "NULLIFIER_SPENT",
      reason: "nullifier already spent: n1",
    });
    expect(offerLivenessFailure({ kind: "unshielded", ref })).toMatchObject({
      code: "UTXO_NOT_LIVE",
      reason:
        `unshielded UTXO not live (spent or never created): ${ref.owner}/${ref.intentHash}/7`,
    });
    expect(offerLivenessFailure({ kind: "root", root: "r1" })).toMatchObject({
      code: "ROOT_UNKNOWN",
      reason: "input merkle root not a known recent chain root: r1",
    });
  });

  test("preserves the pure validator's split unshielded predicates", () => {
    const descriptor = { kind: "unshielded", ref } as const;
    expect(offerLivenessFailure(descriptor, "spent")).toMatchObject({
      code: "UTXO_SPENT",
      reason: `unshielded UTXO already spent: ${ref.owner}/${ref.intentHash}/7`,
    });
    expect(offerLivenessFailure(descriptor, "unknown")).toMatchObject({
      code: "UTXO_UNKNOWN",
      reason: `unshielded UTXO never created on chain: ${ref.owner}/${ref.intentHash}/7`,
    });
  });
});

describe("evaluateOfferLiveness", () => {
  test("is ordered, async-capable, and stops at the first failed descriptor", async () => {
    const seen: OfferLivenessDescriptor[] = [];
    const verdict = await evaluateOfferLiveness(validation, async (descriptor) => {
      seen.push(descriptor);
      return descriptor.kind !== "unshielded";
    });

    expect(verdict).toMatchObject({ ok: false, code: "UTXO_NOT_LIVE" });
    expect(seen).toEqual([
      { kind: "nullifier", nullifier: "n1" },
      { kind: "nullifier", nullifier: "n2" },
      { kind: "unshielded", ref },
    ]);
  });

  test("undefined deliberately skips unavailable probes without changing order", async () => {
    const seen: string[] = [];
    const verdict = await evaluateOfferLiveness(validation, (descriptor) => {
      seen.push(descriptor.kind);
      return descriptor.kind === "root" ? true : undefined;
    });
    expect(verdict).toEqual({ ok: true });
    expect(seen).toEqual([
      "nullifier",
      "nullifier",
      "unshielded",
      "root",
      "root",
    ]);
  });

  test("probe failures propagate so unavailable state cannot become live", async () => {
    await expect(evaluateOfferLiveness(validation, async () => {
      throw new Error("database unavailable");
    })).rejects.toThrow("database unavailable");
  });
});
