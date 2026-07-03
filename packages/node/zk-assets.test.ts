import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveAsset } from "./zk-assets.ts";

// The compiled contract's managed/keys + managed/zkir must exist for these to
// pass — the dev stack's compact-build step generates them (gitignored). Skip
// the file-existence asserts if they haven't been compiled yet.
const compiled = existsSync(
  resolveAsset("keys", "mint_shielded.prover") ?? "/nonexistent",
);

describe("resolveAsset", () => {
  test("blocks path traversal escaping the managed base", () => {
    expect(resolveAsset("keys", "../../../../../../etc/passwd")).toBeNull();
    expect(resolveAsset("zkir", "../managed/keys/mint_shielded.prover")).toBeNull();
  });

  test("returns null for a primitive family with no cache dir", () => {
    expect(resolveAsset("keys", "midnight/nonexistentfam/output.prover")).toBeNull();
  });

  test.if(compiled)("resolves contract circuit keys under managed/keys", () => {
    const p = resolveAsset("keys", "mint_shielded.prover");
    expect(p).toContain("/managed/keys/");
    expect(existsSync(p!)).toBe(true);
  });

  test.if(compiled)("resolves contract zkir under managed/zkir", () => {
    const z = resolveAsset("zkir", "mint_shielded.bzkir");
    expect(z).toContain("/managed/zkir/");
    expect(existsSync(z!)).toBe(true);
  });
});
