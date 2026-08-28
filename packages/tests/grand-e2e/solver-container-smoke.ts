const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
const API_VERSION = "v1.51";
const RECORDER_PORT = 14567;
const DISABLED_MARKER = "[solver] SOLVER_ENABLED=false — exiting without starting";
const SECRET_MARKER = "super-secret-value-must-not-leak";

interface Options {
  image: string;
  scope: string;
}

interface RunResult {
  status: number;
  output: string;
}

function options(): Options {
  const values = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const [name, ...rest] = argument.replace(/^--/, "").split("=");
      return [name, rest.join("=")];
    }),
  );
  if (!values.image || !values.scope) {
    throw new Error("usage: solver-container-smoke.ts --image=<local-image> --scope=<unique-scope>");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(values.scope)) {
    throw new Error("scope may contain only letters, digits, dot, underscore, and dash");
  }
  return { image: values.image, scope: values.scope };
}

const selected = options();
const labelName = "io.effectstream.cow-solver.test-run";
const labels = { [labelName]: selected.scope };
const safeScope = selected.scope.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
const networkName = `${safeScope}-net`;
const ladderVolumeName = `${safeScope}-ladder`;
let sequence = 0;

async function engine(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`http://docker/${API_VERSION}${path}`, {
    ...init,
    headers,
    unix: SOCKET_PATH,
  } as RequestInit & { unix: string });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Docker API ${init.method ?? "GET"} ${path}: ${response.status} ${detail}`);
  }
  return response;
}

async function createContainer(
  role: string,
  config: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const name = `${safeScope}-${role}-${++sequence}`;
  const response = await engine(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({
      Image: selected.image,
      Tty: true,
      Labels: labels,
      ...config,
    }),
  });
  const body = await response.json() as { Id: string };
  return { id: body.Id, name };
}

async function removeContainer(id: string): Promise<void> {
  try {
    await engine(`/containers/${id}?force=true&v=true`, { method: "DELETE" });
  } catch (error) {
    if (!String(error).includes("404")) throw error;
  }
}

async function containerLogs(id: string): Promise<string> {
  return engine(`/containers/${id}/logs?stdout=true&stderr=true`).then((response) => response.text());
}

async function waitContainer(id: string, timeoutMs: number): Promise<number> {
  const response = await engine(`/containers/${id}/wait?condition=not-running`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json() as { StatusCode: number };
  return body.StatusCode;
}

async function runContainer(
  role: string,
  config: Record<string, unknown>,
  timeoutMs: number,
): Promise<RunResult> {
  const container = await createContainer(role, config);
  try {
    await engine(`/containers/${container.id}/start`, { method: "POST" });
    const status = await waitContainer(container.id, timeoutMs);
    const output = await containerLogs(container.id);
    return { status, output };
  } finally {
    await removeContainer(container.id);
  }
}

async function runHelper(
  role: string,
  script: string,
  hostConfig: Record<string, unknown>,
  timeoutMs = 10_000,
  user?: string,
): Promise<string> {
  const result = await runContainer(role, {
    Cmd: ["bun", "--no-install", "--no-env-file", "-e", script],
    ...(user === undefined ? {} : { User: user }),
    HostConfig: hostConfig,
  }, timeoutMs);
  if (result.status !== 0) {
    throw new Error(`${role} exited ${result.status}: ${result.output}`);
  }
  return result.output.trim();
}

async function queryRecorder(path: "/count" | "/reset"): Promise<number> {
  const script = `const response=await fetch("http://recorder:${RECORDER_PORT}${path}");` +
    `if(!response.ok)throw new Error("recorder status "+response.status);` +
    `console.log(await response.text());`;
  const output = await runHelper("probe", script, {
    ReadonlyRootfs: true,
    NetworkMode: networkName,
  });
  const value = Number(output.split(/\s+/).at(-1));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid recorder response: ${output}`);
  }
  return value;
}

async function waitForRecorder(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await queryRecorder("/reset");
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(200);
    }
  }
  throw new Error(`recorder was not ready: ${String(lastError)}`);
}

function baseEnvironment(network: "preview" | "mainnet" = "preview"): Record<string, string> {
  return {
    MIDNIGHT_NETWORK_ID: network,
    SOLVER_ENABLED: "false",
    SOLVER_DRY_RUN: "true",
    SOLVER_SEED: "public-dummy-seed-not-for-use",
    ZSWAP_API: `http://recorder:${RECORDER_PORT}`,
    SOLVER_LADDER_CONFIG: "/etc/cow-solver/ladders.json",
    MIDNIGHT_INDEXER_HTTP: `http://recorder:${RECORDER_PORT}`,
    MIDNIGHT_INDEXER_WS: `ws://recorder:${RECORDER_PORT}`,
    MIDNIGHT_NODE_HTTP: `http://recorder:${RECORDER_PORT}`,
    MIDNIGHT_PROOF_SERVER_URL: `http://recorder:${RECORDER_PORT}`,
  };
}

function environmentList(values: Record<string, string>): string[] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
}

function assertNoInstallOrSecret(output: string): void {
  for (const forbidden of [SECRET_MARKER, "bun install", "Resolving dependencies"]) {
    if (output.includes(forbidden)) throw new Error(`forbidden output marker found: ${forbidden}`);
  }
}

async function runSolverCase(
  role: string,
  environment: Record<string, string>,
  expectedStatus: 0 | 1,
  expectedMessage: string,
  timeoutMs: number,
): Promise<void> {
  await queryRecorder("/reset");
  const result = await runContainer(role, {
    Env: environmentList(environment),
    HostConfig: {
      ReadonlyRootfs: true,
      NetworkMode: networkName,
      Mounts: [{
        Type: "volume",
        Source: ladderVolumeName,
        Target: "/etc/cow-solver",
        ReadOnly: true,
      }],
    },
  }, timeoutMs);

  if (result.status !== expectedStatus) {
    throw new Error(`${role}: expected exit ${expectedStatus}, got ${result.status}: ${result.output}`);
  }
  if (!result.output.includes(expectedMessage)) {
    throw new Error(`${role}: missing ${expectedMessage}: ${result.output}`);
  }
  assertNoInstallOrSecret(result.output);
  if (expectedStatus === 0 && result.output.split(DISABLED_MARKER).length - 1 !== 1) {
    throw new Error(`${role}: disabled marker was not printed exactly once: ${result.output}`);
  }
  const attempts = await queryRecorder("/count");
  if (attempts !== 0) throw new Error(`${role}: recorder observed ${attempts} outbound attempts`);
}

async function listLabelled(kind: "containers" | "networks" | "volumes"): Promise<string[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${labelName}=${selected.scope}`] }));
  if (kind === "containers") {
    const response = await engine(`/containers/json?all=true&filters=${filters}`);
    return (await response.json() as Array<{ Id: string }>).map(({ Id }) => Id);
  }
  if (kind === "networks") {
    const response = await engine(`/networks?filters=${filters}`);
    return (await response.json() as Array<{ Id: string }>).map(({ Id }) => Id);
  }
  const response = await engine(`/volumes?filters=${filters}`);
  const body = await response.json() as { Volumes?: Array<{ Name: string }> };
  return (body.Volumes ?? []).map(({ Name }) => Name);
}

async function cleanupLabelled(): Promise<void> {
  for (const id of await listLabelled("containers")) await removeContainer(id);
  for (const id of await listLabelled("networks")) {
    try {
      await engine(`/networks/${id}`, { method: "DELETE" });
    } catch (error) {
      if (!String(error).includes("404")) throw error;
    }
  }
  for (const name of await listLabelled("volumes")) {
    try {
      await engine(`/volumes/${encodeURIComponent(name)}?force=true`, { method: "DELETE" });
    } catch (error) {
      if (!String(error).includes("404")) throw error;
    }
  }
}

async function assertClean(): Promise<void> {
  const leftovers = {
    containers: await listLabelled("containers"),
    networks: await listLabelled("networks"),
    volumes: await listLabelled("volumes"),
  };
  if (Object.values(leftovers).some((items) => items.length > 0)) {
    throw new Error(`scoped Docker leftovers: ${JSON.stringify(leftovers)}`);
  }
}

let recorderId: string | undefined;
try {
  await cleanupLabelled();
  await engine(`/images/${encodeURIComponent(selected.image)}/json`);

  await engine("/networks/create", {
    method: "POST",
    body: JSON.stringify({ Name: networkName, CheckDuplicate: true, Internal: true, Labels: labels }),
  });
  await engine("/volumes/create", {
    method: "POST",
    body: JSON.stringify({ Name: ladderVolumeName, Labels: labels }),
  });

  await runHelper("ladder-seed", `await Bun.write("/ladder/ladders.json", "{}\\n")`, {
    NetworkMode: "none",
    Mounts: [{ Type: "volume", Source: ladderVolumeName, Target: "/ladder" }],
  }, 10_000, "0:0");

  const recorderScript = `let count=0;Bun.serve({hostname:"0.0.0.0",port:${RECORDER_PORT},` +
    `fetch(request){const path=new URL(request.url).pathname;` +
    `if(path==="/count")return new Response(String(count));` +
    `if(path==="/reset"){count=0;return new Response("0")}` +
    `count++;return new Response("{}",{headers:{"content-type":"application/json"}})}});` +
    `console.log("recorder-ready")`;
  const recorder = await createContainer("recorder", {
    Cmd: ["bun", "--no-install", "--no-env-file", "-e", recorderScript],
    HostConfig: { ReadonlyRootfs: true, NetworkMode: networkName },
    NetworkingConfig: {
      EndpointsConfig: { [networkName]: { Aliases: ["recorder"] } },
    },
  });
  recorderId = recorder.id;
  await engine(`/containers/${recorder.id}/start`, { method: "POST" });
  await waitForRecorder();

  await runSolverCase("positive-preview", baseEnvironment("preview"), 0, DISABLED_MARKER, 30_000);
  await runSolverCase("positive-mainnet", baseEnvironment("mainnet"), 0, DISABLED_MARKER, 30_000);

  const common = [
    "MIDNIGHT_NETWORK_ID",
    "SOLVER_ENABLED",
    "SOLVER_DRY_RUN",
    "SOLVER_SEED",
    "ZSWAP_API",
    "SOLVER_LADDER_CONFIG",
    "MIDNIGHT_INDEXER_HTTP",
    "MIDNIGHT_INDEXER_WS",
    "MIDNIGHT_NODE_HTTP",
    "MIDNIGHT_PROOF_SERVER_URL",
  ];
  for (const name of common) {
    const environment = { ...baseEnvironment(), SOLVER_ENABLED: "true" };
    delete environment[name];
    await runSolverCase(`missing-${name.toLowerCase()}`, environment, 1, name, 10_000);
  }

  await runSolverCase("unreadable-ladder", {
    ...baseEnvironment(),
    SOLVER_ENABLED: "true",
    SOLVER_LADDER_CONFIG: "/etc/cow-solver/missing.json",
  }, 1, "SOLVER_LADDER_CONFIG", 10_000);
  await runSolverCase("invalid-network", {
    ...baseEnvironment(),
    SOLVER_ENABLED: "true",
    MIDNIGHT_NETWORK_ID: SECRET_MARKER,
  }, 1, "MIDNIGHT_NETWORK_ID", 10_000);
  for (const name of ["SOLVER_ENABLED", "SOLVER_DRY_RUN"]) {
    await runSolverCase(`invalid-${name.toLowerCase()}`, {
      ...baseEnvironment(),
      [name]: "TRUE",
    }, 1, name, 10_000);
  }

  const liveFields: Record<string, string> = {
    SOLVER_RELAY_WS_URL: `ws://recorder:${RECORDER_PORT}`,
    SOLVER_RELAY_HTTP_URL: `http://recorder:${RECORDER_PORT}`,
    SOLVER_RELAY_AUTH_TOKEN: SECRET_MARKER,
    SOLVER_JOURNAL_PATH: "/var/lib/cow-solver/operations.sqlite",
  };
  for (const name of Object.keys(liveFields)) {
    const environment = {
      ...baseEnvironment(),
      SOLVER_ENABLED: "true",
      SOLVER_DRY_RUN: "false",
      ...liveFields,
    };
    delete environment[name];
    await runSolverCase(`missing-${name.toLowerCase()}`, environment, 1, name, 10_000);
  }
  await runSolverCase("relative-journal", {
    ...baseEnvironment(),
    SOLVER_ENABLED: "true",
    SOLVER_DRY_RUN: "false",
    ...liveFields,
    SOLVER_JOURNAL_PATH: "relative.sqlite",
  }, 1, "SOLVER_JOURNAL_PATH", 10_000);
  const mainnetLive = {
    ...baseEnvironment("mainnet"),
    SOLVER_ENABLED: "true",
    SOLVER_DRY_RUN: "false",
    ...liveFields,
  };
  await runSolverCase(
    "missing-mainnet-ack",
    mainnetLive,
    1,
    "SOLVER_MAINNET_LIVE_TRADING_ACK",
    10_000,
  );

  const ladderInventory = await runHelper(
    "ladder-inventory",
    `const {readdir}=await import("node:fs/promises");console.log(JSON.stringify(await readdir("/ladder")))`,
    {
      ReadonlyRootfs: true,
      NetworkMode: "none",
      Mounts: [{
        Type: "volume",
        Source: ladderVolumeName,
        Target: "/ladder",
        ReadOnly: true,
      }],
    },
  );
  if (ladderInventory !== '["ladders.json"]') {
    throw new Error(`solver created unexpected state: ${ladderInventory}`);
  }

  console.log("solver-container-smoke: PASS (2 positive, 20 negative, zero outbound attempts)");
} finally {
  if (recorderId !== undefined) await removeContainer(recorderId);
  await cleanupLabelled();
  await assertClean();
  console.log("solver-container-smoke: cleanup PASS (zero labelled resources)");
}
