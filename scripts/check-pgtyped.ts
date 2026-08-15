#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const sqlPath = fileURLToPath(
  new URL("../packages/database/sql/queries.sql", import.meta.url),
);
const appPath = fileURLToPath(
  new URL("../packages/database/sql/queries.app.ts", import.meta.url),
);
const generatedPath = fileURLToPath(
  new URL("../packages/database/sql/queries.queries.ts", import.meta.url),
);

function fail(message: string): never {
  console.error(`[pgtyped-guard] ${message}`);
  process.exit(1);
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) duplicate.add(name);
    seen.add(key);
  }
  return [...duplicate].sort();
}

function assertQueryNamesAreUnique(): void {
  const sql = readFileSync(sqlPath, "utf8");
  const app = readFileSync(appPath, "utf8");
  const generatedNames = [...sql.matchAll(/\/\*\s*@name\s+([A-Za-z_$][\w$]*)\s*\*\//g)]
    .map((match) => match[1]!);
  const handwrittenNames = [...app.matchAll(
    /^export const\s+([A-Za-z_$][\w$]*)\s*=\s*prepared\b/gm,
  )].map((match) => match[1]!);

  const duplicateGenerated = duplicates(generatedNames);
  const duplicateHandwritten = duplicates(handwrittenNames);
  const handwrittenByKey = new Map(
    handwrittenNames.map((name) => [name.toLowerCase(), name]),
  );
  const crossDefined = generatedNames
    .filter((name) => handwrittenByKey.has(name.toLowerCase()))
    .map((name) => `${name} / ${handwrittenByKey.get(name.toLowerCase())}`)
    .sort();

  const errors: string[] = [];
  if (duplicateGenerated.length > 0) {
    errors.push(`duplicate @name entries in queries.sql: ${duplicateGenerated.join(", ")}`);
  }
  if (duplicateHandwritten.length > 0) {
    errors.push(`duplicate prepared exports in queries.app.ts: ${duplicateHandwritten.join(", ")}`);
  }
  if (crossDefined.length > 0) {
    errors.push(
      `query names defined in both queries.sql and queries.app.ts: ${crossDefined.join(", ")}`,
    );
  }
  if (errors.length > 0) fail(errors.join("\n"));
}

assertQueryNamesAreUnique();

if (!existsSync(generatedPath)) {
  fail("queries.queries.ts is missing before regeneration");
}

const previousGenerated = readFileSync(generatedPath);
rmSync(generatedPath);

const generation = spawnSync("bun", ["run", "build:pgtypes"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
});
process.stdout.write(generation.stdout ?? "");
process.stderr.write(generation.stderr ?? "");

const output = `${generation.stdout ?? ""}\n${generation.stderr ?? ""}`;
const skipped = /\bSkipped\b/i.test(output);
const regenerated = existsSync(generatedPath);

if (generation.status !== 0 || skipped || !regenerated) {
  // A parse failure can exit 0 and leave no output. Restore the developer's
  // checkout after proving the guard failed; CI would discard it either way.
  if (!regenerated) writeFileSync(generatedPath, previousGenerated);
  const reasons = [
    generation.status !== 0 ? `generator exited ${generation.status}` : "",
    skipped ? "generator logged Skipped" : "",
    !regenerated ? "generated file was not recreated" : "",
  ].filter(Boolean);
  fail(reasons.join("; "));
}

const diff = spawnSync(
  "git",
  ["diff", "--exit-code", "--", "packages/database/sql/queries.queries.ts"],
  { cwd: repoRoot, encoding: "utf8" },
);
process.stdout.write(diff.stdout ?? "");
process.stderr.write(diff.stderr ?? "");
if (diff.status !== 0) {
  fail("regeneration changed queries.queries.ts; commit the generated output");
}

console.log("[pgtyped-guard] generated output is current and query names are unique");
