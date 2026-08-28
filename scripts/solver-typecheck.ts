/**
 * Strict/no-emit TypeScript gate for the COW solver (FR-006 / 00003 `P4-F06`).
 *
 * `typecheck:backend` deliberately filters its diagnostics to `packages/node`,
 * which is exactly why solver drift was invisible: a dropped publication-policy
 * field, wallet/address and executor-state errors, the validator's
 * proof-variant errors, and a legacy E2E harness still calling callbacks
 * `SolverOptions` no longer has, all compiled "green" as far as the repo's
 * gates were concerned.
 *
 * What this gate covers, and why each part is in scope:
 *
 * - `packages/solver` and `packages/solver-core` — the solver itself,
 *   INCLUDING their tests. A gate that skipped tests would not have caught the
 *   harness rot it exists to prevent, and the tests are the executable
 *   description of the production contract.
 * - `packages/validator` — `swap-job-executor.ts` imports `@zswap-da/validator`
 *   for settlement verification, and 00003 lists its proof-variant diagnostics
 *   under this same finding. Excluding a first-party dependency would repeat
 *   the backend gate's blind spot one directory over.
 * - every other first-party file that imports the production solver's source,
 *   DISCOVERED rather than listed. A hand-maintained list is the failure mode
 *   `P4-F02` already demonstrated; today the scan finds the grand-E2E solver
 *   service and the `start.solver.ts` entrypoint, and any future harness is
 *   covered the moment it imports the solver. The scan covers `packages/**`
 *   and the repository root, because the deployment entrypoint lives there and
 *   is precisely the file whose option drift this gate must catch.
 *
 * Anything else reached through the import graph (notably the gitignored
 * Compact output under `packages/contracts-midnight`, which CI stubs) is
 * typechecked but only COUNTED — the same convention `backend-typecheck.ts`
 * uses, so this gate never depends on generated proof artifacts.
 */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

/** Packages whose own files are gated. Each owns a strict tsconfig. */
const GATED_PACKAGES = ["packages/solver", "packages/solver-core", "packages/validator"] as const;

/**
 * Where solver consumers are looked for (gated packages are skipped). The
 * repository root is searched too, non-recursively: `start.solver.ts` lives
 * there, and the entrypoint whose option drift this gate exists to catch must
 * not be the one file outside it.
 */
const CONSUMER_SEARCH_ROOTS = [
  { dir: resolve(projectRoot, "packages"), recursive: true },
  { dir: projectRoot, recursive: false },
] as const;

/**
 * A static import of the production solver's source: either the package
 * specifier `@zswap-da/solver` (exactly — `@zswap-da/solver-core` is a
 * different package and is gated separately) or a relative path into
 * `solver/src/`. Matching the specifier, never a bare mention, keeps files that
 * merely name a solver path in a string (an image file list, for example) out
 * of the gate.
 */
const SOLVER_IMPORT = /(?:from|import)\s*\(?\s*["'](?:@zswap-da\/solver|[^"']*\/solver\/src\/[^"']*)["']/;

function diagnosticHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  };
}

function fail(message: string): never {
  console.error(`[solver-typecheck] ${message}`);
  process.exit(1);
}

function parsePackageConfig(packageDir: string): ts.ParsedCommandLine {
  const root = resolve(projectRoot, packageDir);
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    console.error(ts.formatDiagnostic(config.error, diagnosticHost()));
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) {
    console.error(ts.formatDiagnostics(parsed.errors, diagnosticHost()));
    process.exit(1);
  }
  if (parsed.options.strict !== true || parsed.options.noEmit !== true) {
    fail(`${packageDir}/tsconfig.json must set compilerOptions.strict=true and noEmit=true`);
  }
  if (parsed.fileNames.length === 0) {
    fail(`${packageDir}/tsconfig.json matched no files — the gate would pass vacuously`);
  }
  return parsed;
}

/** First-party `.ts` files, skipping dependency and generated trees. */
function* firstPartySources(dir: string, recursive: boolean): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (entry.name === "node_modules" || entry.name === "managed" || entry.name.startsWith(".")) {
        continue;
      }
      yield* firstPartySources(path, true);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield path;
    }
  }
}

const gatedRoots = GATED_PACKAGES.map((packageDir) => resolve(projectRoot, packageDir) + sep);
const isInGatedPackage = (file: string): boolean =>
  gatedRoots.some((root) => resolve(file).startsWith(root));

const configs = GATED_PACKAGES.map((packageDir) => ({ packageDir, parsed: parsePackageConfig(packageDir) }));

const consumers: string[] = [];
for (const { dir, recursive } of CONSUMER_SEARCH_ROOTS) {
  for (const file of firstPartySources(dir, recursive)) {
    if (isInGatedPackage(file)) continue;
    if (SOLVER_IMPORT.test(readFileSync(file, "utf8"))) consumers.push(resolve(file));
  }
}
consumers.sort();

const rootNames = [
  ...new Set([...configs.flatMap(({ parsed }) => parsed.fileNames.map((f) => resolve(f))), ...consumers]),
].sort();

// One program over every gated root: the solver package's options are the
// gate's options, and the two other configs are asserted to be strict/noEmit
// copies of them above.
const program = ts.createProgram(rootNames, configs[0]!.parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const consumerSet = new Set(consumers);
const gateDiagnostics = diagnostics.filter((diagnostic) => {
  if (!diagnostic.file) return true;
  const file = resolve(diagnostic.file.fileName);
  return isInGatedPackage(file) || consumerSet.has(file);
});
const dependencyDiagnostics = diagnostics.length - gateDiagnostics.length;

console.log(
  `[solver-typecheck] strict/noEmit roots: ${rootNames.length} ` +
    `(${GATED_PACKAGES.join(", ")}` +
    `${consumers.length === 0
      ? ""
      : ` + ${consumers.length} solver-consuming file(s): ` +
        consumers.map((file) => relative(projectRoot, file)).join(", ")}` +
    `); dependency diagnostics outside the gate: ${dependencyDiagnostics}`,
);

if (gateDiagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(gateDiagnostics, diagnosticHost()));
  fail(`${gateDiagnostics.length} diagnostic(s) in the solver gate`);
}

console.log("[solver-typecheck] solver, solver-core, validator, solver consumers: 0 diagnostics");
