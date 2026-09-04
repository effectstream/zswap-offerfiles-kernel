interface ComposeDependency {
  condition?: string;
}

interface ComposeService {
  depends_on?: Record<string, ComposeDependency | string>;
}

interface ComposeModel {
  services?: Record<string, ComposeService>;
}

type DependencyCondition = "service_healthy" | "service_completed_successfully";

const REQUIRED_EDGES: ReadonlyArray<
  readonly [service: string, dependency: string, condition: DependencyCondition]
> = [
  ["kernel", "offerfiles-deploy", "service_completed_successfully"],
  ["mint-test-tokens", "kernel", "service_healthy"],
  ["mint-test-tokens", "offerfiles-deploy", "service_completed_successfully"],
  ["register-minted-tokens", "kernel", "service_healthy"],
  ["register-minted-tokens", "offerfiles-deploy", "service_completed_successfully"],
  ["register-minted-tokens", "mint-test-tokens", "service_completed_successfully"],
  ...[
    "batcher",
    "solver-provision",
    "maker-offer",
    "offer-poster",
    "solver",
    "scripts",
    "solver-frontend",
    "price-feed",
  ].flatMap((service) => [
    [service, "mint-test-tokens", "service_completed_successfully"] as const,
    [service, "register-minted-tokens", "service_completed_successfully"] as const,
  ]),
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

  for (const serviceName of [
    "offerfiles-deploy",
    "kernel",
    "mint-test-tokens",
    "register-minted-tokens",
  ]) {
    if (!services[serviceName]) {
      throw new Error(`rendered Compose model has no ${serviceName} service`);
    }
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

  for (const forbidden of ["mint-test-tokens", "register-minted-tokens"]) {
    if (dependencyCondition(services["kernel"]!, forbidden)) {
      throw new Error(`kernel must not depend on post-kernel service ${forbidden}`);
    }
  }
  for (const forbidden of ["kernel", "mint-test-tokens", "register-minted-tokens"]) {
    if (dependencyCondition(services["offerfiles-deploy"]!, forbidden)) {
      throw new Error(`offerfiles-deploy must not depend on downstream service ${forbidden}`);
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
      if (!services[dependency]) {
        throw new Error(`${serviceName} depends on unknown service ${dependency}`);
      }
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
  if (!inputPath) {
    throw new Error("usage: bun check-compose-topology.ts <rendered-compose.json|->");
  }
  const input = inputPath === "-" ? await Bun.stdin.text() : await Bun.file(inputPath).text();
  const model = JSON.parse(input) as ComposeModel;
  assertComposeStartupTopology(model);
  console.log(`Compose startup topology OK (${Object.keys(model.services ?? {}).length} services)`);
}
