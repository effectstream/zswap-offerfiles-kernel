import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertMidnightStackInvariant,
  type BunLock,
  LEDGER_V8,
  LEDGER_V9,
  LEDGER_V9_VERSION,
  type MidnightStackState,
  ONCHAIN_RUNTIME_V4,
  ONCHAIN_RUNTIME_V4_VERSION,
  type PackageManifest,
  parseBunLock,
  readLock,
  readWorkspaceManifests,
  TRANSITIVE_LEDGER_V8_VERSION,
} from "./check-midnight-stack";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");

function entry(locator: string): unknown[] {
  return [locator, "", {}, "sha512-fixture"];
}

/** A small lockfile that satisfies every rule: the stable stack, the wallet
 *  SDK's own ledger-v8 copy, an alias of onchain-runtime-v4 and a workspace. */
function validLock(): BunLock {
  return {
    packages: {
      [LEDGER_V9]: entry(`${LEDGER_V9}@${LEDGER_V9_VERSION}`),
      [ONCHAIN_RUNTIME_V4]: entry(`${ONCHAIN_RUNTIME_V4}@${ONCHAIN_RUNTIME_V4_VERSION}`),
      "@midnight-ntwrk/onchain-runtime": entry(
        `${ONCHAIN_RUNTIME_V4}@${ONCHAIN_RUNTIME_V4_VERSION}`,
      ),
      [LEDGER_V8]: entry(`${LEDGER_V8}@${TRANSITIVE_LEDGER_V8_VERSION}`),
      "@effectstream/midnight-contracts": entry("@effectstream/midnight-contracts@0.300.2"),
      "@midnightntwrk/wallet-sdk-facade": entry("@midnightntwrk/wallet-sdk-facade@5.0.0"),
      "@zswap-da/node": ["@zswap-da/node@workspace:packages/node"],
    },
  };
}

function validManifests(): Record<string, PackageManifest> {
  return {
    "package.json": {
      dependencies: { [LEDGER_V9]: LEDGER_V9_VERSION },
      overrides: {
        [LEDGER_V9]: LEDGER_V9_VERSION,
        [ONCHAIN_RUNTIME_V4]: ONCHAIN_RUNTIME_V4_VERSION,
      },
    },
    "packages/node/package.json": {
      dependencies: { [ONCHAIN_RUNTIME_V4]: ONCHAIN_RUNTIME_V4_VERSION },
    },
  };
}

function state(
  lock: BunLock = validLock(),
  manifests: Record<string, PackageManifest> = validManifests(),
): MidnightStackState {
  return { lock, manifests };
}

function withPackage(lock: BunLock, key: string, locator: string): BunLock {
  return { packages: { ...lock.packages, [key]: entry(locator) } };
}

describe("midnight stack invariant: this repository", () => {
  test("the committed bun.lock and workspace manifests satisfy it", async () => {
    const lock = await readLock(REPOSITORY_ROOT);
    const manifests = await readWorkspaceManifests(REPOSITORY_ROOT);
    expect(Object.keys(manifests)).toContain("packages/node/package.json");
    expect(() => assertMidnightStackInvariant({ lock, manifests })).not.toThrow();
  });

  test("the committed bun.lock with a second ledger-v9 copy (1.0.1) fails", async () => {
    const lock = await readLock(REPOSITORY_ROOT);
    const manifests = await readWorkspaceManifests(REPOSITORY_ROOT);
    const mutant = withPackage(
      lock,
      `@effectstream/midnight-contracts/${LEDGER_V9}`,
      `${LEDGER_V9}@1.0.1`,
    );
    expect(() => assertMidnightStackInvariant({ lock: mutant, manifests })).toThrow(
      `${LEDGER_V9} must resolve exactly once, at ${LEDGER_V9_VERSION}; found [1.0.0, 1.0.1]`,
    );
  });
});

describe("parseBunLock", () => {
  test("drops trailing commas but keeps commas and brackets inside strings", () => {
    const text = '{\n  "packages": {\n    "a": ["a@1.0.0", "x,]", { "k": "v,}" },],\n  },\n}\n';
    expect(parseBunLock(text)).toEqual({ packages: { a: ["a@1.0.0", "x,]", { k: "v,}" }] } });
  });

  test("keeps escaped quotes inside strings", () => {
    expect(parseBunLock('{ "packages": { "a": ["a@1.0.0", "q\\",]" ,], }, }')).toEqual({
      packages: { a: ["a@1.0.0", 'q",]'] },
    });
  });
});

describe("midnight stack invariant: rules", () => {
  test("accepts the stable stack, an alias of onchain-runtime-v4 and the SDK's ledger-v8", () => {
    expect(() => assertMidnightStackInvariant(state())).not.toThrow();
  });

  test("accepts a lockfile without ledger-v8", () => {
    const lock = validLock();
    delete lock.packages![LEDGER_V8];
    expect(() => assertMidnightStackInvariant(state(lock))).not.toThrow();
  });

  test("rejects a missing ledger-v9", () => {
    const lock = validLock();
    delete lock.packages![LEDGER_V9];
    expect(() => assertMidnightStackInvariant(state(lock))).toThrow(
      `${LEDGER_V9} must resolve exactly once`,
    );
  });

  test("rejects a ledger-v9 pre-release in place of the pinned version", () => {
    const lock = withPackage(validLock(), LEDGER_V9, `${LEDGER_V9}@1.0.0-rc.3`);
    expect(() => assertMidnightStackInvariant(state(lock))).toThrow(
      `${LEDGER_V9}@1.0.0-rc.3 is a pre-release`,
    );
  });

  test("rejects a second onchain-runtime-v4 copy", () => {
    const lock = withPackage(
      validLock(),
      `some-dep/${ONCHAIN_RUNTIME_V4}`,
      `${ONCHAIN_RUNTIME_V4}@4.0.1`,
    );
    expect(() => assertMidnightStackInvariant(state(lock))).toThrow(
      `${ONCHAIN_RUNTIME_V4} must resolve exactly once`,
    );
  });

  test("rejects a second ledger-v8 copy", () => {
    const lock = withPackage(validLock(), `some-dep/${LEDGER_V8}`, `${LEDGER_V8}@8.2.0`);
    expect(() => assertMidnightStackInvariant(state(lock))).toThrow(
      `${LEDGER_V8} may resolve at most once`,
    );
  });

  test("rejects a pre-rename @midnight-ntwrk ledger package", () => {
    const lock = withPackage(validLock(), "@midnight-ntwrk/ledger-v8", "@midnight-ntwrk/ledger-v8@8.0.0");
    expect(() => assertMidnightStackInvariant(state(lock))).toThrow("pre-rename ledger package");
  });

  test("rejects @effectstream packages from the 0.200.x and 0.10x lines", () => {
    for (const version of ["0.200.6", "0.104.3"]) {
      const lock = withPackage(validLock(), "@effectstream/utils", `@effectstream/utils@${version}`);
      expect(() => assertMidnightStackInvariant(state(lock))).toThrow(
        `@effectstream/utils@${version} is from a retired @effectstream line`,
      );
    }
  });

  test("rejects a pre-release of any Midnight or Effectstream package", () => {
    for (const locator of [
      "@midnightntwrk/wallet-sdk-facade@5.0.0-beta.2",
      "@midnight-ntwrk/midnight-js-types@5.0.0-beta.6",
      "@effectstream/mip-zswap-offer@0.4.0-v9.0",
    ]) {
      const key = locator.slice(0, locator.lastIndexOf("@"));
      const lock = withPackage(validLock(), key, locator);
      expect(() => assertMidnightStackInvariant(state(lock))).toThrow(`${locator} is a pre-release`);
    }
  });

  test("rejects a workspace manifest that depends on a ledger-8 package or midnight-js-network-id", () => {
    for (const dependency of [
      LEDGER_V8,
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/midnight-js-network-id",
    ]) {
      const manifests = validManifests();
      manifests["packages/node/package.json"]!.dependencies![dependency] = "1.0.0";
      expect(() => assertMidnightStackInvariant(state(validLock(), manifests))).toThrow(
        `packages/node/package.json#dependencies must not depend on ${dependency}`,
      );
    }
  });

  test("rejects a root manifest whose overrides do not pin ledger-v9 and onchain-runtime-v4", () => {
    const manifests = validManifests();
    delete manifests["package.json"]!.overrides![ONCHAIN_RUNTIME_V4];
    manifests["package.json"]!.overrides![LEDGER_V9] = "1.0.1";
    const run = () => assertMidnightStackInvariant(state(validLock(), manifests));
    expect(run).toThrow(`package.json#overrides.${LEDGER_V9} must be exactly ${LEDGER_V9_VERSION}, found 1.0.1`);
    expect(run).toThrow(
      `package.json#overrides.${ONCHAIN_RUNTIME_V4} must be exactly ${ONCHAIN_RUNTIME_V4_VERSION}, found missing`,
    );
  });
});
