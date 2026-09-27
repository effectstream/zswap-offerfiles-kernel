// @zswap-da/validator — shared, pure ZSwap offer validation.
//
// One deterministic routine used by the state-machine ingestion path and the
// batcher / submit fee-gate. No I/O of its own: callers supply `refState`
// (getReferenceState(networkId): the network's pinned ledger parameters),
// `tblock`, and (optionally) liveness checks. See validate.ts for the pipeline.
//
// Encoding: MIP-0005 (@effectstream/mip-zswap-offer/mip5). Two-sided / derive:
// MIP-0006 (@effectstream/mip-zswap-offer/mip6).
export {
  validateZswapOffer,
  validateZswapOfferBytes,
  verifyOfferCrypto,
  wellFormedFailureCode,
} from "./validate.ts";
export {
  buildStrictness,
  getBlankRefState,
  getReferenceState,
  referenceDustGracePeriodSeconds,
  requireReferenceParameters,
  UnknownNetworkParametersError,
} from "./refstate.ts";
export { REFERENCE_PARAMETERS, type ReferenceParametersSnapshot } from "./reference-parameters.ts";
export {
  bytesOrStringToHex,
  collectNullifiers,
  collectUnshieldedSpends,
  collectOutputCommitments,
  collectUnshieldedOutputs,
  deriveLegs,
  UnknownTokenTagError,
} from "./derive.ts";
export {
  canonicalRootHex,
  extractInputRoot,
  extractOfferInputRoots,
  RootExtractError,
} from "./extract-root.ts";
export {
  evaluateOfferLiveness,
  offerLivenessFailure,
  orderedOfferLivenessDescriptors,
} from "./liveness.ts";
export type {
  OfferRejectCode,
  OfferValidation,
  OfferLeg,
  UnshieldedOutputRef,
  UnshieldedSpendRef,
  ValidateOpts,
} from "./types.ts";
export type {
  OfferLivenessDescriptor,
  OfferLivenessFailure,
  OfferLivenessProbe,
  OfferLivenessVerdict,
  UnshieldedFailureMode,
} from "./liveness.ts";

// Re-export MIP-0005 codec so API consumers can encode/decode without a
// separate dependency (see API.md).
export { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// Test-only fixture builder for unshielded offer SHAPES (#5 phase (a)).
// Exported so the grand-e2e suite can submit the same blobs the validator's
// own unit tests assert on — one definition, two consumers. Not used by any
// production path; see the SCOPE note in shapes.testkit.ts for what these
// blobs can and cannot prove.
export {
  allShapes,
  structuralShapes,
  hostileShapes,
  decodeShape,
  GIVE_TOKEN,
  WANT_TOKEN,
  MAKER_KEY,
  TAKER_KEY,
  type Shape,
} from "./shapes.testkit.ts";
