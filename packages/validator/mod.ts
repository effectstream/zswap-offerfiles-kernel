// @zswap-da/validator — shared, pure ZSwap offer validation.
//
// One deterministic routine used by the state-machine ingestion path and the
// batcher / submit fee-gate. No I/O of its own: callers supply `refState`,
// `tblock`, and (optionally) liveness checks. See validate.ts for the pipeline.
//
// Encoding: MIP-0005 (@effectstream/mip-zswap-offer/mip5). Two-sided / derive:
// MIP-0006 (@effectstream/mip-zswap-offer/mip6).
export { validateZswapOffer, verifyOfferCrypto } from "./validate.ts";
export { getBlankRefState, buildStrictness } from "./refstate.ts";
export {
  bytesOrStringToHex,
  collectNullifiers,
  collectUnshieldedSpends,
  deriveLegs,
  UnknownTokenTagError,
} from "./derive.ts";
export {
  canonicalRootHex,
  extractInputRoot,
  extractOfferInputRoots,
  RootExtractError,
} from "./extract-root.ts";
export type {
  OfferRejectCode,
  OfferValidation,
  OfferLeg,
  UnshieldedSpendRef,
  ValidateOpts,
} from "./types.ts";

// Re-export MIP-0005 codec so API consumers can encode/decode without a
// separate dependency (see API.md).
export { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
