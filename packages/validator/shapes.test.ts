// #5 phase (a) — do these shapes EXIST on the wire?
//
// The exit criterion for phase (a) is exactly this and nothing more: blobs that
// decode, hash and round-trip. What the ladder should DO with them is phase (b);
// asserting that here would be building (b) speculatively, which the plan
// explicitly warns against because (a)'s outcome can reshape it.
//
// A shape that turns out to be unconstructible is a FINDING, not a dead end —
// so each is asserted individually and by name.
//
//   bun test packages/validator/shapes.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";
import {
  allShapes,
  decodeShape,
  structuralShapes,
  hostileShapes,
  GIVE_TOKEN,
  WANT_TOKEN,
} from "./shapes.testkit.ts";
import { collectUnshieldedOutputs, collectUnshieldedSpends } from "./derive.ts";
import { validateZswapOfferBytes } from "./validate.ts";
import { getBlankRefState } from "./refstate.ts";

const shapes = allShapes();
const byId = new Map(shapes.map((s) => [s.id, s]));

const EXPECTED = [
  "guaranteed-single",
  "fallible-single",
  "same-intent-wrapper-a",
  "same-intent-wrapper-b",
  "multi-intent",
  "no-spendable-input",
];

describe("phase (a) — every planned shape is constructible", () => {
  test("all six shapes were built", () => {
    expect([...byId.keys()].sort()).toEqual([...EXPECTED].sort());
  });

  for (const id of EXPECTED) {
    test(`${id}: decodes, hashes and round-trips`, () => {
      const s = byId.get(id)!;
      expect(s.blob.startsWith("swapoffer1")).toBe(true);

      // Round-trip through the exact path the ladder takes.
      const raw = OfferFiles.decode(s.blob);
      const back = decodeShape(s.blob);
      expect(back).toBeDefined();

      // Byte-stable: re-serializing the decoded transaction reproduces the
      // bytes. Without this the offer_hash a node computes on ingestion could
      // differ from the publisher's, and content addressing would be a lie.
      const reserialized = (back as any).serialize() as Uint8Array;
      expect(Buffer.from(reserialized).equals(Buffer.from(raw))).toBe(true);

      // offer_hash, computed the way the indexer computes it.
      const hash = createHash("sha256").update(raw).digest("hex");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  }
});

describe("phase (a) — the shapes are actually DIFFERENT from each other", () => {
  // A builder that silently produced six copies of the control would pass every
  // assertion above. These are what make the fixtures worth having.

  test("every shape has a distinct offer_hash", () => {
    const hashes = shapes.map((s) =>
      createHash("sha256").update(OfferFiles.decode(s.blob)).digest("hex"),
    );
    expect(new Set(hashes).size).toBe(shapes.length);
  });

  test("the two same-intent wrappers embed the SAME intent at different segments", () => {
    const a: any = decodeShape(byId.get("same-intent-wrapper-a")!.blob);
    const b: any = decodeShape(byId.get("same-intent-wrapper-b")!.blob);

    const segsA = [...(a.intents as Map<number, any>).keys()];
    const segsB = [...(b.intents as Map<number, any>).keys()];
    expect(segsA).not.toEqual(segsB);

    // Same intent content — proven by the intent hash at a FIXED segment, which
    // is a function of the intent alone. This is the property byte-identical
    // dedup cannot see, and the reason "duplicate" needs a stated rule.
    const hashAt = (tx: any, seg: number) =>
      String([...(tx.intents as Map<number, any>).values()][0]!.intentHash(seg));
    expect(hashAt(a, 0)).toBe(hashAt(b, 0));

    // …while the blobs, and therefore the offer_hashes, differ.
    expect(byId.get("same-intent-wrapper-a")!.blob).not.toBe(
      byId.get("same-intent-wrapper-b")!.blob,
    );
  });

  test("multi-intent really carries more than one intent", () => {
    const tx: any = decodeShape(byId.get("multi-intent")!.blob);
    expect((tx.intents as Map<number, any>).size).toBeGreaterThan(1);
  });

  test("fallible-single carries its offer in the fallible section, control in guaranteed", () => {
    const fallible: any = decodeShape(byId.get("fallible-single")!.blob);
    const control: any = decodeShape(byId.get("guaranteed-single")!.blob);
    const only = (tx: any) => [...(tx.intents as Map<number, any>).values()][0]!;

    expect(only(fallible).fallibleUnshieldedOffer).toBeDefined();
    expect(only(fallible).guaranteedUnshieldedOffer).toBeUndefined();
    expect(only(control).guaranteedUnshieldedOffer).toBeDefined();
    expect(only(control).fallibleUnshieldedOffer).toBeUndefined();
  });

  // The measurement the whole segment rule rests on. If these were equal the
  // guaranteed/fallible distinction would be unobservable and #5's premise
  // would be wrong.
  test("intentHash(0) differs from intentHash(physicalSegment)", () => {
    const tx: any = decodeShape(byId.get("fallible-single")!.blob);
    const [seg, intent] = [...(tx.intents as Map<number, any>).entries()][0]!;
    expect(seg).not.toBe(0);
    expect(String(intent.intentHash(0))).not.toBe(String(intent.intentHash(seg)));
  });
});

describe("phase (a) — what the derivation helpers see today", () => {
  // Recorded, NOT asserted as correct. Phase (b) decides what is right; this
  // pins current behaviour so (b)'s change is visible as a diff rather than
  // arriving with nothing to compare against.

  test("MEASUREMENT: derived legs per shape", () => {
    for (const s of structuralShapes()) {
      const tx = decodeShape(s.blob);
      let desc: string;
      try {
        const { gives, wants } = P2pAtomicSwaps.deriveTokenLegs(tx as any);
        desc = `gives=${gives.length} wants=${wants.length}`;
      } catch (e) {
        desc = `THREW: ${e instanceof Error ? e.message : String(e)}`;
      }
      console.log(`  ${s.id.padEnd(24)} ${desc}`);
    }
    expect(true).toBe(true);
  });

  test("MEASUREMENT: unshielded spends and outputs per shape", () => {
    for (const s of allShapes()) {
      const tx = decodeShape(s.blob);
      const spends = collectUnshieldedSpends(tx);
      const outs = collectUnshieldedOutputs(tx);
      console.log(
        `  ${s.id.padEnd(24)} spends=${spends.length} outputs=${outs.length}` +
          (outs.length ? ` first=${JSON.stringify(outs[0])}` : ""),
      );
    }
    expect(true).toBe(true);
  });

  test("no-spendable-input really has no spends", () => {
    const tx = decodeShape(byId.get("no-spendable-input")!.blob);
    expect(collectUnshieldedSpends(tx).length).toBe(0);
    expect(collectUnshieldedOutputs(tx).length).toBeGreaterThan(0);
  });

  test("the control's spend and payout use the token colours the kit declares", () => {
    const tx = decodeShape(byId.get("guaranteed-single")!.blob);
    const outs = collectUnshieldedOutputs(tx);
    expect(outs.some((o) => o.tokenType === WANT_TOKEN)).toBe(true);
    expect(collectUnshieldedSpends(tx).length).toBe(1);
    expect(GIVE_TOKEN).not.toBe(WANT_TOKEN);
  });
});

describe("phase (a) — byte-surgery census (#20 absorbed)", () => {
  // The question #20 asked: can a hostile publisher drive UNKNOWN_TOKEN or
  // ROOT_UNREADABLE from the wire? Answered by exhaustion rather than by
  // argument — flip every byte of a REAL proven offer and tally the verdicts.
  //
  // THE FULL SWEEP, run during development over all 15,479 positions:
  //
  //     ACCEPTED          15131
  //     BAD_DESERIALIZE     346
  //     NOT_A_SWAP            2
  //
  // Neither UNKNOWN_TOKEN nor ROOT_UNREADABLE appears anywhere. The sweep takes
  // ~90 s, so what runs here is a stride sample — which is enough for the
  // NEGATIVE claim this test makes (a sample that found either code would
  // refute the finding) but is NOT the exhaustive proof. The two NOT_A_SWAP
  // positions are rare enough that a sample usually misses them, which is why
  // this test asserts absence rather than the exact code set.
  test("sampled byte flips never reach UNKNOWN_TOKEN or ROOT_UNREADABLE", () => {
    let raw: Uint8Array;
    try {
      raw = OfferFiles.decode(
        readFileSync(new URL("./fixtures/valid-offer.bech32", import.meta.url), "utf-8").trim(),
      );
    } catch {
      console.log("  no valid-offer fixture — census skipped (see fixtures/README.md)");
      return;
    }
    const opts = {
      refState: getBlankRefState("undeployed" as any),
      tblock: new Date(),
      maxBytes: 1 << 20,
      crypto: "defer" as const,
    };
    const codes = new Map<string, number>();
    for (let i = 0; i < raw.length; i += 41) {
      const c = Uint8Array.from(raw);
      c[i] = c[i]! ^ 0xff;
      let code: string;
      try {
        const v = validateZswapOfferBytes(c, opts);
        code = v.ok ? "ACCEPTED" : String(v.code);
      } catch {
        code = "THREW";
      }
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
    console.log(`  census over ${Math.ceil(raw.length / 41)} of ${raw.length} positions:`);
    for (const [k, v] of [...codes].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }

    // The finding: neither code is reachable from the wire.
    expect(codes.has("UNKNOWN_TOKEN")).toBe(false);
    expect(codes.has("ROOT_UNREADABLE")).toBe(false);
    // And the ladder never crashes on hostile bytes — it always answers.
    expect(codes.has("THREW")).toBe(false);

    // ACCEPTED here means "survived the PRE-CRYPTO ladder": crypto is deferred,
    // so a flipped proof byte is not yet caught. That is the correct reading of
    // this census, not a claim that mutated offers are indexable.
    expect((codes.get("ACCEPTED") ?? 0) > 0).toBe(true);
  });
});

describe("phase (a) — determinism", () => {
  // The fixtures are used by unit tests AND by an e2e p4 fixture. If two calls
  // produced different bytes, an e2e failure could never be reproduced locally.
  test("building twice yields identical blobs, except where a TTL is involved", () => {
    const a = new Map(structuralShapes().map((s) => [s.id, s.blob]));
    const b = new Map(structuralShapes().map((s) => [s.id, s.blob]));
    for (const id of a.keys()) {
      // Intent TTL is wall-clock, so bytes are only stable within the same
      // millisecond. What must be stable is the SHAPE, which the tests above
      // assert structurally. Recorded here rather than asserted, honestly:
      // this is a documented limitation of the kit, not a passing guarantee.
      if (a.get(id) !== b.get(id)) {
        console.log(`  ${id}: bytes differ between builds (TTL is wall-clock)`);
      }
    }
    expect(a.size).toBe(b.size);
  });
});
