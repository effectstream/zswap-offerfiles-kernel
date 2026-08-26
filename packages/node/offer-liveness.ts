import { World } from "@effectstream/coroutine";
import {
  isKnownRootLive,
  isNullifierSpent,
  isUnshieldedCreated,
} from "@zswap-da/database";
import {
  evaluateOfferLiveness,
  offerLivenessFailure,
  orderedOfferLivenessDescriptors,
  type OfferLivenessVerdict,
  type OfferValidation,
} from "@zswap-da/validator";

export interface AsyncDatabaseLivenessOptions {
  /** Resolve lazily: nullifier/UTXO rejection must not pay for a root-clock
   * query, and an offer with no shielded roots never needs one. */
  getRootCutoffMs: () => Promise<number>;
}

/** Async pg adapter shared by HTTP submission and the future validate-for-use
 * service. It owns the DB shape-to-live-boolean mapping; stable code/reason and
 * ordering remain in the pure validator boundary. */
export async function evaluateOfferLivenessFromDatabase(
  validation: Pick<
    OfferValidation,
    "nullifiers" | "unshieldedSpends" | "inputRoots"
  >,
  dbConn: any,
  options: AsyncDatabaseLivenessOptions,
): Promise<OfferLivenessVerdict> {
  let rootCutoff: Promise<number> | undefined;
  const getRootCutoff = () => {
    rootCutoff ??= options.getRootCutoffMs();
    return rootCutoff;
  };

  return evaluateOfferLiveness(validation, async (descriptor) => {
    switch (descriptor.kind) {
      case "nullifier":
        return (await isNullifierSpent.run(
          { nullifier: descriptor.nullifier },
          dbConn,
        )).length === 0;
      case "unshielded":
        return (await isUnshieldedCreated.run(
          {
            owner: descriptor.ref.owner,
            intent_hash: descriptor.ref.intentHash,
            output_no: descriptor.ref.outputNo,
          },
          dbConn,
        )).length > 0;
      case "root":
        return (await isKnownRootLive.run(
          { root: descriptor.root, cutoff_ms: await getRootCutoff() },
          dbConn,
        )).length > 0;
    }
  });
}

/** Generator-form adapter for deterministic STM ingestion. It consumes the
 * same ordered descriptors and normalization as the async adapter while
 * retaining World.resolve and the caller-supplied L2 block clock. */
export function* evaluateOfferLivenessInStateMachine(
  validation: Pick<
    OfferValidation,
    "nullifiers" | "unshieldedSpends" | "inputRoots"
  >,
  rootCutoffMs: number,
): Generator<any, OfferLivenessVerdict, any> {
  for (const descriptor of orderedOfferLivenessDescriptors(validation)) {
    let live: boolean;
    switch (descriptor.kind) {
      case "nullifier":
        live = (yield* World.resolve(isNullifierSpent, {
          nullifier: descriptor.nullifier,
        })).length === 0;
        break;
      case "unshielded":
        live = (yield* World.resolve(isUnshieldedCreated, {
          owner: descriptor.ref.owner,
          intent_hash: descriptor.ref.intentHash,
          output_no: descriptor.ref.outputNo,
        })).length > 0;
        break;
      case "root":
        live = (yield* World.resolve(isKnownRootLive, {
          root: descriptor.root,
          cutoff_ms: rootCutoffMs,
        })).length > 0;
        break;
    }
    if (!live) return offerLivenessFailure(descriptor);
  }
  return { ok: true };
}
