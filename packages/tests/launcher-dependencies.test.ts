import { expect, mock, test } from "bun:test";

// Config construction probes `compact --version`. These tests inspect the
// dependency graph only, so isolate that external preflight while leaving the
// production launcher and its real Compact check unchanged.
mock.module("node:child_process", () => ({
  spawnSync: () => ({ status: 0 }),
}));

interface ProcessSpec {
  name: string;
  args?: string[];
  dependsOn?: string[];
  env?: Record<string, string>;
  critical?: boolean;
  waitToExit?: boolean;
}

interface LauncherConfig {
  processes: ProcessSpec[];
}

function processByName(config: LauncherConfig, name: string): ProcessSpec {
  const found = config.processes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`launcher has no ${name} process`);
  return found;
}

function expectLinearStartup(
  config: LauncherConfig,
  contractDeploy: string,
  walletConsumers: string[],
): void {
  const sync = processByName(config, "sync");
  const health = processByName(config, "sync-api-health");
  const mint = processByName(config, "midnight-mint-test-tokens");

  expect(sync.env?.["ENABLE_TOKEN_REGISTRY"]).toBe("true");
  expect(health.dependsOn).toEqual(["sync"]);
  expect(health.waitToExit).toBe(true);
  expect(health.critical).toBe(true);
  expect(health.args?.at(-1)).toMatch(/^https?-get:\/\/.+\/v1\/health$/);
  expect(mint.dependsOn).toContain(contractDeploy);
  expect(mint.dependsOn).toContain("sync-api-health");
  expect(mint.env?.["ZSWAP_API"]).toMatch(/^https?:\/\//);

  for (const consumer of walletConsumers) {
    expect(processByName(config, consumer).dependsOn).toContain("midnight-mint-test-tokens");
  }

  const byName = new Map(config.processes.map((item) => [item.name, item]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`launcher dependency cycle at ${name}`);
    if (done.has(name)) return;
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) {
      if (byName.has(dependency)) visit(dependency);
    }
    visiting.delete(name);
    done.add(name);
  };
  for (const name of byName.keys()) visit(name);
}

test.serial("start.dev.ts uses contract -> sync health -> mint -> wallet consumers", async () => {
  const config = (await import("../../start.dev.ts")).default as unknown as LauncherConfig;
  expectLinearStartup(config, "midnight-contract", ["batcher", "solver"]);
});

test.serial("packages/tests/start.test.ts uses the same health edge", async () => {
  const config = (await import("./start.test.ts")).default as unknown as LauncherConfig;
  expectLinearStartup(config, "midnight-contract", ["batcher"]);
});

test.serial("start.attach.ts uses configured API health before minting", async () => {
  const vars = {
    MIDNIGHT_NODE_HTTP: "http://midnight-node:9944",
    MIDNIGHT_INDEXER_HTTP: "http://indexer:8088/api/v3/graphql",
    MIDNIGHT_PROOF_SERVER_URL: "http://proof-server:6300",
    CELESTIA_RPC_URL: "http://celestia:26658",
    ZSWAP_API: " http://attached-kernel:9999/ ",
  };
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const config = (await import("../../start.attach.ts")).default as unknown as LauncherConfig;
    expectLinearStartup(config, "midnight-contract", ["batcher", "solver"]);
    expect(processByName(config, "sync-api-health").args?.at(-1)).toBe(
      "http-get://attached-kernel:9999/v1/health",
    );
    expect(processByName(config, "midnight-mint-test-tokens").env?.["ZSWAP_API"]).toBe(
      "http://attached-kernel:9999/",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
