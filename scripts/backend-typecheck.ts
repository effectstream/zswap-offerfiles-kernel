import ts from "typescript";
import { resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const backendRoot = resolve(projectRoot, "packages/node") + sep;
const configPath = resolve(backendRoot, "tsconfig.json");

const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  console.error(ts.formatDiagnostic(config.error, diagnosticHost()));
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backendRoot, undefined, configPath);
if (parsed.errors.length > 0) {
  console.error(ts.formatDiagnostics(parsed.errors, diagnosticHost()));
  process.exit(1);
}

if (parsed.options.strict !== true || parsed.options.noEmit !== true) {
  console.error("backend typecheck requires compilerOptions.strict=true and noEmit=true");
  process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const backendDiagnostics = diagnostics.filter(
  (diagnostic) => !diagnostic.file || resolve(diagnostic.file.fileName).startsWith(backendRoot),
);
const dependencyDiagnostics = diagnostics.length - backendDiagnostics.length;

console.log(
  `[backend-typecheck] strict/noEmit packages/node roots: ${parsed.fileNames.length}; ` +
    `dependency diagnostics outside the backend-only gate: ${dependencyDiagnostics}`,
);

if (backendDiagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(backendDiagnostics, diagnosticHost()));
  process.exit(1);
}

console.log("[backend-typecheck] packages/node: 0 diagnostics");

function diagnosticHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  };
}
