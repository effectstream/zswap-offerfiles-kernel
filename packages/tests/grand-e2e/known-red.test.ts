// The expected-failure mechanism is what the whole base-test PR rests on: if
// check()'s KNOWN_RED branch is wrong, every registered defect is silently
// mishandled — either masking a real failure or blocking the merge for a
// defect we deliberately chose not to fix yet.
//
// So test the mechanism itself, against REAL registry entries (not a fixture
// registry): a key that drifts out of known-red.ts must break this test too.

import { describe, expect, test } from "bun:test";
import { KNOWN_RED } from "./known-red.ts";
import { allResults, beginPhase, check, failures, knownReds, staleReds } from "./lib/util.ts";

/** Split a registry key back into the phase and name check() recombines. */
function splitKey(key: string): { phase: string; name: string } {
  const i = key.indexOf(" ▸ ");
  return { phase: key.slice(0, i), name: key.slice(i + 3) };
}

const REGISTERED = Object.keys(KNOWN_RED);

describe("KNOWN_RED expected-failure mechanism", () => {
  test("the registry is non-empty and every entry names its fix PR", () => {
    expect(REGISTERED.length).toBeGreaterThan(0);
    for (const [key, red] of Object.entries(KNOWN_RED)) {
      expect(key, `${key} must be a "phase ▸ name" key`).toContain(" ▸ ");
      expect(red.pr, `${red.id} must name the PR that deletes it`).toMatch(/^PR-[A-Z]$/);
      expect(red.why.length, `${red.id} must say WHY it fails`).toBeGreaterThan(10);
    }
    // Ids unique — they are quoted in fix-PR descriptions.
    const ids = Object.values(KNOWN_RED).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a registered check that FAILS is recorded green and does not gate", async () => {
    const { phase, name } = splitKey(REGISTERED[0]!);
    const failsBefore = failures().length;
    beginPhase(phase);

    const returned = await check(name, () => false, "observed detail");

    // The RAW verdict is returned, so callers branching on it are unaffected.
    expect(returned).toBe(false);
    expect(failures().length).toBe(failsBefore); // did not gate the run
    const rec = allResults().at(-1)!;
    expect(rec.ok).toBe(true);
    expect(rec.red?.id).toBe(KNOWN_RED[REGISTERED[0]!]!.id);
    expect(rec.xpass).toBeUndefined();
    // The observed failure detail survives into the scorecard, so the punch
    // list says what actually happened, not just that it was expected.
    expect(rec.detail).toContain("observed detail");
    expect(knownReds().at(-1)).toBe(rec);
  });

  test("a registered check that PASSES is an XPASS and DOES gate", async () => {
    const { phase, name } = splitKey(REGISTERED[0]!);
    const failsBefore = failures().length;
    beginPhase(phase);

    const returned = await check(name, () => true);

    expect(returned).toBe(true);
    // This is the entire point: nothing else forces a fix PR to delete its
    // entry, so a passing red must break the build until it does.
    expect(failures().length).toBe(failsBefore + 1);
    const rec = allResults().at(-1)!;
    expect(rec.ok).toBe(false);
    expect(rec.xpass).toBe(true);
    expect(rec.detail).toContain("delete the KNOWN_RED entry");
  });

  test("an UNregistered failing check still fails normally", async () => {
    const failsBefore = failures().length;
    beginPhase("p-unit");

    const returned = await check("this name is in no registry", () => false);

    expect(returned).toBe(false);
    expect(failures().length).toBe(failsBefore + 1);
    expect(allResults().at(-1)!.red).toBeUndefined();
  });

  test("a throwing registered check is a red, not an unhandled failure", async () => {
    const { phase, name } = splitKey(REGISTERED[0]!);
    const failsBefore = failures().length;
    beginPhase(phase);

    await check(name, () => {
      throw new Error("boom");
    });

    expect(failures().length).toBe(failsBefore);
    expect(allResults().at(-1)!.detail).toContain("boom");
  });

  test("registry keys that never ran are reported as stale, not silently dropped", () => {
    // Only REGISTERED[0] has been exercised above, so everything else is stale
    // from this test file's point of view — proving the accounting works.
    const stale = staleReds().map((r) => r.id);
    expect(stale).not.toContain(KNOWN_RED[REGISTERED[0]!]!.id);
    expect(stale.length).toBe(REGISTERED.length - 1);
  });
});
