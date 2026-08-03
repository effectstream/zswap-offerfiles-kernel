// Per-network protocol windows, pure and testable — env.ts wires these into
// the exported constants.
//
// The root-recency window is a LEDGER parameter: the chain accepts shielded
// proofs only against Merkle roots it has seen inside this window, and our
// known_roots retention must mirror it exactly. Too wide and the book lists
// offers whose roots the chain already dropped (phantom, unfillable offers —
// the same failure class the nullifier-retention fix closed); too narrow and
// legitimate offers get rejected as ROOT_UNKNOWN.
//
// Values are per-network and WILL change with ledger releases — treat a
// mismatch as a deploy-config error, not a tunable.

/** ~1 hour: the root-recency window on all currently deployed networks. */
export const ROOT_WINDOW_CURRENT_NETWORKS_S = 3600;

/**
 * STAGENET placeholder: a network running the next ledger release with a
 * 2-week root window. NOT PUBLICLY AVAILABLE YET — no config file exists for
 * it; this entry only reserves the name and the window value so deploys can
 * opt in via MIDNIGHT_NETWORK_ID=stagenet the day it opens.
 */
export const ROOT_WINDOW_STAGENET_S = 60 * 60 * 24 * 14;

/**
 * Default root window for a network id. Env (`ROOT_WINDOW_SECONDS`) always
 * wins over this — see resolveRootWindowSeconds.
 */
export function rootWindowDefaultSeconds(networkId: string): number {
  return networkId.toLowerCase() === "stagenet"
    ? ROOT_WINDOW_STAGENET_S
    : ROOT_WINDOW_CURRENT_NETWORKS_S;
}

/** Env override (validated positive integer) → else per-network default. */
export function resolveRootWindowSeconds(
  networkId: string,
  envValue: string | undefined,
): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return rootWindowDefaultSeconds(networkId);
}

/**
 * Offer TTL default: tracks the root window. A shielded offer is fillable
 * only while its proof root stays inside the window, so keeping indexed
 * offers alive longer only serves offers that can no longer settle.
 * Env (`OFFER_TTL_SECONDS`) wins for deployments that want a different bound
 * (e.g. unshielded-heavy books, where fillability is not root-bound).
 */
export function resolveOfferTtlSeconds(
  rootWindowSeconds: number,
  envValue: string | undefined,
): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return rootWindowSeconds;
}
