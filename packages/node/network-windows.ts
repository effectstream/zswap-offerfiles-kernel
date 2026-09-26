// Per-network protocol windows, pure and testable — env.ts wires these into
// the exported constants.
//
// The root-recency window governs `past_roots` in the zswap crate: the chain
// accepts shielded proofs only against Merkle roots inside this window, and
// our known_roots retention must mirror it exactly.
//
// Through ledger 8 (node 1.x) the window was hardcoded in the zswap crate, so
// it was NOT the on-chain `global_ttl` LedgerParameter despite both being 1 h.
// From ledger 9 (node 2.x) it IS `global_ttl`: the ledger's post-block update
// prunes zswap `past_roots` by `self.parameters.global_ttl`
// (midnight-ledger `ledger-9.1.0.0-rc.3`, ledger/src/semantics.rs:1717-1721,
// zswap/src/ledger.rs:241-252 — the crates node 2.0.0-d9729c13 pins). That
// parameter is governance-changeable (OverwriteParameters), so a per-network
// value here must be re-checked when a network changes it. Too wide and the book lists
// offers whose roots the chain already dropped (phantom, unfillable offers —
// the same failure class the nullifier-retention fix closed); too narrow and
// legitimate offers get rejected as ROOT_UNKNOWN.
//
// Values are per-network and WILL change with ledger releases — treat a
// mismatch as a deploy-config error, not a tunable.

/** ~1 hour: the root-recency window on all currently deployed networks. */
export const ROOT_WINDOW_CURRENT_NETWORKS_S = 3600;

/**
 * Stagenet (node 2.0.0-d9729c13, ledger 9): 14 days, its `global_ttl`.
 * Sources (00050 FR-006): midnight-node d9729c13
 * `res/stagenet/ledger-parameters-config.json:179` `"global_ttl": 1209600`, and
 * the live ledger parameters read from the stagenet indexer on 2026-09-26
 * (block 632,090: `global_ttl` = 1209600 s).
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
