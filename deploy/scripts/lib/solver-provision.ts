const PREFUNDING_PREREQUISITE =
  "externally prefund SOLVER_SEED with unshielded NIGHT and wait for usable DUST before retrying";

/** Verify that prefunded NIGHT has either just been registered or was already
 * registered and has produced usable DUST. `registerNightForDust` returns true
 * for both successful states and false when neither condition is true. */
export async function ensureSolverDustReady(
  register: () => Promise<boolean>,
): Promise<{ dustReady: true }> {
  let ready: boolean;
  try {
    ready = await register();
  } catch (error) {
    throw new Error(
      `solver DUST readiness check failed: ${error instanceof Error ? error.message : String(error)}; ${PREFUNDING_PREREQUISITE}`,
    );
  }
  if (!ready) {
    throw new Error(`solver has no usable DUST; ${PREFUNDING_PREREQUISITE}`);
  }
  return { dustReady: true };
}
