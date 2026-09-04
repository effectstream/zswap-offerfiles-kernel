import path from "node:path";

export const COMPACT_RUNTIME_PACKAGE = "@midnight-ntwrk/compact-runtime";
export const EXPECTED_COMPACT_RUNTIME_VERSION = "0.19.0";
export const EXPECTED_COMPACT_RUNTIME_LOCATOR =
  `${COMPACT_RUNTIME_PACKAGE}@${EXPECTED_COMPACT_RUNTIME_VERSION}`;

type DependencyMap = Record<string, string>;

export interface PackageManifest {
  dependencies?: DependencyMap;
  overrides?: DependencyMap;
}

export interface BunLock {
  packages?: Record<string, unknown>;
}

export interface CompactRuntimeState {
  lock: BunLock;
  manifests: Record<string, PackageManifest>;
}

const REQUIRED_DIRECT_PINS = [
  "package.json#dependencies",
  "packages/contracts-midnight/package.json#dependencies",
  "packages/contracts-midnight/contract-offer-files/package.json#dependencies",
] as const;

const REQUIRED_OVERRIDE = "package.json#overrides";

export function resolvedCompactRuntimeLocators(lock: BunLock): string[] {
  const locators = new Set<string>();

  for (const [key, resolution] of Object.entries(lock.packages ?? {})) {
    if (
      key !== COMPACT_RUNTIME_PACKAGE &&
      !key.endsWith(`/${COMPACT_RUNTIME_PACKAGE}`)
    ) {
      continue;
    }

    if (Array.isArray(resolution) && typeof resolution[0] === "string") {
      locators.add(resolution[0]);
    }
  }

  return [...locators].sort();
}

function dependencyMapAt(
  manifests: Record<string, PackageManifest>,
  reference: string,
): DependencyMap | undefined {
  const [manifestPath, section] = reference.split("#") as [
    string,
    "dependencies" | "overrides",
  ];
  return manifests[manifestPath]?.[section];
}

export function assertCompactRuntimeInvariant({
  lock,
  manifests,
}: CompactRuntimeState): void {
  const errors: string[] = [];
  const locators = resolvedCompactRuntimeLocators(lock);

  if (
    locators.length !== 1 ||
    locators[0] !== EXPECTED_COMPACT_RUNTIME_LOCATOR
  ) {
    errors.push(
      `resolved locators must be exactly [${EXPECTED_COMPACT_RUNTIME_LOCATOR}], found [${locators.join(", ")}]`,
    );
  }

  for (const reference of REQUIRED_DIRECT_PINS) {
    const actual = dependencyMapAt(manifests, reference)?.[
      COMPACT_RUNTIME_PACKAGE
    ];
    if (actual !== EXPECTED_COMPACT_RUNTIME_VERSION) {
      errors.push(
        `${reference}.${COMPACT_RUNTIME_PACKAGE} must be exactly ${EXPECTED_COMPACT_RUNTIME_VERSION}, found ${actual ?? "missing"}`,
      );
    }
  }

  const override = dependencyMapAt(manifests, REQUIRED_OVERRIDE)?.[
    COMPACT_RUNTIME_PACKAGE
  ];
  if (override !== EXPECTED_COMPACT_RUNTIME_VERSION) {
    errors.push(
      `${REQUIRED_OVERRIDE}.${COMPACT_RUNTIME_PACKAGE} must be exactly ${EXPECTED_COMPACT_RUNTIME_VERSION}, found ${override ?? "missing"}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Compact runtime invariant failed:\n- ${errors.join("\n- ")}`);
  }
}

async function readJson(filePath: string): Promise<PackageManifest> {
  return JSON.parse(await Bun.file(filePath).text()) as PackageManifest;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const manifestPaths = [
    "package.json",
    "packages/contracts-midnight/package.json",
    "packages/contracts-midnight/contract-offer-files/package.json",
  ];
  const manifests = Object.fromEntries(
    await Promise.all(
      manifestPaths.map(async (manifestPath) => [
        manifestPath,
        await readJson(path.join(repositoryRoot, manifestPath)),
      ]),
    ),
  );
  const lock = Bun.JSONC.parse(
    await Bun.file(path.join(repositoryRoot, "bun.lock")).text(),
  ) as BunLock;

  assertCompactRuntimeInvariant({ lock, manifests });
  console.log(
    `compact-runtime invariant OK: ${EXPECTED_COMPACT_RUNTIME_LOCATOR}`,
  );
}

if (import.meta.main) {
  await main();
}
