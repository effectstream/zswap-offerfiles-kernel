/**
 * @zswap-da/mip5-offer-files — MIP-0005 Offer Files codec.
 *
 * Canonical home for the `swapoffer` bech32m encoding of a proven Midnight
 * `Transaction`. See WIP MIP5 at the repo root.
 */
export {
  OFFER_HRP,
  encodeOffer,
  decodeOffer,
  offerToBech32,
  offerFromBech32,
} from "./codec.ts";
