import { expect, test } from "bun:test";

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

const REMOVED = ["compact-check", "compact-build", "midnight-contract", "midnight-mint-test-tokens"];

function expectNetworkOnlyStartup(
  config: LauncherConfig,
  chainDependencies: string[],
  walletConsumers: string[],
): void {
  const names = new Set(config.processes.map((item) => item.name));
  for (const removed of REMOVED) expect(names.has(removed), `${removed} must stay removed`).toBe(false);

  const sync = processByName(config, "sync");
  const health = processByName(config, "sync-api-health");
  expect(sync.env?.["ENABLE_TOKEN_REGISTRY"]).toBe("true");
  for (const dependency of chainDependencies) expect(sync.dependsOn).toContain(dependency);
  expect(health.dependsOn).toEqual(["sync"]);
  expect(health.waitToExit).toBe(true);
  expect(health.critical).toBe(true);
  expect(health.args?.at(-1)).toMatch(/^https?-get:\/\/.+\/v1\/health$/);

  for (const consumer of walletConsumers) {
    const deps = processByName(config, consumer).dependsOn ?? [];
    expect(deps).toContain("sync-api-health");
    for (const dependency of chainDependencies) expect(deps).toContain(dependency);
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

const localMidnightReady = [
  "midnight-node-wait",
  "midnight-indexer-wait",
  "midnight-proof-server-wait",
];

test("node grammar retains native offer events without the removed contract snapshot", async () => {
  const { grammar } = await import("../node/grammar.ts");
  const keys = Object.keys(grammar);
  expect(keys).not.toContain("midnight-zswap");
  expect(keys).toContain("midnight-zswap-event");
  expect(keys).toContain("midnight-unshielded-spend");
  expect(keys).toContain("midnight-unshielded-create");
  expect(keys).toContain("midnight-zswap-root");
});

test.serial("start.dev.ts launches chain services with no local contract", async () => {
  const config = (await import("../../start.dev.ts")).default as unknown as LauncherConfig;
  expectNetworkOnlyStartup(config, localMidnightReady, ["batcher", "solver"]);
});

test.serial("packages/tests/start.test.ts uses the same network-only health edge", async () => {
  const config = (await import("./start.test.ts")).default as unknown as LauncherConfig;
  expectNetworkOnlyStartup(config, localMidnightReady, ["batcher"]);
});

test.serial("start.attach.ts waits on external chain and kernel health only", async () => {
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
    expectNetworkOnlyStartup(config, ["chain-wait"], ["batcher", "solver"]);
    expect(processByName(config, "sync-api-health").args?.at(-1)).toBe(
      "http-get://attached-kernel:9999/v1/health",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test.serial("start.external.ts preflights external chain and has no contract process", async () => {
  const config = (await import("../../start.external.ts")).default as unknown as LauncherConfig;
  expectNetworkOnlyStartup(config, ["preflight-external"], ["batcher"]);
  expect(processByName(config, "preflight-external")).toMatchObject({
    waitToExit: true,
    critical: true,
  });
});
