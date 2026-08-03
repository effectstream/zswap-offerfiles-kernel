// Moved to the shared @zswap-da/offer-guard package — the node and the
// batcher must compute the identical content address, so it is defined once.
// This re-export keeps existing node-internal import paths stable.
export { offerHashFromBlob } from "@zswap-da/offer-guard";
