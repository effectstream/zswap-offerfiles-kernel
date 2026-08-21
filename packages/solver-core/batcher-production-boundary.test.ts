import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const solverCore = dirname(fileURLToPath(import.meta.url));
const packages = dirname(solverCore);
const forbidden = [
  "settleViaBatcher",
  "parseBatcherAcknowledgement",
  "batcherInputFingerprint",
  "BATCHER_SUBMIT_URL",
];

function productionSources(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...productionSources(path));
    else if (entry.endsWith(".ts") && !entry.includes(".test.") && !entry.includes(".test-support.")) {
      result.push(path);
    }
  }
  return result;
}

test("production exports and solver source cannot reach the legacy batcher network path", () => {
  const exportedBatcher = readFileSync(join(solverCore, "batcher.ts"), "utf8");
  for (const name of forbidden) expect(exportedBatcher).not.toContain(name);

  const solverSources = productionSources(join(packages, "solver", "src"));
  for (const path of solverSources) {
    const source = readFileSync(path, "utf8");
    for (const name of forbidden) expect(source).not.toContain(name);
  }

  const manifest = JSON.parse(readFileSync(join(solverCore, "package.json"), "utf8"));
  expect(Object.values(manifest.exports)).not.toContain("./batcher.test-support.ts");
  expect(manifest.exports["./batcher"]).toBe("./batcher.ts");
});
