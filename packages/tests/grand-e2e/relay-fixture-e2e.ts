/**
 * Relay fixture runner — plan phases N0 and N4 of
 * `plans/00001-zswap-posted-price-solver.md`.
 *
 * Boots the Midnight Intents relay at its PINNED revision in Docker, and:
 *
 *   `--verify-n0` proves the wire contract the COW solver has to speak against
 *   it — bearer-authenticated WS upgrade, `solver-capabilities` and
 *   `price-levels` ingestion, `GET /tokens`, `POST /quote` interpolation over
 *   the FROZEN fixtures, and the drop-on-disconnect behaviour that makes
 *   re-pushing mandatory after every reconnect (FR-012).
 *
 *   `--verify-n4` drives the PRODUCTION relay client (`startRelayClient`) at
 *   the same relay from a seeded book cache, and proves registration, quotes
 *   equal to the derivation, "capabilities alone are not enough", the 1 s
 *   cadence, the fail-closed empty publication, reconnect-and-re-push across a
 *   relay restart, and the explicit withdrawal on a live socket.
 *
 *   RELAY_FIXTURE_SOURCE_REPO=/path/to/midnight-intents-swaps \
 *     bun run packages/tests/grand-e2e/relay-fixture-e2e.ts --verify-n0
 *     bun run packages/tests/grand-e2e/relay-fixture-e2e.ts --verify-n4
 *
 * Each gate owns its own project, its own ports, and its own teardown.
 *
 * Discipline, on a shared host: host ports are randomly selected from verified
 * free ports at or above 10000; every Docker resource is project-prefixed;
 * teardown is unconditional on success, failure, and signal; nothing is ever
 * pruned and no resource this run did not create is touched.
 *
 * The source repository is opened READ-ONLY. The harness clones it into a temp
 * directory and checks the pin out THERE — it never checks out, fetches, or
 * writes anything in the repository it was pointed at.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { interpolateQuote } from "../../solver-core/relay-ws-contract.ts";
import type { ApiZswap } from "../../solver-core/api-client.ts";
import { Book, bookOfferFromApi } from "../../solver/src/book.ts";
import { deriveLadderPush, type LadderCache } from "../../solver/src/ladder-source.ts";
import {
  startRelayClient,
  type RelayClientEvent,
  type RelayClientHandle,
} from "../../solver/src/relay-client.ts";

import {
  RELAY_FIXTURE_BOOT_MODE,
  RELAY_FIXTURE_PINS,
  RELAY_FIXTURE_READY_MARKER,
  RELAY_FIXTURE_REVISION,
  relayFixtureComposeSource,
  relayFixtureDockerfile,
  relayFixtureEntrypoint,
} from "./lib/relay-fixture-n0.ts";

const MIN_HOST_PORT = 10_000;
const MAX_HOST_PORT_EXCLUSIVE = 61_000;
const TEMP_PREFIX = "cow-relay-fixture-";
/** Each gate labels its own Docker resources, so a leak is attributable. */
const PROJECT_PREFIX = { n0: "cow-n0", n4: "cow-n4" } as const;
const CLEAN_SETTLE_MS = 5_000;
const READY_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 900_000;

const FIXTURE_ROOT = new URL(
  "../../solver-core/fixtures/relay-ws/v1/",
  import.meta.url,
);

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

interface Session {
  project: string;
  image: string;
  directory: string;
  composeFile: string;
  environmentFile: string;
  httpPort: number;
  wsPort: number;
  authToken: string;
}

interface CleanupEvidence {
  containers: string[];
  networks: string[];
  volumes: string[];
  images: string[];
}

const children = new Set<ChildProcessWithoutNullStreams>();
const emergencyCleanups = new Map<string, () => Promise<CleanupEvidence>>();
let handlingSignal = false;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function projectName(prefix: string): string {
  return `${prefix}-${process.pid}-${randomBytes(5).toString("hex")}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Reserve a verified-free loopback port at or above 10000. The listener is
 *  held until `release()` so no parallel run can claim the same port between
 *  the probe and `docker compose up`. */
async function reserveRandomPort(excluded: Set<number>): Promise<PortReservation> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const port = randomInt(MIN_HOST_PORT, MAX_HOST_PORT_EXCLUSIVE);
    if (excluded.has(port)) continue;
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
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
        // A failed listen has no listener to close.
      }
    }
  }
  throw new Error("could not reserve a random free host port at or above 10000");
}

async function assertPortIsFree(port: number, label: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void =>
      reject(new Error(`${label} port ${String(port)} is still bound after teardown: ${error.message}`));
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  await closeServer(server);
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean; cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...(options.env ?? {}) },
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const result = await new Promise<CommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  }).finally(() => {
    clearTimeout(timer);
    children.delete(child);
  });
  if (!options.allowFailure && result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(result.code)}${
        result.signal ? ` (${result.signal})` : ""
      }\n${result.stdout}\n${result.stderr}`.trim(),
    );
  }
  return result;
}

function composeArgs(session: Pick<Session, "project" | "composeFile" | "environmentFile">, args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    session.project,
    "--file",
    session.composeFile,
    "--env-file",
    session.environmentFile,
    ...args,
  ];
}

// ── HTTP and WebSocket probes ───────────────────────────────────────────────

interface JsonResponse {
  status: number;
  body: unknown;
}

async function getJson(url: string): Promise<JsonResponse> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}

async function postJson(url: string, payload: unknown): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Perform a raw WebSocket upgrade and report what the relay answered.
 * `upgraded` is the 101 path; otherwise `status` carries the refusal code, so
 * the bearer boundary is proven by the relay's own HTTP verdict rather than by
 * a socket that merely failed to open.
 */
function rawUpgrade(
  port: number,
  authorization: string | null,
): Promise<{ upgraded: boolean; status: number | null }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...(authorization === null ? {} : { Authorization: authorization }),
      },
    });
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("raw websocket upgrade timed out"));
    }, 10_000);
    request.on("upgrade", (_response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ upgraded: true, status: 101 });
    });
    // Some HTTP clients surface a successful handshake as a plain 101 response
    // rather than an `upgrade` event, so treat both as accepted.
    request.on("response", (response) => {
      clearTimeout(timer);
      const status = response.statusCode ?? null;
      response.resume();
      request.destroy();
      resolve({ upgraded: status === 101, status });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

interface SolverSocket {
  send: (message: unknown) => void;
  close: () => Promise<void>;
}

/** Connect as the relay expects a solver to: outbound, `Authorization: Bearer`. */
async function connectSolver(port: number, token: string): Promise<SolverSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/`, {
    headers: { Authorization: `Bearer ${token}` },
  } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("solver websocket did not open")), 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("solver websocket errored before opening"));
    }, { once: true });
  });
  return {
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    },
  };
}

/** Poll until `probe` reports true, so assertions never race the relay's own
 *  per-socket state updates. */
async function waitFor(label: string, probe: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

// ── Session lifecycle ───────────────────────────────────────────────────────

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_ROOT), "utf8"));
}

/**
 * Clone the pinned revision into a scratch directory.
 *
 * The source repository is only ever read: `git clone` opens it, and the
 * checkout happens in the CLONE. Nothing fetches, checks out, or writes there —
 * the standing rule is that `midnight-intents-swaps` is not modified.
 */
async function materializePinnedSource(sourceRepository: string, directory: string): Promise<string> {
  const clone = join(directory, "relay-source");
  await runCommand("git", ["-C", sourceRepository, "rev-parse", `${RELAY_FIXTURE_REVISION}^{commit}`], {
    timeoutMs: 60_000,
  });
  await runCommand("git", ["clone", "--quiet", "--no-checkout", sourceRepository, clone], {
    timeoutMs: 600_000,
  });
  await runCommand("git", ["-C", clone, "checkout", "--quiet", "--detach", RELAY_FIXTURE_REVISION], {
    timeoutMs: 300_000,
  });
  const head = (await runCommand("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
  assert(head === RELAY_FIXTURE_REVISION, `pinned clone is at ${head}, expected ${RELAY_FIXTURE_REVISION}`);
  const status = (await runCommand("git", ["-C", clone, "status", "--porcelain"])).stdout.trim();
  assert(status === "", `pinned clone is dirty:\n${status}`);
  return join(clone, RELAY_FIXTURE_PINS.workspaceSubdirectory);
}

async function dockerResources(project: string): Promise<CleanupEvidence> {
  const filter = ["--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"];
  const containers = await runCommand("docker", ["ps", "-a", ...filter], { allowFailure: true });
  const networks = await runCommand("docker", ["network", "ls", ...filter], { allowFailure: true });
  const volumes = await runCommand("docker", ["volume", "ls", ...filter], { allowFailure: true });
  const images = await runCommand(
    "docker",
    ["images", "--filter", `reference=${project}*`, "--format", "{{.Repository}}:{{.Tag}}"],
    { allowFailure: true },
  );
  return {
    containers: lines(containers.stdout),
    networks: lines(networks.stdout),
    volumes: lines(volumes.stdout),
    images: lines(images.stdout),
  };
}

/**
 * Unconditional teardown. Removes only resources this run named, never prunes,
 * and reports what (if anything) survived so a leak is a loud failure rather
 * than a silent one.
 */
function createCleanup(
  session: Session,
  reservations: PortReservation[],
): () => Promise<CleanupEvidence> {
  let done: Promise<CleanupEvidence> | null = null;
  return () => {
    if (done) return done;
    done = (async () => {
      await runCommand(
        "docker",
        composeArgs(session, ["down", "--volumes", "--remove-orphans", "--timeout", "10"]),
        { allowFailure: true, timeoutMs: 180_000 },
      );
      await runCommand("docker", ["image", "rm", "--force", session.image], {
        allowFailure: true,
        timeoutMs: 120_000,
      });
      await rm(session.directory, { recursive: true, force: true });
      for (const reservation of reservations) await reservation.release();
      const evidence = await dockerResources(session.project);
      const stray = await runCommand(
        "docker",
        ["images", "--filter", `reference=${session.image}`, "--format", "{{.ID}}"],
        { allowFailure: true },
      );
      evidence.images.push(...lines(stray.stdout));
      emergencyCleanups.delete(session.project);
      return evidence;
    })();
    return done;
  };
}

async function createSession(
  prefix: string,
): Promise<{ session: Session; cleanup: () => Promise<CleanupEvidence>; reservations: PortReservation[] }> {
  const excluded = new Set<number>();
  const httpReservation = await reserveRandomPort(excluded);
  const wsReservation = await reserveRandomPort(excluded);
  const reservations = [httpReservation, wsReservation];
  const project = projectName(prefix);
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const session: Session = {
    project,
    image: `${project}-relay:fixture`,
    directory,
    composeFile: join(directory, "compose.yaml"),
    environmentFile: join(directory, "compose.env"),
    httpPort: httpReservation.port,
    wsPort: wsReservation.port,
    // The relay refuses a SOLVER_AUTH_TOKEN under 32 characters, so this is
    // both a real secret and a real config-boundary exercise.
    authToken: randomBytes(32).toString("hex"),
  };
  const cleanup = createCleanup(session, reservations);
  emergencyCleanups.set(project, cleanup);
  await writeFile(
    session.environmentFile,
    `SOLVER_AUTH_TOKEN=${session.authToken}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    session.composeFile,
    relayFixtureComposeSource({
      image: session.image,
      httpHostPort: session.httpPort,
      wsHostPort: session.wsPort,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return { session, cleanup, reservations };
}

async function buildAndStart(
  session: Session,
  sourceRepository: string,
  releasePorts: () => Promise<void>,
): Promise<void> {
  const context = await materializePinnedSource(sourceRepository, session.directory);
  await writeFile(join(context, "relay-fixture.Dockerfile"), relayFixtureDockerfile(), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(context, "relay-fixture-entrypoint.mjs"), relayFixtureEntrypoint(), {
    encoding: "utf8",
    mode: 0o600,
  });
  await runCommand(
    "docker",
    [
      "build",
      "--file",
      join(context, "relay-fixture.Dockerfile"),
      "--tag",
      session.image,
      "--label",
      `com.docker.compose.project=${session.project}`,
      context,
    ],
    { timeoutMs: BUILD_TIMEOUT_MS },
  );
  // Hand the reserved ports over to Docker only now: the probe listeners proved
  // the ports free and kept any parallel run from claiming them during the
  // build, but they must be closed before the daemon can bind them.
  await releasePorts();
  await runCommand("docker", composeArgs(session, ["up", "--detach", "--wait", "--wait-timeout", "120"]), {
    timeoutMs: READY_TIMEOUT_MS,
  });
  const logs = await runCommand("docker", composeArgs(session, ["logs", "relay-fixture"]), {
    allowFailure: true,
  });
  assert(
    logs.stdout.includes(RELAY_FIXTURE_READY_MARKER),
    `relay fixture never printed ${RELAY_FIXTURE_READY_MARKER}:\n${logs.stdout}\n${logs.stderr}`,
  );
  assert(
    /WS server listening/.test(logs.stdout),
    `relay fixture never reported its WS listener:\n${logs.stdout}`,
  );
}

// ── The N0 gate ─────────────────────────────────────────────────────────────

interface GateEvidence {
  project: string;
  image: string;
  httpPort: number;
  wsPort: number;
  revision: string;
  bootMode: string;
  tokens: string[];
  quotes: Array<{ amountIn: string; status: number; amountOut: string | null }>;
  upgrades: Array<{ authorization: string; status: number | null; upgraded: boolean }>;
}

async function assertRelayContract(session: Session): Promise<GateEvidence> {
  const httpBase = `http://127.0.0.1:${String(session.httpPort)}`;
  const capabilities = fixture("solver-capabilities.json");
  const priceLevels = fixture("price-levels.json");
  const swap = fixture("swap.json");
  const pair = priceLevels.levels[0];

  // 1. The bearer boundary, proven by the relay's own upgrade verdict.
  const upgrades: GateEvidence["upgrades"] = [];
  for (const [label, header] of [
    ["absent", null],
    ["wrong", `Bearer ${randomBytes(32).toString("hex")}`],
    ["malformed", session.authToken],
    ["truncated", `Bearer ${session.authToken.slice(0, -1)}`],
  ] as const) {
    const result = await rawUpgrade(session.wsPort, header);
    assert(!result.upgraded, `a ${label} bearer was accepted at the WS upgrade`);
    assert(result.status === 401, `a ${label} bearer returned ${String(result.status)}, expected 401`);
    upgrades.push({ authorization: label, status: result.status, upgraded: result.upgraded });
  }
  const accepted = await rawUpgrade(session.wsPort, `Bearer ${session.authToken}`);
  assert(accepted.upgraded, "the correct bearer was refused at the WS upgrade");
  upgrades.push({ authorization: "correct", status: accepted.status, upgraded: accepted.upgraded });

  // 2. No solver connected: no tokens, and quoting refuses rather than guessing.
  const emptyTokens = await getJson(`${httpBase}/tokens`);
  assert(emptyTokens.status === 200, `GET /tokens returned ${String(emptyTokens.status)}`);
  assert(
    JSON.stringify((emptyTokens.body as { tokens: string[] }).tokens) === "[]",
    `GET /tokens was not empty before any solver connected: ${JSON.stringify(emptyTokens.body)}`,
  );

  // 3. A registered solver: capabilities reach GET /tokens verbatim.
  const solver = await connectSolver(session.wsPort, session.authToken);
  solver.send(capabilities);
  solver.send(priceLevels);
  await waitFor("the relay to publish the registered capabilities", async () => {
    const response = await getJson(`${httpBase}/tokens`);
    return JSON.stringify((response.body as { tokens: string[] }).tokens.slice().sort()) ===
      JSON.stringify([...capabilities.tokenIds].sort());
  });
  const tokens = (await getJson(`${httpBase}/tokens`)).body as { tokens: string[] };

  // 4. The frozen ladder quotes exactly what the frozen `swap` fixture records.
  //    This is the load-bearing assertion of N0: our pinned wire fixtures and
  //    the real relay agree, byte for byte, on the same numbers.
  const quotes: GateEvidence["quotes"] = [];
  const quoteFor = async (amountIn: string): Promise<JsonResponse> =>
    postJson(`${httpBase}/quote`, { tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, amountIn });

  await waitFor("the pushed ladder to become quotable", async () => {
    const response = await quoteFor(swap.amountIn);
    return response.status === 200;
  });

  for (const rung of pair.levels) {
    const response = await quoteFor(rung.input);
    assert(response.status === 200, `rung ${rung.input} quoted ${String(response.status)}`);
    const amountOut = (response.body as { amountOut: string }).amountOut;
    assert(
      amountOut === rung.output,
      `rung ${rung.input} quoted ${amountOut}, expected the frozen ${rung.output}`,
    );
    quotes.push({ amountIn: rung.input, status: response.status, amountOut });
  }

  const interpolated = await quoteFor(swap.amountIn);
  assert(interpolated.status === 200, `the frozen swap size quoted ${String(interpolated.status)}`);
  const interpolatedOut = (interpolated.body as { amountOut: string }).amountOut;
  assert(
    interpolatedOut === swap.amountOut,
    `the relay interpolated ${interpolatedOut} for ${swap.amountIn}, but swap.json freezes ${swap.amountOut}`,
  );
  quotes.push({ amountIn: swap.amountIn, status: 200, amountOut: interpolatedOut });

  // 5. Outside the ladder is a refusal, not a guess. Below the first rung and
  //    above the last are both 422 `unfulfillable` — the reason a small-trade
  //    rung has to be inventory-backed rather than book-derived.
  for (const outside of [
    (BigInt(pair.levels[0].input) - 1n).toString(),
    (BigInt(pair.levels[pair.levels.length - 1].input) + 1n).toString(),
  ]) {
    const response = await quoteFor(outside);
    assert(response.status === 422, `size ${outside} returned ${String(response.status)}, expected 422`);
    assert(
      (response.body as { error: string }).error === "unfulfillable",
      `size ${outside} returned ${JSON.stringify(response.body)}`,
    );
    quotes.push({ amountIn: outside, status: response.status, amountOut: null });
  }

  // 6. The direction the frozen ladder omits is not quotable at all — omission
  //    is how a pair the cache cannot honour stays unpublished (FR-014).
  const reverse = await postJson(`${httpBase}/quote`, {
    tokenIn: pair.tokenOut,
    tokenOut: pair.tokenIn,
    amountIn: swap.amountIn,
  });
  assert(reverse.status === 503, `the omitted direction returned ${String(reverse.status)}, expected 503`);
  assert(
    (reverse.body as { error: string }).error === "no_solver",
    `the omitted direction returned ${JSON.stringify(reverse.body)}`,
  );

  // 7. Disconnect drops BOTH capabilities and ladders at the relay. This is the
  //    fact that makes re-pushing on every reconnect mandatory (FR-012) — the
  //    state lives on the socket entry, not on a solver identity.
  await solver.close();
  await waitFor("the relay to forget a disconnected solver", async () => {
    const listed = await getJson(`${httpBase}/tokens`);
    const quoted = await quoteFor(swap.amountIn);
    return (
      JSON.stringify((listed.body as { tokens: string[] }).tokens) === "[]" && quoted.status === 503
    );
  });

  // 8. Reconnecting and re-pushing restores quotability with the same numbers.
  const reconnected = await connectSolver(session.wsPort, session.authToken);
  reconnected.send(capabilities);
  reconnected.send(priceLevels);
  await waitFor("the reconnected solver to become quotable again", async () => {
    const response = await quoteFor(swap.amountIn);
    return (
      response.status === 200 && (response.body as { amountOut: string }).amountOut === swap.amountOut
    );
  });
  await reconnected.close();

  return {
    project: session.project,
    image: session.image,
    httpPort: session.httpPort,
    wsPort: session.wsPort,
    revision: RELAY_FIXTURE_REVISION,
    bootMode: RELAY_FIXTURE_BOOT_MODE,
    tokens: tokens.tokens,
    quotes,
    upgrades,
  };
}

/** The fixture set must parse and hash to the recorded aggregate before any
 *  container starts — a drifted fixture must not be blamed on the relay. */
function assertFixtureManifest(): { aggregate: string; files: number } {
  const manifest = readFileSync(new URL("MANIFEST.sha256", FIXTURE_ROOT), "utf8");
  const entries = lines(manifest).map((line) => {
    const match = /^([0-9a-f]{64})\s{2}(\S+)$/.exec(line);
    assert(match, `malformed manifest line: ${line}`);
    return { sha256: match![1]!, name: match![2]! };
  });
  assert(entries.length === 7, `expected 7 frozen wire fixtures, found ${String(entries.length)}`);
  for (const entry of entries) {
    const raw = readFileSync(new URL(entry.name, FIXTURE_ROOT), "utf8");
    const actual = createHash("sha256").update(raw).digest("hex");
    assert(actual === entry.sha256, `${entry.name} is ${actual}, manifest says ${entry.sha256}`);
    JSON.parse(raw);
  }
  const rebuilt = entries
    .map((entry) => `${entry.sha256}  ${entry.name}`)
    .slice()
    .sort()
    .map((line) => `${line}\n`)
    .join("");
  assert(manifest === rebuilt, "MANIFEST.sha256 is not in lexical line order");
  return { aggregate: createHash("sha256").update(manifest).digest("hex"), files: entries.length };
}

function assertCleanup(evidence: CleanupEvidence): void {
  const leaked = Object.entries(evidence).filter(([, values]) => values.length > 0);
  assert(
    leaked.length === 0,
    `teardown left Docker resources behind: ${leaked.map(([kind, values]) => `${kind}=${values.join(",")}`).join("; ")}`,
  );
}

async function verifyN0(): Promise<void> {
  const sourceRepository = process.env["RELAY_FIXTURE_SOURCE_REPO"];
  assert(
    sourceRepository && sourceRepository.trim() !== "",
    "RELAY_FIXTURE_SOURCE_REPO must point at a local midnight-intents-swaps clone containing " +
      `${RELAY_FIXTURE_REVISION}. It is opened read-only and is never checked out or written to.`,
  );

  const manifest = assertFixtureManifest();
  console.log(
    `[n0] frozen wire fixtures: ${String(manifest.files)} files, aggregate SHA-256 ${manifest.aggregate}`,
  );

  const { session, cleanup, reservations } = await createSession(PROJECT_PREFIX.n0);
  console.log(
    `[n0] project=${session.project} httpPort=${String(session.httpPort)} wsPort=${String(session.wsPort)}`,
  );
  let evidence: GateEvidence | null = null;
  let failure: unknown;
  try {
    await buildAndStart(session, sourceRepository!, async () => {
      for (const reservation of reservations) await reservation.release();
    });
    evidence = await assertRelayContract(session);
  } catch (error) {
    failure = error;
    const logs = await runCommand("docker", composeArgs(session, ["logs", "--no-color", "--tail", "200"]), {
      allowFailure: true,
    });
    console.error(`[n0] failure diagnostics:\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    const cleanupEvidence = await cleanup();
    await sleep(CLEAN_SETTLE_MS);
    const settled = await dockerResources(session.project);
    if (!failure) {
      assertCleanup(cleanupEvidence);
      assertCleanup(settled);
      await assertPortIsFree(session.httpPort, "http");
      await assertPortIsFree(session.wsPort, "ws");
    }
    console.log(
      `[n0] teardown: containers=${String(cleanupEvidence.containers.length)} ` +
        `networks=${String(cleanupEvidence.networks.length)} ` +
        `volumes=${String(cleanupEvidence.volumes.length)} ` +
        `images=${String(cleanupEvidence.images.length)}; ` +
        `after ${String(CLEAN_SETTLE_MS)}ms settle: containers=${String(settled.containers.length)} ` +
        `networks=${String(settled.networks.length)} volumes=${String(settled.volumes.length)} ` +
        `images=${String(settled.images.length)}`,
    );
  }
  if (failure) throw failure;
  console.log(`[n0] evidence: ${JSON.stringify(evidence)}`);
  console.log("[n0] N0 GATE PASS");
}

// ── The N4 gate ─────────────────────────────────────────────────────────────
//
// Plan phase N4: the PRODUCTION relay client (`startRelayClient`) is driven
// against the same pinned relay N0 froze the wire contract from. Nothing here
// hand-builds a frame: every byte on the socket comes from the client, whose
// frames come from `deriveLadderPush` over a seeded book cache. What the relay
// then answers on `POST /quote` is the acceptance evidence.
//
// Deliberately NOT proven here (it belongs to N5/N6, and the fixture is
// chainless — Q-N0-1: A): `POST /intent`, `userTx.merge(solverTx)`,
// submission, and the `tx-submitted`/`submit-failed` broadcast path.

/** Token ids: the frozen fixture's pair, plus a second pair used only for the
 *  "capabilities alone are not enough" check. */
const N4_TOKEN_A = `01${"00".repeat(31)}`;
const N4_TOKEN_B = `02${"00".repeat(31)}`;
const N4_TOKEN_D = `0d${"00".repeat(31)}`;
const N4_TOKEN_E = `0e${"00".repeat(31)}`;

const N4_NOW = Date.parse("2026-06-01T12:00:00.000Z");
const N4_EXPIRES = "2026-06-01T13:00:00.000Z";
const N4_EXPIRY_MARGIN_SECONDS = 60;
const N4_MAX_PARALLEL_SWAPS = 8;

const n4Row = (offerId: string, givesA: string, wantsB: string): ApiZswap =>
  ({
    version: 1,
    offerId,
    computed: {
      gives: [{ token: N4_TOKEN_A, amount: givesA, type: "SHIELDED" }],
      wants: [{ token: N4_TOKEN_B, amount: wantsB, type: "SHIELDED" }],
      expiresAt: N4_EXPIRES,
      firstSeenAt: "2026-06-01T11:00:00.000Z",
      inputNullifiers: [offerId],
      status: "live",
    },
  }) as ApiZswap;

/** The canonical Q-R2-3 book: `-10A +10B`, `-5A +5B`, `-20A +10B`. */
const N4_CANONICAL: ApiZswap[] = [
  n4Row("11".repeat(32), "10", "10"),
  n4Row("22".repeat(32), "5", "5"),
  n4Row("33".repeat(32), "20", "10"),
];

interface N4Cache extends LadderCache {
  setCurrent: (value: boolean) => void;
}

function n4Cache(rows: ApiZswap[]): { cache: N4Cache; book: Book } {
  const book = new Book();
  for (const entry of rows) {
    const offer = bookOfferFromApi(entry);
    assert(offer !== null, `seeded row ${entry.offerId} did not parse into the book`);
    book.upsert(offer!);
  }
  let current = true;
  return {
    book,
    cache: {
      book,
      isCurrent: () => current,
      setCurrent: (value: boolean) => {
        current = value;
      },
    },
  };
}

const n4Derive = (cache: LadderCache) =>
  deriveLadderPush(cache, {
    nowMs: N4_NOW,
    expiryMarginSeconds: N4_EXPIRY_MARGIN_SECONDS,
    maxParallelSwaps: N4_MAX_PARALLEL_SWAPS,
  });

interface N4Evidence {
  project: string;
  httpPort: number;
  wsPort: number;
  revision: string;
  bootMode: string;
  registeredTokens: string[];
  rungQuotes: Array<{ amountIn: string; amountOut: string }>;
  interpolatedQuotes: Array<{ amountIn: string; amountOut: string; contract: string }>;
  capabilitiesOnly: { tokens: string[]; withoutLadder: number; withLadder: string };
  bookChange: { before: string; after: string };
  failClosed: { quoteStatus: number; tokens: number };
  reconnect: { connectionsBefore: number; connectionsAfter: number; quoteAfterRestart: string };
  withdrawal: { quoteStatus: number; tokens: number; stillConnected: boolean };
}

async function assertRelayClientContract(session: Session): Promise<N4Evidence> {
  const httpBase = `http://127.0.0.1:${String(session.httpPort)}`;
  const { cache, book } = n4Cache(N4_CANONICAL);
  const derived = n4Derive(cache);
  const pair = derived.priceLevels.levels[0]!;
  assert(
    derived.capabilities.tokenIds.length === 2 && pair.levels.length === 3,
    `the seeded book did not derive the canonical ladder: ${JSON.stringify(derived.priceLevels)}`,
  );

  const quoteFor = async (
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
  ): Promise<JsonResponse> => postJson(`${httpBase}/quote`, { tokenIn, tokenOut, amountIn });
  const quoteOnPair = (amountIn: string): Promise<JsonResponse> =>
    quoteFor(pair.tokenIn, pair.tokenOut, amountIn);
  const listTokens = async (): Promise<string[]> =>
    ((await getJson(`${httpBase}/tokens`)).body as { tokens: string[] }).tokens;

  const events: RelayClientEvent[] = [];
  let client: RelayClientHandle | null = null;
  try {
    client = startRelayClient({
      url: `ws://127.0.0.1:${String(session.wsPort)}/`,
      authToken: session.authToken,
      cache,
      ladder: {
        expiryMarginSeconds: N4_EXPIRY_MARGIN_SECONDS,
        maxParallelSwaps: N4_MAX_PARALLEL_SWAPS,
      },
      // Injected clock: the published bytes must not depend on when the gate
      // happens to run.
      nowMs: () => N4_NOW,
      onEvent: (event) => {
        events.push(event);
        if (event.severity !== "info") console.log(`[n4] ${event.severity}: ${event.message}`);
      },
    });

    // 1. Registration: the client's capabilities frame reaches GET /tokens.
    await waitFor("the client's capabilities to register", async () => {
      const tokens = await listTokens();
      return (
        JSON.stringify(tokens.slice().sort()) ===
        JSON.stringify([...derived.capabilities.tokenIds].sort())
      );
    });
    const registeredTokens = await listTokens();

    // 2. Every derived rung quotes exactly what the derivation promised, and
    //    every interpolated size quotes exactly what the frozen contract's
    //    `interpolateQuote` says over OUR ladder. This is the load-bearing
    //    assertion: the relay's real behaviour reproduces the function the
    //    derivation is held to.
    await waitFor("the pushed ladder to become quotable", async () => {
      const response = await quoteOnPair(pair.levels[0]!.input);
      return response.status === 200;
    });
    const rungQuotes: N4Evidence["rungQuotes"] = [];
    for (const rung of pair.levels) {
      const response = await quoteOnPair(rung.input);
      assert(response.status === 200, `rung ${rung.input} quoted ${String(response.status)}`);
      const amountOut = (response.body as { amountOut: string }).amountOut;
      assert(
        amountOut === rung.output,
        `rung ${rung.input} quoted ${amountOut}, the derivation published ${rung.output}`,
      );
      rungQuotes.push({ amountIn: rung.input, amountOut });
    }
    const interpolatedQuotes: N4Evidence["interpolatedQuotes"] = [];
    for (const amountIn of ["12", "17", "23"]) {
      const response = await quoteOnPair(amountIn);
      assert(response.status === 200, `size ${amountIn} quoted ${String(response.status)}`);
      const amountOut = (response.body as { amountOut: string }).amountOut;
      const contract = interpolateQuote(pair.levels, BigInt(amountIn));
      assert(
        contract !== null && contract.toString() === amountOut,
        `size ${amountIn}: relay said ${amountOut}, interpolateQuote says ${String(contract)}`,
      );
      interpolatedQuotes.push({ amountIn, amountOut, contract: String(contract) });
    }
    // Outside the ladder is a refusal, and the direction the book cannot back
    // is not quotable at all (FR-014's omission rule, on the wire).
    for (const outside of ["9", "26"]) {
      const response = await quoteOnPair(outside);
      assert(response.status === 422, `size ${outside} returned ${String(response.status)}`);
    }
    const reverse = await quoteFor(pair.tokenOut, pair.tokenIn, "12");
    assert(
      reverse.status === 503 && (reverse.body as { error: string }).error === "no_solver",
      `the omitted direction returned ${String(reverse.status)} ${JSON.stringify(reverse.body)}`,
    );

    // 3. "Capabilities alone are not enough" (FR-012). A second solver
    //    registers tokens with NO ladder: the relay lists its tokens but
    //    refuses to quote the pair until a ladder for that DIRECTED pair
    //    arrives. Driven from a raw socket on purpose — the production client
    //    always pushes both, so only a hand-driven peer can separate them.
    const capabilitiesOnly = await connectSolver(session.wsPort, session.authToken);
    let capabilitiesOnlyEvidence: N4Evidence["capabilitiesOnly"];
    try {
      capabilitiesOnly.send({
        type: "solver-capabilities",
        tokenIds: [N4_TOKEN_D, N4_TOKEN_E],
        maxParallelSwaps: 1,
      });
      await waitFor("the capability-only solver's tokens to be listed", async () => {
        const tokens = await listTokens();
        return tokens.includes(N4_TOKEN_D) && tokens.includes(N4_TOKEN_E);
      });
      const withoutLadder = await quoteFor(N4_TOKEN_D, N4_TOKEN_E, "10");
      assert(
        withoutLadder.status === 503 &&
          (withoutLadder.body as { error: string }).error === "no_solver",
        `capabilities alone were routable: ${String(withoutLadder.status)} ` +
          `${JSON.stringify(withoutLadder.body)}`,
      );
      capabilitiesOnly.send({
        type: "price-levels",
        levels: [
          {
            tokenIn: N4_TOKEN_D,
            tokenOut: N4_TOKEN_E,
            levels: [
              { input: "10", output: "20" },
              { input: "20", output: "30" },
            ],
          },
        ],
      });
      await waitFor("the same solver to become routable once its ladder arrives", async () => {
        const response = await quoteFor(N4_TOKEN_D, N4_TOKEN_E, "10");
        return response.status === 200;
      });
      const withLadder = await quoteFor(N4_TOKEN_D, N4_TOKEN_E, "10");
      capabilitiesOnlyEvidence = {
        tokens: [N4_TOKEN_D, N4_TOKEN_E],
        withoutLadder: withoutLadder.status,
        withLadder: (withLadder.body as { amountOut: string }).amountOut,
      };
    } finally {
      await capabilitiesOnly.close();
    }
    await waitFor("the capability-only solver to disappear again", async () => {
      const tokens = await listTokens();
      return !tokens.includes(N4_TOKEN_D);
    });

    // 4. A book change reaches the relay in the next push (FR-014's cadence).
    const before = (await quoteOnPair("25")).body as { amountOut: string };
    book.upsert(bookOfferFromApi(n4Row("44".repeat(32), "40", "10"))!);
    const grown = n4Derive(cache).priceLevels.levels[0]!;
    assert(grown.levels.length === 4, "the changed book did not derive a deeper ladder");
    await waitFor("the changed book to reach the relay", async () => {
      const response = await quoteOnPair(grown.levels[3]!.input);
      return (
        response.status === 200 &&
        (response.body as { amountOut: string }).amountOut === grown.levels[3]!.output
      );
    });
    const after = (await quoteOnPair(grown.levels[3]!.input)).body as { amountOut: string };

    // 5. Fail closed: a cache that stops being current publishes the explicit
    //    EMPTY pair, so the relay stops quoting instead of serving a stale
    //    ladder it has no way to expire (FR-005).
    cache.setCurrent(false);
    await waitFor("the fail-closed withdrawal to reach the relay", async () => {
      const response = await quoteOnPair("12");
      const tokens = await listTokens();
      return response.status === 503 && tokens.length === 0;
    });
    const failClosed = {
      quoteStatus: (await quoteOnPair("12")).status,
      tokens: (await listTokens()).length,
    };
    cache.setCurrent(true);
    await waitFor("the ladder to return once the cache is current again", async () => {
      const response = await quoteOnPair("12");
      return response.status === 200;
    });

    // 6. Disconnect/reconnect. The relay is restarted, so it forgets every
    //    solver exactly as a dropped socket does; nothing re-pushes by hand.
    const connectionsBefore = client.stats().connections;
    await runCommand("docker", composeArgs(session, ["restart", "--timeout", "10", "relay-fixture"]), {
      timeoutMs: 180_000,
    });
    await waitFor("the restarted relay to answer", async () => {
      const response = await getJson(`${httpBase}/tokens`);
      return response.status === 200;
    }, 60_000);
    await waitFor("the client to reconnect and re-push", async () => {
      const tokens = await listTokens();
      const response = await quoteOnPair("12");
      return tokens.length === 2 && response.status === 200;
    }, 60_000);
    const quoteAfterRestart = ((await quoteOnPair("12")).body as { amountOut: string }).amountOut;
    const connectionsAfter = client.stats().connections;
    assert(
      connectionsAfter > connectionsBefore,
      `the client did not reconnect: ${connectionsBefore} → ${connectionsAfter} connections`,
    );

    // 7. R-41: the explicit withdrawal, observed on a socket that is STILL
    //    OPEN. Proving it through `stop()` alone would be ambiguous — the
    //    disconnect withdraws us too.
    await client.withdraw();
    await waitFor("the explicit withdrawal to stop quoting", async () => {
      const response = await quoteOnPair("12");
      const tokens = await listTokens();
      return response.status === 503 && tokens.length === 0;
    });
    const withdrawal = {
      quoteStatus: (await quoteOnPair("12")).status,
      tokens: (await listTokens()).length,
      stillConnected: client.stats().connected,
    };
    assert(
      withdrawal.stillConnected,
      "the withdrawal was not proven on a live socket — the client had already disconnected",
    );

    return {
      project: session.project,
      httpPort: session.httpPort,
      wsPort: session.wsPort,
      revision: RELAY_FIXTURE_REVISION,
      bootMode: RELAY_FIXTURE_BOOT_MODE,
      registeredTokens,
      rungQuotes,
      interpolatedQuotes,
      capabilitiesOnly: capabilitiesOnlyEvidence,
      bookChange: { before: before.amountOut, after: after.amountOut },
      failClosed,
      reconnect: { connectionsBefore, connectionsAfter, quoteAfterRestart },
      withdrawal,
    };
  } finally {
    if (client) await client.stop();
  }
}

async function verifyN4(): Promise<void> {
  const sourceRepository = process.env["RELAY_FIXTURE_SOURCE_REPO"];
  assert(
    sourceRepository && sourceRepository.trim() !== "",
    "RELAY_FIXTURE_SOURCE_REPO must point at a local midnight-intents-swaps clone containing " +
      `${RELAY_FIXTURE_REVISION}. It is opened read-only and is never checked out or written to.`,
  );

  const { session, cleanup, reservations } = await createSession(PROJECT_PREFIX.n4);
  console.log(
    `[n4] project=${session.project} httpPort=${String(session.httpPort)} wsPort=${String(session.wsPort)}`,
  );
  let evidence: N4Evidence | null = null;
  let failure: unknown;
  try {
    await buildAndStart(session, sourceRepository!, async () => {
      for (const reservation of reservations) await reservation.release();
    });
    evidence = await assertRelayClientContract(session);
  } catch (error) {
    failure = error;
    const logs = await runCommand("docker", composeArgs(session, ["logs", "--no-color", "--tail", "200"]), {
      allowFailure: true,
    });
    console.error(`[n4] failure diagnostics:\n${logs.stdout}\n${logs.stderr}`);
  } finally {
    const cleanupEvidence = await cleanup();
    await sleep(CLEAN_SETTLE_MS);
    const settled = await dockerResources(session.project);
    if (!failure) {
      assertCleanup(cleanupEvidence);
      assertCleanup(settled);
      await assertPortIsFree(session.httpPort, "http");
      await assertPortIsFree(session.wsPort, "ws");
    }
    console.log(
      `[n4] teardown: containers=${String(cleanupEvidence.containers.length)} ` +
        `networks=${String(cleanupEvidence.networks.length)} ` +
        `volumes=${String(cleanupEvidence.volumes.length)} ` +
        `images=${String(cleanupEvidence.images.length)}; ` +
        `after ${String(CLEAN_SETTLE_MS)}ms settle: containers=${String(settled.containers.length)} ` +
        `networks=${String(settled.networks.length)} volumes=${String(settled.volumes.length)} ` +
        `images=${String(settled.images.length)}`,
    );
  }
  if (failure) throw failure;
  console.log(`[n4] evidence: ${JSON.stringify(evidence)}`);
  console.log("[n4] N4 GATE PASS");
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  if (handlingSignal) return;
  handlingSignal = true;
  console.error(`[n0] received ${signal}; tearing down`);
  for (const cleanup of [...emergencyCleanups.values()]) {
    try {
      await cleanup();
    } catch (error) {
      console.error(`[n0] cleanup after ${signal} failed: ${String(error)}`);
    }
  }
  for (const child of children) child.kill("SIGKILL");
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.on("SIGINT", () => void handleSignal("SIGINT"));
process.on("SIGTERM", () => void handleSignal("SIGTERM"));

const invokedDirectly = process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const wanted = process.argv.slice(2);
  const known = ["--verify-n0", "--verify-n4"];
  if (wanted.some((argument) => !known.includes(argument))) {
    console.error("usage: relay-fixture-e2e.ts [--verify-n0] [--verify-n4]");
    process.exit(2);
  }
  // Each gate owns its own fixture session — separate projects, separate
  // ports, separate teardown — so they never share relay state.
  if (wanted.length === 0 || wanted.includes("--verify-n0")) await verifyN0();
  if (wanted.includes("--verify-n4")) await verifyN4();
}
