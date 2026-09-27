// Per-network protocol windows, pure and testable — env.ts wires these into
// the exported constants.
//
// The root-recency window governs `past_roots` in the zswap crate: the chain
// accepts shielded proofs only against Merkle roots inside this window, and
// our known_roots retention must mirror it exactly. Too wide and the book
// lists offers whose roots the chain already dropped (phantom, unfillable
// offers — the same failure class the nullifier-retention fix closed); too
// narrow and legitimate offers get rejected as ROOT_UNKNOWN.
//
// On ledger 8 (node 1.x: preview, preprod, mainnet — this line) the zswap
// crate HARDCODES a 3600 s window (midnight-ledger `ledger-8.1.0`
// zswap/src/ledger.rs:253, `past_roots.filter(tblock - 3600 s)`), counted from
// the last block in which the root was still current. A shielded (zswap)
// offer carries NO TTL of its own: this window is its only expiry.
//
// It is NOT the `global_ttl` ledger parameter. `global_ttl` bounds intent TTLs
// (`tblock <= ttl <= tblock + global_ttl`) and is 1,209,600 s (14 days) on
// every network (node `res/<net>/ledger-parameters-config.json`; live preview,
// preprod and mainnet parameters, 2026-09-27). The offer validator reads it
// from the network's pinned ledger parameters
// (packages/validator/reference-parameters.ts). Ledger 9 (node 2.x) prunes
// past_roots by `global_ttl` instead — do not copy that onto this line.
//
// Values are per-network and WILL change with ledger releases — treat a
// mismatch as a deploy-config error, not a tunable.

/** ~1 hour: the root-recency window on all currently deployed networks. */
export const ROOT_WINDOW_CURRENT_NETWORKS_S = 3600;

/**
 * STAGENET: runs ledger 9, whose root window is `global_ttl` (14 days). This
 * ledger-8 line cannot validate stagenet offers (it has no ledger-9 reference
 * parameters, so MIDNIGHT_NETWORK_ID=stagenet fails at startup); the value is
 * kept only so the table stays complete. The kernel's `ledger-v9` line serves
 * stagenet.
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
 * OFFER_TTL_SECONDS since 00056: the FALLBACK lifetime of an offer that has
 * neither a shielded input root, nor an intent, nor a DUST spend — the only
 * case with no ledger expiry to derive. It is unreachable for a well-formed
 * two-sided offer (unshielded spends live inside intents, whose TTL is
 * mandatory; shielded inputs carry a root), so it shapes no real offer.
 *
 * It is NOT a cap any more. Offer expiry is the earliest REAL limit
 * (state-machine.ts deriveOfferExpiry):
 *   - shielded (zswap) inputs: no TTL exists; the offer dies when its proof
 *     root leaves `past_roots` — root last-seen + ROOT_WINDOW_SECONDS;
 *   - intents (unshielded legs, fee intents): the earliest intent `ttl`,
 *     which the ledger bounds by `tblock + global_ttl` (14 days);
 *   - DUST spends: `ctime + dust_grace_period`.
 * Default: the root window. Env (`OFFER_TTL_SECONDS`) wins.
 */
export function resolveOfferTtlSeconds(
  rootWindowSeconds: number,
  envValue: string | undefined,
): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return rootWindowSeconds;
}

/**
 * The startup warning for an explicitly set OFFER_TTL_SECONDS, or null when it
 * is unset/blank. Before 00056 the variable capped every offer's lifetime;
 * now it is only the no-root/no-intent fallback, so an operator who set it to
 * shorten offers must hear that it no longer does (no silent change).
 */
export function offerTtlSecondsNotice(envValue: string | undefined): string | null {
  if (envValue === undefined || envValue.trim() === "") return null;
  return (
    `OFFER_TTL_SECONDS=${envValue.trim()} no longer caps offer lifetimes (00056): ` +
    "expiry is derived from the ledger — root last-seen + ROOT_WINDOW_SECONDS for " +
    "shielded inputs, the earliest intent TTL for intents, ctime + DUST grace for " +
    "DUST spends. The value applies only to an offer with none of these."
  );
}
