import { describe, expect, test } from "bun:test";

import { ensureSolverDustReady } from "./solver-provision.ts";

describe("external solver DUST prerequisite", () => {
  test("rejects a false registration/readiness result", async () => {
    await expect(ensureSolverDustReady(async () => false)).rejects.toThrow(
      /no usable DUST.*externally prefund SOLVER_SEED/,
    );
  });

  test("preserves registration errors and explains the external prerequisite", async () => {
    await expect(
      ensureSolverDustReady(async () => { throw new Error("dust sync timeout"); }),
    ).rejects.toThrow(/dust sync timeout.*externally prefund SOLVER_SEED/);
  });

  test("accepts true when NIGHT was already registered and DUST is usable", async () => {
    expect(await ensureSolverDustReady(async () => true)).toEqual({ dustReady: true });
  });
});
