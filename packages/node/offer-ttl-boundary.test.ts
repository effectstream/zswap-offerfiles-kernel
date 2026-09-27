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

// The TTL boundary behind the offer-TTL defaults (00055 FR-005, T4), checked
// against the pinned ledger-v9 WASM, not against our own arithmetic.
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
// 2026-09-26, 791 bytes. Only `global_ttl` matters here; the first test pins it.
import {
  OFFER_TTL_DEFAULT_MINUTES,
  OFFER_TTL_MAX_S,
  ROOT_WINDOW_DEFAULT_S,
  TTL_SAFETY_MARGIN_S,
} from "./network-windows.ts";

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

const refState = LedgerState.blank(NETWORK);
refState.parameters = params;

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
function ttlVerdict(tblock: Date, ttl: Date): string | null {
  const tx = Transaction.fromPartsRandomized(NETWORK, undefined, undefined, Intent.new(ttl) as never);
  try {
    tx.eraseProofs().wellFormed(refState, ttlOnlyStrictness(), tblock);
    return null;
  } catch (err) {
    return String(err);
  }
}

// Whole seconds: ledger timestamps have second resolution.
const NOW = new Date("2026-09-26T12:00:00.000Z");
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);
const DEFAULT_TTL_S = OFFER_TTL_DEFAULT_MINUTES * 60;
const TOO_FAR = /Intent TTL is too far in the future/;

describe("offer TTL vs the ledger-9 global_ttl (00055 T4)", () => {
  test("the fixture's global_ttl is the kernel's root window", () => {
    expect(globalTtlSeconds(params)).toBe(ROOT_WINDOW_DEFAULT_S);
    expect(globalTtlSeconds(refState.parameters)).toBe(1_209_600);
  });

  test("the default TTL (20,100 min) is accepted at the current block time", () => {
    expect(DEFAULT_TTL_S).toBe(OFFER_TTL_MAX_S);
    expect(ttlVerdict(NOW, at(NOW, DEFAULT_TTL_S))).toBeNull();
  });

  test("the bound is tblock + global_ttl, inclusive; one second more is rejected", () => {
    expect(ttlVerdict(NOW, at(NOW, ROOT_WINDOW_DEFAULT_S))).toBeNull();
    expect(ttlVerdict(NOW, at(NOW, ROOT_WINDOW_DEFAULT_S + 1))).toMatch(TOO_FAR);
  });

  test("the safety margin absorbs a block clock up to 1 h behind the wall clock", () => {
    // The tool computes ttl = wall-clock now + default; the ledger measures
    // from the block time, which may lag.
    const ttl = at(NOW, DEFAULT_TTL_S);
    expect(ttlVerdict(at(NOW, -TTL_SAFETY_MARGIN_S), ttl)).toBeNull();
    expect(ttlVerdict(at(NOW, -(TTL_SAFETY_MARGIN_S + 1)), ttl)).toMatch(TOO_FAR);
    // Without the margin, a TTL of now + global_ttl fails as soon as the block
    // clock is one second behind.
    expect(ttlVerdict(at(NOW, -1), at(NOW, ROOT_WINDOW_DEFAULT_S))).toMatch(TOO_FAR);
  });

  test("the check is live in this form: an expired TTL is rejected too", () => {
    expect(ttlVerdict(NOW, at(NOW, -1))).toMatch(/Intent TTL has expired/);
  });
});
