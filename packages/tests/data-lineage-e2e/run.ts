/**
 * Project 00001 / Lineage L5 black-box provenance E2E.
 *
 * Usage:
 *   bun run packages/tests/data-lineage-e2e/run.ts --run-l5
 *   bun run packages/tests/data-lineage-e2e/run.ts --run-l5 --signal-probe
 *   bun run packages/tests/data-lineage-e2e/run.ts --run-l5 --pre-compose-signal-probe
 *
 * The driver creates a unique temporary Compose project. Three separate
 * service processes share one isolated network namespace: the real Offer
 * Files Fastify/PGlite API, an HTTP evidence recorder, and the built Midnight
 * Intents pull-adapter/router surface. Only dynamically probed host ports are
 * published. All Compose files and captures are temporary and are removed
 * after unconditional `down -v --remove-orphans` cleanup.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const BUN_IMAGE =
  "oven/bun@sha256:fbf8e67e9d3b806c86be7a2f2e9bae801f2d9212a21db4dcf8cc9889f5a3c9c4";
const NODE_IMAGE =
  "node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";
const MIN_PORT = 10_000;
const MAX_PORT_EXCLUSIVE = 61_000;
const CLEAN_SETTLE_MS = 5_000;
const SOLVER_ID = "offer-files-solver-lineage-l5";
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);
const V1 = "9007199254740993";
const V2 = "9007199254740994";
const V3 = "9007199254740995";
const V4 = "9007199254740996";
const FORBIDDEN_EXECUTION_FIELDS = /quoteId|requestId|jobId|intentId/;

const OFFER_FILES_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const INTENTS_ROOT = resolve(
  process.env["LINEAGE_INTENTS_ROOT"] ??
    join(OFFER_FILES_ROOT, "..", "00001-midnight-intents-offer-files-data-lineage", "phase1-native-swaps"),
);

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

interface HttpCapture {
  status: number;
  headers: Record<string, string | null>;
  body: any;
  rawBody: string;
}

interface CleanupEvidence {
  composeDownAttempted: boolean;
  downCode: number | null;
  containers: string[];
  networks: string[];
  volumes: string[];
  portsReleased: boolean;
  activeDriverProcesses: number;
  temporaryDirectoryRemoved: boolean;
  errors: string[];
}

interface Session {
  project: string;
  directory: string;
  composePath: string;
  upstreamEvidencePath: string;
  publicEvidencePath: string;
  sourcePort: number;
  relayPort: number;
  reservations: PortReservation[];
  children: Set<ChildProcessWithoutNullStreams>;
  reservationsReleased: boolean;
  composeWritten: boolean;
}

interface Secrets {
  read: string;
  write: string;
  solverWs: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `${message}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

async function reserveRandomPort(excluded: Set<number>): Promise<PortReservation> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const port = randomInt(MIN_PORT, MAX_PORT_EXCLUSIVE);
    if (excluded.has(port)) continue;
    const server = createServer();
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          server.off("error", onError);
          resolvePromise();
        });
      });
      excluded.add(port);
      server.unref();
      let released = false;
      return {
        port,
        release: async () => {
          if (released) return;
          released = true;
          await closeServer(server);
        },
      };
    } catch {
      try {
        await closeServer(server);
      } catch {
        // The failed candidate never acquired a listener.
      }
    }
  }
  throw new Error("could not reserve a verified-free host port at or above 10000");
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  await closeServer(server);
}

async function assertPortIsReserved(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.off("error", onError);
        resolvePromise();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    throw error;
  }
  await closeServer(server);
  throw new Error(`host port ${port} was not held by its reservation`);
}

async function runCommand(
  command: string,
  args: string[],
  children: Set<ChildProcessWithoutNullStreams>,
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      COMPOSE_ANSI: "never",
      COMPOSE_PROGRESS: "plain",
      DOCKER_CLI_HINTS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeoutMs = options.timeoutMs ?? 240_000;
  const result = await new Promise<CommandResult>((resolvePromise, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
      } else {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      }
    });
  }).finally(() => children.delete(child));

  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function composeArgs(session: Session, args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    session.project,
    "--file",
    session.composePath,
    ...args,
  ];
}

function runCompose(
  session: Session,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<CommandResult> {
  return runCommand("docker", composeArgs(session, args), session.children, options);
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

async function createSession(): Promise<Session> {
  assert(await exists(join(OFFER_FILES_ROOT, "packages", "node", "api.ts")), "Offer Files root is invalid");
  assert(
    await exists(join(INTENTS_ROOT, "packages", "relay", "src", "index.ts")),
    `Midnight Intents work root is invalid: ${INTENTS_ROOT}`,
  );

  let directory: string | null = null;
  const reservations: PortReservation[] = [];
  try {
    directory = await mkdtemp(join(tmpdir(), "zswap-lineage-l5-"));
    const excluded = new Set<number>();
    const sourceReservation = await reserveRandomPort(excluded);
    reservations.push(sourceReservation);
    const relayReservation = await reserveRandomPort(excluded);
    reservations.push(relayReservation);
    const project = `zswap-l5-${process.pid}-${randomBytes(5).toString("hex")}`;
    return {
      project,
      directory,
      composePath: join(directory, "compose.yml"),
      upstreamEvidencePath: join(directory, "upstream.jsonl"),
      publicEvidencePath: join(directory, "public.jsonl"),
      sourcePort: sourceReservation.port,
      relayPort: relayReservation.port,
      reservations,
      reservationsReleased: false,
      composeWritten: false,
      children: new Set(),
    };
  } catch (error) {
    const rollback = await Promise.allSettled(
      reservations.map((reservation) => reservation.release()),
    );
    const rollbackErrors = rollback
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason));
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true }).catch((rollbackError) => {
        rollbackErrors.push(String(rollbackError));
      });
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "lineage L5 session construction and rollback both failed",
      );
    }
    throw error;
  }
}

async function writeCompose(
  session: Session,
  secrets: Secrets,
): Promise<void> {
  const offerFilesCopy =
    "export DEBIAN_FRONTEND=noninteractive && " +
    "apt-get update -qq && " +
    "apt-get install -y -qq --no-install-recommends python3 make g++ libnode-dev && " +
    "bun x --silent node-gyp@13.0.1 --version && " +
    "mkdir -p /work/offer && " +
    "tar -C /src/offer --exclude=.git --exclude=node_modules -cf - . | " +
    "tar -C /work/offer -xf - && " +
    "npm_config_nodedir=/usr bun install --frozen-lockfile --concurrent-scripts=1 && " +
    "exec bun run packages/tests/data-lineage-e2e/offer-files-service.ts";
  const relayCopy =
    "mkdir -p /work/intents && " +
    "tar -C /src/intents --exclude=.git --exclude=node_modules --exclude=dist -cf - . | " +
    "tar -C /work/intents -xf - && " +
    "npm ci && " +
    "npm run build:relay && " +
    "cp /src/offer/packages/tests/data-lineage-e2e/relay-service.mjs /work/intents/.lineage-relay-service.mjs && " +
    "exec node /work/intents/.lineage-relay-service.mjs";
  const credentials = JSON.stringify({ [SOLVER_ID]: secrets.write });
  const compose = `services:
  offerfiles:
    image: ${yaml(BUN_IMAGE)}
    init: true
    working_dir: /work/offer
    command: ["sh", "-lc", ${yaml(offerFilesCopy)}]
    environment:
      LINEAGE_OFFER_FILES_PORT: "8080"
      SOLVER_LEVELS_AUTH_KEYS: ${yaml(credentials)}
      SOLVER_LIQUIDITY_READ_AUTH_SECRET: ${yaml(secrets.read)}
      SOLVER_LEVELS_TTL_SECONDS: "2"
      POST_COMMIT_EVENT_BRIDGE_ENABLED: "false"
      API_RATE_LIMIT_MAX: "10000"
    volumes:
      - ${yaml(`${OFFER_FILES_ROOT}:/src/offer:ro`)}
    ports:
      - ${yaml(`127.0.0.1:${session.sourcePort}:8080`)}
      - ${yaml(`127.0.0.1:${session.relayPort}:8081`)}
    stop_grace_period: 15s

  recorder:
    image: ${yaml(NODE_IMAGE)}
    init: true
    network_mode: "service:offerfiles"
    depends_on:
      - offerfiles
    command: ["node", "/src/offer/packages/tests/data-lineage-e2e/upstream-recorder.mjs"]
    environment:
      LINEAGE_RECORDER_PORT: "8082"
      LINEAGE_RECORDER_UPSTREAM: "http://127.0.0.1:8080"
      LINEAGE_UPSTREAM_EVIDENCE_PATH: "/evidence/upstream.jsonl"
    volumes:
      - ${yaml(`${OFFER_FILES_ROOT}:/src/offer:ro`)}
      - ${yaml(`${session.directory}:/evidence`)}
    stop_grace_period: 15s

  relay:
    image: ${yaml(NODE_IMAGE)}
    init: true
    network_mode: "service:offerfiles"
    depends_on:
      - offerfiles
      - recorder
    working_dir: /work/intents
    command: ["sh", "-lc", ${yaml(relayCopy)}]
    environment:
      RELAY_PORT: "8081"
      RELAY_WS_PORT: "8083"
      BIND_HOST: "0.0.0.0"
      SOLVER_AUTH_TOKEN: ${yaml(secrets.solverWs)}
      RATE_LIMIT_MAX: "10000"
      RELAY_PUBLIC_DOCS_ENABLED: "false"
      OFFER_FILES_LIQUIDITY_URL: "http://127.0.0.1:8082/v1/solver/liquidity"
      OFFER_FILES_LIQUIDITY_SOLVER_ID: ${yaml(SOLVER_ID)}
      OFFER_FILES_LIQUIDITY_AUTH_TOKEN: ${yaml(secrets.read)}
      OFFER_FILES_LIQUIDITY_POLL_INTERVAL_MS: "100"
      OFFER_FILES_LIQUIDITY_REQUEST_TIMEOUT_MS: "2000"
    volumes:
      - ${yaml(`${INTENTS_ROOT}:/src/intents:ro`)}
      - ${yaml(`${OFFER_FILES_ROOT}:/src/offer:ro`)}
    stop_grace_period: 15s
`;
  await writeFile(session.composePath, compose, { encoding: "utf8", mode: 0o600 });
  session.composeWritten = true;
}

async function prepareSession(session: Session): Promise<Secrets> {
  const secrets = {
    read: `read-${randomBytes(32).toString("hex")}`,
    write: `write-${randomBytes(24).toString("hex")}`,
    solverWs: `ws-${randomBytes(32).toString("hex")}`,
  };
  await mkdir(dirname(session.upstreamEvidencePath), { recursive: true });
  await writeCompose(session, secrets);
  return secrets;
}

async function releaseReservations(session: Session): Promise<void> {
  if (session.reservationsReleased) return;
  session.reservationsReleased = true;
  await Promise.all(session.reservations.map((reservation) => reservation.release()));
}

async function requestJson(url: string, init: RequestInit = {}): Promise<HttpCapture> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(8_000),
  });
  const rawBody = await response.text();
  let body: any = null;
  try {
    body = rawBody === "" ? null : JSON.parse(rawBody);
  } catch {
    body = rawBody;
  }
  return {
    status: response.status,
    headers: {
      "cache-control": response.headers.get("cache-control"),
      "content-type": response.headers.get("content-type"),
      "access-control-allow-origin": response.headers.get("access-control-allow-origin"),
    },
    body,
    rawBody,
  };
}

async function waitForHttp(
  label: string,
  operation: () => Promise<HttpCapture>,
  predicate: (capture: HttpCapture) => boolean,
  timeoutMs = 180_000,
): Promise<HttpCapture> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const capture = await operation();
      last = `${capture.status} ${capture.rawBody}`;
      if (predicate(capture)) return capture;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready: ${last}`);
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function publish(
  sourceBase: string,
  writeSecret: string,
  version: string,
  pairs: unknown[],
): Promise<HttpCapture> {
  const response = await requestJson(`${sourceBase}/v1/solver/levels`, {
    method: "POST",
    headers: {
      ...bearer(writeSecret),
      "content-type": "application/json",
    },
    body: JSON.stringify({ version, pairs }),
  });
  assert(response.status === 200, `publication ${version} failed: ${response.rawBody}`);
  assert(response.body?.version === version, `publication ${version} returned the wrong version`);
  assert(response.body?.solverId === SOLVER_ID, `publication ${version} returned the wrong identity`);
  return response;
}

async function sourceSnapshot(
  sourceBase: string,
  readSecret: string,
): Promise<{ capture: HttpCapture; snapshot: any }> {
  const capture = await requestJson(
    `${sourceBase}/v1/solver/liquidity?solver_id=${encodeURIComponent(SOLVER_ID)}`,
    { headers: bearer(readSecret) },
  );
  assert(capture.status === 200, `source snapshot failed: ${capture.rawBody}`);
  assert(capture.headers["cache-control"] === "no-store", "source snapshot must be no-store");
  assert(Array.isArray(capture.body?.snapshots), "source snapshot envelope is malformed");
  assert(capture.body.snapshots.length === 1, "published solver identity must return one snapshot");
  return { capture, snapshot: capture.body.snapshots[0] };
}

function expectedLevels(snapshot: any, pairs = snapshot.pairs): any {
  return {
    schemaVersion: 1,
    source: "offer-files-solver",
    solverId: snapshot.solverId,
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    expiresAt: snapshot.expiresAt,
    indicative: true,
    pairs,
  };
}

function expectedTokens(snapshot: any, pairs = snapshot.pairs): any {
  const tokens = [...new Set(
    pairs.flatMap((pair: any) => [pair.tokenIn, pair.tokenOut]),
  )].sort();
  const { pairs: _pairs, ...common } = expectedLevels(snapshot, pairs);
  return { ...common, tokens };
}

async function capturePublic(
  session: Session,
  captures: Array<{ label: string; capture: HttpCapture }>,
  label: string,
  capture: HttpCapture,
): Promise<void> {
  captures.push({ label, capture });
  await appendFile(
    session.publicEvidencePath,
    `${JSON.stringify({ observedAt: new Date().toISOString(), label, ...capture })}\n`,
    "utf8",
  );
}

async function waitForRelaySnapshot(
  session: Session,
  relayBase: string,
  captures: Array<{ label: string; capture: HttpCapture }>,
  label: string,
  target: any,
  prior: any | null,
): Promise<HttpCapture> {
  const deadline = Date.now() + 10_000;
  let last = "no response";
  while (Date.now() < deadline) {
    const response = await requestJson(`${relayBase}/offer-files/levels`, {
      headers: { origin: "https://lineage-e2e.example" },
    });
    await capturePublic(session, captures, `${label}-observation`, response);
    last = `${response.status} ${response.rawBody}`;
    if (response.status === 200 && response.body?.version === target.version) {
      assertEqual(response.body, expectedLevels(target), `${label} target snapshot mismatch`);
      return response;
    }
    if (response.status === 200 && prior && response.body?.version === prior.version) {
      assertEqual(response.body, expectedLevels(prior), `${label} exposed a mixed prior snapshot`);
    } else if (!(response.status === 503 && prior === null)) {
      throw new Error(`${label} exposed an unexpected intermediate state: ${last}`);
    }
    await sleep(40);
  }
  throw new Error(`${label} did not reach version ${target.version}: ${last}`);
}

async function readAudit(relayBase: string): Promise<any> {
  const response = await requestJson(`${relayBase}/__lineage/audit`);
  assert(response.status === 200, `relay audit failed: ${response.rawBody}`);
  return response.body;
}

function assertZeroExecutableActivity(audit: any): void {
  for (const [name, count] of Object.entries(audit.executableMethodCalls ?? {})) {
    assert(count === 0, `executable relay method ${name} was called ${count} times`);
  }
  for (const name of [
    "quoteIdsMinted",
    "jobsStarted",
    "intentDispatches",
    "submissionCalls",
    "connectedSolvers",
    "registeredSolvers",
  ]) {
    assert(audit[name] === 0, `${name} must remain zero, got ${audit[name]}`);
  }
  assert(
    audit.walletProcessStarted === false,
    `the data-only topology must not start a wallet process, got ${audit.walletProcessStarted}`,
  );
}

async function runScenario(
  session: Session,
  secrets: { read: string; write: string },
): Promise<Record<string, unknown>> {
  const sourceBase = `http://127.0.0.1:${session.sourcePort}`;
  const relayBase = `http://127.0.0.1:${session.relayPort}`;
  const sourceUrl =
    `${sourceBase}/v1/solver/liquidity?solver_id=${encodeURIComponent(SOLVER_ID)}`;

  await waitForHttp(
    "Offer Files API",
    () => requestJson(sourceUrl, { headers: bearer(secrets.read) }),
    (capture) => capture.status === 200,
  );
  await waitForHttp(
    "Midnight Intents relay",
    () => requestJson(`${relayBase}/__lineage/ready`),
    (capture) => capture.status === 200 && capture.body?.ready === true,
  );

  const unauthorized = await requestJson(sourceUrl, {
    headers: bearer("not-the-lineage-read-secret"),
  });
  assert(unauthorized.status === 401, "source grouped route must enforce its dedicated bearer");
  assert(unauthorized.headers["cache-control"] === "no-store", "source auth failure must be no-store");

  const initial = await requestJson(sourceUrl, { headers: bearer(secrets.read) });
  assertEqual(initial.body?.snapshots, [], "unknown source identity must begin with zero snapshots");

  const oldPairs = [
    {
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_C,
      levels: [
        { input: "1000", output: "2001" },
        { input: "2000", output: "3901" },
      ],
    },
    {
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      levels: [
        { input: "1000", output: "901" },
        { input: "2000", output: "1703" },
        { input: "4000", output: "3007" },
      ],
    },
  ];
  await publish(sourceBase, secrets.write, V1, oldPairs);
  const sourceV1 = await sourceSnapshot(sourceBase, secrets.read);
  assert(sourceV1.snapshot.version === V1, "source did not retain the >2^53 version exactly");
  assertEqual(
    sourceV1.snapshot.pairs.map((pair: any) => `${pair.tokenIn}|${pair.tokenOut}`),
    [`${TOKEN_A}|${TOKEN_B}`, `${TOKEN_B}|${TOKEN_C}`],
    "source did not stable-sort the distinctive live pairs",
  );

  const publicCaptures: Array<{ label: string; capture: HttpCapture }> = [];
  const liveLevels = await waitForRelaySnapshot(
    session,
    relayBase,
    publicCaptures,
    "live-v1",
    sourceV1.snapshot,
    null,
  );
  assert(liveLevels.headers["cache-control"] === "no-store", "relay levels must be no-store");
  assert(
    liveLevels.headers["access-control-allow-origin"] === "*",
    "relay Offer Files surface must retain public CORS",
  );

  const liveTokens = await requestJson(`${relayBase}/offer-files/tokens`);
  await capturePublic(session, publicCaptures, "live-v1-tokens", liveTokens);
  assertEqual(liveTokens.body, expectedTokens(sourceV1.snapshot), "live token provenance mismatch");

  const liveQuote = await requestJson(`${relayBase}/offer-files/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1500" }),
  });
  await capturePublic(session, publicCaptures, "live-v1-quote", liveQuote);
  assert(liveQuote.status === 200, `live quote failed: ${liveQuote.rawBody}`);
  assertEqual(liveQuote.body, {
    schemaVersion: 1,
    source: "offer-files-solver",
    solverId: SOLVER_ID,
    version: V1,
    updatedAt: sourceV1.snapshot.updatedAt,
    expiresAt: sourceV1.snapshot.expiresAt,
    indicative: true,
    type: "indicative_quote",
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn: "1500",
    amountOut: "1302",
    interpolation: "linear-floor",
  }, "live quote was not derived exactly from the distinctive source ladder");

  const replacementPairs = [{
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_C,
    levels: [
      { input: "500", output: "800" },
      { input: "1500", output: "2200" },
      { input: "3000", output: "4000" },
    ],
  }];
  await publish(sourceBase, secrets.write, V2, replacementPairs);
  const sourceV2 = await sourceSnapshot(sourceBase, secrets.read);
  const replaced = await waitForRelaySnapshot(
    session,
    relayBase,
    publicCaptures,
    "replacement-v2",
    sourceV2.snapshot,
    sourceV1.snapshot,
  );
  assertEqual(replaced.body.pairs, sourceV2.snapshot.pairs, "newer replacement was not atomic");
  assert(
    !replaced.rawBody.includes(TOKEN_B),
    "replacement leaked a pair/token from the prior complete declaration",
  );

  const replacementQuote = await requestJson(`${relayBase}/offer-files/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn: TOKEN_A, tokenOut: TOKEN_C, amountIn: "1000" }),
  });
  await capturePublic(session, publicCaptures, "replacement-v2-quote", replacementQuote);
  assert(replacementQuote.status === 200, "replacement quote must remain available");
  assert(replacementQuote.body.amountOut === "1500", "replacement quote interpolation drifted");
  assert(replacementQuote.body.version === V2, "replacement quote used a stale source version");

  await publish(sourceBase, secrets.write, V3, []);
  const sourceV3 = await sourceSnapshot(sourceBase, secrets.read);
  assertEqual(sourceV3.snapshot.pairs, [], "Offer Files explicit withdrawal was not atomic");
  await waitForRelaySnapshot(
    session,
    relayBase,
    publicCaptures,
    "withdrawal-v3",
    sourceV3.snapshot,
    sourceV2.snapshot,
  );
  const withdrawnTokens = await requestJson(`${relayBase}/offer-files/tokens`);
  await capturePublic(session, publicCaptures, "withdrawal-v3-tokens", withdrawnTokens);
  assertEqual(withdrawnTokens.body.tokens, [], "withdrawal left stale public tokens");
  const withdrawnQuote = await requestJson(`${relayBase}/offer-files/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn: TOKEN_A, tokenOut: TOKEN_C, amountIn: "1000" }),
  });
  await capturePublic(session, publicCaptures, "withdrawal-v3-quote", withdrawnQuote);
  assert(withdrawnQuote.status === 503, "withdrawal left a stale public quote");
  assert(withdrawnQuote.body?.error === "source_unavailable", "withdrawal quote failure drifted");
  const explicitAudit = await readAudit(relayBase);
  assertZeroExecutableActivity(explicitAudit);
  assert(explicitAudit.withdrawalReason === "explicit", "relay did not retain explicit withdrawal provenance");

  const expiryPairs = [{
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    levels: [
      { input: "100", output: "111" },
      { input: "200", output: "210" },
    ],
  }];
  await publish(sourceBase, secrets.write, V4, expiryPairs);
  const sourceV4 = await sourceSnapshot(sourceBase, secrets.read);
  await waitForRelaySnapshot(
    session,
    relayBase,
    publicCaptures,
    "expiry-v4-live",
    sourceV4.snapshot,
    sourceV3.snapshot,
  );
  const recoveredAudit = await readAudit(relayBase);
  assertZeroExecutableActivity(recoveredAudit);
  assert(recoveredAudit.withdrawalReason === null, "strictly newer live data did not recover withdrawal");

  const expiryMs = Date.parse(sourceV4.snapshot.expiresAt);
  assert(Number.isSafeInteger(expiryMs), "source returned a noncanonical expiry");
  await sleep(Math.max(0, expiryMs - Date.now()) + 450);

  const expiredSource = await sourceSnapshot(sourceBase, secrets.read);
  assert(expiredSource.snapshot.version === V4, "expiry changed the source version watermark");
  assertEqual(expiredSource.snapshot.pairs, [], "expired Offer Files source still exposed pairs");

  const expiredLevels = await requestJson(`${relayBase}/offer-files/levels`);
  await capturePublic(session, publicCaptures, "expiry-v4-levels", expiredLevels);
  assert(expiredLevels.status === 200, "expired relay levels must retain provenance");
  assertEqual(
    expiredLevels.body,
    expectedLevels(sourceV4.snapshot, []),
    "relay expiry did not retain the immutable source version/times",
  );
  const expiredTokens = await requestJson(`${relayBase}/offer-files/tokens`);
  await capturePublic(session, publicCaptures, "expiry-v4-tokens", expiredTokens);
  assertEqual(expiredTokens.body.tokens, [], "expiry left stale public tokens");
  const expiredQuote = await requestJson(`${relayBase}/offer-files/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "150" }),
  });
  await capturePublic(session, publicCaptures, "expiry-v4-quote", expiredQuote);
  assert(expiredQuote.status === 503, "expiry left a stale public quote");

  const finalAudit = await readAudit(relayBase);
  assertZeroExecutableActivity(finalAudit);
  assert(finalAudit.withdrawalReason === "expired", "relay did not record independent TTL expiry");
  assert(
    !FORBIDDEN_EXECUTION_FIELDS.test(JSON.stringify(publicCaptures)),
    "data-only public responses leaked an executable identifier",
  );

  // Let the 100 ms production poll cadence capture the source's expired
  // tombstone before reading the append-only recorder file.
  await sleep(300);
  const upstreamRaw = await readFile(session.upstreamEvidencePath, "utf8");
  const upstreamEvents = lines(upstreamRaw).map((line) => JSON.parse(line));
  const requests = upstreamEvents.filter((event) => event.phase === "request");
  const responses = upstreamEvents.filter((event) => event.phase === "response");
  assert(requests.length > 0 && responses.length > 0, "upstream recorder captured no complete exchange");
  const expectedAuthHash = sha256(`Bearer ${secrets.read}`);
  for (const request of requests) {
    assert(request.method === "GET", "relay puller used a non-GET upstream method");
    assert(
      request.path === `/v1/solver/liquidity?solver_id=${SOLVER_ID}`,
      `relay puller used an unexpected upstream path: ${request.path}`,
    );
    assert(request.authorizationPresent === true, "relay pull omitted its dedicated bearer");
    assert(request.authorizationSha256 === expectedAuthHash, "relay pull used the wrong bearer");
    assert(!Object.hasOwn(request, "authorization"), "recorder persisted a raw bearer secret");
  }

  const successfulBodies = responses
    .filter((event) => event.status === 200)
    .map((event) => JSON.parse(Buffer.from(event.bodyBase64, "base64").toString("utf8")));
  const saw = (version: string, pairCount: number): boolean => successfulBodies.some(
    (body) => body.snapshots?.[0]?.version === version && body.snapshots[0].pairs?.length === pairCount,
  );
  assert(saw(V1, 2), "upstream capture is missing the distinctive live v1 snapshot");
  assert(saw(V2, 1), "upstream capture is missing the atomic replacement v2 snapshot");
  assert(saw(V3, 0), "upstream capture is missing the explicit withdrawal v3 snapshot");
  assert(saw(V4, 1), "upstream capture is missing the live TTL-case v4 snapshot");
  assert(saw(V4, 0), "upstream capture is missing the expired v4 tombstone");

  const publicRaw = await readFile(session.publicEvidencePath, "utf8");
  return {
    versions: [V1, V2, V3, V4],
    sourceSolverId: SOLVER_ID,
    upstreamEvents: upstreamEvents.length,
    upstreamRequests: requests.length,
    publicResponses: publicCaptures.length,
    upstreamEvidenceSha256: sha256(upstreamRaw),
    publicEvidenceSha256: sha256(publicRaw),
    finalAudit,
  };
}

async function inspectProjectResources(
  session: Session,
  kind: "containers" | "networks" | "volumes",
): Promise<string[]> {
  const args = kind === "containers"
    ? ["ps", "-aq", "--filter", `label=com.docker.compose.project=${session.project}`]
    : kind === "networks"
      ? ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${session.project}`]
      : ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${session.project}`];
  const result = await runCommand("docker", args, session.children, { allowFailure: true });
  return lines(result.stdout);
}

async function cleanup(session: Session): Promise<CleanupEvidence> {
  const errors: string[] = [];
  for (const child of session.children) child.kill("SIGTERM");
  await releaseReservations(session).catch((error) => errors.push(String(error)));
  const composeDownAttempted = session.composeWritten;
  const down = composeDownAttempted
    ? await runCompose(
      session,
      ["down", "--volumes", "--remove-orphans", "--timeout", "15"],
      { allowFailure: true, timeoutMs: 120_000 },
    ).catch((error) => ({ code: 1, stdout: "", stderr: String(error) }))
    : null;
  if (down !== null && down.code !== 0) errors.push(`compose down failed: ${down.stderr}`);
  await sleep(CLEAN_SETTLE_MS);

  const containers = await inspectProjectResources(session, "containers");
  const networks = await inspectProjectResources(session, "networks");
  const volumes = await inspectProjectResources(session, "volumes");
  let portsReleased = true;
  for (const port of [session.sourcePort, session.relayPort]) {
    try {
      await assertPortCanBind(port);
    } catch (error) {
      portsReleased = false;
      errors.push(`host port ${port} was not released: ${String(error)}`);
    }
  }

  await rm(session.directory, { recursive: true, force: true }).catch((error) => {
    errors.push(`temporary directory cleanup failed: ${String(error)}`);
  });
  const temporaryDirectoryRemoved = !(await exists(session.directory));
  if (containers.length > 0) errors.push(`containers remain: ${containers.join(",")}`);
  if (networks.length > 0) errors.push(`networks remain: ${networks.join(",")}`);
  if (volumes.length > 0) errors.push(`volumes remain: ${volumes.join(",")}`);
  if (!temporaryDirectoryRemoved) errors.push("temporary directory remains");
  if (session.children.size > 0) errors.push("driver child processes remain");

  return {
    composeDownAttempted,
    downCode: down?.code ?? null,
    containers,
    networks,
    volumes,
    portsReleased,
    activeDriverProcesses: session.children.size,
    temporaryDirectoryRemoved,
    errors,
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--run-l5")) {
    throw new Error("refusing to start without explicit --run-l5");
  }
  assert(
    !(process.argv.includes("--signal-probe") &&
      process.argv.includes("--pre-compose-signal-probe")),
    "the post-start and pre-Compose signal probes are mutually exclusive",
  );

  let session: Session | null = null;
  let secrets: Secrets | null = null;
  let scenario: Record<string, unknown> | null = null;
  let scenarioError: Error | null = null;
  let cleanupEvidence: CleanupEvidence | null = null;
  let cleanupPromise: Promise<CleanupEvidence> | null = null;
  let sessionSetupPromise: Promise<Session> | null = null;
  let preComposeSetupPromise: Promise<Secrets> | null = null;
  let lifecycleStage = "before-session";
  let composeUpAttempted = false;

  const cleanOnce = (): Promise<CleanupEvidence | null> => {
    if (session === null) return Promise.resolve(null);
    cleanupPromise ??= cleanup(session);
    return cleanupPromise;
  };

  let terminatingSignal: NodeJS.Signals | null = null;
  let terminationPromise: Promise<never> | null = null;
  const terminateFromSignal = async (
    signal: NodeJS.Signals,
    stageAtSignal: string,
  ): Promise<never> => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    let evidence: CleanupEvidence | null = null;
    let cleanupError: string | null = null;
    let setupError: string | null = null;
    try {
      if (session === null && sessionSetupPromise !== null) {
        session = await sessionSetupPromise;
      }
      if (preComposeSetupPromise !== null) {
        await preComposeSetupPromise;
      }
    } catch (error) {
      setupError = error instanceof Error ? error.message : String(error);
    }
    try {
      evidence = await cleanOnce();
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolvePromise) => {
      process.stderr.write(
        `LINEAGE_L5_SIGNAL_RESULT ${JSON.stringify({
          signal,
          exitCode,
          stageAtSignal,
          project: session?.project ?? null,
          sourcePort: session?.sourcePort ?? null,
          relayPort: session?.relayPort ?? null,
          temporaryDirectory: session?.directory ?? null,
          composeWritten: session?.composeWritten ?? false,
          composeUpAttempted,
          cleanup: evidence,
          setupError,
          cleanupError,
        })}\n`,
        () => resolvePromise(),
      );
    });
    process.exit(exitCode);
    return await new Promise<never>(() => {});
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (terminatingSignal) return;
    terminatingSignal = signal;
    terminationPromise = terminateFromSignal(signal, lifecycleStage);
    void terminationPromise;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    lifecycleStage = "constructing-session";
    sessionSetupPromise = createSession();
    const activeSession = await sessionSetupPromise;
    session = activeSession;
    if (terminationPromise) await terminationPromise;

    lifecycleStage = "preparing-compose";
    preComposeSetupPromise = prepareSession(activeSession);
    const activeSecrets = await preComposeSetupPromise;
    secrets = activeSecrets;
    lifecycleStage = "pre-compose";
    if (terminationPromise) await terminationPromise;

    if (process.argv.includes("--pre-compose-signal-probe")) {
      assert(
        activeSession.composeWritten,
        "pre-Compose probe requires a completed Compose file",
      );
      assert(
        !activeSession.reservationsReleased,
        "pre-Compose probe requires held reservations",
      );
      await assertPortIsReserved(activeSession.sourcePort);
      await assertPortIsReserved(activeSession.relayPort);
      const [containers, networks, volumes] = await Promise.all([
        inspectProjectResources(activeSession, "containers"),
        inspectProjectResources(activeSession, "networks"),
        inspectProjectResources(activeSession, "volumes"),
      ]);
      assert(
        containers.length === 0 && networks.length === 0 && volumes.length === 0,
        "pre-Compose probe unexpectedly found project resources",
      );
      const composeMode = (await stat(activeSession.composePath)).mode & 0o777;
      assert(
        composeMode === 0o600,
        `credential-bearing Compose mode drifted to ${composeMode.toString(8)}`,
      );
      lifecycleStage = "pre-compose-probe-ready";
      await new Promise<void>((resolvePromise) => {
        process.stdout.write(
          `LINEAGE_L5_PRE_COMPOSE_SIGNAL_READY ${JSON.stringify({
            project: activeSession.project,
            sourcePort: activeSession.sourcePort,
            relayPort: activeSession.relayPort,
            temporaryDirectory: activeSession.directory,
            composeMode: "0600",
            reservationsHeld: true,
            composeUpAttempted,
            resources: { containers, networks, volumes },
          })}\n`,
          () => resolvePromise(),
        );
      });
      process.kill(process.pid, "SIGTERM");
      await new Promise<never>(() => {});
    }

    await releaseReservations(activeSession);
    lifecycleStage = "compose-starting";
    composeUpAttempted = true;
    await runCompose(activeSession, ["up", "--detach", "--remove-orphans"], {
      timeoutMs: 300_000,
    });
    lifecycleStage = "compose-running";
    if (process.argv.includes("--signal-probe")) {
      process.stdout.write(
        `LINEAGE_L5_SIGNAL_READY ${JSON.stringify({
          project: activeSession.project,
          sourcePort: activeSession.sourcePort,
          relayPort: activeSession.relayPort,
          temporaryDirectory: activeSession.directory,
        })}\n`,
      );
      process.kill(process.pid, "SIGTERM");
      await new Promise<never>(() => {});
    }
    lifecycleStage = "scenario-running";
    scenario = await runScenario(activeSession, activeSecrets);
    const successfulLogs = await runCompose(activeSession, ["logs", "--no-color"], {
      timeoutMs: 30_000,
    });
    assert(
      !successfulLogs.stdout.includes("Failed to install"),
      "a dependency lifecycle install failed inside the passing stack",
    );
    const installed = successfulLogs.stdout.match(/(\d+) packages installed/);
    assert(installed, "successful stack logs did not retain frozen-install evidence");
    scenario = {
      ...scenario,
      offerFilesInstalledPackages: Number(installed[1]),
      composeLogsSha256: sha256(successfulLogs.stdout),
    };
  } catch (error) {
    if (terminationPromise) await terminationPromise;
    scenarioError = error instanceof Error ? error : new Error(String(error));
    const logs = session?.composeWritten
      ? await runCompose(session, ["logs", "--no-color"], {
        allowFailure: true,
        timeoutMs: 30_000,
      }).catch((logError) => ({ code: 1, stdout: "", stderr: String(logError) }))
      : { code: 0, stdout: "", stderr: "Compose setup did not complete." };
    scenarioError = new Error(
      `${scenarioError.message}\nCompose logs:\n${logs.stdout}\n${logs.stderr}`,
      { cause: scenarioError },
    );
  } finally {
    lifecycleStage = "cleaning";
    cleanupEvidence = await cleanOnce();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (terminationPromise) await terminationPromise;

  const result = {
    project: session?.project ?? null,
    sourcePort: session?.sourcePort ?? null,
    relayPort: session?.relayPort ?? null,
    scenario,
    cleanup: cleanupEvidence,
    error: scenarioError?.message ?? null,
  };
  console.log(`LINEAGE_L5_RESULT ${JSON.stringify(result)}`);
  if (scenarioError) throw scenarioError;
  assert(secrets !== null, "lineage L5 secrets were not prepared");
  assert(cleanupEvidence !== null, "lineage L5 session was not constructed");
  assert(cleanupEvidence.errors.length === 0, cleanupEvidence.errors.join("; "));
}

await main();
