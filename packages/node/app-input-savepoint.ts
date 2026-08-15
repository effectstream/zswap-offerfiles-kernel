import { World, type SyncStateUpdateStream } from "@effectstream/coroutine";
import {
  createAppInputSavepoint,
  releaseAppInputSavepoint,
  rollbackAppInputSavepoint,
} from "@zswap-da/database";

/** Marker recognized by the application-level runtime guard. The pinned
 * Effectstream executor otherwise swallows JavaScript STF errors and deletes
 * their authoritative scheduled input. */
export class AppInputTransitionError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`application input transition failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AppInputTransitionError";
    this.cause = cause;
  }
}

const failStopQuery = {
  queryIR: {
    statement: "SELECT 1 / 0 AS zswap_app_input_failure",
    usedParamSet: {},
    params: [],
  },
} as const;

/** Runtime-facing wrapper for Effectstream 0.103.1. The inner savepoint keeps
 * partial writes out; this catch converts the tagged JavaScript failure into a
 * database error at the outer generator boundary. Because the runtime executes
 * yielded DB promises outside the generator, PostgreSQL becomes aborted and
 * the runtime's outer block handler performs a full rollback without deleting
 * the input. Remove after upgrading to a runtime that retries/retains failed
 * scheduled inputs itself. */
export function* failStopAppInput(
  transition: () => SyncStateUpdateStream<void>,
): SyncStateUpdateStream<void> {
  try {
    yield* withAppInputSavepoint(transition);
  } catch (error) {
    if (!(error instanceof AppInputTransitionError)) throw error;
    yield* World.resolve(failStopQuery as any, undefined);
    // Defensive fallback if a future executor resumes a rejected DB promise.
    throw error;
  }
}

/**
 * Isolate one scheduled application input from the rest of its L2 block.
 *
 * Effectstream 0.103.1 catches non-transient JavaScript exceptions from an STF
 * and continues the block, but it does not invoke the SAVEPOINT helper it
 * defines. Without this wrapper, successful SQL writes before a later throw
 * are therefore eligible to COMMIT as partial state. Roll back those writes,
 * release the savepoint, then throw a tagged application error. The node
 * configuration wraps the pinned runtime executor and poisons the enclosing
 * transaction for this tag so its outer handler rolls the whole block back,
 * leaves the scheduled input in place, and halts progress rather than omitting
 * an authoritative nullifier/expiry transition.
 *
 * A database execution error is not thrown back into this synchronous
 * generator by the pinned executor. PostgreSQL marks the transaction aborted,
 * so the runtime's next statement fails and its outer block handler performs a
 * full ROLLBACK. That path is safe from partial commit but is not per-input
 * isolation; a runtime upgrade/fix is still required for that availability
 * guarantee.
 */
export function* withAppInputSavepoint(
  transition: () => SyncStateUpdateStream<void>,
): SyncStateUpdateStream<void> {
  yield* World.resolve(createAppInputSavepoint, undefined);
  try {
    yield* transition();
  } catch (error) {
    yield* World.resolve(rollbackAppInputSavepoint, undefined);
    yield* World.resolve(releaseAppInputSavepoint, undefined);
    throw new AppInputTransitionError(error);
  }
  yield* World.resolve(releaseAppInputSavepoint, undefined);
}
