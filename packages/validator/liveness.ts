import type {
  OfferRejectCode,
  OfferValidation,
  UnshieldedSpendRef,
} from "./types.ts";

/**
 * Ordered, context-neutral description of every chain-state fact an offer
 * needs to remain usable. The order is deliberate and shared by the API, STM,
 * async guard, and future validate-for-use service: permanent nullifier spends
 * first, unshielded live-set membership second, recent roots last.
 */
export type OfferLivenessDescriptor =
  | { kind: "nullifier"; nullifier: string }
  | { kind: "unshielded"; ref: UnshieldedSpendRef }
  | { kind: "root"; root: string };

export type UnshieldedFailureMode = "not-live" | "spent" | "unknown";

export type OfferLivenessFailure = {
  ok: false;
  code: OfferRejectCode;
  reason: string;
  descriptor: OfferLivenessDescriptor;
};

export type OfferLivenessVerdict = { ok: true } | OfferLivenessFailure;

export function orderedOfferLivenessDescriptors(
  validation: Pick<
    OfferValidation,
    "nullifiers" | "unshieldedSpends" | "inputRoots"
  >,
): OfferLivenessDescriptor[] {
  return [
    ...(validation.nullifiers ?? []).map((nullifier) => ({
      kind: "nullifier" as const,
      nullifier,
    })),
    ...(validation.unshieldedSpends ?? []).map((ref) => ({
      kind: "unshielded" as const,
      ref,
    })),
    ...(validation.inputRoots ?? []).map((root) => ({
      kind: "root" as const,
      root,
    })),
  ];
}

/** Normalize a failed indexed probe into the stable code and reason used at
 * production boundaries. The split `spent`/`unknown` modes preserve the pure
 * validator's older optional predicates; indexed async contexts use the
 * fail-closed `not-live` mode because absence means spent OR never-created. */
export function offerLivenessFailure(
  descriptor: OfferLivenessDescriptor,
  unshieldedMode: UnshieldedFailureMode = "not-live",
): OfferLivenessFailure {
  switch (descriptor.kind) {
    case "nullifier":
      return {
        ok: false,
        code: "NULLIFIER_SPENT",
        reason: `nullifier already spent: ${descriptor.nullifier}`,
        descriptor,
      };
    case "root":
      return {
        ok: false,
        code: "ROOT_UNKNOWN",
        reason: `input merkle root not a known recent chain root: ${descriptor.root}`,
        descriptor,
      };
    case "unshielded": {
      const identity =
        `${descriptor.ref.owner}/${descriptor.ref.intentHash}/${descriptor.ref.outputNo}`;
      if (unshieldedMode === "spent") {
        return {
          ok: false,
          code: "UTXO_SPENT",
          reason: `unshielded UTXO already spent: ${identity}`,
          descriptor,
        };
      }
      if (unshieldedMode === "unknown") {
        return {
          ok: false,
          code: "UTXO_UNKNOWN",
          reason: `unshielded UTXO never created on chain: ${identity}`,
          descriptor,
        };
      }
      return {
        ok: false,
        code: "UTXO_NOT_LIVE",
        reason: `unshielded UTXO not live (spent or never created): ${identity}`,
        descriptor,
      };
    }
  }
}

export type OfferLivenessProbe = (
  descriptor: OfferLivenessDescriptor,
) => boolean | undefined | Promise<boolean | undefined>;

/**
 * Evaluate the ordered descriptors through an async-capable probe.
 *
 * `true` means the referenced chain fact is live, `false` returns the shared
 * failure, and `undefined` deliberately skips a probe a context cannot perform
 * (the batcher-side guard, for example, may have no root index). Probe throws
 * propagate so callers fail closed instead of treating unavailable state as
 * live.
 */
export async function evaluateOfferLiveness(
  validation: Pick<
    OfferValidation,
    "nullifiers" | "unshieldedSpends" | "inputRoots"
  >,
  probe: OfferLivenessProbe,
): Promise<OfferLivenessVerdict> {
  for (const descriptor of orderedOfferLivenessDescriptors(validation)) {
    const live = await probe(descriptor);
    if (live === false) return offerLivenessFailure(descriptor);
  }
  return { ok: true };
}
