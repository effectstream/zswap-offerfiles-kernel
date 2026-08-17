import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "../../../..");
const HARNESS_PATH = join(import.meta.dir, "solver-offerfiles-harness-service.mjs");
const NTP_PACKAGE_PATH = join(
  REPOSITORY_ROOT,
  "node_modules/.bun/node_modules/ntp-time-sync",
);
const NTP_EPOCH_SECONDS = 2_208_988_800;
const NTP_FRACTION_SCALE = 2 ** 32;
const CHANNEL = "ntp-responder-test";

const localRequire = createRequire(import.meta.url);
const ntpPackage = localRequire(NTP_PACKAGE_PATH) as {
  NtpTimeSync: new (options: {
    servers: string[];
    sampleCount: number;
    replyTimeout: number;
  }) => {
    getTime(force?: boolean): Promise<{ now: Date; offset: number; precision: number }>;
  };
};
const ntpPackageManifest = localRequire(join(NTP_PACKAGE_PATH, "package.json")) as {
  version: string;
};

type HarnessChild = ReturnType<typeof Bun.spawn>;
type JsonObject = Record<string, unknown>;

interface RecorderFailure {
  matches(event: JsonObject): boolean;
  delayMs?: number;
  status?: number;
}

interface RecorderSuccessDelay {
  matches(event: JsonObject): boolean;
  delayMs: number;
}

interface RecorderStub {
  readonly url: string;
  readonly events: JsonObject[];
  readonly attempts: JsonObject[];
  failWith(failure: RecorderFailure | null): void;
  delaySuccessfulWith(delayed: RecorderSuccessDelay | null): void;
  stop(): void;
}

interface RunningHarness {
  readonly child: HarnessChild;
  readonly httpPort: number;
  readonly ntpPort: number;
  readonly bindAddress: string;
  readonly baseUrl: string;
  readonly recorder: RecorderStub;
}

const children = new Set<HarnessChild>();
const recorders = new Set<RecorderStub>();
const udpSockets = new Set<UdpSocket>();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function localNonLoopbackIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if ((family === "IPv4" || family === 4) && !entry.internal) {
        const octets = entry.address.split(".").map(Number);
        if (
          octets.length === 4 &&
          octets[0] !== 0 &&
          octets[0] !== 127 &&
          octets[0] < 224 &&
          !(octets[0] === 169 && octets[1] === 254)
        ) {
          return entry.address;
        }
      }
    }
  }
  throw new Error("NTP responder tests require one local non-loopback IPv4 address");
}

async function reserveTcpPort(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = createTcpServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("TCP port reservation returned no numeric address"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (port >= 10_000) return port;
  }
  throw new Error("could not reserve a TCP test port >= 10000");
}

async function bindUdp(host: string, port = 0): Promise<UdpSocket> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.removeListener("listening", onListening);
      try {
        socket.close();
      } catch {
        // A failed bind can already have closed the socket.
      }
      reject(error);
    };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind({ address: host, port, exclusive: true });
  });
  return socket;
}

async function reserveUdpPort(host: string): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const socket = await bindUdp(host);
    const address = socket.address();
    const port = address.port;
    await closeUdp(socket);
    if (port >= 10_000) return port;
  }
  throw new Error("could not reserve a UDP test port >= 10000");
}

async function closeUdp(socket: UdpSocket): Promise<void> {
  udpSockets.delete(socket);
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function createRecorderStub(): RecorderStub {
  const events: JsonObject[] = [];
  const attempts: JsonObject[] = [];
  let sequence = 0;
  let failure: RecorderFailure | null = null;
  let successfulDelay: RecorderSuccessDelay | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/record") {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const event = await request.json() as JsonObject;
      attempts.push(event);
      if (failure?.matches(event)) {
        if (failure.delayMs !== undefined) await delay(failure.delayMs);
        return Response.json(
          { error: "recorder_test_failure" },
          { status: failure.status ?? 503 },
        );
      }
      if (successfulDelay?.matches(event)) await delay(successfulDelay.delayMs);
      const stored = { ...event, sequence: ++sequence };
      events.push(stored);
      return Response.json({ sequence: stored.sequence }, { status: 201 });
    },
  });
  const stub: RecorderStub = {
    url: `http://127.0.0.1:${server.port}`,
    events,
    attempts,
    failWith(value) {
      failure = value;
    },
    delaySuccessfulWith(value) {
      successfulDelay = value;
    },
    stop() {
      server.stop(true);
      recorders.delete(stub);
    },
  };
  recorders.add(stub);
  return stub;
}

function spawnHarness(
  recorder: RecorderStub,
  bindAddress: string,
  httpPort: number,
  ntpPort: number,
  overrides: Record<string, string> = {},
): HarnessChild {
  const child = Bun.spawn([process.execPath, HARNESS_PATH], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      HARNESS_ROLE: "ntp-responder",
      HARNESS_CHANNEL: CHANNEL,
      HARNESS_PORT: String(httpPort),
      HARNESS_NTP_PORT: String(ntpPort),
      HARNESS_NTP_BIND_HOST: bindAddress,
      HARNESS_COLLECTOR_URL: recorder.url,
      HARNESS_UPSTREAM_TIMEOUT_MS: "500",
      HARNESS_NTP_TIMESTAMP_WINDOW_MS: "30000",
      HARNESS_NTP_MAX_CONCURRENCY: "16",
      HARNESS_NTP_RATE_PER_SECOND: "1024",
      HARNESS_NTP_RATE_BURST: "1024",
      HARNESS_NTP_MAX_RESPONSES: "4096",
      ...overrides,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  return child;
}

async function terminateChild(child: HarnessChild): Promise<number> {
  if (child.exitCode === null) child.kill("SIGTERM");
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    delay(2_500).then(() => null),
  ]);
  if (result === null) {
    child.kill("SIGKILL");
    const exitCode = await child.exited;
    children.delete(child);
    return exitCode;
  }
  children.delete(child);
  return result.exitCode;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function fetchJson(url: string): Promise<{ status: number; value: JsonObject }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(500) });
  return { status: response.status, value: await response.json() as JsonObject };
}

async function waitUntilReady(child: HarnessChild, baseUrl: string): Promise<JsonObject> {
  let readyState: JsonObject | null = null;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`NTP responder exited before readiness with ${child.exitCode}`);
    }
    try {
      const result = await fetchJson(`${baseUrl}/ready`);
      readyState = result.value;
      return result.status === 200 && result.value.ready === true;
    } catch {
      return false;
    }
  }, "NTP responder readiness");
  return readyState ?? {};
}

async function startHarness(
  overrides: Record<string, string> = {},
): Promise<RunningHarness> {
  const bindAddress = localNonLoopbackIpv4();
  const [httpPort, ntpPort] = await Promise.all([
    reserveTcpPort(),
    reserveUdpPort(bindAddress),
  ]);
  const recorder = createRecorderStub();
  const child = spawnHarness(recorder, bindAddress, httpPort, ntpPort, overrides);
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const readyState = await waitUntilReady(child, baseUrl);
  expect(readyState).toMatchObject({
    ready: true,
    role: "ntp-responder",
    channel: CHANNEL,
    bindAddress,
    udpPort: ntpPort,
    socketBound: true,
    selfTestPassed: true,
    fatal: false,
    recorderFailures: 0,
    socketFailures: 0,
  });
  expect(recorder.events.some((event) => event.phase === "ntp-ready")).toBe(true);
  return { child, httpPort, ntpPort, bindAddress, baseUrl, recorder };
}

function encodeNtpTimestamp(milliseconds: number): Buffer {
  const wholeMilliseconds = Math.floor(milliseconds);
  const seconds = Math.floor(wholeMilliseconds / 1_000) + NTP_EPOCH_SECONDS;
  const fraction = Math.floor(((wholeMilliseconds % 1_000) * NTP_FRACTION_SCALE) / 1_000);
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(seconds >>> 0, 0);
  bytes.writeUInt32BE(fraction >>> 0, 4);
  return bytes;
}

function decodeNtpTimestamp(bytes: Uint8Array, offset: number): number {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_SECONDS) * 1_000 +
    Math.floor((fraction * 1_000) / NTP_FRACTION_SCALE);
}

function exactClientRequest(nowMs = Date.now()): Buffer {
  const request = Buffer.alloc(48);
  request[0] = 0xe3;
  const timestamp = encodeNtpTimestamp(nowMs);
  timestamp.copy(request, 24);
  timestamp.copy(request, 40);
  return request;
}

async function clientSocket(host: string): Promise<UdpSocket> {
  const socket = await bindUdp(host);
  udpSockets.add(socket);
  return socket;
}

async function exchange(
  socket: UdpSocket,
  request: Buffer,
  host: string,
  port: number,
  timeoutMs = 500,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("message", onMessage);
      socket.removeListener("error", onError);
      if (error) reject(error);
      else resolve(response);
    };
    const onMessage = (response: Buffer) => finish(null, Buffer.from(response));
    const onError = (error: Error) => finish(error, null);
    const timer = setTimeout(() => finish(null, null), timeoutMs);
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.send(request, port, host, (error) => {
      if (error) finish(error, null);
    });
  });
}

async function ntpStats(harness: RunningHarness): Promise<JsonObject> {
  const result = await fetchJson(`${harness.baseUrl}/ntp-stats`);
  expect(result.status).toBe(200);
  return result.value;
}

afterEach(async () => {
  for (const socket of [...udpSockets]) await closeUdp(socket);
  for (const child of [...children]) await terminateChild(child);
  for (const recorder of [...recorders]) recorder.stop();
});

describe("real E1 bounded NTP responder", () => {
  test("counts the bootstrap NTP prefix before the health request, not its later response", () => {
    const runnerSource = readFileSync(join(import.meta.dir, "../solver-offerfiles-e2e.ts"), "utf8");
    const assertionStart = runnerSource.indexOf("async function assertRealE1NtpBoundary(");
    const assertionEnd = runnerSource.indexOf("\nfunction assertRealE1NtpBoundaryStable(", assertionStart);
    expect(assertionStart).toBeGreaterThanOrEqual(0);
    expect(assertionEnd).toBeGreaterThan(assertionStart);
    const assertionBody = runnerSource.slice(assertionStart, assertionEnd);
    expect(assertionBody).toContain(
      "const bootstrapHealthRequestSequence = eventSequence(bootstrapHealth.request);",
    );
    expect(assertionBody).toContain("pair.sentSequence < bootstrapHealthRequestSequence");
    expect(assertionBody).not.toContain("pair.sentSequence < healthSequence");
  });

  test("emits an exact NTPv4 response only after a matching recorder permit", async () => {
    const harness = await startHarness();
    const socket = await clientSocket(harness.bindAddress);
    const remotePort = socket.address().port;
    const request = exactClientRequest();
    const startedAt = Date.now();
    const response = await exchange(socket, request, harness.bindAddress, harness.ntpPort);
    const completedAt = Date.now();

    expect(response).not.toBeNull();
    const bytes = response!;
    expect(bytes.byteLength).toBe(48);
    expect(bytes[0]).toBe(0x24);
    expect(bytes[1]).toBe(1);
    expect(bytes[2]).toBe(4);
    expect(bytes[3]).toBe(0xec);
    expect(bytes.subarray(4, 12)).toEqual(Buffer.alloc(8));
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("LOCL");
    expect(bytes.subarray(16, 24)).toEqual(bytes.subarray(32, 40));
    expect(bytes.subarray(24, 32)).toEqual(request.subarray(40, 48));

    const referenceMs = decodeNtpTimestamp(bytes, 16);
    const receiveMs = decodeNtpTimestamp(bytes, 32);
    const transmitMs = decodeNtpTimestamp(bytes, 40);
    expect(referenceMs).toBe(receiveMs);
    expect(receiveMs).toBeGreaterThanOrEqual(startedAt - 1);
    expect(transmitMs).toBeGreaterThanOrEqual(receiveMs);
    expect(transmitMs).toBeLessThanOrEqual(completedAt + 1);

    const requestHash = sha256(request);
    await waitFor(
      () => harness.recorder.events.some((event) =>
        event.phase === "ntp-sent" && event.requestSha256 === requestHash
      ),
      "matching NTP sent evidence",
    );
    const permit = harness.recorder.events.find((event) =>
      event.phase === "ntp-permit" && event.requestSha256 === requestHash
    );
    const sent = harness.recorder.events.find((event) =>
      event.phase === "ntp-sent" && event.requestSha256 === requestHash
    );
    expect(permit).toMatchObject({
      channel: CHANNEL,
      selfTest: false,
      requestBytes: 48,
      requestSha256: requestHash,
      responseBytes: 48,
      responseSha256: sha256(bytes),
      requestVersion: 4,
      requestMode: 3,
      responseVersion: 4,
      responseMode: 4,
      responseStratum: 1,
      requestTransmitSha256: sha256(request.subarray(40, 48)),
      originateEchoSha256: sha256(request.subarray(40, 48)),
      remoteAddress: harness.bindAddress,
      remotePort,
    });
    expect(permit?.originateEchoSha256).toBe(permit?.requestTransmitSha256);
    expect(typeof permit?.requestId).toBe("string");
    expect(permit?.receiveMs).toBeGreaterThanOrEqual(receiveMs);
    expect((permit?.receiveMs as number) - receiveMs).toBeLessThanOrEqual(1);
    expect(permit?.transmitMs).toBeGreaterThanOrEqual(transmitMs);
    expect((permit?.transmitMs as number) - transmitMs).toBeLessThanOrEqual(1);
    expect(sent).toMatchObject({
      requestId: permit?.requestId,
      requestSha256: requestHash,
      responseSha256: sha256(bytes),
      permitSequence: permit?.sequence,
    });
    expect(sent?.sequence as number).toBeGreaterThan(permit?.sequence as number);

    expect(await ntpStats(harness)).toMatchObject({
      ready: true,
      received: 2,
      valid: 2,
      permitted: 2,
      sent: 2,
      backendSent: 1,
      backendReserved: 1,
      selfTestSent: 1,
      invalid: 0,
      overlimit: 0,
      recorderFailures: 0,
    });
  }, 10_000);

  test("serves the pinned ntp-time-sync@0.5.0 eight-sample two-round request", async () => {
    expect(ntpPackageManifest.version).toBe("0.5.0");
    const harness = await startHarness();
    const server = `${harness.bindAddress}:${harness.ntpPort}`;
    const synchronizer = new ntpPackage.NtpTimeSync({
      servers: [server, server, server, server],
      sampleCount: 8,
      replyTimeout: 1_000,
    });

    const result = await synchronizer.getTime(true);
    expect(result.now).toBeInstanceOf(Date);
    expect(Number.isFinite(result.offset)).toBe(true);
    expect(Number.isFinite(result.precision)).toBe(true);
    expect(Math.abs(result.offset)).toBeLessThan(500);
    expect(result.precision).toBeLessThan(500);

    await waitFor(async () => (await ntpStats(harness)).backendSent === 8, "eight backend NTP responses");
    const backendPermits = harness.recorder.events.filter((event) =>
      event.phase === "ntp-permit" && event.selfTest === false
    );
    const backendSends = harness.recorder.events.filter((event) =>
      event.phase === "ntp-sent" && event.selfTest === false
    );
    expect(backendPermits).toHaveLength(8);
    expect(backendSends).toHaveLength(8);
    expect(new Set(backendPermits.map((event) => event.requestId)).size).toBe(8);
    expect(backendPermits.every((event) => event.remoteAddress === harness.bindAddress)).toBe(true);
    for (const sent of backendSends) {
      const permit = backendPermits.find((event) => event.requestId === sent.requestId);
      expect(permit).toBeDefined();
      expect(sent.permitSequence).toBe(permit?.sequence);
      expect(sent.sequence as number).toBeGreaterThan(permit?.sequence as number);
    }
    expect(await ntpStats(harness)).toMatchObject({
      ready: true,
      received: 9,
      valid: 9,
      permitted: 9,
      sent: 9,
      backendSent: 8,
      backendReserved: 8,
      selfTestSent: 1,
      invalid: 0,
      overlimit: 0,
      recorderFailures: 0,
      socketFailures: 0,
      fatal: false,
    });
  }, 10_000);

  test("silently drops malformed, stale, future, mismatched, zero, wrong-mode, wrong-version, and wrong-length packets", async () => {
    const harness = await startHarness({ HARNESS_NTP_TIMESTAMP_WINDOW_MS: "1000" });
    const socket = await clientSocket(harness.bindAddress);
    const malformedHeader = exactClientRequest();
    malformedHeader[1] = 1;
    const nonzeroReceive = exactClientRequest();
    nonzeroReceive[32] = 1;
    const mismatched = exactClientRequest();
    mismatched[24] ^= 1;
    const zeroTimestamp = exactClientRequest();
    zeroTimestamp.fill(0, 24, 32);
    zeroTimestamp.fill(0, 40, 48);
    const wrongMode = exactClientRequest();
    wrongMode[0] = 0xe2;
    const wrongVersion = exactClientRequest();
    wrongVersion[0] = 0xdb;
    const cases = [
      { name: "short length", packet: exactClientRequest().subarray(0, 47) },
      { name: "long length", packet: Buffer.concat([exactClientRequest(), Buffer.of(0)]) },
      { name: "nonzero reserved header", packet: malformedHeader },
      { name: "nonzero receive field", packet: nonzeroReceive },
      { name: "stale timestamp", packet: exactClientRequest(Date.now() - 60_000) },
      { name: "future timestamp", packet: exactClientRequest(Date.now() + 60_000) },
      { name: "mismatched timestamp", packet: mismatched },
      { name: "zero timestamp", packet: zeroTimestamp },
      { name: "wrong mode", packet: wrongMode },
      { name: "wrong version", packet: wrongVersion },
    ];

    for (const malformed of cases) {
      const response = await exchange(
        socket,
        Buffer.from(malformed.packet),
        harness.bindAddress,
        harness.ntpPort,
        80,
      );
      expect(response, malformed.name).toBeNull();
    }

    expect(await ntpStats(harness)).toMatchObject({
      ready: true,
      received: 1 + cases.length,
      valid: 1,
      sent: 1,
      backendSent: 0,
      backendReserved: 0,
      invalid: cases.length,
      overlimit: 0,
      fatal: false,
    });
    expect(harness.recorder.events.filter((event) => event.selfTest === false)).toHaveLength(0);
  }, 10_000);

  test("drops above a low per-source rate while refilling the bounded token bucket", async () => {
    const harness = await startHarness({
      HARNESS_NTP_RATE_PER_SECOND: "1",
      HARNESS_NTP_RATE_BURST: "1",
      HARNESS_NTP_MAX_RESPONSES: "10",
    });
    const socket = await clientSocket(harness.bindAddress);

    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort)).not.toBeNull();
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort, 150)).toBeNull();
    await delay(1_100);
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort)).not.toBeNull();

    expect(await ntpStats(harness)).toMatchObject({
      ready: true,
      valid: 4,
      backendSent: 2,
      backendReserved: 2,
      selfTestSent: 1,
      overlimit: 1,
      invalid: 0,
      fatal: false,
    });
  }, 10_000);

  test("drops valid traffic after the hard response cap", async () => {
    const harness = await startHarness({ HARNESS_NTP_MAX_RESPONSES: "2" });
    const socket = await clientSocket(harness.bindAddress);

    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort)).not.toBeNull();
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort)).not.toBeNull();
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort, 150)).toBeNull();

    expect(await ntpStats(harness)).toMatchObject({
      ready: true,
      valid: 4,
      backendSent: 2,
      backendReserved: 2,
      selfTestSent: 1,
      overlimit: 1,
      invalid: 0,
      fatal: false,
    });
  }, 10_000);

  test("bounds concurrent delayed permits and hard-cap reservations under UDP bursts", async () => {
    const harness = await startHarness({
      HARNESS_NTP_MAX_CONCURRENCY: "2",
      HARNESS_NTP_MAX_RESPONSES: "3",
    });
    harness.recorder.delaySuccessfulWith({
      matches: (event) => event.phase === "ntp-permit" && event.selfTest === false,
      delayMs: 200,
    });
    const sockets = await Promise.all(
      Array.from({ length: 8 }, () => clientSocket(harness.bindAddress)),
    );
    const burst = () => Promise.all(sockets.map((socket) =>
      exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort, 700)
    ));

    const firstWave = await burst();
    expect(firstWave.filter((response) => response !== null)).toHaveLength(2);
    expect(firstWave.filter((response) => response === null)).toHaveLength(6);
    const secondWave = await burst();
    expect(secondWave.filter((response) => response !== null)).toHaveLength(1);
    expect(secondWave.filter((response) => response === null)).toHaveLength(7);

    await waitFor(async () => {
      const stats = await ntpStats(harness);
      return stats.active === 0 && stats.backendSent === 3;
    }, "all admitted burst responses to finish");
    const stats = await ntpStats(harness);
    expect(stats).toMatchObject({
      ready: true,
      received: 17,
      valid: 17,
      permitted: 4,
      sent: 4,
      backendSent: 3,
      backendReserved: 3,
      selfTestSent: 1,
      invalid: 0,
      overlimit: 13,
      recorderFailures: 0,
      socketFailures: 0,
      active: 0,
      maxActive: 2,
      fatal: false,
    });
    expect(stats.maxActive as number).toBeLessThanOrEqual(2);
    expect(stats.backendReserved as number).toBeLessThanOrEqual(3);
    expect(stats.backendSent as number).toBeLessThanOrEqual(3);

    const permits = harness.recorder.events.filter((event) =>
      event.phase === "ntp-permit" && event.selfTest === false
    );
    const sends = harness.recorder.events.filter((event) =>
      event.phase === "ntp-sent" && event.selfTest === false
    );
    expect(permits).toHaveLength(3);
    expect(sends).toHaveLength(3);
    expect(new Set(permits.map((event) => event.requestId)).size).toBe(3);
    expect(new Set(sends.map((event) => event.requestId)).size).toBe(3);
    for (const permit of permits) {
      const sent = sends.find((event) => event.requestId === permit.requestId);
      expect(sent).toBeDefined();
      expect(sent?.permitSequence).toBe(permit.sequence);
      expect(sent?.requestSha256).toBe(permit.requestSha256);
      expect(sent?.responseSha256).toBe(permit.responseSha256);
      expect(sent?.sequence as number).toBeGreaterThan(permit.sequence as number);
    }
  }, 10_000);

  test("fails closed and becomes unhealthy when the recorder times out before permit", async () => {
    const harness = await startHarness({ HARNESS_UPSTREAM_TIMEOUT_MS: "250" });
    harness.recorder.failWith({
      matches: (event) => event.phase === "ntp-permit" && event.selfTest === false,
      delayMs: 750,
      status: 503,
    });
    const socket = await clientSocket(harness.bindAddress);
    const request = exactClientRequest();
    const requestHash = sha256(request);

    expect(await exchange(socket, request, harness.bindAddress, harness.ntpPort, 650)).toBeNull();
    await waitFor(async () => (await ntpStats(harness)).fatal === true, "recorder-failure unhealthy state");
    const stats = await ntpStats(harness);
    expect(stats).toMatchObject({
      ready: false,
      received: 2,
      valid: 2,
      permitted: 1,
      sent: 1,
      backendSent: 0,
      backendReserved: 1,
      selfTestSent: 1,
      recorderFailures: 1,
      fatal: true,
      fatalCode: "recorder-permit",
    });
    const readyResponse = await fetchJson(`${harness.baseUrl}/ready`);
    expect(readyResponse.status).toBe(503);
    expect(readyResponse.value.ready).toBe(false);
    expect(harness.recorder.attempts.some((event) =>
      event.phase === "ntp-permit" && event.requestSha256 === requestHash
    )).toBe(true);
    expect(harness.recorder.events.some((event) =>
      event.selfTest === false && event.requestSha256 === requestHash
    )).toBe(false);
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort, 150)).toBeNull();
  }, 10_000);

  test("closes UDP without crashing when the recorder rejects the startup self-test permit", async () => {
    const bindAddress = localNonLoopbackIpv4();
    const [httpPort, ntpPort] = await Promise.all([
      reserveTcpPort(),
      reserveUdpPort(bindAddress),
    ]);
    const recorder = createRecorderStub();
    recorder.failWith({
      matches: (event) => event.phase === "ntp-permit" && event.selfTest === true,
      status: 503,
    });
    const child = spawnHarness(recorder, bindAddress, httpPort, ntpPort);
    const baseUrl = `http://127.0.0.1:${httpPort}`;

    let stats: JsonObject = {};
    await waitFor(async () => {
      try {
        const result = await fetchJson(`${baseUrl}/ntp-stats`);
        stats = result.value;
        return result.status === 200 && stats.fatalCode === "recorder-permit" && stats.active === 0;
      } catch {
        return false;
      }
    }, "startup self-test recorder rejection");
    expect(stats).toMatchObject({
      ready: false,
      role: "ntp-responder",
      channel: CHANNEL,
      received: 1,
      valid: 1,
      permitted: 0,
      sent: 0,
      backendSent: 0,
      backendReserved: 0,
      selfTestSent: 0,
      recorderFailures: 1,
      socketFailures: 0,
      active: 0,
      fatal: true,
      fatalCode: "recorder-permit",
      socketBound: false,
      selfTestPassed: false,
      bindAddress,
      udpPort: ntpPort,
    });
    const firstReady = await fetchJson(`${baseUrl}/ready`);
    expect(firstReady.status).toBe(503);
    expect(firstReady.value.ready).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(recorder.attempts.filter((event) =>
      event.phase === "ntp-permit" && event.selfTest === true
    )).toHaveLength(1);
    expect(recorder.events.some((event) => event.phase === "ntp-ready")).toBe(false);

    let reboundUdp: UdpSocket | null = null;
    await waitFor(async () => {
      try {
        reboundUdp = await bindUdp(bindAddress, ntpPort);
        return true;
      } catch {
        return false;
      }
    }, "startup-failure UDP socket release");
    await closeUdp(reboundUdp!);
    const secondReady = await fetchJson(`${baseUrl}/ready`);
    expect(secondReady.status).toBe(503);
    expect(secondReady.value).toMatchObject({
      ready: false,
      fatal: true,
      fatalCode: "recorder-permit",
      recorderFailures: 1,
      socketFailures: 0,
      socketBound: false,
    });
    expect(child.exitCode).toBeNull();

    child.kill("SIGTERM");
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    children.delete(child);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`${CHANNEL} stopping on SIGTERM`);
    expect(stderr).toContain(`ntp-responder:${CHANNEL} unhealthy (recorder-permit)`);
    expect(stderr.toLowerCase()).not.toContain("unhandled");
    expect(stderr).not.toContain("UnhandledPromiseRejection");
  }, 10_000);

  test("rejects out-of-range timeout and NTP control environment values", async () => {
    const bindAddress = localNonLoopbackIpv4();
    const valid = {
      HARNESS_UPSTREAM_TIMEOUT_MS: "500",
      HARNESS_NTP_PORT: "12345",
      HARNESS_NTP_TIMESTAMP_WINDOW_MS: "30000",
      HARNESS_NTP_MAX_CONCURRENCY: "16",
      HARNESS_NTP_RATE_PER_SECOND: "32",
      HARNESS_NTP_RATE_BURST: "32",
      HARNESS_NTP_MAX_RESPONSES: "4096",
    };
    const invalidCases = [
      ["HARNESS_UPSTREAM_TIMEOUT_MS", "249", "[250, 120000]"],
      ["HARNESS_NTP_PORT", "65536", "[1, 65535]"],
      ["HARNESS_NTP_TIMESTAMP_WINDOW_MS", "999", "[1000, 120000]"],
      ["HARNESS_NTP_MAX_CONCURRENCY", "65", "[1, 64]"],
      ["HARNESS_NTP_RATE_PER_SECOND", "0", "[1, 1024]"],
      ["HARNESS_NTP_RATE_BURST", "1025", "[1, 1024]"],
      ["HARNESS_NTP_MAX_RESPONSES", "65537", "[1, 65536]"],
    ] as const;

    for (const [name, value, range] of invalidCases) {
      const child = Bun.spawn([process.execPath, HARNESS_PATH], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          HARNESS_ROLE: "ntp-responder",
          HARNESS_CHANNEL: CHANNEL,
          HARNESS_PORT: "12346",
          HARNESS_NTP_BIND_HOST: bindAddress,
          HARNESS_COLLECTOR_URL: "http://127.0.0.1:1",
          ...valid,
          [name]: value,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      children.add(child);
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      children.delete(child);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`${name} must be an integer in ${range}`);
    }
  }, 10_000);

  test("requires the UDP bind host to resolve to a non-loopback IPv4", async () => {
    const httpPort = await reserveTcpPort();
    const ntpPort = await reserveUdpPort("127.0.0.1");
    const recorder = createRecorderStub();
    const child = spawnHarness(recorder, "127.0.0.1", httpPort, ntpPort);
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    let stats: JsonObject = {};
    await waitFor(async () => {
      try {
        const result = await fetchJson(`${baseUrl}/ntp-stats`);
        stats = result.value;
        return stats.fatal === true;
      } catch {
        return false;
      }
    }, "loopback bind rejection");
    expect(stats).toMatchObject({
      ready: false,
      socketBound: false,
      selfTestPassed: false,
      fatal: true,
      fatalCode: "startup-bind",
      bindAddress: null,
    });
    const socket = await bindUdp("127.0.0.1", ntpPort);
    await closeUdp(socket);
    expect(child.exitCode).toBeNull();
  }, 10_000);

  test("SIGTERM closes both HTTP and UDP listeners", async () => {
    const harness = await startHarness();
    const socket = await clientSocket(harness.bindAddress);
    expect(await exchange(socket, exactClientRequest(), harness.bindAddress, harness.ntpPort)).not.toBeNull();
    await closeUdp(socket);

    harness.child.kill("SIGTERM");
    const exitCode = await harness.child.exited;
    children.delete(harness.child);
    expect(exitCode).toBe(0);
    const stdout = await new Response(harness.child.stdout).text();
    expect(stdout).toContain(`${CHANNEL} stopping on SIGTERM`);

    const reboundHttp = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      reboundHttp.once("error", reject);
      reboundHttp.listen({ host: "0.0.0.0", port: harness.httpPort, exclusive: true }, resolve);
    });
    await new Promise<void>((resolve) => reboundHttp.close(() => resolve()));
    const reboundUdp = await bindUdp(harness.bindAddress, harness.ntpPort);
    await closeUdp(reboundUdp);
  }, 10_000);
});
