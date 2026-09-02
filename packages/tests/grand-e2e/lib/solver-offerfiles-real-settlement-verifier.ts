/**
 * Authoritative backend/Postgres settlement verifier for the real Offer Files
 * solver acceptance scenarios.
 *
 * It is intentionally a standalone, read-only test actor. The verifier binds
 * three sealed artifacts (actor, solver, and direct-publication evidence) to a
 * repeatable-read Postgres snapshot and the backend's public terminal status.
 * It writes evidence only after every settlement marker and exactly-once check
 * succeeds.
 *
 * CLI:
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-settlement-verifier.ts verify
 *
 * Required environment:
 *   E1_RUN_ID
 *   E1_ACTOR_RESULT_PATH
 *   E1_SOLVER_RUNTIME_PATH
 *   E1_PUBLISHER_EVIDENCE_PATH
 *   E1_SETTLEMENT_EVIDENCE_PATH
 *   E1_SETTLEMENT_BACKEND_URL
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PW
 *
 * Optional bounded controls:
 *   E1_SETTLEMENT_DEADLINE_MS          default 120000, maximum 600000
 *   E1_SETTLEMENT_POLL_MS              default 500
 *   E1_SETTLEMENT_MAX_ARTIFACT_BYTES   default 4194304
 *   E1_SETTLEMENT_MAX_DB_ROWS          default 512
 *   E1_SETTLEMENT_MAX_DB_RESULT_BYTES  default 4194304
 *   E1_SETTLEMENT_MAX_HTTP_BYTES       default 65536
 */

import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { mip6NamespaceBytes } from "@zswap-da/offer-guard";

const ACTOR_SCHEMA = "zswap-offer-files-real-actors/v1";
const SOLVER_SCHEMA = "zswap-offer-files-real-solver/v1";
const PUBLICATION_SCHEMA = "zswap-offer-files-real-celestia-publication/v1";
const EVIDENCE_SCHEMA = "zswap-offer-files-real-backend-settlement/v1";
const HARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_ROWS = 4096;
const HARD_MAX_DEADLINE_MS = 10 * 60_000;

type FetchLike = typeof fetch;
type SignalName = "SIGINT" | "SIGTERM";

export interface RealSettlementVerifierConfig {
  runId: string;
  actorPath: string;
  solverPath: string;
  publisherPath: string;
  evidencePath: string;
  backendUrl: string;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  deadlineMs: number;
  pollMs: number;
  maxArtifactBytes: number;
  maxDbRows: number;
  maxDbResultBytes: number;
  maxHttpBytes: number;
}

export interface SettlementQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

/** Narrow injection boundary used by networkless tests and the real pg adapter. */
export interface SettlementQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SettlementQueryResult<Row>>;
}

export interface SettlementVerifierCleanup {
  signal: AbortSignal;
  temporaryPaths: Set<string>;
  abort: (reason?: unknown) => void;
  addCloser: (closer: () => void | Promise<void>) => void;
  cleanup: () => Promise<void>;
}

interface SealedJson<T = unknown> {
  value: T;
  sha256: string;
  bytes: number;
}

interface ActorOracle {
  runId: string;
  networkId: string;
  createdAt: string;
  solverSeedFingerprint: string;
  tokenB: string;
  offerBlob: string;
  rawOfferBytes: Uint8Array;
  offerHash: string;
  transactionHash: string;
  expectedNullifiers: string[];
  expectedCommitments: string[];
  fileSha256: string;
}

interface SolverOracle {
  runId: string;
  networkId: string;
  transactionHash: string;
  reportedTransactionHash: string;
  submissionBlobHash: string;
  submissionBlobBytes: number;
  protocolFeeSpecks: string;
  submissionCount: 1;
  submitBoundaryCalls: 1;
  telemetryCount: number;
  lastCentralSequence: number;
  fileSha256: string;
}

interface PublicationOracle {
  runId: string;
  offerHash: string;
  payloadHash: string;
  submittedHeight: number;
  commitmentBase64: string;
  fileSha256: string;
}

interface MarkerRow {
  marker: string;
  tx_hash: string | null;
}

interface DatabaseSettlement {
  offerFileId: number;
  offerHash: string;
  transactionHex: string;
  l2BlockHeight: string;
  archiveReason: "CONSUMED";
  archivedAt: string;
  settlementTxHash: string;
  nullifiers: Array<{ marker: string; txHash: string }>;
  commitments: Array<{ marker: string; txHash: string }>;
}

export interface RealBackendSettlementEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  runId: string;
  recordedAt: string;
  sources: {
    actor: { schema: typeof ACTOR_SCHEMA; sha256: string };
    solver: { schema: typeof SOLVER_SCHEMA; sha256: string };
    publication: { schema: typeof PUBLICATION_SCHEMA; sha256: string };
  };
  offer: {
    offerFileId: number;
    offerHash: string;
    transactionHex: string;
    transactionHexSha256: string;
    rawOfferSha256: string;
    l2BlockHeight: string;
    archiveReason: "CONSUMED";
    archivedAt: string;
    backendStatus: "consumed";
    publicationHeight: number;
    publicationCommitmentBase64: string;
  };
  settlement: {
    transactionHash: string;
    expectedNullifiers: readonly string[];
    observedNullifiers: ReadonlyArray<{ marker: string; txHash: string }>;
    expectedCommitments: readonly string[];
    observedCommitments: ReadonlyArray<{ marker: string; txHash: string }>;
    distinctMarkerTransactionHashes: readonly [string];
    solver: {
      reportedTransactionHash: string;
      canonicalTransactionHash: string;
      submissionCount: 1;
      submitBoundaryCalls: 1;
      submissionBlobHash: string;
      submissionBlobBytes: number;
      protocolFee: {
        asset: "DUST";
        specks: string;
        source: "wallet.calculateTransactionFee";
      };
      telemetryCount: number;
      lastCentralSequence: number;
    };
  };
  observation: {
    backend: {
      protocol: "http:" | "https:";
      hostname: string;
      port: string;
      pathnameSha256: string;
    };
    postgres: {
      hostSha256: string;
      port: number;
      databaseSha256: string;
      isolation: "repeatable-read-read-only";
    };
    attempts: number;
    deadlineMs: number;
  };
  checks: readonly [
    "sealed-artifacts-cross-bound",
    "exact-history-row-hash-and-blob",
    "backend-terminal-status-consumed",
    "exact-nullifier-multiset",
    "exact-commitment-multiset",
    "all-markers-share-one-non-null-transaction",
    "solver-transaction-equals-database-transaction",
    "exactly-one-solver-submit",
    "exact-path-a-wallet-boundary-matrix",
    "terminal-stock-claim-and-capacity-released",
  ];
}

class PendingSettlement extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingSettlement";
  }
}

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const nowIso = (): string => new Date().toISOString();

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${path} keys must be exactly ${wanted.join(",")}; got ${actual.join(",")}`);
  }
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown keys: ${unknown.sort().join(",")}`);
}

function stringAt(
  value: unknown,
  path: string,
  pattern: RegExp,
  maximumLength = 4096,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || !pattern.test(value)) {
    throw new Error(`${path} is not in the required canonical string form`);
  }
  return value;
}

function canonicalHex(value: unknown, path: string, length = 64): string {
  return stringAt(value, path, new RegExp(`^[0-9a-f]{${length}}$`), length);
}

function canonicalPositiveDecimal(value: unknown, path: string): string {
  return stringAt(value, path, /^[1-9][0-9]*$/, 128);
}

function canonicalDecimal(value: unknown, path: string): string {
  return stringAt(value, path, /^(?:0|[1-9][0-9]*)$/, 128);
}

function canonicalIso(value: unknown, path: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${path} is an invalid Date`);
    return value.toISOString();
  }
  const text = stringAt(value, path, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/, 32);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${path} is not a valid UTC timestamp`);
  return date.toISOString();
}

function canonicalSafeInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${path} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function canonicalTxHash(value: unknown, path: string): { reported: string; canonical: string } {
  const reported = stringAt(value, path, /^(?:0x)?[0-9a-fA-F]{64}$/, 66);
  return {
    reported,
    canonical: reported.replace(/^0x/i, "").toLowerCase(),
  };
}

function sortedHexMultiset(value: unknown, path: string, minimum = 1): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > HARD_MAX_ROWS) {
    throw new Error(`${path} must contain between ${minimum} and ${HARD_MAX_ROWS} entries`);
  }
  const parsed = value.map((entry, index) => canonicalHex(entry, `${path}[${index}]`));
  if (parsed.some((entry, index) => index > 0 && parsed[index - 1]! > entry)) {
    throw new Error(`${path} must be sorted canonically`);
  }
  return parsed;
}

function exactStringMultiset(actual: readonly string[], expected: readonly string[], path: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) {
    throw new Error(`${path} differs: expected ${JSON.stringify(right)}, got ${JSON.stringify(left)}`);
  }
}

function boundedVisibleStrings(
  value: unknown,
  path: string,
  minimum = 1,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > HARD_MAX_ROWS) {
    throw new Error(`${path} must contain between ${minimum} and ${HARD_MAX_ROWS} entries`);
  }
  return value.map((entry, index) =>
    stringAt(entry, `${path}[${index}]`, /^[\x21-\x7e]+$/, 1024)
  );
}

function validateBalanceActor(value: unknown, path: string): void {
  const actor = recordAt(value, path);
  exactKeys(actor, ["shielded", "unshielded", "dust"], path);
  canonicalDecimal(actor["dust"], `${path}.dust`);
  for (const kind of ["shielded", "unshielded"] as const) {
    const balances = recordAt(actor[kind], `${path}.${kind}`);
    if (Object.keys(balances).length > HARD_MAX_ROWS) {
      throw new Error(`${path}.${kind} contains too many token balances`);
    }
    for (const [token, amount] of Object.entries(balances)) {
      canonicalHex(token, `${path}.${kind} token`);
      canonicalDecimal(amount, `${path}.${kind}.${token}`);
    }
  }
}

function validateBalanceSnapshot(value: unknown, path: string): void {
  const snapshot = recordAt(value, path);
  exactKeys(snapshot, ["capturedAt", "user", "solver"], path);
  canonicalIso(snapshot["capturedAt"], `${path}.capturedAt`);
  validateBalanceActor(snapshot["user"], `${path}.user`);
  validateBalanceActor(snapshot["solver"], `${path}.solver`);
}

function positiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const raw = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a canonical positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be in [${minimum}, ${maximum}]`);
  }
  return parsed;
}

function requireRunId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) {
    throw new Error("E1_RUN_ID must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}");
  }
  return value;
}

function requireAbsolutePath(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function boundedDatabaseString(name: string, value: string | undefined, maximum = 255): string {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a non-empty bounded string without control bytes`);
  }
  return value;
}

function backendUrl(value: string | undefined): string {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("E1_SETTLEMENT_BACKEND_URL must be a bounded HTTP(S) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("E1_SETTLEMENT_BACKEND_URL is not a valid URL", { cause: error });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("E1_SETTLEMENT_BACKEND_URL must be a credential-free HTTP(S) origin");
  }
  return parsed.origin;
}

export function readRealSettlementVerifierConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealSettlementVerifierConfig {
  const actorPath = requireAbsolutePath("E1_ACTOR_RESULT_PATH", env["E1_ACTOR_RESULT_PATH"]);
  const solverPath = requireAbsolutePath("E1_SOLVER_RUNTIME_PATH", env["E1_SOLVER_RUNTIME_PATH"]);
  const publisherPath = requireAbsolutePath(
    "E1_PUBLISHER_EVIDENCE_PATH",
    env["E1_PUBLISHER_EVIDENCE_PATH"],
  );
  const evidencePath = requireAbsolutePath(
    "E1_SETTLEMENT_EVIDENCE_PATH",
    env["E1_SETTLEMENT_EVIDENCE_PATH"],
  );
  if (new Set([actorPath, solverPath, publisherPath, evidencePath]).size !== 4) {
    throw new Error("actor, solver, publication, and settlement evidence paths must be distinct");
  }
  const password = env["DB_PW"];
  if (!password || password.length > 4096 || password.includes("\0")) {
    throw new Error("DB_PW must be a non-empty bounded password without NUL bytes");
  }
  return {
    runId: requireRunId(env["E1_RUN_ID"]),
    actorPath,
    solverPath,
    publisherPath,
    evidencePath,
    backendUrl: backendUrl(env["E1_SETTLEMENT_BACKEND_URL"]),
    database: {
      host: boundedDatabaseString("DB_HOST", env["DB_HOST"]),
      port: positiveIntegerEnv("DB_PORT", env["DB_PORT"], 5432, 65_535),
      name: boundedDatabaseString("DB_NAME", env["DB_NAME"]),
      user: boundedDatabaseString("DB_USER", env["DB_USER"]),
      password,
    },
    deadlineMs: positiveIntegerEnv(
      "E1_SETTLEMENT_DEADLINE_MS",
      env["E1_SETTLEMENT_DEADLINE_MS"],
      120_000,
      HARD_MAX_DEADLINE_MS,
      1_000,
    ),
    pollMs: positiveIntegerEnv(
      "E1_SETTLEMENT_POLL_MS",
      env["E1_SETTLEMENT_POLL_MS"],
      500,
      10_000,
      10,
    ),
    maxArtifactBytes: positiveIntegerEnv(
      "E1_SETTLEMENT_MAX_ARTIFACT_BYTES",
      env["E1_SETTLEMENT_MAX_ARTIFACT_BYTES"],
      4 * 1024 * 1024,
      HARD_MAX_FILE_BYTES,
      1024,
    ),
    maxDbRows: positiveIntegerEnv(
      "E1_SETTLEMENT_MAX_DB_ROWS",
      env["E1_SETTLEMENT_MAX_DB_ROWS"],
      512,
      HARD_MAX_ROWS,
    ),
    maxDbResultBytes: positiveIntegerEnv(
      "E1_SETTLEMENT_MAX_DB_RESULT_BYTES",
      env["E1_SETTLEMENT_MAX_DB_RESULT_BYTES"],
      4 * 1024 * 1024,
      HARD_MAX_FILE_BYTES,
      1024,
    ),
    maxHttpBytes: positiveIntegerEnv(
      "E1_SETTLEMENT_MAX_HTTP_BYTES",
      env["E1_SETTLEMENT_MAX_HTTP_BYTES"],
      64 * 1024,
      1024 * 1024,
      1024,
    ),
  };
}

async function readSealedCanonicalJson(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<SealedJson> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    if ((before.mode & 0o077) !== 0) throw new Error("group/other permissions must be zero");
    if (before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`size must be in [1, ${maximumBytes}] bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.length !== before.size || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("file changed while being read");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (`${JSON.stringify(value, null, 2)}\n` !== text) {
      throw new Error("file is not canonical pretty JSON with one trailing newline");
    }
    return { value, sha256: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    throw new Error(`could not read sealed ${label}: ${errorMessage(error)}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseActorArtifact(artifact: SealedJson, config: RealSettlementVerifierConfig): ActorOracle {
  const root = recordAt(artifact.value, "actor artifact");
  exactKeys(
    root,
    ["schema", "runId", "networkId", "createdAt", "actors", "tokens", "funding", "balances", "offer", "ladder"],
    "actor artifact",
  );
  if (root["schema"] !== ACTOR_SCHEMA || root["runId"] !== config.runId) {
    throw new Error("actor artifact has the wrong schema or run ID");
  }
  const networkId = stringAt(root["networkId"], "actor artifact.networkId", /^[a-zA-Z0-9_.-]+$/, 64);
  if (networkId !== "undeployed") throw new Error("actor artifact must target Midnight undeployed/ledger-v8");
  const createdAt = canonicalIso(root["createdAt"], "actor artifact.createdAt");

  const actors = recordAt(root["actors"], "actor artifact.actors");
  exactKeys(actors, ["genesis", "user", "solver"], "actor artifact.actors");
  let solverSeedFingerprint = "";
  for (const name of ["genesis", "user", "solver"] as const) {
    const actor = recordAt(actors[name], `actor artifact.actors.${name}`);
    exactKeys(actor, ["seedFingerprint"], `actor artifact.actors.${name}`);
    const fingerprint = canonicalHex(actor["seedFingerprint"], `actor artifact.actors.${name}.seedFingerprint`, 16);
    if (name === "solver") solverSeedFingerprint = fingerprint;
  }

  const tokens = recordAt(root["tokens"], "actor artifact.tokens");
  exactKeys(tokens, ["A", "B", "NIGHT"], "actor artifact.tokens");
  const tokenA = canonicalHex(tokens["A"], "actor artifact.tokens.A");
  const tokenB = canonicalHex(tokens["B"], "actor artifact.tokens.B");
  const night = canonicalHex(tokens["NIGHT"], "actor artifact.tokens.NIGHT");
  if (tokenA === tokenB || night !== "0".repeat(64)) throw new Error("actor artifact token identities are invalid");
  const funding = recordAt(root["funding"], "actor artifact.funding");
  exactKeys(
    funding,
    [
      "mintAmount", "userTokenAAmount", "solverTokenBAmount", "nightPerUtxo",
      "nightUtxosPerActor", "nightFundingTransaction", "tokenFundingTransactions",
    ],
    "actor artifact.funding",
  );
  for (const key of ["mintAmount", "userTokenAAmount", "solverTokenBAmount", "nightPerUtxo"] as const) {
    canonicalPositiveDecimal(funding[key], `actor artifact.funding.${key}`);
  }
  canonicalSafeInteger(funding["nightUtxosPerActor"], "actor artifact.funding.nightUtxosPerActor", 1);
  const nightFunding = recordAt(
    funding["nightFundingTransaction"],
    "actor artifact.funding.nightFundingTransaction",
  );
  exactKeys(nightFunding, ["hash", "identifiers"], "actor artifact.funding.nightFundingTransaction");
  stringAt(nightFunding["hash"], "actor artifact.funding.nightFundingTransaction.hash", /^[\x21-\x7e]+$/, 1024);
  boundedVisibleStrings(
    nightFunding["identifiers"],
    "actor artifact.funding.nightFundingTransaction.identifiers",
  );
  if (!Array.isArray(funding["tokenFundingTransactions"]) || funding["tokenFundingTransactions"].length !== 2) {
    throw new Error("actor artifact.funding.tokenFundingTransactions must contain A and B exactly once");
  }
  const fundedTokens: string[] = [];
  for (const [index, value] of funding["tokenFundingTransactions"].entries()) {
    const transaction = recordAt(value, `actor artifact.funding.tokenFundingTransactions[${index}]`);
    exactKeys(transaction, ["token", "hash", "identifiers"], `actor artifact.funding.tokenFundingTransactions[${index}]`);
    const token = stringAt(transaction["token"], `actor artifact.funding.tokenFundingTransactions[${index}].token`, /^(?:A|B)$/, 1);
    fundedTokens.push(token);
    stringAt(transaction["hash"], `actor artifact.funding.tokenFundingTransactions[${index}].hash`, /^[\x21-\x7e]+$/, 1024);
    boundedVisibleStrings(
      transaction["identifiers"],
      `actor artifact.funding.tokenFundingTransactions[${index}].identifiers`,
    );
  }
  if ([...fundedTokens].sort().join(",") !== "A,B") {
    throw new Error("actor artifact.funding.tokenFundingTransactions must contain A and B exactly once");
  }

  const balances = recordAt(root["balances"], "actor artifact.balances");
  exactKeys(
    balances,
    ["beforeFunding", "beforeSettlement", "expectedAfterSettlement", "dustBalanceEvidence"],
    "actor artifact.balances",
  );
  validateBalanceSnapshot(balances["beforeFunding"], "actor artifact.balances.beforeFunding");
  validateBalanceSnapshot(balances["beforeSettlement"], "actor artifact.balances.beforeSettlement");
  const expectedAfter = recordAt(
    balances["expectedAfterSettlement"],
    "actor artifact.balances.expectedAfterSettlement",
  );
  exactKeys(expectedAfter, ["user", "solver"], "actor artifact.balances.expectedAfterSettlement");
  for (const actorName of ["user", "solver"] as const) {
    const actorBalances = recordAt(
      expectedAfter[actorName],
      `actor artifact.balances.expectedAfterSettlement.${actorName}`,
    );
    exactKeys(actorBalances, ["A", "B"], `actor artifact.balances.expectedAfterSettlement.${actorName}`);
    canonicalDecimal(actorBalances["A"], `actor artifact.balances.expectedAfterSettlement.${actorName}.A`);
    canonicalDecimal(actorBalances["B"], `actor artifact.balances.expectedAfterSettlement.${actorName}.B`);
  }
  const dustEvidence = recordAt(
    balances["dustBalanceEvidence"],
    "actor artifact.balances.dustBalanceEvidence",
  );
  exactKeys(
    dustEvidence,
    ["actor", "asset", "balanceSource", "before", "after", "delta", "interpretation"],
    "actor artifact.balances.dustBalanceEvidence",
  );
  if (
    dustEvidence["actor"] !== "solver" || dustEvidence["asset"] !== "DUST" ||
    dustEvidence["balanceSource"] !== "wallet.dust.state/waitForDustFunds" ||
    dustEvidence["after"] !== null || dustEvidence["delta"] !== null ||
    dustEvidence["interpretation"] !== "net-balance-delta-not-exact-fee"
  ) {
    throw new Error("actor artifact dust balance evidence has the wrong contract");
  }
  canonicalDecimal(dustEvidence["before"], "actor artifact.balances.dustBalanceEvidence.before");
  const ladder = recordAt(root["ladder"], "actor artifact.ladder");
  exactKeys(ladder, ["path", "sha256"], "actor artifact.ladder");
  requireAbsolutePath("actor artifact.ladder.path", ladder["path"] as string | undefined);
  canonicalHex(ladder["sha256"], "actor artifact.ladder.sha256");

  const offer = recordAt(root["offer"], "actor artifact.offer");
  exactKeys(
    offer,
    ["offerBlob", "offerHash", "transactionHash", "identifiers", "expectedNullifiers", "expectedCommitments", "inputRoots", "gives", "wants", "expiresAt"],
    "actor artifact.offer",
  );
  const offerBlob = stringAt(
    offer["offerBlob"],
    "actor artifact.offer.offerBlob",
    /^swapoffer1[0-9a-z]+$/,
    Math.ceil(config.maxArtifactBytes * 1.7),
  );
  let rawOfferBytes: Uint8Array;
  try {
    rawOfferBytes = Uint8Array.from(OfferFiles.decode(offerBlob));
  } catch (error) {
    throw new Error("actor artifact offerBlob is not decodable", { cause: error });
  }
  if (rawOfferBytes.length === 0 || rawOfferBytes.length > 1024 * 1024 || OfferFiles.encode(rawOfferBytes) !== offerBlob) {
    throw new Error("actor artifact offerBlob is empty, oversized, or non-canonical");
  }
  const offerHash = canonicalHex(offer["offerHash"], "actor artifact.offer.offerHash");
  if (sha256(rawOfferBytes) !== offerHash) throw new Error("actor artifact offer hash differs from raw bytes");
  const transactionHash = stringAt(
    offer["transactionHash"],
    "actor artifact.offer.transactionHash",
    /^[\x21-\x7e]+$/,
    1024,
  );
  const expectedNullifiers = sortedHexMultiset(
    offer["expectedNullifiers"],
    "actor artifact.offer.expectedNullifiers",
  );
  const expectedCommitments = sortedHexMultiset(
    offer["expectedCommitments"],
    "actor artifact.offer.expectedCommitments",
  );
  sortedHexMultiset(offer["inputRoots"], "actor artifact.offer.inputRoots", 0);
  canonicalIso(offer["expiresAt"], "actor artifact.offer.expiresAt");
  boundedVisibleStrings(offer["identifiers"], "actor artifact.offer.identifiers");
  for (const side of ["gives", "wants"] as const) {
    if (!Array.isArray(offer[side]) || offer[side].length !== 1) {
      throw new Error(`actor artifact.offer.${side} must contain exactly one leg`);
    }
    const leg = recordAt(offer[side][0], `actor artifact.offer.${side}[0]`);
    exactKeys(leg, ["token", "amount", "kind"], `actor artifact.offer.${side}[0]`);
    if (leg["kind"] !== "SHIELDED") throw new Error(`actor artifact.offer.${side}[0] is not shielded`);
    canonicalPositiveDecimal(leg["amount"], `actor artifact.offer.${side}[0].amount`);
    const token = canonicalHex(leg["token"], `actor artifact.offer.${side}[0].token`);
    if ((side === "gives" ? tokenA : tokenB) !== token) {
      throw new Error(`actor artifact.offer.${side}[0] has the wrong token`);
    }
  }
  return {
    runId: config.runId,
    networkId,
    createdAt,
    solverSeedFingerprint,
    tokenB,
    offerBlob,
    rawOfferBytes,
    offerHash,
    transactionHash,
    expectedNullifiers,
    expectedCommitments,
    fileSha256: artifact.sha256,
  };
}

function parseSolverArtifact(
  artifact: SealedJson,
  config: RealSettlementVerifierConfig,
  actor: ActorOracle,
): SolverOracle {
  const root = recordAt(artifact.value, "solver artifact");
  const allowed = [
    "schema", "runId", "networkId", "pid", "api", "ladderConfigPath", "telemetryPath",
    "centralRecorderEnabled", "seedFingerprint", "startedAt", "state", "updatedAt",
    "submissionCount", "ready", "walletBoundaries", "stock", "lastSubmission",
    "lastSubmissionOutcome", "reason", "telemetryCount", "lastCentralSequence", "evidenceFailures",
  ];
  allowedKeys(root, allowed, "solver artifact");
  for (const required of allowed) {
    if (!(required in root)) throw new Error(`solver artifact.${required} is required for terminal evidence`);
  }
  if (root["schema"] !== SOLVER_SCHEMA || root["runId"] !== config.runId || root["networkId"] !== actor.networkId) {
    throw new Error("solver artifact has the wrong schema, run, or network");
  }
  if (root["state"] !== "stopped" || root["ready"] !== false) {
    throw new Error("solver artifact is not a stopped, flushed terminal document");
  }
  canonicalSafeInteger(root["pid"], "solver artifact.pid", 1);
  const solverApi = stringAt(root["api"], "solver artifact.api", /^https?:\/\//, 4096);
  let parsedSolverApi: URL;
  try {
    parsedSolverApi = new URL(solverApi);
  } catch (error) {
    throw new Error("solver artifact.api is not a valid URL", { cause: error });
  }
  if (
    (parsedSolverApi.protocol !== "http:" && parsedSolverApi.protocol !== "https:") ||
    !parsedSolverApi.hostname || parsedSolverApi.username || parsedSolverApi.password ||
    parsedSolverApi.search || parsedSolverApi.hash
  ) {
    throw new Error("solver artifact.api must be a credential-free HTTP(S) URL");
  }
  requireAbsolutePath("solver artifact.ladderConfigPath", root["ladderConfigPath"] as string | undefined);
  requireAbsolutePath("solver artifact.telemetryPath", root["telemetryPath"] as string | undefined);
  canonicalIso(root["startedAt"], "solver artifact.startedAt");
  canonicalIso(root["updatedAt"], "solver artifact.updatedAt");
  if (root["centralRecorderEnabled"] !== true) throw new Error("solver central recorder was not enabled");
  if (root["seedFingerprint"] !== actor.solverSeedFingerprint) {
    throw new Error("solver artifact is not bound to the actor manifest's solver seed");
  }
  if (root["submissionCount"] !== 1) throw new Error("solver artifact must report exactly one submission");
  if (!Array.isArray(root["evidenceFailures"]) || root["evidenceFailures"].length !== 0) {
    throw new Error("solver artifact reports evidence failures");
  }
  stringAt(root["reason"], "solver artifact.reason", /^[\x20-\x7e]+$/, 1024);
  const telemetryCount = canonicalSafeInteger(root["telemetryCount"], "solver artifact.telemetryCount", 1);
  const lastCentralSequence = canonicalSafeInteger(
    root["lastCentralSequence"],
    "solver artifact.lastCentralSequence",
    1,
  );

  const boundaries = recordAt(root["walletBoundaries"], "solver artifact.walletBoundaries");
  exactKeys(boundaries, ["features", "methods"], "solver artifact.walletBoundaries");
  const features = recordAt(boundaries["features"], "solver artifact.walletBoundaries.features");
  exactKeys(features, ["pathB", "residualTopUps", "cycles", "levelsPublication"], "solver artifact.walletBoundaries.features");
  if (Object.values(features).some((value) => value !== false)) {
    throw new Error("solver artifact unexpectedly enabled a gated feature");
  }
  const methods = recordAt(boundaries["methods"], "solver artifact.walletBoundaries.methods");
  exactKeys(
    methods,
    ["balanceFinalizedTransaction", "finalizeRecipe", "submitTransaction", "revert", "transferTransaction", "finalizeTransaction", "initSwap"],
    "solver artifact.walletBoundaries.methods",
  );
  for (const [name, value] of Object.entries(methods)) {
    const method = recordAt(value, `solver artifact.walletBoundaries.methods.${name}`);
    exactKeys(method, ["available", "calls"], `solver artifact.walletBoundaries.methods.${name}`);
    if (typeof method["available"] !== "boolean") throw new Error(`solver method ${name} availability is malformed`);
    const calls = canonicalSafeInteger(method["calls"], `solver method ${name} calls`);
    if (method["available"] === false && calls !== 0) {
      throw new Error(`unavailable solver method ${name} reports ${calls} calls`);
    }
  }
  const exactPathACalls: Record<string, number> = {
    balanceFinalizedTransaction: 1,
    finalizeRecipe: 1,
    submitTransaction: 1,
    revert: 0,
    transferTransaction: 0,
    finalizeTransaction: 0,
    initSwap: 0,
  };
  for (const [name, expectedCalls] of Object.entries(exactPathACalls)) {
    const method = methods[name] as Record<string, unknown>;
    if (method["calls"] !== expectedCalls || (expectedCalls > 0 && method["available"] !== true)) {
      throw new Error(
        `solver wallet boundary ${name} must be available when used and report exactly ${expectedCalls} calls`,
      );
    }
  }

  const submission = recordAt(root["lastSubmission"], "solver artifact.lastSubmission");
  exactKeys(
    submission,
    ["count", "transactionHash", "identifiers", "blobHash", "blobBytes", "imbalanceCount", "imbalances", "protocolFee", "inspectionErrors", "boundary"],
    "solver artifact.lastSubmission",
  );
  if (submission["count"] !== 1 || submission["boundary"] !== "post-invocation") {
    throw new Error("solver immutable submission inspection is not submission one at the post-invocation boundary");
  }
  const tx = canonicalTxHash(submission["transactionHash"], "solver artifact.lastSubmission.transactionHash");
  const submissionBlobHash = canonicalHex(submission["blobHash"], "solver artifact.lastSubmission.blobHash");
  const submissionBlobBytes = canonicalSafeInteger(
    submission["blobBytes"],
    "solver artifact.lastSubmission.blobBytes",
    1,
  );
  if (submission["imbalanceCount"] !== 0 || !Array.isArray(submission["imbalances"]) || submission["imbalances"].length !== 0) {
    throw new Error("solver submitted transaction is not exactly balanced");
  }
  if (!Array.isArray(submission["inspectionErrors"]) || submission["inspectionErrors"].length !== 0) {
    throw new Error("solver immutable submission inspection reports errors");
  }
  boundedVisibleStrings(submission["identifiers"], "solver artifact.lastSubmission.identifiers");
  const fee = recordAt(submission["protocolFee"], "solver artifact.lastSubmission.protocolFee");
  exactKeys(fee, ["asset", "specks", "source", "transactionHash"], "solver artifact.lastSubmission.protocolFee");
  if (fee["asset"] !== "DUST" || fee["source"] !== "wallet.calculateTransactionFee") {
    throw new Error("solver protocol fee is not exact wallet-calculated DUST evidence");
  }
  const protocolFeeSpecks = canonicalPositiveDecimal(fee["specks"], "solver artifact.lastSubmission.protocolFee.specks");
  if (canonicalTxHash(fee["transactionHash"], "solver artifact.lastSubmission.protocolFee.transactionHash").canonical !== tx.canonical) {
    throw new Error("solver protocol fee is bound to a different transaction");
  }
  const outcome = recordAt(root["lastSubmissionOutcome"], "solver artifact.lastSubmissionOutcome");
  exactKeys(outcome, ["kind", "count", "result"], "solver artifact.lastSubmissionOutcome");
  if (outcome["kind"] !== "succeeded" || outcome["count"] !== 1) {
    throw new Error("solver's only submission did not succeed");
  }

  const stock = recordAt(root["stock"], "solver artifact.stock");
  exactKeys(stock, ["tokens", "offers"], "solver artifact.stock");
  if (!Array.isArray(stock["tokens"]) || stock["tokens"].length > config.maxDbRows) {
    throw new Error("solver stock tokens are missing or oversized");
  }
  const stockTokenRows = stock["tokens"].map((value, index) => {
    const row = recordAt(value, `solver artifact.stock.tokens[${index}]`);
    exactKeys(row, ["token", "balance", "reserved", "available"], `solver artifact.stock.tokens[${index}]`);
    return {
      token: canonicalHex(row["token"], `solver artifact.stock.tokens[${index}].token`),
      balance: canonicalDecimal(row["balance"], `solver artifact.stock.tokens[${index}].balance`),
      reserved: canonicalDecimal(row["reserved"], `solver artifact.stock.tokens[${index}].reserved`),
      available: canonicalDecimal(row["available"], `solver artifact.stock.tokens[${index}].available`),
    };
  });
  if (new Set(stockTokenRows.map(({ token }) => token)).size !== stockTokenRows.length) {
    throw new Error("solver stock contains duplicate token rows");
  }
  for (const row of stockTokenRows) {
    const spare = BigInt(row.balance) - BigInt(row.reserved);
    const expectedAvailable = (spare > 0n ? spare : 0n).toString();
    if (row.available !== expectedAvailable) {
      throw new Error(`solver stock available capacity is inconsistent for token ${row.token}`);
    }
    if (row.reserved !== "0" || row.available !== row.balance) {
      throw new Error(`solver terminal stock retains reserved capacity for token ${row.token}`);
    }
  }
  if (!Array.isArray(stock["offers"]) || stock["offers"].length > config.maxDbRows) {
    throw new Error("solver stock offers are missing or oversized");
  }
  const target = stock["offers"].map((value, index) => {
    const row = recordAt(value, `solver artifact.stock.offers[${index}]`);
    exactKeys(row, ["offerHash", "resolvable", "claimed", "nullifiers"], `solver artifact.stock.offers[${index}]`);
    canonicalHex(row["offerHash"], `solver artifact.stock.offers[${index}].offerHash`);
    if (typeof row["resolvable"] !== "boolean" || (row["claimed"] !== null && typeof row["claimed"] !== "boolean")) {
      throw new Error(`solver artifact.stock.offers[${index}] has malformed state flags`);
    }
    sortedHexMultiset(row["nullifiers"], `solver artifact.stock.offers[${index}].nullifiers`, 0);
    return row;
  }).filter((row) => row["offerHash"] === actor.offerHash);
  if (target.length !== 1 || target[0]!["resolvable"] !== true || target[0]!["claimed"] !== false) {
    throw new Error("solver terminal stock does not prove the exact successful offer claim was released");
  }
  exactStringMultiset(
    sortedHexMultiset(target[0]!["nullifiers"], "solver target stock nullifiers"),
    actor.expectedNullifiers,
    "solver target stock nullifier multiset",
  );
  const payoutCapacity = stockTokenRows.filter(({ token }) => token === actor.tokenB);
  if (payoutCapacity.length !== 1) {
    throw new Error("solver terminal stock does not contain the target B payout capacity");
  }

  return {
    runId: config.runId,
    networkId: actor.networkId,
    transactionHash: tx.canonical,
    reportedTransactionHash: tx.reported,
    submissionBlobHash,
    submissionBlobBytes,
    protocolFeeSpecks,
    submissionCount: 1,
    submitBoundaryCalls: 1,
    telemetryCount,
    lastCentralSequence,
    fileSha256: artifact.sha256,
  };
}

function canonicalBase64(value: unknown, path: string, maximumBytes: number): Uint8Array {
  const text = stringAt(
    value,
    path,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    Math.ceil(maximumBytes / 3) * 4,
  );
  if (text.length === 0 || text.length % 4 !== 0) throw new Error(`${path} is not padded base64`);
  const bytes = Uint8Array.from(Buffer.from(text, "base64"));
  if (bytes.length === 0 || bytes.length > maximumBytes || Buffer.from(bytes).toString("base64") !== text) {
    throw new Error(`${path} is not canonical bounded base64`);
  }
  return bytes;
}

function parsePublicationArtifact(
  artifact: SealedJson,
  config: RealSettlementVerifierConfig,
  actor: ActorOracle,
): PublicationOracle {
  const root = recordAt(artifact.value, "publication artifact");
  exactKeys(root, ["schema", "runId", "mode", "recordedAt", "actorManifest", "payload", "celestia", "verification"], "publication artifact");
  if (root["schema"] !== PUBLICATION_SCHEMA || root["runId"] !== config.runId || root["mode"] !== "offer") {
    throw new Error("publication artifact has the wrong schema, run, or mode");
  }
  canonicalIso(root["recordedAt"], "publication artifact.recordedAt");
  const actorBinding = recordAt(root["actorManifest"], "publication artifact.actorManifest");
  exactKeys(actorBinding, ["schema", "sha256", "networkId", "createdAt", "offerHash", "offerTransactionHash"], "publication artifact.actorManifest");
  if (
    actorBinding["schema"] !== ACTOR_SCHEMA ||
    actorBinding["sha256"] !== actor.fileSha256 ||
    actorBinding["networkId"] !== actor.networkId ||
    canonicalIso(actorBinding["createdAt"], "publication artifact.actorManifest.createdAt") !== actor.createdAt ||
    actorBinding["offerHash"] !== actor.offerHash ||
    actorBinding["offerTransactionHash"] !== actor.transactionHash
  ) {
    throw new Error("publication artifact is not bound to the exact sealed actor artifact");
  }
  const payload = recordAt(root["payload"], "publication artifact.payload");
  exactKeys(payload, ["source", "garbageLabel", "byteLength", "sha256", "dataBase64"], "publication artifact.payload");
  if (payload["source"] !== "actor-manifest.offer.offerBlob" || payload["garbageLabel"] !== null) {
    throw new Error("publication artifact did not publish the actor offer");
  }
  const data = canonicalBase64(payload["dataBase64"], "publication artifact.payload.dataBase64", 1024 * 1024);
  const payloadHash = canonicalHex(payload["sha256"], "publication artifact.payload.sha256");
  if (
    payload["byteLength"] !== actor.rawOfferBytes.length ||
    data.length !== actor.rawOfferBytes.length ||
    !Buffer.from(data).equals(Buffer.from(actor.rawOfferBytes)) ||
    payloadHash !== actor.offerHash
  ) {
    throw new Error("publication payload differs from the actor's exact raw offer bytes");
  }
  const celestia = recordAt(root["celestia"], "publication artifact.celestia");
  exactKeys(celestia, ["rpcEndpoint", "namespaceBase64", "shareVersion", "gasPrice", "submittedHeight", "observedHeaderHeight", "commitmentBase64", "commitmentSha256"], "publication artifact.celestia");
  const endpoint = recordAt(celestia["rpcEndpoint"], "publication artifact.celestia.rpcEndpoint");
  exactKeys(
    endpoint,
    ["protocol", "hostname", "port", "pathnameSha256", "hasQuery", "bearerAuth"],
    "publication artifact.celestia.rpcEndpoint",
  );
  if (endpoint["protocol"] !== "http:" && endpoint["protocol"] !== "https:") {
    throw new Error("publication Celestia RPC protocol is invalid");
  }
  stringAt(endpoint["hostname"], "publication artifact.celestia.rpcEndpoint.hostname", /^[a-zA-Z0-9:._-]+$/, 255);
  if (endpoint["port"] !== "") {
    positiveIntegerEnv(
      "publication artifact.celestia.rpcEndpoint.port",
      endpoint["port"] as string | undefined,
      1,
      65_535,
    );
  }
  canonicalHex(endpoint["pathnameSha256"], "publication artifact.celestia.rpcEndpoint.pathnameSha256");
  if (typeof endpoint["hasQuery"] !== "boolean" || typeof endpoint["bearerAuth"] !== "boolean") {
    throw new Error("publication Celestia RPC query/auth flags are malformed");
  }
  const namespace = canonicalBase64(
    celestia["namespaceBase64"],
    "publication artifact.celestia.namespaceBase64",
    29,
  );
  if (
    namespace.length !== 29 ||
    !Buffer.from(namespace).equals(Buffer.from(mip6NamespaceBytes()))
  ) {
    throw new Error("publication Celestia namespace is not the exact MIP-0006 namespace");
  }
  stringAt(celestia["gasPrice"], "publication artifact.celestia.gasPrice", /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/, 64);
  const submittedHeight = canonicalSafeInteger(celestia["submittedHeight"], "publication artifact.celestia.submittedHeight", 1);
  if (celestia["observedHeaderHeight"] !== submittedHeight || celestia["shareVersion"] !== 0) {
    throw new Error("publication height/share-version evidence is inconsistent");
  }
  const commitmentBase64 = stringAt(celestia["commitmentBase64"], "publication artifact.celestia.commitmentBase64", /^[A-Za-z0-9+/]{43}=$/, 44);
  const commitmentBytes = canonicalBase64(
    commitmentBase64,
    "publication artifact.celestia.commitmentBase64",
    32,
  );
  if (commitmentBytes.length !== 32) throw new Error("publication Celestia commitment is not 32 bytes");
  if (
    canonicalHex(celestia["commitmentSha256"], "publication artifact.celestia.commitmentSha256") !==
      sha256(commitmentBytes)
  ) {
    throw new Error("publication commitment hash does not match commitment bytes");
  }
  const verification = recordAt(root["verification"], "publication artifact.verification");
  exactKeys(verification, ["absoluteDeadlineMs", "networkHeadAttempts", "getAllAttempts", "exactMatchesAtHeight", "observedByteLength", "observedSha256", "getByCommitmentSha256", "checks"], "publication artifact.verification");
  canonicalSafeInteger(verification["absoluteDeadlineMs"], "publication artifact.verification.absoluteDeadlineMs", 1);
  canonicalSafeInteger(verification["networkHeadAttempts"], "publication artifact.verification.networkHeadAttempts", 1);
  canonicalSafeInteger(verification["getAllAttempts"], "publication artifact.verification.getAllAttempts", 1);
  if (
    verification["exactMatchesAtHeight"] !== 1 ||
    verification["observedByteLength"] !== actor.rawOfferBytes.length ||
    verification["observedSha256"] !== actor.offerHash ||
    verification["getByCommitmentSha256"] !== actor.offerHash
  ) {
    throw new Error("publication artifact lacks exact byte/hash read-back evidence");
  }
  const expectedChecks = [
    "submitted-height-has-exact-header",
    "namespace-and-share-version-match",
    "exactly-one-byte-identical-blob-at-height",
    "sha256-matches-submitted-bytes",
    "commitment-resolves-to-byte-identical-blob",
  ];
  if (JSON.stringify(verification["checks"]) !== JSON.stringify(expectedChecks)) {
    throw new Error("publication artifact verification checks are incomplete or out of order");
  }
  return {
    runId: config.runId,
    offerHash: actor.offerHash,
    payloadHash,
    submittedHeight,
    commitmentBase64,
    fileSha256: artifact.sha256,
  };
}

export function createIdempotentSettlementVerifierCleanup(
  controller = new AbortController(),
): SettlementVerifierCleanup {
  const temporaryPaths = new Set<string>();
  const closers: Array<() => void | Promise<void>> = [];
  let cleanupPromise: Promise<void> | null = null;
  const abort = (reason: unknown = new Error("settlement verifier cleanup requested")): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const addCloser = (closer: () => void | Promise<void>): void => {
    if (cleanupPromise) throw new Error("cannot add a closer after settlement verifier cleanup started");
    closers.push(closer);
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      abort();
      const paths = [...temporaryPaths];
      temporaryPaths.clear();
      const operations = [
        ...[...closers].reverse().map((closer) => Promise.resolve().then(closer)),
        ...paths.map((path) => unlink(path)),
      ];
      const results = await Promise.allSettled(operations);
      const failures = results.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const error = result.reason as NodeJS.ErrnoException;
        if (index >= closers.length && error?.code === "ENOENT") return [];
        return [new Error(`settlement verifier cleanup operation ${index + 1} failed: ${errorMessage(error)}`)];
      });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "settlement verifier cleanup failed");
    })();
    return cleanupPromise;
  };
  return { signal: controller.signal, temporaryPaths, abort, addCloser, cleanup };
}

export function realSettlementVerifierSignalExitCode(signal: SignalName): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

function deadlineError(): Error {
  const error = new Error("settlement verification exceeded its absolute deadline");
  error.name = "DeadlineError";
  return error;
}

async function withAbsoluteDeadline<T>(
  signal: AbortSignal,
  deadlineAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw deadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("settlement verification aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(deadlineError()), remaining);
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function abortableSleep(ms: number, signal: AbortSignal, deadlineAt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw deadlineError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, Math.min(ms, remaining));
    function finish(): void {
      signal.removeEventListener("abort", onAbort);
      if (Date.now() >= deadlineAt) reject(deadlineError());
      else resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("settlement verification aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function boundedQuery<Row extends Record<string, unknown>>(
  executor: SettlementQueryExecutor,
  text: string,
  values: readonly unknown[],
  config: RealSettlementVerifierConfig,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Row[]> {
  const result = await withAbsoluteDeadline(signal, deadlineAt, () => executor.query<Row>(text, values));
  if (!result || !Array.isArray(result.rows) || result.rows.length > config.maxDbRows) {
    throw new Error(`database query returned more than ${config.maxDbRows} rows or a malformed result`);
  }
  const encoded = JSON.stringify(result.rows);
  if (Buffer.byteLength(encoded) > config.maxDbResultBytes) {
    throw new Error(`database query result exceeds ${config.maxDbResultBytes} bytes`);
  }
  return result.rows;
}

const OFFER_QUERY = `/* settlement-verifier:offer */
SELECT 'live'::text AS source, id, offer_hash, transaction_hex,
       celestia_height::text AS l2_block_height,
       NULL::text AS archive_reason, NULL::timestamptz AS archived_at
FROM offer_file WHERE offer_hash = $1
UNION ALL
SELECT 'history'::text AS source, id, offer_hash, transaction_hex,
       celestia_height::text AS l2_block_height,
       archive_reason, archived_at
FROM offer_file_history WHERE offer_hash = $1
ORDER BY source, id`;

const NULLIFIER_QUERY = `/* settlement-verifier:nullifiers */
SELECT h.nullifier AS marker, n.tx_hash
FROM offer_file_nullifiers_history h
LEFT JOIN nullifiers n ON n.nullifier = h.nullifier
WHERE h.offer_file_id = $1
ORDER BY h.nullifier, n.tx_hash NULLS FIRST`;

const COMMITMENT_QUERY = `/* settlement-verifier:commitments */
SELECT h.commitment AS marker, c.tx_hash
FROM offer_file_commitments_history h
LEFT JOIN commitments c ON c.commitment = h.commitment
WHERE h.offer_file_id = $1
ORDER BY h.commitment, c.tx_hash NULLS FIRST`;

function parseMarkerRows(rows: Record<string, unknown>[], path: string): MarkerRow[] {
  return rows.map((value, index) => {
    const row = recordAt(value, `${path}[${index}]`);
    exactKeys(row, ["marker", "tx_hash"], `${path}[${index}]`);
    return {
      marker: canonicalHex(row["marker"], `${path}[${index}].marker`),
      tx_hash: row["tx_hash"] === null
        ? null
        : canonicalTxHash(row["tx_hash"], `${path}[${index}].tx_hash`).canonical,
    };
  });
}

async function readDatabaseSettlement(
  executor: SettlementQueryExecutor,
  config: RealSettlementVerifierConfig,
  actor: ActorOracle,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<DatabaseSettlement> {
  await boundedQuery(executor, "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", [], config, signal, deadlineAt);
  let committed = false;
  try {
    const statementMs = Math.max(1, deadlineAt - Date.now());
    await boundedQuery(
      executor,
      "SELECT set_config('statement_timeout', $1, true)",
      [`${statementMs}ms`],
      config,
      signal,
      deadlineAt,
    );
    const offerRows = await boundedQuery(
      executor,
      OFFER_QUERY,
      [actor.offerHash],
      config,
      signal,
      deadlineAt,
    );
    if (offerRows.length === 0) throw new PendingSettlement("offer is not indexed yet");
    if (offerRows.length !== 1) {
      throw new Error(`offer hash appears in ${offerRows.length} live/history rows; expected exactly one`);
    }
    const offer = recordAt(offerRows[0], "database offer row");
    exactKeys(
      offer,
      ["source", "id", "offer_hash", "transaction_hex", "l2_block_height", "archive_reason", "archived_at"],
      "database offer row",
    );
    if (offer["source"] === "live") throw new PendingSettlement("offer remains live");
    if (offer["source"] !== "history") throw new Error("database offer row has an unknown source");
    if (offer["offer_hash"] !== actor.offerHash || offer["transaction_hex"] !== actor.offerBlob) {
      throw new Error("database history row hash/blob differs from the exact actor offer");
    }
    if (offer["archive_reason"] !== "CONSUMED") {
      throw new Error(`database terminal archive reason is ${String(offer["archive_reason"])}, not CONSUMED`);
    }
    const offerFileId = canonicalSafeInteger(offer["id"], "database offer row.id", 1);
    const l2BlockHeight = stringAt(
      String(offer["l2_block_height"]),
      "database offer row.l2_block_height",
      /^[1-9][0-9]*$/,
      32,
    );
    const archivedAt = canonicalIso(offer["archived_at"], "database offer row.archived_at");
    const nullifierRows = parseMarkerRows(
      await boundedQuery(executor, NULLIFIER_QUERY, [offerFileId], config, signal, deadlineAt),
      "database nullifier rows",
    );
    const commitmentRows = parseMarkerRows(
      await boundedQuery(executor, COMMITMENT_QUERY, [offerFileId], config, signal, deadlineAt),
      "database commitment rows",
    );
    exactStringMultiset(
      nullifierRows.map(({ marker }) => marker),
      actor.expectedNullifiers,
      "database nullifier history multiset",
    );
    exactStringMultiset(
      commitmentRows.map(({ marker }) => marker),
      actor.expectedCommitments,
      "database commitment history multiset",
    );
    if ([...nullifierRows, ...commitmentRows].some(({ tx_hash }) => tx_hash === null)) {
      throw new Error("one or more settlement markers have no chain transaction hash");
    }
    const transactionHashes = new Set(
      [...nullifierRows, ...commitmentRows].map(({ tx_hash }) => tx_hash!),
    );
    if (transactionHashes.size !== 1) {
      throw new Error(`settlement markers span ${transactionHashes.size} transaction hashes; expected exactly one`);
    }
    const settlementTxHash = [...transactionHashes][0]!;
    await boundedQuery(executor, "COMMIT", [], config, signal, deadlineAt);
    committed = true;
    return {
      offerFileId,
      offerHash: actor.offerHash,
      transactionHex: actor.offerBlob,
      l2BlockHeight,
      archiveReason: "CONSUMED",
      archivedAt,
      settlementTxHash,
      nullifiers: nullifierRows.map(({ marker, tx_hash }) => ({ marker, txHash: tx_hash! })),
      commitments: commitmentRows.map(({ marker, tx_hash }) => ({ marker, txHash: tx_hash! })),
    };
  } finally {
    if (!committed) {
      await withAbsoluteDeadline(signal, deadlineAt, () => executor.query("ROLLBACK")).catch(() => undefined);
    }
  }
}

async function boundedHttpJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await response.body?.cancel("bounded settlement response rejected").catch(() => undefined);
    throw new Error(`backend response exceeds ${maximumBytes} bytes or has malformed Content-Length`);
  }
  if (!response.body) throw new Error("backend response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await withAbsoluteDeadline(signal, deadlineAt, () => reader.read());
      if (next.done) break;
      length += next.value.length;
      if (length > maximumBytes) {
        await reader.cancel("bounded settlement response rejected").catch(() => undefined);
        throw new Error(`backend response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel("settlement response read interrupted").catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("backend returned invalid UTF-8 JSON", { cause: error });
  }
}

async function readBackendConsumedStatus(
  config: RealSettlementVerifierConfig,
  offerHash: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<"consumed"> {
  const url = `${config.backendUrl}/v1/offers/${offerHash}/status`;
  const response = await withAbsoluteDeadline(signal, deadlineAt, () =>
    fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal,
    })
  );
  if (response.status !== 200) {
    await response.body?.cancel("unexpected backend status").catch(() => undefined);
    throw new Error(`backend status endpoint returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    await response.body?.cancel("unexpected backend content type").catch(() => undefined);
    throw new Error("backend status endpoint returned a non-JSON content type");
  }
  const decoded = recordAt(
    await boundedHttpJson(response, config.maxHttpBytes, signal, deadlineAt),
    "backend status response",
  );
  exactKeys(decoded, ["offerId", "status"], "backend status response");
  if (decoded["offerId"] !== offerHash) throw new Error("backend status response is bound to another offer");
  if (decoded["status"] === "live" || decoded["status"] === "not_found") {
    throw new PendingSettlement(`backend status is ${decoded["status"]}`);
  }
  if (decoded["status"] !== "consumed") {
    throw new Error(`backend terminal status is ${String(decoded["status"])}, not consumed`);
  }
  return "consumed";
}

async function atomicPrivateJson(
  path: string,
  value: unknown,
  cleanup: SettlementVerifierCleanup,
  deadlineAt: number,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  cleanup.temporaryPaths.add(temporary);
  let handle;
  let linked = false;
  let temporaryDevice: number | undefined;
  let temporaryInode: number | undefined;
  try {
    if (cleanup.signal.aborted) throw cleanup.signal.reason;
    if (Date.now() >= deadlineAt) throw deadlineError();
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const temporaryMetadata = await handle.stat();
    if (!temporaryMetadata.isFile() || (temporaryMetadata.mode & 0o777) !== 0o600) {
      throw new Error("settlement evidence temporary is not a regular mode-0600 file");
    }
    temporaryDevice = temporaryMetadata.dev;
    temporaryInode = temporaryMetadata.ino;
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    if (cleanup.signal.aborted) throw cleanup.signal.reason;
    if (Date.now() >= deadlineAt) throw deadlineError();
    await link(temporary, path);
    linked = true;
    // Treat the final hard link as tentative until fsync + O_NOFOLLOW inode
    // verification complete, so concurrent signal cleanup cannot strand it.
    cleanup.temporaryPaths.add(path);
    await unlink(temporary);
    cleanup.temporaryPaths.delete(temporary);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    if (cleanup.signal.aborted) throw cleanup.signal.reason;
    if (Date.now() >= deadlineAt) throw deadlineError();
    const publishedHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await publishedHandle.stat();
      if (
        !metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
        metadata.dev !== temporaryDevice || metadata.ino !== temporaryInode
      ) {
        throw new Error("settlement evidence is not the exact regular mode-0600 hard link");
      }
    } finally {
      await publishedHandle.close();
    }
    cleanup.temporaryPaths.delete(path);
  } catch (error) {
    if (linked) {
      cleanup.temporaryPaths.delete(path);
      await unlink(path).catch(() => undefined);
    }
    throw new Error(`could not atomically publish settlement evidence: ${errorMessage(error)}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    if (cleanup.temporaryPaths.delete(temporary)) await unlink(temporary).catch(() => undefined);
  }
}

export async function verifyRealBackendSettlement(
  config: RealSettlementVerifierConfig,
  executor: SettlementQueryExecutor,
  options: {
    fetchImpl?: FetchLike;
    cleanup?: SettlementVerifierCleanup;
    signal?: AbortSignal;
    deadlineAt?: number;
  } = {},
): Promise<RealBackendSettlementEvidence> {
  const cleanup = options.cleanup ?? createIdempotentSettlementVerifierCleanup();
  const signal = options.signal ?? cleanup.signal;
  const deadlineAt = options.deadlineAt ?? Date.now() + config.deadlineMs;
  const [actorArtifact, solverArtifact, publicationArtifact] = await withAbsoluteDeadline(
    signal,
    deadlineAt,
    () => Promise.all([
      readSealedCanonicalJson(config.actorPath, config.maxArtifactBytes, "actor artifact"),
      readSealedCanonicalJson(config.solverPath, config.maxArtifactBytes, "solver artifact"),
      readSealedCanonicalJson(config.publisherPath, config.maxArtifactBytes, "publication artifact"),
    ]),
  );
  const actor = parseActorArtifact(actorArtifact, config);
  const solver = parseSolverArtifact(solverArtifact, config, actor);
  const publication = parsePublicationArtifact(publicationArtifact, config, actor);

  let attempts = 0;
  let database!: DatabaseSettlement;
  let backendStatus!: "consumed";
  while (true) {
    attempts++;
    const [databaseAttempt, backendAttempt] = await Promise.allSettled([
      readDatabaseSettlement(executor, config, actor, signal, deadlineAt),
      readBackendConsumedStatus(
        config,
        actor.offerHash,
        options.fetchImpl ?? fetch,
        signal,
        deadlineAt,
      ),
    ]);
    const fatal = [databaseAttempt, backendAttempt].find(
      (result) => result.status === "rejected" && !(result.reason instanceof PendingSettlement),
    );
    if (fatal?.status === "rejected") throw fatal.reason;
    if (databaseAttempt.status === "fulfilled" && backendAttempt.status === "fulfilled") {
      database = databaseAttempt.value;
      backendStatus = backendAttempt.value;
      break;
    }
    {
      if (Date.now() >= deadlineAt) throw deadlineError();
      await abortableSleep(config.pollMs, signal, deadlineAt);
    }
  }
  if (database.settlementTxHash !== solver.transactionHash) {
    throw new Error(
      `solver submitted transaction ${solver.transactionHash} differs from database settlement ${database.settlementTxHash}`,
    );
  }
  const backend = new URL(config.backendUrl);
  const evidence: RealBackendSettlementEvidence = {
    schema: EVIDENCE_SCHEMA,
    runId: config.runId,
    recordedAt: nowIso(),
    sources: {
      actor: { schema: ACTOR_SCHEMA, sha256: actor.fileSha256 },
      solver: { schema: SOLVER_SCHEMA, sha256: solver.fileSha256 },
      publication: { schema: PUBLICATION_SCHEMA, sha256: publication.fileSha256 },
    },
    offer: {
      offerFileId: database.offerFileId,
      offerHash: database.offerHash,
      transactionHex: database.transactionHex,
      transactionHexSha256: sha256(database.transactionHex),
      rawOfferSha256: actor.offerHash,
      l2BlockHeight: database.l2BlockHeight,
      archiveReason: database.archiveReason,
      archivedAt: database.archivedAt,
      backendStatus,
      publicationHeight: publication.submittedHeight,
      publicationCommitmentBase64: publication.commitmentBase64,
    },
    settlement: {
      transactionHash: database.settlementTxHash,
      expectedNullifiers: Object.freeze([...actor.expectedNullifiers]),
      observedNullifiers: Object.freeze(database.nullifiers),
      expectedCommitments: Object.freeze([...actor.expectedCommitments]),
      observedCommitments: Object.freeze(database.commitments),
      distinctMarkerTransactionHashes: [database.settlementTxHash],
      solver: {
        reportedTransactionHash: solver.reportedTransactionHash,
        canonicalTransactionHash: solver.transactionHash,
        submissionCount: solver.submissionCount,
        submitBoundaryCalls: solver.submitBoundaryCalls,
        submissionBlobHash: solver.submissionBlobHash,
        submissionBlobBytes: solver.submissionBlobBytes,
        protocolFee: {
          asset: "DUST",
          specks: solver.protocolFeeSpecks,
          source: "wallet.calculateTransactionFee",
        },
        telemetryCount: solver.telemetryCount,
        lastCentralSequence: solver.lastCentralSequence,
      },
    },
    observation: {
      backend: {
        protocol: backend.protocol as "http:" | "https:",
        hostname: backend.hostname,
        port: backend.port,
        pathnameSha256: sha256(backend.pathname),
      },
      postgres: {
        hostSha256: sha256(config.database.host),
        port: config.database.port,
        databaseSha256: sha256(config.database.name),
        isolation: "repeatable-read-read-only",
      },
      attempts,
      deadlineMs: config.deadlineMs,
    },
    checks: [
      "sealed-artifacts-cross-bound",
      "exact-history-row-hash-and-blob",
      "backend-terminal-status-consumed",
      "exact-nullifier-multiset",
      "exact-commitment-multiset",
      "all-markers-share-one-non-null-transaction",
      "solver-transaction-equals-database-transaction",
      "exactly-one-solver-submit",
      "exact-path-a-wallet-boundary-matrix",
      "terminal-stock-claim-and-capacity-released",
    ],
  };
  if (signal.aborted) throw signal.reason;
  await withAbsoluteDeadline(signal, deadlineAt, () =>
    atomicPrivateJson(config.evidencePath, evidence, cleanup, deadlineAt)
  );
  return evidence;
}

interface RealPgHandle extends SettlementQueryExecutor {
  close: () => Promise<void>;
}

async function connectRealPostgres(
  config: RealSettlementVerifierConfig,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<RealPgHandle> {
  const { Client } = await withAbsoluteDeadline(signal, deadlineAt, () => import("pg"));
  const client = new Client({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
    ssl: false,
    application_name: `zswap-e1-settlement-${config.runId}`,
    connectionTimeoutMillis: Math.max(1, Math.min(config.deadlineMs, deadlineAt - Date.now())),
    query_timeout: config.deadlineMs,
    statement_timeout: config.deadlineMs,
  });
  try {
    await withAbsoluteDeadline(signal, deadlineAt, () => client.connect());
  } catch (error) {
    await Promise.resolve(client.end()).catch(() => undefined);
    throw error;
  }
  let closed: Promise<void> | null = null;
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<SettlementQueryResult<Row>> {
      const result = await client.query(text, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
    close: () => {
      if (!closed) closed = client.end();
      return closed;
    },
  };
}

function parseCommand(argv: readonly string[]): void {
  if (argv.length !== 1 || argv[0] !== "verify") {
    throw new Error("usage: solver-offerfiles-real-settlement-verifier.ts verify");
  }
}

export async function runRealSettlementVerifierCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const cleanup = createIdempotentSettlementVerifierCleanup();
  let receivedSignal: SignalName | null = null;
  const receive = (signal: SignalName): void => {
    receivedSignal ??= signal;
    cleanup.abort(new Error(`real settlement verifier received ${signal}`));
  };
  const onSigint = (): void => receive("SIGINT");
  const onSigterm = (): void => receive("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let failure: unknown = null;
  let evidence: RealBackendSettlementEvidence | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    parseCommand(argv);
    const config = readRealSettlementVerifierConfig(env);
    const deadlineAt = Date.now() + config.deadlineMs;
    deadlineTimer = setTimeout(() => cleanup.abort(deadlineError()), config.deadlineMs);
    const postgres = await connectRealPostgres(config, cleanup.signal, deadlineAt);
    cleanup.addCloser(postgres.close);
    evidence = await verifyRealBackendSettlement(config, postgres, {
      cleanup,
      signal: cleanup.signal,
      deadlineAt,
    });
  } catch (error) {
    failure = error;
  }
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  try {
    await cleanup.cleanup();
  } catch (error) {
    failure = failure === null
      ? error
      : new AggregateError([failure, error], "settlement verification and cleanup both failed");
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (receivedSignal) {
    console.error(`[real-settlement-verifier] ${receivedSignal}; cleanup complete`);
    return realSettlementVerifierSignalExitCode(receivedSignal);
  }
  if (failure !== null) {
    console.error(`[real-settlement-verifier] failed: ${errorMessage(failure)}`);
    return 1;
  }
  console.log(JSON.stringify({
    status: "backend-settlement-verified",
    runId: evidence!.runId,
    offerHash: evidence!.offer.offerHash,
    transactionHash: evidence!.settlement.transactionHash,
    submissionCount: evidence!.settlement.solver.submissionCount,
  }));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runRealSettlementVerifierCli();
}
