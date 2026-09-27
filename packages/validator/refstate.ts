import { Buffer } from "node:buffer";
import { LedgerParameters, LedgerState, WellFormedStrictness } from "@midnightntwrk/ledger-v9";

import { REFERENCE_PARAMETERS } from "./reference-parameters.ts";

// Reference state for `Transaction.wellFormed` (00056 FR-001).
//
// The security-critical `stateless_check` (ZK proof + signature verification)
// is STATE-INDEPENDENT — it uses bundled verifier keys and never reads state
// content. With `enforceBalancing=false` and `enforceLimits=false` (below),
// the parts of the reference state `wellFormed` does consult are the network
// id and the network's LEDGER PARAMETERS — above all `global_ttl`, which
// bounds every intent TTL: `tblock <= ttl <= tblock + global_ttl`
// (midnight-ledger `ledger-9.1.0.0-rc.3` ledger/src/verify.rs:632-635,
// :1721-1742).
//
// So the reference state is a blank state for the network with the network's
// real parameters swapped in. A BLANK state is wrong here: it carries the
// ledger's INITIAL_PARAMETERS, whose `global_ttl` is 3600 s, so an intent TTL
// more than one hour ahead would be refused although the chain accepts up to
// 14 days. The parameters are pinned per network (reference-parameters.ts),
// never read live, so every kernel and every replay reaches the same verdict.
//
// Not covered by parameters alone: a DUST spend's proof is checked against the
// DUST commitment/generation roots at its `ctime`, which only a synced state
// holds, so an offer carrying a DUST spend still fails here (as it did against
// a blank state). Open offers do not pay fees; the taker's settlement does.

/** No pinned ledger parameters exist for this network id. Thrown at startup
 *  (see requireReferenceParameters) so the kernel never validates against
 *  blank defaults. */
export class UnknownNetworkParametersError extends Error {
  constructor(readonly networkId: string) {
    super(
      `no reference ledger parameters for MIDNIGHT_NETWORK_ID='${networkId}' ` +
        `(supported: ${Object.keys(REFERENCE_PARAMETERS).sort().join(", ")}). ` +
        "The offer validator needs the network's real ledger parameters " +
        "(global_ttl bounds intent TTLs); add a pinned snapshot to " +
        "packages/validator/reference-parameters.ts.",
    );
    this.name = "UnknownNetworkParametersError";
  }
}

const parametersCache = new Map<string, LedgerParameters>();
const stateCache = new Map<string, LedgerState>();

/**
 * The pinned ledger parameters for `networkId`, deserialized once. Throws
 * UnknownNetworkParametersError for an id without a snapshot. Call it at
 * process startup (node env.ts, the batcher's adapter) so a wrong id fails
 * before the first offer.
 */
export function requireReferenceParameters(networkId: string): LedgerParameters {
  let parameters = parametersCache.get(networkId);
  if (!parameters) {
    const snapshot = Object.hasOwn(REFERENCE_PARAMETERS, networkId)
      ? REFERENCE_PARAMETERS[networkId]
      : undefined;
    if (!snapshot) throw new UnknownNetworkParametersError(networkId);
    parameters = LedgerParameters.deserialize(Buffer.from(snapshot.hex, "hex"));
    parametersCache.set(networkId, parameters);
  }
  return parameters;
}

/** The DUST grace period of the network's pinned parameters, in seconds. */
export function referenceDustGracePeriodSeconds(networkId: string): number {
  return Number(requireReferenceParameters(networkId).dust.dustGracePeriodSeconds);
}

/**
 * The reference ledger state for `networkId`: a blank state carrying the
 * network's pinned ledger parameters. Cached per id; deterministic. Throws
 * UnknownNetworkParametersError for an id without a snapshot.
 */
export function getReferenceState(networkId: string): LedgerState {
  let state = stateCache.get(networkId);
  if (!state) {
    state = LedgerState.blank(networkId);
    state.parameters = requireReferenceParameters(networkId);
    stateCache.set(networkId, state);
  }
  return state;
}

/**
 * @deprecated Use getReferenceState. Kept for out-of-tree importers; since
 * 00056 it returns the same reference state (the network's pinned
 * parameters), not a blank one — a blank state would refuse valid intent TTLs.
 */
export function getBlankRefState(networkId: string): LedgerState {
  return getReferenceState(networkId);
}

// Strictness for an OPEN (intentionally unbalanced) ZSwap offer. Every flag is
// set explicitly — do NOT rely on constructor defaults.
//
//   enforceBalancing = false  ← CRITICAL: open offers are unbalanced by design;
//                               true rejects every legitimate offer.
//   verifyNativeProofs = true ← verify the zswap input/output/transient ZK
//                               proofs (this is what rejects forged coins).
//   verifyContractProofs = true
//   verifySignatures = true
//   enforceLimits = false     ← the ledger byte-limit check reads a state
//                               parameter; we cap size ourselves via maxBytes,
//                               so leave it off to avoid that dependency.
export function buildStrictness(opts?: { verifyContractProofs?: boolean }): WellFormedStrictness {
  const s = new WellFormedStrictness();
  s.enforceBalancing = false;
  s.verifyNativeProofs = true;
  // false ONLY on the contract-maker retry lane — see ValidateOpts.contractMakerRetry.
  s.verifyContractProofs = opts?.verifyContractProofs ?? true;
  s.verifySignatures = true;
  s.enforceLimits = false;
  return s;
}
