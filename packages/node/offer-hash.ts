import { createHash } from "node:crypto";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

/**
 * Content-addressed offer identity (the MIP-0006 `offerId`): hex sha256 over
 * the offer's canonical bytes — the raw MIP-0005 `Transaction` serialization,
 * NOT the bech32m string. Hashing the raw bytes keeps the id stable across
 * display encodings; hashing the bech32m string would tie identity to a
 * re-encodable rendering.
 *
 * Set at ingestion for every indexed offer, so `offer_hash` is never NULL on
 * rows this node writes. Throws when the blob is not a decodable
 * `swapoffer1…` string — callers answer those without touching the DB (an
 * undecodable blob can never be indexed, and probing the DB for it would
 * open a junk-blob → table-scan DoS).
 */
export function offerHashFromBlob(blob: string): string {
  return createHash("sha256").update(OfferFiles.decode(blob)).digest("hex");
}
