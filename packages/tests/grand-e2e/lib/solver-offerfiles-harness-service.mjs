import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createSocket as createUdpSocket } from "node:dgram";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer, isIPv4 } from "node:net";

const HOST = "0.0.0.0";
const PORT = boundedIntegerEnv("HARNESS_PORT", 8080, 1, 65_535);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BODY_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_BODY_EVIDENCE_BYTES = 1024 * 1024;
const MAX_STREAM_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_EVIDENCE_EVENTS = 256;
const UPSTREAM_TIMEOUT_MS = boundedIntegerEnv("HARNESS_UPSTREAM_TIMEOUT_MS", 30_000, 250, 120_000);
const role = requiredEnv("HARNESS_ROLE");
const channel = process.env.HARNESS_CHANNEL ?? role;
const collectorUrl = process.env.HARNESS_COLLECTOR_URL;
const upstreamUrl = process.env.HARNESS_UPSTREAM_URL;
const artifactPath = process.env.HARNESS_TRAFFIC_PATH;

let ready = false;
let shuttingDown = false;
let startAfterListen = async () => {};
let closeRoleResources = async () => {};

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function constantTimeStringEqual(actual, expected) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  const actualDigest = createHash("sha256").update(actualBytes).digest();
  const expectedDigest = createHash("sha256").update(expectedBytes).digest();
  const digestMatches = timingSafeEqual(actualDigest, expectedDigest);
  return digestMatches && actualBytes.byteLength === expectedBytes.byteLength;
}

function configuredTelemetryIdentities() {
  const registry = process.env.HARNESS_TELEMETRY_IDENTITIES;
  if (registry === undefined) {
    return [{
      runId: requiredEnv("HARNESS_TELEMETRY_RUN_ID"),
      token: requiredEnv("HARNESS_TELEMETRY_TOKEN"),
    }];
  }
  let value;
  try {
    value = JSON.parse(registry);
  } catch {
    throw new Error("HARNESS_TELEMETRY_IDENTITIES must be a JSON object of run ID to token");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HARNESS_TELEMETRY_IDENTITIES must be a JSON object of run ID to token");
  }
  const identities = Object.entries(value).map(([runId, token]) => ({ runId, token }));
  if (identities.length < 1 || identities.length > 64) {
    throw new Error("HARNESS_TELEMETRY_IDENTITIES must contain 1-64 identities");
  }
  return identities;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendBytes(response, status, bytes, contentType = "application/octet-stream") {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function readBody(request, maximumBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maximumBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bodyEvidence(bytes) {
  const inline = bytes.byteLength <= MAX_INLINE_BODY_EVIDENCE_BYTES;
  return {
    bodyBytes: bytes.byteLength,
    bodySha256: sha256(bytes),
    bodyBase64: inline ? bytes.toString("base64") : null,
    bodyTruncated: !inline,
  };
}

function headerEvidence(headers) {
  const authorization = headers.authorization;
  return {
    contentType: headers["content-type"] ?? null,
    authorizationPresent: authorization !== undefined,
    authorizationSha256: authorization === undefined ? null : sha256(Buffer.from(authorization)),
    harnessRequestId: headers["x-harness-request-id"] ?? null,
  };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function collectorRequest(path, init = {}) {
  if (!collectorUrl) throw new Error("HARNESS_COLLECTOR_URL is required for proxy role");
  const response = await fetchWithTimeout(new URL(path, collectorUrl), init);
  if (!response.ok) throw new Error(`collector ${path} returned ${response.status}`);
  return response;
}

async function record(event) {
  const response = await collectorRequest("/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const result = await response.json();
  return result.sequence;
}

const NTP_PACKET_BYTES = 48;
const NTP_EPOCH_SECONDS = 2_208_988_800;
const NTP_FRACTION_SCALE = 2 ** 32;

function encodeNtpTimestamp(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("invalid NTP timestamp");
  const wholeMilliseconds = Math.floor(milliseconds);
  const seconds = Math.floor(wholeMilliseconds / 1_000) + NTP_EPOCH_SECONDS;
  const fraction = Math.floor(((wholeMilliseconds % 1_000) * NTP_FRACTION_SCALE) / 1_000);
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(seconds >>> 0, 0);
  bytes.writeUInt32BE(fraction >>> 0, 4);
  return bytes;
}

function decodeNtpTimestamp(bytes, offset) {
  const seconds = bytes.readUInt32BE(offset);
  const fraction = bytes.readUInt32BE(offset + 4);
  if (seconds < NTP_EPOCH_SECONDS) throw new Error("NTP timestamp predates Unix epoch");
  return (seconds - NTP_EPOCH_SECONDS) * 1_000 + Math.floor((fraction * 1_000) / NTP_FRACTION_SCALE);
}

function exactNtpClientRequest(nowMs = Date.now()) {
  const request = Buffer.alloc(NTP_PACKET_BYTES);
  request[0] = 0xe3;
  const timestamp = encodeNtpTimestamp(nowMs);
  timestamp.copy(request, 24);
  timestamp.copy(request, 40);
  return request;
}

function parseNtpClientRequest(bytes, nowMs, windowMs) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== NTP_PACKET_BYTES) return null;
  if (bytes[0] !== 0xe3) return null;
  if (!bytes.subarray(1, 24).equals(Buffer.alloc(23))) return null;
  const origin = bytes.subarray(24, 32);
  if (origin.equals(Buffer.alloc(8)) || !origin.equals(bytes.subarray(40, 48))) return null;
  if (!bytes.subarray(32, 40).equals(Buffer.alloc(8))) return null;
  let timestampMs;
  try {
    timestampMs = decodeNtpTimestamp(bytes, 40);
  } catch {
    return null;
  }
  if (Math.abs(timestampMs - nowMs) > windowMs) return null;
  return Object.freeze({
    version: (bytes[0] >>> 3) & 0x7,
    mode: bytes[0] & 0x7,
    timestampMs,
    transmitTimestamp: Buffer.from(bytes.subarray(40, 48)),
  });
}

function exactNtpServerResponse(request, receiveMs, transmitMs) {
  const response = Buffer.alloc(NTP_PACKET_BYTES);
  response[0] = 0x24;
  response[1] = 1;
  response[2] = 4;
  response[3] = 0xec;
  response.write("LOCL", 12, 4, "ascii");
  encodeNtpTimestamp(receiveMs).copy(response, 16);
  request.subarray(40, 48).copy(response, 24);
  encodeNtpTimestamp(receiveMs).copy(response, 32);
  encodeNtpTimestamp(transmitMs).copy(response, 40);
  return response;
}

function safeNonLoopbackIpv4(address) {
  if (!isIPv4(address)) return false;
  const octets = address.split(".").map(Number);
  return octets[0] !== 0 && octets[0] !== 127 && octets[0] < 224 &&
    !(octets[0] === 169 && octets[1] === 254);
}

async function resolveSingleNtpBindAddress(host) {
  const resolved = await lookup(host, { all: true, family: 4, verbatim: true });
  const addresses = [...new Set(resolved.map((entry) => entry.address))];
  if (addresses.length !== 1 || !safeNonLoopbackIpv4(addresses[0])) {
    throw new Error("HARNESS_NTP_BIND_HOST must resolve to exactly one non-loopback IPv4 address");
  }
  return addresses[0];
}

function ntpResponseEvidence(request, response, parsed, requestId, receiveMs, transmitMs, remote, selfTest) {
  return {
    channel,
    requestId,
    selfTest,
    requestBytes: request.byteLength,
    requestSha256: sha256(request),
    responseBytes: response.byteLength,
    responseSha256: sha256(response),
    requestVersion: parsed.version,
    requestMode: parsed.mode,
    responseVersion: (response[0] >>> 3) & 0x7,
    responseMode: response[0] & 0x7,
    responseStratum: response[1],
    requestTransmitSha256: sha256(request.subarray(40, 48)),
    originateEchoSha256: sha256(response.subarray(24, 32)),
    receiveMs,
    transmitMs,
    remoteAddress: remote.address,
    remotePort: remote.port,
  };
}

async function sendUdp(socket, bytes, port, address) {
  await new Promise((resolve, reject) => {
    socket.send(bytes, port, address, (error) => error ? reject(error) : resolve());
  });
}

async function closeUdp(socket) {
  if (socket === null) return;
  await new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function runNtpResponder() {
  const bindHost = requiredEnv("HARNESS_NTP_BIND_HOST");
  const udpPort = boundedIntegerEnv("HARNESS_NTP_PORT", 123, 1, 65_535);
  const timestampWindowMs = boundedIntegerEnv("HARNESS_NTP_TIMESTAMP_WINDOW_MS", 30_000, 1_000, 120_000);
  const maximumConcurrency = boundedIntegerEnv("HARNESS_NTP_MAX_CONCURRENCY", 16, 1, 64);
  const ratePerSecond = boundedIntegerEnv("HARNESS_NTP_RATE_PER_SECOND", 32, 1, 1_024);
  const rateBurst = boundedIntegerEnv("HARNESS_NTP_RATE_BURST", 32, 1, 1_024);
  const maximumResponses = boundedIntegerEnv("HARNESS_NTP_MAX_RESPONSES", 4_096, 1, 65_536);
  const state = {
    received: 0,
    valid: 0,
    permitted: 0,
    sent: 0,
    backendSent: 0,
    backendReserved: 0,
    selfTestSent: 0,
    invalid: 0,
    overlimit: 0,
    recorderFailures: 0,
    socketFailures: 0,
    active: 0,
    maxActive: 0,
    fatal: false,
    fatalCode: null,
    socketBound: false,
    selfTestPassed: false,
    bindAddress: null,
    udpPort,
  };
  const buckets = new Map();
  const activeTasks = new Set();
  let udpSocket = null;
  let selfTestRequestSha256 = null;
  let selfTestCompletion = null;

  const publicState = () => ({ ...state, active: state.active });
  const healthy = () => ready && state.socketBound && state.selfTestPassed && !state.fatal && !shuttingDown;
  const markFatal = (code) => {
    if (!state.fatal) {
      state.fatal = true;
      state.fatalCode = code;
      ready = false;
      console.error(`ntp-responder:${channel} unhealthy (${code})`);
    }
  };
  const permitRate = (address, nowMs) => {
    const prior = buckets.get(address) ?? { tokens: rateBurst, at: nowMs };
    const elapsed = Math.max(0, nowMs - prior.at);
    const tokens = Math.min(rateBurst, prior.tokens + (elapsed * ratePerSecond) / 1_000);
    if (tokens < 1) {
      buckets.set(address, { tokens, at: nowMs });
      return false;
    }
    buckets.set(address, { tokens: tokens - 1, at: nowMs });
    return true;
  };

  const handleDatagram = async (request, remote) => {
    state.received += 1;
    if (state.fatal || shuttingDown) return;
    const receiveMs = Date.now();
    const parsed = parseNtpClientRequest(request, receiveMs, timestampWindowMs);
    if (parsed === null) {
      state.invalid += 1;
      return;
    }
    state.valid += 1;
    const requestHash = sha256(request);
    const selfTest = requestHash === selfTestRequestSha256 && remote.address === state.bindAddress;
    if (!selfTest && (
      state.active >= maximumConcurrency ||
      state.backendReserved >= maximumResponses ||
      !permitRate(remote.address, receiveMs)
    )) {
      state.overlimit += 1;
      return;
    }
    if (!selfTest) state.backendReserved += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const requestId = randomUUID();
    const transmitMs = Date.now();
    const response = exactNtpServerResponse(request, receiveMs, transmitMs);
    const evidence = ntpResponseEvidence(
      request,
      response,
      parsed,
      requestId,
      receiveMs,
      transmitMs,
      remote,
      selfTest,
    );
    try {
      let permitSequence;
      try {
        permitSequence = await record({ ...evidence, phase: "ntp-permit" });
      } catch {
        state.recorderFailures += 1;
        markFatal("recorder-permit");
        throw new Error("ntp recorder permit failed");
      }
      state.permitted += 1;
      if (state.fatal || shuttingDown) throw new Error("ntp responder became unhealthy before send");
      try {
        await sendUdp(udpSocket, response, remote.port, remote.address);
      } catch {
        state.socketFailures += 1;
        markFatal("socket-send");
        throw new Error("ntp socket send failed");
      }
      state.sent += 1;
      if (selfTest) state.selfTestSent += 1;
      else state.backendSent += 1;
      try {
        await record({ ...evidence, phase: "ntp-sent", permitSequence });
      } catch {
        state.recorderFailures += 1;
        markFatal("recorder-sent");
        throw new Error("ntp recorder sent record failed");
      }
      if (selfTest && selfTestCompletion !== null) selfTestCompletion.resolve();
    } catch (error) {
      if (selfTest && selfTestCompletion !== null) selfTestCompletion.reject(error);
    } finally {
      state.active -= 1;
    }
  };

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/ready") {
      return sendJson(response, healthy() ? 200 : 503, { ready: healthy(), role, channel, ...publicState() });
    }
    if (request.method === "GET" && request.url === "/ntp-stats") {
      return sendJson(response, 200, { ready: healthy(), role, channel, ...publicState() });
    }
    return sendJson(response, 404, { error: "not_found" });
  });

  const runSelfTest = async () => {
    const client = createUdpSocket("udp4");
    const request = exactNtpClientRequest();
    selfTestRequestSha256 = sha256(request);
    let completionResolve;
    let completionReject;
    selfTestCompletion = {
      promise: new Promise((resolve, reject) => {
        completionResolve = resolve;
        completionReject = reject;
      }),
      resolve: completionResolve,
      reject: completionReject,
    };
    try {
      const responsePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("NTP self-test timed out")), UPSTREAM_TIMEOUT_MS + 1_000);
        timer.unref();
        client.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        client.once("message", (response) => {
          try {
            if (response.byteLength !== NTP_PACKET_BYTES || response[0] !== 0x24 || response[1] !== 1 ||
              !response.subarray(24, 32).equals(request.subarray(40, 48))) {
              throw new Error("NTP self-test response mismatch");
            }
            const receiveMs = decodeNtpTimestamp(response, 32);
            const transmitMs = decodeNtpTimestamp(response, 40);
            if (Math.abs(receiveMs - Date.now()) > timestampWindowMs || transmitMs < receiveMs ||
              transmitMs - receiveMs > UPSTREAM_TIMEOUT_MS) {
              throw new Error("NTP self-test timestamp mismatch");
            }
            clearTimeout(timer);
            resolve();
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        client.bind(0, state.bindAddress, () => {
          void sendUdp(client, request, udpPort, state.bindAddress).catch(reject);
        });
      });
      await Promise.all([responsePromise, selfTestCompletion.promise]);
      state.selfTestPassed = true;
    } finally {
      await closeUdp(client);
      selfTestCompletion = null;
      selfTestRequestSha256 = null;
    }
  };

  const start = async () => {
    try {
      state.bindAddress = await resolveSingleNtpBindAddress(bindHost);
      udpSocket = createUdpSocket("udp4");
      udpSocket.on("error", () => {
        state.socketFailures += 1;
        markFatal("socket-error");
      });
      udpSocket.on("message", (request, remote) => {
        const task = handleDatagram(Buffer.from(request), remote);
        activeTasks.add(task);
        void task.then(
          () => activeTasks.delete(task),
          () => {
            activeTasks.delete(task);
            markFatal("handler-error");
          },
        );
      });
      await new Promise((resolve, reject) => {
        udpSocket.once("error", reject);
        udpSocket.bind({ address: state.bindAddress, port: udpPort, exclusive: true }, resolve);
      });
      state.socketBound = true;
      await runSelfTest();
    } catch {
      markFatal(state.socketBound ? "startup-self-test" : "startup-bind");
      state.socketBound = false;
      await closeUdp(udpSocket);
      udpSocket = null;
      return;
    }
    try {
      await record({
        channel,
        phase: "ntp-ready",
        bindAddress: state.bindAddress,
        udpPort,
        selfTestPassed: state.selfTestPassed,
        counters: publicState(),
      });
      ready = true;
    } catch {
      state.recorderFailures += 1;
      markFatal("recorder-ready");
      state.socketBound = false;
      await closeUdp(udpSocket);
      udpSocket = null;
    }
  };

  const close = async () => {
    ready = false;
    state.socketBound = false;
    await closeUdp(udpSocket);
    udpSocket = null;
    await Promise.allSettled([...activeTasks]);
  };

  return { server, start, close };
}

async function configuredFault(request) {
  const requestUrl = new URL(request.url ?? "/", "http://harness.invalid");
  const query = new URLSearchParams({
    method: request.method ?? "GET",
    path: requestUrl.pathname,
  });
  const response = await collectorRequest(`/faults/${encodeURIComponent(channel)}?${query}`);
  return response.json();
}

function forwardedHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "host" || name === "content-length") continue;
    result.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return result;
}

function originFormTarget(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\#\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

async function runCollector() {
  const events = [];
  const faults = new Map();
  let sequence = 0;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/ready") {
        return sendJson(response, ready ? 200 : 503, { ready, role });
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return sendJson(response, 200, { events });
      }
      if (request.method === "POST" && url.pathname === "/record") {
        const value = JSON.parse((await readBody(request, MAX_RECORD_BODY_BYTES)).toString("utf8"));
        const stored = {
          ...value,
          sequence: ++sequence,
          observedAt: new Date().toISOString(),
        };
        events.push(stored);
        if (artifactPath) appendFileSync(artifactPath, `${JSON.stringify(stored)}\n`, { encoding: "utf8" });
        return sendJson(response, 201, { sequence: stored.sequence });
      }

      const faultMatch = /^\/faults\/([^/]+)$/.exec(url.pathname);
      if (faultMatch && request.method === "GET") {
        const stored = faults.get(decodeURIComponent(faultMatch[1]));
        if (!stored) return sendJson(response, 200, { mode: "pass" });
        const method = url.searchParams.get("method") ?? "";
        const path = url.searchParams.get("path") ?? "";
        const matchesMethod = stored.definition.match?.method === undefined || stored.definition.match.method === method;
        const matchesPath = stored.definition.match?.path === undefined || stored.definition.match.path === path;
        if (!matchesMethod || !matchesPath) return sendJson(response, 200, { mode: "pass" });
        stored.matches += 1;
        if (
          stored.definition.match?.occurrence !== undefined &&
          stored.definition.match.occurrence !== stored.matches
        ) {
          return sendJson(response, 200, { mode: "pass" });
        }
        if (
          stored.definition.match?.fromOccurrence !== undefined &&
          stored.matches < stored.definition.match.fromOccurrence
        ) {
          return sendJson(response, 200, { mode: "pass" });
        }
        return sendJson(response, 200, { ...stored.definition, matchedOccurrence: stored.matches });
      }
      if (faultMatch && request.method === "DELETE") {
        faults.delete(decodeURIComponent(faultMatch[1]));
        return sendJson(response, 200, { mode: "pass" });
      }
      if (faultMatch && request.method === "PUT") {
        const value = JSON.parse((await readBody(request)).toString("utf8"));
        const validationError = validateFault(value);
        if (validationError !== null) {
          return sendJson(response, 400, { error: "invalid_fault" });
        }
        faults.set(decodeURIComponent(faultMatch[1]), { definition: value, matches: 0 });
        return sendJson(response, 200, value);
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(response, 500, {
        error: "collector_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

const JSON_PATCH_PATHS = new Set([
  "/schemaVersion",
  "/valid",
  "/live",
  "/claimedOfferId",
  "/computedOfferId",
  "/stateVersion",
  "/validatedAt",
  "/status",
  "/code",
  "/reason",
  "/computed/gives/0/amount",
  "/files/0/verdict/computed/gives/0/amount",
]);

function isBoundedPatchValue(value) {
  return value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && Buffer.byteLength(value) <= 4_096);
}

function validateJsonPatch(value) {
  if (value.afterUpstream !== true) return "json_patch_after_upstream";
  if (typeof value.patchId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value.patchId)) {
    return "json_patch_id";
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 16) {
    return "json_patch_operations";
  }
  for (const operation of value.operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return "json_patch_operation";
    if (!JSON_PATCH_PATHS.has(operation.path)) return "json_patch_path";
    if (operation.op === "set") {
      if (Object.keys(operation).some((key) => !["op", "path", "value"].includes(key)) ||
        !Object.hasOwn(operation, "value") || !isBoundedPatchValue(operation.value)) {
        return "json_patch_set";
      }
    } else if (operation.op === "increment-decimal-string") {
      if (Object.keys(operation).some((key) => !["op", "path", "delta"].includes(key)) ||
        !["/computed/gives/0/amount", "/files/0/verdict/computed/gives/0/amount"].includes(operation.path) ||
        typeof operation.delta !== "string" || !/^[1-9][0-9]{0,5}$/.test(operation.delta)) {
        return "json_patch_increment";
      }
    } else {
      return "json_patch_op";
    }
  }
  return null;
}

function validateFault(value) {
  const allowed = new Set(["pass", "status", "malformed", "disconnect", "delay", "replace", "json-patch"]);
  if (!value || typeof value !== "object" || Array.isArray(value) || !allowed.has(value.mode)) return "mode";
  if (value.match !== undefined) {
    if (!value.match || typeof value.match !== "object" || Array.isArray(value.match)) return "match";
    if (
      value.match.method !== undefined &&
      (typeof value.match.method !== "string" || !/^[A-Z]+$/.test(value.match.method) || value.match.method.length > 16)
    ) {
      return "method";
    }
    if (
      value.match.path !== undefined &&
      (typeof value.match.path !== "string" || !value.match.path.startsWith("/") || value.match.path.length > 2_048)
    ) {
      return "path";
    }
    if (
      value.match.occurrence !== undefined &&
      (!Number.isInteger(value.match.occurrence) || value.match.occurrence < 1 || value.match.occurrence > 10_000)
    ) {
      return "occurrence";
    }
    if (
      value.match.fromOccurrence !== undefined &&
      (!Number.isInteger(value.match.fromOccurrence) ||
        value.match.fromOccurrence < 1 ||
        value.match.fromOccurrence > 10_000)
    ) {
      return "from_occurrence";
    }
    if (value.match.occurrence !== undefined && value.match.fromOccurrence !== undefined) {
      return "occurrence_conflict";
    }
  }
  if (
    value.delayMs !== undefined &&
    (!Number.isInteger(value.delayMs) || value.delayMs < 0 || value.delayMs > 60_000)
  ) {
    return "delay";
  }
  if (value.mode === "status" && (!Number.isInteger(value.status ?? 503) || (value.status ?? 503) < 400 || (value.status ?? 503) > 599)) {
    return "status";
  }
  if (value.mode === "replace") {
    if (!Number.isInteger(value.status ?? 200) || (value.status ?? 200) < 200 || (value.status ?? 200) > 599) {
      return "replace_status";
    }
    if (typeof value.bodyBase64 !== "string" || value.bodyBase64.length > Math.ceil((MAX_BODY_BYTES * 4) / 3) + 4) {
      return "replace_body";
    }
    const bytes = Buffer.from(value.bodyBase64, "base64");
    if (bytes.byteLength > MAX_BODY_BYTES || bytes.toString("base64") !== value.bodyBase64) return "replace_body";
    if (
      value.contentType !== undefined &&
      (typeof value.contentType !== "string" || value.contentType.length < 1 || value.contentType.length > 256)
    ) {
      return "replace_content_type";
    }
    if (value.afterUpstream !== undefined && typeof value.afterUpstream !== "boolean") return "after_upstream";
  } else if (value.mode === "json-patch") {
    const error = validateJsonPatch(value);
    if (error !== null) return error;
    if (value.bodyBase64 !== undefined || value.contentType !== undefined || value.status !== undefined) {
      return "json_patch_replace_fields";
    }
  } else if (
    value.afterUpstream !== undefined || value.bodyBase64 !== undefined || value.contentType !== undefined ||
    value.patchId !== undefined || value.operations !== undefined
  ) {
    return "replace_only";
  }
  return null;
}

function jsonPointerParent(root, path) {
  const segments = path.slice(1).split("/");
  const key = segments.pop();
  let parent = root;
  for (const segment of segments) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent) && !/^\d+$/.test(segment) ||
      !Object.hasOwn(parent, segment)) {
      throw new Error(`json_patch_missing_path:${path}`);
    }
    parent = parent[segment];
  }
  if (!parent || typeof parent !== "object" || key === undefined || !Object.hasOwn(parent, key)) {
    throw new Error(`json_patch_missing_path:${path}`);
  }
  return { parent, key };
}

function applyJsonPatch(upstreamBody, fault) {
  let parsed;
  try {
    parsed = JSON.parse(upstreamBody.toString("utf8"));
  } catch {
    throw new Error("json_patch_upstream_not_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("json_patch_upstream_not_object");
  }
  const patched = structuredClone(parsed);
  for (const operation of fault.operations) {
    const { parent, key } = jsonPointerParent(patched, operation.path);
    if (operation.op === "set") {
      parent[key] = operation.value;
      continue;
    }
    const current = parent[key];
    if (typeof current !== "string" || !/^(0|[1-9][0-9]*)$/.test(current)) {
      throw new Error(`json_patch_not_decimal_string:${operation.path}`);
    }
    parent[key] = (BigInt(current) + BigInt(operation.delta)).toString();
  }
  const body = Buffer.from(JSON.stringify(patched));
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("json_patch_body_too_large");
  return body;
}

async function sendJsonPatchResponse(fault, requestId, request, response, requestBody, upstreamStatus, upstreamBody) {
  if (upstreamStatus !== 200) throw new Error(`json_patch_upstream_status:${upstreamStatus}`);
  const body = applyJsonPatch(upstreamBody, fault);
  const patchDefinition = Buffer.from(JSON.stringify({ patchId: fault.patchId, operations: fault.operations }));
  const upstreamInline = upstreamBody.byteLength <= MAX_INLINE_BODY_EVIDENCE_BYTES;
  await record({
    channel,
    phase: "response",
    requestId,
    method: request.method,
    path: request.url,
    fault: "json-patch",
    matchedOccurrence: fault.matchedOccurrence ?? null,
    upstreamStatus,
    upstreamBodyBytes: upstreamBody.byteLength,
    upstreamBodySha256: sha256(upstreamBody),
    upstreamBodyBase64: upstreamInline ? upstreamBody.toString("base64") : null,
    upstreamBodyTruncated: !upstreamInline,
    patchId: fault.patchId,
    patchSha256: sha256(patchDefinition),
    requestBodySha256: sha256(requestBody),
    status: 200,
    ...bodyEvidence(body),
  });
  sendBytes(response, 200, body, "application/json");
}

async function sendFaultResponse(fault, faultName, requestId, request, response, requestBody, upstreamStatus = null) {
  let status;
  let body;
  let contentType = "application/json";
  if (fault.mode === "malformed") {
    status = 200;
    body = Buffer.from('{"malformed":');
  } else if (fault.mode === "replace") {
    status = Number(fault.status ?? 200);
    body = Buffer.from(fault.bodyBase64, "base64");
    contentType = fault.contentType ?? "application/octet-stream";
  } else {
    status = Number(fault.status ?? 503);
    body = Buffer.from(
      JSON.stringify({ error: "HARNESS_FAULT", channel, status, requestBodySha256: sha256(requestBody) }),
    );
  }
  await record({
    channel,
    phase: "response",
    requestId,
    method: request.method,
    path: request.url,
    fault: faultName,
    matchedOccurrence: fault.matchedOccurrence ?? null,
    upstreamStatus,
    status,
    ...bodyEvidence(body),
  });
  sendBytes(response, status, body, contentType);
}

async function applyPreFault(fault, requestId, request, response, requestBody) {
  if (fault.mode === "pass") return false;

  if (fault.mode === "delay") {
    const delayMs = Number(fault.delayMs);
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
      throw new Error("invalid delay fault");
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return false;
  }

  if (fault.mode === "disconnect") {
    await record({
      channel,
      phase: "response",
      requestId,
      method: request.method,
      path: request.url,
      fault: "disconnect",
      matchedOccurrence: fault.matchedOccurrence ?? null,
      status: null,
      ...bodyEvidence(Buffer.alloc(0)),
    });
    request.socket.destroy();
    return true;
  }

  if ((fault.mode === "replace" || fault.mode === "json-patch") && fault.afterUpstream) return false;
  await sendFaultResponse(fault, fault.mode, requestId, request, response, requestBody);
  return true;
}

async function readUpstreamBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("upstream_body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function streamedResponseHeaders(headers) {
  const result = {};
  for (const name of ["content-type", "cache-control", "etag", "last-modified", "x-request-id"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}

async function proxyStream(upstreamResponse, controller, requestId, request, response, appliedFault) {
  const hash = createHash("sha256");
  let total = 0;
  let evidenceBytes = 0;
  let evidenceEvents = 0;
  let finished = false;
  const onClose = () => {
    if (!finished) controller.abort(new Error("downstream_closed"));
  };
  response.once("close", onClose);
  await record({
    channel,
    phase: "response-open",
    requestId,
    method: request.method,
    path: request.url,
    fault: null,
    appliedFault: appliedFault?.mode ?? null,
    matchedOccurrence: appliedFault?.matchedOccurrence ?? null,
    status: upstreamResponse.status,
    ...bodyEvidence(Buffer.alloc(0)),
  });
  response.writeHead(upstreamResponse.status, streamedResponseHeaders(upstreamResponse.headers));
  try {
    if (upstreamResponse.body) {
      for await (const chunk of upstreamResponse.body) {
        const bytes = Buffer.from(chunk);
        hash.update(bytes);
        total += bytes.byteLength;
        if (evidenceEvents < MAX_STREAM_EVIDENCE_EVENTS && evidenceBytes < MAX_STREAM_EVIDENCE_BYTES) {
          const evidence = bytes.subarray(0, MAX_STREAM_EVIDENCE_BYTES - evidenceBytes);
          evidenceBytes += evidence.byteLength;
          evidenceEvents += 1;
          await record({
            channel,
            phase: "stream-chunk",
            requestId,
            method: request.method,
            path: request.url,
            chunk: evidenceEvents,
            truncated: evidence.byteLength !== bytes.byteLength,
            ...bodyEvidence(evidence),
          });
        }
        if (!response.write(bytes)) await once(response, "drain");
      }
    }
    finished = true;
    await record({
      channel,
      phase: "stream-end",
      requestId,
      method: request.method,
      path: request.url,
      status: upstreamResponse.status,
      bodyBytes: total,
      bodySha256: hash.digest("hex"),
      bodyBase64: null,
      appliedFault: appliedFault?.mode ?? null,
      matchedOccurrence: appliedFault?.matchedOccurrence ?? null,
      evidenceBytes,
      evidenceEvents,
    });
    response.end();
  } finally {
    response.off("close", onClose);
  }
}

async function runProxy() {
  const server = createServer(async (request, response) => {
    if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role, channel });

    const requestTarget = originFormTarget(request.url);
    if (requestTarget === null) {
      return sendJson(response, 400, { error: "invalid_request_target" });
    }

    const requestId = randomUUID();
    let appliedFault = null;
    try {
      const body = await readBody(request);
      await record({
        channel,
        phase: "request",
        requestId,
        method: request.method,
        path: request.url,
        headers: headerEvidence(request.headers),
        ...bodyEvidence(body),
      });

      const fault = await configuredFault(request);
      if (fault.mode === "delay") {
        appliedFault = { mode: "delay", matchedOccurrence: fault.matchedOccurrence ?? null };
      }
      if (await applyPreFault(fault, requestId, request, response, body)) return;

      let status = 200;
      let contentType = "application/json";
      let responseBody;
      if (upstreamUrl) {
        const upstream = new URL(requestTarget, upstreamUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("upstream_timeout")), UPSTREAM_TIMEOUT_MS);
        timer.unref();
        try {
          const upstreamResponse = await fetch(upstream, {
            method: request.method,
            headers: forwardedHeaders(request.headers),
            body: body.byteLength === 0 || request.method === "GET" || request.method === "HEAD" ? undefined : body,
            redirect: "manual",
            signal: controller.signal,
          });
          status = upstreamResponse.status;
          contentType = upstreamResponse.headers.get("content-type") ?? "application/octet-stream";
          if (contentType.toLowerCase().startsWith("text/event-stream")) {
            if ((fault.mode === "replace" || fault.mode === "json-patch") && fault.afterUpstream) {
              controller.abort(new Error("cannot_replace_stream_after_upstream"));
              throw new Error("after-upstream replacement cannot target a streaming response");
            }
            clearTimeout(timer);
            await proxyStream(upstreamResponse, controller, requestId, request, response, appliedFault);
            return;
          }
          responseBody = await readUpstreamBody(upstreamResponse);
        } finally {
          clearTimeout(timer);
        }
      } else {
        responseBody = Buffer.from(JSON.stringify({ ok: true, channel }));
      }

      if (fault.mode === "replace" && fault.afterUpstream) {
        await sendFaultResponse(fault, "replace", requestId, request, response, body, status);
        return;
      }
      if (fault.mode === "json-patch" && fault.afterUpstream) {
        await sendJsonPatchResponse(fault, requestId, request, response, body, status, responseBody);
        return;
      }

      await record({
        channel,
        phase: "response",
        requestId,
        method: request.method,
        path: request.url,
        fault: null,
        appliedFault: appliedFault?.mode ?? null,
        matchedOccurrence: appliedFault?.matchedOccurrence ?? null,
        status,
        ...bodyEvidence(responseBody),
      });
      return sendBytes(response, status, responseBody, contentType);
    } catch (error) {
      const body = Buffer.from(
        JSON.stringify({ error: "proxy_error", message: error instanceof Error ? error.message : String(error) }),
      );
      try {
        await record({
          channel,
          phase: "response",
          requestId,
          method: request.method,
          path: request.url,
          fault: "proxy_error",
          appliedFault: appliedFault?.mode ?? null,
          matchedOccurrence: appliedFault?.matchedOccurrence ?? null,
          status: 502,
          ...bodyEvidence(body),
        });
      } catch {
        // The response still fails closed if the recorder itself is unavailable.
      }
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      return sendBytes(response, 502, body, "application/json");
    }
  });
  // WHATWG fetch cannot proxy an HTTP/1.1 websocket upgrade. Preserve the
  // exact bytes at the split-horizon boundary instead: downstream solvers can
  // open the backend update stream, while the backend still has no network
  // route back to them. Ordinary REST requests continue through the recorded
  // and fault-injectable fetch path above.
  server.on("upgrade", (request, downstream, head) => {
    const requestTarget = originFormTarget(request.url);
    if (!upstreamUrl || requestTarget === null) {
      downstream.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const requestId = randomUUID();
    const upstreamTarget = new URL(upstreamUrl);
    const upstreamPort = Number(upstreamTarget.port || (upstreamTarget.protocol === "https:" ? 443 : 80));
    if (upstreamTarget.protocol !== "http:") {
      downstream.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    void record({
      channel,
      phase: "request",
      requestId,
      method: request.method,
      path: request.url,
      upgrade: "websocket",
      headers: headerEvidence(request.headers),
      ...bodyEvidence(Buffer.alloc(0)),
    }).catch((error) => {
      console.error("websocket upgrade record failed", error);
      downstream.destroy();
    });
    const upstream = connect({ host: upstreamTarget.hostname, port: upstreamPort }, () => {
      const requestLine = `${request.method ?? "GET"} ${requestTarget} HTTP/${request.httpVersion}\r\n`;
      const rawHeaders = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        rawHeaders.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${requestLine}${rawHeaders.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    const close = () => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on("error", close);
    upstream.on("error", close);
    downstream.on("close", () => upstream.destroy());
    upstream.on("close", () => downstream.destroy());
  });
  return server;
}

async function runOfferFilesProbe() {
  const server = createServer((request, response) => {
    if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role });
    if (request.url === "/__harness/redirect") {
      response.writeHead(302, { location: "http://traffic-recorder:8080/events" });
      return response.end();
    }
    if (request.url === "/__harness/sse") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.write("event: offer\ndata: first\n\n");
      setTimeout(() => {
        response.end("event: offer\ndata: second\n\n");
      }, 750);
      return;
    }
    if (request.url === "/__harness/json-patch") {
      return sendJson(response, 200, {
        schemaVersion: 1,
        valid: true,
        live: true,
        claimedOfferId: "a".repeat(64),
        computedOfferId: "a".repeat(64),
        stateVersion: "42",
        validatedAt: "2026-08-15T00:00:00.000Z",
        status: "live",
        code: "VALID",
        computed: { gives: [{ amount: "9" }] },
      });
    }
    return sendJson(response, 200, { ok: true, source: "offerfiles-probe", path: request.url });
  });

  server.on("listening", async () => {
    try {
      const celestia = await fetchWithTimeout(requiredEnv("CELESTIA_RPC_URL"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "header.NetworkHead", params: [] }),
      });
      const batcher = await fetchWithTimeout(requiredEnv("BATCHER_SUBMIT_URL"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      if (!celestia.ok || !batcher.ok) throw new Error("upstream dry probes failed");
      ready = true;
    } catch (error) {
      console.error("offerfiles dry probe failed", error);
    }
  });
  return server;
}

async function runTelemetryRelay() {
  const identities = configuredTelemetryIdentities();
  const seenTokens = new Set();
  for (const identity of identities) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(identity.runId)) {
      throw new Error("telemetry run IDs must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}");
    }
    if (typeof identity.token !== "string" || identity.token.length < 16 || identity.token.length > 512 || /\s/.test(identity.token)) {
      throw new Error("telemetry tokens must contain 16-512 non-whitespace characters");
    }
    if (seenTokens.has(identity.token)) throw new Error("telemetry tokens must be unique per run ID");
    seenTokens.add(identity.token);
  }
  return createServer(async (request, response) => {
    try {
      if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role, channel });
      if (request.method !== "POST" || request.url !== "/record") {
        return sendJson(response, 404, { error: "not_found" });
      }
      const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
      let authenticatedRunId = null;
      for (const identity of identities) {
        if (constantTimeStringEqual(authorization, `Bearer ${identity.token}`)) {
          authenticatedRunId = identity.runId;
        }
      }
      if (authenticatedRunId === null) {
        return sendJson(response, 401, { error: "unauthorized" });
      }
      const value = JSON.parse((await readBody(request)).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return sendJson(response, 400, { error: "invalid_event" });
      }
      if (value.runId !== authenticatedRunId) {
        return sendJson(response, 403, { error: "run_id_mismatch" });
      }
      const sequence = await record({
        ...value,
        runId: authenticatedRunId,
        channel,
        authenticatedRunId,
        authentication: "bearer",
      });
      return sendJson(response, 202, { sequence });
    } catch (error) {
      return sendJson(response, 502, {
        error: "telemetry_relay_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function runSolverProbe() {
  const server = createServer((request, response) => {
    if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role });
    return sendJson(response, 404, { error: "not_found" });
  });

  server.on("listening", async () => {
    try {
      const response = await fetchWithTimeout(new URL("/v1/offers?dry=1", requiredEnv("OFFER_FILES_BACKEND_URL")), {
        headers: { "x-harness-request-id": randomUUID() },
      });
      if (!response.ok) throw new Error(`backend dry probe returned ${response.status}`);
      ready = true;
    } catch (error) {
      console.error("solver dry probe failed", error);
    }
  });
  return server;
}

async function waitForTcp(host, port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = "not attempted";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const timer = setTimeout(() => socket.destroy(new Error("connect timeout")), 2_000);
        timer.unref();
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.end();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`tcp probe ${host}:${port} timed out after ${timeoutMs}ms (${lastError})`);
}

async function waitForHttp(probe, timeoutMs) {
  const startedAt = Date.now();
  let lastError = "not attempted";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchWithTimeout(
        probe.url,
        {
          method: probe.method ?? "GET",
          headers: probe.headers,
          body: probe.body,
        },
        Math.min(5_000, timeoutMs),
      );
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (probe.includes !== undefined && !body.includes(probe.includes)) {
        throw new Error(`response omitted ${JSON.stringify(probe.includes)}`);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`http probe ${probe.url} timed out after ${timeoutMs}ms (${lastError})`);
}

async function runDependencyProbe() {
  const raw = requiredEnv("HARNESS_DEPENDENCY_PROBES");
  const probes = JSON.parse(raw);
  if (!Array.isArray(probes) || probes.length === 0 || probes.length > 32) {
    throw new Error("HARNESS_DEPENDENCY_PROBES must be a non-empty array of at most 32 probes");
  }
  const timeoutMs = boundedIntegerEnv("HARNESS_DEPENDENCY_TIMEOUT_MS", 240_000, 1_000, 600_000);
  const server = createServer((request, response) => {
    if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role });
    return sendJson(response, 404, { error: "not_found" });
  });
  server.on("listening", async () => {
    try {
      for (const probe of probes) {
        if (!probe || typeof probe !== "object" || Array.isArray(probe)) throw new Error("invalid dependency probe");
        if (probe.kind === "tcp") {
          if (typeof probe.host !== "string" || !Number.isInteger(probe.port)) throw new Error("invalid tcp probe");
          await waitForTcp(probe.host, probe.port, timeoutMs);
        } else if (probe.kind === "http") {
          if (typeof probe.url !== "string") throw new Error("invalid http probe");
          await waitForHttp(probe, timeoutMs);
        } else {
          throw new Error(`unsupported dependency probe kind ${String(probe.kind)}`);
        }
      }
      ready = true;
    } catch (error) {
      console.error("dependency probe failed", error);
    }
  });
  return server;
}

async function assertTcpUnreachable(host, port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error("expected isolation timeout")), 1_500);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`isolation breach: connected to ${host}:${port}`));
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runIsolationProbe() {
  const targets = JSON.parse(requiredEnv("HARNESS_FORBIDDEN_TCP_TARGETS"));
  const prefixes = JSON.parse(requiredEnv("HARNESS_FORBIDDEN_ENV_PREFIXES"));
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 16) {
    throw new Error("HARNESS_FORBIDDEN_TCP_TARGETS must be a non-empty array of at most 16 targets");
  }
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > 16) {
    throw new Error("HARNESS_FORBIDDEN_ENV_PREFIXES must be a non-empty array of at most 16 prefixes");
  }
  const server = createServer((request, response) => {
    if (request.url === "/ready") return sendJson(response, ready ? 200 : 503, { ready, role });
    return sendJson(response, 404, { error: "not_found" });
  });
  server.on("listening", async () => {
    try {
      for (const prefix of prefixes) {
        if (typeof prefix !== "string" || !/^[A-Z][A-Z0-9_]{1,31}$/.test(prefix)) {
          throw new Error("invalid forbidden environment prefix");
        }
        const leaked = Object.keys(process.env).filter((name) => name.startsWith(prefix));
        if (leaked.length > 0) throw new Error(`forbidden environment keys present: ${leaked.join(",")}`);
      }
      for (const target of targets) {
        if (
          !target ||
          typeof target !== "object" ||
          Array.isArray(target) ||
          typeof target.host !== "string" ||
          !Number.isInteger(target.port) ||
          target.port < 1 ||
          target.port > 65_535
        ) {
          throw new Error("invalid forbidden TCP target");
        }
        await assertTcpUnreachable(target.host, target.port);
      }
      ready = true;
    } catch (error) {
      console.error("isolation probe failed", error);
    }
  });
  return server;
}

async function runTcpForwarder() {
  const targetHost = requiredEnv("HARNESS_TCP_TARGET_HOST");
  const targetPort = boundedIntegerEnv("HARNESS_TCP_TARGET_PORT", 0, 1, 65_535);
  return createTcpServer((downstream) => {
    const connectionId = randomUUID();
    const remoteAddress = downstream.remoteAddress?.replace(/^::ffff:/, "") ?? null;
    const recordConnection = collectorUrl && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1";
    if (recordConnection) {
      void record({
        channel,
        phase: "connection-open",
        connectionId,
        remoteAddress,
        targetHost,
        targetPort,
      }).catch((error) => {
        console.error("tcp-forwarder connection record failed", error);
        downstream.destroy();
      });
    }
    const upstream = connect({ host: targetHost, port: targetPort });
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => {
      if (recordConnection) {
        void record({ channel, phase: "connection-close", connectionId }).catch(() => {});
      }
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
}

let server;
if (role === "collector") server = await runCollector();
else if (role === "proxy") server = await runProxy();
else if (role === "offerfiles-probe") server = await runOfferFilesProbe();
else if (role === "solver-probe") server = await runSolverProbe();
else if (role === "telemetry") server = await runTelemetryRelay();
else if (role === "dependency-probe") server = await runDependencyProbe();
else if (role === "isolation-probe") server = await runIsolationProbe();
else if (role === "tcp-forwarder") server = await runTcpForwarder();
else if (role === "ntp-responder") {
  const ntp = await runNtpResponder();
  server = ntp.server;
  startAfterListen = ntp.start;
  closeRoleResources = ntp.close;
}
else throw new Error(`unsupported HARNESS_ROLE ${role}`);

server.listen(PORT, HOST, () => {
  if (role === "collector" || role === "proxy" || role === "telemetry" || role === "tcp-forwarder") ready = true;
  console.log(`${role}:${channel} listening on ${HOST}:${PORT}`);
  void startAfterListen();
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  console.log(`${role}:${channel} stopping on ${signal}`);
  const timer = setTimeout(() => process.exit(1), 4_000);
  timer.unref();
  const httpClosed = new Promise((resolve) => server.close(() => resolve()));
  await Promise.allSettled([httpClosed, closeRoleResources()]);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
