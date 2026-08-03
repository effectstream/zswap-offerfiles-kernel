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
      for (let i = 0; i < bytes.length; i++) bytes[i] = detVar(seedIndex * 1000 + i, 256, 5);
      break;
    }
    case "truncated-tx": {
      const raw = OfferFiles.decode(realBlobBech32);
      bytes = raw.slice(0, Math.floor(raw.length / 2));
      break;
    }
    case "bech32-string-as-utf8": {
      // The legacy wire format (bech32m string as UTF-8) — no longer valid tx
      // bytes on the raw-bytes namespace.
      bytes = new TextEncoder().encode(realBlobBech32);
      break;
    }
    case "replayed-real-blob": {
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
