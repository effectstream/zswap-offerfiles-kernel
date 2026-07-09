/**
 * MIP-0005 — bech32m encode/decode for offer files.
 *
 *   HRP:   swapoffer
 *   Limit: none (the standard 90-char bech32 cap is lifted by the MIP)
 */

import { bech32m } from "@scure/base";
import { Transaction } from "@midnight-ntwrk/ledger-v8";

export const OFFER_HRP = "swapoffer";

/**
 * Disable the standard 90-character bech32 length cap.
 * `@scure/base` accepts `false` here to skip the limit check entirely.
 */
const NO_LIMIT = false as unknown as number;

/**
 * Encodes raw transaction bytes into a bech32m string with the `swapoffer` HRP.
 */
export function encodeOffer(transactionBytes: Uint8Array): string {
  if (!(transactionBytes instanceof Uint8Array)) {
    throw new TypeError("encodeOffer: transactionBytes must be a Uint8Array");
  }
  const words = bech32m.toWords(transactionBytes);
  return bech32m.encode(OFFER_HRP, words, NO_LIMIT);
}

/**
 * Decodes a bech32m `swapoffer` string back to raw transaction bytes.
 *
 * @throws {Error} if the HRP is not `swapoffer`, the checksum is invalid,
 *                 or the string is malformed.
 */
export function decodeOffer(encoded: string): Uint8Array {
  if (typeof encoded !== "string") {
    throw new TypeError("decodeOffer: input must be a string");
  }
  const { prefix, words } = bech32m.decode(
    encoded as `${string}1${string}`,
    NO_LIMIT,
  );
  if (prefix !== OFFER_HRP) {
    throw new Error(
      `decodeOffer: expected HRP "${OFFER_HRP}", got "${prefix}"`,
    );
  }
  return Uint8Array.from(bech32m.fromWords(words));
}

/** MIP-0005 reference: serialize a proven Transaction to `swapoffer1…`. */
export function offerToBech32(
  tx: Transaction<"signature", "proof", "binding">,
): string {
  return encodeOffer(tx.serialize());
}

/** MIP-0005 reference: deserialize a `swapoffer1…` string to a Transaction. */
export function offerFromBech32(
  text: string,
): Transaction<"signature", "proof", "binding"> {
  const bytes = decodeOffer(text);
  return Transaction.deserialize("signature", "proof", "binding", bytes);
}
