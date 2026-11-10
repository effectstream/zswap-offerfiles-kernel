import ts from "typescript";
import { resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

// Each gated package compiles as its own program with its own strict tsconfig.
// packages/node gates its production files. packages/validator,
// packages/api-contracts and packages/kernel-client gate their production files
// and tests: the validator is the offer-verification code the node and the
// batcher run, and the tests of the other two are the executable description of
// the wire contracts the node serves and of the client that parses them.
const GATED_PACKAGES = [
  "packages/node",
  "packages/validator",
  "packages/api-contracts",
  "packages/kernel-client",
] as const;

let failed = false;
for (const packageDir of GATED_PACKAGES) {
  const packageRoot = resolve(projectRoot, packageDir) + sep;
  const configPath = resolve(packageRoot, "tsconfig.json");

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    console.error(ts.formatDiagnostic(config.error, diagnosticHost()));
    process.exit(1);
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot, undefined, configPath);
  if (parsed.errors.length > 0) {
    console.error(ts.formatDiagnostics(parsed.errors, diagnosticHost()));
    process.exit(1);
  }

  if (parsed.options.strict !== true || parsed.options.noEmit !== true) {
    console.error(`backend typecheck requires ${packageDir}/tsconfig.json to set compilerOptions.strict=true and noEmit=true`);
    process.exit(1);
  }
  if (parsed.fileNames.length === 0) {
    console.error(`${packageDir}/tsconfig.json matched no files — the gate would pass vacuously`);
    process.exit(1);
  }

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const packageDiagnostics = diagnostics.filter(
    (diagnostic) => !diagnostic.file || resolve(diagnostic.file.fileName).startsWith(packageRoot),
  );
  const dependencyDiagnostics = diagnostics.length - packageDiagnostics.length;

  console.log(
    `[backend-typecheck] strict/noEmit ${packageDir} roots: ${parsed.fileNames.length}; ` +
      `dependency diagnostics outside the backend-only gate: ${dependencyDiagnostics}`,
  );

  if (packageDiagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(packageDiagnostics, diagnosticHost()));
    failed = true;
    continue;
  }

  console.log(`[backend-typecheck] ${packageDir}: 0 diagnostics`);
}

if (failed) process.exit(1);

function diagnosticHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  };
}
