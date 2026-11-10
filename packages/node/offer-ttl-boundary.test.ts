import { describe, expect, test } from "bun:test";
import {
  Intent,
  LedgerParameters,
  LedgerState,
  Transaction,
  WellFormedStrictness,
} from "@midnightntwrk/ledger-v9";
import { getReferenceState, REFERENCE_PARAMETERS } from "@zswap-da/validator";

import { ROOT_WINDOW_DEFAULT_S } from "./network-windows.ts";

// The intent TTL boundary, checked against the pinned ledger-v9 WASM, not our
// own arithmetic. Shielded offers carry no TTL at all, so only intents are
// exercised here.
//
// Ledger 9 rejects an intent whose `ttl > tblock + global_ttl` (or whose
// `ttl < tblock`). The check runs first in `Transaction.wellFormed`
// (midnight-ledger `ledger-9.1.0.0`, ledger/src/verify.rs:641-645 and
// :1731-1750, `ttl_check_weak`) and again at apply
// (ledger/src/semantics.rs:1966-1971). Proofs, signatures, balancing and
// limits are switched off below, so the TTL check is the only one that can
// fail for these proof-erased transactions.
//
// Every case runs on the kernel's reference state of each pinned network (the
// network's real ledger parameters, packages/validator/reference-parameters.ts),
// with a transaction carrying that network's id. `LedgerState.blank` would not
// do: it carries the ledger's INITIAL_PARAMETERS, whose `global_ttl` is 3600 s
// (ledger/src/structure.rs:1371), while every network runs 1,209,600 s.

const BLANK_NETWORK = "undeployed";

function globalTtlSeconds(p: LedgerParameters): number {
  const m = p.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
  if (!m) throw new Error("global_ttl not found in the LedgerParameters dump");
  return Number(m[1]);
}

function ttlOnlyStrictness(): WellFormedStrictness {
  const s = new WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = false;
  s.verifyContractProofs = false;
  s.verifySignatures = false;
  s.enforceLimits = false;
  return s;
}

/** `null` when the ledger accepts an intent with `ttl` at block time `tblock`,
 *  otherwise the ledger's error message. */
function ttlVerdict(state: LedgerState, tblock: Date, ttl: Date, network: string = BLANK_NETWORK): string | null {
  const tx = Transaction.fromPartsRandomized(network, undefined, undefined, Intent.new(ttl) as never);
  try {
    tx.eraseProofs().wellFormed(state, ttlOnlyStrictness(), tblock);
    return null;
  } catch (err) {
    return String(err);
  }
}

// Whole seconds: ledger timestamps have second resolution.
const NOW = new Date("2026-11-09T12:00:00.000Z");
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
const TOO_FAR = /Intent TTL is too far in the future/;
const EXPIRED = /Intent TTL has expired/;

describe("intent TTL vs the ledger-9 global_ttl", () => {
  test("the local and public test networks all have a reference state", () => {
    expect(Object.keys(REFERENCE_PARAMETERS)).toEqual(
      expect.arrayContaining(["undeployed", "preview", "preprod"]),
    );
  });

  for (const network of Object.keys(REFERENCE_PARAMETERS)) {
    describe(`the kernel's ${network} reference state`, () => {
      const state = getReferenceState(network);

      test("its global_ttl is the kernel's root window (14 days)", () => {
        expect(globalTtlSeconds(state.parameters)).toBe(ROOT_WINDOW_DEFAULT_S);
      });

      test("the bound is tblock + global_ttl, inclusive; one second more is rejected", () => {
        expect(ttlVerdict(state, NOW, at(NOW, ROOT_WINDOW_DEFAULT_S), network)).toBeNull();
        expect(ttlVerdict(state, NOW, at(NOW, ROOT_WINDOW_DEFAULT_S + 1), network)).toMatch(TOO_FAR);
      });

      test("2 h, 3 days and 14 days − 1 min are accepted", () => {
        for (const seconds of [2 * 3_600, 3 * 86_400, ROOT_WINDOW_DEFAULT_S - 60]) {
          expect(ttlVerdict(state, NOW, at(NOW, seconds), network)).toBeNull();
        }
      });

      test("an expired TTL is rejected; a TTL equal to the block time is not", () => {
        expect(ttlVerdict(state, NOW, at(NOW, -1), network)).toMatch(EXPIRED);
        expect(ttlVerdict(state, NOW, NOW, network)).toBeNull();
      });
    });
  }

  test("a blank state's bound is 1 h: the bug the reference state fixes", () => {
    const blank = LedgerState.blank(BLANK_NETWORK);
    expect(ttlVerdict(blank, NOW, at(NOW, 3_600))).toBeNull();
    expect(ttlVerdict(blank, NOW, at(NOW, 3_601))).toMatch(TOO_FAR);
    expect(ttlVerdict(blank, NOW, at(NOW, 2 * 3_600))).toMatch(TOO_FAR);
  });
});
