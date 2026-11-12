// Checks a built kernel image from the inside, with the image's own Bun:
//
//   1. no test-only file is in the image: no `*.test.ts`, `*.test-<role>.ts`,
//      `*.testkit.ts`, `*.pgtest.ts` or `*.bench.ts` file (nor any other name
//      `bun test` collects), no test fixture and nothing of the e2e suite
//      `packages/tests/` except its `package.json`, outside every
//      `node_modules`;
//   2. every program the image runs resolves its whole import graph, so no
//      runtime module depends on a file the image leaves out.
//
// The image holds no copy of this file. Run it from a checkout:
//
//   docker run --rm --network none \
//     -v "$PWD/deploy/images/kernel/image.test-gate.ts:/opt/image-gate/image.test-gate.ts:ro" \
//     --entrypoint bun <kernel image> /opt/image-gate/image.test-gate.ts
//
// It prints what it checked and every finding, and exits 1 on any finding.

import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const APP = "/app";
const BIN = "/usr/local/bin";

/** Names that only test code carries. */
const TEST_FILE_NAMES: RegExp[] = [
  /[._](test|spec)\.[cm]?[jt]sx?$/, // what `bun test` collects
  /\.test-[a-z0-9-]+\.[cm]?[jt]sx?$/, // test helpers: *.test-child.ts, *.test-support.ts, ...
  /\.testkit\.[cm]?[jt]sx?$/,
  /\.pgtest\.[cm]?[jt]sx?$/,
  /\.bench\.[cm]?[jt]sx?$/,
];

/** Directories (relative to /app) that hold test code or test data only. */
const TEST_DIRS = [
  "packages/tests/",
  "packages/api-contracts/fixtures/",
  "packages/database/fixtures/",
  "packages/validator/fixtures/",
];

/** The one file a test directory may keep: the workspace install needs it. */
const KEPT = new Set(["packages/tests/package.json"]);

/** The programs the image runs: its entrypoint scripts' targets, the PGlite
 *  helpers they copy to /usr/local/bin, and the operator scripts the
 *  deployment docs run inside the kernel container. */
const PROGRAMS = [
  "packages/node/main.dev.ts",
  "packages/node/main.public.ts",
  "packages/node/public-network-profile.ts",
  "packages/batcher/batcher.dev.ts",
  "packages/batcher/batcher.public.ts",
  "packages/price-feed/price-feed.dev.ts",
  "packages/database/import-token-registry.ts",
  "deploy/scripts/post-maker-offer.ts",
  "deploy/scripts/offer-poster.ts",
  "deploy/scripts/read-wallet.ts",
  "deploy/scripts/provision-solver-fees.ts",
  "deploy/scripts/probe-backend-currentness.ts",
  "deploy/scripts/lib/check-compose-topology.ts",
  `${BIN}/pglite-forwarder.ts`,
  `${BIN}/pglite-healthcheck.ts`,
];

const findings: string[] = [];

// ── 1. no test-only file ────────────────────────────────────────────────────

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      if (name !== "node_modules") walk(path, out);
    } else {
      out.push(path);
    }
  }
}

const appFiles: string[] = [];
walk(APP, appFiles);
const binFiles = readdirSync(BIN).map((name) => join(BIN, name));
let testFiles = 0;
for (const path of [...appFiles, ...binFiles]) {
  const rel = path.startsWith(`${APP}/`) ? relative(APP, path) : path;
  const byName = TEST_FILE_NAMES.some((pattern) => pattern.test(path));
  const byDir = TEST_DIRS.some((dir) => rel.startsWith(dir)) && !KEPT.has(rel);
  if (byName || byDir) {
    testFiles += 1;
    findings.push(`test-only file in the image: ${path}`);
  }
}
console.log(
  `[image-gate] scanned ${appFiles.length} files under ${APP} (outside node_modules) and ` +
    `${binFiles.length} under ${BIN}: ${testFiles} test-only`,
);

// ── 2. every program's import graph resolves ────────────────────────────────
//
// `Bun.build` bundles each program with the image's own resolver (workspace
// links, package `exports`, text imports) into a throwaway directory. A module
// that imports a file the image leaves out fails with "Could not resolve".

// entrypoint-pglite.sh runs the start script it resolves from the database
// workspace package; resolve it the same way.
let startPglite = "";
try {
  startPglite = Bun.resolveSync("@effectstream/db/start-pglite", `${APP}/packages/database`);
} catch (error) {
  findings.push(`cannot resolve @effectstream/db/start-pglite from packages/database: ${String(error)}`);
}
const programs = PROGRAMS.map((program) => (program.startsWith("/") ? program : join(APP, program)));
if (startPglite) programs.push(startPglite);

const outRoot = mkdtempSync(join(tmpdir(), "image-gate-"));
let resolved = 0;
try {
  for (const [index, program] of programs.entries()) {
    if (!Bun.file(program).size) {
      findings.push(`program missing from the image: ${program}`);
      console.log(`[image-gate] MISSING ${program}`);
      continue;
    }
    let errors: string[];
    try {
      const result = await Bun.build({
        entrypoints: [program],
        target: "bun",
        outdir: join(outRoot, String(index)),
        throw: false,
      });
      errors = result.success
        ? []
        : result.logs.map((log) => {
            const at = log.position ? ` (${log.position.file}:${log.position.line})` : "";
            return `${log.message}${at}`;
          });
      if (!result.success && errors.length === 0) errors = ["build failed without a message"];
    } catch (error) {
      errors = [String(error)];
    }
    if (errors.length === 0) {
      resolved += 1;
      console.log(`[image-gate] resolves ${program}`);
    } else {
      console.log(`[image-gate] UNRESOLVED ${program}`);
      for (const message of errors) findings.push(`${program}: ${message}`);
    }
  }
} finally {
  rmSync(outRoot, { recursive: true, force: true });
}
console.log(`[image-gate] import graphs: ${resolved} of ${programs.length} programs resolve`);

if (findings.length > 0) {
  console.log(`[image-gate] FAIL: ${findings.length} finding(s)`);
  for (const finding of findings) console.log(`  - ${finding}`);
  process.exit(1);
}
console.log("[image-gate] PASS: no test-only file, every program resolves");
