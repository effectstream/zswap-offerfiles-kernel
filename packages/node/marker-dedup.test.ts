// Marker dedup, the part that is NOT a database question.
//
// Two things this file pins, both of which the DB tests
// (packages/database/marker-dedup.test.ts) take for granted:
//
//   1. WHAT an offer declares. The rule is only as good as the marker list it
//      probes, so the derivation is asserted against the REAL wrapper pair from
//      the shapes testkit rather than a hand-built stub. That pair is the
//      measured evasion in miniature: two byte-different blobs, two different
//      offer_hashes, one identical set of markers.
//   2. WHERE the check runs, at BOTH doors. The API gate and the STM path are
//      separate code, and the rule is only sound if they agree — the same
//      CROSS_LAYER problem, answered the same way. Asserted at the source
//      level, because a runtime import of either door starts a stack.
//
//   bun test packages/node/marker-dedup.test.ts

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Relative, not "@zswap-da/validator": the testkit is deliberately outside the
// package's public surface (mod.ts exports the validator, not its fixtures).
import { allShapes, decodeShape } from "../validator/shapes.testkit.ts";
import { declaredMarkers, duplicateMarkerReason, DUPLICATE_MARKERS } from "./marker-dedup.ts";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf-8");

const shapes = new Map(allShapes().map((s) => [s.id, s]));

const key = (m: ReturnType<typeof declaredMarkers>[number]) =>
  m.kind === "commitment"
    ? `c:${m.commitment}`
    : `u:${m.owner}/${m.intentHash}/${m.outputNo}`;

test("the wrapper pair: different bytes, different hash, IDENTICAL markers", () => {
  // This is the whole argument for rule (ii) in one assertion. The pair wraps
  // ONE intent twice — Transaction.fromParts pins segment 1,
  // fromPartsRandomized picks another — so the blobs differ and rule (i), which
  // keys on the bytes, relates them not at all. `intentHash(0)` does not depend
  // on the physical segment, so both declare the same payout identity.
  const a = shapes.get("same-intent-wrapper-a");
  const b = shapes.get("same-intent-wrapper-b");
  expect(a && b).toBeTruthy();
  expect(a!.blob).not.toBe(b!.blob); // rule (i) sees two unrelated offers

  const markersA = declaredMarkers(decodeShape(a!.blob)).map(key);
  const markersB = declaredMarkers(decodeShape(b!.blob)).map(key);
  expect(markersA.length).toBeGreaterThan(0);
  expect(markersB).toEqual(markersA); // rule (ii) sees one offer, declared twice
});

test("a different offer declares different markers — the rule discriminates", () => {
  // The guard: if every shape produced the same marker list, the test above
  // would pass for the wrong reason.
  //
  // `fallible-single` and NOT `guaranteed-single`, for a reason worth recording:
  // the testkit builds every structural shape from ONE deterministic recipe, so
  // `guaranteed-single` and the wrapper pair genuinely declare the same marker
  // — same maker, same intent contents, same `intentHash(0)`. That is a fixture
  // property, not a collision the rule invents. `fallible-single` places its
  // output in the fallible section, whose identity is
  // `intentHash(physicalSegment)`, so its marker is disjoint.
  const wrapper = declaredMarkers(decodeShape(shapes.get("same-intent-wrapper-a")!.blob)).map(key);
  const other = declaredMarkers(decodeShape(shapes.get("fallible-single")!.blob)).map(key);
  expect(other.length).toBeGreaterThan(0);
  expect(other.some((m) => wrapper.includes(m))).toBe(false);
});

test("markers are derived from BOTH layers, generally", () => {
  // Not commitments alone: the wrapper pairs actually measured on chain were
  // unshielded and carry no commitments at all, so a commitment-only rule would
  // miss the case that motivated the ruling. The testkit's shapes are
  // unshielded, so the unshielded branch is what must be non-empty here; the
  // commitment branch is exercised against a stub because building a real
  // shielded offer needs a chain.
  const kinds = new Set(
    declaredMarkers(decodeShape(shapes.get("multi-intent")!.blob)).map((m) => m.kind),
  );
  expect(kinds.has("unshielded-output")).toBe(true);

  const shieldedStub = {
    guaranteedOffer: { outputs: [{ commitment: "aa" }, { commitment: "bb" }] },
    intents: undefined,
  } as any;
  expect(declaredMarkers(shieldedStub)).toEqual([
    { kind: "commitment", commitment: "aa" },
    { kind: "commitment", commitment: "bb" },
  ]);
});

test("the marker order is a pure function of the offer, so replicas agree", () => {
  // Two probes of the same blob must report the SAME first conflict, or two
  // replicas could reject with different reasons for the same blob — which p7a
  // would see as divergence.
  const blob = shapes.get("multi-intent")!.blob;
  expect(declaredMarkers(decodeShape(blob)).map(key)).toEqual(
    declaredMarkers(decodeShape(blob)).map(key),
  );
});

test("the reject reason names the incumbent by content address", () => {
  const reason = duplicateMarkerReason(
    { kind: "commitment", commitment: "abc" },
    "0".repeat(64),
  );
  expect(reason).toContain("abc");
  expect(reason).toContain("0".repeat(64));
  // Never crashes on a hash-less incumbent (pre-005 rows); says so instead.
  expect(duplicateMarkerReason({ kind: "commitment", commitment: "abc" }, null))
    .toContain("hash unavailable");
});

// ── Both doors, same predicate, same place ──────────────────────────────────
//
// The API gate can only ADVISE — the DA namespace is permissionless, so a blob
// can reach the STM without ever passing through it — while the STM decides. A
// rule implemented at one door only is a rule with a bypass; a rule implemented
// twice, differently, is worse. So: same two queries, and in both files the
// step sits AFTER crypto verification and BEFORE the side effect.

// CALL SITES, not bare symbol names: every one of these appears in the import
// block first, and an import-position comparison is trivially satisfied — a
// decorative test that would keep passing with the check deleted from the body.
const DOORS = [
  { file: "api.ts", sideEffect: "submitBlobViaBatcher(blob)", hashDedup: "getOfferStatusByHash.run(" },
  {
    file: "state-machine.ts",
    sideEffect: "World.resolve(insertOfferFileWithHash",
    hashDedup: "World.resolve(getOfferStatusByHash",
  },
];

for (const door of DOORS) {
  test(`${door.file}: marker dedup runs after crypto and before the side effect`, () => {
    const src = read(`./${door.file}`);
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const crypto = stripped.indexOf("verifyOfferCrypto(");
    const dedup = stripped.indexOf("declaredMarkers(");
    const effect = stripped.indexOf(door.sideEffect);
    expect(crypto).toBeGreaterThan(-1);
    expect(dedup).toBeGreaterThan(-1);
    expect(effect).toBeGreaterThan(-1);

    // AFTER crypto is the security property, not a preference: this check
    // writes a claim on markers, so an unverified blob able to register a
    // victim's markers would block the victim's real offer.
    expect(dedup).toBeGreaterThan(crypto);
    expect(dedup).toBeLessThan(effect);
  });

  test(`${door.file}: asks both marker probes, and rejects with ${DUPLICATE_MARKERS}`, () => {
    const src = read(`./${door.file}`);
    expect(src).toContain("findActiveOfferByCommitment");
    expect(src).toContain("findActiveOfferByUnshieldedOutput");
    expect(src).toContain("DUPLICATE_MARKERS");
    expect(src).toContain("duplicateMarkerReason");
  });
}

test("byte-identical dedup still runs FIRST, at both doors", () => {
  // Rule (i) is unchanged and must stay ahead of crypto: it is one indexed
  // probe on a hash already computed, against the cheapest attack there is.
  // Reordering it behind crypto would make every replay pay a wellFormed.
  for (const door of DOORS) {
    const stripped = read(`./${door.file}`)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const hashDedup = stripped.indexOf(door.hashDedup);
    expect(hashDedup).toBeGreaterThan(-1);
    expect(hashDedup).toBeLessThan(stripped.indexOf("verifyOfferCrypto("));
  }
});
