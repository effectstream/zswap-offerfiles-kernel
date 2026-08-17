import {
  reportsBackendProjectionCurrent,
  type BackendSyncHealth,
} from "@zswap-da/solver-core/api-client";

export type SolverReadinessBlocker =
  | "backend-unavailable"
  | "backend-not-current"
  | "stream-disconnected"
  | "snapshot-incomplete"
  | "inventory-unready"
  | "validation-unavailable";

export interface SolverReadinessSignals {
  /** Null covers transport, HTTP, deadline, cancellation, and grammar failure. */
  backend: BackendSyncHealth | null;
  /** Increments for every SSE open/disconnect transition. */
  streamGeneration: number;
  streamConnected: boolean;
  /** The stream generation whose full REST snapshot and buffered gap drained. */
  snapshotGeneration: number | null;
  inventoryReady: boolean;
  /** The exact backend/SSE generation whose raw book fully drained through
   * validate-for-use. Null covers transport, auth, grammar, domain-generation,
   * initial-empty capability, and active-drain states. */
  validationGeneration: {
    streamGeneration: number;
    backendBlockL2: string;
  } | null;
}

export type SolverReadinessState =
  | {
      kind: "blocked";
      reason: SolverReadinessBlocker;
      streamGeneration: number;
    }
  | {
      kind: "ready";
      streamGeneration: number;
      backendBlockL2: string;
    };

/** Pure combined-policy seam. D1 owns backend polling/freshness and stream-
 * bound snapshots; D2 binds validation and inventory restoration to that same
 * exact generation. This keeps the final cross-gate state
 * explicit and independently testable while those lifecycle owners stay
 * separate. */
export function deriveSolverReadiness(signals: SolverReadinessSignals): SolverReadinessState {
  const blocked = (reason: SolverReadinessBlocker): SolverReadinessState => ({
    kind: "blocked",
    reason,
    streamGeneration: signals.streamGeneration,
  });

  if (signals.backend === null) return blocked("backend-unavailable");
  if (
    !reportsBackendProjectionCurrent(signals.backend) ||
    signals.backend.blockL2 === null
  ) {
    return blocked("backend-not-current");
  }
  if (
    !signals.streamConnected ||
    !Number.isSafeInteger(signals.streamGeneration) ||
    signals.streamGeneration <= 0
  ) {
    return blocked("stream-disconnected");
  }
  if (signals.snapshotGeneration !== signals.streamGeneration) {
    return blocked("snapshot-incomplete");
  }
  if (
    signals.validationGeneration === null ||
    signals.validationGeneration.streamGeneration !== signals.streamGeneration ||
    signals.validationGeneration.backendBlockL2 !== signals.backend.blockL2.height
  ) return blocked("validation-unavailable");
  if (!signals.inventoryReady) return blocked("inventory-unready");

  return {
    kind: "ready",
    streamGeneration: signals.streamGeneration,
    backendBlockL2: signals.backend.blockL2.height,
  };
}
