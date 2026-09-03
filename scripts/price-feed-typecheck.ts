#!/usr/bin/env bun
// Type gate for packages/price-feed, mirroring backend-typecheck.ts.
//
// The repo gates types per component rather than repo-wide: `tsc` over
// everything drowns in diagnostics from dependencies nobody is changing. The
// price feed is a standalone process with its own tsconfig, so it gets its own
// gate — otherwise the one package in this project that nothing imports would
// be the one package nothing typechecks.
import ts from "typescript";
import { resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(projectRoot, "packages/price-feed") + sep;
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
  console.error("price-feed typecheck requires compilerOptions.strict=true and noEmit=true");
  process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const own = diagnostics.filter(
  (diagnostic) => !diagnostic.file || resolve(diagnostic.file.fileName).startsWith(packageRoot),
);

console.log(
  `[price-feed-typecheck] strict/noEmit roots: ${parsed.fileNames.length}; ` +
    `dependency diagnostics outside the gate: ${diagnostics.length - own.length}`,
);

if (own.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(own, diagnosticHost()));
  process.exit(1);
}

console.log("[price-feed-typecheck] packages/price-feed: 0 diagnostics");

function diagnosticHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => "\n",
  };
}
