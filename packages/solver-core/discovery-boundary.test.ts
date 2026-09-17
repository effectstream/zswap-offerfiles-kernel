import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const packageRoots = [
  fileURLToPath(new URL("./", import.meta.url)),
  fileURLToPath(new URL("../solver/", import.meta.url)),
];

function productionTypescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionTypescriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

test("solver packages have no direct Celestia dependency, configuration, or RPC call", () => {
  for (const root of packageRoots) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(dependencyNames.filter((name) => /celestia/i.test(name))).toEqual([]);
  }

  const source = packageRoots
    .flatMap(productionTypescriptFiles)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const forbidden of [
    /\bCELESTIA_[A-Z0-9_]+\b/,
    /@effectstream\/celestia/,
    /\bblob\.(?:Submit|GetAll)\b/,
  ]) {
    expect(source).not.toMatch(forbidden);
  }
});
