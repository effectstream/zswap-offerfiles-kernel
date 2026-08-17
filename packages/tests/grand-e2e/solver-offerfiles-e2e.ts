/**
 * Focused Offer Files solver E2E runner.
 *
 * E0 deliberately boots only inert probe services. The real Story 1–4
 * services/scenarios are dependency-gated in the acceptance plan. This file
 * owns the reusable lifecycle: ephemeral Compose, dynamic host ports, explicit
 * readiness, recorded/fault-injected boundaries, and unconditional teardown.
 *
 *   bun run packages/tests/grand-e2e/solver-offerfiles-e2e.ts --verify-e0
 *   bun run packages/tests/grand-e2e/solver-offerfiles-e2e.ts --verify-e1-topology
 *   bun run packages/tests/grand-e2e/solver-offerfiles-e2e.ts --verify-e1-services
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

import {
  REAL_E1_PINS,
  REAL_E1_PROOF_COMMAND,
  REAL_E1_PROOF_COMPOSE_COMMAND,
  REAL_E1_PROOF_ENTRYPOINT,
  REAL_E1_PROOF_STAT,
  REAL_E1_PROOF_START_MARKER_PREFIX,
  realE1AcceptanceComposeSource,
  realE1AppDockerfile,
  realE1CelestiaDockerfile,
  realE1ComposeSource,
} from "./lib/solver-offerfiles-real-e1.ts";
import {
  assertDirectProofLogSafe,
  assertMixedComposeProofLogSafe,
  assertNoProofMaterialLogSignatures,
} from "./lib/solver-offerfiles-real-proof-log-scan.ts";

const NODE_IMAGE =
  "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43";
const SERVICE_SOURCE = fileURLToPath(new URL("./lib/solver-offerfiles-harness-service.mjs", import.meta.url));
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGE_SECRET_SCANNER_RELATIVE =
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-image-secret-scan.sh";
const TEMP_PREFIX = "zswap-offerfiles-e2e-";
const FORBIDDEN_HISTORICAL_PORT_MIN = 14_350;
const FORBIDDEN_HISTORICAL_PORT_MAX = 14_380;
const MIN_HOST_PORT = 10_000;
const MAX_HOST_PORT_EXCLUSIVE = 61_000;
const CLEAN_SETTLE_MS = 5_000;
const REAL_E1_FAILURE_COMMAND_ERROR_MAX_BYTES = 1024 * 1024;
const REAL_E1_FAILURE_SERVICE_TAIL_MAX_BYTES = 4 * 1024 * 1024;
const REAL_E1_APP_IMAGE_LABELS = Object.freeze({
  "org.zswap.e1.role": "native-app-toolchain",
  "org.zswap.e1.app-build-bun-image": REAL_E1_PINS.appBuildBunImage,
  "org.zswap.e1.app-build-bun": REAL_E1_PINS.appBuildBunVersion,
  "org.zswap.e1.app-runtime-bun-image": REAL_E1_PINS.appRuntimeBunImage,
  "org.zswap.e1.app-runtime-bun": REAL_E1_PINS.appRuntimeBunVersion,
  "org.zswap.e1.app-runtime-bun-revision": REAL_E1_PINS.appRuntimeBunRevision,
  "org.zswap.e1.app-runtime-bun-sha256": REAL_E1_PINS.appRuntimeBunBinarySha256,
  "org.zswap.e1.compact": REAL_E1_PINS.compactVersion,
});
const REAL_E1_CELESTIA_IMAGE_LABELS = Object.freeze({
  "org.zswap.e1.role": "celestia-amd64-wrapper",
  "org.zswap.e1.celestia-bun": REAL_E1_PINS.celestiaBunVersion,
  "org.zswap.e1.celestia-bun-sha256": REAL_E1_PINS.celestiaBunBinarySha256,
  "org.zswap.e1.celestia-app": REAL_E1_PINS.celestiaAppVersion,
  "org.zswap.e1.celestia-node": REAL_E1_PINS.celestiaNodeVersion,
});
const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "SSH_AUTH_SOCK",
  "SYSTEM_VERSION_COMPAT",
]);
const E0_SERVICES = [
  "traffic-recorder",
  "celestia-proxy",
  "batcher-proxy",
  "offerfiles-probe",
  "backend-proxy",
  "solver-probe",
] as const;
const E1_FOUNDATION_SERVICES = [...E0_SERVICES, "telemetry-relay"] as const;
const REAL_E1_ALLOWED_UNTRACKED_PATHS = Object.freeze([
  "packages/node/offer-liveness.ts",
  "packages/node/offer-validation.test.ts",
  "packages/node/offer-validation.ts",
  "packages/node/solver-liquidity-route.test.ts",
  "packages/node/solver-liquidity.test.ts",
  "packages/node/validation-contexts.characterization.test.ts",
  "packages/solver-core/api-client.sync-health.test.ts",
  "packages/solver-core/api-client.validation.test.ts",
  "packages/solver-core/discovery-boundary.test.ts",
  "packages/solver-core/fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-live.json",
  "packages/solver-core/fixtures/offer-files-data-lineage/v1/upstream-liquidity-200-withdrawn.json",
  "packages/solver-core/fixtures/offer-validation/v1/request.json",
  "packages/solver-core/fixtures/offer-validation/v1/verdict-expired-before-archive.json",
  "packages/solver-core/fixtures/offer-validation/v1/verdict-live-but-invalid.json",
  "packages/solver-core/fixtures/offer-validation/v1/verdict-not-indexed.json",
  "packages/solver-core/fixtures/offer-validation/v1/verdict-unsupported-profile.json",
  "packages/solver-core/fixtures/offer-validation/v1/verdict-valid.json",
  "packages/solver-core/liquidity-contract.test.ts",
  "packages/solver-core/liquidity-contract.ts",
  "packages/solver-core/validation-contract.test.ts",
  "packages/solver-core/validation-contract.ts",
  "packages/solver/backend-currentness.characterization.test.ts",
  "packages/solver/backend-currentness.integration.test.ts",
  "packages/solver/readiness-state.test.ts",
  "packages/solver/src/readiness-state.ts",
  "packages/solver/src/validation-gate.ts",
  "packages/solver/validation-gate.test.ts",
  "packages/tests/data-lineage-e2e/offer-files-service.ts",
  "packages/tests/data-lineage-e2e/relay-service.mjs",
  "packages/tests/data-lineage-e2e/run.ts",
  "packages/tests/data-lineage-e2e/upstream-recorder.mjs",
  "packages/tests/grand-e2e/lib/solver-offerfiles-celestia.bun.lock",
  "packages/tests/grand-e2e/lib/solver-offerfiles-celestia.package.json",
  "packages/tests/grand-e2e/lib/solver-offerfiles-harness-service.mjs",
  "packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.bun.lock",
  "packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.package.json",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-e1.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-fixtures.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-image-secret-scan.sh",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-image-secret-scan.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-invalid-fixtures.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-invalid-fixtures.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-ntp-responder.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-proof-log-scan.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-proof-log-scan.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-runtime-smoke.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-settlement-verifier.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-settlement-verifier.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-solver-service.ts",
  "packages/tests/grand-e2e/solver-offerfiles-e2e.ts",
  "packages/validator/liveness.test.ts",
  "packages/validator/liveness.ts",
]);
const REAL_E1_REQUIRED_SOURCE_PATHS = Object.freeze([
  "packages/node/offer-liveness.ts",
  "packages/node/offer-validation.ts",
  "packages/solver-core/liquidity-contract.ts",
  "packages/solver-core/validation-contract.ts",
  "packages/solver/src/readiness-state.ts",
  "packages/solver/src/validation-gate.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-celestia.bun.lock",
  "packages/tests/grand-e2e/lib/solver-offerfiles-celestia.package.json",
  "packages/tests/grand-e2e/lib/solver-offerfiles-harness-service.mjs",
  "packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.bun.lock",
  "packages/tests/grand-e2e/lib/solver-offerfiles-node-gyp.package.json",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-e1.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-image-secret-scan.sh",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-image-secret-scan.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-invalid-fixtures.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-ntp-responder.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-proof-log-scan.test.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-proof-log-scan.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-runtime-smoke.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-settlement-verifier.ts",
  "packages/tests/grand-e2e/lib/solver-offerfiles-real-solver-service.ts",
  "packages/tests/grand-e2e/solver-offerfiles-e2e.ts",
  "packages/validator/liveness.ts",
]);
const REAL_E1_ALLOWED_ENV_TEMPLATES = new Set([
  ".env.mainnet.example",
  ".env.preview.example",
  "docs/.env.development",
  "docs/.env.example",
  "docs/.env.preview",
]);
const CELESTIA_PACKAGE_SOURCE = fileURLToPath(
  new URL("./lib/solver-offerfiles-celestia.package.json", import.meta.url),
);
const CELESTIA_LOCK_SOURCE = fileURLToPath(
  new URL("./lib/solver-offerfiles-celestia.bun.lock", import.meta.url),
);

type ServiceName = (typeof E1_FOUNDATION_SERVICES)[number];

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PortReservation {
  port: number;
  release: () => Promise<void>;
}

interface SessionFiles {
  directory: string;
  compose: string;
  environment: string;
  traffic: string;
  telemetryToken?: string;
  telemetryRunId?: string;
  generatedSecrets?: string[];
}

interface CleanupEvidence {
  downCode: number;
  containers: string[];
  networks: string[];
  volumes: string[];
  listenerReleased: boolean;
  activeDriverProcesses: number;
  temporaryDirectoryRemoved: boolean;
  errors: string[];
}

interface HarnessResult {
  project: string;
  recorderPort: number;
  eventCount: number;
  channels: string[];
  testError: string | null;
  diagnosticsSha256: string | null;
  cleanup: CleanupEvidence;
}

interface HarnessSession {
  project: string;
  recorderPort: number;
  foundation: boolean;
  services: readonly ServiceName[];
  files: SessionFiles;
  children: Set<ChildProcessWithoutNullStreams>;
  cleanup: () => Promise<CleanupEvidence>;
}

interface RealE1SessionFiles extends SessionFiles {
  appContext: string;
  appDockerfile: string;
  appImageId: string;
  celestiaContext: string;
  celestiaDockerfile: string;
  celestiaImageId: string;
  imageSecretScanner: string;
  runtimeDirectory: string;
  proofLogMarker: string;
  sourceManifestCount: number;
  sourceManifestSha256: string;
}

interface RealE1CleanupEvidence extends CleanupEvidence {
  selfCheckContainersRemoved: string[];
  retainedSelfCheckContainers: string[];
  imageTagsRemoved: string[];
  retainedImageTags: string[];
  imageIdsRemoved: string[];
  retainedImageIds: string[];
  sharedImageIds: string[];
}

interface RealE1Result {
  project: string;
  recorderPort: number;
  status: "PREFLIGHT_PASS";
  e1Gate: "OPEN";
  scenarioStatus: "NOT_RUN";
  appImage: {
    id: string;
    architecture: string;
    dockerfileSha256: string;
    labels: Record<string, string>;
    sourceManifestCount: number;
    sourceManifestSha256: string;
  };
  celestiaImage: { id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> };
  toolVersions: Record<string, string>;
  packageManifests: {
    app: { sha256: string; text: string };
    celestia: { sha256: string; text: string };
  };
  serviceStates: Array<Record<string, unknown>>;
  networkEvidence: Array<Record<string, unknown>>;
  runtimeHardening: RealE1RuntimeHardeningEvidence;
  celestiaHeadHeight: string;
  eventCount: number;
  artifacts: {
    traffic: { bytes: number; sha256: string; jsonl: string };
    composeLogs: { bytes: number; sha256: string; text: string };
    proofLogs: { bytes: number; sha256: string; text: string; startMarker: string };
  };
  cleanup: RealE1CleanupEvidence;
  buildCachePolicy: string;
  nextImplementationBoundary: string;
}

interface RealE1RuntimeHardeningEvidence {
  proof: {
    containerId: string;
    restartCount: 0;
    writableLayerBytes: number;
    networks: string[];
    cacheFiles: Array<{ path: string; bytes: number }>;
  };
  writableLayers: Array<{ service: string; bytes: number }>;
  runtimeLogging: Array<{ service: string; driver: string; options: Record<string, string> }>;
  proofEgressMembers: string[];
  nodeAvailableBytes: number;
}

interface RealE1NtpBoundaryEvidence {
  responderContainerId: string;
  backendContainerId: string;
  responderAddress: string;
  backendAddress: string;
  responderNetworks: string[];
  backendNetworks: string[];
  backendNtpMembers: string[];
  internalNetworks: string[];
  dns: Array<{ host: string; address: string }>;
  stats: {
    received: number;
    valid: number;
    permitted: number;
    sent: number;
    backendReserved: number;
    backendSent: number;
    selfTestSent: 1;
    maxActive: number;
  };
  readySequence: number;
  bootstrapHealthSequence: number;
  observationSequence: number;
  pairsBeforeBootstrapHealth: number;
  backendPairs: Array<{
    requestId: string;
    permitSequence: number;
    sentSequence: number;
    requestSha256: string;
    requestTransmitSha256: string;
    responseSha256: string;
    remoteAddress: string;
    remotePort: number;
    receiveMs: number;
    transmitMs: number;
  }>;
}

interface RealE1DatabaseBootstrapEvidence {
  migrations: Array<{ name: string; blockHeight: 1 }>;
  blockOneCount: 1;
  finalizedBlockOneCount: 1;
  relations: string[];
  stableNoDuplicateCheck: true;
}

const E1_GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const REAL_E1_NTP_ALIASES = Object.freeze([
  "e1-ntp-boundary",
  "0.pool.ntp.org",
  "1.pool.ntp.org",
  "2.pool.ntp.org",
  "3.pool.ntp.org",
]);
const REAL_E1_MIGRATION_NAMES = Object.freeze([
  "000-init.sql",
  "001-spent-sets.sql",
  "002-liveness-sets.sql",
  "003-token-prices.sql",
  "004-pair-stats.sql",
  "005-offer-hash.sql",
  "006-offer-rejections.sql",
  "007-cursor-pagination.sql",
  "008-nullifier-tx-hash.sql",
  "009-leg-kind.sql",
  "010-drop-auth-and-note.sql",
  "011-root-first-seen.sql",
  "012-first-seen-at.sql",
  "013-commitments.sql",
  "local-migration.sql",
]);
const REAL_E1_REQUIRED_DATABASE_RELATIONS = Object.freeze([
  "commitments",
  "created_unshielded",
  "known_roots",
  "known_tokens",
  "nullifiers",
  "offer_file",
  "offer_file_commitments",
  "offer_file_commitments_history",
  "offer_file_history",
  "offer_file_nullifiers",
  "offer_file_nullifiers_history",
  "offer_file_tokens",
  "offer_file_tokens_history",
  "offer_file_unshielded_spends",
  "offer_file_unshielded_spends_history",
  "offer_rejections",
  "pair_stats",
  "token_prices",
].sort());
const E1_CASE_NAMES = Object.freeze([
  "boot",
  "admission-delay",
  "domain-invalid",
  "http-404",
  "http-400",
  "http-413",
  "http-429",
  "http-500",
  "http-503",
  "malformed",
  "timeout",
  "disconnect",
  "wrong-identity",
  "mismatch",
  "stale-state-version",
  "unknown-schema",
  "unknown-status",
  "unknown-code",
  "dequeue-domain-invalid",
  "dequeue-unavailable",
  "valid-fill",
]);

interface RealE1AcceptanceIdentity {
  caseName: string;
  runId: string;
  solverToken: string;
  recorderToken: string;
}

interface RealE1AcceptanceConfig {
  runId: string;
  identities: RealE1AcceptanceIdentity[];
  postgresPassword: string;
  indexerSecret: string;
  storagePassword: string;
  liquidityReadSecret: string;
  userSeed: string;
  solverSeed: string;
  secrets: string[];
  oneShotLogs: Array<{ service: string; path: string; bytes: number; sha256: string; text: string }>;
}

interface RealE1ServiceBootResult {
  project: string;
  recorderPort: number;
  status: "SERVICES_PASS";
  e1Gate: "OPEN";
  scenarioStatus: "BOOTSTRAP_ONLY";
  appImage: { id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> };
  celestiaImage: { id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> };
  toolVersions: Record<string, string>;
  packageManifestHashes: { app: string; celestia: string };
  backendHealth: Record<string, unknown>;
  ntpBoundary: RealE1NtpBoundaryEvidence;
  databaseBootstrap: RealE1DatabaseBootstrapEvidence;
  actor: { offerHash: string; manifestSha256: string; ladderSha256: string };
  publication: { evidenceSha256: string };
  indexedOffer: Record<string, unknown>;
  validationVerdict: Record<string, unknown>;
  eventCount: number;
  artifacts: RealE1Result["artifacts"];
  cleanup: RealE1CleanupEvidence;
  oneShotLogs: Array<{ service: string; path: string; bytes: number; sha256: string; text: string }>;
  runtimeArtifacts: Array<{ path: string; bytes: number; sha256: string }>;
  runtimeHardening: RealE1RuntimeHardeningEvidence;
}

interface RealE1CaseEvidence {
  caseName: string;
  runId: string;
  startSequence: number;
  endSequence: number;
  validationRequests: number;
  runtimeSha256: string;
  telemetrySha256: string;
  centralSliceSha256: string;
  manifestSha256: string;
  solverExitCode: 143;
  solverLogsSha256: string;
  solverLogsBytes: number;
  solverLogs: string;
  submissionCount: number;
  walletBoundaryCalls: Record<string, number>;
}

interface RealE1AcceptanceResult {
  project: string;
  recorderPort: number;
  status: "E1_PASS";
  e1Gate: "PASS";
  scenarioStatus: "REAL_SERVICES_COMPLETE";
  appImage: { id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> };
  celestiaImage: { id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> };
  toolVersions: Record<string, string>;
  packageManifestHashes: { app: string; celestia: string };
  ntpBoundary: RealE1NtpBoundaryEvidence;
  databaseBootstrap: RealE1DatabaseBootstrapEvidence;
  offerHash: string;
  invalidCorpus: Array<{ label: string; payloadSha256: string; evidenceSha256: string }>;
  cases: RealE1CaseEvidence[];
  walletSettlementSha256: string;
  backendSettlementSha256: string;
  eventCount: number;
  artifacts: RealE1Result["artifacts"];
  cleanup: RealE1CleanupEvidence;
  oneShotLogs: Array<{ service: string; path: string; bytes: number; sha256: string; text: string }>;
  runtimeArtifacts: Array<{ path: string; bytes: number; sha256: string }>;
  runtimeHardening: RealE1RuntimeHardeningEvidence;
}

interface RealE1Session {
  project: string;
  recorderPort: number;
  appImage: string;
  celestiaImage: string;
  files: RealE1SessionFiles;
  children: Set<ChildProcessWithoutNullStreams>;
  cleanup: () => Promise<RealE1CleanupEvidence>;
}

const emergencyCleanups = new Map<string, () => Promise<CleanupEvidence>>();
let handlingSignal = false;
let signalHandlingPromise: Promise<void> | null = null;
let realE1OuterCleanupProbeMs = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function projectName(foundation: boolean): string {
  return `zswap-${foundation ? "e1f" : "e0"}-${process.pid}-${randomBytes(5).toString("hex")}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reserveRandomPort(excluded: Set<number>): Promise<PortReservation> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const port = randomInt(MIN_HOST_PORT, MAX_HOST_PORT_EXCLUSIVE);
    if (
      excluded.has(port) ||
      (port >= FORBIDDEN_HISTORICAL_PORT_MIN && port <= FORBIDDEN_HISTORICAL_PORT_MAX)
    ) {
      continue;
    }

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
        // A failed listen has no open listener to close.
      }
    }
  }
  throw new Error("could not reserve a random free host port at or above 10000");
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
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
  children: Set<ChildProcessWithoutNullStreams>,
  options: { timeoutMs?: number; allowFailure?: boolean; maxOutputBytes?: number } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes;
  if (maxOutputBytes !== undefined) {
    assert(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0, "maxOutputBytes must be a positive integer");
  }
  const child = spawn(command, args, {
    env: childCommandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputExceeded = false;
  const retainOutput = (stream: "stdout" | "stderr", chunk: string): void => {
    if (outputExceeded) return;
    outputBytes += Buffer.byteLength(chunk);
    if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
      outputExceeded = true;
      stdout = "";
      stderr = "";
      child.kill("SIGTERM");
      const hardStop = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hardStop.unref();
      return;
    }
    if (stream === "stdout") stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    retainOutput("stdout", chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    retainOutput("stderr", chunk);
  });

  const result = await new Promise<CommandResult>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardStop = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hardStop.unref();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputExceeded) {
        reject(new Error(`${command} ${args.join(" ")} exceeded output cap ${maxOutputBytes} bytes`));
        return;
      }
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  }).finally(() => {
    children.delete(child);
  });

  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function childCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment["COMPOSE_ANSI"] = "never";
  environment["COMPOSE_PROGRESS"] = "plain";
  environment["DOCKER_CLI_HINTS"] = "false";
  return environment;
}

function assertHostileAmbientEnvironmentIsScrubbed(): void {
  const hostile: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    DOCKER_CONTEXT: process.env["DOCKER_CONTEXT"],
    POSTGRES_PASSWORD: "hostile-postgres",
    MIDNIGHT_INDEXER_SECRET: "hostile-indexer",
    TELEMETRY_TOKEN: "hostile-telemetry",
    E1_USER_SEED: "hostile-seed",
    SOLVER_AUTH_REGISTRY: "hostile-registry",
    COMPOSE_PROFILES: "acceptance-manual",
    COMPOSE_ENV_FILES: "/tmp/hostile.env",
    COMPOSE_FILE: "/tmp/hostile.yaml",
  };
  const scrubbed = childCommandEnvironment(hostile);
  for (const name of [
    "POSTGRES_PASSWORD",
    "MIDNIGHT_INDEXER_SECRET",
    "TELEMETRY_TOKEN",
    "E1_USER_SEED",
    "SOLVER_AUTH_REGISTRY",
    "COMPOSE_PROFILES",
    "COMPOSE_ENV_FILES",
    "COMPOSE_FILE",
  ]) {
    assert(scrubbed[name] === undefined, `child environment retained hostile ${name}`);
  }
  assert(scrubbed["PATH"] === hostile.PATH, "child environment dropped PATH");
  assert(scrubbed["COMPOSE_ANSI"] === "never", "child environment did not pin COMPOSE_ANSI");
  assert(scrubbed["COMPOSE_PROGRESS"] === "plain", "child environment did not pin COMPOSE_PROGRESS");
}

function composeArgs(session: Pick<HarnessSession, "project" | "files">, args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    session.project,
    "--env-file",
    session.files.environment,
    "--file",
    session.files.compose,
    ...args,
  ];
}

async function runCompose(
  session: Pick<HarnessSession, "project" | "files" | "children">,
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean; maxOutputBytes?: number } = {},
): Promise<CommandResult> {
  return runCommand("docker", composeArgs(session, args), session.children, options);
}

function composeSource(serviceSource: string, trafficPath: string, foundation: boolean): string {
  const healthcheck = quoteYaml(
    "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
  );
  const source = quoteYaml(serviceSource);
  const traffic = quoteYaml(trafficPath);
  const telemetryService = foundation
    ? `
  telemetry-relay:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: telemetry
      HARNESS_CHANNEL: solver-validation
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_TELEMETRY_TOKEN: \${TELEMETRY_TOKEN:?TELEMETRY_TOKEN must be set}
      HARNESS_TELEMETRY_RUN_ID: \${TELEMETRY_RUN_ID:?TELEMETRY_RUN_ID must be set}
    networks: [solver_front, control]
`
    : "";
  return `x-harness-service: &harness-service
  image: ${NODE_IMAGE}
  pull_policy: missing
  command: ["node", "/opt/harness/service.mjs"]
  restart: "no"
  init: true
  volumes:
    - type: bind
      source: ${source}
      target: /opt/harness/service.mjs
      read_only: true
  healthcheck:
    test: ["CMD", "node", "-e", ${healthcheck}]
    interval: 1s
    timeout: 1s
    retries: 40
    start_period: 1s

services:
  traffic-recorder:
    <<: *harness-service
    environment:
      HARNESS_ROLE: collector
      HARNESS_CHANNEL: recorder
      HARNESS_TRAFFIC_PATH: /opt/harness/traffic.jsonl
    volumes:
      - type: bind
        source: ${source}
        target: /opt/harness/service.mjs
        read_only: true
      - type: bind
        source: ${traffic}
        target: /opt/harness/traffic.jsonl
    ports:
      - "127.0.0.1:\${RECORDER_HOST_PORT:?RECORDER_HOST_PORT must be set}:8080"
    networks: [control, host_access]

  celestia-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: celestia
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
    networks: [backend_egress, control]

  batcher-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: batcher
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
    networks: [backend_egress, control]

  offerfiles-probe:
    <<: *harness-service
    depends_on:
      celestia-proxy: { condition: service_healthy }
      batcher-proxy: { condition: service_healthy }
    environment:
      HARNESS_ROLE: offerfiles-probe
      CELESTIA_RPC_URL: http://celestia-proxy:8080
      BATCHER_SUBMIT_URL: http://batcher-proxy:8080/send-input
    networks: [offerfiles_private, backend_egress]

  backend-proxy:
    <<: *harness-service
    depends_on:
      traffic-recorder: { condition: service_healthy }
      offerfiles-probe: { condition: service_healthy }
    environment:
      HARNESS_ROLE: proxy
      HARNESS_CHANNEL: backend
      HARNESS_COLLECTOR_URL: http://traffic-recorder:8080
      HARNESS_UPSTREAM_URL: http://offerfiles-probe:8080
    networks: [solver_front, offerfiles_private, control]

  solver-probe:
    <<: *harness-service
    depends_on:
      backend-proxy: { condition: service_healthy }
    environment:
      HARNESS_ROLE: solver-probe
      OFFER_FILES_BACKEND_URL: http://backend-proxy:8080
    networks: [solver_front]
${telemetryService}

networks:
  solver_front: { internal: true }
  offerfiles_private: { internal: true }
  backend_egress: { internal: true }
  control: { internal: true }
  host_access: {}
`;
}

async function createSessionFiles(
  project: string,
  recorderPort: number,
  foundation: boolean,
  signal: AbortSignal,
  onDirectoryCreated: (directory: string) => void,
): Promise<SessionFiles> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  assert(directory.startsWith(join(tmpdir(), TEMP_PREFIX)), `unsafe temporary directory ${directory}`);
  onDirectoryCreated(directory);
  const compose = join(directory, "compose.yaml");
  const environment = join(directory, "compose.env");
  const traffic = join(directory, "traffic.jsonl");
  const telemetryToken = foundation ? randomBytes(32).toString("hex") : undefined;
  const telemetryRunId = foundation ? `e1-foundation-${randomBytes(12).toString("hex")}` : undefined;
  try {
    signal.throwIfAborted();
    await mkdir(dirname(compose), { recursive: true });
    await writeFile(traffic, "", { encoding: "utf8", mode: 0o600 });
    signal.throwIfAborted();
    await writeFile(
      environment,
      [
        `RECORDER_HOST_PORT=${recorderPort}`,
        ...(telemetryToken === undefined ? [] : [`TELEMETRY_TOKEN=${telemetryToken}`]),
        ...(telemetryRunId === undefined ? [] : [`TELEMETRY_RUN_ID=${telemetryRunId}`]),
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(compose, composeSource(SERVICE_SOURCE, traffic, foundation), { encoding: "utf8", mode: 0o600 });
    const holdRaw = process.env["E0_CONSTRUCTION_HOLD_MS"] ?? "0";
    assert(/^\d{1,5}$/.test(holdRaw), "E0_CONSTRUCTION_HOLD_MS must be an integer in [0, 30000]");
    const holdMs = Number(holdRaw);
    assert(holdMs <= 30_000, "E0_CONSTRUCTION_HOLD_MS must be an integer in [0, 30000]");
    if (holdMs > 0) {
      console.error(`[solver-offerfiles-e2e] harness construction probe ready: project=${project} directory=${directory}`);
    }
    await sleepWithAbort(holdMs, signal);
    signal.throwIfAborted();
    return {
      directory,
      compose,
      environment,
      traffic,
      ...(telemetryToken === undefined ? {} : { telemetryToken }),
      ...(telemetryRunId === undefined ? {} : { telemetryRunId }),
      ...(telemetryToken === undefined ? {} : { generatedSecrets: [telemetryToken] }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function realE1ProjectName(): string {
  return `zswap-e1r-${process.pid}-${randomBytes(5).toString("hex")}`;
}

function assertRealE1SourcePath(path: string): void {
  assert(
    !path.startsWith("/") && !path.split("/").includes("..") && !/[\x00-\x1f\x7f]/.test(path),
    `unsafe real E1 source-manifest path ${JSON.stringify(path)}`,
  );
  const lower = path.toLowerCase();
  const basename = lower.slice(lower.lastIndexOf("/") + 1);
  const sensitive =
    (basename === ".env" || basename.startsWith(".env.")) ||
    /(^|\/)(batcher-data|credentials?|secrets?)(\/|$)/i.test(path) ||
    /(^|\/)(id_rsa(?:\.pub)?|contract\.json)$/i.test(path) ||
    /\.(?:pem|p12|pfx|sqlite|sqlite3|db)$/i.test(path);
  assert(!sensitive || REAL_E1_ALLOWED_ENV_TEMPLATES.has(path), `sensitive path rejected from E1 context: ${path}`);
}

async function realE1SourceRecord(root: string, path: string): Promise<Buffer> {
  const absolute = join(root, path);
  const metadata = await lstat(absolute);
  const mode = (metadata.mode & 0o7777).toString(8).padStart(4, "0");
  let type: "file" | "symlink";
  let payload: Buffer;
  if (metadata.isFile()) {
    type = "file";
    payload = await readFile(absolute);
  } else if (metadata.isSymbolicLink()) {
    type = "symlink";
    const target = await readlink(absolute);
    assert(!/[\x00-\x1f\x7f]/.test(target), `control-character symlink rejected from E1 context: ${path}`);
    assert(!target.startsWith("/"), `absolute symlink rejected from E1 context: ${path} -> ${target}`);
    const resolvedTarget = resolve(dirname(absolute), target);
    assert(
      resolvedTarget === root || resolvedTarget.startsWith(`${root}/`),
      `out-of-tree symlink rejected from E1 context: ${path} -> ${target}`,
    );
    payload = Buffer.from(target);
  } else {
    throw new Error(`unsupported source entry type for ${path}`);
  }
  return Buffer.concat([
    Buffer.from(path),
    Buffer.from([0]),
    Buffer.from(`${type}/${mode}`),
    Buffer.from([0]),
    payload,
    Buffer.from([0]),
  ]);
}

async function realE1SourceManifest(children: Set<ChildProcessWithoutNullStreams>): Promise<string[]> {
  const sentinelName = `.zswap-e1-ignored-secret-${process.pid}-${randomBytes(5).toString("hex")}`;
  const sentinelParent = join(REPOSITORY_ROOT, "node_modules");
  const sentinelParentExisted = await pathExists(sentinelParent);
  await mkdir(sentinelParent, { recursive: true });
  const sentinel = join(sentinelParent, sentinelName);
  const sentinelRelative = relative(REPOSITORY_ROOT, sentinel);
  await writeFile(sentinel, randomBytes(32), { mode: 0o600 });
  try {
    const ignored = await runCommand(
      "git",
      ["-C", REPOSITORY_ROOT, "check-ignore", "--quiet", "--", sentinelRelative],
      children,
      { allowFailure: true, timeoutMs: 30_000 },
    );
    assert(ignored.code === 0, `source-context sentinel is not ignored: ${sentinelRelative}`);
    const [trackedResult, untrackedResult] = await Promise.all([
      runCommand("git", ["-C", REPOSITORY_ROOT, "ls-files", "-z"], children, { timeoutMs: 30_000 }),
      runCommand(
        "git",
        ["-C", REPOSITORY_ROOT, "ls-files", "--others", "--exclude-standard", "-z"],
        children,
        { timeoutMs: 30_000 },
      ),
    ]);
    const managedPrefix = "packages/contracts-midnight/contract-offer-files/src/managed/";
    const tracked = trackedResult.stdout.split("\0").filter(Boolean);
    const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
    const allowedUntracked = new Set(REAL_E1_ALLOWED_UNTRACKED_PATHS);
    const unexpectedUntracked = untracked.filter((path) => !allowedUntracked.has(path));
    assert(
      unexpectedUntracked.length === 0,
      `real E1 source context has unapproved untracked paths: ${unexpectedUntracked.join(", ")}`,
    );
    const entries = [...tracked, ...untracked].filter(
      (path) => path !== managedPrefix.slice(0, -1) && !path.startsWith(managedPrefix),
    );
    const missingRequired = REAL_E1_REQUIRED_SOURCE_PATHS.filter((path) => !entries.includes(path));
    assert(missingRequired.length === 0, `real E1 required source paths are absent: ${missingRequired.join(", ")}`);
    assert(entries.length > 0, "real E1 source manifest is empty");
    assert(!entries.includes(sentinelRelative), "ignored secret sentinel leaked into the source manifest");
    assert(new Set(entries).size === entries.length, "real E1 source manifest contains duplicate entries");
    for (const path of entries) assertRealE1SourcePath(path);
    return entries.sort();
  } finally {
    await rm(sentinel, { force: true });
    if (!sentinelParentExisted) {
      try {
        await rmdir(sentinelParent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      }
    }
  }
}

async function createRealE1SessionFiles(
  project: string,
  recorderPort: number,
  appImage: string,
  celestiaImage: string,
  children: Set<ChildProcessWithoutNullStreams>,
  signal: AbortSignal,
  onDirectoryCreated: (directory: string) => void,
): Promise<RealE1SessionFiles> {
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  assert(directory.startsWith(join(tmpdir(), TEMP_PREFIX)), `unsafe temporary directory ${directory}`);
  onDirectoryCreated(directory);
  const compose = join(directory, "compose.yaml");
  const environment = join(directory, "compose.env");
  const traffic = join(directory, "traffic.jsonl");
  const appContext = join(directory, "app-context");
  const appDockerfile = join(appContext, "Dockerfile");
  const appImageId = join(directory, "app-image-id");
  const celestiaContext = join(directory, "celestia-context");
  const celestiaDockerfile = join(celestiaContext, "Dockerfile");
  const celestiaImageId = join(directory, "celestia-image-id");
  const imageSecretScanner = join(directory, "image-secret-scan.sh");
  const runtimeDirectory = join(directory, "runtime");
  const proofLogMarker = randomBytes(16).toString("hex");
  const topologyPostgresPassword = `e1-${randomBytes(24).toString("hex")}`;
  const topologyIndexerSecret = randomBytes(32).toString("hex").toUpperCase();
  try {
    signal.throwIfAborted();
    await Promise.all([
      mkdir(join(appContext, "source"), { recursive: true }),
      mkdir(celestiaContext, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
      ...["deployment", "actor", "publication", "invalid", "solver", "wallet-settlement", "backend-settlement", "control"].map((name) =>
        mkdir(join(runtimeDirectory, name), { recursive: true, mode: 0o700 }),
      ),
      writeFile(traffic, "", { encoding: "utf8", mode: 0o600 }),
    ]);
    signal.throwIfAborted();
    const sourceManifest = await realE1SourceManifest(children);
    const sourceManifestHash = createHash("sha256");
    const sourceManifestLines: string[] = [];
    for (const path of sourceManifest) {
      signal.throwIfAborted();
      const sourceRecord = await realE1SourceRecord(REPOSITORY_ROOT, path);
      const destination = join(appContext, "source", path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(REPOSITORY_ROOT, path), destination, { dereference: false });
      const copiedRecord = await realE1SourceRecord(join(appContext, "source"), path);
      assert(sourceRecord.equals(copiedRecord), `source changed or copied non-identically while staging ${path}`);
      sourceManifestHash.update(sourceRecord);
      sourceManifestLines.push(`${createHash("sha256").update(sourceRecord).digest("hex")}  ${path}`);
    }
    const sourceManifestText = `${sourceManifestLines.join("\n")}\n`;
    const sourceManifestSha256 = sourceManifestHash.digest("hex");
    await writeFile(join(appContext, "source-manifest.txt"), sourceManifestText, {
      encoding: "utf8",
      mode: 0o600,
    });
    const [appDockerfileSource, celestiaDockerfileSource] = [
      realE1AppDockerfile(),
      realE1CelestiaDockerfile(),
    ];
    await Promise.all([
      writeFile(appDockerfile, appDockerfileSource, { encoding: "utf8", mode: 0o600 }),
      writeFile(celestiaDockerfile, celestiaDockerfileSource, { encoding: "utf8", mode: 0o600 }),
      cp(CELESTIA_PACKAGE_SOURCE, join(celestiaContext, "package.json")),
      cp(CELESTIA_LOCK_SOURCE, join(celestiaContext, "bun.lock")),
      writeFile(appImageId, "", { encoding: "utf8", mode: 0o600 }),
      writeFile(celestiaImageId, "", { encoding: "utf8", mode: 0o600 }),
      (async () => {
        await cp(join(appContext, "source", IMAGE_SECRET_SCANNER_RELATIVE), imageSecretScanner);
        await chmod(imageSecretScanner, 0o500);
      })(),
      writeFile(
        environment,
        [
          `RECORDER_HOST_PORT=${recorderPort}`,
          `POSTGRES_PASSWORD=${topologyPostgresPassword}`,
          `MIDNIGHT_INDEXER_SECRET=${topologyIndexerSecret}`,
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        compose,
        realE1ComposeSource({
          appImage,
          celestiaImage,
          serviceSource: SERVICE_SOURCE,
          trafficPath: traffic,
          proofLogMarker,
        }),
        { encoding: "utf8", mode: 0o600 },
      ),
    ]);
    const holdRaw = process.env["E1_REAL_CONSTRUCTION_HOLD_MS"] ?? "0";
    assert(/^\d{1,5}$/.test(holdRaw), "E1_REAL_CONSTRUCTION_HOLD_MS must be an integer in [0, 30000]");
    const holdMs = Number(holdRaw);
    assert(holdMs <= 30_000, "E1_REAL_CONSTRUCTION_HOLD_MS must be an integer in [0, 30000]");
    if (holdMs > 0) {
      console.error(
        `[solver-offerfiles-e2e] real E1 construction probe ready: project=${project} directory=${directory}`,
      );
    }
    await sleepWithAbort(holdMs, signal);
    signal.throwIfAborted();
    return {
      directory,
      compose,
      environment,
      traffic,
      appContext,
      appDockerfile,
      appImageId,
      celestiaContext,
      celestiaDockerfile,
      celestiaImageId,
      imageSecretScanner,
      runtimeDirectory,
      proofLogMarker,
      generatedSecrets: [topologyPostgresPassword, topologyIndexerSecret],
      sourceManifestCount: sourceManifest.length,
      sourceManifestSha256,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function buildRealE1Images(session: RealE1Session): Promise<void> {
  const builds = await Promise.allSettled([
    runCommand(
      "docker",
      [
        "build",
        "--platform",
        "linux/arm64",
        "--progress",
        "plain",
        "--tag",
        session.appImage,
        "--iidfile",
        session.files.appImageId,
        "--file",
        session.files.appDockerfile,
        session.files.appContext,
      ],
      session.children,
      { timeoutMs: 1_200_000 },
    ),
    runCommand(
      "docker",
      [
        "build",
        "--platform",
        "linux/amd64",
        "--progress",
        "plain",
        "--tag",
        session.celestiaImage,
        "--iidfile",
        session.files.celestiaImageId,
        "--file",
        session.files.celestiaDockerfile,
        session.files.celestiaContext,
      ],
      session.children,
      { timeoutMs: 1_200_000 },
    ),
  ]);
  const failures = builds.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), "one or more real E1 image builds failed");
  }
}

function createRealE1Cleanup(session: Omit<RealE1Session, "cleanup">): () => Promise<RealE1CleanupEvidence> {
  const harnessCleanup = createCleanup({
    project: session.project,
    recorderPort: session.recorderPort,
    foundation: false,
    services: [],
    files: session.files,
    children: session.children,
  }, { unregister: false });
  let cleanupPromise: Promise<RealE1CleanupEvidence> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      const expectedImageIds = new Set<string>();
      const outerErrors: string[] = [];
      for (const iidPath of [session.files.appImageId, session.files.celestiaImageId]) {
        try {
          const iid = (await readFile(iidPath, "utf8")).trim();
          if (iid !== "") {
            if (/^sha256:[0-9a-f]{64}$/.test(iid)) expectedImageIds.add(iid);
            else outerErrors.push(`invalid generated image IID recorded in ${iidPath}`);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            outerErrors.push(`image IID read failed for ${iidPath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const cleanup = await harnessCleanup().catch((error): CleanupEvidence => ({
        downCode: -1,
        containers: [],
        networks: [],
        volumes: [],
        listenerReleased: false,
        activeDriverProcesses: session.children.size,
        temporaryDirectoryRemoved: false,
        errors: [`base cleanup threw: ${error instanceof Error ? error.message : String(error)}`],
      }));
      cleanup.errors.push(...outerErrors);
      if (realE1OuterCleanupProbeMs > 0) {
        console.error(`[solver-offerfiles-e2e] real E1 outer cleanup probe ready: project=${session.project}`);
        await sleep(realE1OuterCleanupProbeMs);
      }
      const selfCheckContainersRemoved: string[] = [];
      const retainedSelfCheckContainers: string[] = [];
      for (const name of [`${session.project}-app-self-check`, `${session.project}-celestia-self-check`]) {
        const before = await runCommand("docker", ["container", "inspect", name], session.children, {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch((error) => {
          cleanup.errors.push(`self-check container pre-clean check for ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (before?.code === 0) {
          const removed = await runCommand("docker", ["container", "rm", "--force", name], session.children, {
            allowFailure: true,
            timeoutMs: 60_000,
          }).catch((error) => {
            cleanup.errors.push(`self-check container removal for ${name} threw: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          if (removed?.code === 0) selfCheckContainersRemoved.push(name);
          else cleanup.errors.push(`self-check container removal for ${name} exited ${removed?.code ?? "unknown"}`);
        }
        const after = await runCommand("docker", ["container", "inspect", name], session.children, {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch((error) => {
          cleanup.errors.push(`self-check container post-clean check for ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (after?.code === 0) {
          retainedSelfCheckContainers.push(name);
          cleanup.errors.push(`retained self-check container ${name}`);
        }
      }
      const imageTagsRemoved: string[] = [];
      const retainedImageTags: string[] = [];
      const imageIdsRemoved: string[] = [];
      const retainedImageIds: string[] = [];
      const sharedImageIds: string[] = [];
      for (const tag of [session.appImage, session.celestiaImage]) {
        const before = await runCommand("docker", ["image", "inspect", tag], session.children, {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch((error) => {
          cleanup.errors.push(`image pre-clean check for ${tag} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (before?.code === 0) {
          const removed = await runCommand("docker", ["image", "rm", tag], session.children, {
            allowFailure: true,
            timeoutMs: 60_000,
          }).catch((error) => {
            cleanup.errors.push(`image removal for ${tag} threw: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
          if (removed?.code === 0) imageTagsRemoved.push(tag);
          else cleanup.errors.push(`image removal for ${tag} exited ${removed?.code ?? "unknown"}`);
        }
        const after = await runCommand("docker", ["image", "inspect", tag], session.children, {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch((error) => {
          cleanup.errors.push(`image post-clean check for ${tag} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (after?.code === 0) {
          retainedImageTags.push(tag);
          cleanup.errors.push(`retained generated image tag ${tag}`);
        }
      }
      for (const iid of expectedImageIds) {
        const after = await runCommand("docker", ["image", "inspect", iid], session.children, {
          allowFailure: true,
          timeoutMs: 30_000,
        }).catch((error) => {
          cleanup.errors.push(`image IID post-clean check for ${iid} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (after?.code === 0) {
          // A content-addressed IID can be shared by a concurrent run under a
          // different tag. Never delete it by IID: removing only our unique
          // tags above preserves the other run and leaves shared BuildKit
          // cache ownership explicit in the evidence.
          sharedImageIds.push(iid);
        }
      }
      return {
        ...cleanup,
        selfCheckContainersRemoved,
        retainedSelfCheckContainers,
        imageTagsRemoved,
        retainedImageTags,
        imageIdsRemoved,
        retainedImageIds,
        sharedImageIds,
      };
    })().finally(() => {
      emergencyCleanups.delete(session.project);
    });
    return cleanupPromise;
  };
}

async function createRealE1Session(reservation: PortReservation): Promise<RealE1Session> {
  assert(reservation.port >= MIN_HOST_PORT, `published port ${reservation.port} is below 10000`);
  assert(
    reservation.port < FORBIDDEN_HISTORICAL_PORT_MIN || reservation.port > FORBIDDEN_HISTORICAL_PORT_MAX,
    `published port ${reservation.port} reused historical fixed range`,
  );
  const project = realE1ProjectName();
  const appImage = `zswap-e1-app:${project}`;
  const celestiaImage = `zswap-e1-celestia:${project}`;
  const children = new Set<ChildProcessWithoutNullStreams>();
  const constructionAbort = new AbortController();
  let constructionDirectory: string | undefined;
  let settleConstruction!: (session: RealE1Session | null) => void;
  const constructionSettled = new Promise<RealE1Session | null>((resolve) => {
    settleConstruction = resolve;
  });
  const partialCleanup = async (): Promise<RealE1CleanupEvidence> => {
    constructionAbort.abort(new Error("real E1 construction interrupted"));
    const session = await constructionSettled;
    await reservation.release();
    if (session !== null) return session.cleanup();
    let listenerReleased = false;
    const errors: string[] = [];
    try {
      await assertPortCanBind(reservation.port);
      listenerReleased = true;
    } catch (error) {
      errors.push(
        `construction listener ${reservation.port} retained: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (children.size > 0) errors.push(`${children.size} construction process(es) remain active`);
    let temporaryDirectoryRemoved = constructionDirectory === undefined;
    if (constructionDirectory !== undefined) {
      try {
        assert(
          constructionDirectory.startsWith(join(tmpdir(), TEMP_PREFIX)),
          `refusing to remove unexpected path ${constructionDirectory}`,
        );
        await rm(constructionDirectory, { recursive: true, force: true });
        temporaryDirectoryRemoved = !(await pathExists(constructionDirectory));
        if (!temporaryDirectoryRemoved) errors.push(`temporary directory retained: ${constructionDirectory}`);
      } catch (error) {
        errors.push(`construction temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      downCode: 0,
      containers: [],
      networks: [],
      volumes: [],
      listenerReleased,
      activeDriverProcesses: children.size,
      temporaryDirectoryRemoved,
      errors,
      imageTagsRemoved: [],
      retainedImageTags: [],
      imageIdsRemoved: [],
      retainedImageIds: [],
      sharedImageIds: [],
      selfCheckContainersRemoved: [],
      retainedSelfCheckContainers: [],
    };
  };
  emergencyCleanups.set(project, partialCleanup);
  try {
    const base = {
      project,
      recorderPort: reservation.port,
      appImage,
      celestiaImage,
      files: await createRealE1SessionFiles(
        project,
        reservation.port,
        appImage,
        celestiaImage,
        children,
        constructionAbort.signal,
        (directory) => {
          constructionDirectory = directory;
        },
      ),
      children,
    };
    const session: RealE1Session = {
      ...base,
      cleanup: () => Promise.reject(new Error("cleanup not initialized")),
    };
    session.cleanup = createRealE1Cleanup(session);
    emergencyCleanups.set(session.project, session.cleanup);
    settleConstruction(session);
    await reservation.release();
    return session;
  } catch (error) {
    settleConstruction(null);
    await reservation.release();
    emergencyCleanups.delete(project);
    throw error;
  }
}

async function runRealE1OuterCleanupSignalProbe(): Promise<never> {
  const session = await createRealE1Session(await reserveRandomPort(new Set()));
  realE1OuterCleanupProbeMs = 30_000;
  try {
    const baseImage = await runCommand(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", NODE_IMAGE],
      session.children,
      { timeoutMs: 30_000 },
    );
    const iid = baseImage.stdout.trim();
    assert(/^sha256:[0-9a-f]{64}$/.test(iid), "cleanup signal probe could not resolve its base image IID");
    await Promise.all([
      runCommand("docker", ["image", "tag", NODE_IMAGE, session.appImage], session.children, { timeoutMs: 30_000 }),
      runCommand("docker", ["image", "tag", NODE_IMAGE, session.celestiaImage], session.children, { timeoutMs: 30_000 }),
      writeFile(session.files.appImageId, iid, { encoding: "utf8", mode: 0o600 }),
      writeFile(session.files.celestiaImageId, iid, { encoding: "utf8", mode: 0o600 }),
    ]);
    for (const role of ["app", "celestia"]) {
      await runCommand(
        "docker",
        [
          "container",
          "create",
          "--name",
          `${session.project}-${role}-self-check`,
          "--label",
          `org.zswap.e1.project=${session.project}`,
          "--network",
          "none",
          NODE_IMAGE,
          "node",
          "-e",
          "process.exit(0)",
        ],
        session.children,
        { timeoutMs: 30_000 },
      );
    }
    await session.cleanup();
    throw new Error("outer cleanup signal probe completed without receiving SIGTERM/SIGINT");
  } catch (error) {
    await session.cleanup();
    throw error;
  } finally {
    realE1OuterCleanupProbeMs = 0;
  }
}

async function dockerResources(
  kind: "container" | "network" | "volume",
  project: string,
  children: Set<ChildProcessWithoutNullStreams>,
): Promise<string[]> {
  const noun = kind === "container" ? "ps" : kind;
  const args =
    kind === "container"
      ? [noun, "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]
      : [noun, "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
  const result = await runCommand("docker", args, children);
  return lines(result.stdout);
}

async function captureDiagnostics(session: HarnessSession): Promise<string> {
  const ps = await runCompose(session, ["ps", "--all"], { allowFailure: true, timeoutMs: 30_000 });
  const logs = await runCompose(session, ["logs", "--no-color", "--timestamps"], {
    allowFailure: true,
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024 * 1024,
  });
  const diagnostics = [
    `project=${session.project}`,
    "--- compose ps ---",
    ps.stdout,
    ps.stderr,
    "--- compose logs ---",
    logs.stdout,
    logs.stderr,
  ].join("\n");
  if ("proofLogMarker" in session.files) {
    assertMixedComposeProofLogSafe("real E1 failure diagnostics", diagnostics);
  }
  return diagnostics;
}

async function captureRealE1ServiceFailureSummary(
  session: HarnessSession,
  commandError: Error,
): Promise<string> {
  const commandErrorBytes = Buffer.byteLength(commandError.message);
  assert(
    commandErrorBytes <= REAL_E1_FAILURE_COMMAND_ERROR_MAX_BYTES,
    `real E1 command error exceeds ${REAL_E1_FAILURE_COMMAND_ERROR_MAX_BYTES} bytes`,
  );
  const selectedLogs = await runCompose(
    session,
    [
      "logs",
      "--no-color",
      "--timestamps",
      "--tail",
      "200",
      "offerfiles-backend",
      "contract-deployer",
    ],
    {
      allowFailure: true,
      timeoutMs: 30_000,
      maxOutputBytes: REAL_E1_FAILURE_SERVICE_TAIL_MAX_BYTES,
    },
  );
  const summary = [
    `project=${session.project}`,
    "--- original command error ---",
    commandError.message,
    "--- selected service tail: offerfiles-backend + contract-deployer ---",
    `captureExitCode=${selectedLogs.code}`,
    selectedLogs.stdout,
    selectedLogs.stderr,
  ].join("\n");
  assert(
    Buffer.byteLength(summary) <=
      REAL_E1_FAILURE_COMMAND_ERROR_MAX_BYTES + REAL_E1_FAILURE_SERVICE_TAIL_MAX_BYTES + 1024,
    "real E1 selected failure summary exceeded its combined evidence cap",
  );
  assertNoProofMaterialLogSignatures("real E1 selected failure summary", summary);
  return summary;
}

async function captureRealE1FailureProofLog(
  session: HarnessSession,
): Promise<{ text: string; bytes: number; sha256: string } | null> {
  const proof = await runCompose(session, ["ps", "--all", "--quiet", "proof-server"], {
    allowFailure: true,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
  });
  assert(proof.code === 0, "real E1 proof-only failure capture could not resolve the proof container");
  const ids = lines(proof.stdout);
  if (ids.length === 0) return null;
  assert(
    ids.length === 1 && /^[0-9a-f]{12,64}$/i.test(ids[0]!),
    "real E1 proof-only failure capture resolved an invalid container set",
  );
  const logs = await runCommand(
    "docker",
    ["logs", "--timestamps", ids[0]!],
    session.children,
    { allowFailure: true, timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 },
  );
  assert(logs.code === 0, "real E1 proof-only failure log capture failed");
  const text = `${logs.stdout}${logs.stderr}`;
  const bytes = Buffer.byteLength(text);
  assert(bytes < 8 * 1024 * 1024, "real E1 proof-only failure log reached its rotation bound");
  assertDirectProofLogSafe("real E1 proof-only failure log", text);
  return { text, bytes, sha256: createHash("sha256").update(text).digest("hex") };
}

async function reportRealE1FailureProofLog(
  session: HarnessSession,
  secrets: readonly string[],
): Promise<void> {
  const proof = await captureRealE1FailureProofLog(session);
  if (proof === null) return;
  assertNoGeneratedSecrets("real E1 proof-only failure log", proof.text, secrets);
  console.error(
    `[real E1 proof-only failure log captured and scanned bytes=${proof.bytes} sha256=${proof.sha256}]`,
  );
}

function createCleanup(
  session: Omit<HarnessSession, "cleanup">,
  options: { unregister?: boolean } = {},
): () => Promise<CleanupEvidence> {
  let cleanupPromise: Promise<CleanupEvidence> | undefined;
  return () => {
    cleanupPromise ??= (async () => {
      const errors: string[] = [];
      let downCode = -1;
      let containers: string[] = [];
      let networks: string[] = [];
      let volumes: string[] = [];
      let listenerReleased = false;
      let temporaryDirectoryRemoved = false;

      if (handlingSignal && session.children.size > 0) {
        for (const child of session.children) child.kill("SIGTERM");
        for (let attempt = 0; attempt < 20 && session.children.size > 0; attempt += 1) await sleep(100);
      }

      try {
        const down = await runCompose(session, ["down", "--volumes", "--remove-orphans", "--timeout", "3"], {
          allowFailure: true,
          timeoutMs: 60_000,
        });
        downCode = down.code;
        if (down.code !== 0) errors.push(`compose down exited ${down.code}: ${down.stderr}`);
      } catch (error) {
        errors.push(`compose down threw: ${error instanceof Error ? error.message : String(error)}`);
      }

      await sleep(CLEAN_SETTLE_MS);

      try {
        containers = await dockerResources("container", session.project, session.children);
        if (containers.length > 0) errors.push(`retained containers: ${containers.join(", ")}`);
      } catch (error) {
        errors.push(`container check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        networks = await dockerResources("network", session.project, session.children);
        if (networks.length > 0) errors.push(`retained networks: ${networks.join(", ")}`);
      } catch (error) {
        errors.push(`network check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        volumes = await dockerResources("volume", session.project, session.children);
        if (volumes.length > 0) errors.push(`retained volumes: ${volumes.join(", ")}`);
      } catch (error) {
        errors.push(`volume check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await assertPortCanBind(session.recorderPort);
        listenerReleased = true;
      } catch (error) {
        errors.push(`listener ${session.recorderPort} retained: ${error instanceof Error ? error.message : String(error)}`);
      }

      const activeDriverProcesses = session.children.size;
      if (activeDriverProcesses > 0) errors.push(`${activeDriverProcesses} driver process(es) remain active`);

      try {
        assert(
          session.files.directory.startsWith(join(tmpdir(), TEMP_PREFIX)),
          `refusing to remove unexpected path ${session.files.directory}`,
        );
        await rm(session.files.directory, { recursive: true, force: true });
        temporaryDirectoryRemoved = !(await pathExists(session.files.directory));
        if (!temporaryDirectoryRemoved) errors.push(`temporary directory retained: ${session.files.directory}`);
      } catch (error) {
        errors.push(`temporary cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (options.unregister !== false) emergencyCleanups.delete(session.project);
      return {
        downCode,
        containers,
        networks,
        volumes,
        listenerReleased,
        activeDriverProcesses,
        temporaryDirectoryRemoved,
        errors,
      };
    })();
    return cleanupPromise;
  };
}

async function serviceContainerId(session: HarnessSession, service: ServiceName): Promise<string> {
  const result = await runCompose(session, ["ps", "--quiet", service]);
  const ids = lines(result.stdout);
  assert(ids.length === 1, `${service} has ${ids.length} containers, expected one`);
  return ids[0];
}

async function assertReadiness(session: HarnessSession): Promise<void> {
  for (const service of session.services) {
    const id = await serviceContainerId(session, service);
    const state = await runCommand(
      "docker",
      ["inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", id],
      session.children,
    );
    assert(state.stdout.trim() === "running healthy", `${service} is not explicitly healthy: ${state.stdout.trim()}`);
  }

  const response = await fetch(`http://127.0.0.1:${session.recorderPort}/ready`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(response.status === 200, `recorder readiness returned ${response.status}`);
}

async function networkNames(session: HarnessSession, service: ServiceName): Promise<string[]> {
  const id = await serviceContainerId(session, service);
  const result = await runCommand(
    "docker",
    ["inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}", id],
    session.children,
  );
  return lines(result.stdout).sort();
}

async function assertNetworkPolicy(session: HarnessSession): Promise<void> {
  const expected: Record<ServiceName, string[]> = {
    "traffic-recorder": ["control", "host_access"],
    "celestia-proxy": ["backend_egress", "control"],
    "batcher-proxy": ["backend_egress", "control"],
    "offerfiles-probe": ["backend_egress", "offerfiles_private"],
    "backend-proxy": ["control", "offerfiles_private", "solver_front"],
    "solver-probe": ["solver_front"],
    "telemetry-relay": ["control", "solver_front"],
  };

  for (const service of session.services) {
    const actual = await networkNames(session, service);
    const wanted = expected[service].map((network) => `${session.project}_${network}`).sort();
    assert(JSON.stringify(actual) === JSON.stringify(wanted), `${service} networks ${actual} != ${wanted}`);
  }

  const solverId = await serviceContainerId(session, "solver-probe");
  const env = await runCommand(
    "docker",
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", solverId],
    session.children,
  );
  assert(!/(?:^|\n)(?:CELESTIA|BATCHER)[^=]*=/m.test(env.stdout), "solver probe received forbidden upstream env");

  const isolationScript = `(async()=>{
    const urls=['http://celestia-proxy:8080/ready','http://batcher-proxy:8080/ready'];
    const reached=[];
    for (const url of urls) {
      try { await fetch(url,{signal:AbortSignal.timeout(1500)}); reached.push(url); } catch {}
    }
    if (reached.length) { console.error('solver reached forbidden services',reached); process.exit(1); }
  })().catch(e=>{console.error(e);process.exit(1)})`;
  await runCompose(session, ["exec", "--no-TTY", "solver-probe", "node", "-e", isolationScript], {
    timeoutMs: 10_000,
  });
}

async function setFault(session: HarnessSession, channel: string, value: object | null): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${session.recorderPort}/faults/${encodeURIComponent(channel)}`,
    {
    method: value === null ? "DELETE" : "PUT",
    headers: { "content-type": "application/json" },
    body: value === null ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(3_000),
    },
  );
  assert(response.ok, `fault control returned ${response.status}`);
}

async function assertRecorderAndFaultSeam(session: HarnessSession): Promise<{ count: number; channels: string[] }> {
  await setFault(session, "backend", { mode: "status", status: 503 });
  try {
    const faultScript = `fetch('http://backend-proxy:8080/forced-e0-fault',{signal:AbortSignal.timeout(3000)})
      .then(async r=>{console.log(await r.text());if(r.status!==503)process.exit(1)})
      .catch(e=>{console.error(e);process.exit(1)})`;
    await runCompose(session, ["exec", "--no-TTY", "solver-probe", "node", "-e", faultScript], {
      timeoutMs: 10_000,
    });
  } finally {
    await setFault(session, "backend", null);
  }

  const response = await fetch(`http://127.0.0.1:${session.recorderPort}/events`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(response.ok, `events endpoint returned ${response.status}`);
  const payload = (await response.json()) as { events?: Array<Record<string, unknown>> };
  assert(Array.isArray(payload.events), "events response is not an array");
  assert(payload.events.length >= 8, `only ${payload.events.length} traffic events recorded`);

  const channels = [...new Set(payload.events.map((event) => String(event.channel)))].sort();
  for (const required of ["backend", "batcher", "celestia"]) {
    assert(channels.includes(required), `missing ${required} traffic channel`);
    assert(
      payload.events.some((event) => event.channel === required && event.phase === "request"),
      `missing ${required} request event`,
    );
    assert(
      payload.events.some((event) => event.channel === required && event.phase === "response"),
      `missing ${required} response event`,
    );
  }
  assert(
    payload.events.some(
      (event) => event.channel === "backend" && event.phase === "response" && event.fault === "status" && event.status === 503,
    ),
    "backend status fault was not recorded",
  );

  const sequences = payload.events.map((event) => Number(event.sequence));
  assert(
    sequences.every((sequence, index) => sequence === index + 1),
    `recorder sequence is not globally monotonic: ${sequences.join(",")}`,
  );

  const persisted = lines(await readFile(session.files.traffic, "utf8")).map((line) => JSON.parse(line));
  assert(persisted.length === payload.events.length, "persisted traffic count differs from recorder response");
  assert(
    persisted.every((event, index) => event.sequence === sequences[index]),
    "persisted traffic sequence differs from recorder response",
  );
  return { count: payload.events.length, channels };
}

async function recorderEvents(session: HarnessSession): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`http://127.0.0.1:${session.recorderPort}/events`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(response.ok, `events endpoint returned ${response.status}`);
  const payload = (await response.json()) as { events?: Array<Record<string, unknown>> };
  assert(Array.isArray(payload.events), "events response is not an array");
  return payload.events;
}

async function execSolverScript(session: HarnessSession, script: string, timeoutMs = 15_000): Promise<void> {
  await runCompose(session, ["exec", "--no-TTY", "solver-probe", "node", "-e", script], { timeoutMs });
}

function assertNoGeneratedSecrets(label: string, text: string | Buffer, secrets: readonly string[]): void {
  const matches = secrets.reduce(
    (count, secret) =>
      count +
      (secret.length > 0 &&
      (typeof text === "string" ? text.includes(secret) : text.includes(Buffer.from(secret)))
        ? 1
        : 0),
    0,
  );
  assert(matches === 0, `${label}: suppressed ${matches} generated secret value(s)`);
}

async function prepareGeneratedSecretBoundary(session: RealE1Session): Promise<void> {
  const secrets = session.files.generatedSecrets ?? [];
  assert(secrets.length > 0, "real E1 secret boundary has no generated values");
  assert(secrets.every((secret) => secret.length >= 16 && !/[\r\n]/.test(secret)), "invalid generated secret boundary value");
  const manifest = lines(await readFile(join(session.files.appContext, "source-manifest.txt"), "utf8"));
  const stagedSourceRoot = join(session.files.appContext, "source");
  for (const line of manifest) {
    assert(/^[0-9a-f]{64}  .+$/.test(line), "invalid staged source-manifest line");
    const sourcePath = line.slice(66);
    assertRealE1SourcePath(sourcePath);
    assertNoGeneratedSecrets(`real E1 staged source path ${sourcePath}`, sourcePath, secrets);
    const absolute = join(stagedSourceRoot, sourcePath);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolute);
      assert(!/[\x00-\x1f\x7f]/.test(target), `control-character staged symlink rejected: ${sourcePath}`);
      assertNoGeneratedSecrets(`real E1 staged source symlink ${sourcePath}`, target, secrets);
    } else {
      assert(metadata.isFile(), `unsupported staged source input type: ${sourcePath}`);
      assertNoGeneratedSecrets(`real E1 staged source file ${sourcePath}`, await readFile(absolute), secrets);
    }
  }
  const generatedInputs = [
    join(session.files.appContext, "source-manifest.txt"),
    session.files.appDockerfile,
    session.files.celestiaDockerfile,
    join(session.files.celestiaContext, "package.json"),
    join(session.files.celestiaContext, "bun.lock"),
  ];
  for (const path of generatedInputs) {
    const stagedPath = relative(session.files.directory, path);
    assert(!/[\x00-\x1f\x7f]/.test(stagedPath), `control-character generated build-input path: ${JSON.stringify(stagedPath)}`);
    assertNoGeneratedSecrets(`real E1 staged build-input path ${stagedPath}`, stagedPath, secrets);
    const metadata = await lstat(path);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `generated build input is not a regular file: ${path}`);
    assertNoGeneratedSecrets(
      `real E1 staged build input ${stagedPath}`,
      await readFile(path),
      secrets,
    );
  }
  await writeFile(join(session.files.directory, "image-secret-patterns"), `${secrets.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function assertGeneratedSecretsAbsentFromBuiltImages(session: RealE1Session): Promise<void> {
  const patternPath = join(session.files.directory, "image-secret-patterns");
  await assertPrivateArtifact(patternPath);
  const scannerMetadata = await lstat(session.files.imageSecretScanner);
  assert(
    scannerMetadata.isFile() && !scannerMetadata.isSymbolicLink() && (scannerMetadata.mode & 0o777) === 0o500,
    "real E1 image secret scanner is not a mode-0500 regular file",
  );
  for (const [role, platform, image] of [
    ["app", "linux/arm64", session.appImage],
    ["celestia", "linux/amd64", session.celestiaImage],
  ] as const) {
    const result = await runCommand(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        `${session.project}-${role}-self-check`,
        "--label",
        `org.zswap.e1.project=${session.project}`,
        "--label",
        "org.zswap.e1.role=self-check",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=0,gid=0",
        "--platform",
        platform,
        "--volume",
        `${patternPath}:/run/e1-secret-patterns:ro`,
        "--volume",
        `${session.files.imageSecretScanner}:/run/e1-image-secret-scan:ro`,
        image,
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "120s",
        "bash",
        "/run/e1-image-secret-scan",
        role,
      ],
      session.children,
      { timeoutMs: 180_000 },
    );
    assertNoGeneratedSecrets(`real E1 ${role} image secret scanner stdout`, result.stdout, session.files.generatedSecrets ?? []);
    assertNoGeneratedSecrets(`real E1 ${role} image secret scanner stderr`, result.stderr, session.files.generatedSecrets ?? []);
    const evidence = lines(result.stdout);
    assert(evidence.length === 1, `real E1 ${role} image secret scanner emitted ${evidence.length} evidence lines`);
    assert(
      evidence[0].startsWith(`image-secret-scan role=${role} `) && evidence[0].endsWith(" status=clean"),
      `real E1 ${role} image secret scanner evidence is invalid`,
    );
  }
}

async function assertFailureDiagnosticsAreSecretFree(
  session: Pick<HarnessSession, "project" | "files" | "children">,
  service: string,
  secrets: readonly string[],
): Promise<void> {
  let failure: unknown;
  try {
    await runCompose(
      session,
      ["exec", "--no-TTY", service, "node", "-e", "console.error('intentional-diagnostic-probe');process.exit(91)"],
      { timeoutMs: 15_000 },
    );
  } catch (error) {
    failure = error;
  }
  assert(failure !== undefined, "intentional diagnostic probe unexpectedly succeeded");
  const diagnostic = failure instanceof Error ? failure.message : String(failure);
  assert(diagnostic.includes("exited 91"), "intentional diagnostic probe did not exercise command failure output");
  assertNoGeneratedSecrets("intentional command-failure diagnostics", diagnostic, secrets);
}

async function assertE1Foundation(session: HarnessSession): Promise<void> {
  assert(session.foundation, "E1 foundation assertions require the telemetry topology");
  const telemetryToken = session.files.telemetryToken;
  const telemetryRunId = session.files.telemetryRunId;
  assert(telemetryToken !== undefined, "E1 foundation telemetry token is missing");
  assert(telemetryRunId !== undefined, "E1 foundation telemetry run ID is missing");
  await setFault(session, "backend", {
    mode: "status",
    status: 429,
    match: { method: "POST", path: "/v1/offers/validate", occurrence: 2 },
  });
  try {
    const occurrenceScript = `(async()=>{
      const url='http://backend-proxy:8080/v1/offers/validate';
      const get=await fetch(url); if(get.status!==200) throw new Error('GET was not route-isolated: '+get.status);
      for (const expected of [200,429,200]) {
        const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
        if(response.status!==expected) throw new Error('occurrence expected '+expected+' got '+response.status);
      }
    })().catch(e=>{console.error(e);process.exit(1)})`;
    await execSolverScript(session, occurrenceScript);
  } finally {
    await setFault(session, "backend", null);
  }

  await setFault(session, "backend", {
    mode: "status",
    status: 503,
    match: { method: "POST", path: "/v1/offers/validate", fromOccurrence: 2 },
  });
  try {
    const persistentOccurrenceScript = `(async()=>{
      const url='http://backend-proxy:8080/v1/offers/validate';
      for (const expected of [200,503,503]) {
        const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
        if(response.status!==expected) throw new Error('from-occurrence expected '+expected+' got '+response.status);
      }
    })().catch(e=>{console.error(e);process.exit(1)})`;
    await execSolverScript(session, persistentOccurrenceScript);
  } finally {
    await setFault(session, "backend", null);
  }

  await setFault(session, "backend", {
    mode: "delay",
    delayMs: 750,
    match: { method: "POST", path: "/v1/offers/validate", occurrence: 1 },
  });
  try {
    const delayScript = `(async()=>{
      const started=Date.now();
      const response=await fetch('http://backend-proxy:8080/v1/offers/validate',{
        method:'POST',headers:{'content-type':'application/json'},body:'{}'
      });
      if(response.status!==200) throw new Error('delayed response status '+response.status);
      const elapsed=Date.now()-started;
      if(elapsed<650) throw new Error('delay fault returned too early: '+elapsed);
    })().catch(e=>{console.error(e);process.exit(1)})`;
    await execSolverScript(session, delayScript);
  } finally {
    await setFault(session, "backend", null);
  }

  const replacement = Buffer.from(JSON.stringify({ valid: false, code: "E1_FOUNDATION" }));
  await setFault(session, "backend", {
    mode: "replace",
    status: 200,
    contentType: "application/json",
    bodyBase64: replacement.toString("base64"),
    afterUpstream: true,
    match: { method: "POST", path: "/v1/offers/validate", occurrence: 1 },
  });
  try {
    const replaceScript = `(async()=>{
      const response=await fetch('http://backend-proxy:8080/v1/offers/validate',{
        method:'POST',headers:{'content-type':'application/json'},body:'{}'
      });
      const body=await response.text();
      if(response.status!==200||body!==${JSON.stringify(replacement.toString("utf8"))}) {
        throw new Error('after-upstream replacement mismatch '+response.status+' '+body);
      }
    })().catch(e=>{console.error(e);process.exit(1)})`;
    await execSolverScript(session, replaceScript);
  } finally {
    await setFault(session, "backend", null);
  }

  const foundationPatch = jsonPatchFault("foundation-fresh-response", [
    { op: "set", path: "/valid", value: false },
    { op: "increment-decimal-string", path: "/computed/gives/0/amount", delta: "1" },
  ]);
  foundationPatch.match = { method: "GET", path: "/__harness/json-patch", occurrence: 1 };
  await setFault(session, "backend", foundationPatch);
  try {
    const jsonPatchScript = `(async()=>{
      const response=await fetch('http://backend-proxy:8080/__harness/json-patch');
      const body=await response.json();
      if(response.status!==200||body.valid!==false||body.computed?.gives?.[0]?.amount!=='10') {
        throw new Error('fresh-response JSON patch mismatch '+response.status+' '+JSON.stringify(body));
      }
    })().catch(e=>{console.error(e);process.exit(1)})`;
    await execSolverScript(session, jsonPatchScript);
  } finally {
    await setFault(session, "backend", null);
  }

  const streamScript = `(async()=>{
    const response=await fetch('http://backend-proxy:8080/__harness/sse');
    if(response.status!==200||!response.body) throw new Error('stream did not open');
    const reader=response.body.getReader();
    const first=await Promise.race([
      reader.read(),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('first stream chunk was buffered')),500))
    ]);
    const firstText=new TextDecoder().decode(first.value);
    if(first.done||!firstText.includes('data: first')) throw new Error('first stream chunk mismatch '+firstText);
    let rest='';
    for (;;) { const next=await reader.read(); if(next.done) break; rest+=new TextDecoder().decode(next.value); }
    if(!rest.includes('data: second')) throw new Error('second stream chunk missing '+rest);
  })().catch(e=>{console.error(e);process.exit(1)})`;
  await execSolverScript(session, streamScript);

  const originFormScript = `(()=>new Promise((resolve,reject)=>{
    const net=require('node:net');
    const targets=['http://traffic-recorder:8080/events','//traffic-recorder:8080/events','/\\\\traffic-recorder:8080/events'];
    let index=0;
    const next=()=>{
      if(index===targets.length){resolve();return}
      const target=targets[index++];let response='';
      const socket=net.connect(8080,'backend-proxy');
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('request-target probe timed out'))},3000);
      socket.on('connect',()=>socket.write('GET '+target+' HTTP/1.1\\r\\nHost: backend-proxy\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('data',chunk=>{response+=chunk.toString('utf8')});
      socket.on('end',()=>{clearTimeout(timer);if(!/^HTTP\\/1\\.1 400 /.test(response)){reject(new Error('unsafe target was not rejected: '+target+' '+response.slice(0,80)));return}next()});
      socket.on('error',error=>{clearTimeout(timer);reject(error)});
    };next();
  }))().catch(e=>{console.error(e);process.exit(1)})`;
  await execSolverScript(session, originFormScript);

  const redirectScript = `(async()=>{
    const response=await fetch('http://backend-proxy:8080/__harness/redirect',{redirect:'manual'});
    if(response.status!==302) {
      throw new Error('proxy followed or rewrote an upstream redirect: '+response.status);
    }
  })().catch(e=>{console.error(e);process.exit(1)})`;
  await execSolverScript(session, redirectScript);

  const telemetryScript = `(async()=>{
    const url='http://telemetry-relay:8080/record';
    const malformed='{"';
    const unauthenticated=await fetch(url,{
      method:'POST',headers:{'content-type':'application/json'},body:malformed
    });
    if(unauthenticated.status!==401) throw new Error('unauthenticated malformed body was processed: '+unauthenticated.status);
    const wrongToken=await fetch(url,{
      method:'POST',headers:{'content-type':'application/json','authorization':'Bearer definitely-wrong-token'},body:malformed
    });
    if(wrongToken.status!==401) throw new Error('wrong-token malformed body was processed: '+wrongToken.status);
    const authorization='Bearer '+process.env.HARNESS_TELEMETRY_TOKEN;
    const expectedRunId=process.env.HARNESS_TELEMETRY_RUN_ID;
    if(!process.env.HARNESS_TELEMETRY_TOKEN||!expectedRunId) throw new Error('telemetry identity env missing');
    const wrongRun=await fetch(url,{
      method:'POST',headers:{'content-type':'application/json',authorization},
      body:JSON.stringify({runId:expectedRunId+'-wrong',phase:'validation-trace',offerId:'rejected-run',event:'admitted'})
    });
    if(wrongRun.status!==403) throw new Error('wrong run ID was accepted: '+wrongRun.status);
    const response=await fetch(url,{
      method:'POST',headers:{'content-type':'application/json',authorization},
      body:JSON.stringify({runId:expectedRunId,phase:'validation-trace',offerId:'e1-foundation',event:'admitted',authenticatedRunId:'spoofed',authentication:'spoofed'})
    });
    if(response.status!==202) throw new Error('authenticated telemetry returned '+response.status+' '+await response.text());
  })().catch(e=>{console.error(e);process.exit(1)})`;
  await runCompose(session, ["exec", "--no-TTY", "telemetry-relay", "node", "-e", telemetryScript], {
    timeoutMs: 15_000,
  });
  await assertFailureDiagnosticsAreSecretFree(session, "telemetry-relay", [telemetryToken]);

  const events = await recorderEvents(session);
  assertNoGeneratedSecrets("E1 foundation recorder events", JSON.stringify(events), [telemetryToken]);
  assertNoGeneratedSecrets("E1 foundation persisted traffic", await readFile(session.files.traffic, "utf8"), [telemetryToken]);
  assert(
    events.some(
      (event) =>
        event.channel === "backend" &&
        event.phase === "response" &&
        event.fault === "status" &&
        event.status === 429 &&
        event.matchedOccurrence === 2,
    ),
    "method/path/occurrence-scoped fault evidence is missing",
  );
  const persistentFaultOccurrences = events
    .filter(
      (event) =>
        event.channel === "backend" &&
        event.phase === "response" &&
        event.fault === "status" &&
        event.status === 503,
    )
    .map((event) => event.matchedOccurrence);
  assert(
    persistentFaultOccurrences.includes(2) && persistentFaultOccurrences.includes(3),
    `from-occurrence fault did not remain active for calls 2+: ${persistentFaultOccurrences.join(",")}`,
  );
  const delayedResponse = events.find(
    (event) =>
      event.channel === "backend" &&
      event.phase === "response" &&
      event.path === "/v1/offers/validate" &&
      event.appliedFault === "delay" &&
      event.matchedOccurrence === 1,
  );
  assert(delayedResponse !== undefined, "delay fault attribution/occurrence evidence is missing");
  const delayedRequest = events.find(
    (event) => event.channel === "backend" && event.phase === "request" && event.requestId === delayedResponse.requestId,
  );
  assert(delayedRequest !== undefined, "delay fault request evidence is missing");
  assert(
    Date.parse(String(delayedResponse.observedAt)) - Date.parse(String(delayedRequest.observedAt)) >= 650,
    "delay fault attribution did not span the configured delay",
  );
  assert(
    events.some(
      (event) =>
        event.channel === "backend" &&
        event.phase === "response" &&
        event.fault === "replace" &&
        event.upstreamStatus === 200,
    ),
    "after-upstream replacement evidence is missing",
  );
  const patched = events.find(
    (event) =>
      event.channel === "backend" &&
      event.phase === "response" &&
      event.fault === "json-patch" &&
      event.patchId === "foundation-fresh-response",
  );
  assert(patched !== undefined, "fresh-upstream JSON-patch evidence is missing");
  const patchedRequest = events.find(
    (event) => event.channel === "backend" && event.phase === "request" && event.requestId === patched.requestId,
  );
  assert(patchedRequest !== undefined, "fresh-upstream JSON-patch request evidence is missing");
  assertConfiguredFaultResponse(foundationPatch, patchedRequest, patched, 1, "foundation JSON patch");
  assert(
    events.some(
      (event) =>
        event.channel === "backend" &&
        event.phase === "response" &&
        event.path === "/__harness/redirect" &&
        event.status === 302,
    ),
    "manual upstream redirect was not authoritatively recorded as an unfollowed 302",
  );
  for (const phase of ["response-open", "stream-chunk", "stream-end"]) {
    assert(
      events.some((event) => event.channel === "backend" && event.path === "/__harness/sse" && event.phase === phase),
      `streaming ${phase} evidence is missing`,
    );
  }
  assert(
    events.filter(
      (event) =>
        event.channel === "solver-validation" &&
        event.phase === "validation-trace" &&
        event.offerId === "e1-foundation" &&
        event.event === "admitted" &&
        event.runId === telemetryRunId &&
        event.authenticatedRunId === telemetryRunId &&
        event.authentication === "bearer",
    ).length === 1,
    "internal solver validation telemetry was not globally ordered",
  );
  assert(
    !events.some((event) => event.offerId === "rejected-run"),
    "run-ID-mismatched telemetry reached the central recorder",
  );
}

async function createSession(reservation: PortReservation, foundation: boolean): Promise<HarnessSession> {
  assert(reservation.port >= MIN_HOST_PORT, `published port ${reservation.port} is below 10000`);
  assert(
    reservation.port < FORBIDDEN_HISTORICAL_PORT_MIN || reservation.port > FORBIDDEN_HISTORICAL_PORT_MAX,
    `published port ${reservation.port} reused historical fixed range`,
  );
  const project = projectName(foundation);
  const children = new Set<ChildProcessWithoutNullStreams>();
  const constructionAbort = new AbortController();
  let constructionDirectory: string | undefined;
  let settleConstruction!: (session: HarnessSession | null) => void;
  const constructionSettled = new Promise<HarnessSession | null>((resolve) => {
    settleConstruction = resolve;
  });
  const partialCleanup = async (): Promise<CleanupEvidence> => {
    constructionAbort.abort(new Error("harness construction interrupted"));
    const session = await constructionSettled;
    await reservation.release();
    if (session !== null) return session.cleanup();
    const errors: string[] = [];
    let temporaryDirectoryRemoved = constructionDirectory === undefined;
    if (constructionDirectory !== undefined) {
      try {
        assert(
          constructionDirectory.startsWith(join(tmpdir(), TEMP_PREFIX)),
          `refusing to remove unexpected path ${constructionDirectory}`,
        );
        await rm(constructionDirectory, { recursive: true, force: true });
        temporaryDirectoryRemoved = !(await pathExists(constructionDirectory));
        if (!temporaryDirectoryRemoved) errors.push(`temporary directory retained: ${constructionDirectory}`);
      } catch (error) {
        errors.push(`construction temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let listenerReleased = false;
    try {
      await assertPortCanBind(reservation.port);
      listenerReleased = true;
    } catch (error) {
      errors.push(`construction listener ${reservation.port} retained: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      downCode: 0,
      containers: [],
      networks: [],
      volumes: [],
      listenerReleased,
      activeDriverProcesses: children.size,
      temporaryDirectoryRemoved,
      errors,
    };
  };
  emergencyCleanups.set(project, partialCleanup);
  try {
    const base = {
      project,
      recorderPort: reservation.port,
      foundation,
      services: foundation ? E1_FOUNDATION_SERVICES : E0_SERVICES,
      files: await createSessionFiles(project, reservation.port, foundation, constructionAbort.signal, (directory) => {
        constructionDirectory = directory;
      }),
      children,
    };
    const session: HarnessSession = { ...base, cleanup: () => Promise.reject(new Error("cleanup not initialized")) };
    session.cleanup = createCleanup(session);
    emergencyCleanups.set(session.project, session.cleanup);
    settleConstruction(session);
    await reservation.release();
    return session;
  } catch (error) {
    settleConstruction(null);
    await reservation.release();
    emergencyCleanups.delete(project);
    throw error;
  }
}

async function runHarness(
  reservation: PortReservation,
  options: { forceFailure: boolean; foundation?: boolean },
): Promise<HarnessResult> {
  const session = await createSession(reservation, options.foundation ?? false);
  let testError: Error | null = null;
  let diagnostics: string | null = null;
  let eventCount = 0;
  let channels: string[] = [];
  let cleanup!: CleanupEvidence;

  try {
    await runCompose(session, ["config", "--quiet"], { timeoutMs: 30_000 });
    await runCompose(session, ["up", "--detach", "--wait", "--wait-timeout", "60"], { timeoutMs: 90_000 });
    await assertReadiness(session);
    await assertNetworkPolicy(session);
    ({ count: eventCount, channels } = await assertRecorderAndFaultSeam(session));
    if (session.foundation) {
      await assertE1Foundation(session);
      const events = await recorderEvents(session);
      eventCount = events.length;
      channels = [...new Set(events.map((event) => String(event.channel)))].sort();
    }
    if (options.forceFailure) throw new Error("forced E0 failure after readiness and traffic capture");
  } catch (error) {
    testError = error instanceof Error ? error : new Error(String(error));
    const secrets = session.files.telemetryToken === undefined ? [] : [session.files.telemetryToken];
    try {
      diagnostics = await captureDiagnostics(session);
      try {
        assertNoGeneratedSecrets("harness failure", testError.message, secrets);
        assertNoGeneratedSecrets("harness diagnostics", diagnostics, secrets);
        const diagnosticBytes = Buffer.from(diagnostics);
        console.error(
          `\n[harness diagnostics captured before teardown bytes=${diagnosticBytes.byteLength} sha256=${createHash("sha256").update(diagnosticBytes).digest("hex")}]\n${diagnostics}`,
        );
      } catch (secretError) {
        testError = secretError instanceof Error ? secretError : new Error("harness secret scan failed");
        diagnostics = "harness diagnostics suppressed because a generated secret was detected";
        console.error(diagnostics);
      }
    } catch (diagnosticError) {
      const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      try {
        assertNoGeneratedSecrets("diagnostic capture failure", diagnosticMessage, secrets);
        diagnostics = `diagnostic capture failed: ${diagnosticMessage}`;
      } catch {
        diagnostics = "diagnostic capture failed; details suppressed because a generated secret was detected";
      }
      console.error(diagnostics);
    }
  } finally {
    cleanup = await session.cleanup();
  }

  return {
    project: session.project,
    recorderPort: session.recorderPort,
    eventCount,
    channels,
    testError: testError?.message ?? null,
    diagnosticsSha256: diagnostics === null ? null : createHash("sha256").update(diagnostics).digest("hex"),
    cleanup,
  };
}

function assertCleanup(result: HarnessResult): void {
  assert(result.cleanup.downCode === 0, `${result.project}: compose down did not succeed`);
  assert(result.cleanup.containers.length === 0, `${result.project}: retained containers`);
  assert(result.cleanup.networks.length === 0, `${result.project}: retained networks`);
  assert(result.cleanup.volumes.length === 0, `${result.project}: retained volumes`);
  assert(result.cleanup.listenerReleased, `${result.project}: listener was not released`);
  assert(result.cleanup.activeDriverProcesses === 0, `${result.project}: driver process remains`);
  assert(result.cleanup.temporaryDirectoryRemoved, `${result.project}: temporary directory remains`);
  assert(result.cleanup.errors.length === 0, `${result.project}: ${result.cleanup.errors.join("; ")}`);
}

async function verifyE0(): Promise<HarnessResult[]> {
  const excluded = new Set<number>();
  const reservations = await Promise.all([reserveRandomPort(excluded), reserveRandomPort(excluded)]);
  assert(reservations[0].port !== reservations[1].port, "parallel sessions received the same host port");

  const parallel = await Promise.all(
    reservations.map((reservation) => runHarness(reservation, { forceFailure: false })),
  );
  for (const result of parallel) {
    assert(result.testError === null, `${result.project}: ${result.testError}`);
    assertCleanup(result);
  }

  const forced = await runHarness(await reserveRandomPort(excluded), { forceFailure: true });
  assert(
    forced.testError === "forced E0 failure after readiness and traffic capture",
    `forced failure was not observed: ${forced.testError}`,
  );
  assert(forced.diagnosticsSha256 !== null, "forced failure diagnostics were not captured");
  assertCleanup(forced);
  return [...parallel, forced];
}

async function dryBoot(forceFailure: boolean): Promise<HarnessResult> {
  const result = await runHarness(await reserveRandomPort(new Set()), { forceFailure });
  if (forceFailure) {
    assert(result.testError === "forced E0 failure after readiness and traffic capture", result.testError ?? "missing error");
  } else {
    assert(result.testError === null, result.testError ?? "unexpected harness failure");
  }
  assertCleanup(result);
  return result;
}

async function verifyE1Foundation(): Promise<HarnessResult> {
  const result = await runHarness(await reserveRandomPort(new Set()), {
    forceFailure: false,
    foundation: true,
  });
  assert(result.testError === null, result.testError ?? "unexpected E1 foundation failure");
  assertCleanup(result);
  assert(result.channels.includes("solver-validation"), "foundation result omitted solver validation telemetry");
  return result;
}

async function inspectRealE1Image(
  session: RealE1Session,
  tag: string,
  iidPath: string,
  expectedArchitecture: "arm64" | "amd64",
  dockerfilePath: string,
  expectedLabels: Readonly<Record<string, string>>,
): Promise<{ id: string; architecture: string; dockerfileSha256: string; labels: Record<string, string> }> {
  const expectedId = (await readFile(iidPath, "utf8")).trim();
  assert(/^sha256:[a-f0-9]{64}$/.test(expectedId), `${tag}: invalid iidfile content ${JSON.stringify(expectedId)}`);
  const inspected = await runCommand(
    "docker",
    ["image", "inspect", tag],
    session.children,
    { timeoutMs: 30_000 },
  );
  const image = (JSON.parse(inspected.stdout) as Array<{
    Id?: unknown;
    Architecture?: unknown;
    Config?: { Labels?: Record<string, string> | null };
  }>)[0];
  assert(image !== undefined, `${tag}: image inspect returned no result`);
  const id = image.Id;
  const architecture = image.Architecture;
  assert(typeof id === "string" && typeof architecture === "string", `${tag}: invalid inspect output`);
  assert(id === expectedId, `${tag}: image id ${id} != iidfile ${expectedId}`);
  assert(architecture === expectedArchitecture, `${tag}: architecture ${architecture} != ${expectedArchitecture}`);
  const imageLabels = image.Config?.Labels ?? {};
  const labels: Record<string, string> = {};
  for (const [name, value] of Object.entries(expectedLabels)) {
    assert(imageLabels[name] === value, `${tag}: image label ${name} differs from ${JSON.stringify(value)}`);
    labels[name] = value;
  }
  return {
    id,
    architecture,
    dockerfileSha256: createHash("sha256").update(await readFile(dockerfilePath)).digest("hex"),
    labels,
  };
}

async function assertRealE1ImageSelfChecks(
  session: RealE1Session,
): Promise<Pick<RealE1Result, "toolVersions" | "packageManifests">> {
  const holdRaw = process.env["E1_SELF_CHECK_HOLD_MS"] ?? "0";
  assert(/^\d{1,5}$/.test(holdRaw), "E1_SELF_CHECK_HOLD_MS must be an integer in [0, 30000]");
  const holdMs = Number(holdRaw);
  assert(holdMs <= 30_000, "E1_SELF_CHECK_HOLD_MS must be an integer in [0, 30000]");
  if (holdMs > 0) {
    console.error(`[solver-offerfiles-e2e] real E1 self-check probe ready: project=${session.project}`);
  }
  const holdCommand = holdMs > 0 ? `sleep ${Math.ceil(holdMs / 1000)}` : "true";
  const app = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${session.project}-app-self-check`,
      "--label",
      `org.zswap.e1.project=${session.project}`,
      "--label",
      "org.zswap.e1.role=self-check",
      "--network",
      "none",
      "--platform",
      "linux/arm64",
      session.appImage,
      "bash",
      "-lc",
      [
        holdCommand,
        `test "$(cat /opt/zswap-app-build-bun-version.txt)" = "${REAL_E1_PINS.appBuildBunVersion}"`,
        `test "$(sha256sum /usr/local/bin/bun | cut -d' ' -f1)" = "${REAL_E1_PINS.appRuntimeBunBinarySha256}"`,
        `test "$(bun --version)" = "${REAL_E1_PINS.appRuntimeBunVersion}"`,
        `test "$(bun --revision)" = "${REAL_E1_PINS.appRuntimeBunRevision}"`,
        "test \"$(command -v bun)\" = \"/usr/local/bin/bun\"",
        "test \"$(printf '%s\\n' \"$PATH\" | tr ':' '\\n' | while IFS= read -r directory; do test -n \"$directory\" || directory=.; test ! -x \"$directory/bun\" || readlink -f \"$directory/bun\"; done | LC_ALL=C sort -u)\" = \"/usr/local/bin/bun\"",
        `test "$(/opt/node-gyp/node_modules/.bin/node-gyp --version)" = "v${REAL_E1_PINS.nodeGypVersion}"`,
        `test "$(sha256sum /opt/node-gyp/package.json | cut -d' ' -f1)" = "${REAL_E1_PINS.nodeGypPackageJsonSha256}"`,
        `test "$(sha256sum /opt/node-gyp/bun.lock | cut -d' ' -f1)" = "${REAL_E1_PINS.nodeGypLockSha256}"`,
        "test \"$(/root/.local/bin/compact --version)\" = \"compact 0.5.1\"",
        `test \"$(/root/.local/bin/compact compile +${REAL_E1_PINS.compactVersion} --version)\" = \"${REAL_E1_PINS.compactVersion}\"`,
        "test -s /opt/zswap-dpkg-manifest.txt",
        "bun packages/tests/grand-e2e/lib/solver-offerfiles-real-runtime-smoke.ts",
        "bun build packages/tests/grand-e2e/lib/solver-offerfiles-real-runtime-smoke.ts --target=bun --outfile=/tmp/e1-runtime-smoke.js >/tmp/e1-runtime-smoke-build.stdout 2>/tmp/e1-runtime-smoke-build.stderr",
        "test -s /tmp/e1-runtime-smoke.js",
        "! grep -F '__legacyDecorateClassTS' /tmp/e1-runtime-smoke.js",
        "printf 'app-runtime-legacy-helper=absent\\n'",
        "rm -f /tmp/e1-runtime-smoke.js /tmp/e1-runtime-smoke-build.stdout /tmp/e1-runtime-smoke-build.stderr",
        `printf 'app-build-bun=${REAL_E1_PINS.appBuildBunVersion}\\napp-runtime-bun=${REAL_E1_PINS.appRuntimeBunVersion}\\napp-runtime-bun-revision=${REAL_E1_PINS.appRuntimeBunRevision}\\napp-runtime-bun-sha256=${REAL_E1_PINS.appRuntimeBunBinarySha256}\\nnode-gyp=${REAL_E1_PINS.nodeGypVersion}\\nnode-gyp-package-json=${REAL_E1_PINS.nodeGypPackageJsonSha256}\\nnode-gyp-lock=${REAL_E1_PINS.nodeGypLockSha256}\\ncompact-manager=0.5.1\\ncompact-compiler=0.30.0\\napp-dpkg-manifest=%s\\n' "$(sha256sum /opt/zswap-dpkg-manifest.txt | cut -d' ' -f1)"`,
        "printf '__APP_DPKG_BEGIN__\\n'",
        "cat /opt/zswap-dpkg-manifest.txt",
        "printf '__APP_DPKG_END__\\n'",
      ].join(" && "),
    ],
    session.children,
    { timeoutMs: 60_000 },
  );
  const celestia = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${session.project}-celestia-self-check`,
      "--label",
      `org.zswap.e1.project=${session.project}`,
      "--label",
      "org.zswap.e1.role=self-check",
      "--network",
      "none",
      "--platform",
      "linux/amd64",
      session.celestiaImage,
      "bash",
      "-lc",
      [
        holdCommand,
        `test "$(bun --version)" = "${REAL_E1_PINS.celestiaBunVersion}"`,
        `test "$(sha256sum /usr/local/bin/bun | cut -d' ' -f1)" = "${REAL_E1_PINS.celestiaBunBinarySha256}"`,
        "test -s /opt/zswap-dpkg-manifest.txt",
        `/opt/celestia/node_modules/@effectstream/celestia/vendor/celestia-appd version | grep -F '${REAL_E1_PINS.celestiaAppVersion}' >/dev/null`,
        `/opt/celestia/node_modules/@effectstream/celestia/vendor/celestia version | grep -F '${REAL_E1_PINS.celestiaNodeVersion}' >/dev/null`,
        `printf 'celestia-bun=${REAL_E1_PINS.celestiaBunVersion}\\ncelestia-bun-sha256=${REAL_E1_PINS.celestiaBunBinarySha256}\\ncelestia-app=6.4.10\\ncelestia-node=0.28.4\\ncelestia-dpkg-manifest=%s\\n' "$(sha256sum /opt/zswap-dpkg-manifest.txt | cut -d' ' -f1)"`,
        "printf '__CELESTIA_DPKG_BEGIN__\\n'",
        "cat /opt/zswap-dpkg-manifest.txt",
        "printf '__CELESTIA_DPKG_END__\\n'",
      ].join(" && "),
    ],
    session.children,
    { timeoutMs: 90_000 },
  );
  const values: Record<string, string> = {};
  for (const line of lines(`${app.stdout}\n${celestia.stdout}`)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  assert(values["app-build-bun"] === REAL_E1_PINS.appBuildBunVersion, "real E1 app build Bun evidence missing");
  assert(values["app-runtime-bun"] === REAL_E1_PINS.appRuntimeBunVersion, "real E1 app runtime Bun evidence missing");
  assert(
    values["app-runtime-bun-revision"] === REAL_E1_PINS.appRuntimeBunRevision,
    "real E1 app runtime Bun revision evidence missing",
  );
  assert(
    values["app-runtime-bun-sha256"] === REAL_E1_PINS.appRuntimeBunBinarySha256,
    "real E1 app runtime Bun binary evidence missing",
  );
  assert(values["app-runtime-import"] === "ok", "real E1 app runtime import smoke evidence missing");
  assert(
    values["app-runtime-detached-decorator"] === "ok",
    "real E1 detached EvmFetcher decorator smoke evidence missing",
  );
  assert(
    values["app-runtime-legacy-helper"] === "absent",
    "real E1 app runtime bundle retained __legacyDecorateClassTS",
  );
  assert(values["celestia-bun"] === REAL_E1_PINS.celestiaBunVersion, "real E1 Celestia Bun evidence missing");
  assert(
    values["celestia-bun-sha256"] === REAL_E1_PINS.celestiaBunBinarySha256,
    "real E1 Celestia Bun binary evidence missing",
  );
  assert(values["node-gyp"] === REAL_E1_PINS.nodeGypVersion, "real E1 node-gyp self-check output missing");
  assert(
    values["node-gyp-package-json"] === REAL_E1_PINS.nodeGypPackageJsonSha256,
    "real E1 node-gyp package self-check output missing",
  );
  assert(values["node-gyp-lock"] === REAL_E1_PINS.nodeGypLockSha256, "real E1 node-gyp lock self-check output missing");
  assert(values["compact-manager"] === "0.5.1", "real E1 Compact manager self-check output missing");
  assert(values["compact-compiler"] === REAL_E1_PINS.compactVersion, "real E1 Compact compiler self-check output missing");
  assert(values["celestia-app"] === REAL_E1_PINS.celestiaAppVersion, "Celestia app self-check output missing");
  assert(values["celestia-node"] === REAL_E1_PINS.celestiaNodeVersion, "Celestia node self-check output missing");
  assert(/^[0-9a-f]{64}$/.test(values["app-dpkg-manifest"] ?? ""), "app dpkg manifest hash missing");
  assert(/^[0-9a-f]{64}$/.test(values["celestia-dpkg-manifest"] ?? ""), "Celestia dpkg manifest hash missing");
  const extractManifest = (source: string, begin: string, end: string): string => {
    const start = source.indexOf(`${begin}\n`);
    const finish = source.indexOf(end, start + begin.length + 1);
    assert(start >= 0 && finish > start, `missing ${begin}/${end} manifest markers`);
    const text = source.slice(start + begin.length + 1, finish);
    assert(text.endsWith("\n") && text.trim().length > 0, `${begin}: empty or unterminated package manifest`);
    return text;
  };
  const appManifest = extractManifest(app.stdout, "__APP_DPKG_BEGIN__", "__APP_DPKG_END__");
  const celestiaManifest = extractManifest(
    celestia.stdout,
    "__CELESTIA_DPKG_BEGIN__",
    "__CELESTIA_DPKG_END__",
  );
  assert(
    createHash("sha256").update(appManifest).digest("hex") === values["app-dpkg-manifest"],
    "app package manifest text does not match its reported hash",
  );
  assert(
    createHash("sha256").update(celestiaManifest).digest("hex") === values["celestia-dpkg-manifest"],
    "Celestia package manifest text does not match its reported hash",
  );
  return {
    toolVersions: values,
    packageManifests: {
      app: { sha256: values["app-dpkg-manifest"]!, text: appManifest },
      celestia: { sha256: values["celestia-dpkg-manifest"]!, text: celestiaManifest },
    },
  };
}

function parseComposePs(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const value = JSON.parse(trimmed);
    if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    if (value && typeof value === "object") return [value as Record<string, unknown>];
  } catch {
    return lines(trimmed).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  throw new Error("Compose ps returned an unsupported JSON shape");
}

async function realE1ServiceStates(session: RealE1Session): Promise<Array<Record<string, unknown>>> {
  const result = await runCompose(session, ["ps", "--all", "--format", "json"], { timeoutMs: 30_000 });
  const states = parseComposePs(result.stdout).map((entry) => ({
    service: entry.Service,
    state: entry.State,
    health: entry.Health,
    exitCode: entry.ExitCode,
  }));
  const byService = new Map(states.map((state) => [String(state.service), state]));
  for (const service of [
    "traffic-recorder",
    "postgres",
    "midnight-node",
    "midnight-indexer",
    "proof-server",
    "celestia",
    "celestia-forwarder",
    "celestia-proxy",
    "topology-probe",
    "solver-isolation-probe",
  ]) {
    const state = byService.get(service);
    assert(state !== undefined, `${service}: missing from Compose state`);
    assert(state.state === "running", `${service}: state is ${String(state.state)}, expected running`);
    if (service !== "proof-server") {
      assert(state.health === "healthy", `${service}: health is ${String(state.health)}, expected healthy`);
    }
  }
  const toolchain = byService.get("app-toolchain-check");
  assert(toolchain !== undefined, "app-toolchain-check: missing from Compose state");
  assert(toolchain.state === "exited", `app-toolchain-check: state is ${String(toolchain.state)}`);
  assert(Number(toolchain.exitCode) === 0, `app-toolchain-check: exit code is ${String(toolchain.exitCode)}`);
  return states;
}

async function realE1NetworkEvidence(session: RealE1Session): Promise<Array<Record<string, unknown>>> {
  const expected = new Map<string, string[]>([
    ["traffic-recorder", ["control", "host_access"]],
    ["postgres", ["offerfiles_private"]],
    ["midnight-node", ["midnight_private"]],
    ["midnight-indexer", ["midnight_private"]],
    ["proof-server", ["midnight_private", "proof_egress"]],
    ["app-toolchain-check", ["build_private"]],
    ["celestia", ["celestia_boundary"]],
    ["celestia-proxy", ["celestia_boundary", "control"]],
    ["topology-probe", ["celestia_boundary", "control", "midnight_private", "offerfiles_private"]],
    ["solver-isolation-probe", ["solver_front"]],
  ]);
  const evidence: Array<Record<string, unknown>> = [];
  const containerIds = new Map<string, string>();
  for (const service of [...expected.keys(), "celestia-forwarder"]) {
    const result = await runCompose(session, ["ps", "--all", "--quiet", service], { timeoutMs: 30_000 });
    const id = result.stdout.trim();
    assert(/^[0-9a-f]{12,64}$/.test(id), `${service}: invalid container id ${JSON.stringify(id)}`);
    containerIds.set(service, id);
    const inspected = await runCommand("docker", ["inspect", id], session.children, { timeoutMs: 30_000 });
    const entries = JSON.parse(inspected.stdout) as Array<{
      Config?: { Env?: string[] };
      HostConfig?: { NetworkMode?: string };
      NetworkSettings?: { Networks?: Record<string, unknown> };
    }>;
    assert(entries.length === 1, `${service}: unexpected inspect result count`);
    const entry = entries[0]!;
    const networks = Object.keys(entry.NetworkSettings?.Networks ?? {})
      .map((name) => (name.startsWith(`${session.project}_`) ? name.slice(session.project.length + 1) : name))
      .sort();
    const environmentNames = (entry.Config?.Env ?? []).map((value) => value.slice(0, Math.max(0, value.indexOf("="))));
    if (service === "celestia-forwarder") {
      assert(
        entry.HostConfig?.NetworkMode === `container:${containerIds.get("celestia")}`,
        `${service}: did not share the Celestia network namespace`,
      );
    } else {
      const expectedNetworks = expected.get(service)!.slice().sort();
      assert(
        JSON.stringify(networks) === JSON.stringify(expectedNetworks),
        `${service}: networks ${JSON.stringify(networks)} != ${JSON.stringify(expectedNetworks)}`,
      );
    }
    if (service === "solver-isolation-probe") {
      const leaked = environmentNames.filter((name) => name.startsWith("CELESTIA"));
      assert(leaked.length === 0, `${service}: forbidden Celestia environment keys ${leaked.join(",")}`);
    }
    evidence.push({ service, networkMode: entry.HostConfig?.NetworkMode, networks, environmentNames });
  }
  const solverFrontName = `${session.project}_solver_front`;
  const solverFront = await runCommand(
    "docker",
    ["network", "inspect", "--format", "{{json .Containers}}", solverFrontName],
    session.children,
    { timeoutMs: 30_000 },
  );
  const solverFrontMembers = Object.keys(JSON.parse(solverFront.stdout.trim()) as Record<string, unknown>);
  assert(
    solverFrontMembers.length === 1 && solverFrontMembers[0] === containerIds.get("solver-isolation-probe"),
    `solver_front has unexpected members: ${solverFrontMembers.join(",")}`,
  );
  return evidence;
}

function canonicalMountOptions(value: string): string {
  return value
    .split(",")
    .filter(Boolean)
    .map((option) => option.replace(/^mode=0+([0-7]+)$/, "mode=$1"))
    .sort()
    .join(",");
}

async function assertRealE1RuntimeHardening(
  session: RealE1Session,
  requireProofCache: boolean,
): Promise<RealE1RuntimeHardeningEvidence> {
  const serviceIds = new Map<string, string>();
  for (const service of ["postgres", "midnight-node", "midnight-indexer", "proof-server", "celestia"]) {
    const result = await runCompose(session, ["ps", "--all", "--quiet", service], { timeoutMs: 30_000 });
    const id = result.stdout.trim();
    assert(/^[0-9a-f]{12,64}$/i.test(id), `${service}: container ID missing from runtime hardening probe`);
    serviceIds.set(service, id);
  }
  type InspectedContainer = {
    Config?: { Cmd?: string[]; Entrypoint?: string[]; Env?: string[]; Labels?: Record<string, string> };
    HostConfig?: {
      LogConfig?: { Type?: string; Config?: Record<string, string> };
      Tmpfs?: Record<string, string>;
    };
    Mounts?: Array<{ Type?: string; Destination?: string }>;
    NetworkSettings?: { Networks?: Record<string, unknown> };
    RestartCount?: number;
    SizeRw?: number;
  };
  const inspected = new Map<string, InspectedContainer>();
  for (const [service, id] of serviceIds) {
    const result = await runCommand("docker", ["inspect", "--size", id], session.children, { timeoutMs: 30_000 });
    const value = JSON.parse(result.stdout) as InspectedContainer[];
    assert(value.length === 1, `${service}: unexpected Docker inspect result count`);
    const entry = value[0]!;
    const writableLayerBytes = Number(entry.SizeRw);
    assert(
      Number.isSafeInteger(writableLayerBytes) && writableLayerBytes >= 0 && writableLayerBytes < 16 * 1024 * 1024,
      `${service}: writable layer ${String(entry.SizeRw)} is not below 16 MiB`,
    );
    const expectedTmpfs = REAL_E1_EXPECTED_TMPFS[service]!;
    const actualTmpfs = entry.HostConfig?.Tmpfs ?? {};
    const expectedTmpfsMap = Object.fromEntries(expectedTmpfs.map((item) => {
      const separator = item.indexOf(":");
      return [item.slice(0, separator), canonicalMountOptions(item.slice(separator + 1))];
    }));
    assert(
      JSON.stringify(Object.keys(actualTmpfs).sort()) === JSON.stringify(Object.keys(expectedTmpfsMap).sort()),
      `${service}: runtime tmpfs targets differ from the bounded write-path map`,
    );
    for (const [target, expectedOptions] of Object.entries(expectedTmpfsMap)) {
      assert(
        canonicalMountOptions(actualTmpfs[target] ?? "") === expectedOptions,
        `${service}: runtime tmpfs options differ for ${target}`,
      );
    }
    assert(
      !(entry.Mounts ?? []).some((mount) => mount.Type === "volume"),
      `${service}: runtime retained a disk-backed named volume`,
    );
    const logConfig = entry.HostConfig?.LogConfig;
    if (service === "proof-server") {
      assert(
        logConfig?.Type === "local" && logConfig.Config?.["max-size"] === "8m" &&
          logConfig.Config?.["max-file"] === "1" && logConfig.Config?.compress === "false" &&
          logConfig.Config?.mode === "blocking" && Object.keys(logConfig.Config ?? {}).length === 4,
        "proof-server: runtime logging is not exactly local/8m/1/no-compress/blocking",
      );
    } else {
      assert(
        logConfig?.Type === "json-file" && logConfig.Config?.mode === "blocking" &&
          Object.keys(logConfig.Config ?? {}).length === 1,
        `${service}: runtime complete-log policy is not exactly json-file/unlimited-default/blocking`,
      );
    }
    inspected.set(service, entry);
  }

  const runtimeLogging: Array<{ service: string; driver: string; options: Record<string, string> }> = [];
  const projectContainers = await dockerResources("container", session.project, session.children);
  assert(projectContainers.length > 0, "real E1 runtime has no Compose-labeled containers");
  for (const id of projectContainers) {
    let entry = [...inspected.entries()].find(([, candidate]) => {
      const candidateService = candidate.Config?.Labels?.["com.docker.compose.service"];
      return candidateService !== undefined && serviceIds.get(candidateService) === id;
    })?.[1];
    if (entry === undefined) {
      const result = await runCommand("docker", ["inspect", id], session.children, { timeoutMs: 30_000 });
      const value = JSON.parse(result.stdout) as InspectedContainer[];
      assert(value.length === 1, `${id}: unexpected runtime logging inspect result count`);
      entry = value[0]!;
    }
    const service = entry.Config?.Labels?.["com.docker.compose.service"];
    assert(typeof service === "string" && service.length > 0, `${id}: Compose service label is absent`);
    const logConfig = entry.HostConfig?.LogConfig;
    const proofService = service === "proof-server";
    assert(
      logConfig?.Type === (proofService ? "local" : "json-file"),
      `${service}: runtime logging driver drifted`,
    );
    if (proofService) {
      assert(
        logConfig.Config?.["max-size"] === "8m" && logConfig.Config?.["max-file"] === "1" &&
          logConfig.Config?.compress === "false" && logConfig.Config?.mode === "blocking" &&
          Object.keys(logConfig.Config ?? {}).length === 4,
        "proof-server: runtime bounded logging options drifted",
      );
    } else {
      assert(
        logConfig.Config?.mode === "blocking" && Object.keys(logConfig.Config ?? {}).length === 1,
        `${service}: runtime complete-log options drifted`,
      );
    }
    runtimeLogging.push({ service, driver: logConfig.Type!, options: { ...(logConfig.Config ?? {}) } });
  }
  runtimeLogging.sort((left, right) => left.service.localeCompare(right.service));

  const proof = inspected.get("proof-server")!;
  assert(JSON.stringify(proof.Config?.Cmd) === JSON.stringify([REAL_E1_PROOF_COMMAND]), "proof-server: runtime Cmd drifted");
  assert(
    JSON.stringify(proof.Config?.Entrypoint) === JSON.stringify([REAL_E1_PROOF_ENTRYPOINT, "-c"]),
    "proof-server: runtime Entrypoint differs from the pinned bash-c boundary",
  );
  const proofEnvironment = Object.fromEntries((proof.Config?.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  assert(
    proofEnvironment.E1_PROOF_LOG_MARKER === session.files.proofLogMarker &&
      proofEnvironment.RUST_LOG === "info" && proofEnvironment.RUST_BACKTRACE === "0" &&
      proofEnvironment.MIDNIGHT_PROOF_SERVER_VERBOSE === "false" && !("EXTRA_ARGS" in proofEnvironment),
    "proof-server: runtime environment drifted from the non-verbose policy",
  );
  assert(proof.RestartCount === 0, `proof-server: restart count is ${String(proof.RestartCount)}`);
  const proofNetworks = Object.keys(proof.NetworkSettings?.Networks ?? {})
    .map((name) => name.startsWith(`${session.project}_`) ? name.slice(session.project.length + 1) : name)
    .sort();
  assert(
    JSON.stringify(proofNetworks) === JSON.stringify(["midnight_private", "proof_egress"]),
    `proof-server: runtime networks differ from exact allowlist: ${proofNetworks.join(",")}`,
  );
  const proofNetwork = await runCommand(
    "docker",
    ["network", "inspect", "--format", "{{json .Containers}}", `${session.project}_proof_egress`],
    session.children,
    { timeoutMs: 30_000 },
  );
  const proofEgressMembers = Object.keys(JSON.parse(proofNetwork.stdout.trim()) as Record<string, unknown>);
  assert(
    proofEgressMembers.length === 1 && proofEgressMembers[0] === serviceIds.get("proof-server"),
    `proof_egress has unexpected runtime members: ${proofEgressMembers.join(",")}`,
  );

  const nodeDisk = await runCommand(
    "docker",
    ["exec", serviceIds.get("midnight-node")!, "df", "-Pk", "/node/chain"],
    session.children,
    { timeoutMs: 30_000 },
  );
  const diskFields = lines(nodeDisk.stdout).at(-1)?.split(/\s+/) ?? [];
  const nodeAvailableBytes = Number(diskFields[3]) * 1024;
  assert(
    Number.isSafeInteger(nodeAvailableBytes) && nodeAvailableBytes >= 512 * 1024 * 1024,
    `midnight-node: tmpfs has only ${String(nodeAvailableBytes)} available bytes`,
  );

  const cacheFiles: Array<{ path: string; bytes: number }> = [];
  const proofStat = await runCommand(
    "docker",
    ["exec", serviceIds.get("proof-server")!, REAL_E1_PROOF_STAT, "--version"],
    session.children,
    { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 },
  );
  assert(/stat \(GNU coreutils\) 9\.10/.test(proofStat.stdout), "proof-server: pinned coreutils stat is absent");
  if (requireProofCache) {
    const cachePaths = [
      ["/.cache/midnight/zk-params/bls_midnight_2p17", 25_166_212],
      ["/.cache/midnight/zk-params/zswap/9/spend.prover", 11_020_001],
      ["/.cache/midnight/zk-params/zswap/9/output.prover", 5_730_182],
      ["/.cache/midnight/zk-params/zswap/9/sign.prover", 2_814_823],
      ["/.cache/midnight/zk-params/dust/9/spend.prover", 2_175_671],
    ] as const;
    const cacheScript = cachePaths
      .map(([path]) =>
        `test -s '${path}' && printf '${path}\\t%s\\n' "$(${REAL_E1_PROOF_STAT} -c %s '${path}')"`
      )
      .join(" && ");
    const cache = await runCommand(
      "docker",
      ["exec", serviceIds.get("proof-server")!, REAL_E1_PROOF_ENTRYPOINT, "-c", cacheScript],
      session.children,
      { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 },
    );
    for (const line of lines(cache.stdout)) {
      const [path, rawBytes] = line.split("\t");
      const bytes = Number(rawBytes);
      assert(path !== undefined && Number.isSafeInteger(bytes) && bytes > 0, "proof-server: malformed cache evidence");
      cacheFiles.push({ path, bytes });
    }
    assert(cacheFiles.length === cachePaths.length, "proof-server: required SRS cache evidence is incomplete");
    for (const [path, expectedBytes] of cachePaths) {
      assert(
        cacheFiles.some((entry) => entry.path === path && entry.bytes === expectedBytes),
        `proof-server: pinned cache file ${path} has unexpected size`,
      );
    }
  }
  return {
    proof: {
      containerId: serviceIds.get("proof-server")!,
      restartCount: 0,
      writableLayerBytes: Number(proof.SizeRw),
      networks: proofNetworks,
      cacheFiles,
    },
    writableLayers: [...inspected.entries()].map(([service, entry]) => ({ service, bytes: Number(entry.SizeRw) })),
    runtimeLogging,
    proofEgressMembers,
    nodeAvailableBytes,
  };
}

async function assertRealE1CelestiaEvidence(session: RealE1Session): Promise<{ eventCount: number; headHeight: string }> {
  const events = await recorderEvents(session as unknown as HarnessSession);
  const sequences = events.map((event) => Number(event.sequence));
  assert(
    sequences.every((sequence, index) => sequence === index + 1),
    `real E1 recorder sequence is not globally monotonic: ${sequences.join(",")}`,
  );
  const request = events.find(
    (event) => event.channel === "celestia" && event.phase === "request" && event.method === "POST",
  );
  assert(request !== undefined, "real E1 topology omitted the recorded Celestia request");
  const response = events.find(
    (event) =>
      event.channel === "celestia" &&
      event.phase === "response" &&
      event.status === 200 &&
      typeof event.bodyBase64 === "string",
  );
  assert(response !== undefined, "real E1 topology omitted the recorded Celestia response");
  const payload = JSON.parse(Buffer.from(String(response.bodyBase64), "base64").toString("utf8")) as {
    result?: { header?: { height?: string | number } };
  };
  const headHeight = String(payload.result?.header?.height ?? "");
  assert(/^[1-9][0-9]*$/.test(headHeight), `invalid Celestia head height ${JSON.stringify(headHeight)}`);
  return { eventCount: events.length, headHeight };
}

async function captureRealE1Artifacts(session: RealE1Session): Promise<RealE1Result["artifacts"]> {
  const proofContainer = await runCompose(session, ["ps", "--all", "--quiet", "proof-server"], {
    timeoutMs: 30_000,
  });
  const proofContainerId = proofContainer.stdout.trim();
  assert(/^[0-9a-f]{12,64}$/i.test(proofContainerId), "proof-server: container ID is missing during log capture");
  const proofLogResult = await runCommand(
    "docker",
    ["logs", "--timestamps", proofContainerId],
    session.children,
    { timeoutMs: 60_000, maxOutputBytes: 8 * 1024 * 1024 },
  );
  const proofLogText = `${proofLogResult.stdout}${proofLogResult.stderr}`;
  const proofLogBytes = Buffer.from(proofLogText);
  assert(proofLogBytes.byteLength < 8 * 1024 * 1024, "proof-server: retained log reached the 8 MiB rotation bound");
  const expectedMarker = `${REAL_E1_PROOF_START_MARKER_PREFIX}${session.files.proofLogMarker}`;
  assert(
    proofLogText.split(expectedMarker).length - 1 === 1,
    "proof-server: public per-session start marker is missing or duplicated",
  );
  const proofLines = [...proofLogResult.stdout.split("\n"), ...proofLogResult.stderr.split("\n")]
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = /^(\S+)\s([\s\S]*)$/.exec(line);
      assert(match !== null && !Number.isNaN(Date.parse(match[1]!)), "proof-server: log line lacks Docker timestamp");
      return { timestamp: match[1]!, payload: match[2]! };
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  assert(proofLines.length > 0 && proofLines[0]!.payload === expectedMarker, "proof-server: marker is not the first retained payload line");
  for (const line of proofLines) {
    assert(Buffer.byteLength(line.payload) <= 64 * 1024, "proof-server: oversized log line may contain proving material");
  }
  assertDirectProofLogSafe("proof-server retained log", proofLogText);
  const srsDownloads = proofLogText.match(
    /Attempting to download from the host https:\/\/srs\.midnight\.network\//g,
  )?.length ?? 0;
  const srsVerifications = proofLogText.match(/verified correct/gi)?.length ?? 0;
  assert(
    srsDownloads === 18 && srsVerifications === 18,
    `proof-server: expected 18 SRS downloads/verifications, observed ${srsDownloads}/${srsVerifications}`,
  );
  assert(
    (proofLogText.match(/starting service[^\n]*6300/gi)?.length ?? 0) === 1,
    "proof-server: expected exactly one port-6300 startup line",
  );
  assertNoGeneratedSecrets(
    "real E1 proof-server logs",
    proofLogText,
    session.files.generatedSecrets ?? [],
  );

  const trafficMetadata = await stat(session.files.traffic);
  assert(trafficMetadata.size <= 256 * 1024 * 1024, "real E1 recorder traffic exceeds 256 MiB");
  const traffic = await readFile(session.files.traffic);
  assert(traffic.byteLength <= 256 * 1024 * 1024, "real E1 recorder traffic grew beyond 256 MiB during capture");
  const logs = await runCompose(session, ["logs", "--no-color", "--timestamps"], {
    allowFailure: true,
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024 * 1024,
  });
  assert(logs.code === 0, `real E1 Compose log capture exited ${logs.code}`);
  const composeLogText = `${logs.stdout}${logs.stderr}`;
  const composeLogBytes = Buffer.from(composeLogText);
  assert(composeLogBytes.byteLength <= 256 * 1024 * 1024, "real E1 Compose logs exceed 256 MiB");
  assertMixedComposeProofLogSafe("real E1 aggregate Compose logs", composeLogText);
  return {
    traffic: {
      bytes: traffic.byteLength,
      sha256: createHash("sha256").update(traffic).digest("hex"),
      jsonl: traffic.toString("utf8"),
    },
    composeLogs: {
      bytes: composeLogBytes.byteLength,
      sha256: createHash("sha256").update(composeLogBytes).digest("hex"),
      text: composeLogText,
    },
    proofLogs: {
      bytes: proofLogBytes.byteLength,
      sha256: createHash("sha256").update(proofLogBytes).digest("hex"),
      text: proofLogText,
      startMarker: expectedMarker,
    },
  };
}

async function runRealE1Topology(): Promise<RealE1Result> {
  const session = await createRealE1Session(await reserveRandomPort(new Set()));
  let cleanup!: RealE1CleanupEvidence;
  try {
    assert(!handlingSignal, "real E1 construction completed after a termination signal");
    await prepareGeneratedSecretBoundary(session);
    await assertRealE1ConfiguredResourcePolicy(session);
    await buildRealE1Images(session);
    const [appImage, celestiaImage, selfChecks] = await Promise.all([
      inspectRealE1Image(
        session,
        session.appImage,
        session.files.appImageId,
        "arm64",
        session.files.appDockerfile,
        REAL_E1_APP_IMAGE_LABELS,
      ),
      inspectRealE1Image(
        session,
        session.celestiaImage,
        session.files.celestiaImageId,
        "amd64",
        session.files.celestiaDockerfile,
        REAL_E1_CELESTIA_IMAGE_LABELS,
      ),
      assertRealE1ImageSelfChecks(session),
    ]);
    await assertGeneratedSecretsAbsentFromBuiltImages(session);
    await runCompose(session, ["up", "--detach", "--wait", "--wait-timeout", "420"], {
      timeoutMs: 480_000,
    });
    const ready = await fetch(`http://127.0.0.1:${session.recorderPort}/ready`, {
      signal: AbortSignal.timeout(3_000),
    });
    assert(ready.status === 200, `real E1 recorder readiness returned ${ready.status}`);
    const [serviceStates, networkEvidence, evidence] = await Promise.all([
      realE1ServiceStates(session),
      realE1NetworkEvidence(session),
      assertRealE1CelestiaEvidence(session),
    ]);
    const runtimeHardening = await assertRealE1RuntimeHardening(session, false);
    const artifacts = await captureRealE1Artifacts(session);
    assertNoGeneratedSecrets(
      "real E1 topology evidence",
      JSON.stringify({ serviceStates, networkEvidence, runtimeHardening, evidence, artifacts }),
      session.files.generatedSecrets ?? [],
    );
    cleanup = await session.cleanup();
    assertCleanup({
      project: session.project,
      recorderPort: session.recorderPort,
      eventCount: evidence.eventCount,
      channels: ["celestia"],
      testError: null,
      diagnosticsSha256: null,
      cleanup,
    });
    assert(cleanup.retainedImageTags.length === 0, `${session.project}: retained generated image tags`);
    assert(cleanup.retainedImageIds.length === 0, `${session.project}: retained generated image IDs`);
    assert(
      cleanup.retainedSelfCheckContainers.length === 0,
      `${session.project}: retained standalone self-check containers`,
    );
    return {
      project: session.project,
      recorderPort: session.recorderPort,
      status: "PREFLIGHT_PASS",
      e1Gate: "OPEN",
      scenarioStatus: "NOT_RUN",
      appImage: {
        ...appImage,
        sourceManifestCount: session.files.sourceManifestCount,
        sourceManifestSha256: session.files.sourceManifestSha256,
      },
      celestiaImage,
      toolVersions: selfChecks.toolVersions,
      packageManifests: selfChecks.packageManifests,
      serviceStates,
      networkEvidence,
      runtimeHardening,
      celestiaHeadHeight: evidence.headHeight,
      eventCount: evidence.eventCount,
      artifacts,
      cleanup,
      buildCachePolicy:
        "Only this run's unique image tags are removed without force. Surviving content-addressed IIDs are recorded as shared image/BuildKit cache and are never deleted by IID; that workstation cache is not a committed test artifact.",
      nextImplementationBoundary:
        "Add the contract-deployment handoff and production Offer Files, batcher, solver, wallet actor, and refusal/race scenarios; this topology preflight does not satisfy SC-004 or SC-005.",
    };
  } catch (error) {
    let safeError = error instanceof Error ? error : new Error(String(error));
    try {
      assertNoGeneratedSecrets(
        "real E1 topology failure",
        safeError.message,
        session.files.generatedSecrets ?? [],
      );
    } catch (secretError) {
      safeError = secretError instanceof Error ? secretError : new Error("real E1 topology secret scan failed");
    }
    try {
      const diagnostics = await captureDiagnostics(session as unknown as HarnessSession);
      assertNoGeneratedSecrets(
        "real E1 topology diagnostics",
        diagnostics,
        session.files.generatedSecrets ?? [],
      );
      const diagnosticBytes = Buffer.from(diagnostics);
      console.error(
        `\n[real E1 diagnostics captured before teardown bytes=${diagnosticBytes.byteLength} sha256=${createHash("sha256").update(diagnosticBytes).digest("hex")}]\n${diagnostics}`,
      );
    } catch (diagnosticError) {
      const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      try {
        assertNoGeneratedSecrets(
          "real E1 topology diagnostic failure",
          diagnosticMessage,
          session.files.generatedSecrets ?? [],
        );
        console.error(`real E1 diagnostic capture failed: ${diagnosticMessage}`);
      } catch (secretError) {
        safeError = secretError instanceof Error ? secretError : new Error("real E1 topology diagnostic secret scan failed");
        console.error("real E1 topology diagnostics suppressed because a generated secret was detected");
      }
    }
    cleanup = await session.cleanup();
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        [safeError, ...cleanup.errors.map((message) => new Error(message))],
        "real E1 topology and cleanup both failed",
      );
    }
    throw safeError;
  }
}

function createRealE1AcceptanceConfig(): RealE1AcceptanceConfig {
  const runPrefix = `e1-${randomBytes(10).toString("hex")}`;
  const identities = E1_CASE_NAMES.map((caseName) => ({
    caseName,
    runId: `${runPrefix}-${caseName}`,
    solverToken: randomBytes(32).toString("hex"),
    recorderToken: randomBytes(32).toString("hex"),
  }));
  const runId = identities.find((identity) => identity.caseName === "valid-fill")!.runId;
  const postgresPassword = `e1-${randomBytes(24).toString("hex")}`;
  const indexerSecret = randomBytes(32).toString("hex").toUpperCase();
  const storagePassword = `e1-${randomBytes(32).toString("hex")}`;
  const liquidityReadSecret = randomBytes(32).toString("hex");
  const userSeed = randomBytes(32).toString("hex");
  const solverSeed = randomBytes(32).toString("hex");
  assert(userSeed !== solverSeed && userSeed !== E1_GENESIS_SEED && solverSeed !== E1_GENESIS_SEED, "generated actor seeds collided");
  return {
    runId,
    identities,
    postgresPassword,
    indexerSecret,
    storagePassword,
    liquidityReadSecret,
    userSeed,
    solverSeed,
    oneShotLogs: [],
    secrets: [
      postgresPassword,
      indexerSecret,
      storagePassword,
      liquidityReadSecret,
      ...identities.flatMap((identity) => [identity.solverToken, identity.recorderToken]),
      userSeed,
      solverSeed,
    ],
  };
}

function acceptanceIdentity(config: RealE1AcceptanceConfig, caseName: string): RealE1AcceptanceIdentity {
  const identity = config.identities.find((candidate) => candidate.caseName === caseName);
  assert(identity !== undefined, `missing real E1 identity for ${caseName}`);
  return identity;
}

function realE1AcceptanceEnvironment(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  identity: RealE1AcceptanceIdentity,
  solverOutputDirectory: string,
  garbage: { outputDirectory: string; label: string; rawBase64: string },
): string {
  const solverRegistry = Object.fromEntries(
    config.identities.map((candidate) => [candidate.runId, candidate.solverToken]),
  );
  const telemetryIdentities = Object.fromEntries(
    config.identities.map((candidate) => [candidate.runId, candidate.recorderToken]),
  );
  for (const [label, path] of [
    ["solver output", solverOutputDirectory],
    ["garbage output", garbage.outputDirectory],
  ] as const) {
    assert(path.startsWith(`${session.files.runtimeDirectory}/`), `${label} escaped the acceptance runtime`);
    assert(!/[\r\n]/.test(path), `${label} contains a line break`);
  }
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(garbage.label), "invalid garbage label");
  assert(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(garbage.rawBase64) &&
      garbage.rawBase64.length > 0 &&
      !/[\r\n]/.test(garbage.rawBase64),
    "invalid active garbage Base64",
  );
  return [
    `RECORDER_HOST_PORT=${session.recorderPort}`,
    `POSTGRES_PASSWORD=${config.postgresPassword}`,
    `MIDNIGHT_INDEXER_SECRET=${config.indexerSecret}`,
    `MIDNIGHT_STORAGE_PASSWORD=${config.storagePassword}`,
    `SOLVER_LIQUIDITY_READ_AUTH_SECRET=${config.liquidityReadSecret}`,
    `SOLVER_AUTH_REGISTRY=${JSON.stringify(solverRegistry)}`,
    `TELEMETRY_IDENTITIES=${JSON.stringify(telemetryIdentities)}`,
    `E1_ACCEPTANCE_RUN_ID=${config.runId}`,
    `E1_ACTIVE_RUN_ID=${identity.runId}`,
    `E1_ACTIVE_SOLVER_TOKEN=${identity.solverToken}`,
    `E1_ACTIVE_RECORDER_TOKEN=${identity.recorderToken}`,
    `E1_ACTIVE_SOLVER_OUTPUT_DIRECTORY=${solverOutputDirectory}`,
    `E1_ACTIVE_GARBAGE_OUTPUT_DIRECTORY=${garbage.outputDirectory}`,
    `E1_ACTIVE_GARBAGE_LABEL=${garbage.label}`,
    `E1_ACTIVE_GARBAGE_BLOB_BASE64=${garbage.rawBase64}`,
    `E1_GENESIS_SEED=${E1_GENESIS_SEED}`,
    `E1_USER_SEED=${config.userSeed}`,
    `E1_SOLVER_SEED=${config.solverSeed}`,
    "",
  ].join("\n");
}

async function atomicPrivateText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function activateRealE1Identity(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  identity: RealE1AcceptanceIdentity,
  solverOutputDirectory: string,
  garbage: { outputDirectory: string; label: string; rawBase64: string },
): Promise<void> {
  assert(!(await pathExists(solverOutputDirectory)), `solver output already exists for ${identity.caseName}`);
  await Promise.all([
    mkdir(solverOutputDirectory, { recursive: true, mode: 0o700 }),
    mkdir(garbage.outputDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeRealE1ActiveEnvironment(session, config, identity, solverOutputDirectory, garbage);
}

async function writeRealE1ActiveEnvironment(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  identity: RealE1AcceptanceIdentity,
  solverOutputDirectory: string,
  garbage: { outputDirectory: string; label: string; rawBase64: string },
): Promise<void> {
  await atomicPrivateText(
    session.files.environment,
    realE1AcceptanceEnvironment(session, config, identity, solverOutputDirectory, garbage),
  );
}

async function configureRealE1AcceptanceSession(
  session: RealE1Session,
): Promise<RealE1AcceptanceConfig> {
  const config = createRealE1AcceptanceConfig();
  const defaultIdentity = config.identities[0]!;
  const bootSolverOutput = join(session.files.runtimeDirectory, "solver", "boot");
  const inactiveGarbageOutput = join(session.files.runtimeDirectory, "publication", "inactive-garbage");
  await Promise.all([
    mkdir(bootSolverOutput, { mode: 0o700 }),
    mkdir(inactiveGarbageOutput, { mode: 0o700 }),
  ]);
  const environment = realE1AcceptanceEnvironment(
    session,
    config,
    defaultIdentity,
    bootSolverOutput,
    { outputDirectory: inactiveGarbageOutput, label: "inactive", rawBase64: "AQ==" },
  );
  session.files.generatedSecrets = config.secrets;
  await Promise.all([
    writeFile(session.files.environment, environment, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(session.files.runtimeDirectory, "control", "boot-solver-token"), defaultIdentity.solverToken, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(
      session.files.compose,
      realE1AcceptanceComposeSource({
        appImage: session.appImage,
        celestiaImage: session.celestiaImage,
        serviceSource: SERVICE_SOURCE,
        trafficPath: session.files.traffic,
        runtimeDirectory: session.files.runtimeDirectory,
        proofLogMarker: session.files.proofLogMarker,
      }),
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
  return config;
}

interface RealE1ConfiguredService {
  profiles?: string[];
  network_mode?: string;
  networks?: Record<string, { aliases?: string[] } | null> | string[];
  volumes?: Array<{ type?: string; source?: string; target?: string; read_only?: boolean }>;
  tmpfs?: string[];
  command?: string | string[];
  environment?: Record<string, string | null> | string[];
  logging?: { driver?: string; options?: Record<string, string | number> };
  restart?: string;
  depends_on?: Record<string, { condition?: string } | string> | string[];
  read_only?: boolean;
  cap_add?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  ports?: unknown[];
}

interface RealE1ConfiguredProject {
  services?: Record<string, RealE1ConfiguredService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, { internal?: boolean }>;
}

const REAL_E1_EXPECTED_TMPFS = Object.freeze<Record<string, readonly string[]>>({
  postgres: [
    "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=536870912,uid=70,gid=70,mode=0700",
    "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16777216,uid=70,gid=70,mode=3777",
  ],
  "midnight-node": [
    "/node/chain:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700",
  ],
  "midnight-indexer": [
    "/data:rw,nosuid,nodev,noexec,size=536870912,uid=10001,gid=10001,mode=0700",
    "/var/run/indexer-standalone:rw,nosuid,nodev,noexec,size=16777216,uid=10001,gid=10001,mode=0700",
  ],
  "proof-server": [
    "/.cache/midnight/zk-params:rw,nosuid,nodev,noexec,size=1073741824,uid=0,gid=0,mode=0700",
  ],
  celestia: [
    "/tmp:rw,nosuid,nodev,size=1073741824,uid=0,gid=0,mode=1777",
  ],
});

function configuredEnvironment(service: RealE1ConfiguredService | undefined): Record<string, string | null> {
  const value = service?.environment ?? {};
  if (!Array.isArray(value)) return value;
  return Object.fromEntries(value.map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? [entry, null] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function configuredCommand(service: RealE1ConfiguredService | undefined): string[] {
  const value = service?.command;
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function assertRealE1ConfiguredResourcePolicy(
  session: RealE1Session,
): Promise<RealE1ConfiguredProject> {
  const configured = await runCompose(session, ["config", "--no-interpolate", "--format", "json"], {
    timeoutMs: 30_000,
  });
  assertNoGeneratedSecrets(
    "non-interpolated real E1 Compose config",
    configured.stdout + configured.stderr,
    session.files.generatedSecrets ?? [],
  );
  const parsed = JSON.parse(configured.stdout) as RealE1ConfiguredProject;
  const services = parsed.services ?? {};
  assert(Object.keys(parsed.volumes ?? {}).length === 0, "real E1 Compose declares disk-backed named volumes");
  for (const [serviceName, service] of Object.entries(services)) {
    const expectedProofLogging = serviceName === "proof-server";
    assert(
      service.logging?.driver === (expectedProofLogging ? "local" : "json-file"),
      `${serviceName}: unexpected logging driver ${String(service.logging?.driver)}`,
    );
    const options = service.logging?.options ?? {};
    if (expectedProofLogging) {
      assert(
        String(options["max-size"]) === "8m" && String(options["max-file"]) === "1" &&
          String(options.compress) === "false" && String(options.mode) === "blocking" &&
          Object.keys(options).length === 4,
        "proof-server: logging must be exactly local/8m/1/no-compress/blocking",
      );
    } else {
      assert(
        String(options.mode) === "blocking" && Object.keys(options).length === 1,
        `${serviceName}: complete log retention must be exactly json-file/unlimited-default/blocking`,
      );
    }
    assert(
      !(service.volumes ?? []).some((volume) => volume.type === "volume"),
      `${serviceName}: disk-backed named volume mount is forbidden`,
    );
  }
  for (const [serviceName, expected] of Object.entries(REAL_E1_EXPECTED_TMPFS)) {
    const service = services[serviceName];
    assert(service !== undefined, `${serviceName}: missing from real E1 Compose`);
    assert(
      JSON.stringify([...(service.tmpfs ?? [])].sort()) === JSON.stringify([...expected].sort()),
      `${serviceName}: tmpfs policy differs from the bounded write-path map`,
    );
  }
  const proof = services["proof-server"];
  assert(
    JSON.stringify(configuredCommand(proof)) === JSON.stringify([REAL_E1_PROOF_COMPOSE_COMMAND]),
    "proof-server: generated command is not the exact pinned non-verbose command",
  );
  const proofEnvironment = configuredEnvironment(proof);
  assert(
    proofEnvironment.E1_PROOF_LOG_MARKER === session.files.proofLogMarker &&
      /^[0-9a-f]{32}$/.test(session.files.proofLogMarker),
    "proof-server: public per-session marker is absent or malformed",
  );
  assert(
    proofEnvironment.RUST_LOG === "info" && proofEnvironment.RUST_BACKTRACE === "0" &&
      proofEnvironment.MIDNIGHT_PROOF_SERVER_VERBOSE === "false" &&
      !("EXTRA_ARGS" in proofEnvironment),
    "proof-server: logging/backtrace environment is not fail-closed non-verbose",
  );
  const proofConfiguration = JSON.stringify({ command: configuredCommand(proof), environment: proofEnvironment });
  assert(!/(?:^|[^a-z])(?:--verbose|-v)(?:$|[^a-z])/i.test(proofConfiguration), "proof-server: verbose flag present");
  assert(!/\b(?:debug|trace)\b/i.test(proofConfiguration), "proof-server: DEBUG/TRACE configuration present");
  return parsed;
}

async function assertAcceptanceComposeIsManualSafe(session: RealE1Session): Promise<void> {
  const parsed = await assertRealE1ConfiguredResourcePolicy(session);
  const services = parsed.services ?? {};
  const networkNames = (service: RealE1ConfiguredService | undefined): string[] => {
    const networks = service?.networks ?? {};
    return (Array.isArray(networks) ? networks : Object.keys(networks)).sort();
  };
  const expectedNetworks: Record<string, string[]> = {
    "actor-provisioner": ["midnight_actor_clients"],
    "offer-publisher": ["publisher_egress"],
    "garbage-publisher": ["publisher_egress"],
    "solver-case": ["midnight_solver_clients", "solver_front"],
    "settlement-verifier": ["midnight_actor_clients"],
    "backend-settlement-verifier": ["offerfiles_private"],
  };
  for (const service of [
    "actor-provisioner",
    "offer-publisher",
    "invalid-fixture-generator",
    "garbage-publisher",
    "solver-case",
    "settlement-verifier",
    "backend-settlement-verifier",
  ]) {
    assert(
      services[service]?.profiles?.includes("acceptance-manual") === true,
      `${service}: missing acceptance-manual profile guard`,
    );
    if (service !== "invalid-fixture-generator") {
      assert(
        JSON.stringify(networkNames(services[service])) === JSON.stringify(expectedNetworks[service]!.sort()),
        `${service}: configured networks differ from the role allowlist`,
      );
    } else {
      assert(services[service]?.network_mode === "none", "invalid fixture generator must have no network");
    }
  }
  for (const service of [
    "traffic-recorder",
    "ntp-responder",
    "contract-deployer",
    "offerfiles-backend",
    "backend-proxy",
  ]) {
    assert(services[service] !== undefined, `${service}: absent from acceptance Compose`);
  }
  assert(
    JSON.stringify(networkNames(services["ntp-responder"])) === JSON.stringify(["backend_ntp", "control"]),
    "ntp-responder: configured networks differ from the exact backend-NTP boundary",
  );
  assert(
    JSON.stringify(networkNames(services["offerfiles-backend"])) ===
      JSON.stringify(["backend_egress", "backend_ntp", "midnight_backend_clients", "offerfiles_private"]),
    "offerfiles-backend: configured networks differ from the exact backend allowlist",
  );
  const ntpNetworks = services["ntp-responder"]?.networks;
  assert(ntpNetworks !== undefined && !Array.isArray(ntpNetworks), "ntp-responder: network aliases are absent");
  const ntpAliases = [...(ntpNetworks.backend_ntp?.aliases ?? [])].sort();
  assert(
    JSON.stringify(ntpAliases) === JSON.stringify([...REAL_E1_NTP_ALIASES].sort()),
    `ntp-responder: backend_ntp aliases differ from the exact allowlist: ${ntpAliases.join(",")}`,
  );
  const backendNtpMembers = Object.entries(services)
    .filter(([, service]) => networkNames(service).includes("backend_ntp"))
    .map(([name]) => name)
    .sort();
  assert(
    JSON.stringify(backendNtpMembers) === JSON.stringify(["ntp-responder", "offerfiles-backend"].sort()),
    `backend_ntp has unexpected configured members: ${backendNtpMembers.join(",")}`,
  );
  for (const network of new Set([
    ...networkNames(services["ntp-responder"]),
    ...networkNames(services["offerfiles-backend"]),
  ])) {
    assert(parsed.networks?.[network]?.internal === true, `${network}: NTP/backend boundary is not internal`);
  }
  const ntpEnvironment = configuredEnvironment(services["ntp-responder"]);
  const expectedNtpEnvironment = {
    HARNESS_ROLE: "ntp-responder",
    HARNESS_CHANNEL: "backend-ntp",
    HARNESS_COLLECTOR_URL: "http://traffic-recorder:8080",
    HARNESS_UPSTREAM_TIMEOUT_MS: "1000",
    HARNESS_NTP_BIND_HOST: "e1-ntp-boundary",
    HARNESS_NTP_PORT: "123",
    HARNESS_NTP_TIMESTAMP_WINDOW_MS: "30000",
    HARNESS_NTP_MAX_CONCURRENCY: "16",
    HARNESS_NTP_RATE_PER_SECOND: "32",
    HARNESS_NTP_RATE_BURST: "32",
    HARNESS_NTP_MAX_RESPONSES: "4096",
  };
  assert(
    JSON.stringify(Object.entries(ntpEnvironment).sort(([left], [right]) => left.localeCompare(right))) ===
      JSON.stringify(Object.entries(expectedNtpEnvironment).sort(([left], [right]) => left.localeCompare(right))),
    "ntp-responder: control environment differs from the exact bounded contract",
  );
  assert(
    services["ntp-responder"]?.read_only === true &&
      JSON.stringify([...(services["ntp-responder"]?.cap_drop ?? [])].sort()) === JSON.stringify(["ALL"]) &&
      JSON.stringify([...(services["ntp-responder"]?.cap_add ?? [])].sort()) ===
        JSON.stringify(["NET_BIND_SERVICE"]) &&
      (services["ntp-responder"]?.security_opt ?? []).length === 1 &&
      String(services["ntp-responder"]?.security_opt?.[0]).replace("=", ":") ===
        "no-new-privileges:true" &&
      (services["ntp-responder"]?.ports ?? []).length === 0,
    "ntp-responder: rootfs/capability/security/no-port policy drifted",
  );
  const backendDependencies = services["offerfiles-backend"]?.depends_on;
  assert(
    backendDependencies !== undefined && !Array.isArray(backendDependencies) &&
      typeof backendDependencies["ntp-responder"] === "object" &&
      backendDependencies["ntp-responder"]?.condition === "service_healthy",
    "offerfiles-backend: NTP dependency is not health-gated",
  );
  assert(
    JSON.stringify(networkNames(services["proof-server"])) === JSON.stringify(["midnight_private", "proof_egress"]),
    "proof-server: configured networks differ from the exact private+egress allowlist",
  );
  const proofEgressMembers = Object.entries(services)
    .filter(([, service]) => networkNames(service).includes("proof_egress"))
    .map(([name]) => name)
    .sort();
  assert(
    JSON.stringify(proofEgressMembers) === JSON.stringify(["proof-server"]),
    `proof_egress has unexpected configured members: ${proofEgressMembers.join(",")}`,
  );
  const proofGatewayEnvironment = configuredEnvironment(services["midnight-proof-gateway"]);
  assert(
    proofGatewayEnvironment.HARNESS_ROLE === "tcp-forwarder" &&
      proofGatewayEnvironment.HARNESS_TCP_TARGET_HOST === "proof-server" &&
      proofGatewayEnvironment.HARNESS_TCP_TARGET_PORT === "6300" &&
      !networkNames(services["midnight-proof-gateway"]).includes("proof_egress"),
    "midnight proof gateway is not the exact private TCP-only boundary",
  );

  const runtime = session.files.runtimeDirectory;
  const activeSolverOutput = join(
    dirname(session.files.compose),
    "${E1_ACTIVE_SOLVER_OUTPUT_DIRECTORY:?E1_ACTIVE_SOLVER_OUTPUT_DIRECTORY must be set}",
  );
  const activeGarbageOutput = join(
    dirname(session.files.compose),
    "${E1_ACTIVE_GARBAGE_OUTPUT_DIRECTORY:?E1_ACTIVE_GARBAGE_OUTPUT_DIRECTORY must be set}",
  );
  const expectedMounts: Record<string, Array<[string, string, boolean]>> = {
    "contract-deployer": [[join(runtime, "deployment"), "/outputs/deployment", false]],
    "offerfiles-backend": [[join(runtime, "deployment"), "/inputs/deployment", true]],
    "telemetry-relay": [
      [join(runtime, "actor"), "/inputs/actor", true],
      [join(runtime, "control"), "/run/e1-control", true],
    ],
    "actor-provisioner": [
      [join(runtime, "deployment"), "/inputs/deployment", true],
      [join(runtime, "actor"), "/outputs/actor", false],
    ],
    "offer-publisher": [
      [join(runtime, "actor"), "/inputs/actor", true],
      [join(runtime, "publication"), "/outputs/publication", false],
    ],
    "invalid-fixture-generator": [
      [join(runtime, "actor"), "/inputs/actor", true],
      [join(runtime, "invalid"), "/outputs/invalid", false],
    ],
    "garbage-publisher": [
      [join(runtime, "actor"), "/inputs/actor", true],
      [activeGarbageOutput, "/outputs/publication", false],
    ],
    "solver-case": [
      [join(runtime, "deployment"), "/inputs/deployment", true],
      [join(runtime, "actor"), "/inputs/actor", true],
      [activeSolverOutput, "/outputs/solver", false],
    ],
    "settlement-verifier": [
      [join(runtime, "deployment"), "/inputs/deployment", true],
      [join(runtime, "actor"), "/inputs/actor", true],
      [join(runtime, "wallet-settlement"), "/outputs/settlement", false],
    ],
    "backend-settlement-verifier": [
      [join(runtime, "actor"), "/inputs/actor", true],
      [join(runtime, "publication"), "/inputs/publication", true],
      [activeSolverOutput, "/inputs/solver", true],
      [join(runtime, "backend-settlement"), "/outputs/settlement", false],
    ],
  };
  for (const [serviceName, expected] of Object.entries(expectedMounts)) {
    const expectedSources = new Set(expected.map(([source]) => source));
    const actual = (services[serviceName]?.volumes ?? [])
      .filter(
        (volume) =>
          volume.source === runtime ||
          volume.source?.startsWith(`${runtime}/`) ||
          (volume.source !== undefined && expectedSources.has(volume.source)),
      )
      .map((volume) => [volume.source ?? "", volume.target ?? "", volume.read_only === true] as [string, string, boolean])
      .sort((left, right) => left[1].localeCompare(right[1]));
    const wanted = [...expected].sort((left, right) => left[1].localeCompare(right[1]));
    assert(JSON.stringify(actual) === JSON.stringify(wanted), `${serviceName}: runtime mount policy mismatch`);
  }
  for (const [serviceName, service] of Object.entries(services)) {
    if (serviceName in expectedMounts) continue;
    assert(
      !(service.volumes ?? []).some(
        (volume) => volume.source === runtime || volume.source?.startsWith(`${runtime}/`),
      ),
      `${serviceName}: undeclared access to acceptance runtime`,
    );
  }
  const solverNetworkMembers = Object.entries(services)
    .filter(([, service]) => networkNames(service).includes("midnight_solver_clients"))
    .map(([name]) => name)
    .sort();
  assert(
    JSON.stringify(solverNetworkMembers) ===
      JSON.stringify(
        ["midnight-indexer-gateway", "midnight-node-gateway", "midnight-proof-gateway", "solver-case"].sort(),
      ),
    `midnight_solver_clients has unexpected members: ${solverNetworkMembers.join(",")}`,
  );
}

async function execAcceptanceJson(
  session: RealE1Session,
  script: string,
  timeoutMs = 330_000,
): Promise<Record<string, unknown>> {
  const result = await runCompose(
    session,
    ["exec", "--no-TTY", "telemetry-relay", "node", "-e", script],
    { timeoutMs },
  );
  const output = result.stdout.trim();
  assert(output.length > 0, "acceptance control script returned no JSON");
  const lastLine = output.split("\n").at(-1)!;
  const parsed = JSON.parse(lastLine);
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), "acceptance control result is not an object");
  return parsed as Record<string, unknown>;
}

function normalizedComposeNetworkNames(
  session: RealE1Session,
  networks: Record<string, unknown> | undefined,
): string[] {
  return Object.keys(networks ?? {})
    .map((name) => name.startsWith(`${session.project}_`) ? name.slice(session.project.length + 1) : name)
    .sort();
}

async function realE1ComposeContainerId(session: RealE1Session, service: string): Promise<string> {
  const result = await runCompose(session, ["ps", "--all", "--quiet", service], {
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
  });
  const id = result.stdout.trim();
  assert(/^[0-9a-f]{12,64}$/i.test(id), `${service}: container ID is absent or malformed`);
  return id;
}

async function assertRealE1NtpBoundary(
  session: RealE1Session,
): Promise<RealE1NtpBoundaryEvidence> {
  const [responderContainerId, backendContainerId] = await Promise.all([
    realE1ComposeContainerId(session, "ntp-responder"),
    realE1ComposeContainerId(session, "offerfiles-backend"),
  ]);
  type NetworkAttachment = { IPAddress?: string; Aliases?: string[] };
  type InspectedNtpContainer = {
    Config?: { Env?: string[] };
    HostConfig?: {
      ReadonlyRootfs?: boolean;
      CapAdd?: string[];
      CapDrop?: string[];
      SecurityOpt?: string[];
    };
    NetworkSettings?: { Networks?: Record<string, NetworkAttachment> };
  };
  const inspectedResult = await runCommand(
    "docker",
    ["inspect", responderContainerId, backendContainerId],
    session.children,
    { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
  );
  const inspected = JSON.parse(inspectedResult.stdout) as InspectedNtpContainer[];
  assert(inspected.length === 2, "NTP boundary Docker inspect returned an unexpected container count");
  const responder = inspected[0]!;
  const backend = inspected[1]!;
  const responderNetworks = normalizedComposeNetworkNames(session, responder.NetworkSettings?.Networks);
  const backendNetworks = normalizedComposeNetworkNames(session, backend.NetworkSettings?.Networks);
  assert(
    JSON.stringify(responderNetworks) === JSON.stringify(["backend_ntp", "control"]),
    `ntp-responder: runtime networks differ from exact allowlist: ${responderNetworks.join(",")}`,
  );
  assert(
    JSON.stringify(backendNetworks) ===
      JSON.stringify(["backend_egress", "backend_ntp", "midnight_backend_clients", "offerfiles_private"]),
    `offerfiles-backend: runtime networks differ from exact allowlist: ${backendNetworks.join(",")}`,
  );
  assert(
    responder.HostConfig?.ReadonlyRootfs === true &&
      JSON.stringify([...(responder.HostConfig.CapDrop ?? [])].sort()) === JSON.stringify(["ALL"]) &&
      JSON.stringify([...(responder.HostConfig.CapAdd ?? [])].sort()) === JSON.stringify(["NET_BIND_SERVICE"]) &&
      (responder.HostConfig.SecurityOpt ?? []).length === 1 &&
      /^no-new-privileges(?::true)?$/.test(responder.HostConfig.SecurityOpt?.[0] ?? ""),
    "ntp-responder: runtime rootfs/capability/security policy drifted",
  );
  const responderNetworkKey = `${session.project}_backend_ntp`;
  const responderAttachment = responder.NetworkSettings?.Networks?.[responderNetworkKey];
  const backendAttachment = backend.NetworkSettings?.Networks?.[responderNetworkKey];
  const responderAddress = responderAttachment?.IPAddress ?? "";
  const backendAddress = backendAttachment?.IPAddress ?? "";
  assert(
    /^(?!0\.|127\.|169\.254\.)[0-9]+(?:\.[0-9]+){3}$/.test(responderAddress) &&
      /^(?!0\.|127\.|169\.254\.)[0-9]+(?:\.[0-9]+){3}$/.test(backendAddress) &&
      responderAddress !== backendAddress,
    "backend_ntp runtime addresses are absent, unsafe, or aliased",
  );
  const runtimeAliases = responderAttachment?.Aliases ?? [];
  for (const alias of REAL_E1_NTP_ALIASES) {
    assert(runtimeAliases.includes(alias), `ntp-responder: runtime alias ${alias} is absent`);
  }
  const unexpectedPoolAliases = runtimeAliases.filter(
    (alias) => /(?:^|\.)pool\.ntp\.org$/.test(alias) && !REAL_E1_NTP_ALIASES.includes(alias),
  );
  assert(unexpectedPoolAliases.length === 0, "ntp-responder: runtime has an undeclared NTP pool alias");

  const backendNtpNetwork = await runCommand(
    "docker",
    ["network", "inspect", responderNetworkKey],
    session.children,
    { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
  );
  const networkEntries = JSON.parse(backendNtpNetwork.stdout) as Array<{
    Internal?: boolean;
    Containers?: Record<string, unknown>;
  }>;
  assert(networkEntries.length === 1 && networkEntries[0]?.Internal === true, "backend_ntp is not internal at runtime");
  const backendNtpMembers = Object.keys(networkEntries[0]?.Containers ?? {}).sort();
  assert(
    JSON.stringify(backendNtpMembers) === JSON.stringify([responderContainerId, backendContainerId].sort()),
    `backend_ntp has unexpected runtime members: ${backendNtpMembers.join(",")}`,
  );
  const internalNetworks = [...new Set([...responderNetworks, ...backendNetworks])].sort();
  for (const network of internalNetworks) {
    const inspectedNetwork = await runCommand(
      "docker",
      ["network", "inspect", "--format", "{{json .Internal}}", `${session.project}_${network}`],
      session.children,
      { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 },
    );
    assert(inspectedNetwork.stdout.trim() === "true", `${network}: backend/NTP runtime network is not internal`);
  }

  const dnsScript = [
    "const {lookup}=await import('node:dns/promises');",
    `const hosts=${JSON.stringify(REAL_E1_NTP_ALIASES.slice(1))};`,
    "const rows=[];for(const host of hosts){const found=await lookup(host,{all:true,family:4,verbatim:true});rows.push({host,addresses:[...new Set(found.map(v=>v.address))]})}",
    "console.log(JSON.stringify(rows));",
  ].join("");
  const dnsResult = await runCommand(
    "docker",
    ["exec", backendContainerId, "/usr/local/bin/bun", "-e", dnsScript],
    session.children,
    { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 },
  );
  const resolved = JSON.parse(dnsResult.stdout.trim()) as Array<{ host?: unknown; addresses?: unknown }>;
  const dns = resolved.map((entry) => {
    assert(typeof entry.host === "string" && Array.isArray(entry.addresses), "backend NTP DNS evidence is malformed");
    assert(
      entry.addresses.length === 1 && entry.addresses[0] === responderAddress,
      `${entry.host}: backend DNS escaped the internal NTP responder`,
    );
    return { host: entry.host, address: responderAddress };
  });
  assert(
    JSON.stringify(dns.map((entry) => entry.host)) === JSON.stringify(REAL_E1_NTP_ALIASES.slice(1)),
    "backend NTP DNS evidence is incomplete or out of order",
  );

  const statsScript =
    "fetch('http://127.0.0.1:8080/ntp-stats',{signal:AbortSignal.timeout(5000)}).then(async r=>{const v=await r.json();if(!r.ok)throw new Error('stats '+r.status);console.log(JSON.stringify(v))}).catch(e=>{console.error(e);process.exit(1)})";
  const readStats = async (): Promise<Record<string, unknown>> => {
    const statsResult = await runCommand(
      "docker",
      ["exec", responderContainerId, "node", "-e", statsScript],
      session.children,
      { timeoutMs: 15_000, maxOutputBytes: 16 * 1024 },
    );
    return JSON.parse(statsResult.stdout.trim()) as Record<string, unknown>;
  };
  const stableCounterNames = [
    "received",
    "valid",
    "permitted",
    "sent",
    "backendReserved",
    "backendSent",
    "selfTestSent",
    "invalid",
    "overlimit",
    "recorderFailures",
    "socketFailures",
    "active",
    "maxActive",
  ];
  const stableCounters = (value: Record<string, unknown>): string =>
    JSON.stringify(stableCounterNames.map((name) => value[name]));
  let stats: Record<string, unknown> | undefined;
  let events: Array<Record<string, unknown>> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = await readStats();
    if (Number(before.active) !== 0 || Number(before.backendReserved) !== Number(before.backendSent)) {
      await sleep(100);
      continue;
    }
    const candidateEvents = await recorderEvents(session as unknown as HarnessSession);
    const after = await readStats();
    if (Number(after.active) === 0 && stableCounters(before) === stableCounters(after)) {
      stats = after;
      events = candidateEvents;
      break;
    }
    await sleep(100);
  }
  assert(stats !== undefined && events !== undefined, "ntp-responder: no stable bounded evidence window");
  const numeric = (name: string): number => {
    const value = Number(stats[name]);
    assert(Number.isSafeInteger(value) && value >= 0, `ntp-responder: invalid ${name} counter`);
    return value;
  };
  const statsEvidence = {
    received: numeric("received"),
    valid: numeric("valid"),
    permitted: numeric("permitted"),
    sent: numeric("sent"),
    backendReserved: numeric("backendReserved"),
    backendSent: numeric("backendSent"),
    selfTestSent: numeric("selfTestSent"),
    maxActive: numeric("maxActive"),
  };
  assert(
    stats.ready === true && stats.selfTestPassed === true && stats.socketBound === true && stats.fatal === false &&
      stats.fatalCode === null && numeric("invalid") === 0 && numeric("overlimit") === 0 &&
      numeric("recorderFailures") === 0 && numeric("socketFailures") === 0 && numeric("active") === 0 &&
      statsEvidence.selfTestSent === 1 && statsEvidence.backendSent >= 8 && statsEvidence.backendSent <= 4_096 &&
      statsEvidence.backendReserved === statsEvidence.backendSent &&
      statsEvidence.received === statsEvidence.valid && statsEvidence.valid === statsEvidence.sent &&
      statsEvidence.permitted === statsEvidence.sent && statsEvidence.maxActive <= 16,
    "ntp-responder: bounded healthy counter invariants failed",
  );

  assert(events.every((event, index) => eventSequence(event) === index + 1), "NTP evidence recorder order is not total");
  const ntpEvents = events.filter((event) => event.channel === "backend-ntp");
  const readyEvents = ntpEvents.filter((event) => event.phase === "ntp-ready");
  assert(readyEvents.length === 1, "ntp-responder: ready evidence is missing or duplicated");
  const readySequence = eventSequence(readyEvents[0]!);
  const healthRequests = events.filter(
    (event) => event.channel === "backend" && event.phase === "request" && event.method === "GET" &&
      event.path === "/v1/health/sync",
  );
  const successfulHealthObservations = healthRequests.flatMap((request) => {
    const response = events.find(
      (event) => event.channel === "backend" && event.phase === "response" &&
        event.requestId === request.requestId && event.status === 200,
    );
    return response === undefined ? [] : [{ request, response }];
  }).sort((left, right) => eventSequence(left.response) - eventSequence(right.response));
  const bootstrapHealth = successfulHealthObservations.find(
    ({ request, response }) => eventSequence(request) > readySequence && eventSequence(response) > eventSequence(request),
  );
  assert(bootstrapHealth !== undefined, "backend has no exact successful post-NTP-ready health observation");
  const healthResponse = bootstrapHealth.response;
  const healthSequence = eventSequence(healthResponse);
  assert(readySequence < eventSequence(bootstrapHealth.request) && healthSequence > eventSequence(bootstrapHealth.request),
    "NTP readiness does not precede the successful backend health observation");
  const selfTestPermits = ntpEvents.filter((event) => event.phase === "ntp-permit" && event.selfTest === true);
  const selfTestSends = ntpEvents.filter((event) => event.phase === "ntp-sent" && event.selfTest === true);
  assert(
    selfTestPermits.length === 1 && selfTestSends.length === 1 &&
      selfTestSends[0]?.permitSequence === eventSequence(selfTestPermits[0]!) &&
      eventSequence(selfTestSends[0]!) < readySequence,
    "ntp-responder: self-test permit/send/ready order is invalid",
  );
  const backendPermits = ntpEvents.filter((event) => event.phase === "ntp-permit" && event.selfTest === false);
  const backendSends = ntpEvents.filter((event) => event.phase === "ntp-sent" && event.selfTest === false);
  assert(
    backendPermits.length === statsEvidence.backendSent && backendSends.length === statsEvidence.backendSent &&
      backendPermits.length >= 8,
    "ntp-responder: backend permit/send evidence count differs from healthy stats",
  );
  const permitByRequest = new Map<string, Record<string, unknown>>();
  for (const permit of backendPermits) {
    const requestId = String(permit.requestId ?? "");
    assert(requestId.length > 0 && !permitByRequest.has(requestId), "ntp-responder: duplicate backend permit identity");
    permitByRequest.set(requestId, permit);
  }
  const backendPairs = backendSends.map((sent) => {
    const requestId = String(sent.requestId ?? "");
    const permit = permitByRequest.get(requestId);
    assert(permit !== undefined, "ntp-responder: sent evidence has no matching permit");
    const permitSequence = eventSequence(permit);
    const sentSequence = eventSequence(sent);
    const requestSha256 = String(permit.requestSha256 ?? "");
    const requestTransmitSha256 = String(permit.requestTransmitSha256 ?? "");
    const responseSha256 = String(permit.responseSha256 ?? "");
    const remotePort = Number(permit.remotePort);
    const receiveMs = Number(permit.receiveMs);
    const transmitMs = Number(permit.transmitMs);
    assert(
      sent.permitSequence === permitSequence && sentSequence > permitSequence &&
        permitSequence > readySequence && permit.remoteAddress === backendAddress && permit.requestBytes === 48 &&
        permit.responseBytes === 48 && permit.requestVersion === 4 && permit.requestMode === 3 &&
        permit.responseVersion === 4 && permit.responseMode === 4 && permit.responseStratum === 1 &&
        /^[0-9a-f]{64}$/.test(requestSha256) && sent.requestSha256 === requestSha256 &&
        /^[0-9a-f]{64}$/.test(requestTransmitSha256) &&
        requestTransmitSha256 === permit.originateEchoSha256 && sent.requestTransmitSha256 === requestTransmitSha256 &&
        sent.originateEchoSha256 === requestTransmitSha256 && /^[0-9a-f]{64}$/.test(responseSha256) &&
        sent.responseSha256 === responseSha256 && sent.remoteAddress === backendAddress &&
        Number(sent.remotePort) === remotePort && Number.isInteger(remotePort) && remotePort >= 1 && remotePort <= 65_535 &&
        Number(sent.receiveMs) === receiveMs && Number(sent.transmitMs) === transmitMs &&
        Number.isSafeInteger(receiveMs) && Number.isSafeInteger(transmitMs) && receiveMs > 0 &&
        transmitMs >= receiveMs && transmitMs - receiveMs <= 1_000,
      "ntp-responder: backend permit/send pair is not causally or byte-metadata bound",
    );
    permitByRequest.delete(requestId);
    return {
      requestId,
      permitSequence,
      sentSequence,
      requestSha256,
      requestTransmitSha256,
      responseSha256,
      remoteAddress: backendAddress,
      remotePort,
      receiveMs,
      transmitMs,
    };
  });
  assert(permitByRequest.size === 0, "ntp-responder: backend permit evidence was not consumed exactly once");
  const bootstrapHealthRequestSequence = eventSequence(bootstrapHealth.request);
  const pairsBeforeBootstrapHealth = backendPairs.filter(
    (pair) => pair.sentSequence < bootstrapHealthRequestSequence,
  ).length;
  assert(
    pairsBeforeBootstrapHealth >= 8,
    `ntp-responder: only ${pairsBeforeBootstrapHealth} complete backend pairs preceded the bootstrap health request`,
  );
  const observationSequence = eventSequence(events.at(-1)!);
  assert(observationSequence === events.length, "NTP final observation does not cover the complete recorder prefix");
  return {
    responderContainerId,
    backendContainerId,
    responderAddress,
    backendAddress,
    responderNetworks,
    backendNetworks,
    backendNtpMembers,
    internalNetworks,
    dns,
    stats: { ...statsEvidence, selfTestSent: 1 },
    readySequence,
    bootstrapHealthSequence: healthSequence,
    observationSequence,
    pairsBeforeBootstrapHealth,
    backendPairs,
  };
}

function assertRealE1NtpBoundaryStable(
  initial: RealE1NtpBoundaryEvidence,
  final: RealE1NtpBoundaryEvidence,
): void {
  assert(
    final.responderContainerId === initial.responderContainerId &&
      final.backendContainerId === initial.backendContainerId &&
      final.responderAddress === initial.responderAddress && final.backendAddress === initial.backendAddress &&
      JSON.stringify(final.responderNetworks) === JSON.stringify(initial.responderNetworks) &&
      JSON.stringify(final.backendNetworks) === JSON.stringify(initial.backendNetworks) &&
      JSON.stringify(final.backendNtpMembers) === JSON.stringify(initial.backendNtpMembers) &&
      JSON.stringify(final.dns) === JSON.stringify(initial.dns) &&
      final.readySequence === initial.readySequence &&
      final.bootstrapHealthSequence === initial.bootstrapHealthSequence &&
      final.observationSequence >= initial.observationSequence &&
      final.backendPairs.length >= initial.backendPairs.length &&
      JSON.stringify(final.backendPairs.slice(0, initial.backendPairs.length)) ===
        JSON.stringify(initial.backendPairs),
    "real E1 NTP boundary changed between bootstrap and final evidence",
  );
}

async function captureRealE1FinalNtpEvidence(
  session: RealE1Session,
  initial: RealE1NtpBoundaryEvidence,
): Promise<{ ntpBoundary: RealE1NtpBoundaryEvidence; events: Array<Record<string, unknown>> }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const ntpBoundary = await assertRealE1NtpBoundary(session);
    assertRealE1NtpBoundaryStable(initial, ntpBoundary);
    const events = await recorderEvents(session as unknown as HarnessSession);
    if (
      events.length === ntpBoundary.observationSequence &&
      events.length > 0 && eventSequence(events.at(-1)!) === ntpBoundary.observationSequence
    ) {
      return { ntpBoundary, events };
    }
    await sleep(50);
  }
  throw new Error("real E1 recorder appended events between final NTP and global evidence snapshots");
}

async function queryRealE1DatabaseBootstrapSnapshot(
  session: RealE1Session,
): Promise<Omit<RealE1DatabaseBootstrapEvidence, "stableNoDuplicateCheck">> {
  const migrationOrderSource = await readFile(
    join(REPOSITORY_ROOT, "packages/database/migration-order.ts"),
    "utf8",
  );
  const declaredMigrationNames = [...migrationOrderSource.matchAll(/\bname:\s*"([a-z0-9_.-]+)"/g)]
    .map((match) => match[1]!);
  assert(
    REAL_E1_MIGRATION_NAMES.length === 15 && new Set(REAL_E1_MIGRATION_NAMES).size === 15 &&
      JSON.stringify(declaredMigrationNames) === JSON.stringify(REAL_E1_MIGRATION_NAMES),
    "real E1 expected migrations do not exactly match migrationTable source order",
  );
  assert(
    REAL_E1_REQUIRED_DATABASE_RELATIONS.every((name) => /^[a-z0-9_]+$/.test(name)),
    "real E1 public relation allowlist contains an unsafe identifier",
  );
  const query = `
WITH app_migrations AS (
  SELECT name, block_height
  FROM effectstream.effectstream_migration_history
  WHERE is_system_migration = false
), public_relations AS (
  SELECT c.relname
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
)
SELECT json_build_object(
  'migrations', (SELECT COALESCE(json_agg(json_build_object('name', name, 'blockHeight', block_height) ORDER BY name), '[]'::json) FROM app_migrations),
  'blockOneCount', (SELECT count(*) FROM effectstream.effectstream_blocks WHERE block_height = 1),
  'finalizedBlockOneCount', (SELECT count(*) FROM effectstream.effectstream_blocks WHERE block_height = 1 AND effectstream_block_hash IS NOT NULL),
  'relations', (SELECT COALESCE(json_agg(relname ORDER BY relname), '[]'::json) FROM public_relations)
)::text;
`;
  const result = await runCompose(
    session,
    [
      "exec",
      "--no-TTY",
      "postgres",
      "psql",
      "--username=postgres",
      "--dbname=postgres",
      "--no-align",
      "--tuples-only",
      "--set=ON_ERROR_STOP=1",
      "--command",
      query,
    ],
    { timeoutMs: 30_000, maxOutputBytes: 128 * 1024 },
  );
  assertNoGeneratedSecrets(
    "real E1 DB bootstrap query output",
    result.stdout + result.stderr,
    session.files.generatedSecrets ?? [],
  );
  const parsed = JSON.parse(result.stdout.trim()) as {
    migrations?: Array<{ name?: unknown; blockHeight?: unknown }>;
    blockOneCount?: unknown;
    finalizedBlockOneCount?: unknown;
    relations?: unknown;
  };
  assert(Array.isArray(parsed.migrations), "real E1 DB migration evidence is not an array");
  const migrations = parsed.migrations.map((entry) => {
    assert(
      typeof entry.name === "string" && Number(entry.blockHeight) === 1,
      "real E1 DB migration evidence has a malformed name/height",
    );
    return { name: entry.name, blockHeight: 1 as const };
  });
  const expectedMigrationNames = [...REAL_E1_MIGRATION_NAMES].sort();
  assert(
    JSON.stringify(migrations.map((entry) => entry.name)) === JSON.stringify(expectedMigrationNames),
    "real E1 DB non-system migration rows do not exactly match migrationTable at block 1",
  );
  assert(Number(parsed.blockOneCount) === 1, "real E1 DB does not contain exactly one block-height-1 row");
  assert(
    Number(parsed.finalizedBlockOneCount) === 1,
    "real E1 DB block-height-1 row has no finalized effectstream block hash",
  );
  assert(Array.isArray(parsed.relations), "real E1 DB relation evidence is not an array");
  const relations = parsed.relations.map(String);
  assert(
    JSON.stringify(relations) === JSON.stringify(REAL_E1_REQUIRED_DATABASE_RELATIONS),
    "real E1 DB public relations do not exactly match the isolated application schema",
  );
  return { migrations, blockOneCount: 1, finalizedBlockOneCount: 1, relations };
}

async function assertRealE1DatabaseBootstrap(
  session: RealE1Session,
): Promise<RealE1DatabaseBootstrapEvidence> {
  const first = await queryRealE1DatabaseBootstrapSnapshot(session);
  await sleep(2_000);
  const second = await queryRealE1DatabaseBootstrapSnapshot(session);
  assert(
    JSON.stringify(second) === JSON.stringify(first),
    "real E1 DB bootstrap evidence changed during the stable no-duplicate window",
  );
  return { ...first, stableNoDuplicateCheck: true };
}

async function assertRealE1DatabaseBootstrapStillExact(
  session: RealE1Session,
  initial: RealE1DatabaseBootstrapEvidence,
): Promise<void> {
  const final = await queryRealE1DatabaseBootstrapSnapshot(session);
  assert(
    JSON.stringify(final) === JSON.stringify({
      migrations: initial.migrations,
      blockOneCount: initial.blockOneCount,
      finalizedBlockOneCount: initial.finalizedBlockOneCount,
      relations: initial.relations,
    }),
    "real E1 DB migrations/block-1/relations changed after bootstrap",
  );
}

async function runAcceptanceOneShot(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  service: string,
  logPath: string,
  timeoutMs: number,
): Promise<{ bytes: number; sha256: string }> {
  const result = await runCompose(
    session,
    ["--profile", "acceptance-manual", "run", "--rm", "--no-deps", service],
    { timeoutMs, maxOutputBytes: 8 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  const bytes = Buffer.from(output);
  assert(bytes.byteLength <= 8 * 1024 * 1024, `${service}: one-shot output exceeds 8 MiB`);
  assertNoGeneratedSecrets(`${service} one-shot output`, output, config.secrets);
  await writeFile(logPath, bytes, { mode: 0o600, flag: "wx" });
  const evidence = { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  config.oneShotLogs.push({
    service,
    path: relative(session.files.runtimeDirectory, logPath),
    ...evidence,
    text: output,
  });
  return evidence;
}

async function assertPrivateArtifact(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${path}: acceptance artifact is not a non-symlink regular file`);
  assert((metadata.mode & 0o777) === 0o600, `${path}: acceptance artifact mode is not 0600`);
  const bytes = await readFile(path);
  assert(bytes.byteLength > 0, `${path}: acceptance artifact is empty`);
  return bytes;
}

async function assertRuntimeTreeSecretFree(
  session: RealE1Session,
  secrets: readonly string[],
  label: string,
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const root = session.files.runtimeDirectory;
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const directoryMetadata = await lstat(directory);
    assert(
      directoryMetadata.isDirectory() && !directoryMetadata.isSymbolicLink() &&
        (directoryMetadata.mode & 0o777) === 0o700,
      `${label}: runtime directory is not a non-symlink mode-0700 directory: ${relative(root, directory) || "."}`,
    );
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      assert(!metadata.isSymbolicLink(), `${label}: runtime tree contains symlink ${relative(root, path)}`);
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      assert(metadata.isFile(), `${label}: runtime tree contains non-regular entry ${relative(root, path)}`);
      assert((metadata.mode & 0o777) === 0o600, `${label}: runtime artifact is not mode 0600: ${relative(root, path)}`);
      assert(metadata.size <= 8 * 1024 * 1024, `${label}: runtime artifact exceeds 8 MiB: ${relative(root, path)}`);
      assert(files.length < 512, `${label}: runtime tree exceeds 512 files`);
      totalBytes += metadata.size;
      assert(totalBytes <= 64 * 1024 * 1024, `${label}: runtime artifacts exceed 64 MiB total`);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        assert(
          before.isFile() && (before.mode & 0o777) === 0o600 &&
            before.dev === metadata.dev && before.ino === metadata.ino && before.size === metadata.size,
          `${label}: runtime artifact changed before scan ${relative(root, path)}`,
        );
        bytes = await handle.readFile();
        const after = await handle.stat();
        assert(
          after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
            after.mtimeMs === before.mtimeMs && bytes.byteLength === before.size,
          `${label}: runtime artifact changed during scan ${relative(root, path)}`,
        );
      } finally {
        await handle.close();
      }
      assertNoGeneratedSecrets(`${label} ${relative(root, path)}`, bytes.toString("utf8"), secrets);
      files.push({
        path: relative(root, path),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await visit(root);
  return files;
}

type E1Fault = Record<string, unknown> | null;

interface E1CaseDescriptor {
  caseName: string;
  stage: "admission" | "dequeue" | "valid";
  completion: "held-request" | "negative-verdict" | "unavailable" | "dequeue-release" | "settled";
  fault: (verdict: Record<string, unknown>, offerHash: string) => E1Fault;
}

const validateMatch = (fromOccurrence = 1): Record<string, unknown> => ({
  method: "POST",
  path: "/v1/offers/validate",
  fromOccurrence,
});

const replaceFault = (
  value: unknown,
  fromOccurrence = 1,
  contentType = "application/json",
): Record<string, unknown> => ({
  mode: "replace",
  status: 200,
  contentType,
  bodyBase64: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64"),
  afterUpstream: true,
  match: validateMatch(fromOccurrence),
});

type E1JsonPatchOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "increment-decimal-string"; path: string; delta: string };

const jsonPatchFault = (
  patchId: string,
  operations: readonly E1JsonPatchOperation[],
  fromOccurrence = 1,
): Record<string, unknown> => ({
  mode: "json-patch",
  afterUpstream: true,
  patchId,
  operations: operations.map((operation) => ({ ...operation })),
  match: validateMatch(fromOccurrence),
});

const domainNegativePatch = (fromOccurrence = 1): Record<string, unknown> => jsonPatchFault(
  "canonical-root-unknown",
  [
    { op: "set", path: "/valid", value: false },
    { op: "set", path: "/live", value: false },
    { op: "set", path: "/status", value: "live" },
    { op: "set", path: "/code", value: "ROOT_UNKNOWN" },
  ],
  fromOccurrence,
);

const E1_CASE_MATRIX: readonly E1CaseDescriptor[] = Object.freeze([
  {
    caseName: "admission-delay",
    stage: "admission",
    completion: "held-request",
    fault: () => ({ mode: "delay", delayMs: 8_000, match: validateMatch() }),
  },
  {
    caseName: "domain-invalid",
    stage: "admission",
    completion: "negative-verdict",
    fault: () => domainNegativePatch(),
  },
  ...[404, 400, 413, 429, 500, 503].map((status): E1CaseDescriptor => ({
    caseName: `http-${status}`,
    stage: "admission",
    completion: "unavailable",
    fault: () => ({ mode: "status", status, match: validateMatch() }),
  })),
  {
    caseName: "malformed",
    stage: "admission",
    completion: "unavailable",
    fault: () => replaceFault('{"malformed":'),
  },
  {
    caseName: "timeout",
    stage: "admission",
    completion: "unavailable",
    fault: () => ({ mode: "delay", delayMs: 20_000, match: validateMatch() }),
  },
  {
    caseName: "disconnect",
    stage: "admission",
    completion: "unavailable",
    fault: () => ({ mode: "disconnect", match: validateMatch() }),
  },
  {
    caseName: "wrong-identity",
    stage: "admission",
    completion: "unavailable",
    fault: (verdict, offerHash) => {
      const wrong = offerHash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      return jsonPatchFault("wrong-identity", [
        { op: "set", path: "/claimedOfferId", value: wrong },
        { op: "set", path: "/computedOfferId", value: wrong },
      ]);
    },
  },
  {
    caseName: "mismatch",
    stage: "admission",
    completion: "unavailable",
    fault: () => jsonPatchFault("projection-mismatch", [{
      op: "increment-decimal-string",
      path: "/computed/gives/0/amount",
      delta: "1",
    }]),
  },
  {
    caseName: "stale-state-version",
    stage: "admission",
    completion: "unavailable",
    fault: () => jsonPatchFault("stale-state-version", [{ op: "set", path: "/stateVersion", value: "1" }]),
  },
  {
    caseName: "unknown-schema",
    stage: "admission",
    completion: "unavailable",
    fault: () => jsonPatchFault("unknown-schema", [{ op: "set", path: "/schemaVersion", value: 2 }]),
  },
  {
    caseName: "unknown-status",
    stage: "admission",
    completion: "unavailable",
    fault: () => jsonPatchFault("unknown-status", [{ op: "set", path: "/status", value: "future" }]),
  },
  {
    caseName: "unknown-code",
    stage: "admission",
    completion: "unavailable",
    fault: () => jsonPatchFault("unknown-code", [{ op: "set", path: "/code", value: "FUTURE_VERDICT" }]),
  },
  {
    caseName: "dequeue-domain-invalid",
    stage: "dequeue",
    completion: "dequeue-release",
    fault: () => domainNegativePatch(2),
  },
  {
    caseName: "dequeue-unavailable",
    stage: "dequeue",
    completion: "dequeue-release",
    fault: () => ({ mode: "status", status: 503, match: validateMatch(2) }),
  },
  {
    caseName: "valid-fill",
    stage: "valid",
    completion: "settled",
    fault: () => null,
  },
]);

function eventSequence(event: Record<string, unknown>): number {
  const sequence = Number(event.sequence);
  assert(Number.isSafeInteger(sequence) && sequence > 0, "recorder event has no canonical sequence");
  return sequence;
}

function eventHeaders(event: Record<string, unknown>): Record<string, unknown> {
  const value = event.headers;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSolverEvent(event: Record<string, unknown>, runId: string): boolean {
  return event.channel === "solver-validation" &&
    event.runId === runId &&
    event.authenticatedRunId === runId &&
    event.authentication === "bearer";
}

function isPhaseEvent(
  event: Record<string, unknown>,
  runId: string,
  phase: string,
  name: string,
): boolean {
  return isSolverEvent(event, runId) && event.phase === phase && event.event === name;
}

async function waitForRecorderEvent(
  session: RealE1Session,
  afterSequence: number,
  label: string,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 360_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  do {
    const events = await recorderEvents(session as unknown as HarnessSession);
    const match = events.find((event) => eventSequence(event) > afterSequence && predicate(event));
    if (match !== undefined) return match;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`${label} was not recorded within ${timeoutMs} ms`);
}

function validationRequestEvents(
  events: Array<Record<string, unknown>>,
  identity: RealE1AcceptanceIdentity,
  afterSequence: number,
): Array<Record<string, unknown>> {
  const authorizationSha256 = createHash("sha256")
    .update(`Bearer ${identity.solverToken}`)
    .digest("hex");
  return events.filter(
    (event) =>
      eventSequence(event) > afterSequence &&
      event.channel === "backend" &&
      event.phase === "request" &&
      event.method === "POST" &&
      event.path === "/v1/offers/validate" &&
      eventHeaders(event).authorizationSha256 === authorizationSha256,
  );
}

function caseEventSlice(
  events: Array<Record<string, unknown>>,
  identity: RealE1AcceptanceIdentity,
  afterSequence: number,
): Array<Record<string, unknown>> {
  const requests = validationRequestEvents(events, identity, afterSequence);
  const requestIds = new Set(requests.map((event) => String(event.requestId)));
  return events.filter(
    (event) =>
      eventSequence(event) > afterSequence &&
      (isSolverEvent(event, identity.runId) ||
        (event.channel === "backend" && requestIds.has(String(event.requestId)))),
  );
}

function matchingResponse(
  events: Array<Record<string, unknown>>,
  request: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return events.find(
    (event) =>
      event.channel === "backend" &&
      event.phase === "response" &&
      event.requestId === request.requestId,
  );
}

function applyExpectedJsonPatch(
  upstream: Buffer,
  operations: readonly E1JsonPatchOperation[],
  label: string,
): Buffer {
  const root = JSON.parse(upstream.toString("utf8")) as Record<string, unknown>;
  const patched = structuredClone(root);
  for (const operation of operations) {
    const segments = operation.path.slice(1).split("/");
    const key = segments.pop();
    assert(key !== undefined, `${label}: empty JSON patch path`);
    let parent: Record<string, unknown> | Array<unknown> = patched;
    for (const segment of segments) {
      const child = parent[segment as keyof typeof parent];
      assert(child !== null && typeof child === "object", `${label}: missing JSON patch path ${operation.path}`);
      parent = child as Record<string, unknown> | Array<unknown>;
    }
    assert(Object.hasOwn(parent, key), `${label}: JSON patch target ${operation.path} is absent`);
    if (operation.op === "set") {
      (parent as Record<string, unknown>)[key] = operation.value;
    } else {
      const current = (parent as Record<string, unknown>)[key];
      assert(typeof current === "string" && /^(0|[1-9][0-9]*)$/.test(current), `${label}: increment target is not decimal`);
      (parent as Record<string, unknown>)[key] = (BigInt(current) + BigInt(operation.delta)).toString();
    }
  }
  return Buffer.from(JSON.stringify(patched));
}

function assertConfiguredFaultResponse(
  fault: E1Fault,
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  expectedOccurrence: number,
  label: string,
): void {
  assert(response.requestId === request.requestId, `${label}: fault response requestId mismatch`);
  if (fault === null) {
    assert(response.fault === null && Number(response.status) === 200, `${label}: pass response was not real HTTP 200`);
    return;
  }
  const mode = String(fault.mode);
  if (mode === "delay") {
    const elapsed = Date.parse(String(response.observedAt)) - Date.parse(String(request.observedAt));
    assert(
      Number.isFinite(elapsed) && elapsed >= Number(fault.delayMs) - 500,
      `${label}: delayed response elapsed ${elapsed} ms, expected ${String(fault.delayMs)} ms`,
    );
    assert(
      response.fault === null || response.fault === "proxy_error",
      `${label}: delayed request ended with unrelated fault ${String(response.fault)}`,
    );
    assert(response.appliedFault === "delay", `${label}: delayed response lost its applied-fault attribution`);
    assert(Number(response.matchedOccurrence) === expectedOccurrence, `${label}: wrong matched delay occurrence`);
    assert(
      request.method === "POST" && request.path === "/v1/offers/validate" &&
        response.method === request.method && response.path === request.path,
      `${label}: delay attribution is not bound to the validation route`,
    );
    if (response.fault === null) {
      assert(Number(response.status) === 200 && typeof response.bodyBase64 === "string", `${label}: delayed endpoint did not return JSON 200`);
      const requestBody = JSON.parse(Buffer.from(String(request.bodyBase64), "base64").toString("utf8")) as {
        offerId?: unknown;
      };
      const verdict = JSON.parse(Buffer.from(response.bodyBase64, "base64").toString("utf8")) as {
        valid?: unknown;
        live?: unknown;
        code?: unknown;
        claimedOfferId?: unknown;
        computedOfferId?: unknown;
      };
      assert(
        verdict.valid === true && verdict.live === true && verdict.code === "VALID" &&
          verdict.claimedOfferId === requestBody.offerId && verdict.computedOfferId === requestBody.offerId,
        `${label}: delayed real endpoint response is not the exact positive offer verdict`,
      );
    } else {
      assert(label === "timeout" && response.fault === "proxy_error" && Number(response.status) === 502,
        `${label}: only the timeout case may terminate as an attributed proxy error`);
    }
    return;
  }
  if (mode === "json-patch") {
    assert(response.fault === "json-patch", `${label}: response did not carry JSON-patch attribution`);
    assert(Number(response.matchedOccurrence) === expectedOccurrence, `${label}: wrong matched JSON-patch occurrence`);
    assert(Number(response.status) === 200 && Number(response.upstreamStatus) === 200, `${label}: JSON patch did not follow real HTTP 200`);
    assert(response.patchId === fault.patchId, `${label}: JSON patch identity mismatch`);
    assert(response.requestBodySha256 === request.bodySha256, `${label}: JSON patch request-body binding mismatch`);
    const operations = fault.operations as E1JsonPatchOperation[];
    const expectedPatchSha = createHash("sha256")
      .update(JSON.stringify({ patchId: fault.patchId, operations }))
      .digest("hex");
    assert(response.patchSha256 === expectedPatchSha, `${label}: JSON patch definition hash mismatch`);
    assert(typeof response.upstreamBodyBase64 === "string", `${label}: fresh upstream JSON body was not retained`);
    const upstream = Buffer.from(response.upstreamBodyBase64, "base64");
    assert(
      response.upstreamBodySha256 === createHash("sha256").update(upstream).digest("hex") &&
        Number(response.upstreamBodyBytes) === upstream.byteLength,
      `${label}: upstream response hash/size evidence mismatch`,
    );
    if (fault.patchId === "stale-state-version") {
      const upstreamVerdict = JSON.parse(upstream.toString("utf8")) as { stateVersion?: unknown };
      assert(BigInt(String(upstreamVerdict.stateVersion)) > 1n, `${label}: stale-state case had no fresh upstream state to downgrade`);
    }
    const expectedBody = applyExpectedJsonPatch(upstream, operations, label);
    assert(
      response.bodySha256 === createHash("sha256").update(expectedBody).digest("hex") &&
        Number(response.bodyBytes) === expectedBody.byteLength &&
        response.bodyBase64 === expectedBody.toString("base64"),
      `${label}: JSON-patched response body mismatch`,
    );
    return;
  }
  assert(response.fault === mode, `${label}: response fault ${String(response.fault)} != ${mode}`);
  assert(Number(response.matchedOccurrence) === expectedOccurrence, `${label}: wrong matched fault occurrence`);
  if (mode === "disconnect") {
    assert(response.status === null, `${label}: disconnect emitted an HTTP status`);
    return;
  }
  assert(Number(response.status) === Number(fault.status ?? 503), `${label}: injected status mismatch`);
  if (mode === "replace") {
    const expectedBody = Buffer.from(String(fault.bodyBase64), "base64");
    assert(
      response.bodySha256 === createHash("sha256").update(expectedBody).digest("hex") &&
        Number(response.bodyBytes) === expectedBody.byteLength,
      `${label}: replacement response body mismatch`,
    );
    if (fault.afterUpstream === true) {
      assert(Number(response.upstreamStatus) === 200, `${label}: replacement did not follow a real endpoint HTTP 200`);
    }
  }
}

async function waitForCaseDrain(
  session: RealE1Session,
  identity: RealE1AcceptanceIdentity,
  afterSequence: number,
  quietMs = 2_000,
  timeoutMs = 90_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let lastFingerprint = "";
  let quietSince = Date.now();
  do {
    const all = await recorderEvents(session as unknown as HarnessSession);
    const requests = validationRequestEvents(all, identity, afterSequence);
    const slice = caseEventSlice(all, identity, afterSequence);
    const fingerprint = slice.map(eventSequence).join(",");
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      quietSince = Date.now();
    }
    const allRequestsTerminal = requests.every((request) => matchingResponse(all, request) !== undefined);
    if (allRequestsTerminal && Date.now() - quietSince >= quietMs) return slice;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`case ${identity.caseName} recorder traffic did not drain`);
}

async function assertNoBatcherTrafficAfter(
  session: RealE1Session,
  startSequence: number,
  label: string,
): Promise<void> {
  const events = await recorderEvents(session as unknown as HarnessSession);
  assert(
    !events.some((event) => eventSequence(event) > startSequence && event.channel === "batcher"),
    `${label}: Path A touched the recorded batcher boundary`,
  );
}

async function readPrivateJson(path: string): Promise<Record<string, unknown>> {
  const value = JSON.parse((await assertPrivateArtifact(path)).toString("utf8"));
  assert(value && typeof value === "object" && !Array.isArray(value), `${path}: JSON is not an object`);
  return value as Record<string, unknown>;
}

function walletBoundaryCalls(runtime: Record<string, unknown>): Record<string, number> {
  const boundaries = runtime.walletBoundaries as { methods?: Record<string, { calls?: unknown }> } | undefined;
  const methods = boundaries?.methods ?? {};
  return Object.fromEntries(
    Object.entries(methods).map(([method, value]) => {
      const calls = Number(value.calls);
      assert(Number.isSafeInteger(calls) && calls >= 0, `${method}: invalid wallet-boundary count`);
      return [method, calls];
    }),
  );
}

function assertNoWalletMutation(runtime: Record<string, unknown>, label: string): Record<string, number> {
  const calls = walletBoundaryCalls(runtime);
  for (const method of [
    "balanceFinalizedTransaction",
    "finalizeRecipe",
    "submitTransaction",
    "revert",
    "transferTransaction",
    "finalizeTransaction",
    "initSwap",
  ]) {
    assert(calls[method] === 0, `${label}: wallet boundary ${method} had ${calls[method] ?? "no"} call(s)`);
  }
  assert(Number(runtime.submissionCount) === 0, `${label}: submission count was not zero`);
  return calls;
}

function assertReleasedStock(runtime: Record<string, unknown>, offerHash: string, label: string): void {
  const stock = runtime.stock as {
    tokens?: Array<{ balance?: unknown; reserved?: unknown; available?: unknown }>;
    offers?: Array<{ offerHash?: unknown; claimed?: unknown }>;
  } | undefined;
  assert(Array.isArray(stock?.tokens), `${label}: terminal Stock token evidence is missing`);
  for (const token of stock!.tokens!) {
    assert(String(token.reserved) === "0", `${label}: terminal token reservation leaked`);
    assert(String(token.available) === String(token.balance), `${label}: available Stock differs from balance`);
  }
  const target = (stock?.offers ?? []).find((offer) => offer.offerHash === offerHash);
  if (target !== undefined) assert(target.claimed === false, `${label}: target offer remains claimed`);
}

async function startRealSolverCase(
  session: RealE1Session,
  identity: RealE1AcceptanceIdentity,
): Promise<string> {
  const containerName = `${session.project}-case-${identity.caseName}`;
  const started = await runCompose(
    session,
    [
      "--profile",
      "acceptance-manual",
      "run",
      "--detach",
      "--no-deps",
      "--name",
      containerName,
      "solver-case",
    ],
    { timeoutMs: 120_000 },
  );
  assert(/^[0-9a-f]{12,64}$/i.test(started.stdout.trim()), `${identity.caseName}: Compose returned no container ID`);
  const envNames = await runCommand(
    "docker",
    ["exec", containerName, "sh", "-c", "env | sed 's/=.*//' | sort"],
    session.children,
    { timeoutMs: 30_000 },
  );
  const names = new Set(lines(envNames.stdout));
  assert(names.has("E1_SOLVER_API") && names.has("E1_SOLVER_AUTH_TOKEN"), `${identity.caseName}: solver backend env is absent`);
  assert(
    ![...names].some((name) => /^(?:CELESTIA|BATCHER|DB_|POSTGRES)/.test(name)),
    `${identity.caseName}: solver received a forbidden upstream/database environment name`,
  );
  const networks = await runCommand(
    "docker",
    ["inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}", containerName],
    session.children,
    { timeoutMs: 30_000 },
  );
  assert(
    JSON.stringify(lines(networks.stdout).sort()) ===
      JSON.stringify([
        `${session.project}_midnight_solver_clients`,
        `${session.project}_solver_front`,
      ].sort()),
    `${identity.caseName}: live solver networks differ from the exact allowlist`,
  );
  return containerName;
}

async function stopRealSolverCase(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  identity: RealE1AcceptanceIdentity,
  containerName: string,
): Promise<string> {
  const exists = await runCommand(
    "docker",
    ["inspect", "--format", "{{.State.Running}}", containerName],
    session.children,
    { allowFailure: true, timeoutMs: 30_000 },
  );
  if (exists.code !== 0) return "";
  if (exists.stdout.trim() === "true") {
    await runCommand(
      "docker",
      ["stop", "--signal", "SIGTERM", "--timeout", "90", containerName],
      session.children,
      { timeoutMs: 120_000 },
    );
  }
  const state = await runCommand(
    "docker",
    ["inspect", "--format", "{{.State.ExitCode}}", containerName],
    session.children,
    { timeoutMs: 30_000 },
  );
  assert(state.stdout.trim() === "143", `${identity.caseName}: solver did not exit through its SIGTERM cleanup path`);
  const logsResult = await runCommand(
    "docker",
    ["logs", "--timestamps", containerName],
    session.children,
    { allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 8 * 1024 * 1024 },
  );
  assert(logsResult.code === 0, `${identity.caseName}: docker logs capture exited ${logsResult.code}`);
  const logs = `${logsResult.stdout}${logsResult.stderr}`;
  assert(Buffer.byteLength(logs) <= 8 * 1024 * 1024, `${identity.caseName}: solver logs exceed 8 MiB`);
  assertNoGeneratedSecrets(`${identity.caseName} solver logs`, logs, config.secrets);
  await runCommand("docker", ["rm", containerName], session.children, { timeoutMs: 30_000 });
  return logs;
}

async function sealRealE1Case(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  identity: RealE1AcceptanceIdentity,
  outputDirectory: string,
  startSequence: number,
  slice: Array<Record<string, unknown>>,
  offerHash: string,
  solverLogs: string,
): Promise<{ evidence: RealE1CaseEvidence; runtime: Record<string, unknown> }> {
  const runtimePath = join(outputDirectory, "solver-runtime.json");
  const telemetryPath = join(outputDirectory, "solver-telemetry.jsonl");
  const runtimeBytes = await assertPrivateArtifact(runtimePath);
  const telemetryBytes = await assertPrivateArtifact(telemetryPath);
  assertNoGeneratedSecrets(`${identity.caseName} runtime`, runtimeBytes.toString("utf8"), config.secrets);
  assertNoGeneratedSecrets(`${identity.caseName} telemetry`, telemetryBytes.toString("utf8"), config.secrets);
  const runtime = JSON.parse(runtimeBytes.toString("utf8")) as Record<string, unknown>;
  assert(runtime.runId === identity.runId && runtime.state === "stopped", `${identity.caseName}: runtime was not cleanly stopped`);
  assert(
    Array.isArray(runtime.evidenceFailures) && runtime.evidenceFailures.length === 0,
    `${identity.caseName}: solver retained evidence failures`,
  );
  const telemetry = lines(telemetryBytes.toString("utf8")).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(telemetry.length > 0, `${identity.caseName}: local telemetry is empty`);
  assert(
    telemetry.every((event, index) => event.runId === identity.runId && Number(event.sequence) === index + 1),
    `${identity.caseName}: local telemetry identity/sequence mismatch`,
  );
  const centralText = `${slice.map((event) => JSON.stringify(event)).join("\n")}\n`;
  assertNoGeneratedSecrets(`${identity.caseName} central slice`, centralText, config.secrets);
  const centralPath = join(outputDirectory, "central-evidence.jsonl");
  await writeFile(centralPath, centralText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const solverLogsBytes = Buffer.from(solverLogs);
  assert(solverLogsBytes.byteLength <= 8 * 1024 * 1024, `${identity.caseName}: solver logs exceed 8 MiB`);
  assertNoGeneratedSecrets(`${identity.caseName} container logs`, solverLogs, config.secrets);
  await writeFile(join(outputDirectory, "solver-container.log"), solverLogsBytes, { mode: 0o600, flag: "wx" });
  const requests = validationRequestEvents(slice, identity, startSequence);
  const calls = walletBoundaryCalls(runtime);
  const endSequence = Math.max(startSequence, ...slice.map(eventSequence));
  const evidenceBase = {
    schema: "zswap-offer-files-real-e1-case/v1",
    caseName: identity.caseName,
    runId: identity.runId,
    offerHash,
    startSequence,
    endSequence,
    validationRequests: requests.length,
    runtimeSha256: createHash("sha256").update(runtimeBytes).digest("hex"),
    telemetrySha256: createHash("sha256").update(telemetryBytes).digest("hex"),
    centralSliceSha256: createHash("sha256").update(centralText).digest("hex"),
    solverExitCode: 143 as const,
    solverLogsSha256: createHash("sha256").update(solverLogsBytes).digest("hex"),
    solverLogsBytes: solverLogsBytes.byteLength,
    submissionCount: Number(runtime.submissionCount),
    walletBoundaryCalls: calls,
  };
  const manifestPath = join(outputDirectory, "case-evidence.json");
  await writeFile(manifestPath, `${JSON.stringify(evidenceBase, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const manifestBytes = await assertPrivateArtifact(manifestPath);
  const evidence: RealE1CaseEvidence = {
    ...evidenceBase,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    solverLogs,
  };
  return { evidence, runtime };
}

function assertValidationRequestBinding(
  request: Record<string, unknown>,
  identity: RealE1AcceptanceIdentity,
  offerHash: string,
  offerBlob: string,
  label: string,
): void {
  const expectedBody = JSON.stringify({
    schemaVersion: 1,
    profile: "offer-files-solver-v1",
    offerId: offerHash,
    offer: offerBlob,
  });
  assert(
    request.bodySha256 === createHash("sha256").update(expectedBody).digest("hex"),
    `${label}: validation request body is not bound to the exact offer`,
  );
  assert(
    eventHeaders(request).authorizationSha256 ===
      createHash("sha256").update(`Bearer ${identity.solverToken}`).digest("hex"),
    `${label}: validation request is not bound to the case credential`,
  );
  assert(typeof request.requestId === "string" && request.requestId.length > 0, `${label}: request ID is absent`);
}

function findPhase(
  events: Array<Record<string, unknown>>,
  identity: RealE1AcceptanceIdentity,
  phase: string,
  name: string,
  afterSequence = 0,
): Record<string, unknown> | undefined {
  return events.find(
    (event) => eventSequence(event) > afterSequence && isPhaseEvent(event, identity.runId, phase, name),
  );
}

function assertNoAdmissionSideEffects(
  events: Array<Record<string, unknown>>,
  identity: RealE1AcceptanceIdentity,
  offerHash: string,
  label: string,
): void {
  for (const [phase, name] of [
    ["validation", "admitted"],
    ["execution", "candidate-selected"],
    ["submission", "post-invocation"],
    ["submission", "succeeded"],
  ] as const) {
    assert(findPhase(events, identity, phase, name) === undefined, `${label}: observed forbidden ${phase}/${name}`);
  }
  assert(
    !events.some(
      (event) => isSolverEvent(event, identity.runId) &&
        (event.phase === "wallet-boundary" || event.phase === "execution-match" ||
          (event.phase === "execution" && event.event !== "candidate-selected")),
    ),
    `${label}: observed a wallet or execution outcome before admission authority`,
  );
  const stockEvents = events.filter(
    (event) => isSolverEvent(event, identity.runId) && event.phase === "stock",
  );
  assert(
    !stockEvents.some((event) => event.event === "execution-start"),
    `${label}: observed a Stock execution-start reservation before admission authority`,
  );
  for (const event of stockEvents) {
    const tokens = Array.isArray(event.tokens) ? event.tokens as Array<Record<string, unknown>> : [];
    for (const token of tokens) {
      assert(String(token.reserved) === "0", `${label}: observed a transient token reservation`);
      assert(String(token.available) === String(token.balance), `${label}: transient Stock availability changed`);
    }
    const offers = Array.isArray(event.offers) ? event.offers as Array<Record<string, unknown>> : [];
    const target = offers.find((offer) => offer.offerHash === offerHash);
    if (target !== undefined) assert(target.claimed === false, `${label}: target offer was transiently claimed`);
  }
}

function stockEvidence(event: Record<string, unknown>, offerHash: string, label: string): {
  target: Record<string, unknown>;
  tokens: Array<Record<string, unknown>>;
} {
  const tokens = Array.isArray(event.tokens) ? event.tokens as Array<Record<string, unknown>> : [];
  const offers = Array.isArray(event.offers) ? event.offers as Array<Record<string, unknown>> : [];
  const target = offers.find((offer) => offer.offerHash === offerHash);
  assert(target !== undefined, `${label}: target offer is absent from Stock evidence`);
  return { target, tokens };
}

async function assertOfferRemainsLive(
  session: RealE1Session,
  offerHash: string,
  offerBlob: string,
): Promise<void> {
  const result = await execAcceptanceJson(
    session,
    `(async()=>{const id=${JSON.stringify(offerHash)};const expected=${JSON.stringify(createHash("sha256").update(offerBlob).digest("hex"))};const detail=await fetch('http://backend-proxy:8080/v1/offers/'+id,{signal:AbortSignal.timeout(15000)});if(detail.status!==200)throw new Error('detail status '+detail.status);const d=await detail.json();if(d.offerId!==id||d.computed?.status!=='live')throw new Error('detail not live');const crypto=await import('node:crypto');if(crypto.createHash('sha256').update(d.offerBech32).digest('hex')!==expected)throw new Error('detail blob changed');const list=await fetch('http://backend-proxy:8080/v1/offers?limit=100',{signal:AbortSignal.timeout(15000)});if(!list.ok)throw new Error('list status '+list.status);const p=await list.json();if(!Array.isArray(p.offers)||!p.offers.some(o=>o.offerId===id&&o.computed?.status==='live'))throw new Error('offer missing from current list');console.log(JSON.stringify({offerId:id,status:'live'}))})().catch(e=>{console.error(e);process.exit(1)})`,
    45_000,
  );
  assert(result.offerId === offerHash && result.status === "live", "backend live-offer assertion returned wrong identity");
}

async function runRealE1RefusalCase(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  descriptor: E1CaseDescriptor,
  positiveVerdict: Record<string, unknown>,
  offer: { offerHash: string; offerBlob: string; expiresAt: string; tokenB: string },
): Promise<RealE1CaseEvidence> {
  assert(descriptor.stage !== "valid", `${descriptor.caseName}: refusal runner received the valid case`);
  const identity = acceptanceIdentity(config, descriptor.caseName);
  assert(
    Date.parse(offer.expiresAt) - Date.now() > 60 * 60_000,
    `${descriptor.caseName}: offer has less than one hour of live budget`,
  );
  const outputDirectory = join(session.files.runtimeDirectory, "solver", "cases", descriptor.caseName);
  const inactiveGarbage = join(session.files.runtimeDirectory, "publication", "inactive-garbage");
  await activateRealE1Identity(
    session,
    config,
    identity,
    outputDirectory,
    { outputDirectory: inactiveGarbage, label: "inactive", rawBase64: "AQ==" },
  );
  const before = await recorderEvents(session as unknown as HarnessSession);
  const startSequence = before.length === 0 ? 0 : eventSequence(before.at(-1)!);
  const configuredFault = descriptor.fault(positiveVerdict, offer.offerHash);
  await setFault(session as unknown as HarnessSession, "backend", configuredFault);
  let containerName = "";
  let solverLogs = "";
  let causalFaultRequestId = "";
  let executionStartSequence: number | undefined;
  let primaryError: unknown;
  try {
    containerName = await startRealSolverCase(session, identity);
    const firstRequest = await waitForRecorderEvent(
      session,
      startSequence,
      `${descriptor.caseName} validation request`,
      (event) => validationRequestEvents([event], identity, startSequence).length === 1,
    );
    assertValidationRequestBinding(firstRequest, identity, offer.offerHash, offer.offerBlob, descriptor.caseName);
    causalFaultRequestId = String(firstRequest.requestId);

    if (descriptor.completion === "held-request") {
      await sleep(2_000);
      const held = caseEventSlice(
        await recorderEvents(session as unknown as HarnessSession),
        identity,
        startSequence,
      );
      assert(matchingResponse(held, firstRequest) === undefined, `${descriptor.caseName}: delayed response completed too early`);
      assertNoAdmissionSideEffects(held, identity, offer.offerHash, descriptor.caseName);
    } else if (descriptor.completion === "negative-verdict") {
      await waitForRecorderEvent(
        session,
        eventSequence(firstRequest),
        `${descriptor.caseName} negative verdict`,
        (event) => isPhaseEvent(event, identity.runId, "validation", "verdict") && event.valid === false,
      );
    } else if (descriptor.completion === "unavailable") {
      await waitForRecorderEvent(
        session,
        eventSequence(firstRequest),
        `${descriptor.caseName} unavailable trace`,
        (event) => isPhaseEvent(event, identity.runId, "validation", "unavailable"),
      );
    } else {
      const candidate = await waitForRecorderEvent(
        session,
        eventSequence(firstRequest),
        `${descriptor.caseName} candidate selection`,
        (event) => isPhaseEvent(event, identity.runId, "execution", "candidate-selected"),
      );
      const executionStart = await waitForRecorderEvent(
        session,
        eventSequence(candidate),
        `${descriptor.caseName} execution validation start`,
        (event) => isPhaseEvent(event, identity.runId, "validation", "execution-start") && event.offerHash === offer.offerHash,
      );
      executionStartSequence = eventSequence(executionStart);
      const preStock = await waitForRecorderEvent(
        session,
        eventSequence(executionStart),
        `${descriptor.caseName} pre-refusal Stock snapshot`,
        (event) => isPhaseEvent(event, identity.runId, "stock", "execution-start"),
      );
      const secondRequest = await waitForRecorderEvent(
        session,
        eventSequence(executionStart),
        `${descriptor.caseName} dequeue validation request`,
        (event) => validationRequestEvents([event], identity, startSequence).length === 1 && event.requestId !== firstRequest.requestId,
      );
      causalFaultRequestId = String(secondRequest.requestId);
      assertValidationRequestBinding(secondRequest, identity, offer.offerHash, offer.offerBlob, descriptor.caseName);
      const secondResponse = await waitForRecorderEvent(
        session,
        eventSequence(secondRequest),
        `${descriptor.caseName} dequeue validation response`,
        (event) => event.channel === "backend" && event.phase === "response" && event.requestId === secondRequest.requestId,
      );
      const outcome = await waitForRecorderEvent(
        session,
        eventSequence(secondResponse),
        `${descriptor.caseName} release outcome`,
        (event) => isSolverEvent(event, identity.runId) && event.phase === "execution" && event.claimDisposition === "release",
      );
      const postStock = await waitForRecorderEvent(
        session,
        eventSequence(outcome),
        `${descriptor.caseName} released Stock snapshot`,
        (event) => isPhaseEvent(event, identity.runId, "stock", "post-outcome"),
      );
      const reserved = stockEvidence(preStock, offer.offerHash, `${descriptor.caseName} pre-refusal`);
      assert(reserved.target.claimed === true, `${descriptor.caseName}: offer was not claimed before dequeue refusal`);
      assert(
        reserved.tokens.some((token) => token.token === offer.tokenB && BigInt(String(token.reserved)) > 0n),
        `${descriptor.caseName}: target payout token was not reserved before dequeue refusal`,
      );
      assert(eventSequence(preStock) < eventSequence(secondResponse), `${descriptor.caseName}: pre-refusal Stock was not captured before refusal`);
      const released = stockEvidence(postStock, offer.offerHash, `${descriptor.caseName} post-refusal`);
      assert(released.target.claimed === false, `${descriptor.caseName}: offer claim was not released`);
      assert(released.tokens.every((token) => String(token.reserved) === "0"), `${descriptor.caseName}: reservation leaked after refusal`);
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    if (containerName) solverLogs = await stopRealSolverCase(session, config, identity, containerName);
  } catch (error) {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], `${descriptor.caseName} work and solver stop failed`);
  }

  let slice: Array<Record<string, unknown>> = [];
  try {
    slice = await waitForCaseDrain(session, identity, startSequence);
  } catch (error) {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], `${descriptor.caseName} work and traffic drain failed`);
  }
  await setFault(session as unknown as HarnessSession, "backend", null).catch((error) => {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], `${descriptor.caseName} work and fault reset failed`);
  });
  if (primaryError !== undefined) throw primaryError;
  await assertNoBatcherTrafficAfter(session, startSequence, descriptor.caseName);

  const requests = validationRequestEvents(slice, identity, startSequence);
  for (const request of requests) {
    assertValidationRequestBinding(request, identity, offer.offerHash, offer.offerBlob, descriptor.caseName);
    assert(matchingResponse(slice, request) !== undefined, `${descriptor.caseName}: validation request has no terminal response`);
  }
  assert(requests.length >= (descriptor.stage === "dequeue" ? 2 : 1), `${descriptor.caseName}: too few bound validation requests`);
  const faultedRequest = requests.find((request) => request.requestId === causalFaultRequestId);
  assert(faultedRequest !== undefined, `${descriptor.caseName}: causally captured fault request is absent after drain`);
  if (descriptor.stage === "dequeue") {
    assert(executionStartSequence !== undefined, `${descriptor.caseName}: execution-start sequence was not retained`);
    assert(
      requests.filter((request) => eventSequence(request) < executionStartSequence!).length === 1 &&
        eventSequence(faultedRequest) > executionStartSequence,
      `${descriptor.caseName}: occurrence 2 was not the first dequeue validation after exactly one admission request`,
    );
  }
  assertConfiguredFaultResponse(
    configuredFault,
    faultedRequest,
    matchingResponse(slice, faultedRequest)!,
    descriptor.stage === "dequeue" ? 2 : 1,
    descriptor.caseName,
  );
  if (descriptor.stage === "dequeue") {
    assert(
      findPhase(slice, identity, "validation", "execution-valid") === undefined,
      `${descriptor.caseName}: dequeue refusal emitted execution-valid`,
    );
  }
  if (descriptor.completion === "negative-verdict" || descriptor.caseName === "dequeue-domain-invalid") {
    const negative = slice.find(
      (event) => isPhaseEvent(event, identity.runId, "validation", "verdict") &&
        event.valid === false && event.code === "ROOT_UNKNOWN",
    );
    assert(negative !== undefined, `${descriptor.caseName}: canonical ROOT_UNKNOWN negative verdict was not observed`);
    assert(
      findPhase(slice, identity, "validation", "unavailable") === undefined,
      `${descriptor.caseName}: canonical domain refusal was masked as validation unavailable`,
    );
  }
  if (descriptor.caseName === "stale-state-version") {
    const generation = slice.find(
      (event) => isPhaseEvent(event, identity.runId, "validation", "drain-start") &&
        event.generation && typeof event.generation === "object",
    )?.generation as { backendBlockL2?: unknown } | undefined;
    const floor = BigInt(String(generation?.backendBlockL2));
    const response = matchingResponse(slice, faultedRequest)!;
    const upstream = JSON.parse(Buffer.from(String(response.upstreamBodyBase64), "base64").toString("utf8")) as {
      stateVersion?: unknown;
    };
    const patched = JSON.parse(Buffer.from(String(response.bodyBase64), "base64").toString("utf8")) as {
      stateVersion?: unknown;
    };
    assert(
      floor > 1n && BigInt(String(upstream.stateVersion)) >= floor && BigInt(String(patched.stateVersion)) === 1n && 1n < floor,
      `${descriptor.caseName}: patched state was not below the same-run active backend L2 floor`,
    );
    const unavailable = findPhase(slice, identity, "validation", "unavailable");
    assert(
      typeof unavailable?.reason === "string" && unavailable.reason.includes("below active backend L2 floor"),
      `${descriptor.caseName}: stale state did not exercise the generation-floor refusal`,
    );
  }
  if (descriptor.stage === "admission") {
    assertNoAdmissionSideEffects(slice, identity, offer.offerHash, descriptor.caseName);
  }
  const sealed = await sealRealE1Case(
    session,
    config,
    identity,
    outputDirectory,
    startSequence,
    slice,
    offer.offerHash,
    solverLogs,
  );
  if (descriptor.stage === "dequeue") {
    const localTelemetry = lines(
      (await assertPrivateArtifact(join(outputDirectory, "solver-telemetry.jsonl"))).toString("utf8"),
    ).map((line) => JSON.parse(line) as { kind?: unknown; data?: { kind?: unknown } });
    assert(
      !localTelemetry.some((event) => event.kind === "validation-trace" && event.data?.kind === "execution-valid"),
      `${descriptor.caseName}: local telemetry emitted execution-valid`,
    );
  }
  const calls = assertNoWalletMutation(sealed.runtime, descriptor.caseName);
  assertReleasedStock(sealed.runtime, offer.offerHash, descriptor.caseName);
  assert(JSON.stringify(calls) === JSON.stringify(sealed.evidence.walletBoundaryCalls), `${descriptor.caseName}: sealed call counts changed`);
  await assertOfferRemainsLive(session, offer.offerHash, offer.offerBlob);
  return sealed.evidence;
}

interface RealE1ValidCaseResult {
  evidence: RealE1CaseEvidence;
  runtime: Record<string, unknown>;
  outputDirectory: string;
  slice: Array<Record<string, unknown>>;
  transactionHash: string;
  protocolFeeSpecks: string;
}

async function waitForBackendConsumed(session: RealE1Session, offerHash: string): Promise<void> {
  const result = await execAcceptanceJson(
    session,
    `(async()=>{const id=${JSON.stringify(offerHash)};const end=Date.now()+300000;for(;;){const r=await fetch('http://backend-proxy:8080/v1/offers/'+id+'/status',{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});if(r.status!==200)throw new Error('status '+r.status+' '+await r.text());const body=await r.json();if(body.offerId!==id)throw new Error('status identity mismatch');if(body.status==='consumed'){console.log(JSON.stringify(body));return}if(!['live','not_found'].includes(body.status))throw new Error('unexpected status '+body.status);if(Date.now()>=end)throw new Error('offer was not consumed');await new Promise(resolve=>setTimeout(resolve,1000))}})().catch(e=>{console.error(e);process.exit(1)})`,
    330_000,
  );
  assert(result.offerId === offerHash && result.status === "consumed", "backend did not retain consumed finality");
}

async function runRealE1ValidCase(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  offer: { offerHash: string; offerBlob: string; expiresAt: string; tokenB: string },
): Promise<RealE1ValidCaseResult> {
  const descriptor = E1_CASE_MATRIX.find((candidate) => candidate.caseName === "valid-fill")!;
  const identity = acceptanceIdentity(config, descriptor.caseName);
  assert(
    Date.parse(offer.expiresAt) - Date.now() > 60 * 60_000,
    "valid-fill: offer has less than one hour of live budget",
  );
  const outputDirectory = join(session.files.runtimeDirectory, "solver", "cases", descriptor.caseName);
  const inactiveGarbage = join(session.files.runtimeDirectory, "publication", "inactive-garbage");
  await activateRealE1Identity(
    session,
    config,
    identity,
    outputDirectory,
    { outputDirectory: inactiveGarbage, label: "inactive", rawBase64: "AQ==" },
  );
  await setFault(session as unknown as HarnessSession, "backend", null);
  const before = await recorderEvents(session as unknown as HarnessSession);
  const startSequence = before.length === 0 ? 0 : eventSequence(before.at(-1)!);
  let containerName = "";
  let solverLogs = "";
  let primaryError: unknown;
  let firstRequest!: Record<string, unknown>;
  let firstResponse!: Record<string, unknown>;
  let firstVerdict!: Record<string, unknown>;
  let admitted!: Record<string, unknown>;
  let candidate!: Record<string, unknown>;
  let executionStart!: Record<string, unknown>;
  let preStock!: Record<string, unknown>;
  let secondRequest!: Record<string, unknown>;
  let secondResponse!: Record<string, unknown>;
  let secondVerdict!: Record<string, unknown>;
  let executionValid!: Record<string, unknown>;
  let balanceStarted!: Record<string, unknown>;
  let finalizeStarted!: Record<string, unknown>;
  let submissionStarted!: Record<string, unknown>;
  let submissionSucceeded!: Record<string, unknown>;
  let settled!: Record<string, unknown>;
  let postStock!: Record<string, unknown>;
  try {
    containerName = await startRealSolverCase(session, identity);
    firstRequest = await waitForRecorderEvent(
      session,
      startSequence,
      "valid-fill admission validation request",
      (event) => validationRequestEvents([event], identity, startSequence).length === 1,
      600_000,
    );
    assertValidationRequestBinding(firstRequest, identity, offer.offerHash, offer.offerBlob, "valid-fill admission");
    firstResponse = await waitForRecorderEvent(
      session,
      eventSequence(firstRequest),
      "valid-fill admission validation response",
      (event) => event.channel === "backend" && event.phase === "response" && event.requestId === firstRequest.requestId,
    );
    assertConfiguredFaultResponse(null, firstRequest, firstResponse, 1, "valid-fill admission");
    firstVerdict = await waitForRecorderEvent(
      session,
      eventSequence(firstResponse),
      "valid-fill admission VALID verdict",
      (event) => isPhaseEvent(event, identity.runId, "validation", "verdict") &&
        event.offerHash === offer.offerHash && event.valid === true && event.code === "VALID",
    );
    admitted = await waitForRecorderEvent(
      session,
      eventSequence(firstVerdict),
      "valid-fill admission",
      (event) => isPhaseEvent(event, identity.runId, "validation", "admitted") && event.offerHash === offer.offerHash,
    );
    candidate = await waitForRecorderEvent(
      session,
      eventSequence(admitted),
      "valid-fill candidate selection",
      (event) => isPhaseEvent(event, identity.runId, "execution", "candidate-selected") &&
        typeof event.message === "string" &&
        event.message.startsWith(`[solver]     FILL (A) ${offer.offerHash.slice(0, 10)} at posted `),
    );
    executionStart = await waitForRecorderEvent(
      session,
      eventSequence(candidate),
      "valid-fill execution validation start",
      (event) => isPhaseEvent(event, identity.runId, "validation", "execution-start") && event.offerHash === offer.offerHash,
    );
    preStock = await waitForRecorderEvent(
      session,
      eventSequence(executionStart),
      "valid-fill reserved Stock snapshot",
      (event) => isPhaseEvent(event, identity.runId, "stock", "execution-start"),
    );
    const reserved = stockEvidence(preStock, offer.offerHash, "valid-fill pre-execution");
    assert(reserved.target.claimed === true, "valid-fill: offer was not claimed before wallet mutation");
    assert(
      reserved.tokens.some((token) => token.token === offer.tokenB && BigInt(String(token.reserved)) > 0n),
      "valid-fill: payout inventory was not reserved before wallet mutation",
    );
    secondRequest = await waitForRecorderEvent(
      session,
      eventSequence(executionStart),
      "valid-fill dequeue validation request",
      (event) => validationRequestEvents([event], identity, startSequence).length === 1 &&
        event.requestId !== firstRequest.requestId,
    );
    assertValidationRequestBinding(secondRequest, identity, offer.offerHash, offer.offerBlob, "valid-fill dequeue");
    secondResponse = await waitForRecorderEvent(
      session,
      eventSequence(secondRequest),
      "valid-fill dequeue validation response",
      (event) => event.channel === "backend" && event.phase === "response" && event.requestId === secondRequest.requestId,
    );
    assertConfiguredFaultResponse(null, secondRequest, secondResponse, 2, "valid-fill dequeue");
    secondVerdict = await waitForRecorderEvent(
      session,
      eventSequence(secondResponse),
      "valid-fill dequeue VALID verdict",
      (event) => isPhaseEvent(event, identity.runId, "validation", "verdict") &&
        event.offerHash === offer.offerHash && event.valid === true && event.code === "VALID",
    );
    executionValid = await waitForRecorderEvent(
      session,
      eventSequence(secondVerdict),
      "valid-fill execution-valid authority",
      (event) => isPhaseEvent(event, identity.runId, "validation", "execution-valid") && event.offerHash === offer.offerHash,
    );
    balanceStarted = await waitForRecorderEvent(
      session,
      eventSequence(executionValid),
      "valid-fill balanceFinalizedTransaction boundary",
      (event) => isPhaseEvent(event, identity.runId, "wallet-boundary", "balanceFinalizedTransaction-post-invocation"),
      600_000,
    );
    finalizeStarted = await waitForRecorderEvent(
      session,
      eventSequence(balanceStarted),
      "valid-fill finalizeRecipe boundary",
      (event) => isPhaseEvent(event, identity.runId, "wallet-boundary", "finalizeRecipe-post-invocation"),
      600_000,
    );
    submissionStarted = await waitForRecorderEvent(
      session,
      eventSequence(finalizeStarted),
      "valid-fill submit post-invocation",
      (event) => isPhaseEvent(event, identity.runId, "submission", "post-invocation"),
      600_000,
    );
    submissionSucceeded = await waitForRecorderEvent(
      session,
      eventSequence(submissionStarted),
      "valid-fill submit success",
      (event) => isPhaseEvent(event, identity.runId, "submission", "succeeded"),
      600_000,
    );
    settled = await waitForRecorderEvent(
      session,
      eventSequence(submissionSucceeded),
      "valid-fill settled outcome",
      (event) => isPhaseEvent(event, identity.runId, "execution", "settled") &&
        event.offerHash === offer.offerHash && event.claimDisposition === "release",
      600_000,
    );
    postStock = await waitForRecorderEvent(
      session,
      eventSequence(settled),
      "valid-fill released Stock snapshot",
      (event) => isPhaseEvent(event, identity.runId, "stock", "post-outcome"),
    );
    const released = stockEvidence(postStock, offer.offerHash, "valid-fill post-outcome");
    assert(released.target.claimed === false, "valid-fill: offer claim was not released after confirmed settlement");
    assert(released.tokens.every((token) => String(token.reserved) === "0"), "valid-fill: inventory reservation leaked");
    await waitForBackendConsumed(session, offer.offerHash);
  } catch (error) {
    primaryError = error;
  }

  try {
    if (containerName) solverLogs = await stopRealSolverCase(session, config, identity, containerName);
  } catch (error) {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], "valid-fill work and solver stop failed");
  }
  let slice: Array<Record<string, unknown>> = [];
  try {
    slice = await waitForCaseDrain(session, identity, startSequence, 5_000, 120_000);
  } catch (error) {
    primaryError = primaryError === undefined
      ? error
      : new AggregateError([primaryError, error], "valid-fill work and traffic drain failed");
  }
  if (primaryError !== undefined) throw primaryError;
  await assertNoBatcherTrafficAfter(session, startSequence, "valid-fill");

  const requests = validationRequestEvents(slice, identity, startSequence);
  assert(requests.length === 2, `valid-fill: expected exactly two validation requests, got ${requests.length}`);
  assert(
    requests.filter((request) => eventSequence(request) < eventSequence(executionStart)).length === 1 &&
      requests[0]?.requestId === firstRequest.requestId && requests[1]?.requestId === secondRequest.requestId,
    "valid-fill: admission/dequeue requests are not causally unique and ordered",
  );
  assert(
    eventSequence(firstRequest) < eventSequence(firstResponse) &&
      eventSequence(firstResponse) < eventSequence(firstVerdict) &&
      eventSequence(firstVerdict) < eventSequence(admitted) &&
      eventSequence(admitted) < eventSequence(candidate) &&
      eventSequence(candidate) < eventSequence(executionStart) &&
      eventSequence(executionStart) < eventSequence(preStock) &&
      eventSequence(preStock) < eventSequence(secondRequest) &&
      eventSequence(secondRequest) < eventSequence(secondResponse) &&
      eventSequence(secondResponse) < eventSequence(secondVerdict) &&
      eventSequence(secondVerdict) < eventSequence(executionValid) &&
      eventSequence(executionValid) < eventSequence(balanceStarted) &&
      eventSequence(balanceStarted) < eventSequence(finalizeStarted) &&
      eventSequence(finalizeStarted) < eventSequence(submissionStarted) &&
      eventSequence(submissionStarted) < eventSequence(submissionSucceeded) &&
      eventSequence(submissionSucceeded) < eventSequence(settled) &&
      eventSequence(settled) < eventSequence(postStock),
    "valid-fill: authoritative validation/wallet/submission/settlement order is not total",
  );
  const firstWalletBoundary = slice.find(
    (event) => isSolverEvent(event, identity.runId) && event.phase === "wallet-boundary",
  );
  assert(firstWalletBoundary?.event === "balanceFinalizedTransaction-post-invocation", "valid-fill: unexpected first wallet mutation");
  const candidates = slice.filter(
    (event) => isPhaseEvent(event, identity.runId, "execution", "candidate-selected"),
  );
  assert(
    candidates.length === 1 && candidates[0]?.message === candidate.message,
    "valid-fill: target Path-A candidate was not the unique selected candidate",
  );
  assert(!slice.some((event) => isPhaseEvent(event, identity.runId, "submission", "failed")), "valid-fill: submit failure was recorded");

  const sealed = await sealRealE1Case(
    session,
    config,
    identity,
    outputDirectory,
    startSequence,
    slice,
    offer.offerHash,
    solverLogs,
  );
  const calls = walletBoundaryCalls(sealed.runtime);
  const expectedCalls: Record<string, number> = {
    balanceFinalizedTransaction: 1,
    finalizeRecipe: 1,
    submitTransaction: 1,
    revert: 0,
    transferTransaction: 0,
    finalizeTransaction: 0,
    initSwap: 0,
  };
  assert(JSON.stringify(calls) === JSON.stringify(expectedCalls), `valid-fill: wrong Path-A wallet matrix ${JSON.stringify(calls)}`);
  assert(Number(sealed.runtime.submissionCount) === 1, "valid-fill: submission count is not exactly one");
  assertReleasedStock(sealed.runtime, offer.offerHash, "valid-fill");
  const lastSubmission = sealed.runtime.lastSubmission as {
    count?: unknown;
    transactionHash?: unknown;
    protocolFee?: { asset?: unknown; specks?: unknown; source?: unknown; transactionHash?: unknown };
    inspectionErrors?: unknown;
  } | undefined;
  const transactionHash = String(lastSubmission?.transactionHash ?? "").replace(/^0x/i, "").toLowerCase();
  const protocolFeeSpecks = String(lastSubmission?.protocolFee?.specks ?? "");
  assert(
    lastSubmission?.count === 1 && /^[0-9a-f]{64}$/.test(transactionHash) &&
      lastSubmission.protocolFee?.asset === "DUST" && /^[1-9][0-9]*$/.test(protocolFeeSpecks) &&
      lastSubmission.protocolFee.source === "wallet.calculateTransactionFee" &&
      String(lastSubmission.protocolFee.transactionHash).replace(/^0x/i, "").toLowerCase() === transactionHash &&
      Array.isArray(lastSubmission.inspectionErrors) && lastSubmission.inspectionErrors.length === 0,
    "valid-fill: submitted transaction/exact protocol-fee evidence is malformed",
  );
  const lastOutcome = sealed.runtime.lastSubmissionOutcome as { kind?: unknown; count?: unknown } | undefined;
  assert(lastOutcome?.kind === "succeeded" && lastOutcome.count === 1, "valid-fill: runtime has no exact submit success");
  return {
    evidence: sealed.evidence,
    runtime: sealed.runtime,
    outputDirectory,
    slice,
    transactionHash,
    protocolFeeSpecks,
  };
}

interface RealInvalidCorpusResult {
  evidence: Array<{ label: string; payloadSha256: string; evidenceSha256: string }>;
  payloadHashes: string[];
  artifactBytes: Buffer[];
  publishedThroughSequence: number;
}

async function waitForInvalidBlobAbsence(
  session: RealE1Session,
  payloadSha256: string,
  celestiaHeight: number,
): Promise<Record<string, unknown>> {
  return execAcceptanceJson(
    session,
    `(async()=>{const id=${JSON.stringify(payloadSha256)};const height=${celestiaHeight};const end=Date.now()+300000;let stable=0;for(;;){const health=await fetch('http://backend-proxy:8080/v1/health/sync',{signal:AbortSignal.timeout(15000)});if(!health.ok)throw new Error('health '+health.status);const h=await health.json();const current=Number(h.celestia?.current);if(Number.isFinite(current)&&current>=height){const detail=await fetch('http://backend-proxy:8080/v1/offers/'+id,{signal:AbortSignal.timeout(15000)});let cursor=null;const seen=new Set();let pages=0;for(;;){const suffix=cursor===null?'':'&after_hash='+encodeURIComponent(cursor);const list=await fetch('http://backend-proxy:8080/v1/offers?limit=100'+suffix,{signal:AbortSignal.timeout(15000)});if(!list.ok)throw new Error('list '+list.status);const p=await list.json();if(!Array.isArray(p.offers)||!(p.nextCursor===null||typeof p.nextCursor==='string'))throw new Error('malformed paginated list');for(const offer of p.offers){if(typeof offer.offerId!=='string'||seen.has(offer.offerId))throw new Error('duplicate/malformed paginated offer');seen.add(offer.offerId)}pages++;if(p.nextCursor===null)break;if(pages>=1000||p.nextCursor===cursor)throw new Error('pagination did not terminate');cursor=p.nextCursor}if(detail.status===404&&!seen.has(id)){stable++;if(stable===3){console.log(JSON.stringify({offerId:id,celestiaHeight:height,backendCurrent:current,pages,listedOffers:seen.size,status:'absent'}));return}}else{stable=0}}if(Date.now()>=end)throw new Error('invalid blob became visible or backend did not pass height');await new Promise(resolve=>setTimeout(resolve,1000))}})().catch(e=>{console.error(e);process.exit(1)})`,
    330_000,
  );
}

async function publishRealInvalidBlob(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  label: string,
  rawBase64: string,
  expectedSha256: string,
): Promise<{ summary: { label: string; payloadSha256: string; evidenceSha256: string }; bytes: Buffer }> {
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(label), `invalid publication label ${label}`);
  const bytes = Buffer.from(rawBase64, "base64");
  assert(
    bytes.byteLength > 0 && bytes.byteLength <= 1024 * 1024 && bytes.toString("base64") === rawBase64,
    `${label}: invalid raw Base64`,
  );
  assert(createHash("sha256").update(bytes).digest("hex") === expectedSha256, `${label}: payload hash mismatch`);
  const actorManifestBytes = await assertPrivateArtifact(
    join(session.files.runtimeDirectory, "actor", "actor-manifest.json"),
  );
  const actorManifest = JSON.parse(actorManifestBytes.toString("utf8")) as { offer?: { offerHash?: unknown } };
  const beforeEvents = await recorderEvents(session as unknown as HarnessSession);
  const startSequence = beforeEvents.length === 0 ? 0 : eventSequence(beforeEvents.at(-1)!);
  const outputDirectory = join(session.files.runtimeDirectory, "publication", "invalid", label);
  assert(!(await pathExists(outputDirectory)), `${label}: publication output already exists`);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeRealE1ActiveEnvironment(
    session,
    config,
    acceptanceIdentity(config, "boot"),
    join(session.files.runtimeDirectory, "solver", "boot"),
    { outputDirectory, label, rawBase64 },
  );
  await runAcceptanceOneShot(
    session,
    config,
    "garbage-publisher",
    join(outputDirectory, "garbage-publisher.log"),
    180_000,
  );
  const evidencePath = join(outputDirectory, "garbage-publication.json");
  const evidenceBytes = await assertPrivateArtifact(evidencePath);
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as {
    schema?: unknown;
    runId?: unknown;
    mode?: unknown;
    actorManifest?: { sha256?: unknown; offerHash?: unknown };
    payload?: {
      source?: unknown;
      sha256?: unknown;
      byteLength?: unknown;
      dataBase64?: unknown;
      garbageLabel?: unknown;
    };
    celestia?: { submittedHeight?: unknown };
    verification?: {
      exactMatchesAtHeight?: unknown;
      observedByteLength?: unknown;
      observedSha256?: unknown;
      getByCommitmentSha256?: unknown;
    };
  };
  assert(
    evidence.schema === "zswap-offer-files-real-celestia-publication/v1" &&
      evidence.runId === config.runId &&
      evidence.mode === "garbage" &&
      evidence.actorManifest?.sha256 === createHash("sha256").update(actorManifestBytes).digest("hex") &&
      evidence.actorManifest?.offerHash === actorManifest.offer?.offerHash &&
      evidence.payload?.source === "explicit-raw-garbage-base64" &&
      evidence.payload?.sha256 === expectedSha256 &&
      evidence.payload?.garbageLabel === label &&
      Number(evidence.payload.byteLength) === bytes.byteLength &&
      evidence.payload.dataBase64 === rawBase64 &&
      evidence.verification?.exactMatchesAtHeight === 1 &&
      Number(evidence.verification.observedByteLength) === bytes.byteLength &&
      evidence.verification.observedSha256 === expectedSha256 &&
      evidence.verification.getByCommitmentSha256 === expectedSha256,
    `${label}: publisher evidence identity mismatch`,
  );
  const publisherTraffic = (await recorderEvents(session as unknown as HarnessSession)).filter(
    (event) => eventSequence(event) > startSequence && event.channel === "publisher-celestia",
  );
  assert(
    publisherTraffic.some(
      (event) => event.phase === "request" && event.method === "POST" && event.path === "/",
    ) && publisherTraffic.every(
      (event) => event.phase !== "request" || (event.method === "POST" && event.path === "/"),
    ),
    `${label}: publisher traffic escaped the exact Celestia JSON-RPC method/path boundary`,
  );
  const height = Number(evidence.celestia?.submittedHeight);
  assert(Number.isSafeInteger(height) && height > 0, `${label}: publisher returned no canonical height`);
  const absence = await waitForInvalidBlobAbsence(session, expectedSha256, height);
  assert(absence.status === "absent" && absence.offerId === expectedSha256, `${label}: backend absence was not proved`);
  return {
    summary: {
      label,
      payloadSha256: expectedSha256,
      evidenceSha256: createHash("sha256").update(evidenceBytes).digest("hex"),
    },
    bytes: evidenceBytes,
  };
}

async function prepareRealInvalidCorpus(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  actorManifest: Record<string, unknown>,
): Promise<RealInvalidCorpusResult> {
  await runAcceptanceOneShot(
    session,
    config,
    "invalid-fixture-generator",
    join(session.files.runtimeDirectory, "invalid", "invalid-fixture-generator.log"),
    180_000,
  );
  const generatedPath = join(session.files.runtimeDirectory, "invalid", "invalid-fixtures.json");
  const preSpentPath = join(session.files.runtimeDirectory, "actor", "pre-spent-liveness.json");
  const generatedBytes = await assertPrivateArtifact(generatedPath);
  const preSpentBytes = await assertPrivateArtifact(preSpentPath);
  const generated = JSON.parse(generatedBytes.toString("utf8")) as {
    schema?: unknown;
    runId?: unknown;
    preSpentLiveness?: {
      artifactSha256?: unknown;
      offerHash?: unknown;
      rawBase64?: unknown;
      bytes?: unknown;
    };
    proofInvalid?: { rawBase64?: unknown; sha256?: unknown; localCryptoVerdict?: unknown };
    arbitraryGarbage?: { rawBase64?: unknown; sha256?: unknown; nulBytes?: unknown };
  };
  const preSpent = JSON.parse(preSpentBytes.toString("utf8")) as {
    schema?: unknown;
    runId?: unknown;
    networkId?: unknown;
    offerBlob?: unknown;
    rawBase64?: unknown;
    offerHash?: unknown;
    inputNullifiers?: unknown;
    consumingFundingTxHash?: unknown;
    sourceValidation?: { crypto?: unknown };
  };
  assert(
    generated.schema === "zswap-offer-files-real-invalid-fixtures/v1" && generated.runId === config.runId,
    "generated invalid fixture artifact identity mismatch",
  );
  assert(
    ["PROOF_INVALID", "SIGNATURE_INVALID"].includes(String(generated.proofInvalid?.localCryptoVerdict)),
    "proof-invalid fixture did not fail the production crypto boundary",
  );
  assert(generated.arbitraryGarbage?.nulBytes === 0, "arbitrary garbage contains a NUL byte");
  assert(
    preSpent.schema === "zswap-offer-files-real-pre-spent-liveness/v1" &&
      preSpent.runId === config.runId &&
      preSpent.networkId === "undeployed" &&
      preSpent.sourceValidation?.crypto === "verify" &&
      Array.isArray(preSpent.inputNullifiers) && preSpent.inputNullifiers.length === 1,
    "pre-spent liveness artifact identity/crypto evidence mismatch",
  );
  const preSpentRaw = Buffer.from(String(preSpent.rawBase64 ?? ""), "base64");
  assert(
    typeof preSpent.offerBlob === "string" &&
      preSpentRaw.byteLength > 0 &&
      preSpentRaw.toString("base64") === preSpent.rawBase64 &&
      Buffer.from(OfferFiles.decode(preSpent.offerBlob)).equals(preSpentRaw) &&
      createHash("sha256").update(preSpentRaw).digest("hex") === preSpent.offerHash &&
      generated.preSpentLiveness?.artifactSha256 === createHash("sha256").update(preSpentBytes).digest("hex") &&
      generated.preSpentLiveness?.offerHash === preSpent.offerHash &&
      generated.preSpentLiveness?.rawBase64 === preSpent.rawBase64 &&
      Number(generated.preSpentLiveness?.bytes) === preSpentRaw.byteLength,
    "pre-spent liveness bech32/raw/hash/generator binding mismatch",
  );
  const funding = actorManifest.funding as {
    tokenFundingTransactions?: Array<{ token?: unknown; hash?: unknown; identifiers?: unknown }>;
  } | undefined;
  const tokenAFundingRows = funding?.tokenFundingTransactions?.filter((row) => row.token === "A") ?? [];
  const tokenAFunding = tokenAFundingRows[0];
  assert(
    tokenAFundingRows.length === 1 && tokenAFunding?.hash === preSpent.consumingFundingTxHash &&
      Array.isArray(tokenAFunding.identifiers) &&
      (preSpent.inputNullifiers as unknown[]).every((value) => tokenAFunding.identifiers!.includes(value)),
    "pre-spent offer is not bound to the exact consuming token-A funding transaction",
  );
  const inputs = [
    {
      label: "arbitrary-garbage",
      rawBase64: String(generated.arbitraryGarbage?.rawBase64 ?? ""),
      sha256: String(generated.arbitraryGarbage?.sha256 ?? ""),
    },
    {
      label: "proof-invalid",
      rawBase64: String(generated.proofInvalid?.rawBase64 ?? ""),
      sha256: String(generated.proofInvalid?.sha256 ?? ""),
    },
    {
      label: "nullifier-spent-liveness-invalid",
      rawBase64: String(preSpent.rawBase64 ?? ""),
      sha256: String(preSpent.offerHash ?? ""),
    },
  ];
  const liveOfferHash = String((actorManifest.offer as { offerHash?: unknown } | undefined)?.offerHash ?? "");
  assert(
    new Set(inputs.map((input) => input.sha256)).size === inputs.length &&
      inputs.every((input) => input.sha256 !== liveOfferHash),
    "invalid corpus payload hashes alias each other or the live offer",
  );
  const evidence: RealInvalidCorpusResult["evidence"] = [];
  const publicationBytes: Buffer[] = [];
  for (const input of inputs) {
    assert(/^[0-9a-f]{64}$/.test(input.sha256), `${input.label}: non-canonical payload hash`);
    const published = await publishRealInvalidBlob(
      session,
      config,
      input.label,
      input.rawBase64,
      input.sha256,
    );
    evidence.push(published.summary);
    publicationBytes.push(published.bytes);
  }
  const events = await recorderEvents(session as unknown as HarnessSession);
  return {
    evidence,
    payloadHashes: inputs.map((input) => input.sha256),
    artifactBytes: [generatedBytes, preSpentBytes, ...publicationBytes],
    publishedThroughSequence: events.length === 0 ? 0 : eventSequence(events.at(-1)!),
  };
}

function assertInvalidCorpusNeverReachedSolver(
  events: Array<Record<string, unknown>>,
  corpus: RealInvalidCorpusResult,
  liveOfferHash: string,
): void {
  const afterPublication = events.filter((event) => eventSequence(event) > corpus.publishedThroughSequence);
  const firstSolverEvent = afterPublication.find((event) => event.channel === "solver-validation");
  assert(firstSolverEvent !== undefined, "invalid-corpus gate observed no real solver traffic");
  for (const invalidHash of corpus.payloadHashes) {
    assert(
      !afterPublication.some(
        (event) => event.channel === "backend" && event.phase === "request" &&
          typeof event.path === "string" &&
          (event.path === `/v1/offers/${invalidHash}` || event.path === `/v1/offers/${invalidHash}/status`),
      ),
      `solver/control traffic fetched invalid offer detail ${invalidHash}`,
    );
    assert(
      !afterPublication.some(
        (event) => event.channel === "solver-validation" &&
          JSON.stringify(event).includes(invalidHash.slice(0, 10)),
      ),
      `invalid offer ${invalidHash} reached solver validation/selection telemetry`,
    );
  }
  const validationRequests = afterPublication.filter(
    (event) => event.channel === "backend" && event.phase === "request" &&
      event.method === "POST" && event.path === "/v1/offers/validate",
  );
  assert(validationRequests.length > 0, "matrix emitted no validation requests after invalid-corpus publication");
  for (const request of validationRequests) {
    assert(typeof request.bodyBase64 === "string", "validation request body was not retained for corpus exclusion");
    const body = JSON.parse(Buffer.from(request.bodyBase64, "base64").toString("utf8")) as { offerId?: unknown };
    assert(body.offerId === liveOfferHash, `validation request selected non-live-corpus offer ${String(body.offerId)}`);
  }
}

async function runRealSettlementVerifiers(
  session: RealE1Session,
  config: RealE1AcceptanceConfig,
  valid: RealE1ValidCaseResult,
  actorManifestBytes: Buffer,
  publicationBytes: Buffer,
  offerHash: string,
): Promise<{ walletBytes: Buffer; backendBytes: Buffer; walletSha256: string; backendSha256: string }> {
  await runAcceptanceOneShot(
    session,
    config,
    "settlement-verifier",
    join(session.files.runtimeDirectory, "wallet-settlement", "settlement-verifier.log"),
    900_000,
  );
  const walletPath = join(session.files.runtimeDirectory, "wallet-settlement", "settlement-evidence.json");
  const walletRuntimePath = join(session.files.runtimeDirectory, "wallet-settlement", "settlement-runtime.json");
  const walletBytes = await assertPrivateArtifact(walletPath);
  const walletRuntimeBytes = await assertPrivateArtifact(walletRuntimePath);
  const wallet = JSON.parse(walletBytes.toString("utf8")) as {
    schema?: unknown;
    runId?: unknown;
    finality?: { source?: unknown; requiredStableObservations?: unknown; observations?: unknown };
    netDustBalanceDelta?: {
      actor?: unknown;
      asset?: unknown;
      before?: unknown;
      after?: unknown;
      delta?: unknown;
      interpretation?: unknown;
    };
  };
  assert(
    wallet.schema === "zswap-offer-files-real-settlement-balances/v1" && wallet.runId === config.runId &&
      wallet.finality?.source === "wallet-facade-strict-sync" &&
      wallet.finality.requiredStableObservations === 3 &&
      Array.isArray(wallet.finality.observations) && wallet.finality.observations.length === 3 &&
      wallet.netDustBalanceDelta?.actor === "solver" && wallet.netDustBalanceDelta.asset === "DUST" &&
      wallet.netDustBalanceDelta.interpretation === "net-balance-delta-not-exact-fee" &&
      /^-?(?:0|[1-9][0-9]*)$/.test(String(wallet.netDustBalanceDelta.delta)) &&
      BigInt(String(wallet.netDustBalanceDelta.after)) - BigInt(String(wallet.netDustBalanceDelta.before)) ===
        BigInt(String(wallet.netDustBalanceDelta.delta)),
    "wallet settlement evidence is not the strict three-observation A/B+DUST oracle",
  );
  const walletRuntime = JSON.parse(walletRuntimeBytes.toString("utf8")) as { state?: unknown; operation?: unknown };
  assert(walletRuntime.state === "complete" && walletRuntime.operation === "verify-settlement", "wallet settlement verifier did not close cleanly");

  await runAcceptanceOneShot(
    session,
    config,
    "backend-settlement-verifier",
    join(session.files.runtimeDirectory, "backend-settlement", "backend-settlement-verifier.log"),
    420_000,
  );
  const backendPath = join(
    session.files.runtimeDirectory,
    "backend-settlement",
    "backend-settlement-evidence.json",
  );
  const backendBytes = await assertPrivateArtifact(backendPath);
  const backend = JSON.parse(backendBytes.toString("utf8")) as {
    schema?: unknown;
    runId?: unknown;
    sources?: {
      actor?: { sha256?: unknown };
      solver?: { sha256?: unknown };
      publication?: { sha256?: unknown };
    };
    offer?: { offerHash?: unknown; backendStatus?: unknown; archiveReason?: unknown };
    settlement?: {
      transactionHash?: unknown;
      distinctMarkerTransactionHashes?: unknown;
      solver?: {
        canonicalTransactionHash?: unknown;
        submissionCount?: unknown;
        submitBoundaryCalls?: unknown;
        protocolFee?: { asset?: unknown; specks?: unknown; source?: unknown };
      };
    };
  };
  const validRuntimeBytes = await assertPrivateArtifact(join(valid.outputDirectory, "solver-runtime.json"));
  assert(
    backend.schema === "zswap-offer-files-real-backend-settlement/v1" && backend.runId === config.runId &&
      backend.sources?.actor?.sha256 === createHash("sha256").update(actorManifestBytes).digest("hex") &&
      backend.sources?.solver?.sha256 === createHash("sha256").update(validRuntimeBytes).digest("hex") &&
      backend.sources?.publication?.sha256 === createHash("sha256").update(publicationBytes).digest("hex") &&
      backend.offer?.offerHash === offerHash,
    "backend settlement sources are not bound to the sealed actor/solver/publication artifacts",
  );
  const settlement = backend.settlement;
  assert(
    backend.offer?.backendStatus === "consumed" && backend.offer.archiveReason === "CONSUMED" &&
      String(settlement?.transactionHash).replace(/^0x/i, "").toLowerCase() === valid.transactionHash &&
      String(settlement?.solver?.canonicalTransactionHash).replace(/^0x/i, "").toLowerCase() === valid.transactionHash &&
      settlement?.solver?.submissionCount === 1 && settlement.solver.submitBoundaryCalls === 1 &&
      settlement.solver.protocolFee?.asset === "DUST" &&
      settlement.solver.protocolFee.specks === valid.protocolFeeSpecks &&
      settlement.solver.protocolFee.source === "wallet.calculateTransactionFee" &&
      Array.isArray(settlement.distinctMarkerTransactionHashes) &&
      settlement.distinctMarkerTransactionHashes.length === 1 &&
      String(settlement.distinctMarkerTransactionHashes[0]).replace(/^0x/i, "").toLowerCase() === valid.transactionHash,
    "backend settlement did not prove one identity-bound Path-A transaction and exact protocol fee",
  );
  return {
    walletBytes,
    backendBytes,
    walletSha256: createHash("sha256").update(walletBytes).digest("hex"),
    backendSha256: createHash("sha256").update(backendBytes).digest("hex"),
  };
}

async function runRealE1ServiceBootstrap(): Promise<RealE1ServiceBootResult> {
  const session = await createRealE1Session(await reserveRandomPort(new Set()));
  let config: RealE1AcceptanceConfig | undefined;
  let cleanup!: RealE1CleanupEvidence;
  try {
    config = await configureRealE1AcceptanceSession(session);
    assert(!handlingSignal, "real E1 acceptance construction completed after a termination signal");
    await prepareGeneratedSecretBoundary(session);
    await assertAcceptanceComposeIsManualSafe(session);
    await buildRealE1Images(session);
    const [appImage, celestiaImage, selfChecks] = await Promise.all([
      inspectRealE1Image(
        session,
        session.appImage,
        session.files.appImageId,
        "arm64",
        session.files.appDockerfile,
        REAL_E1_APP_IMAGE_LABELS,
      ),
      inspectRealE1Image(
        session,
        session.celestiaImage,
        session.files.celestiaImageId,
        "amd64",
        session.files.celestiaDockerfile,
        REAL_E1_CELESTIA_IMAGE_LABELS,
      ),
      assertRealE1ImageSelfChecks(session),
    ]);
    await assertGeneratedSecretsAbsentFromBuiltImages(session);
    await runCompose(
      session,
      [
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "1200",
        "backend-proxy",
        "telemetry-relay",
        "publisher-celestia-proxy",
        "solver-isolation-probe",
      ],
      { timeoutMs: 1_260_000 },
    );

    for (const service of [
      "actor-provisioner",
      "offer-publisher",
      "invalid-fixture-generator",
      "garbage-publisher",
      "solver-case",
      "settlement-verifier",
      "backend-settlement-verifier",
    ]) {
      const inactive = await runCompose(session, ["ps", "--all", "--quiet", service], { timeoutMs: 30_000 });
      assert(inactive.stdout.trim() === "", `${service}: manual service auto-started during base boot`);
    }
    await assertFailureDiagnosticsAreSecretFree(session, "telemetry-relay", config.secrets);

    const deploymentPath = join(
      session.files.runtimeDirectory,
      "deployment",
      "contract-offer-files.undeployed.json",
    );
    const deploymentChecksumPath = join(
      session.files.runtimeDirectory,
      "deployment",
      "contract-offer-files.undeployed.sha256",
    );
    const deploymentBytes = await assertPrivateArtifact(deploymentPath);
    const deploymentSha256 = createHash("sha256").update(deploymentBytes).digest("hex");
    const deploymentChecksum = (await assertPrivateArtifact(deploymentChecksumPath)).toString("utf8");
    assert(
      deploymentChecksum === `${deploymentSha256}  contract-offer-files.undeployed.json\n`,
      "sealed contract deployment checksum mismatch",
    );
    await assertPrivateArtifact(join(session.files.runtimeDirectory, "control", "boot-solver-token"));

    const backendHealth = await execAcceptanceJson(
      session,
      `(async()=>{const r=await fetch('http://backend-proxy:8080/v1/health/sync',{signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok||v.status!=='ok'||!v.blockL2||v.midnight?.current==null||v.midnight?.tip==null||v.celestia?.current==null||v.celestia?.tip==null)throw new Error('backend not current '+JSON.stringify(v));console.log(JSON.stringify(v))})().catch(e=>{console.error(e);process.exit(1)})`,
      30_000,
    );
    const initialNtpBoundary = await assertRealE1NtpBoundary(session);
    const databaseBootstrap = await assertRealE1DatabaseBootstrap(session);

    await runAcceptanceOneShot(
      session,
      config,
      "actor-provisioner",
      join(session.files.runtimeDirectory, "actor", "actor-provisioner.log"),
      900_000,
    );
    const actorManifestPath = join(session.files.runtimeDirectory, "actor", "actor-manifest.json");
    const ladderPath = join(session.files.runtimeDirectory, "actor", "solver-ladder.json");
    const preSpentPath = join(session.files.runtimeDirectory, "actor", "pre-spent-liveness.json");
    const actorManifestBytes = await assertPrivateArtifact(actorManifestPath);
    const ladderBytes = await assertPrivateArtifact(ladderPath);
    const preSpentBytes = await assertPrivateArtifact(preSpentPath);
    const actorManifest = JSON.parse(actorManifestBytes.toString("utf8")) as {
      schema?: unknown;
      runId?: unknown;
      networkId?: unknown;
      offer?: { offerHash?: unknown; offerBlob?: unknown };
      ladder?: { sha256?: unknown };
    };
    assert(actorManifest.runId === config.runId, "actor manifest is not bound to the acceptance run");
    assert(actorManifest.networkId === "undeployed", "actor manifest has the wrong Midnight network");
    const offerHash = String(actorManifest.offer?.offerHash ?? "");
    const offerBlob = String(actorManifest.offer?.offerBlob ?? "");
    assert(/^[0-9a-f]{64}$/.test(offerHash) && offerBlob.length > 0, "actor manifest has no canonical offer");
    const ladderSha256 = createHash("sha256").update(ladderBytes).digest("hex");
    assert(actorManifest.ladder?.sha256 === ladderSha256, "actor manifest ladder hash mismatch");

    await runAcceptanceOneShot(
      session,
      config,
      "offer-publisher",
      join(session.files.runtimeDirectory, "publication", "offer-publisher.log"),
      180_000,
    );
    const publicationPath = join(session.files.runtimeDirectory, "publication", "offer-publication.json");
    const publicationBytes = await assertPrivateArtifact(publicationPath);
    const publication = JSON.parse(publicationBytes.toString("utf8")) as {
      runId?: unknown;
      mode?: unknown;
      actorManifest?: { offerHash?: unknown; sha256?: unknown };
      payload?: { sha256?: unknown };
      verification?: { exactMatchesAtHeight?: unknown; getByCommitmentSha256?: unknown };
    };
    assert(publication.runId === config.runId && publication.mode === "offer", "publication evidence identity mismatch");
    assert(
      publication.actorManifest?.offerHash === offerHash &&
        publication.actorManifest?.sha256 === createHash("sha256").update(actorManifestBytes).digest("hex") &&
        publication.payload?.sha256 === offerHash &&
        publication.verification?.exactMatchesAtHeight === 1 &&
        publication.verification?.getByCommitmentSha256 === offerHash,
      "publication evidence is not byte/hash/commitment bound to the actor offer",
    );

    const indexedOffer = await execAcceptanceJson(
      session,
      `(async()=>{const fs=await import('node:fs/promises');const a=JSON.parse(await fs.readFile('/inputs/actor/actor-manifest.json','utf8'));const url='http://backend-proxy:8080/v1/offers/'+a.offer.offerHash;const end=Date.now()+300000;for(;;){const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(r.status===200){const v=await r.json();if(v.offerId!==a.offer.offerHash||v.offerBech32!==a.offer.offerBlob)throw new Error('indexed detail identity mismatch');console.log(JSON.stringify(v));return}if(r.status!==404)throw new Error('offer detail returned '+r.status+' '+await r.text());if(Date.now()>=end)throw new Error('offer was not indexed before deadline');await new Promise(resolve=>setTimeout(resolve,2000))}})().catch(e=>{console.error(e);process.exit(1)})`,
      330_000,
    );

    const validationVerdict = await execAcceptanceJson(
      session,
      `(async()=>{const fs=await import('node:fs/promises');const a=JSON.parse(await fs.readFile('/inputs/actor/actor-manifest.json','utf8'));const token=(await fs.readFile('/run/e1-control/boot-solver-token','utf8')).trim();if(!token)throw new Error('validation credential missing');const url='http://backend-proxy:8080/v1/offers/validate';const body=JSON.stringify({schemaVersion:1,profile:'offer-files-solver-v1',offerId:a.offer.offerHash,offer:a.offer.offerBlob});const end=Date.now()+300000;for(;;){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','accept':'application/json','authorization':'Bearer '+token},body,signal:AbortSignal.timeout(45000)});if(r.status!==200)throw new Error('validate returned '+r.status+' '+await r.text());const v=await r.json();if(v.valid===true&&v.live===true&&v.code==='VALID'&&v.claimedOfferId===a.offer.offerHash&&v.computedOfferId===a.offer.offerHash){console.log(JSON.stringify(v));return}if(Date.now()>=end)throw new Error('offer did not become valid before deadline '+JSON.stringify(v));await new Promise(resolve=>setTimeout(resolve,2000))}})().catch(e=>{console.error(e);process.exit(1)})`,
      360_000,
    );
    await rm(join(session.files.runtimeDirectory, "control", "boot-solver-token"));

    assert(
      (await assertPrivateArtifact(actorManifestPath)).equals(actorManifestBytes),
      "actor manifest changed after its read-only handoffs",
    );
    assert(
      (await assertPrivateArtifact(ladderPath)).equals(ladderBytes),
      "solver ladder changed after its read-only handoffs",
    );
    assert(
      (await assertPrivateArtifact(preSpentPath)).equals(preSpentBytes),
      "pre-spent liveness authority changed after its read-only handoffs",
    );
    assert(
      createHash("sha256").update(await assertPrivateArtifact(deploymentPath)).digest("hex") === deploymentSha256,
      "contract deployment changed after its read-only handoffs",
    );
    const runtimeEntries = await readdir(session.files.runtimeDirectory, { withFileTypes: true });
    assert(
      JSON.stringify(runtimeEntries.map((entry) => entry.name).sort()) ===
        JSON.stringify([
          "actor",
          "backend-settlement",
          "control",
          "deployment",
          "invalid",
          "publication",
          "solver",
          "wallet-settlement",
        ]),
      "acceptance runtime root contains an unexpected entry",
    );
    for (const entry of runtimeEntries) {
      assert(entry.isDirectory(), `acceptance runtime root contains a non-directory entry: ${entry.name}`);
      const metadata = await stat(join(session.files.runtimeDirectory, entry.name));
      assert((metadata.mode & 0o777) === 0o700, `acceptance runtime directory ${entry.name} is not mode 0700`);
    }

    await assertRealE1DatabaseBootstrapStillExact(session, databaseBootstrap);
    const runtimeHardening = await assertRealE1RuntimeHardening(session, true);
    const { ntpBoundary, events } = await captureRealE1FinalNtpEvidence(session, initialNtpBoundary);
    assert(
      events.every((event, index) => Number(event.sequence) === index + 1),
      "acceptance bootstrap recorder sequence is not globally monotonic",
    );
    assert(events.some((event) => event.channel === "publisher-celestia" && event.phase === "request"), "publisher boundary was not recorded");
    assert(events.some((event) => event.channel === "backend-celestia" && event.phase === "request"), "backend Celestia discovery was not recorded");
    assert(
      events.some(
        (event) =>
          event.channel === "backend" &&
          event.phase === "request" &&
          event.method === "POST" &&
          event.path === "/v1/offers/validate",
      ),
      "real backend validation call was not recorded",
    );
    assert(
      !events.some(
        (event) =>
          event.channel === "backend" &&
          event.phase === "request" &&
          event.method === "POST" &&
          event.path === "/v1/offers",
      ),
      "acceptance bootstrap bypassed Celestia through POST /v1/offers",
    );
    assert(!events.some((event) => event.channel === "batcher"), "Path-A bootstrap touched the batcher boundary");

    const artifacts = await captureRealE1Artifacts(session);
    for (const [label, bytes] of [
      ["contract deployment", deploymentBytes],
      ["contract deployment checksum", Buffer.from(deploymentChecksum)],
      ["actor manifest", actorManifestBytes],
      ["solver ladder", ladderBytes],
      ["pre-spent liveness", preSpentBytes],
      ["publication evidence", publicationBytes],
    ] as const) {
      assertNoGeneratedSecrets(`real E1 ${label}`, bytes.toString("utf8"), config.secrets);
    }
    assertNoGeneratedSecrets(
      "real E1 service evidence",
      JSON.stringify({
        events,
        backendHealth,
        ntpBoundary,
        databaseBootstrap,
        indexedOffer,
        validationVerdict,
        runtimeHardening,
        artifacts,
      }),
      config.secrets,
    );
    const runtimeArtifacts = await assertRuntimeTreeSecretFree(
      session,
      config.secrets,
      "real E1 service success runtime",
    );
    cleanup = await session.cleanup();
    assertCleanup({
      project: session.project,
      recorderPort: session.recorderPort,
      eventCount: events.length,
      channels: [...new Set(events.map((event) => String(event.channel)))],
      testError: null,
      diagnosticsSha256: null,
      cleanup,
    });
    assert(cleanup.retainedImageTags.length === 0, `${session.project}: retained generated image tags`);
    assert(cleanup.retainedImageIds.length === 0, `${session.project}: retained generated image IDs`);
    assert(cleanup.retainedSelfCheckContainers.length === 0, `${session.project}: retained self-check containers`);
    return {
      project: session.project,
      recorderPort: session.recorderPort,
      status: "SERVICES_PASS",
      e1Gate: "OPEN",
      scenarioStatus: "BOOTSTRAP_ONLY",
      appImage,
      celestiaImage,
      toolVersions: selfChecks.toolVersions,
      packageManifestHashes: {
        app: selfChecks.packageManifests.app.sha256,
        celestia: selfChecks.packageManifests.celestia.sha256,
      },
      backendHealth,
      ntpBoundary,
      databaseBootstrap,
      actor: {
        offerHash,
        manifestSha256: createHash("sha256").update(actorManifestBytes).digest("hex"),
        ladderSha256,
      },
      publication: { evidenceSha256: createHash("sha256").update(publicationBytes).digest("hex") },
      indexedOffer,
      validationVerdict,
      eventCount: events.length,
      artifacts,
      cleanup,
      oneShotLogs: config.oneShotLogs.map((entry) => ({ ...entry })),
      runtimeArtifacts,
      runtimeHardening,
    };
  } catch (error) {
    let safeError = error instanceof Error ? error : new Error(String(error));
    if (config !== undefined) {
      try {
        assertNoGeneratedSecrets("real E1 service failure", safeError.message, config.secrets);
        await rm(join(session.files.runtimeDirectory, "control", "boot-solver-token"), { force: true });
        await assertRuntimeTreeSecretFree(session, config.secrets, "real E1 service failure runtime");
      } catch (secretError) {
        safeError = secretError instanceof Error ? secretError : new Error("real E1 service secret scan failed");
      }
    }
    try {
      await reportRealE1FailureProofLog(
        session as unknown as HarnessSession,
        config?.secrets ?? [],
      );
    } catch (proofError) {
      const proofMessage = proofError instanceof Error ? proofError.message : String(proofError);
      if (config !== undefined) {
        assertNoGeneratedSecrets("real E1 proof-only diagnostic failure", proofMessage, config.secrets);
      }
      console.error(`real E1 proof-only diagnostic capture failed: ${proofMessage}`);
    }
    try {
      const summary = await captureRealE1ServiceFailureSummary(
        session as unknown as HarnessSession,
        safeError,
      );
      if (config !== undefined) {
        assertNoGeneratedSecrets("real E1 selected failure summary", summary, config.secrets);
      }
      const summaryBytes = Buffer.from(summary);
      console.error(
        `\n[real E1 selected failure summary bytes=${summaryBytes.byteLength} sha256=${createHash("sha256").update(summaryBytes).digest("hex")}]\n${summary}`,
      );
    } catch (summaryError) {
      const summaryMessage = summaryError instanceof Error ? summaryError.message : String(summaryError);
      try {
        if (config !== undefined) {
          assertNoGeneratedSecrets("real E1 selected diagnostic failure", summaryMessage, config.secrets);
        }
        console.error(`real E1 selected service diagnostic capture failed: ${summaryMessage}`);
      } catch (secretError) {
        safeError = secretError instanceof Error ? secretError : new Error("real E1 selected diagnostic secret scan failed");
        console.error("real E1 selected service diagnostics suppressed because a generated secret was detected");
      }
    }
    try {
      const diagnostics = await captureDiagnostics(session as unknown as HarnessSession);
      if (config !== undefined) assertNoGeneratedSecrets("real E1 service diagnostics", diagnostics, config.secrets);
      const diagnosticBytes = Buffer.from(diagnostics);
      console.error(
        `\n[real E1 service diagnostics captured and secret-scanned before teardown bytes=${diagnosticBytes.byteLength} sha256=${createHash("sha256").update(diagnosticBytes).digest("hex")}]`,
      );
    } catch (diagnosticError) {
      const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      try {
        if (config !== undefined) {
          assertNoGeneratedSecrets("real E1 diagnostic failure", diagnosticMessage, config.secrets);
        }
        console.error(`real E1 service diagnostic capture failed: ${diagnosticMessage}`);
      } catch (secretError) {
        safeError = secretError instanceof Error ? secretError : new Error("real E1 diagnostic secret scan failed");
        console.error("real E1 service diagnostics suppressed because a generated secret was detected");
      }
    }
    cleanup = await session.cleanup();
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        [safeError, ...cleanup.errors.map((message) => new Error(message))],
        "real E1 service bootstrap and cleanup both failed",
      );
    }
    throw safeError;
  }
}

async function runRealE1Acceptance(): Promise<RealE1AcceptanceResult> {
  const session = await createRealE1Session(await reserveRandomPort(new Set()));
  let config: RealE1AcceptanceConfig | undefined;
  let cleanup!: RealE1CleanupEvidence;
  try {
    config = await configureRealE1AcceptanceSession(session);
    assert(!handlingSignal, "real E1 scenario construction completed after a termination signal");
    await prepareGeneratedSecretBoundary(session);
    await assertAcceptanceComposeIsManualSafe(session);
    await buildRealE1Images(session);
    const [appImage, celestiaImage, selfChecks] = await Promise.all([
      inspectRealE1Image(
        session,
        session.appImage,
        session.files.appImageId,
        "arm64",
        session.files.appDockerfile,
        REAL_E1_APP_IMAGE_LABELS,
      ),
      inspectRealE1Image(
        session,
        session.celestiaImage,
        session.files.celestiaImageId,
        "amd64",
        session.files.celestiaDockerfile,
        REAL_E1_CELESTIA_IMAGE_LABELS,
      ),
      assertRealE1ImageSelfChecks(session),
    ]);
    await assertGeneratedSecretsAbsentFromBuiltImages(session);
    await runCompose(
      session,
      [
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "1200",
        "backend-proxy",
        "telemetry-relay",
        "publisher-celestia-proxy",
        "solver-isolation-probe",
      ],
      { timeoutMs: 1_260_000 },
    );
    for (const service of [
      "actor-provisioner",
      "offer-publisher",
      "invalid-fixture-generator",
      "garbage-publisher",
      "solver-case",
      "settlement-verifier",
      "backend-settlement-verifier",
    ]) {
      const inactive = await runCompose(session, ["ps", "--all", "--quiet", service], { timeoutMs: 30_000 });
      assert(inactive.stdout.trim() === "", `${service}: manual service auto-started during scenario base boot`);
    }
    await assertFailureDiagnosticsAreSecretFree(session, "telemetry-relay", config.secrets);

    const deploymentPath = join(
      session.files.runtimeDirectory,
      "deployment",
      "contract-offer-files.undeployed.json",
    );
    const deploymentChecksumPath = join(
      session.files.runtimeDirectory,
      "deployment",
      "contract-offer-files.undeployed.sha256",
    );
    const deploymentBytes = await assertPrivateArtifact(deploymentPath);
    const deploymentSha256 = createHash("sha256").update(deploymentBytes).digest("hex");
    const deploymentChecksumBytes = await assertPrivateArtifact(deploymentChecksumPath);
    assert(
      deploymentChecksumBytes.toString("utf8") === `${deploymentSha256}  contract-offer-files.undeployed.json\n`,
      "scenario sealed contract deployment checksum mismatch",
    );
    const bootIdentity = acceptanceIdentity(config, "boot");
    const bootTokenPath = join(session.files.runtimeDirectory, "control", "boot-solver-token");
    const bootTokenBytes = await assertPrivateArtifact(bootTokenPath);
    assert(bootTokenBytes.toString("utf8") === bootIdentity.solverToken, "boot validation token handoff mismatch");
    const backendHealth = await execAcceptanceJson(
      session,
      `(async()=>{const r=await fetch('http://backend-proxy:8080/v1/health/sync',{signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok||v.status!=='ok'||!v.blockL2||v.midnight?.current==null||v.midnight?.tip==null||v.celestia?.current==null||v.celestia?.tip==null)throw new Error('backend not current '+JSON.stringify(v));console.log(JSON.stringify(v))})().catch(e=>{console.error(e);process.exit(1)})`,
      30_000,
    );
    const initialNtpBoundary = await assertRealE1NtpBoundary(session);
    const databaseBootstrap = await assertRealE1DatabaseBootstrap(session);

    await runAcceptanceOneShot(
      session,
      config,
      "actor-provisioner",
      join(session.files.runtimeDirectory, "actor", "actor-provisioner.log"),
      900_000,
    );
    const actorManifestPath = join(session.files.runtimeDirectory, "actor", "actor-manifest.json");
    const ladderPath = join(session.files.runtimeDirectory, "actor", "solver-ladder.json");
    const preSpentPath = join(session.files.runtimeDirectory, "actor", "pre-spent-liveness.json");
    const actorManifestBytes = await assertPrivateArtifact(actorManifestPath);
    const ladderBytes = await assertPrivateArtifact(ladderPath);
    const preSpentBytes = await assertPrivateArtifact(preSpentPath);
    const actorManifest = JSON.parse(actorManifestBytes.toString("utf8")) as {
      schema?: unknown;
      runId?: unknown;
      networkId?: unknown;
      tokens?: { B?: unknown };
      offer?: { offerHash?: unknown; offerBlob?: unknown; expiresAt?: unknown };
      ladder?: { sha256?: unknown };
    };
    const offerHash = String(actorManifest.offer?.offerHash ?? "");
    const offerBlob = String(actorManifest.offer?.offerBlob ?? "");
    const expiresAt = String(actorManifest.offer?.expiresAt ?? "");
    const tokenB = String(actorManifest.tokens?.B ?? "").toLowerCase();
    assert(
      actorManifest.schema === "zswap-offer-files-real-actors/v1" &&
        actorManifest.runId === config.runId && actorManifest.networkId === "undeployed" &&
        /^[0-9a-f]{64}$/.test(offerHash) && offerBlob.length > 0 &&
        /^[0-9a-f]{64}$/.test(tokenB) && Number.isFinite(Date.parse(expiresAt)) &&
        Date.parse(expiresAt) - Date.now() > 60 * 60_000,
      "actor manifest does not contain the live shielded A-to-B scenario oracle",
    );
    assert(
      createHash("sha256").update(OfferFiles.decode(offerBlob)).digest("hex") === offerHash,
      "actor offer blob is not bound to its content hash",
    );
    assert(
      actorManifest.ladder?.sha256 === createHash("sha256").update(ladderBytes).digest("hex"),
      "actor solver ladder is not hash-bound",
    );

    await runAcceptanceOneShot(
      session,
      config,
      "offer-publisher",
      join(session.files.runtimeDirectory, "publication", "offer-publisher.log"),
      180_000,
    );
    const publicationPath = join(session.files.runtimeDirectory, "publication", "offer-publication.json");
    const publicationBytes = await assertPrivateArtifact(publicationPath);
    const publication = JSON.parse(publicationBytes.toString("utf8")) as {
      schema?: unknown;
      runId?: unknown;
      mode?: unknown;
      actorManifest?: { offerHash?: unknown; sha256?: unknown };
      payload?: { source?: unknown; sha256?: unknown; dataBase64?: unknown };
      verification?: {
        exactMatchesAtHeight?: unknown;
        observedSha256?: unknown;
        getByCommitmentSha256?: unknown;
      };
    };
    assert(
      publication.schema === "zswap-offer-files-real-celestia-publication/v1" &&
        publication.runId === config.runId && publication.mode === "offer" &&
        publication.actorManifest?.offerHash === offerHash &&
        publication.actorManifest.sha256 === createHash("sha256").update(actorManifestBytes).digest("hex") &&
        publication.payload?.source === "actor-manifest.offer.offerBlob" &&
        publication.payload.sha256 === offerHash &&
        publication.payload.dataBase64 === Buffer.from(OfferFiles.decode(offerBlob)).toString("base64") &&
        publication.verification?.exactMatchesAtHeight === 1 &&
        publication.verification.observedSha256 === offerHash &&
        publication.verification.getByCommitmentSha256 === offerHash,
      "valid offer publication is not byte/hash/Celestia-readback bound",
    );

    await execAcceptanceJson(
      session,
      `(async()=>{const id=${JSON.stringify(offerHash)};const blobHash=${JSON.stringify(createHash("sha256").update(offerBlob).digest("hex"))};const crypto=await import('node:crypto');const end=Date.now()+300000;for(;;){const r=await fetch('http://backend-proxy:8080/v1/offers/'+id,{signal:AbortSignal.timeout(15000)});if(r.status===200){const v=await r.json();if(v.offerId!==id||crypto.createHash('sha256').update(v.offerBech32).digest('hex')!==blobHash||v.computed?.status!=='live')throw new Error('indexed detail mismatch');console.log(JSON.stringify({offerId:id,status:'live'}));return}if(r.status!==404)throw new Error('detail '+r.status+' '+await r.text());if(Date.now()>=end)throw new Error('offer was not indexed');await new Promise(resolve=>setTimeout(resolve,1000))}})().catch(e=>{console.error(e);process.exit(1)})`,
      330_000,
    );
    const positiveVerdict = await execAcceptanceJson(
      session,
      `(async()=>{const fs=await import('node:fs/promises');const a=JSON.parse(await fs.readFile('/inputs/actor/actor-manifest.json','utf8'));const token=(await fs.readFile('/run/e1-control/boot-solver-token','utf8')).trim();const body=JSON.stringify({schemaVersion:1,profile:'offer-files-solver-v1',offerId:a.offer.offerHash,offer:a.offer.offerBlob});const end=Date.now()+300000;for(;;){const r=await fetch('http://backend-proxy:8080/v1/offers/validate',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','authorization':'Bearer '+token},body,signal:AbortSignal.timeout(45000)});if(r.status!==200)throw new Error('validate '+r.status+' '+await r.text());const v=await r.json();if(v.valid===true&&v.live===true&&v.code==='VALID'&&v.claimedOfferId===a.offer.offerHash&&v.computedOfferId===a.offer.offerHash){console.log(JSON.stringify(v));return}if(Date.now()>=end)throw new Error('offer did not validate '+JSON.stringify(v));await new Promise(resolve=>setTimeout(resolve,1000))}})().catch(e=>{console.error(e);process.exit(1)})`,
      360_000,
    );
    assert((await assertPrivateArtifact(bootTokenPath)).equals(bootTokenBytes), "boot token changed during use");
    await rm(bootTokenPath);
    assert(!(await pathExists(bootTokenPath)), "boot token remained after its last consumer");

    const invalidCorpus = await prepareRealInvalidCorpus(session, config, actorManifest as Record<string, unknown>);
    const cases: RealE1CaseEvidence[] = [];
    for (const descriptor of E1_CASE_MATRIX) {
      if (descriptor.stage === "valid") continue;
      cases.push(await runRealE1RefusalCase(
        session,
        config,
        descriptor,
        positiveVerdict,
        { offerHash, offerBlob, expiresAt, tokenB },
      ));
    }
    const valid = await runRealE1ValidCase(
      session,
      config,
      { offerHash, offerBlob, expiresAt, tokenB },
    );
    cases.push(valid.evidence);
    assert(
      JSON.stringify(cases.map((entry) => entry.caseName)) === JSON.stringify(E1_CASE_MATRIX.map((entry) => entry.caseName)),
      "E1 case evidence is incomplete or out of order",
    );
    assert(new Set(cases.map((entry) => entry.runId)).size === cases.length, "E1 cases reused a run identity");

    const settlement = await runRealSettlementVerifiers(
      session,
      config,
      valid,
      actorManifestBytes,
      publicationBytes,
      offerHash,
    );
    await assertRealE1DatabaseBootstrapStillExact(session, databaseBootstrap);
    const runtimeHardening = await assertRealE1RuntimeHardening(session, true);
    const { ntpBoundary, events } = await captureRealE1FinalNtpEvidence(session, initialNtpBoundary);
    assert(events.every((event, index) => eventSequence(event) === index + 1), "E1 global recorder sequence is not total");
    assertInvalidCorpusNeverReachedSolver(events, invalidCorpus, offerHash);
    assert(!events.some((event) => event.channel === "batcher"), "E1 Path A touched the batcher boundary");
    assert(
      !events.some(
        (event) => event.channel === "backend" && event.phase === "request" &&
          event.method === "POST" && event.path === "/v1/offers",
      ),
      "E1 bypassed Celestia through POST /v1/offers",
    );
    assert(
      events.some((event) => event.channel === "publisher-celestia" && event.phase === "request") &&
        events.some((event) => event.channel === "backend-celestia" && event.phase === "request"),
      "E1 lacks recorded publisher/backend Celestia boundaries",
    );
    assert(
      (await assertPrivateArtifact(actorManifestPath)).equals(actorManifestBytes) &&
        (await assertPrivateArtifact(ladderPath)).equals(ladderBytes) &&
        (await assertPrivateArtifact(preSpentPath)).equals(preSpentBytes) &&
        (await assertPrivateArtifact(publicationPath)).equals(publicationBytes) &&
        createHash("sha256").update(await assertPrivateArtifact(deploymentPath)).digest("hex") === deploymentSha256,
      "sealed deployment/actor/publication authority changed across the E1 matrix",
    );
    for (const bytes of invalidCorpus.artifactBytes) {
      assertNoGeneratedSecrets("E1 invalid-corpus sealed artifact", bytes.toString("utf8"), config.secrets);
    }
    const artifacts = await captureRealE1Artifacts(session);
    const runtimeArtifacts = await assertRuntimeTreeSecretFree(
      session,
      config.secrets,
      "real E1 acceptance success runtime",
    );
    const publicResult = {
      backendHealth,
      ntpBoundary,
      databaseBootstrap,
      offerHash,
      invalidCorpus: invalidCorpus.evidence,
      cases,
      walletSettlementSha256: settlement.walletSha256,
      backendSettlementSha256: settlement.backendSha256,
      eventCount: events.length,
      artifacts,
      oneShotLogs: config.oneShotLogs,
      runtimeArtifacts,
      runtimeHardening,
    };
    assertNoGeneratedSecrets("real E1 acceptance result", JSON.stringify(publicResult), config.secrets);
    cleanup = await session.cleanup();
    assertCleanup({
      project: session.project,
      recorderPort: session.recorderPort,
      eventCount: events.length,
      channels: [...new Set(events.map((event) => String(event.channel)))],
      testError: null,
      diagnosticsSha256: null,
      cleanup,
    });
    assert(cleanup.retainedImageTags.length === 0, `${session.project}: retained generated image tags`);
    assert(cleanup.retainedImageIds.length === 0, `${session.project}: retained generated image IDs`);
    assert(cleanup.retainedSelfCheckContainers.length === 0, `${session.project}: retained self-check containers`);
    return {
      project: session.project,
      recorderPort: session.recorderPort,
      status: "E1_PASS",
      e1Gate: "PASS",
      scenarioStatus: "REAL_SERVICES_COMPLETE",
      appImage,
      celestiaImage,
      toolVersions: selfChecks.toolVersions,
      packageManifestHashes: {
        app: selfChecks.packageManifests.app.sha256,
        celestia: selfChecks.packageManifests.celestia.sha256,
      },
      ntpBoundary,
      databaseBootstrap,
      offerHash,
      invalidCorpus: invalidCorpus.evidence,
      cases,
      walletSettlementSha256: settlement.walletSha256,
      backendSettlementSha256: settlement.backendSha256,
      eventCount: events.length,
      artifacts,
      cleanup,
      oneShotLogs: config.oneShotLogs.map((entry) => ({ ...entry })),
      runtimeArtifacts,
      runtimeHardening,
    };
  } catch (error) {
    let safeError = error instanceof Error ? error : new Error(String(error));
    if (config !== undefined) {
      try {
        assertNoGeneratedSecrets("real E1 acceptance failure", safeError.message, config.secrets);
        await rm(join(session.files.runtimeDirectory, "control", "boot-solver-token"), { force: true });
        await assertRuntimeTreeSecretFree(session, config.secrets, "real E1 acceptance failure runtime");
      } catch (scanError) {
        safeError = scanError instanceof Error ? scanError : new Error("real E1 acceptance failure scan failed");
      }
    }
    try {
      await reportRealE1FailureProofLog(
        session as unknown as HarnessSession,
        config?.secrets ?? [],
      );
    } catch (proofError) {
      const proofMessage = proofError instanceof Error ? proofError.message : String(proofError);
      if (config !== undefined) {
        assertNoGeneratedSecrets("real E1 acceptance proof-only diagnostic failure", proofMessage, config.secrets);
      }
      console.error(`real E1 acceptance proof-only diagnostic capture failed: ${proofMessage}`);
    }
    try {
      const diagnostics = await captureDiagnostics(session as unknown as HarnessSession);
      if (config !== undefined) assertNoGeneratedSecrets("real E1 acceptance diagnostics", diagnostics, config.secrets);
      const diagnosticBytes = Buffer.from(diagnostics);
      console.error(
        `\n[real E1 acceptance diagnostics captured before teardown bytes=${diagnosticBytes.byteLength} sha256=${createHash("sha256").update(diagnosticBytes).digest("hex")}]\n${diagnostics}`,
      );
    } catch (diagnosticError) {
      const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      try {
        if (config !== undefined) assertNoGeneratedSecrets("real E1 acceptance diagnostic failure", diagnosticMessage, config.secrets);
        console.error(`real E1 acceptance diagnostic capture failed: ${diagnosticMessage}`);
      } catch (secretError) {
        safeError = secretError instanceof Error ? secretError : new Error("real E1 acceptance diagnostics suppressed");
        console.error("real E1 acceptance diagnostics suppressed because a generated secret was detected");
      }
    }
    cleanup = await session.cleanup();
    if (cleanup.errors.length > 0) {
      throw new AggregateError(
        [safeError, ...cleanup.errors.map((message) => new Error(message))],
        "real E1 acceptance and cleanup both failed",
      );
    }
    throw safeError;
  }
}

function installSignalHandlers(): void {
  const handle = (signal: NodeJS.Signals): Promise<void> => {
    if (signalHandlingPromise !== null) return signalHandlingPromise;
    handlingSignal = true;
    signalHandlingPromise = (async () => {
      console.error(
        `[solver-offerfiles-e2e] ${signal}: tearing down ${emergencyCleanups.size} active construction/Compose project(s)`,
      );
      const results = await Promise.allSettled([...emergencyCleanups.values()].map((cleanup) => cleanup()));
      const failed = results.some(
        (result) => result.status === "rejected" || (result.status === "fulfilled" && result.value.errors.length > 0),
      );
      process.exit(failed ? 1 : signal === "SIGINT" ? 130 : 143);
    })();
    return signalHandlingPromise;
  };
  process.once("SIGINT", () => void handle("SIGINT"));
  process.once("SIGTERM", () => void handle("SIGTERM"));
}

async function main(): Promise<void> {
  installSignalHandlers();
  assertHostileAmbientEnvironmentIsScrubbed();
  const mode = process.argv[2] ?? "--verify-e0";
  if (mode === "--verify-e1-topology") {
    const result = await runRealE1Topology();
    console.log(
      JSON.stringify(
        {
          gate: mode,
          status: result.status,
          e1Gate: result.e1Gate,
          scenarioStatus: result.scenarioStatus,
          pins: REAL_E1_PINS,
          run: result,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "--verify-e1-services") {
    const result = await runRealE1ServiceBootstrap();
    console.log(
      JSON.stringify(
        {
          gate: mode,
          status: result.status,
          e1Gate: result.e1Gate,
          scenarioStatus: result.scenarioStatus,
          pins: REAL_E1_PINS,
          run: result,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "--run-e1") {
    const result = await runRealE1Acceptance();
    console.log(
      JSON.stringify(
        {
          gate: mode,
          status: result.status,
          e1Gate: result.e1Gate,
          scenarioStatus: result.scenarioStatus,
          pins: REAL_E1_PINS,
          run: result,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "--probe-e1-outer-cleanup-signal") {
    await runRealE1OuterCleanupSignalProbe();
    return;
  }
  let results: HarnessResult[];
  if (mode === "--verify-e0") results = await verifyE0();
  else if (mode === "--verify-e1-foundation") results = [await verifyE1Foundation()];
  else if (mode === "--dry-boot") results = [await dryBoot(false)];
  else if (mode === "--force-failure-probe") results = [await dryBoot(true)];
  else {
    throw new Error(
      `unknown mode ${mode}; use --verify-e0, --verify-e1-foundation, --verify-e1-topology, --verify-e1-services, --run-e1, --probe-e1-outer-cleanup-signal, --dry-boot, or --force-failure-probe`,
    );
  }

  console.log(
    JSON.stringify(
      {
        gate: mode,
        status: "PASS",
        image: NODE_IMAGE,
        cleanSettleMs: CLEAN_SETTLE_MS,
        runs: results,
      },
      null,
      2,
    ),
  );
}

main().catch(async (error) => {
  if (handlingSignal && signalHandlingPromise !== null) {
    await signalHandlingPromise;
    return;
  }
  console.error("[solver-offerfiles-e2e] FAIL", error);
  await Promise.allSettled([...emergencyCleanups.values()].map((cleanup) => cleanup()));
  process.exitCode = 1;
});
