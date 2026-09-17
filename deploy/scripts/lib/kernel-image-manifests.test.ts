// kernel-image-manifests.test.ts — the kernel image's dependency layer must
// copy EVERY workspace manifest, or no image can be built at all.
//
// WHY THIS TEST EXISTS. `deploy/images/kernel/Dockerfile` copies the workspace
// manifests on their own before `RUN bun install --frozen-lockfile`, so that a
// source-only edit does not re-run the install (and, behind it, the ~20-minute
// proving-key layer). That list is hand-maintained, and nothing else notices
// when it falls behind: adding a workspace member to the root `package.json`
// without adding it here makes bun resolve a DIFFERENT workspace set from the
// one `bun.lock` records, and `--frozen-lockfile` refuses the install with
//
//     error: lockfile had changes, but lockfile is frozen
//
// which fails the build long after the (cached, expensive) layers above it.
// That is not hypothetical: `packages/price-feed` joined the workspace with the
// 00005 price service (bc5c673) and never joined the COPY list, so every build
// of this image from that merge until 00007's P5 failed exactly this way — and
// it went unnoticed because the image is normally pulled from a cache rather
// than rebuilt. One string comparison here is cheaper than another 20-minute
// discovery.
//
// The check is deliberately structural (does a COPY line name the manifest?)
// rather than semantic: it does not care about ordering, alignment or comments.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `new URL(...).pathname`: this repository is cloned into
// a path containing a space in at least one working tree, and the raw pathname
// keeps it percent-encoded.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCKERFILE = join(REPO_ROOT, "deploy/images/kernel/Dockerfile");

/** Workspace members from the root package.json, `packages/*` globs expanded,
 *  keeping only those that actually carry a package.json. */
function workspaceManifests(): string[] {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const patterns = root.workspaces ?? [];
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(join(REPO_ROOT, parent))) {
        const dir = `${parent}/${entry}`;
        try {
          if (statSync(join(REPO_ROOT, dir, "package.json")).isFile()) dirs.add(dir);
        } catch {
          // a workspace glob may match a directory with no manifest — skip it
        }
      }
    } else {
      dirs.add(pattern);
    }
  }
  return [...dirs].sort().map((d) => `${d}/package.json`);
}

describe("kernel image dependency layer", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const manifests = workspaceManifests();

  test("the workspace really does have members to check", () => {
    expect(manifests.length).toBeGreaterThan(5);
    expect(manifests).toContain("packages/price-feed/package.json");
  });

  test.each(manifests)("Dockerfile COPYs %s", (manifest) => {
    // `COPY <src> <dest>` — the source path is what has to appear. Matching the
    // whole line would break on the column alignment the file uses.
    const copied = dockerfile
      .split("\n")
      .filter((line) => /^\s*COPY\s/.test(line))
      .some((line) => line.split(/\s+/).includes(manifest));
    expect(copied).toBe(true);
  });

  test("the root manifest and the lockfile are copied too", () => {
    expect(dockerfile).toMatch(/^COPY\s+package\.json\s+bun\.lock\s/m);
  });
});
