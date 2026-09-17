import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePrivateJson } from "./solver-offerfiles-real-invalid-fixtures.ts";

const directories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zswap-invalid-fixtures-test-"));
  directories.add(directory);
  return directory;
}

async function assertNoTemporaryFiles(directory: string): Promise<void> {
  const entries = await readdir(directory);
  expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

describe("sealed invalid-fixture publication", () => {
  test("never replaces an existing authority artifact and removes its temporary inode", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "invalid-fixtures.json");
    await writePrivateJson(path, { winner: "first" });
    const original = await readFile(path);

    await expect(writePrivateJson(path, { winner: "second" })).rejects.toThrow(
      "could not publish sealed invalid-fixture artifact",
    );

    expect(await readFile(path)).toEqual(original);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await assertNoTemporaryFiles(directory);
  });

  test("concurrent writers produce exactly one sealed winner and clean both temporaries", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "invalid-fixtures.json");
    const results = await Promise.allSettled([
      writePrivateJson(path, { contender: "left" }),
      writePrivateJson(path, { contender: "right" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const published = JSON.parse(await readFile(path, "utf8")) as { contender?: unknown };
    expect(["left", "right"]).toContain(published.contender);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await assertNoTemporaryFiles(directory);
  });
});
