import { describe, expect, test } from "bun:test";

import {
  ADMISSION_POLICY_FIELDS,
  admissionPairKey,
  forwardAdmissionPolicy,
  type JobAdmissionPolicy,
} from "./admission-policy.ts";
import { pairKey } from "./ladder-schema.ts";

// FR-002's lockstep property, at the only layer where it can be asserted
// mechanically. The finding this replaces (P4-F02) was invisible: `run.ts`
// handed `supportedPairs`/`minJobOutput` to the relay client, the relay client's
// options interface did not declare them, its forwarder did not copy them, and
// the solver published pairs and sizes its own executor refused. Nothing threw,
// nothing logged.
//
// The load-bearing guard is a COMPILE error (`admission-policy.ts` intersects
// `keyof JobAdmissionPolicy` against `ADMISSION_POLICY_FIELDS`), so what these
// tests pin is the runtime half: forwarding is driven BY that tuple, so a field
// added to the tuple reaches every consumer without touching a single call
// site, and the three states of a field — configured, explicitly open, absent —
// stay distinguishable end to end.

const A = `01${"00".repeat(31)}`;
const B = `02${"00".repeat(31)}`;

/** Every field populated with a distinguishable value, built from the tuple so
 *  it cannot fall behind it. */
const populated = (): JobAdmissionPolicy => ({
  supportedPairs: new Set([admissionPairKey(A, B)]),
  minJobOutput: new Map([[B, 7n]]),
});

describe("job admission policy — one typed policy, one forwarder (FR-002)", () => {
  test("every declared field survives the hop, and the tuple is the complete field list", () => {
    const source = populated();
    const forwarded = forwardAdmissionPolicy(source);

    // Exactly the tuple's fields, no more and no fewer: a field the interface
    // declares but the tuple omits would be missing here (and would already
    // have failed to compile).
    expect(Object.keys(forwarded).sort()).toEqual([...ADMISSION_POLICY_FIELDS].sort());
    expect(Object.keys(source).sort()).toEqual([...ADMISSION_POLICY_FIELDS].sort());
    // By reference, not by copy: the derivation must match against the very set
    // the operator configured.
    expect(forwarded.supportedPairs).toBe(source.supportedPairs);
    expect(forwarded.minJobOutput).toBe(source.minJobOutput);
  });

  test("each field forwards on its own, so no field depends on another being set", () => {
    const source = populated();
    for (const field of ADMISSION_POLICY_FIELDS) {
      const only = forwardAdmissionPolicy({ [field]: source[field] });
      expect(Object.keys(only), field).toEqual([field]);
      expect(only[field], field).toBe(source[field]);
    }
  });

  test("absent stays absent and explicit-open stays open — they are not the same state", () => {
    // Absent: the consumer's own default applies. Critically NOT forwarded as
    // an explicit `undefined`, which `exactOptionalPropertyTypes` rejects and
    // which would read as "configured" to a spread.
    expect(forwardAdmissionPolicy({})).toEqual({});
    expect("supportedPairs" in forwardAdmissionPolicy({})).toBe(false);
    expect("supportedPairs" in forwardAdmissionPolicy({ supportedPairs: undefined })).toBe(false);

    // Explicit open (the Q-RF-2 amendment, warned about at startup) is a
    // decision and must reach every layer as one.
    const open = forwardAdmissionPolicy({ supportedPairs: null, minJobOutput: null });
    expect(open).toEqual({ supportedPairs: null, minJobOutput: null });
  });

  test("an empty configured policy is a total refusal, not an open one", () => {
    // The distinction the forwarder must preserve: an empty set/map is a
    // configured policy that admits nothing, and both derivation and executor
    // read it that way.
    const closed = forwardAdmissionPolicy({
      supportedPairs: new Set<string>(),
      minJobOutput: new Map<string, bigint>(),
    });
    expect(closed.supportedPairs?.size).toBe(0);
    expect(closed.minJobOutput?.size).toBe(0);
    expect(closed.supportedPairs).not.toBeNull();
  });

  test("the forwarder returns a fresh object, so one layer cannot mutate another's policy", () => {
    const source = populated();
    const forwarded = forwardAdmissionPolicy(source);
    expect(forwarded).not.toBe(source);
    delete (forwarded as Record<string, unknown>)["minJobOutput"];
    expect(source.minJobOutput).toBeDefined();
  });
});

describe("job admission policy — the configured directed-pair grammar", () => {
  test("the key is the lowercased `in->out` form the env grammar accepts", () => {
    expect(admissionPairKey(A, B)).toBe(`${A}->${B}`);
    expect(admissionPairKey(A.toUpperCase(), B.toUpperCase())).toBe(`${A}->${B}`);
    // Directed: the reverse pair is a different policy entry entirely.
    expect(admissionPairKey(B, A)).not.toBe(admissionPairKey(A, B));
  });

  test("it is deliberately NOT the internal grouping key", () => {
    // `ladder-schema`'s `pairKey` groups offers inside derivation; this one is
    // typed by an operator into SOLVER_SUPPORTED_PAIRS. Kept distinct so a
    // change to either cannot silently reinterpret the other's strings.
    expect(admissionPairKey(A, B)).not.toBe(pairKey(A, B));
    expect(pairKey(A, B)).toContain("|");
    expect(admissionPairKey(A, B)).toContain("->");
  });
});
