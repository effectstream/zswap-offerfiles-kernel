import type { SolverAdmissionEnv } from "../env.ts";

export interface AdmissionWarningTimers {
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const DEFAULT_TIMERS: AdmissionWarningTimers = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs) as unknown as { unref?: () => void };
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Q-RF-2's OPEN-default warning contract. Diagnostics are contained: a
 * throwing sink cannot change admission state or create a rejected task. */
export function startAdmissionWarnings(
  admission: SolverAdmissionEnv,
  log: (message: string) => void,
  timers: AdmissionWarningTimers = DEFAULT_TIMERS,
): { stop: () => void } {
  let stopped = false;
  const warn = (): void => {
    if (stopped) return;
    for (const group of admission.openGroups) {
      try {
        log(`[ADMISSION] ${group} is UNSET: this policy group is OPEN`);
      } catch {
        // A diagnostic sink never owns the admission decision.
      }
    }
  };
  warn();
  const timer = admission.openGroups.length === 0
    ? null
    : timers.setInterval(warn, admission.warningIntervalMs);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer !== null) timers.clearInterval(timer);
    },
  };
}
