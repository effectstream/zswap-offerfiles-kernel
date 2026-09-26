// kernel-entrypoints.test.ts — the kernel image's entrypoint scripts, RUN
// (00050 FR-004, testing catalogue T1/T2/T3).
//
// The scripts are executed for real with bash, in a scratch copy where
// `/usr/local/bin/` points at a temp directory and `bun` on PATH is a stub
// that records every invocation: `bun -e …` (the wait-for.sh readiness probes)
// succeeds at once, the stagenet preflights exit with $FAKE_PREFLIGHT_EXIT,
// the registry import with $FAKE_IMPORT_EXIT, and the final `exec bun run
// <entry>` is recorded as EXEC. So each case proves, without a chain:
//   * which entry MIDNIGHT_NETWORK_ID selects, and the exact argv it execs;
//   * that `undeployed` still runs main.dev.ts / batcher.dev.ts after the same
//     readiness waits and prints nothing new (T3);
//   * that the stagenet preflight runs BEFORE the waits and its refusal stops
//     the script (T1/T2);
//   * that an unsupported network, a missing variable, or a missing preview
//     batcher seed exits 78 naming it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGE_DIR = join(REPO_ROOT, "deploy/images/kernel");

let scratch = "";
let binDir = "";
let fakeRepo = "";

const FAKE_BUN = `#!/usr/bin/env bash
# A readiness probe's -e body is multi-line JavaScript: log only its target.
if [ "$1" = "-e" ]; then echo "BUN -e <probe> \${@: -1}" >> "$FAKE_BUN_LOG"; exit 0; fi
echo "BUN $*" >> "$FAKE_BUN_LOG"
if [ "$1" = "run" ]; then
  case "$2" in
    packages/node/stagenet-profile.ts) exit "\${FAKE_PREFLIGHT_EXIT:-0}" ;;
    packages/database/import-token-registry.ts) exit "\${FAKE_IMPORT_EXIT:-0}" ;;
  esac
  for arg in "$@"; do
    if [ "$arg" = "--check" ]; then exit "\${FAKE_PREFLIGHT_EXIT:-0}"; fi
  done
  echo "EXEC $*" >> "$FAKE_BUN_LOG"
  exit 0
fi
exit 0
`;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "k00050-entrypoints-"));
  binDir = join(scratch, "usr-local-bin");
  fakeRepo = join(scratch, "app");
  const pathDir = join(scratch, "path");
  for (const d of [binDir, fakeRepo, pathDir]) mkdirSync(d, { recursive: true });
  for (const file of readdirSync(IMAGE_DIR)) {
    if (!file.endsWith(".sh")) continue;
    const src = readFileSync(join(IMAGE_DIR, file), "utf8").replaceAll("/usr/local/bin/", `${binDir}/`);
    writeFileSync(join(binDir, file), src);
    chmodSync(join(binDir, file), 0o755);
  }
  writeFileSync(join(pathDir, "bun"), FAKE_BUN);
  chmodSync(join(pathDir, "bun"), 0o755);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  stderr: string;
  calls: string[];
}

function runEntrypoint(script: string, vars: Record<string, string>): Run {
  const log = join(scratch, `calls-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, "");
  const result = Bun.spawnSync(["bash", join(binDir, script)], {
    cwd: fakeRepo,
    env: {
      PATH: `${join(scratch, "path")}:/usr/bin:/bin`,
      HOME: scratch,
      REPO_ROOT: fakeRepo,
      FAKE_BUN_LOG: log,
      ...vars,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const calls = readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
  return { code: result.exitCode ?? -1, stderr: result.stderr.toString(), calls };
}

const kernelEnv = (network: string): Record<string, string> => ({
  MIDNIGHT_NETWORK_ID: network,
  MIDNIGHT_NODE_HTTP: "http://midnight-node:9944",
  MIDNIGHT_INDEXER_HTTP: "http://indexer:8088/api/v4/graphql",
  MIDNIGHT_INDEXER_WS: "ws://indexer:8088/api/v4/graphql/ws",
  MIDNIGHT_PROOF_SERVER_URL: "http://proof-server:6300",
  CELESTIA_RPC_URL: "http://celestia:26658",
  DB_HOST: "pglite",
  DB_PORT: "5432",
});

const batcherEnv = (network: string): Record<string, string> => {
  const { DB_HOST: _h, DB_PORT: _p, ...rest } = kernelEnv(network);
  return { ...rest, BATCHER_STORAGE_DIR: join(scratch, `batcher-${network}`) };
};

const probes = (run: Run) => run.calls.filter((c) => c.startsWith("BUN -e ")).length;
const execs = (run: Run) => run.calls.filter((c) => c.startsWith("EXEC "));

describe("entrypoint-kernel.sh selects the node entry from MIDNIGHT_NETWORK_ID", () => {
  test("undeployed: exactly `bun run packages/node/main.dev.ts` after the five waits, nothing new logged (T3)", () => {
    const run = runEntrypoint("entrypoint-kernel.sh", kernelEnv("undeployed"));
    expect(run.code, run.stderr).toBe(0);
    expect(probes(run)).toBe(5);
    expect(execs(run)).toEqual(["EXEC run packages/node/main.dev.ts"]);
    expect(run.calls.at(-1)).toBe("EXEC run packages/node/main.dev.ts");
    expect(run.stderr).not.toContain("selected");
    expect(run.stderr).toContain("starting kernel on :9999 (network undeployed)");
  });

  test("preview: main.preview.ts", () => {
    const run = runEntrypoint("entrypoint-kernel.sh", kernelEnv("preview"));
    expect(run.code, run.stderr).toBe(0);
    expect(execs(run)).toEqual(["EXEC run packages/node/main.preview.ts"]);
    expect(run.stderr).toContain("selected packages/node/main.preview.ts for network preview");
  });

  test("stagenet: the config preflight runs BEFORE the waits, then main.stagenet.ts (T1)", () => {
    const run = runEntrypoint("entrypoint-kernel.sh", kernelEnv("stagenet"));
    expect(run.code, run.stderr).toBe(0);
    expect(run.calls[0]).toBe("BUN run packages/node/stagenet-profile.ts");
    expect(probes(run)).toBe(5);
    expect(execs(run)).toEqual(["EXEC run packages/node/main.stagenet.ts"]);
    expect(run.stderr).toContain("selected packages/node/main.stagenet.ts for network stagenet");
  });

  test("stagenet: a preflight refusal (exit 78) stops before any wait or exec (T2)", () => {
    const run = runEntrypoint("entrypoint-kernel.sh", { ...kernelEnv("stagenet"), FAKE_PREFLIGHT_EXIT: "78" });
    expect(run.code).toBe(78);
    expect(probes(run)).toBe(0);
    expect(execs(run)).toEqual([]);
  });

  test.each(["mainnet", "preprod", "devnet"])("%s is refused with exit 78, naming the supported set", (network) => {
    const run = runEntrypoint("entrypoint-kernel.sh", kernelEnv(network));
    expect(run.code).toBe(78);
    expect(run.stderr).toContain(`no kernel entry for MIDNIGHT_NETWORK_ID='${network}' (supported: undeployed, preview, stagenet)`);
    expect(run.calls).toEqual([]);
  });

  test("a missing required variable exits 78 naming it (unchanged)", () => {
    const { DB_HOST: _omit, ...vars } = kernelEnv("stagenet");
    const run = runEntrypoint("entrypoint-kernel.sh", vars);
    expect(run.code).toBe(78);
    expect(run.stderr).toContain("missing required environment: DB_HOST");
  });
});

describe("entrypoint-batcher.sh selects the batcher entry from MIDNIGHT_NETWORK_ID", () => {
  test("undeployed: exactly `bun run packages/batcher/batcher.dev.ts` after the four waits (T3)", () => {
    const run = runEntrypoint("entrypoint-batcher.sh", batcherEnv("undeployed"));
    expect(run.code, run.stderr).toBe(0);
    expect(probes(run)).toBe(4);
    expect(execs(run)).toEqual(["EXEC run packages/batcher/batcher.dev.ts"]);
    expect(run.stderr).not.toContain("selected");
  });

  test("preview requires BATCHER_WALLET_SEED at the shell (no public-seed fallback), then batcher.preview.ts", () => {
    const refused = runEntrypoint("entrypoint-batcher.sh", batcherEnv("preview"));
    expect(refused.code).toBe(78);
    expect(refused.stderr).toContain("missing required environment: BATCHER_WALLET_SEED");
    expect(refused.calls).toEqual([]);
    const run = runEntrypoint("entrypoint-batcher.sh", { ...batcherEnv("preview"), BATCHER_WALLET_SEED: "7f".repeat(32) });
    expect(run.code, run.stderr).toBe(0);
    expect(execs(run)).toEqual(["EXEC run packages/batcher/batcher.preview.ts"]);
  });

  test("stagenet: `batcher.stagenet.ts --check` BEFORE the waits, then batcher.stagenet.ts (T1)", () => {
    const run = runEntrypoint("entrypoint-batcher.sh", batcherEnv("stagenet"));
    expect(run.code, run.stderr).toBe(0);
    expect(run.calls[0]).toBe("BUN run packages/batcher/batcher.stagenet.ts --check");
    expect(probes(run)).toBe(4);
    expect(execs(run)).toEqual(["EXEC run packages/batcher/batcher.stagenet.ts"]);
  });

  test("stagenet: a --check refusal (exit 78) stops before any wait or exec (T2)", () => {
    const run = runEntrypoint("entrypoint-batcher.sh", { ...batcherEnv("stagenet"), FAKE_PREFLIGHT_EXIT: "78" });
    expect(run.code).toBe(78);
    expect(probes(run)).toBe(0);
    expect(execs(run)).toEqual([]);
  });

  test("an unsupported network exits 78", () => {
    const run = runEntrypoint("entrypoint-batcher.sh", batcherEnv("mainnet"));
    expect(run.code).toBe(78);
    expect(run.stderr).toContain("no batcher entry for MIDNIGHT_NETWORK_ID='mainnet'");
  });
});

describe("entrypoint-token-registry.sh — the one-shot import (FR-004)", () => {
  const registryEnv = (network: string): Record<string, string> => ({
    TOKEN_REGISTRY_NETWORK: network,
    DB_HOST: "postgres",
    DB_PORT: "5432",
    TOKEN_REGISTRY_RETRY_DELAY_S: "0",
  });

  test("runs the import with --required and exits 0 when it applies", () => {
    const run = runEntrypoint("entrypoint-token-registry.sh", registryEnv("stagenet"));
    expect(run.code, run.stderr).toBe(0);
    expect(run.calls).toContain("BUN run packages/database/import-token-registry.ts --required");
    expect(run.stderr).toContain("token registry import applied");
  });

  test("a failing import is retried, then fails LOUDLY (exit 1) — never a silent skip", () => {
    const run = runEntrypoint("entrypoint-token-registry.sh", {
      ...registryEnv("stagenet"),
      FAKE_IMPORT_EXIT: "1",
      TOKEN_REGISTRY_ATTEMPTS: "3",
    });
    expect(run.code).toBe(1);
    expect(run.calls.filter((c) => c.includes("import-token-registry.ts --required"))).toHaveLength(3);
    expect(run.stderr).toContain("token registry import FAILED after 3 attempt(s)");
  });

  test("waits for the kernel API when ZSWAP_API is set", () => {
    const run = runEntrypoint("entrypoint-token-registry.sh", { ...registryEnv("preview"), ZSWAP_API: "http://kernel:9999" });
    expect(run.code, run.stderr).toBe(0);
    expect(run.calls.some((c) => c.startsWith("BUN -e ") && c.endsWith("http://kernel:9999/v1/health"))).toBe(true);
  });

  test.each([
    [{}, "missing required environment: TOKEN_REGISTRY_NETWORK"],
    [{ TOKEN_REGISTRY_NETWORK: "undeployed" }, "TOKEN_REGISTRY_NETWORK must be preview, preprod or stagenet"],
    [{ TOKEN_REGISTRY_ATTEMPTS: "0" }, "TOKEN_REGISTRY_ATTEMPTS must be a positive integer"],
  ])("refuses %j with exit 78", (overrides, message) => {
    const base = registryEnv("stagenet");
    if (!("TOKEN_REGISTRY_NETWORK" in overrides) && Object.keys(overrides).length === 0) {
      delete (base as Record<string, string | undefined>)["TOKEN_REGISTRY_NETWORK"];
    }
    const run = runEntrypoint("entrypoint-token-registry.sh", { ...base, ...(overrides as Record<string, string>) });
    expect(run.code).toBe(78);
    expect(run.stderr).toContain(message);
    expect(run.calls.some((c) => c.includes("import-token-registry"))).toBe(false);
  });
});

describe("the image ships every entrypoint and every selected entry exists", () => {
  const dockerfile = readFileSync(join(IMAGE_DIR, "Dockerfile"), "utf8");

  test.each(readdirSync(IMAGE_DIR).filter((f) => /^entrypoint-.*\.sh$/.test(f)))("Dockerfile COPYs %s", (file) => {
    expect(dockerfile).toMatch(
      new RegExp(`^COPY\\s+deploy/images/kernel/${file.replace(".", "\\.")}\\s+/usr/local/bin/${file.replace(".", "\\.")}\\s*$`, "m"),
    );
  });

  test.each([
    "packages/node/main.dev.ts",
    "packages/node/main.preview.ts",
    "packages/node/main.stagenet.ts",
    "packages/node/stagenet-profile.ts",
    "packages/batcher/batcher.dev.ts",
    "packages/batcher/batcher.preview.ts",
    "packages/batcher/batcher.stagenet.ts",
    "packages/database/import-token-registry.ts",
  ])("%s exists", (entry) => {
    expect(() => readFileSync(join(REPO_ROOT, entry))).not.toThrow();
  });
});
