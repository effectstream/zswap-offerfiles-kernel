import { describe, expect, test } from "bun:test";
import {
  assertCompactRuntimeInvariant,
  COMPACT_RUNTIME_PACKAGE,
  EXPECTED_COMPACT_RUNTIME_LOCATOR,
  EXPECTED_COMPACT_RUNTIME_VERSION,
  type BunLock,
  type CompactRuntimeState,
  type PackageManifest,
} from "./check-compact-runtime";

function validManifests(): Record<string, PackageManifest> {
  const dependencies = {
    [COMPACT_RUNTIME_PACKAGE]: EXPECTED_COMPACT_RUNTIME_VERSION,
  };
  return {
    "package.json": {
      dependencies: { ...dependencies },
      overrides: { ...dependencies },
    },
    "packages/contracts-midnight/package.json": {
      dependencies: { ...dependencies },
    },
    "packages/contracts-midnight/contract-offer-files/package.json": {
      dependencies: { ...dependencies },
    },
  };
}

function stateWith(lock: BunLock): CompactRuntimeState {
  return { lock, manifests: validManifests() };
}

describe("compact runtime invariant", () => {
  test("accepts exactly one 0.19.0 resolution and exact first-party pins", () => {
    expect(() =>
      assertCompactRuntimeInvariant(
        stateWith({
          packages: {
            [COMPACT_RUNTIME_PACKAGE]: [EXPECTED_COMPACT_RUNTIME_LOCATOR],
          },
        }),
      ),
    ).not.toThrow();
  });

  test("rejects duplicate resolved runtime versions", () => {
    expect(() =>
      assertCompactRuntimeInvariant(
        stateWith({
          packages: {
            [COMPACT_RUNTIME_PACKAGE]: [EXPECTED_COMPACT_RUNTIME_LOCATOR],
            [`transitive/${COMPACT_RUNTIME_PACKAGE}`]: [
              `${COMPACT_RUNTIME_PACKAGE}@0.18.0-rc.1`,
            ],
          },
        }),
      ),
    ).toThrow("resolved locators must be exactly");
  });

  test("rejects a missing runtime resolution", () => {
    expect(() =>
      assertCompactRuntimeInvariant(stateWith({ packages: {} })),
    ).toThrow("found []");
  });

  test("rejects a stale first-party direct pin", () => {
    const state = stateWith({
      packages: {
        [COMPACT_RUNTIME_PACKAGE]: [EXPECTED_COMPACT_RUNTIME_LOCATOR],
      },
    });
    state.manifests["packages/contracts-midnight/package.json"]!.dependencies![
      COMPACT_RUNTIME_PACKAGE
    ] = "0.18.0-rc.1";

    expect(() => assertCompactRuntimeInvariant(state)).toThrow(
      "packages/contracts-midnight/package.json#dependencies",
    );
  });
});
