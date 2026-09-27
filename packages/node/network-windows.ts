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
// deployments. The same `global_ttl` also bounds intent TTLs
// (`tblock <= ttl <= tblock + global_ttl`); the validator reads that bound
// from the network's pinned ledger parameters
// (packages/validator/reference-parameters.ts), whose `global_ttl` equals this
// constant (reference-parameters.test.ts checks it).
//
// Shielded (zswap) offers carry NO TTL of their own: this window — counted
// from the last block in which the offer's root was still current — is their
// only expiry.
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
 *     which the ledger bounds by `tblock + global_ttl`;
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
