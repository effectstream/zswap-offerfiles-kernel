import { createHash } from "node:crypto";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  getOffersMissingHash,
  setOpenOfferHash,
  setHistoryOfferHash,
} from "@zswap-da/database";

/**
 * Content-addressed offer identity (the MIP-0006 `offerId`): hex sha256 over
 * the offer's canonical bytes — the raw MIP-0005 `Transaction` serialization,
 * NOT the bech32m string. Hashing the raw bytes keeps the id stable across
 * display encodings; hashing the bech32m string would tie identity to a
 * re-encodable rendering.
 *
 * Throws when the blob is not a decodable `swapoffer1…` string.
 */
export function offerHashFromBlob(blob: string): string {
  return createHash("sha256").update(OfferFiles.decode(blob)).digest("hex");
}

/**
 * One-shot startup backfill for rows indexed before 005-offer-hash.sql.
 * Legacy blobs that no longer decode under the current codec (e.g. the old
 * `zswapoffer` HRP) are left NULL — they can't be content-addressed, only
 * listed and looked up by blob.
 */
export async function backfillOfferHashes(dbConn: any): Promise<void> {
  const rows = await getOffersMissingHash.run(undefined, dbConn);
  if (rows.length === 0) return;
  let done = 0;
  let skipped = 0;
  for (const row of rows) {
    let hash: string;
    try {
      hash = offerHashFromBlob(row.transaction_hex);
    } catch {
      skipped++;
      continue;
    }
    const setter = row.live ? setOpenOfferHash : setHistoryOfferHash;
    await setter.run({ id: row.id, offer_hash: hash }, dbConn);
    done++;
  }
  console.log(
    `[OFFER_HASH] Backfilled ${done}/${rows.length} offer hashes` +
      (skipped ? ` (${skipped} legacy blobs not decodable — left NULL)` : ""),
  );
}
