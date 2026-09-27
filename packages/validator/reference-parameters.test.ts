import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LedgerParameters, LedgerState } from "@midnight-ntwrk/ledger-v8";

import { REFERENCE_PARAMETERS } from "./reference-parameters.ts";
import {
  getBlankRefState,
  getReferenceState,
  referenceDustGracePeriodSeconds,
  requireReferenceParameters,
  UnknownNetworkParametersError,
} from "./refstate.ts";

// 00056 FR-001 / T4: the validator's reference state carries each network's
// PINNED ledger parameters. These tests pin what the bytes are (provenance
// hash), what they say (global_ttl, DUST grace) and what happens for a network
// without a snapshot.

const GLOBAL_TTL_S = 1_209_600; // 14 days, every network (static; hard fork to change)
const DUST_GRACE_S = 10_800; // 3 h
const HEADER = "midnight:ledger-parameters[v5]:"; // ledger 8's LedgerParameters tag

/** `LedgerParameters` exposes no `global_ttl` getter; its debug dump does. */
function globalTtlSeconds(p: LedgerParameters): number {
  const m = p.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
  if (!m) throw new Error("global_ttl not found in the LedgerParameters dump");
  return Number(m[1]);
}

describe("pinned reference parameters", () => {
  test("exactly the ledger-8 networks this line serves have a snapshot", () => {
    expect(Object.keys(REFERENCE_PARAMETERS).sort()).toEqual(["mainnet", "preprod", "preview", "undeployed"]);
  });

  for (const snapshot of Object.values(REFERENCE_PARAMETERS)) {
    describe(snapshot.networkId, () => {
      const bytes = Buffer.from(snapshot.hex, "hex");

      test("the bytes match their recorded sha256 and carry the ledger-9 header", () => {
        expect(snapshot.hex).toMatch(/^[0-9a-f]+$/);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(snapshot.sha256);
        expect(bytes.subarray(0, HEADER.length).toString("latin1")).toBe(HEADER);
        expect(snapshot.source.length).toBeGreaterThan(20);
      });

      test("they decode to global_ttl = 14 days and a 3 h DUST grace period", () => {
        const parameters = LedgerParameters.deserialize(bytes);
        expect(globalTtlSeconds(parameters)).toBe(GLOBAL_TTL_S);
        expect(Number(parameters.dust.dustGracePeriodSeconds)).toBe(DUST_GRACE_S);
        expect(referenceDustGracePeriodSeconds(snapshot.networkId)).toBe(DUST_GRACE_S);
      });

      test("getReferenceState carries them (and is cached)", () => {
        const state = getReferenceState(snapshot.networkId);
        expect(state).toBeInstanceOf(LedgerState);
        expect(state).toBe(getReferenceState(snapshot.networkId));
        expect(Buffer.from(state.parameters.serialize()).toString("hex")).toBe(snapshot.hex);
        expect(globalTtlSeconds(state.parameters)).toBe(GLOBAL_TTL_S);
        // The deprecated alias returns the same reference state, not a blank one.
        expect(getBlankRefState(snapshot.networkId)).toBe(state);
      });
    });
  }

  test("the snapshots differ only in fee prices (same limits, cost model, DUST and global_ttl)", () => {
    const withoutFeePrices = (hex: string) => LedgerParameters.deserialize(Buffer.from(hex, "hex"))
      .toString()
      .split("\n")
      .filter((line) => !/overall_price|read_factor|compute_factor|block_usage_factor|write_factor/.test(line))
      .join("\n");
    const reference = withoutFeePrices(REFERENCE_PARAMETERS["undeployed"]!.hex);
    for (const snapshot of Object.values(REFERENCE_PARAMETERS)) {
      expect({ network: snapshot.networkId, same: withoutFeePrices(snapshot.hex) === reference })
        .toEqual({ network: snapshot.networkId, same: true });
    }
  });

  test("the pitfall they replace: a BLANK state's global_ttl is only 3600 s", () => {
    expect(globalTtlSeconds(LedgerState.blank("undeployed").parameters)).toBe(3_600);
    expect(globalTtlSeconds(LedgerParameters.initialParameters())).toBe(3_600);
  });
});

describe("a network without a snapshot fails loudly", () => {
  for (const networkId of ["stagenet", "devnet", "qanet", "", "undeployed "]) {
    test(`requireReferenceParameters(${JSON.stringify(networkId)}) throws, naming the supported ids`, () => {
      let error: unknown;
      try {
        requireReferenceParameters(networkId);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(UnknownNetworkParametersError);
      expect((error as Error).message).toContain(`MIDNIGHT_NETWORK_ID='${networkId}'`);
      expect((error as Error).message).toContain("supported: mainnet, preprod, preview, undeployed");
      expect(() => getReferenceState(networkId)).toThrow(UnknownNetworkParametersError);
    });
  }

  test("inherited object keys are not snapshots", () => {
    expect(() => requireReferenceParameters("toString")).toThrow(UnknownNetworkParametersError);
    expect(() => requireReferenceParameters("__proto__")).toThrow(UnknownNetworkParametersError);
  });
});
