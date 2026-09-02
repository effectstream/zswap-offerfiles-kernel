// main.grand-b.ts carries its own copy of config.dev.ts's ConfigBuilder chain,
// because it must pin the NTP anchor from an env var instead of deriving it
// from its own (empty) database. That copy is what makes the grand-e2e
// determinism phase meaningful: instance B is only a valid replica of instance
// A if both nodes are configured identically.
//
// Nothing enforces that. Add a primitive to config.dev.ts, or change a
// delayMs, and grand-b keeps the old shape — at which point p7a compares two
// differently-configured nodes and a PASS stops meaning anything. That failure
// is invisible: the phase still runs, still diffs, still reports green.
//
// So compare the two at the source level. A runtime import is not an option —
// config.dev.ts queries the database at module load to derive its start time.
//
// If this test fails, port the config.dev.ts change into main.grand-b.ts. The
// deeper fix is to delete the duplication: export a `buildConfig(startTime)`
// from config.dev.ts and have both entrypoints call it.

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf-8");

/**
 * The ConfigBuilder chain as a list of comparable chunks, one per declaration.
 *
 * Formatting must not register as drift — the two files wrap and chain
 * differently (`).addPrimitive(` on one line vs split across two,
 * `.setNamespace(` wrapped vs inline). So: strip comments, collapse ALL
 * whitespace away, then split on declaration boundaries. What survives is
 * structure only, and a failure names the declaration that moved.
 */
function configChain(src: string): string[] {
  const start = src.indexOf("new ConfigBuilder()");
  if (start < 0) throw new Error("no ConfigBuilder chain found");
  const body = src
    .slice(start)
    .split(".build()")[0]!
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "")
    .replace(/,(?=[})])/g, ""); // trailing commas are style, not config
  return body
    .split(/(?=\.addPrimitive\()|(?=\.addParallel\()|(?=\.addNetwork\()|(?=\.addMain\()|(?=\.build[A-Z])/)
    .filter((c) => c.length > 0);
}

/** Differences that are the POINT of grand-b, not drift. Whitespace-free, to
 *  match the normalised chunks. */
const INTENDED = [
  // grand-b pins the anchor from GRAND_NTP_START_TIME; dev derives it from its DB.
  { dev: "startTime:launchStartTime??newDate().getTime()", grandB: "startTime:launchStartTime" },
  // dev names the protocol via a const; grand-b inlines the same literal.
  { dev: "name:mainSyncProtocolName", grandB: 'name:"mainNtp"' },
];

describe("main.grand-b.ts config must not drift from config.dev.ts", () => {
  const dev = configChain(read("./config.dev.ts"));
  const grandB = configChain(read("./main.grand-b.ts"));

  test("the intended differences are present and unchanged", () => {
    const devSrc = dev.join("");
    const grandBSrc = grandB.join("");
    for (const { dev: d, grandB: g } of INTENDED) {
      expect(devSrc.includes(d), `config.dev.ts should still contain: ${d}`).toBe(true);
      expect(grandBSrc.includes(g), `main.grand-b.ts should still contain: ${g}`).toBe(true);
    }
  });

  test("everything else is identical", () => {
    // Rewrite each intended difference to a shared marker, so only UNintended
    // divergence can fail the comparison.
    const canon = (chunks: string[]) =>
      chunks.map((c) => {
        let out = c;
        for (const { dev: d, grandB: g } of INTENDED) {
          out = out.split(d).join("<<INTENDED>>").split(g).join("<<INTENDED>>");
        }
        return out;
      });
    expect(canon(grandB)).toEqual(canon(dev));
  });

  test("both declare the same primitive set", () => {
    const primitives = (src: string) =>
      [...src.matchAll(/PrimitiveType[A-Za-z]+/g)].map((m) => m[0]).sort();
    // The determinism claim rests on this: a primitive present on one side only
    // means one node ingests a class of chain events the other never sees.
    expect(new Set(primitives(read("./main.grand-b.ts")))).toEqual(
      new Set(primitives(read("./config.dev.ts"))),
    );
  });

  test("the ZswapChainState.tryApply guard is on every entrypoint", () => {
    // Not cosmetic: without it a tryApply throw propagates and the STF diverges,
    // so an entrypoint missing it would process the same chain differently.
    for (const f of ["main.dev.ts", "main.preview.ts", "main.mainnet.ts", "main.grand-b.ts"]) {
      expect(read(`./${f}`), `${f} is missing the tryApply guard`).toContain(
        "ZswapChainState.prototype.tryApply",
      );
    }
  });
});
