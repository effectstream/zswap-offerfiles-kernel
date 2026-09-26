// Protocol windows, pure and testable — env.ts wires these into the exported
// constants.
//
// The root-recency window governs zswap `past_roots`: the chain accepts
// shielded proofs only against Merkle roots inside this window, and our
// known_roots retention must mirror it exactly. Too wide and the book lists
// offers whose roots the chain already dropped (phantom, unfillable offers —
// the same failure class the nullifier-retention fix closed); too narrow and
// legitimate offers get rejected as ROOT_UNKNOWN.
//
// On ledger 9 — the only ledger this line runs against (node 2.x) — the window
// IS the `global_ttl` ledger parameter. The post-block update prunes zswap
// `past_roots` by `self.parameters.global_ttl`:
//   - midnight-ledger `ledger-9.1.0.0-rc.3`, ledger/src/semantics.rs:1717-1721
//     (`zswap.post_block_update(tblock, self.parameters.global_ttl)`);
//   - midnight-ledger `zswap-9.0.0-rc.3`, zswap/src/ledger.rs:241-251
//     (`past_roots.filter(tblock - retention_duration)`).
// `global_ttl` is 1209600 s (14 days) in every network config of
// midnight-node (`res/<network>/ledger-parameters-config.json` for dev,
// devnet, preview, preprod, mainnet, qanet and stagenet, at d9729c13 and
// node-2.0.0-rc.4), and live on stagenet (block 634,797, 2026-09-26).
//
// The value is static on purpose: changing `global_ttl` is a hard fork, so the
// kernel uses one constant for every network instead of reading the parameter
// at startup. ROOT_WINDOW_SECONDS still overrides it for tests and special
// deployments.
//
// Ledger 8 (node 1.x, the kernel's `main` line) is different: its zswap crate
// hardcodes a 3600 s window (zswap/src/ledger.rs:253 at ledger-8.1.x) and
// ignores `global_ttl`. Do not copy this value onto a ledger-8 kernel.

/** The ledger-9 `global_ttl`: 14 days, the root window on every network. */
export const ROOT_WINDOW_DEFAULT_S = 1_209_600;

/**
 * @deprecated Every network uses ROOT_WINDOW_DEFAULT_S. This alias (same
 * value) keeps existing importers compiling (the stagenet profile and its
 * tests). Stagenet's own sources agree (00050 FR-006): midnight-node d9729c13
 * `res/stagenet/ledger-parameters-config.json:179` `"global_ttl": 1209600`,
 * and the live ledger parameters read from the stagenet indexer on 2026-09-26
 * (block 632,090: `global_ttl` = 1209600 s).
 */
export const ROOT_WINDOW_STAGENET_S = ROOT_WINDOW_DEFAULT_S;

/**
 * Default root window for a network id: the same static value for every id,
 * known or not. The argument stays so callers do not change. Env
 * (`ROOT_WINDOW_SECONDS`) always wins over this — see resolveRootWindowSeconds.
 */
export function rootWindowDefaultSeconds(_networkId: string): number {
  return ROOT_WINDOW_DEFAULT_S;
}

/** Env override (validated positive integer) → else the static default. */
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
