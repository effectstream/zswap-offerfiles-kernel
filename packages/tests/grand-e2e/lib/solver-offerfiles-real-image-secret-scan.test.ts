import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, link as hardLink, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE =
  "oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e";
const CELESTIA_IMAGE =
  "ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const SCANNER = fileURLToPath(new URL("./solver-offerfiles-real-image-secret-scan.sh", import.meta.url));
const SECRET = "scanner-secret-0123456789abcdef";
const createdDirectories: string[] = [];

interface ScannerResult {
  code: number;
  stdout: string;
  stderr: string;
  containerName: string;
  containerTmp: string;
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zswap-e1-image-scan-test-"));
  createdDirectories.push(directory);
  return directory;
}

async function sealedPatterns(directory: string): Promise<string> {
  const path = join(directory, "patterns");
  await writeFile(path, `${SECRET}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

async function runScanner(input: {
  mount: string;
  roots: string[];
  patterns: string;
  timeout?: string;
  path?: string;
  extraMounts?: string[];
  role?: "test" | "app" | "celestia";
  image?: string;
  platform?: "linux/arm64" | "linux/amd64";
}): Promise<ScannerResult> {
  const containerName = `zswap-e1-image-scan-${randomUUID()}`;
  const containerTmp = join(dirname(input.patterns), `container-tmp-${randomUUID()}`);
  await mkdir(containerTmp, { mode: 0o700 });
  const role = input.role ?? "test";
  const args = [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--platform",
    input.platform ?? "linux/arm64",
    "--volume",
    `${SCANNER}:/run/e1-image-secret-scan:ro`,
    "--volume",
    `${input.patterns}:/run/e1-secret-patterns:ro`,
    "--volume",
    `${containerTmp}:/tmp:rw`,
    "--volume",
    `${input.mount}:/fixture-host:ro`,
    ...(input.extraMounts ?? []).flatMap((mount) => ["--volume", mount]),
    ...(input.path === undefined ? [] : ["--env", `PATH=${input.path}`]),
    input.image ?? IMAGE,
    "timeout",
    "--signal=TERM",
    "--kill-after=1s",
    input.timeout ?? "15s",
    "bash",
    "/run/e1-image-secret-scan",
    role,
    ...(role === "test" ? input.roots : []),
  ];
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, containerName, containerTmp };
}

async function expectClean(result: ScannerResult, role: string): Promise<void> {
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`image-secret-scan role=${role} `);
  expect(result.stdout).toEndWith(" status=clean\n");
  expect(await readdir(result.containerTmp)).toEqual([]);
}

async function expectRefused(result: ScannerResult): Promise<void> {
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain(SECRET);
  expect(result.stderr).not.toContain(SECRET);
  expect(await readdir(result.containerTmp)).toEqual([]);
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("real E1 physical image secret scanner", () => {
  test("retains only the authoritative bounded inventory and resolver artifacts", async () => {
    const source = await Bun.file(SCANNER).text();
    const allocatedArtifacts = [...source.matchAll(/readonly scan_[a-z_]+="\$scan_tmp\/([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(allocatedArtifacts).toEqual(["inventory.nul", "resolution.nul"]);
    expect(source).not.toContain("paths.nul");
    expect(source).not.toContain("targets.nul");
    expect(source).not.toMatch(/exec [45](?:<|>)/);
    expect(source).not.toContain("path-bytes");
    expect(source).not.toContain("link-target-bytes");
    expect(source).toContain("scan_require_clean_grep inventory-bytes");
    expect(source).toContain("scan_require_clean_grep file-bytes");
  });

  test("accepts clean physical roots, internal links, and both production role root sets", async () => {
    const directory = await fixtureDirectory();
    const patterns = await sealedPatterns(directory);
    const fixture = join(directory, "fixture");
    await mkdir(join(fixture, "actual", "nested"), { recursive: true });
    await writeFile(join(fixture, "actual", "nested", "clean.txt"), "clean\0bytes");
    await symlink("actual", join(fixture, "internal-directory"));
    await symlink("actual/nested/clean.txt", join(fixture, "internal-file"));
    for (const [index, name] of ["line\nbreak", "tab\tname", "control-\x01", "back\\slash", "-leading", "utf8-λ"].entries()) {
      await writeFile(join(fixture, "actual", "nested", name), "clean");
      await symlink(`actual/nested/${name}`, join(fixture, `unusual-link-${index}`));
    }
    await expectClean(
      await runScanner({ mount: directory, roots: ["/fixture-host/fixture"], patterns }),
      "test",
    );

    for (const path of ["work", "opt", "local", "compact", "bun"]) {
      await mkdir(join(directory, "app", path), { recursive: true });
      await writeFile(join(directory, "app", path, "clean"), path);
    }
    await expectClean(
      await runScanner({
        mount: directory,
        roots: [],
        patterns,
        role: "app",
        extraMounts: [
          `${join(directory, "app", "work")}:/work:ro`,
          `${join(directory, "app", "opt")}:/opt:ro`,
          `${join(directory, "app", "local")}:/root/.local:ro`,
          `${join(directory, "app", "compact")}:/root/.compact:ro`,
          `${join(directory, "app", "bun")}:/root/.bun:ro`,
        ],
      }),
      "app",
    );
    await expectClean(
      await runScanner({
        mount: directory,
        roots: [],
        patterns,
        role: "celestia",
        image: CELESTIA_IMAGE,
        platform: "linux/amd64",
        extraMounts: [`${join(directory, "app", "opt")}:/opt:ro`],
      }),
      "celestia",
    );
  }, 60_000);

  test("detects text, NUL-late, buffer-boundary, pathname, and link-payload secrets", async () => {
    const vectors: Array<(root: string) => Promise<void>> = [
      async (root) => writeFile(join(root, "text"), `prefix-${SECRET}-suffix`),
      async (root) => {
        const bytes = Buffer.alloc(128 * 1024, 0);
        bytes.write(SECRET, 96 * 1024);
        await writeFile(join(root, "nul-late"), bytes);
      },
      async (root) => {
        const bytes = Buffer.alloc(64 * 1024, 0x61);
        bytes.write(SECRET, 32 * 1024 - 7);
        await writeFile(join(root, "buffer-boundary"), bytes);
      },
      async (root) => writeFile(join(root, `path-${SECRET}`), "clean"),
      async (root) => {
        await writeFile(join(root, `target-${SECRET}`), "clean");
        await symlink(`target-${SECRET}`, join(root, "link"));
      },
      async (root) => {
        await writeFile(join(root, "secret-target"), SECRET);
        await symlink("secret-target", join(root, "internal-secret-link"));
      },
    ];
    for (const [index, createVector] of vectors.entries()) {
      const directory = await fixtureDirectory();
      const patterns = await sealedPatterns(directory);
      const root = join(directory, `vector-${index}`);
      await mkdir(root);
      await createVector(root);
      await expectRefused(await runScanner({ mount: directory, roots: [`/fixture-host/vector-${index}`], patterns }));
    }
  }, 90_000);

  test("preserves trailing-newline root and symlink-target bytes during canonical resolution", async () => {
    const directory = await fixtureDirectory();
    const patterns = await sealedPatterns(directory);
    const rootName = "root-ending-newline\n";
    const targetName = "target-ending-newline\n";
    const root = join(directory, rootName);
    await mkdir(root);
    await writeFile(join(root, targetName), "clean");
    await symlink(targetName, join(root, "link"));
    const result = await runScanner({
      mount: directory,
      roots: [`/fixture-host/${rootName}`],
      patterns,
    });
    await expectClean(result, "test");
    expect(result.stdout).toContain("paths=3 links=1");
  }, 30_000);

  test("rejects escaping, broken, cyclic, special, unreadable, symlink-root, and missing roots", async () => {
    const cases: Array<(directory: string, root: string) => Promise<string>> = [
      async (_directory, root) => {
        await symlink("/etc/passwd", join(root, "escape"));
        return root;
      },
      async (_directory, root) => {
        await symlink("missing", join(root, "broken"));
        return root;
      },
      async (_directory, root) => {
        await symlink("cycle-b", join(root, "cycle-a"));
        await symlink("cycle-a", join(root, "cycle-b"));
        return root;
      },
      async (_directory, root) => {
        const fifo = join(root, `fifo-${SECRET}`);
        const child = Bun.spawn(["mkfifo", fifo]);
        expect(await child.exited).toBe(0);
        return root;
      },
      async (_directory, root) => {
        const unreadable = join(root, "unreadable");
        await writeFile(unreadable, "clean");
        await chmod(unreadable, 0o000);
        return root;
      },
      async (directory, root) => {
        await writeFile(join(root, "clean"), "clean");
        await symlink("root", join(directory, "root-link"));
        return join(directory, "root-link");
      },
      async (directory) => join(directory, "missing-root"),
    ];
    for (const createCase of cases) {
      const directory = await fixtureDirectory();
      const patterns = await sealedPatterns(directory);
      const root = join(directory, "root");
      await mkdir(root);
      const selectedRoot = await createCase(directory, root);
      await expectRefused(
        await runScanner({
          mount: directory,
          roots: [`/fixture-host/${selectedRoot.slice(directory.length + 1)}`],
          patterns,
        }),
      );
    }
  }, 90_000);

  test("handles a large physical inventory and internal-link fanout without process amplification", async () => {
    const directory = await fixtureDirectory();
    const patterns = await sealedPatterns(directory);
    const root = join(directory, "fanout");
    await mkdir(join(root, "actual"), { recursive: true });
    const clean = join(root, "actual", "clean");
    await writeFile(clean, "clean");
    for (let offset = 0; offset < 15_000; offset += 500) {
      await Promise.all(
        Array.from({ length: 500 }, (_, index) =>
          hardLink(clean, join(root, `physical-${(offset + index).toString().padStart(5, "0")}`)),
        ),
      );
    }
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) => symlink("actual", join(root, `link-${index.toString().padStart(4, "0")}`))),
    );
    const startedAt = performance.now();
    const result = await runScanner({ mount: directory, roots: ["/fixture-host/fanout"], patterns, timeout: "25s" });
    const elapsedMs = performance.now() - startedAt;
    await expectClean(result, "test");
    expect(result.stdout).toContain("paths=16003 links=1000");
    expect(elapsedMs).toBeLessThan(25_000);
  }, 60_000);

  test("rejects empty, truncated, and malformed NUL inventories", async () => {
    const cases = [
      "#!/bin/sh\nexit 0\n",
      String.raw`#!/bin/sh
printf 'f'
`,
      String.raw`#!/bin/sh
printf 'f\000644\000/fixture-host/root/clean\000'
`,
      String.raw`#!/bin/sh
printf 'x\000755\000/fixture-host/root/inventory-${SECRET}\000\000'
`,
      String.raw`#!/bin/sh
printf 'f\000644\000/fixture-host/root/clean\000unexpected\000'
`,
      String.raw`#!/bin/sh
printf 'l\000777\000/fixture-host/root/link\000\000'
`,
      String.raw`#!/bin/sh
printf 'f\000644\000/fixture-host/root-prefix-collision\000\000'
`,
    ];
    for (const findBody of cases) {
      const directory = await fixtureDirectory();
      const patterns = await sealedPatterns(directory);
      await mkdir(join(directory, "root"));
      await writeFile(join(directory, "root", "clean"), "clean");
      await symlink("clean", join(directory, "root", "link"));
      await mkdir(join(directory, "bin"));
      await writeFile(join(directory, "bin", "find"), findBody, { mode: 0o755 });
      const result = await runScanner({
        mount: directory,
        roots: ["/fixture-host/root"],
        patterns,
        path: "/fixture-host/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      });
      await expectRefused(result);
      expect(result.stderr).toContain("image-secret-scan: fail (");
      expect(result.stderr).not.toContain(`inventory-${SECRET}`);
    }
  }, 45_000);

  test("rejects empty, truncated, extra, and trailing canonical-resolution records", async () => {
    const cases = [
      String.raw`#!/bin/sh
printf '/fixture-host/root'
`,
      String.raw`#!/bin/sh
printf '\000'
`,
      String.raw`#!/bin/sh
printf '/fixture-host/root\000/fixture-host/root\000'
`,
      String.raw`#!/bin/sh
printf '/fixture-host/root\000trailing'
`,
      String.raw`#!/bin/sh
case "$4" in
  /fixture-host/root) printf '/fixture-host/root\000' ;;
  *) printf '/fixture-host/root/target' ;;
esac
`,
    ];
    for (const readlinkBody of cases) {
      const directory = await fixtureDirectory();
      const patterns = await sealedPatterns(directory);
      await mkdir(join(directory, "root"));
      await writeFile(join(directory, "root", "target"), "clean");
      await symlink("target", join(directory, "root", "link"));
      await mkdir(join(directory, "bin"));
      await writeFile(join(directory, "bin", "readlink"), readlinkBody, { mode: 0o755 });
      const result = await runScanner({
        mount: directory,
        roots: ["/fixture-host/root"],
        patterns,
        path: "/fixture-host/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      });
      await expectRefused(result);
      expect(result.stderr).toContain("image-secret-scan: fail (");
    }
  }, 45_000);

  test("fails closed on traversal and grep errors and times out with zero residue", async () => {
    for (const [tool, body] of [
      ["find", "#!/bin/sh\nexit 9\n"],
      ["grep", "#!/bin/sh\nexit 2\n"],
    ] as const) {
      const directory = await fixtureDirectory();
      const patterns = await sealedPatterns(directory);
      await mkdir(join(directory, "root"));
      await writeFile(join(directory, "root", "clean"), "clean");
      await mkdir(join(directory, "bin"));
      await writeFile(join(directory, "bin", tool), body, { mode: 0o755 });
      await expectRefused(
        await runScanner({
          mount: directory,
          roots: ["/fixture-host/root"],
          patterns,
          path: "/fixture-host/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        }),
      );
    }

    const directory = await fixtureDirectory();
    const patterns = await sealedPatterns(directory);
    await mkdir(join(directory, "root"));
    await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "bin", "find"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const result = await runScanner({
      mount: directory,
      roots: ["/fixture-host/root"],
      patterns,
      path: "/fixture-host/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      timeout: "1s",
    });
    expect([124, 137]).toContain(result.code);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(await readdir(result.containerTmp)).toEqual([]);
    const residue = Bun.spawn([
      "docker",
      "ps",
      "-aq",
      "--filter",
      `name=^/${result.containerName}$`,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await residue.exited).toBe(0);
    expect((await new Response(residue.stdout).text()).trim()).toBe("");
  }, 45_000);
});
