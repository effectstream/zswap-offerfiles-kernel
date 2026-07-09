/**
 * @zswap-da/mip6-p2p-swaps — MIP-0006 Peer-to-Peer Atomic Swaps core library.
 *
 * Canonical home for payload types, gives/wants derivation, and the two-sided
 * swap rule. See WIP MIP6 at the repo root.
 */
export type {
  TokenKind,
  TokenLeg,
  OnchainOfferPayload,
  OffchainOfferPayload,
  OfferStatus,
} from "./types.ts";

export {
  deriveTokenLegs,
  UnknownTokenTagError,
} from "./derive.ts";

export {
  isTwoSidedSwap,
  assertTwoSided,
  NotASwapError,
} from "./two-sided.ts";

export {
  buildOnchainOfferPayload,
  toOffchainOfferPayload,
  earliestIntentTtl,
  type OffchainOfferInput,
} from "./payload.ts";
