// deploy/PRODUCTION.md is checked against this tree like a link checker: every
// path, `bun` command target, package script, link, anchor and env name it
// names must exist. The fixture cases prove that the checker reports each
// kind of missing reference.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkProductionGuide, headingSlug } from "./production-guide.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/** A small tree: root package.json with one script, one workspace package,
 *  one source file reading two variables, one README with a heading. */
function fixtureTree(guide: string): { root: string; guidePath: string } {
  const root = mkdtempSync(join(tmpdir(), "production-guide-"));
  fixtures.push(root);
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "packages", "node"), { recursive: true });
  mkdirSync(join(root, "packages", "feed"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "start:public": "x" } }));
  writeFileSync(join(root, "packages", "feed", "package.json"), JSON.stringify({ name: "@x/feed", scripts: { once: "y" } }));
  writeFileSync(
    join(root, "packages", "node", "main.public.ts"),
    'const a = process.env["KNOWN_VAR"]; const b = process.env["SYNC_HEALTH_LIMIT"]; const c = process.env["PGLITE"];\n',
  );
  writeFileSync(join(root, "README.md"), "# Title\n\n## Funding runbook\n\ntext\n");
  const guidePath = join(root, "deploy", "PRODUCTION.md");
  writeFileSync(guidePath, guide);
  return { root, guidePath };
}

describe("deploy/PRODUCTION.md", () => {
  test("every path, command target, package script, link, anchor and env name it names exists in this tree", () => {
    const { references, missing } = checkProductionGuide(join(REPO, "deploy", "PRODUCTION.md"), REPO);
    expect(missing).toEqual([]);
    const count = (kind: string) => references.filter((r) => r.kind === kind).length;
    // Not vacuous: the guide names its entries, its env contract and its sections.
    expect(count("path")).toBeGreaterThanOrEqual(10);
    expect(count("env")).toBeGreaterThanOrEqual(30);
    expect(count("anchor")).toBeGreaterThanOrEqual(10);
    expect(count("link")).toBeGreaterThanOrEqual(3);
    for (const entry of [
      "packages/node/main.public.ts",
      "packages/batcher/batcher.public.ts",
      "packages/database/import-token-registry.ts",
      "deploy/scripts/provision-solver-fees.ts",
    ]) {
      expect(references.some((r) => r.kind === "path" && r.value === entry), entry).toBe(true);
    }
  });
});

describe("the checker reports what is missing", () => {
  test("a guide whose references all exist passes", () => {
    const { root, guidePath } = fixtureTree([
      "# Guide",
      "",
      "Run `packages/node/main.public.ts` with `KNOWN_VAR`, `PGLITE` and the `SYNC_HEALTH_*` knobs.",
      "See [the runbook](../README.md#funding-runbook) and [above](#guide).",
      "```bash",
      "/usr/local/bin/bun run packages/node/main.public.ts",
      "bun run start:public",
      "bun run --filter @x/feed once",
      "bun install --frozen-lockfile",
      "```",
    ].join("\n"));
    expect(checkProductionGuide(guidePath, root).missing).toEqual([]);
  });

  test("each kind of missing reference is named with its line", () => {
    const { root, guidePath } = fixtureTree([
      "# Guide",
      "Run `packages/node/gone.ts` and set `UNKNOWN_VAR` and `NOPE_*`.",
      "See [the runbook](../README.md#no-such-heading) and [x](../MISSING.md).",
      "```bash",
      "bun run packages/batcher/gone.public.ts",
      "bun run start:private",
      "bun run --filter @x/feed twice",
      "bun run --filter @x/none once",
      "```",
    ].join("\n"));
    const missing = checkProductionGuide(guidePath, root).missing.map((m) => `${m.kind} ${m.value} @${m.line}`);
    expect(missing.sort()).toEqual([
      "anchor README.md#no-such-heading @3",
      "env NOPE_* @2",
      "env UNKNOWN_VAR @2",
      "link MISSING.md @3",
      "package-script @x/feed twice @7",
      "package-script @x/none once @8",
      "package-script start:private @6",
      "path packages/batcher/gone.public.ts @5",
      "path packages/node/gone.ts @2",
    ]);
  });

  test("host paths, URLs and API routes are not repository paths", () => {
    const { root, guidePath } = fixtureTree([
      "# Guide",
      "Put it in `/etc/zswap-kernel/preprod.env`, poll `/v1/health`, read `https://example.org/a/b`.",
    ].join("\n"));
    const { references, missing } = checkProductionGuide(guidePath, root);
    expect(references.filter((r) => r.kind === "path")).toEqual([]);
    expect(missing).toEqual([]);
  });

  test("a renamed file the guide names is caught", () => {
    const { root, guidePath } = fixtureTree("# Guide\n\n`packages/node/main.public.ts`\n");
    expect(checkProductionGuide(guidePath, root).missing).toEqual([]);
    rmSync(join(root, "packages", "node", "main.public.ts"));
    writeFileSync(join(root, "packages", "node", "main.ts"), 'process.env["KNOWN_VAR"];\n');
    expect(checkProductionGuide(guidePath, root).missing.map((m) => m.value)).toEqual(["packages/node/main.public.ts"]);
  });

  test("anchors follow GitHub's heading slugs", () => {
    expect(headingSlug("4. Postgres with pg_ivm")).toBe("4-postgres-with-pg_ivm");
    expect(headingSlug("`GET /v1/health`")).toBe("get-v1health");
    expect(headingSlug("Real funds: NO-GO")).toBe("real-funds-no-go");
  });
});
