import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LedgerParameters, LedgerState } from "@midnightntwrk/ledger-v9";

import { REFERENCE_PARAMETERS, UNPINNED_REFERENCE_PARAMETERS } from "./reference-parameters.ts";
import {
  getBlankRefState,
  getReferenceState,
  ReferenceParametersNotPinnedError,
  referenceDustGracePeriodSeconds,
  requireReferenceParameters,
  UnknownNetworkParametersError,
} from "./refstate.ts";

// The validator's reference state carries each network's PINNED ledger
// parameters. These tests pin what the bytes are (sha256, ledger-9 header),
// what they say (global_ttl, DUST grace period) and what happens for a
// network without a snapshot.

const GLOBAL_TTL_S = 1_209_600; // 14 days, every network
const DUST_GRACE_S = 10_800; // 3 h
const HEADER = "midnight:ledger-parameters[v8]:"; // ledger 9's LedgerParameters tag

/** The pinned networks, in declaration order (the order the error lists). */
const PINNED = ["undeployed", "preview", "preprod"];

/** `LedgerParameters` exposes no `global_ttl` getter; its debug dump does. */
function globalTtlSeconds(p: LedgerParameters): number {
  const m = p.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
  if (!m) throw new Error("global_ttl not found in the LedgerParameters dump");
  return Number(m[1]);
}

/** The debug dump without its `fee_prices` block: the parameters that do not
 *  move from block to block. */
function staticDump(p: LedgerParameters): string {
  const dump = p.toString();
  const without = dump.replace(/\n\s*fee_prices: FeePrices \{[^}]*\},/, "");
  if (without === dump) throw new Error("fee_prices block not found in the LedgerParameters dump");
  return without;
}

/** Lines of `a` that are not in `b`, trimmed. */
function linesOnlyIn(a: string, b: string): string[] {
  const other = new Set(b.split("\n").map((l) => l.trim()));
  return a.split("\n").map((l) => l.trim()).filter((l) => !other.has(l));
}

const decoded = (networkId: string) =>
  LedgerParameters.deserialize(Buffer.from(REFERENCE_PARAMETERS[networkId]!.hex, "hex"));

describe("pinned reference parameters", () => {
  test("exactly the ledger-9 networks with a pinned snapshot, in declaration order", () => {
    expect(Object.keys(REFERENCE_PARAMETERS)).toEqual(PINNED);
  });

  for (const [key, snapshot] of Object.entries(REFERENCE_PARAMETERS)) {
    describe(key, () => {
      const bytes = Buffer.from(snapshot.hex, "hex");

      test("the bytes match their recorded sha256 and carry the ledger-9 header", () => {
        expect(snapshot.networkId).toBe(key);
        expect(snapshot.hex).toMatch(/^[0-9a-f]+$/);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(snapshot.sha256);
        expect(bytes.subarray(0, HEADER.length).toString("latin1")).toBe(HEADER);
      });

      test("the provenance names a date and carries no endpoint token", () => {
        expect(snapshot.source).toMatch(/\b2026-\d\d-\d\d\b/);
        expect(snapshot.source).not.toContain("project_id");
        expect(snapshot.source).not.toMatch(/[?&]\w+=/);
      });

      test("they decode to global_ttl = 14 days and a 3 h DUST grace period", () => {
        const parameters = LedgerParameters.deserialize(bytes);
        expect(globalTtlSeconds(parameters)).toBe(GLOBAL_TTL_S);
        expect(Number(parameters.dust.dustGracePeriodSeconds)).toBe(DUST_GRACE_S);
        expect(referenceDustGracePeriodSeconds(key)).toBe(DUST_GRACE_S);
        // Decoding is lossless: the pinned bytes are what the ledger re-serializes.
        expect(Buffer.from(parameters.serialize()).toString("hex")).toBe(snapshot.hex);
      });

      test("getReferenceState carries them (and is cached)", () => {
        const state = getReferenceState(key);
        expect(state).toBeInstanceOf(LedgerState);
        expect(state).toBe(getReferenceState(key));
        expect(Buffer.from(state.parameters.serialize()).toString("hex")).toBe(snapshot.hex);
        expect(globalTtlSeconds(state.parameters)).toBe(GLOBAL_TTL_S);
        // The deprecated alias returns the same reference state, not a blank one.
        expect(getBlankRefState(key)).toBe(state);
      });
    });
  }

  test("each network has its own snapshot: no two entries share bytes", () => {
    const hashes = Object.values(REFERENCE_PARAMETERS).map((s) => s.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("preview and preprod differ only in the per-block fee prices", () => {
    const preview = decoded("preview");
    const preprod = decoded("preprod");
    expect(REFERENCE_PARAMETERS["preview"]!.sha256).not.toBe(REFERENCE_PARAMETERS["preprod"]!.sha256);
    expect(staticDump(preview)).toBe(staticDump(preprod));
  });

  test("undeployed differs from the public networks in max_contract_metadata_size (besides fee prices)", () => {
    const local = staticDump(decoded("undeployed"));
    const preview = staticDump(decoded("preview"));
    expect(linesOnlyIn(local, preview)).toEqual(["max_contract_metadata_size: 10485760,"]);
    expect(linesOnlyIn(preview, local)).toEqual(["max_contract_metadata_size: 50000,"]);
  });

  test("the pitfall they replace: a BLANK state's global_ttl is only 3600 s", () => {
    expect(globalTtlSeconds(LedgerState.blank("undeployed").parameters)).toBe(3_600);
    expect(globalTtlSeconds(LedgerParameters.initialParameters())).toBe(3_600);
  });
});

describe("a network without a snapshot fails loudly", () => {
  for (const networkId of ["stagenet", "devnet", "", "undeployed ", "Preview", "PREPROD", "Mainnet"]) {
    test(`requireReferenceParameters(${JSON.stringify(networkId)}) throws, naming the supported ids`, () => {
      let error: unknown;
      try {
        requireReferenceParameters(networkId);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(UnknownNetworkParametersError);
      expect(error).not.toBeInstanceOf(ReferenceParametersNotPinnedError);
      expect((error as UnknownNetworkParametersError).networkId).toBe(networkId);
      expect((error as Error).message).toContain(`no reference ledger parameters for MIDNIGHT_NETWORK_ID='${networkId}'`);
      expect((error as Error).message).toContain("(supported: undeployed, preview, preprod)");
      // The four-vs-three difference is spelled out, not left to the reader.
      expect((error as Error).message).toContain("Supported but not pinned yet, so not startable either: mainnet");
      expect(() => getReferenceState(networkId)).toThrow(UnknownNetworkParametersError);
      expect(() => referenceDustGracePeriodSeconds(networkId)).toThrow(UnknownNetworkParametersError);
    });
  }

  test("mainnet is supported but not pinned yet: the error says so instead of calling it unknown", () => {
    let error: unknown;
    try {
      requireReferenceParameters("mainnet");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReferenceParametersNotPinnedError);
    // Still an UnknownNetworkParametersError: every startup check that refuses
    // an id without parameters refuses this one too.
    expect(error).toBeInstanceOf(UnknownNetworkParametersError);
    const message = (error as Error).message;
    expect(message).toStartWith("reference ledger parameters for MIDNIGHT_NETWORK_ID='mainnet' are not pinned yet: ");
    expect(message).toContain("MidnightRuntimeApi_get_ledger_parameters");
    expect(message).toContain("mainnet is a supported network");
    expect(message).toContain("(pinned today: undeployed, preview, preprod)");
    expect(message).not.toContain("no reference ledger parameters");
    expect((error as ReferenceParametersNotPinnedError).reason).toBe(UNPINNED_REFERENCE_PARAMETERS["mainnet"]!);
    expect(() => getReferenceState("mainnet")).toThrow(ReferenceParametersNotPinnedError);
    expect(() => referenceDustGracePeriodSeconds("mainnet")).toThrow(ReferenceParametersNotPinnedError);
  });

  test("the not-pinned list is exactly mainnet, and no id is both pinned and not pinned", () => {
    expect(Object.keys(UNPINNED_REFERENCE_PARAMETERS)).toEqual(["mainnet"]);
    for (const id of Object.keys(UNPINNED_REFERENCE_PARAMETERS)) {
      expect(Object.hasOwn(REFERENCE_PARAMETERS, id)).toBe(false);
    }
  });

  test("inherited object keys are not snapshots", () => {
    expect(() => requireReferenceParameters("toString")).toThrow(UnknownNetworkParametersError);
    expect(() => requireReferenceParameters("__proto__")).toThrow(UnknownNetworkParametersError);
  });
});
