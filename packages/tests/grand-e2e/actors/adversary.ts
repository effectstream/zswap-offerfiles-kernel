// Adversarial fixture factory + direct-Celestia garbage publisher.
//
// Fixtures are pre-verified against the validator wherever the rejection is
// structural (no DB needed), so a fixture that starts rejecting for the WRONG
// reason fails loudly here instead of silently passing a weaker assertion.

import { readFileSync } from "node:fs";
import { bech32m } from "@scure/base";
import { OfferFiles, OFFER_HRP } from "@effectstream/mip-zswap-offer/mip5";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { offerHashFromBytes } from "@zswap-da/offer-guard";

import { ledger } from "../ledger.ts";
import { detVar } from "../lib/util.ts";
import { submitBlobRaw } from "../lib/celestia.ts";

const OFFER_MAX_BYTES = 1024 * 1024;

// Structural rejections that must NOT be produced by the crypto-tamper
// fixture (proving crypto runs after every one of these).
export const STRUCTURAL_CODES = new Set([
  "BAD_ENCODING",
  "TOO_LARGE",
  "BAD_DESERIALIZE",
  "WRONG_TX_VARIANT",
  "NO_SPENDABLE_INPUT",
  "NOT_A_SWAP",
  "NULLIFIER_SPENT",
  "UTXO_SPENT",
  "UTXO_UNKNOWN",
  "UTXO_NOT_LIVE",
  "ROOT_UNKNOWN",
  "DUPLICATE_OFFER",
]);

export interface ApiFixture {
  kind: string;
  blob: string;
  /** Codes the submit gate may answer with (any of these = correct). */
  expectedCodes: string[];
}

/** Validate that a structural fixture rejects locally for the right reason. */
function preVerify(fix: ApiFixture): ApiFixture {
  const v = validateZswapOffer(fix.blob, {
    refState: getBlankRefState(net.id),
    tblock: new Date(),
    maxBytes: OFFER_MAX_BYTES,
    crypto: "defer",
  });
  if (v.ok) {
    // Liveness-class fixtures pass structural validation by design.
    return fix;
  }
  if (!fix.expectedCodes.includes(v.code ?? "")) {
    throw new Error(
      `fixture ${fix.kind}: validator says ${v.code}, expected one of ${fix.expectedCodes.join("/")}`,
    );
  }
  return fix;
}

/** The Lace-made fixture offer — parses fine, but its coins/roots don't exist
 *  on a fresh dev chain, so the submit gate answers ROOT_UNKNOWN. */
export function foreignRootBlob(): string {
  const p = new URL("../../../validator/fixtures/valid-offer.bech32", import.meta.url).pathname;
  return readFileSync(p, "utf-8").trim();
}

/** A valid bech32m string in the right HRP whose payload is random bytes —
 *  passes checksum, fails Transaction.deserialize. */
export function bech32GarbageBlob(seedIndex: number): string {
  const bytes = new Uint8Array(600);
  for (let i = 0; i < bytes.length; i++) bytes[i] = detVar(seedIndex * 600 + i, 256, 13);
  return bech32m.encode(OFFER_HRP, bech32m.toWords(bytes), false as any);
}

/** Flip bytes near the end of a real offer's raw tx (proof data) and
 *  re-encode. Structure still parses; only the crypto step can catch it. */
export function cryptoTamperBlob(validBlob: string): string {
  const raw = OfferFiles.decode(validBlob);
  const copy = Uint8Array.from(raw);
  // Flip a run of bytes in the last 5% of the serialization — deep inside
  // proof/signature material, far from the structural headers.
  const start = Math.floor(copy.length * 0.97);
  for (let i = start; i < Math.min(copy.length, start + 8); i++) copy[i] = copy[i]! ^ 0xff;
  return OfferFiles.encode(copy);
}

export function apiFixtures(validLiveBlob: string, consumedBlob: string | null): ApiFixture[] {
  const out: ApiFixture[] = [];
  out.push(
    preVerify({ kind: "BAD_ENCODING-not-bech32", blob: "definitely not an offer", expectedCodes: ["BAD_ENCODING"] }),
    preVerify({
      kind: "BAD_ENCODING-corrupt-checksum",
      blob: validLiveBlob.slice(0, validLiveBlob.length - 12) + "qqqqqqqqqqqq",
      expectedCodes: ["BAD_ENCODING"],
    }),
    preVerify({
      kind: "BAD_ENCODING-wrong-hrp",
      blob: "notanoffer1" + validLiveBlob.slice(validLiveBlob.indexOf("1") + 1),
      expectedCodes: ["BAD_ENCODING"],
    }),
    preVerify({ kind: "BAD_DESERIALIZE-random-payload", blob: bech32GarbageBlob(1), expectedCodes: ["BAD_DESERIALIZE"] }),
    preVerify({
      kind: "TOO_LARGE",
      blob: bech32m.encode(OFFER_HRP, bech32m.toWords(new Uint8Array(OFFER_MAX_BYTES + 64)), false as any),
      expectedCodes: ["TOO_LARGE"],
    }),
  );
  // Liveness fixtures — verified by the API's DB-backed gate, not locally.
  out.push({ kind: "ROOT_UNKNOWN-foreign-fixture", blob: foreignRootBlob(), expectedCodes: ["ROOT_UNKNOWN"] });
  out.push({ kind: "DUPLICATE_OFFER-live-replay", blob: validLiveBlob, expectedCodes: ["DUPLICATE_OFFER"] });
  if (consumedBlob) {
    out.push({
      kind: "NULLIFIER_SPENT-or-DUP-consumed-replay",
      blob: consumedBlob,
      // Dedup (409) fires before liveness on the API path — both prove the
      // offer can never re-index.
      expectedCodes: ["DUPLICATE_OFFER", "NULLIFIER_SPENT", "UTXO_NOT_LIVE"],
    });
  }
  return out;
}

// ── Direct-Celestia garbage ─────────────────────────────────────────────────

export type CelestiaGarbageKind =
  | "random-bytes"
  | "truncated-tx"
  | "bech32-string-as-utf8"
  | "replayed-real-blob";

/** Garbage families safe to publish against the CURRENT node. `replayed-real-blob`
 *  carries a real transaction's 0x00 bytes and so trips the NUL crash below;
 *  it returns only once that is fixed (or with the repro flag set). */
export function celestiaGarbageKinds(): CelestiaGarbageKind[] {
  // All four are safe again: `replayed-real-blob` carries a real transaction's
  // 0x00 bytes, which used to crash the node on the rejection path. With the
  // scrub fixed (it no longer matches the body as text) a NUL-bearing body is
  // just another rejection, so the dedup path is exercised again.
  return ["random-bytes", "truncated-tx", "bech32-string-as-utf8", "replayed-real-blob"];
}

/**
 * CRITICAL BUG FOUND BY THIS SUITE (2026-08-03) — reported, NOT patched.
 *
 * A namespace blob containing a single 0x00 byte crashes the node. Nothing
 * ever WRITES a NUL into a text column — the write side is fine, because JSON
 * escaping turns it into the six characters backslash-u-0-0-0-0. The NUL
 * bites where the body is used as a LOOKUP KEY:
 *
 *   1. the framework hands the STM the blob body as a latin1 JS string
 *      (suppliedValue = atob(blob.data), char codes = raw bytes) and persists
 *      it in effectstream.primitive_accounting.payload — a legal write;
 *   2. the STM's scrub (deleteRejectedAccountingRow) then asks Postgres to
 *      extract that stored body back to TEXT with `->>` and compare it to the
 *      raw latin1 string as a parameter. BOTH halves are illegal: the `->>`
 *      extraction raises "unsupported Unicode escape sequence" (no text value
 *      can hold NUL) and the parameter raises "invalid byte sequence for
 *      encoding UTF8: 0x00";
 *   3. the runtime swallows STF errors to telemetry (HANDOFF gotcha #2), so
 *      nothing is logged — and the NEXT statement in the same block
 *      transaction dies with 25P02 "current transaction is aborted", which
 *      exits the sync process (code 1) and tears the stack down.
 *
 * Blast radius exceeds the poison blob: the failing half is the extraction of
 * the STORED row, so the scrub dies for every blob sharing that Celestia
 * height, legitimate offers included.
 *
 * The namespace is permissionless by design, so this is an unauthenticated
 * remote crash of every ZSwap-DA indexer for the price of one blob fee — and
 * binary junk contains 0x00 by default, so it is the *expected* outcome of
 * ordinary spam, not a sophisticated attack. It fires on the very path built
 * to survive hostile input.
 *
 * Fixable without a migration: never extract the body to text. Matching the
 * whole document (`payload::text = :param`) or the existing generated column
 * (`payload_hash = md5(:param)`) both delete the row correctly — the JSON text
 * carries the escape as literal characters, so the parameter is clean ASCII.
 * The payload_hash form is additionally an index probe on
 * (primitive_name, effectstream_block_height, payload_hash) instead of today's
 * body comparison. Reported, not patched, per the handoff's find-bugs rule.
 *
 * Verified standalone: nul-crash-repro.ts (PGlite, no stack required).
 *
 * Consequence for this suite: garbage fixtures are NUL-free by default so the
 * remaining ~200 checks can run. Set GRAND_NUL_CRASH_REPRO=1 to publish one
 * NUL-bearing blob and watch the node die — expect the run to end there.
 */
export const NUL_CRASH_REPRO = process.env["GRAND_NUL_CRASH_REPRO"] === "1";

/** Byte in 1..255 — never 0x00 (see NUL_CRASH_REPRO above). */
const nonNulByte = (i: number, salt: number): number => 1 + detVar(i, 255, salt);

export async function publishCelestiaGarbage(
  kind: CelestiaGarbageKind,
  seedIndex: number,
  realBlobBech32: string,
): Promise<{ height: number; hash?: string }> {
  let bytes: Uint8Array;
  let hash: string | undefined;
  switch (kind) {
    case "random-bytes": {
      bytes = new Uint8Array(400 + detVar(seedIndex, 400, 3));
      for (let i = 0; i < bytes.length; i++) bytes[i] = nonNulByte(seedIndex * 1000 + i, 5);
      if (NUL_CRASH_REPRO) bytes[0] = 0x00; // deliberate node-crash reproduction
      break;
    }
    case "truncated-tx": {
      // A real tx prefix is full of 0x00, which would crash the node before
      // testing anything else — substitute those bytes. Still not a
      // deserializable transaction, which is what this fixture asserts.
      const raw = OfferFiles.decode(realBlobBech32);
      bytes = raw.slice(0, Math.floor(raw.length / 2));
      if (!NUL_CRASH_REPRO) {
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) bytes[i] = 0xff;
      }
      break;
    }
    case "bech32-string-as-utf8": {
      // The legacy wire format (bech32m string as UTF-8) — no longer valid tx
      // bytes on the raw-bytes namespace.
      bytes = new TextEncoder().encode(realBlobBech32);
      break;
    }
    case "replayed-real-blob": {
      // A byte-identical replay — it must stay verbatim to test dedup at all,
      // and a real transaction is full of 0x00. Its DUPLICATE rejection runs
      // the same scrub, so this fixture crashes the node until the NUL bug is
      // fixed; celestiaGarbageKinds() drops it by default. Celestia-side
      // dedup is still covered by p4's byte-identical API replay (409).
      bytes = OfferFiles.decode(realBlobBech32);
      hash = offerHashFromBytes(bytes);
      break;
    }
  }
  const height = await submitBlobRaw(bytes);
  ledger.addGarbage({
    kind: `celestia:${kind}`,
    via: "celestia",
    expectedCodes: [], // celestia-path garbage is asserted via offer_rejections rows
    offerHash: hash,
    celestiaHeight: height,
    at: Date.now(),
  });
  return { height, hash };
}
