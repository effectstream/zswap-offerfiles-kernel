// Lockfile guard for the Midnight / Effectstream stack.
//
// Why: two copies of a ledger WASM package in one process make every call that
// crosses them fail with "expected instance of LedgerParameters" (the classes
// are nominally distinct per copy). A transitive range can pull a second copy in
// silently (for example `ledger-v9@1.0.1` next to the pinned 1.0.0), and only a
// check on the resolved lockfile notices before runtime does.
//
// The rules, all on the resolved `bun.lock` plus the workspace manifests:
//   * exactly one `@midnightntwrk/ledger-v9`, at LEDGER_V9_VERSION;
//   * exactly one `@midnightntwrk/onchain-runtime-v4`, at ONCHAIN_RUNTIME_V4_VERSION;
//   * `@midnightntwrk/ledger-v8` at most once, at TRANSITIVE_LEDGER_V8_VERSION.
//     The stable wallet SDK (wallet-sdk 2.0.0, midnight-js 5.0.0, compact-js
//     3.0.0) is dual-era: it carries ledger-8 handlers next to the ledger-9 ones
//     and depends on ledger-v8 itself. That copy is tolerated; a second copy, or
//     a workspace manifest naming any ledger-8 package directly, is not;
//   * no `@midnight-ntwrk/ledger*` package (the pre-rename ledger scope);
//   * no `@effectstream/*` from the retired 0.10x / 0.200.x lines;
//   * no pre-release (rc, beta, alpha, canary, …) of any `@midnightntwrk/*`,
//     `@midnight-ntwrk/*` or `@effectstream/*` package;
//   * the root `overrides` pin ledger-v9 and onchain-runtime-v4 to the versions
//     above, so a transitive range cannot move them;
//   * no workspace manifest depends on `@midnight-ntwrk/midnight-js-network-id`
//     (removed in midnight-js 5.0.0; the network id travels in the provider and
//     wallet configuration).
import path from "node:path";

export const LEDGER_V9 = "@midnightntwrk/ledger-v9";
export const ONCHAIN_RUNTIME_V4 = "@midnightntwrk/onchain-runtime-v4";
export const LEDGER_V8 = "@midnightntwrk/ledger-v8";
export const LEDGER_V9_VERSION = "1.0.0";
export const ONCHAIN_RUNTIME_V4_VERSION = "4.0.0";
export const TRANSITIVE_LEDGER_V8_VERSION = "8.1.3";

/** Packages no workspace manifest may depend on directly. */
export const FORBIDDEN_DIRECT_DEPENDENCIES = [
  LEDGER_V8,
  "@midnight-ntwrk/onchain-runtime-v3",
  "@midnight-ntwrk/midnight-js-network-id",
] as const;

const MIDNIGHT_SCOPES = ["@midnightntwrk/", "@midnight-ntwrk/", "@effectstream/"];
const RETIRED_EFFECTSTREAM = /^0\.(10[0-9]|200)\.\d+/;
const PRERELEASE = /^\d+\.\d+\.\d+-/;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type DependencyMap = Record<string, string>;

export interface PackageManifest {
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  overrides?: DependencyMap;
  workspaces?: string[];
}

export interface BunLock {
  packages?: Record<string, unknown>;
}

export interface MidnightStackState {
  lock: BunLock;
  /** Keyed by repository-relative manifest path; the root is "package.json". */
  manifests: Record<string, PackageManifest>;
}

export interface Locator {
  name: string;
  version: string;
}

/** `@scope/name@1.2.3` → { name, version }. Workspace and other non-registry
 *  locators (`workspace:`, `github:`, …) come back with that prefix in
 *  `version`, which no rule below matches. */
export function parseLocator(locator: string): Locator | null {
  const at = locator.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: locator.slice(0, at), version: locator.slice(at + 1) };
}

/** Every distinct resolved locator in the lockfile. An alias key (for example
 *  `@midnight-ntwrk/onchain-runtime` → `npm:@midnightntwrk/onchain-runtime-v4`)
 *  resolves to the real package's locator, so it counts as that package. */
export function resolvedLocators(lock: BunLock): Locator[] {
  const seen = new Set<string>();
  const out: Locator[] = [];
  for (const resolution of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(resolution) || typeof resolution[0] !== "string") continue;
    const raw = resolution[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const parsed = parseLocator(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function versionsOf(locators: Locator[], name: string): string[] {
  return locators
    .filter((l) => l.name === name)
    .map((l) => l.version)
    .sort();
}

export function assertMidnightStackInvariant({
  lock,
  manifests,
}: MidnightStackState): void {
  const errors: string[] = [];
  const locators = resolvedLocators(lock);

  const exactlyOne = (name: string, version: string) => {
    const versions = versionsOf(locators, name);
    if (versions.length !== 1 || versions[0] !== version) {
      errors.push(
        `${name} must resolve exactly once, at ${version}; found [${versions.join(", ")}]`,
      );
    }
  };
  exactlyOne(LEDGER_V9, LEDGER_V9_VERSION);
  exactlyOne(ONCHAIN_RUNTIME_V4, ONCHAIN_RUNTIME_V4_VERSION);

  const v8 = versionsOf(locators, LEDGER_V8);
  if (v8.length > 1 || (v8.length === 1 && v8[0] !== TRANSITIVE_LEDGER_V8_VERSION)) {
    errors.push(
      `${LEDGER_V8} may resolve at most once, at ${TRANSITIVE_LEDGER_V8_VERSION} (the wallet SDK's own dependency); found [${v8.join(", ")}]`,
    );
  }

  for (const { name, version } of locators) {
    if (name.startsWith("@midnight-ntwrk/ledger")) {
      errors.push(`pre-rename ledger package ${name}@${version} must not resolve`);
    }
    if (name.startsWith("@effectstream/") && RETIRED_EFFECTSTREAM.test(version)) {
      errors.push(`${name}@${version} is from a retired @effectstream line (0.10x / 0.200.x)`);
    }
    if (MIDNIGHT_SCOPES.some((scope) => name.startsWith(scope)) && PRERELEASE.test(version)) {
      errors.push(`${name}@${version} is a pre-release; the stack must be stable releases only`);
    }
  }

  for (const [manifestPath, manifest] of Object.entries(manifests)) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of FORBIDDEN_DIRECT_DEPENDENCIES) {
        if (manifest[section]?.[dependency] !== undefined) {
          errors.push(`${manifestPath}#${section} must not depend on ${dependency}`);
        }
      }
    }
  }

  const overrides = manifests["package.json"]?.overrides ?? {};
  for (const [name, version] of [
    [LEDGER_V9, LEDGER_V9_VERSION],
    [ONCHAIN_RUNTIME_V4, ONCHAIN_RUNTIME_V4_VERSION],
  ] as const) {
    if (overrides[name] !== version) {
      errors.push(
        `package.json#overrides.${name} must be exactly ${version}, found ${overrides[name] ?? "missing"}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Midnight stack invariant failed:\n- ${errors.join("\n- ")}`);
  }
}

/** The root manifest plus every workspace member's (`workspaces` globs). */
export async function readWorkspaceManifests(
  repositoryRoot: string,
): Promise<Record<string, PackageManifest>> {
  const read = async (relativePath: string) =>
    JSON.parse(await Bun.file(path.join(repositoryRoot, relativePath)).text()) as PackageManifest;
  const root = await read("package.json");
  const manifests: Record<string, PackageManifest> = { "package.json": root };
  for (const pattern of root.workspaces ?? []) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, "")}/package.json`);
    for await (const relativePath of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
      manifests[relativePath] = await read(relativePath);
    }
  }
  return manifests;
}

/** `bun.lock` is JSON with trailing commas. Drop every comma that is followed
 *  only by whitespace and a closing bracket, outside string literals, then
 *  parse as JSON (no JSONC parser ships with every Bun version this repo runs
 *  on). */
export function parseBunLock(text: string): BunLock {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return JSON.parse(out) as BunLock;
}

export async function readLock(repositoryRoot: string): Promise<BunLock> {
  return parseBunLock(await Bun.file(path.join(repositoryRoot, "bun.lock")).text());
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  assertMidnightStackInvariant({
    lock: await readLock(repositoryRoot),
    manifests: await readWorkspaceManifests(repositoryRoot),
  });
  console.log(
    `midnight stack invariant OK: ${LEDGER_V9}@${LEDGER_V9_VERSION}, ${ONCHAIN_RUNTIME_V4}@${ONCHAIN_RUNTIME_V4_VERSION}`,
  );
}

if (import.meta.main) {
  await main();
}
