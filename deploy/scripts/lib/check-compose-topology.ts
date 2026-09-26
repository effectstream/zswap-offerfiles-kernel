interface ComposeDependency {
  condition?: string;
}

interface ComposeService {
  depends_on?: Record<string, ComposeDependency | string>;
}

interface ComposeModel {
  services?: Record<string, ComposeService>;
}

type DependencyCondition = "service_started" | "service_healthy" | "service_completed_successfully";

const REMOVED_SERVICES = ["offerfiles-deploy", "mint-test-tokens", "register-minted-tokens"];

const REQUIRED_EDGES: ReadonlyArray<
  readonly [service: string, dependency: string, condition: DependencyCondition]
> = [
  ["indexer", "midnight-node", "service_healthy"],
  ["kernel", "pglite", "service_healthy"],
  ["kernel", "celestia", "service_healthy"],
  ["batcher", "celestia", "service_healthy"],
  ["solver-provision", "midnight-node", "service_healthy"],
  ["solver-provision", "proof-server", "service_started"],
  ["solver-provision", "indexer", "service_healthy"],
  ["maker-offer", "kernel", "service_healthy"],
  ["offer-poster", "kernel", "service_healthy"],
  ["relay", "midnight-node", "service_healthy"],
  ["relay", "indexer", "service_healthy"],
  ["relay", "proof-server", "service_started"],
  ["solver", "kernel", "service_healthy"],
  ["solver", "relay", "service_healthy"],
  ["solver", "solver-provision", "service_completed_successfully"],
  ["solver-frontend", "kernel", "service_healthy"],
  ["price-feed", "pglite", "service_healthy"],
  ["price-feed", "kernel", "service_healthy"],
  ["scripts", "kernel", "service_healthy"],
  ["scripts", "relay", "service_healthy"],
  ["scripts", "batcher", "service_healthy"],
];

function dependencyCondition(service: ComposeService, dependency: string): string | undefined {
  const value = service.depends_on?.[dependency];
  return typeof value === "string" ? value : value?.condition;
}

export function assertComposeStartupTopology(model: ComposeModel): void {
  const services = model.services;
  if (!services || typeof services !== "object") {
    throw new Error("rendered Compose model has no services object");
  }

  for (const removed of REMOVED_SERVICES) {
    if (services[removed]) throw new Error(`removed local-funding service is still present: ${removed}`);
  }

  for (const [serviceName, dependency, expected] of REQUIRED_EDGES) {
    const service = services[serviceName];
    if (!service) throw new Error(`rendered Compose model has no ${serviceName} service`);
    const actual = dependencyCondition(service, dependency);
    if (actual !== expected) {
      throw new Error(
        `${serviceName} -> ${dependency}: expected ${expected}, got ${actual ?? "missing"}`,
      );
    }
  }

  for (const [serviceName, service] of Object.entries(services)) {
    for (const removed of REMOVED_SERVICES) {
      if (dependencyCondition(service, removed)) {
        throw new Error(`${serviceName} still depends on removed service ${removed}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (serviceName: string): void => {
    if (visiting.has(serviceName)) {
      const cycleStart = path.indexOf(serviceName);
      throw new Error(
        `Compose dependency cycle: ${[...path.slice(cycleStart), serviceName].join(" -> ")}`,
      );
    }
    if (visited.has(serviceName)) return;
    visiting.add(serviceName);
    path.push(serviceName);
    for (const dependency of Object.keys(services[serviceName]?.depends_on ?? {})) {
      if (!services[dependency]) throw new Error(`${serviceName} depends on unknown service ${dependency}`);
      visit(dependency);
    }
    path.pop();
    visiting.delete(serviceName);
    visited.add(serviceName);
  };

  for (const serviceName of Object.keys(services)) visit(serviceName);
}

if (import.meta.main) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("usage: bun check-compose-topology.ts <rendered-compose.json|->");
  const input = inputPath === "-" ? await Bun.stdin.text() : await Bun.file(inputPath).text();
  const model = JSON.parse(input) as ComposeModel;
  assertComposeStartupTopology(model);
  console.log(`Compose startup topology OK (${Object.keys(model.services ?? {}).length} services)`);
}
