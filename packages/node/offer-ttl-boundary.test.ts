import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Intent,
  LedgerParameters,
  LedgerState,
  Transaction,
  WellFormedStrictness,
} from "@midnightntwrk/ledger-v9";
import { getReferenceState } from "@zswap-da/validator";

import { ROOT_WINDOW_DEFAULT_S } from "./network-windows.ts";

// The intent TTL boundary, checked against the pinned ledger-v9 WASM, not our
// own arithmetic. Carried over from 00055 (PR #85, commit bdee17b) with its
// fixture; 00056 dropped that PR's client-default and safety-margin cases,
// because shielded offers carry no TTL at all (see spec 00056).
//
// Ledger 9 rejects an intent whose `ttl > tblock + global_ttl` (or whose
// `ttl < tblock`). The check runs first in `Transaction.wellFormed`
// (midnight-ledger `ledger-9.1.0.0-rc.3`, ledger/src/verify.rs:633 and
// :1721-1742, `ttl_check_weak`) and again at apply (ledger/src/semantics.rs:1968).
// Proofs, signatures, balancing and limits are switched off below, so the TTL
// check is the only one that can fail for these proof-erased transactions.
//
// The reference state carries the LIVE stagenet ledger parameters.
// `LedgerState.blank` would not do: it carries the ledger's INITIAL_PARAMETERS,
// whose `global_ttl` is 3600 s (ledger/src/structure.rs:1373), while every
// network runs 1,209,600 s. `LedgerParameters` has no public constructor, so
// the fixture is the serialized parameters from the stagenet indexer:
// `{ block { ledgerParameters } }` at block 637,700
// (808f87ca70f3c822342c3fc9435b9e00a2208fc65807ec52f1654d8ab187ee97),
// 2026-09-26, 791 bytes. The kernel's own stagenet reference state
// (packages/validator/reference-parameters.ts) is these bytes.

const NETWORK = "undeployed";
const FIXTURE = join(import.meta.dir, "test-support", "stagenet-ledger-parameters.hex");
const params = LedgerParameters.deserialize(
  Buffer.from(readFileSync(FIXTURE, "utf8").trim(), "hex"),
);

function globalTtlSeconds(p: LedgerParameters): number {
  const m = p.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
  if (!m) throw new Error("global_ttl not found in the LedgerParameters dump");
  return Number(m[1]);
}

const fixtureState = LedgerState.blank(NETWORK);
fixtureState.parameters = params;

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
function ttlVerdict(state: LedgerState, tblock: Date, ttl: Date, network: string = NETWORK): string | null {
  const tx = Transaction.fromPartsRandomized(network, undefined, undefined, Intent.new(ttl) as never);
  try {
    tx.eraseProofs().wellFormed(state, ttlOnlyStrictness(), tblock);
    return null;
  } catch (err) {
    return String(err);
  }
}

// Whole seconds: ledger timestamps have second resolution.
const NOW = new Date("2026-09-26T12:00:00.000Z");
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
const TOO_FAR = /Intent TTL is too far in the future/;
const EXPIRED = /Intent TTL has expired/;

describe("intent TTL vs the ledger-9 global_ttl", () => {
  test("the fixture's global_ttl is the kernel's root window (14 days)", () => {
    expect(globalTtlSeconds(params)).toBe(ROOT_WINDOW_DEFAULT_S);
    expect(globalTtlSeconds(fixtureState.parameters)).toBe(1_209_600);
  });

  for (const [label, state, network] of [
    ["the stagenet fixture", fixtureState, NETWORK],
    ["the kernel's undeployed reference state", getReferenceState("undeployed"), "undeployed"],
    ["the kernel's stagenet reference state", getReferenceState("stagenet"), "stagenet"],
  ] as const) {
    describe(label, () => {
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
    const blank = LedgerState.blank(NETWORK);
    expect(ttlVerdict(blank, NOW, at(NOW, 3_600))).toBeNull();
    expect(ttlVerdict(blank, NOW, at(NOW, 3_601))).toMatch(TOO_FAR);
    expect(ttlVerdict(blank, NOW, at(NOW, 2 * 3_600))).toMatch(TOO_FAR);
  });
});
