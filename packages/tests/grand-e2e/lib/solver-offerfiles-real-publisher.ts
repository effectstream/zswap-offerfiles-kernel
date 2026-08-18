/**
 * Direct-Celestia publisher for the real Offer Files solver E2 acceptance run.
 *
 * This is deliberately a test-only actor. It reads the provisioner's sealed
 * manifest, publishes either that manifest's exact raw MIP-0005 bytes or one
 * explicitly supplied bounded garbage blob, and proves the write through
 * independent Celestia reads before it emits evidence.
 *
 * CLI:
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts publish-offer
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-publisher.ts publish-garbage
 *
 * Required environment:
 *   E1_RUN_ID
 *   E1_ACTOR_RESULT_PATH          absolute, regular, private actor manifest
 *   E1_PUBLISHER_EVIDENCE_PATH   absolute, must not already exist
 *   E1_CELESTIA_RPC_URL          HTTP(S) Celestia light/bridge JSON-RPC URL
 *
 * Optional environment:
 *   E1_CELESTIA_AUTH_TOKEN       Bearer token (CELESTIA_AUTH_TOKEN fallback)
 *   E1_EXPECTED_NETWORK_ID       defaults to undeployed
 *   E1_PUBLISHER_DEADLINE_MS     one absolute deadline, defaults to 120000
 *   E1_PUBLISHER_VERIFY_POLL_MS  defaults to 500
 *   E1_PUBLISHER_MAX_RESPONSE_BYTES defaults to 2097152
 *   E1_PUBLISHER_MAX_MANIFEST_BYTES defaults to 4194304
 *   E1_PUBLISHER_MAX_OFFER_BYTES defaults to 1048576
 *   E1_CELESTIA_GAS_PRICE        defaults to 0.002
 *
 * publish-garbage additionally requires:
 *   E1_PUBLISHER_RAW_BLOB_BASE64 canonical standard base64, one non-empty blob
 *   E1_PUBLISHER_GARBAGE_LABEL   safe evidence label
 * and accepts E1_PUBLISHER_GARBAGE_MAX_BYTES (default/cap 65536/1048576).
 */

import { constants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  stat,
  unlink,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { mip6NamespaceBytes } from "@zswap-da/offer-guard";

const ACTOR_SCHEMA = "zswap-offer-files-real-actors/v1";
const EVIDENCE_SCHEMA = "zswap-offer-files-real-celestia-publication/v1";
const NIGHT = "0".repeat(64);
const MAX_CONFIGURED_DEADLINE_MS = 10 * 60_000;
const MAX_CONFIGURED_BODY_BYTES = 8 * 1024 * 1024;
/** Hard cap on the body prefix a refusal may quote back. Diagnosis only. */
const REFUSAL_EVIDENCE_BYTES = 512;
const HARD_MAX_OFFER_BYTES = 1024 * 1024;
const HARD_MAX_GARBAGE_BYTES = 1024 * 1024;
const COMMITMENT_BYTES = 32;

export type RealPublisherMode = "offer" | "garbage";

export interface RealPublisherConfig {
  runId: string;
  mode: RealPublisherMode;
  actorManifestPath: string;
  evidencePath: string;
  expectedNetworkId: string;
  rpcUrl: string;
  authToken: string | null;
  deadlineMs: number;
  verifyPollMs: number;
  maxResponseBytes: number;
  maxManifestBytes: number;
  maxOfferBytes: number;
  gasPrice: number;
  gasPriceSource: string;
  garbage: null | {
    label: string;
    bytes: Uint8Array;
    maxBytes: number;
  };
}

interface BalanceActor {
  shielded: Record<string, string>;
  unshielded: Record<string, string>;
  dust: string;
}

interface BalanceSnapshot {
  capturedAt: string;
  user: BalanceActor;
  solver: BalanceActor;
}

interface ValidatedActorManifest {
  schema: typeof ACTOR_SCHEMA;
  runId: string;
  networkId: string;
  createdAt: string;
  tokens: { A: string; B: string; NIGHT: string };
  funding: {
    mintAmount: string;
    userTokenAAmount: string;
    solverTokenBAmount: string;
  };
  balances: {
    beforeSettlement: BalanceSnapshot;
    expectedAfterSettlement: {
      user: { A: string; B: string };
      solver: { A: string; B: string };
    };
  };
  offer: {
    offerBlob: string;
    offerHash: string;
    transactionHash: string;
    gives: Array<{ token: string; amount: string; kind: "SHIELDED" }>;
    wants: Array<{ token: string; amount: string; kind: "SHIELDED" }>;
  };
  rawOfferBytes: Uint8Array;
  manifestSha256: string;
}

interface ParsedCelestiaBlob {
  namespaceBase64: string;
  dataBase64: string;
  data: Uint8Array;
  sha256: string;
  commitmentBase64: string;
  commitment: Uint8Array;
  shareVersion: 0;
  index: number | null;
}

export interface RealCelestiaPublicationEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  runId: string;
  mode: RealPublisherMode;
  recordedAt: string;
  actorManifest: {
    schema: typeof ACTOR_SCHEMA;
    sha256: string;
    networkId: string;
    createdAt: string;
    offerHash: string;
    offerTransactionHash: string;
  };
  payload: {
    source: "actor-manifest.offer.offerBlob" | "explicit-raw-garbage-base64";
    garbageLabel: string | null;
    byteLength: number;
    sha256: string;
    dataBase64: string;
  };
  celestia: {
    rpcEndpoint: {
      protocol: "http:" | "https:";
      hostname: string;
      port: string;
      pathnameSha256: string;
      hasQuery: boolean;
      bearerAuth: boolean;
    };
    namespaceBase64: string;
    shareVersion: 0;
    gasPrice: string;
    submittedHeight: number;
    observedHeaderHeight: number;
    commitmentBase64: string;
    commitmentSha256: string;
  };
  verification: {
    absoluteDeadlineMs: number;
    networkHeadAttempts: number;
    getAllAttempts: number;
    exactMatchesAtHeight: 1;
    observedByteLength: number;
    observedSha256: string;
    getByCommitmentSha256: string;
    checks: readonly [
      "submitted-height-has-exact-header",
      "namespace-and-share-version-match",
      "exactly-one-byte-identical-blob-at-height",
      "sha256-matches-submitted-bytes",
      "commitment-resolves-to-byte-identical-blob",
    ];
  };
}

export interface PublisherCleanup {
  signal: AbortSignal;
  temporaryPaths: Set<string>;
  abort: (reason?: unknown) => void;
  cleanup: () => Promise<void>;
}

type FetchLike = typeof fetch;

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const nowIso = (): string => new Date().toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A call that reached HTTP 200: either a parsed result, or case (iii). */
type CelestiaCallOutcome =
  | { parsed: true; result: unknown }
  | { parsed: false; evidence: string };

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON.stringify that cannot itself throw on a cyclic or exotic value. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
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

function canonicalIso(value: unknown, path: string): string {
  const text = stringAt(value, path, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 24);
  if (new Date(text).toISOString() !== text) throw new Error(`${path} is not a valid canonical UTC timestamp`);
  return text;
}

function canonicalUnsigned(value: unknown, path: string): string {
  return stringAt(value, path, /^(?:0|[1-9][0-9]*)$/, 128);
}

function canonicalPositive(value: unknown, path: string): string {
  return stringAt(value, path, /^[1-9][0-9]*$/, 128);
}

function canonicalHex(value: unknown, path: string, exactLength?: number): string {
  const pattern = exactLength === undefined
    ? /^(?:[0-9a-f]{2})+$/
    : new RegExp(`^[0-9a-f]{${exactLength}}$`);
  return stringAt(value, path, pattern, exactLength ?? 4096);
}

function canonicalIdentity(value: unknown, path: string): string {
  return stringAt(value, path, /^[\x21-\x7e]+$/, 1024);
}

function canonicalStringArray(
  value: unknown,
  path: string,
  item: (value: unknown, path: string) => string,
  options: { min?: number; max?: number; sorted?: boolean } = {},
): string[] {
  const min = options.min ?? 0;
  const max = options.max ?? 512;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${path} must contain between ${min} and ${max} entries`);
  }
  const parsed = value.map((entry, index) => item(entry, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} must not contain duplicates`);
  if (options.sorted && parsed.some((entry, index) => index > 0 && parsed[index - 1]! > entry)) {
    throw new Error(`${path} must be sorted canonically`);
  }
  return parsed;
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

function requireAbsolutePath(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function requireRunId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) {
    throw new Error("E1_RUN_ID must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}");
  }
  return value;
}

function parseCanonicalBase64(value: unknown, path: string, maximumBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new Error(`${path} must be non-empty padded standard base64`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${path} must be canonical standard base64`);
  }
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (decoded.length === 0 || decoded.length > maximumBytes) {
    throw new Error(`${path} decoded length must be in [1, ${maximumBytes}]`);
  }
  if (Buffer.from(decoded).toString("base64") !== value) {
    throw new Error(`${path} is not canonical standard base64`);
  }
  return decoded;
}

function parseRpcUrl(value: string | undefined): URL {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("E1_CELESTIA_RPC_URL must be a bounded HTTP(S) URL without whitespace");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("E1_CELESTIA_RPC_URL is not a valid URL", { cause: error });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.hash) {
    throw new Error("E1_CELESTIA_RPC_URL must be an HTTP(S) URL without a fragment");
  }
  if (url.username || url.password) {
    throw new Error("E1_CELESTIA_RPC_URL must not contain user-info; use the bearer-token variable");
  }
  return url;
}

function optionalAuthToken(
  primary: string | undefined,
  fallback: string | undefined,
): string | null {
  if (primary !== undefined && fallback !== undefined && primary !== fallback) {
    throw new Error("E1_CELESTIA_AUTH_TOKEN and CELESTIA_AUTH_TOKEN disagree");
  }
  const value = primary ?? fallback;
  if (value === undefined || value === "") return null;
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Celestia bearer token contains forbidden control bytes or is too long");
  }
  return value;
}

function gasPrice(value: string | undefined): { number: number; source: string } {
  const raw = value ?? "0.002";
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/.test(raw)) {
    throw new Error("E1_CELESTIA_GAS_PRICE must be a canonical non-negative decimal");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("E1_CELESTIA_GAS_PRICE must be finite and at most 10000");
  }
  return { number: parsed, source: raw };
}

export function readRealPublisherConfig(
  mode: RealPublisherMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealPublisherConfig {
  const actorManifestPath = requireAbsolutePath("E1_ACTOR_RESULT_PATH", env["E1_ACTOR_RESULT_PATH"]);
  const evidencePath = requireAbsolutePath(
    "E1_PUBLISHER_EVIDENCE_PATH",
    env["E1_PUBLISHER_EVIDENCE_PATH"],
  );
  if (actorManifestPath === evidencePath) {
    throw new Error("actor manifest and publisher evidence paths must differ");
  }
  const parsedUrl = parseRpcUrl(env["E1_CELESTIA_RPC_URL"] ?? env["CELESTIA_RPC_URL"]);
  const parsedGasPrice = gasPrice(env["E1_CELESTIA_GAS_PRICE"]);
  const maxOfferBytes = positiveIntegerEnv(
    "E1_PUBLISHER_MAX_OFFER_BYTES",
    env["E1_PUBLISHER_MAX_OFFER_BYTES"],
    HARD_MAX_OFFER_BYTES,
    HARD_MAX_OFFER_BYTES,
  );

  let garbage: RealPublisherConfig["garbage"] = null;
  if (mode === "garbage") {
    const maxBytes = positiveIntegerEnv(
      "E1_PUBLISHER_GARBAGE_MAX_BYTES",
      env["E1_PUBLISHER_GARBAGE_MAX_BYTES"],
      64 * 1024,
      HARD_MAX_GARBAGE_BYTES,
    );
    const label = stringAt(
      env["E1_PUBLISHER_GARBAGE_LABEL"],
      "E1_PUBLISHER_GARBAGE_LABEL",
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/,
      96,
    );
    garbage = {
      label,
      bytes: parseCanonicalBase64(
        env["E1_PUBLISHER_RAW_BLOB_BASE64"],
        "E1_PUBLISHER_RAW_BLOB_BASE64",
        maxBytes,
      ),
      maxBytes,
    };
  } else if (
    env["E1_PUBLISHER_RAW_BLOB_BASE64"] !== undefined ||
    env["E1_PUBLISHER_GARBAGE_LABEL"] !== undefined ||
    env["E1_PUBLISHER_GARBAGE_MAX_BYTES"] !== undefined
  ) {
    throw new Error("garbage publication variables are forbidden in publish-offer mode");
  }

  return {
    runId: requireRunId(env["E1_RUN_ID"]),
    mode,
    actorManifestPath,
    evidencePath,
    expectedNetworkId: stringAt(
      env["E1_EXPECTED_NETWORK_ID"] ?? "undeployed",
      "E1_EXPECTED_NETWORK_ID",
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/,
      64,
    ),
    rpcUrl: parsedUrl.toString(),
    authToken: optionalAuthToken(
      env["E1_CELESTIA_AUTH_TOKEN"],
      env["CELESTIA_AUTH_TOKEN"],
    ),
    deadlineMs: positiveIntegerEnv(
      "E1_PUBLISHER_DEADLINE_MS",
      env["E1_PUBLISHER_DEADLINE_MS"],
      120_000,
      MAX_CONFIGURED_DEADLINE_MS,
      1_000,
    ),
    verifyPollMs: positiveIntegerEnv(
      "E1_PUBLISHER_VERIFY_POLL_MS",
      env["E1_PUBLISHER_VERIFY_POLL_MS"],
      500,
      10_000,
      10,
    ),
    maxResponseBytes: positiveIntegerEnv(
      "E1_PUBLISHER_MAX_RESPONSE_BYTES",
      env["E1_PUBLISHER_MAX_RESPONSE_BYTES"],
      2 * 1024 * 1024,
      MAX_CONFIGURED_BODY_BYTES,
      1024,
    ),
    maxManifestBytes: positiveIntegerEnv(
      "E1_PUBLISHER_MAX_MANIFEST_BYTES",
      env["E1_PUBLISHER_MAX_MANIFEST_BYTES"],
      4 * 1024 * 1024,
      MAX_CONFIGURED_BODY_BYTES,
      1024,
    ),
    maxOfferBytes,
    gasPrice: parsedGasPrice.number,
    gasPriceSource: parsedGasPrice.source,
    garbage,
  };
}

function validateTokenMap(value: unknown, path: string): Record<string, string> {
  const record = recordAt(value, path);
  if (Object.keys(record).length > 256) throw new Error(`${path} has too many token entries`);
  const parsed: Record<string, string> = {};
  for (const [token, amount] of Object.entries(record)) {
    canonicalHex(token, `${path} token`, 64);
    parsed[token] = canonicalUnsigned(amount, `${path}.${token}`);
  }
  return parsed;
}

function validateBalanceActor(value: unknown, path: string): BalanceActor {
  const record = recordAt(value, path);
  exactKeys(record, ["shielded", "unshielded", "dust"], path);
  return {
    shielded: validateTokenMap(record["shielded"], `${path}.shielded`),
    unshielded: validateTokenMap(record["unshielded"], `${path}.unshielded`),
    dust: canonicalUnsigned(record["dust"], `${path}.dust`),
  };
}

function validateBalanceSnapshot(value: unknown, path: string): BalanceSnapshot {
  const record = recordAt(value, path);
  exactKeys(record, ["capturedAt", "user", "solver"], path);
  return {
    capturedAt: canonicalIso(record["capturedAt"], `${path}.capturedAt`),
    user: validateBalanceActor(record["user"], `${path}.user`),
    solver: validateBalanceActor(record["solver"], `${path}.solver`),
  };
}

function validateTransactionOracle(value: unknown, path: string): void {
  const record = recordAt(value, path);
  exactKeys(record, ["hash", "identifiers"], path);
  canonicalIdentity(record["hash"], `${path}.hash`);
  canonicalStringArray(record["identifiers"], `${path}.identifiers`, canonicalIdentity, {
    min: 1,
    sorted: true,
  });
}

function validateActorManifestShape(
  decoded: unknown,
  config: RealPublisherConfig,
  manifestSha256: string,
): ValidatedActorManifest {
  const root = recordAt(decoded, "actor manifest");
  exactKeys(
    root,
    ["schema", "runId", "networkId", "createdAt", "actors", "tokens", "funding", "balances", "offer", "ladder"],
    "actor manifest",
  );
  if (root["schema"] !== ACTOR_SCHEMA || root["runId"] !== config.runId) {
    throw new Error("actor manifest has the wrong schema or run ID");
  }
  if (root["networkId"] !== config.expectedNetworkId) {
    throw new Error("actor manifest has the wrong Midnight network ID");
  }
  const createdAt = canonicalIso(root["createdAt"], "actor manifest.createdAt");

  const actors = recordAt(root["actors"], "actor manifest.actors");
  exactKeys(actors, ["genesis", "user", "solver"], "actor manifest.actors");
  for (const actor of ["genesis", "user", "solver"] as const) {
    const record = recordAt(actors[actor], `actor manifest.actors.${actor}`);
    exactKeys(record, ["seedFingerprint"], `actor manifest.actors.${actor}`);
    canonicalHex(record["seedFingerprint"], `actor manifest.actors.${actor}.seedFingerprint`, 16);
  }
  const fingerprints = (["genesis", "user", "solver"] as const).map((actor) =>
    (actors[actor] as Record<string, unknown>)["seedFingerprint"] as string
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("actor manifest seed fingerprints must be distinct");
  }

  const tokenRecord = recordAt(root["tokens"], "actor manifest.tokens");
  exactKeys(tokenRecord, ["A", "B", "NIGHT"], "actor manifest.tokens");
  const tokens = {
    A: canonicalHex(tokenRecord["A"], "actor manifest.tokens.A", 64),
    B: canonicalHex(tokenRecord["B"], "actor manifest.tokens.B", 64),
    NIGHT: canonicalHex(tokenRecord["NIGHT"], "actor manifest.tokens.NIGHT", 64),
  };
  if (tokens.A === tokens.B || tokens.A === NIGHT || tokens.B === NIGHT || tokens.NIGHT !== NIGHT) {
    throw new Error("actor manifest token identities are invalid or aliased");
  }

  const fundingRecord = recordAt(root["funding"], "actor manifest.funding");
  exactKeys(
    fundingRecord,
    [
      "mintAmount",
      "userTokenAAmount",
      "solverTokenBAmount",
      "nightPerUtxo",
      "nightUtxosPerActor",
      "nightFundingTransaction",
      "tokenFundingTransactions",
    ],
    "actor manifest.funding",
  );
  const funding = {
    mintAmount: canonicalPositive(fundingRecord["mintAmount"], "actor manifest.funding.mintAmount"),
    userTokenAAmount: canonicalPositive(
      fundingRecord["userTokenAAmount"],
      "actor manifest.funding.userTokenAAmount",
    ),
    solverTokenBAmount: canonicalPositive(
      fundingRecord["solverTokenBAmount"],
      "actor manifest.funding.solverTokenBAmount",
    ),
  };
  canonicalPositive(fundingRecord["nightPerUtxo"], "actor manifest.funding.nightPerUtxo");
  if (
    typeof fundingRecord["nightUtxosPerActor"] !== "number" ||
    !Number.isSafeInteger(fundingRecord["nightUtxosPerActor"]) ||
    fundingRecord["nightUtxosPerActor"] < 1 ||
    fundingRecord["nightUtxosPerActor"] > 4
  ) {
    throw new Error("actor manifest.funding.nightUtxosPerActor must be an integer in [1, 4]");
  }
  validateTransactionOracle(
    fundingRecord["nightFundingTransaction"],
    "actor manifest.funding.nightFundingTransaction",
  );
  if (!Array.isArray(fundingRecord["tokenFundingTransactions"]) || fundingRecord["tokenFundingTransactions"].length !== 2) {
    throw new Error("actor manifest must have exactly two token funding transactions");
  }
  const fundingTokens = new Set<string>();
  fundingRecord["tokenFundingTransactions"].forEach((entry, index) => {
    const record = recordAt(entry, `actor manifest.funding.tokenFundingTransactions[${index}]`);
    exactKeys(record, ["token", "hash", "identifiers"], `actor manifest.funding.tokenFundingTransactions[${index}]`);
    if (record["token"] !== "A" && record["token"] !== "B") {
      throw new Error(`actor manifest.funding.tokenFundingTransactions[${index}].token must be A or B`);
    }
    if (fundingTokens.has(record["token"])) throw new Error("actor manifest token funding transactions are duplicated");
    fundingTokens.add(record["token"]);
    canonicalIdentity(record["hash"], `actor manifest.funding.tokenFundingTransactions[${index}].hash`);
    canonicalStringArray(
      record["identifiers"],
      `actor manifest.funding.tokenFundingTransactions[${index}].identifiers`,
      canonicalIdentity,
      { min: 1, sorted: true },
    );
  });

  const balancesRecord = recordAt(root["balances"], "actor manifest.balances");
  exactKeys(
    balancesRecord,
    ["beforeFunding", "beforeSettlement", "expectedAfterSettlement", "dustBalanceEvidence"],
    "actor manifest.balances",
  );
  validateBalanceSnapshot(balancesRecord["beforeFunding"], "actor manifest.balances.beforeFunding");
  const beforeSettlement = validateBalanceSnapshot(
    balancesRecord["beforeSettlement"],
    "actor manifest.balances.beforeSettlement",
  );
  if (BigInt(beforeSettlement.solver.dust) <= 0n) {
    throw new Error("actor manifest must prove a positive solver DUST balance");
  }
  const expectedRecord = recordAt(
    balancesRecord["expectedAfterSettlement"],
    "actor manifest.balances.expectedAfterSettlement",
  );
  exactKeys(expectedRecord, ["user", "solver"], "actor manifest.balances.expectedAfterSettlement");
  const expectedActors = {} as Record<"user" | "solver", { A: string; B: string }>;
  for (const actor of ["user", "solver"] as const) {
    const record = recordAt(expectedRecord[actor], `actor manifest.balances.expectedAfterSettlement.${actor}`);
    exactKeys(record, ["A", "B"], `actor manifest.balances.expectedAfterSettlement.${actor}`);
    expectedActors[actor] = {
      A: canonicalUnsigned(record["A"], `actor manifest.balances.expectedAfterSettlement.${actor}.A`),
      B: canonicalUnsigned(record["B"], `actor manifest.balances.expectedAfterSettlement.${actor}.B`),
    };
  }
  const dust = recordAt(balancesRecord["dustBalanceEvidence"], "actor manifest.balances.dustBalanceEvidence");
  exactKeys(dust, ["actor", "asset", "balanceSource", "before", "after", "delta", "interpretation"], "actor manifest.balances.dustBalanceEvidence");
  if (
    dust["actor"] !== "solver" ||
    dust["asset"] !== "DUST" ||
    dust["balanceSource"] !== "wallet.dust.state/waitForDustFunds" ||
    dust["before"] !== beforeSettlement.solver.dust ||
    dust["after"] !== null ||
    dust["delta"] !== null ||
    dust["interpretation"] !== "net-balance-delta-not-exact-fee"
  ) {
    throw new Error("actor manifest has an invalid DUST balance oracle");
  }

  const offerRecord = recordAt(root["offer"], "actor manifest.offer");
  exactKeys(
    offerRecord,
    [
      "offerBlob",
      "offerHash",
      "transactionHash",
      "identifiers",
      "expectedNullifiers",
      "expectedCommitments",
      "inputRoots",
      "gives",
      "wants",
      "expiresAt",
    ],
    "actor manifest.offer",
  );
  const offerBlob = stringAt(
    offerRecord["offerBlob"],
    "actor manifest.offer.offerBlob",
    /^swapoffer1[0-9a-z]+$/,
    Math.ceil(config.maxOfferBytes * 1.7) + 128,
  );
  let rawOfferBytes: Uint8Array;
  try {
    rawOfferBytes = Uint8Array.from(OfferFiles.decode(offerBlob));
  } catch (error) {
    throw new Error("actor manifest offerBlob is not a decodable MIP-0005 offer", { cause: error });
  }
  if (rawOfferBytes.length === 0 || rawOfferBytes.length > config.maxOfferBytes) {
    throw new Error(`actor manifest raw offer must be in [1, ${config.maxOfferBytes}] bytes`);
  }
  if (OfferFiles.encode(rawOfferBytes) !== offerBlob) {
    throw new Error("actor manifest offerBlob is not canonically encoded");
  }
  const offerHash = canonicalHex(offerRecord["offerHash"], "actor manifest.offer.offerHash", 64);
  if (sha256(rawOfferBytes) !== offerHash) throw new Error("actor manifest offer hash differs from its raw bytes");
  const transactionHash = canonicalIdentity(
    offerRecord["transactionHash"],
    "actor manifest.offer.transactionHash",
  );
  canonicalStringArray(offerRecord["identifiers"], "actor manifest.offer.identifiers", canonicalIdentity, {
    min: 1,
    sorted: true,
  });
  for (const field of ["expectedNullifiers", "expectedCommitments", "inputRoots"] as const) {
    canonicalStringArray(
      offerRecord[field],
      `actor manifest.offer.${field}`,
      (entry, path) => canonicalHex(entry, path),
      { min: field === "inputRoots" ? 0 : 1, sorted: true },
    );
  }
  const expiresAt = canonicalIso(offerRecord["expiresAt"], "actor manifest.offer.expiresAt");
  if (expiresAt <= createdAt) throw new Error("actor manifest offer expiry must follow manifest creation");

  const parseLeg = (value: unknown, path: string): { token: string; amount: string; kind: "SHIELDED" } => {
    const record = recordAt(value, path);
    exactKeys(record, ["token", "amount", "kind"], path);
    if (record["kind"] !== "SHIELDED") throw new Error(`${path}.kind must be SHIELDED`);
    return {
      token: canonicalHex(record["token"], `${path}.token`, 64),
      amount: canonicalPositive(record["amount"], `${path}.amount`),
      kind: "SHIELDED",
    };
  };
  if (!Array.isArray(offerRecord["gives"]) || offerRecord["gives"].length !== 1 ||
      !Array.isArray(offerRecord["wants"]) || offerRecord["wants"].length !== 1) {
    throw new Error("actor manifest must contain exactly one give and one want leg");
  }
  const gives = [parseLeg(offerRecord["gives"][0], "actor manifest.offer.gives[0]")];
  const wants = [parseLeg(offerRecord["wants"][0], "actor manifest.offer.wants[0]")];
  if (gives[0]!.token !== tokens.A || wants[0]!.token !== tokens.B || gives[0]!.token === wants[0]!.token) {
    throw new Error("actor manifest offer does not describe shielded A-to-B economics");
  }
  if (
    funding.userTokenAAmount !== gives[0]!.amount ||
    BigInt(funding.solverTokenBAmount) < BigInt(wants[0]!.amount) ||
    BigInt(funding.mintAmount) < BigInt(funding.userTokenAAmount) ||
    BigInt(funding.mintAmount) < BigInt(funding.solverTokenBAmount)
  ) {
    throw new Error("actor manifest offer economics disagree with its funding oracle");
  }
  const balance = (actor: BalanceActor, token: string): bigint => BigInt(actor.shielded[token] ?? "0");
  const recomputedExpected = {
    user: {
      A: (balance(beforeSettlement.user, tokens.A) - BigInt(gives[0]!.amount)).toString(),
      B: (balance(beforeSettlement.user, tokens.B) + BigInt(wants[0]!.amount)).toString(),
    },
    solver: {
      A: (balance(beforeSettlement.solver, tokens.A) + BigInt(gives[0]!.amount)).toString(),
      B: (balance(beforeSettlement.solver, tokens.B) - BigInt(wants[0]!.amount)).toString(),
    },
  };
  if (
    Object.values(recomputedExpected.user).some((amount) => BigInt(amount) < 0n) ||
    Object.values(recomputedExpected.solver).some((amount) => BigInt(amount) < 0n) ||
    JSON.stringify(recomputedExpected) !== JSON.stringify(expectedActors)
  ) {
    throw new Error("actor manifest settlement balances are not derived from the exact A-to-B offer");
  }

  const ladder = recordAt(root["ladder"], "actor manifest.ladder");
  exactKeys(ladder, ["path", "sha256"], "actor manifest.ladder");
  requireAbsolutePath("actor manifest.ladder.path", ladder["path"] as string | undefined);
  canonicalHex(ladder["sha256"], "actor manifest.ladder.sha256", 64);

  return {
    schema: ACTOR_SCHEMA,
    runId: config.runId,
    networkId: config.expectedNetworkId,
    createdAt,
    tokens,
    funding,
    balances: { beforeSettlement, expectedAfterSettlement: expectedActors },
    offer: { offerBlob, offerHash, transactionHash, gives, wants },
    rawOfferBytes,
    manifestSha256,
  };
}

async function readBoundedPrivateFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("path is not a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new Error("file must not grant group or other permissions");
    if (metadata.size <= 0 || metadata.size > maximumBytes) {
      throw new Error(`file size must be in [1, ${maximumBytes}] bytes`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size || bytes.length > maximumBytes) {
      throw new Error("file changed while it was read or exceeded the size cap");
    }
    const after = await handle.stat();
    if (
      after.size !== metadata.size ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.mtimeMs !== metadata.mtimeMs
    ) {
      throw new Error("file changed while it was read");
    }
    return Uint8Array.from(bytes);
  } catch (error) {
    throw new Error(
      `could not read sealed actor manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readAndValidateRealActorManifest(
  config: RealPublisherConfig,
): Promise<ValidatedActorManifest> {
  const bytes = await readBoundedPrivateFile(config.actorManifestPath, config.maxManifestBytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("actor manifest is not bounded canonical UTF-8 JSON", { cause: error });
  }
  return validateActorManifestShape(decoded, config, sha256(bytes));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function createIdempotentPublisherCleanup(
  controller = new AbortController(),
): PublisherCleanup {
  const temporaryPaths = new Set<string>();
  let cleanupPromise: Promise<void> | null = null;
  const abort = (reason: unknown = new Error("publisher cleanup requested")): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      abort();
      const paths = [...temporaryPaths];
      temporaryPaths.clear();
      const results = await Promise.allSettled(paths.map((path) => unlink(path)));
      const failures = results.flatMap((result, index) =>
        result.status === "rejected" && (result.reason as NodeJS.ErrnoException)?.code !== "ENOENT"
          ? [new Error(`temporary evidence cleanup failed for ${paths[index]}: ${errorMessage(result.reason)}`)]
          : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "publisher cleanup failed");
    })();
    return cleanupPromise;
  };
  return { signal: controller.signal, temporaryPaths, abort, cleanup };
}

export function realPublisherSignalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

async function atomicPrivateJson(
  path: string,
  value: unknown,
  cleanup: PublisherCleanup,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  cleanup.temporaryPaths.add(temporary);
  let handle;
  try {
    if (cleanup.signal.aborted) throw cleanup.signal.reason;
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    if (cleanup.signal.aborted) throw cleanup.signal.reason;
    // link(2) is an atomic no-replace publication: unlike rename(2), it
    // refuses to overwrite prior evidence from an earlier invocation.
    await link(temporary, path);
    await unlink(temporary);
    cleanup.temporaryPaths.delete(temporary);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    const finalMetadata = await stat(path);
    if (!finalMetadata.isFile() || (finalMetadata.mode & 0o777) !== 0o600) {
      throw new Error("published evidence is not a regular mode-0600 file");
    }
  } catch (error) {
    throw new Error(`could not atomically publish private evidence ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
    if (cleanup.temporaryPaths.delete(temporary)) await unlink(temporary).catch(() => undefined);
  }
}

function deadlineError(): Error {
  const error = new Error("Celestia publication exceeded its absolute deadline");
  error.name = "DeadlineError";
  return error;
}

async function withDeadlineSignal<T>(
  parent: AbortSignal,
  deadlineAt: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw parent.reason;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw deadlineError();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(deadlineError()), remaining);
  try {
    return await action(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }
}

async function boundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new Error("Celestia response has a malformed Content-Length");
    }
    if (Number(contentLength) > maximumBytes) {
      await response.body?.cancel("response body exceeds configured cap").catch(() => undefined);
      throw new Error(`Celestia response exceeds ${maximumBytes} bytes`);
    }
  }
  if (!response.body) throw new Error("Celestia response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximumBytes) {
        await reader.cancel("response body exceeds configured cap").catch(() => undefined);
        throw new Error(`Celestia response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

class StrictCelestiaRpc {
  private nextId = 1;
  readonly url: string;
  readonly authToken: string | null;
  readonly maximumResponseBytes: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly fetchImpl: FetchLike;

  constructor(
    config: RealPublisherConfig,
    deadlineAt: number,
    signal: AbortSignal,
    fetchImpl: FetchLike,
  ) {
    this.url = config.rpcUrl;
    this.authToken = config.authToken;
    this.maximumResponseBytes = config.maxResponseBytes;
    this.deadlineAt = deadlineAt;
    this.signal = signal;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Bounded, scrubbed evidence for a refusal — diagnosis only.
   *
   * Both refusal paths above still refuse; this only makes them say WHAT they
   * saw. Without it a refusal reports a verdict with no observation, which is
   * what left E1-Q2 undecidable: the media-type gate fired before anything read
   * the body, so neither the header value nor the payload was ever captured.
   *
   * Bounded by construction: at most REFUSAL_EVIDENCE_BYTES are pulled off the
   * stream and the remainder is cancelled, so a hostile or huge body cannot be
   * used to exhaust memory through the failure path. The excerpt is scrubbed
   * before it can reach a log — the configured bearer token is replaced, and
   * every byte outside printable ASCII is escaped — so no credential and no raw
   * control sequence is emitted.
   */
  private async refusalEvidence(response: Response): Promise<string> {
    const rawContentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const parts = [
      `status=${response.status}`,
      `content-type=${rawContentType === null ? "<absent>" : JSON.stringify(rawContentType)}`,
      `content-length=${contentLength === null ? "<absent>" : JSON.stringify(contentLength)}`,
    ];
    let excerpt = "<unread>";
    const body = response.body;
    if (!body) {
      excerpt = "<no body>";
    } else {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (length < REFUSAL_EVIDENCE_BYTES) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
          length += chunk.value.length;
        }
        const joined = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        excerpt = this.scrubExcerpt(joined.slice(0, REFUSAL_EVIDENCE_BYTES));
        if (length > REFUSAL_EVIDENCE_BYTES) excerpt += "…";
      } catch (error) {
        excerpt = `<body read failed: ${errorMessage(error)}>`;
      } finally {
        await reader.cancel("refusal evidence captured").catch(() => undefined);
        reader.releaseLock();
      }
    }
    parts.push(`body=${excerpt}`);
    return parts.join(" ");
  }

  /** Replace the configured bearer token and escape every non-printable byte. */
  private scrubExcerpt(bytes: Uint8Array): string {
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (this.authToken) text = text.split(this.authToken).join("<redacted-auth-token>");
    const escaped = [...text]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code <= 0x7e ? character : `\\u{${code.toString(16)}}`;
      })
      .join("");
    return JSON.stringify(escaped);
  }

  async call(method: string, params: unknown[]): Promise<CelestiaCallOutcome> {
    const id = this.nextId++;
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(requestBody) > 2 * MAX_CONFIGURED_BODY_BYTES) {
      throw new Error(`Celestia ${method} request body exceeds the hard cap`);
    }
    return withDeadlineSignal(this.signal, this.deadlineAt, async (signal) => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          },
          body: requestBody,
          redirect: "error",
          cache: "no-store",
          signal,
        });
      } catch (error) {
        throw new Error(`Celestia ${method} transport failed: ${errorMessage(error)}`, { cause: error });
      }
      // Any non-200 is a refusal, always — that gate is unchanged.
      if (response.status !== 200) {
        const evidence = await this.refusalEvidence(response);
        throw new Error(
          `Celestia ${method} returned HTTP ${response.status}, expected 200 [${evidence}]`,
        );
      }
      // NO content-type gate. celestia-node writes JSON-RPC ERROR responses
      // without setting Content-Type, so Go's http.DetectContentType sniffs
      // them as `text/plain; charset=utf-8` — see e2e open question E1-Q2,
      // which captured exactly that against the real node. Gating on the
      // header therefore converted every RPC error into an opaque media-type
      // refusal and hid the real message. The node's behaviour is a given, so
      // classification cascades over the BODY instead (user decision, 2026-08-18).
      const headerEvidence = this.headerEvidence(response);
      const bytes = await boundedResponseBytes(response, this.maximumResponseBytes);
      let decoded: unknown;
      let parsed = true;
      try {
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        parsed = false;
      }
      if (!parsed) {
        // Case (iii): HTTP 200 with no available parse. By explicit user policy
        // the CALL is classified successful, not refused; the bounded scrubbed
        // evidence is carried so a caller that structurally needs the parsed
        // fact can say so precisely instead of inventing one.
        return {
          parsed: false as const,
          evidence: `${headerEvidence} body=${this.scrubExcerpt(bytes.slice(0, REFUSAL_EVIDENCE_BYTES))}`,
        };
      }
      // Case (i): a parsed body carrying a known JSON-RPC error shape is a
      // named refusal that reports the error the node actually sent, whatever
      // media type it arrived under.
      if (isRecordValue(decoded)) {
        const errorValue = decoded["error"];
        if (errorValue !== undefined) {
          throw new Error(
            `Celestia ${method} RPC error: ${safeJson(errorValue)} [${headerEvidence}]`,
          );
        }
        if (decoded["code"] !== undefined && decoded["result"] === undefined) {
          throw new Error(
            `Celestia ${method} RPC error: ${safeJson({ code: decoded["code"], message: decoded["message"] })} [${headerEvidence}]`,
          );
        }
      }
      // Case (ii): the canonical success envelope, checked exactly as before.
      const envelope = recordAt(decoded, `Celestia ${method} response`);
      const keys = Object.keys(envelope).sort();
      const expectedKeys = envelope["error"] === undefined
        ? ["id", "jsonrpc", "result"]
        : ["error", "id", "jsonrpc"];
      if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error(`Celestia ${method} returned a non-canonical JSON-RPC envelope`);
      }
      if (envelope["jsonrpc"] !== "2.0" || envelope["id"] !== id) {
        throw new Error(`Celestia ${method} returned the wrong JSON-RPC version or ID`);
      }
      if ("error" in envelope) {
        throw new Error(`Celestia ${method} RPC error: ${safeJson(envelope["error"])} [${headerEvidence}]`);
      }
      return { parsed: true as const, result: envelope["result"] };
    });
  }

  /** Status and headers only — safe to build before the body is read. */
  private headerEvidence(response: Response): string {
    const rawContentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    return [
      `status=${response.status}`,
      `content-type=${rawContentType === null ? "<absent>" : JSON.stringify(rawContentType)}`,
      `content-length=${contentLength === null ? "<absent>" : JSON.stringify(contentLength)}`,
    ].join(" ");
  }
}

/**
 * Unwrap a call that structurally needs its parsed result.
 *
 * Case (iii) classifies the CALL as successful — that is the user's policy and
 * it is honoured: this is not a refusal of the call. What fails here is the
 * caller's separate need for a fact the node never sent in a readable form.
 * Fabricating a height or a blob would be worse than failing, and recovering
 * one by downstream inclusion search is design work that has not been
 * authorized, so this fails closed and names the situation. See e2e open
 * question E1-Q3.
 */
function requireParsed(
  outcome: CelestiaCallOutcome,
  method: string,
): unknown {
  if (outcome.parsed) return outcome.result;
  throw new Error(
    `Celestia ${method} was classified a successful call but returned no parseable result, ` +
      `and this caller structurally requires one; it was not fabricated. ` +
      `See e2e open question E1-Q3 [${outcome.evidence}]`,
  );
}

function strictHeight(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe JSON number`);
  }
  return value;
}

function headerHeight(value: unknown, expected: number): number {
  const result = recordAt(value, "Celestia header.GetByHeight result");
  const header = recordAt(result["header"], "Celestia header.GetByHeight result.header");
  const height = canonicalPositive(header["height"], "Celestia header height");
  if (BigInt(height) !== BigInt(expected)) {
    throw new Error(`Celestia header height ${height} differs from submitted height ${expected}`);
  }
  return Number(height);
}

function networkHeadHeight(value: unknown): bigint {
  const result = recordAt(value, "Celestia header.NetworkHead result");
  const header = recordAt(result["header"], "Celestia header.NetworkHead result.header");
  return BigInt(canonicalPositive(header["height"], "Celestia network-head height"));
}

function parseCelestiaBlob(
  value: unknown,
  path: string,
  expectedNamespace: Uint8Array,
  maximumPayloadBytes: number,
): ParsedCelestiaBlob {
  const blob = recordAt(value, path);
  const keys = Object.keys(blob).sort();
  const allowed = ["commitment", "data", "index", "namespace", "share_version"];
  for (const required of ["commitment", "data", "namespace", "share_version"]) {
    if (!keys.includes(required)) throw new Error(`${path}.${required} is required`);
  }
  if (keys.some((key) => !allowed.includes(key))) throw new Error(`${path} contains an unknown field`);
  const namespaceBase64 = stringAt(blob["namespace"], `${path}.namespace`, /^[A-Za-z0-9+/]+={0,2}$/, 128);
  const namespace = parseCanonicalBase64(namespaceBase64, `${path}.namespace`, 64);
  if (!Buffer.from(namespace).equals(Buffer.from(expectedNamespace))) {
    throw new Error(`${path}.namespace differs from the MIP-0006 namespace`);
  }
  if (blob["share_version"] !== 0) throw new Error(`${path}.share_version must be exactly 0`);
  const dataBase64 = stringAt(
    blob["data"],
    `${path}.data`,
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    Math.ceil(maximumPayloadBytes / 3) * 4,
  );
  const data = parseCanonicalBase64(dataBase64, `${path}.data`, maximumPayloadBytes);
  const commitmentBase64 = stringAt(
    blob["commitment"],
    `${path}.commitment`,
    /^[A-Za-z0-9+/]+={0,2}$/,
    64,
  );
  const commitment = parseCanonicalBase64(commitmentBase64, `${path}.commitment`, COMMITMENT_BYTES);
  if (commitment.length !== COMMITMENT_BYTES) {
    throw new Error(`${path}.commitment must decode to ${COMMITMENT_BYTES} bytes`);
  }
  let index: number | null = null;
  if (blob["index"] !== undefined) {
    if (typeof blob["index"] !== "number" || !Number.isSafeInteger(blob["index"]) || blob["index"] < 0) {
      throw new Error(`${path}.index must be a non-negative safe integer when present`);
    }
    index = blob["index"];
  }
  return {
    namespaceBase64,
    dataBase64,
    data,
    sha256: sha256(data),
    commitmentBase64,
    commitment,
    shareVersion: 0,
    index,
  };
}

async function abortableSleep(ms: number, signal: AbortSignal, deadlineAt: number): Promise<void> {
  await withDeadlineSignal(signal, deadlineAt, (childSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(childSignal.reason);
      };
      childSignal.addEventListener("abort", onAbort, { once: true });
      if (childSignal.aborted) onAbort();
    })
  );
}

async function verifyPublication(
  rpc: StrictCelestiaRpc,
  config: RealPublisherConfig,
  height: number,
  namespace: Uint8Array,
  namespaceBase64: string,
  expectedBytes: Uint8Array,
  expectedHash: string,
  deadlineAt: number,
): Promise<{
  blob: ParsedCelestiaBlob;
  headerHeight: number;
  networkHeadAttempts: number;
  getAllAttempts: number;
  byCommitmentSha256: string;
}> {
  const maximumPublishedBytes = Math.max(
    config.maxOfferBytes,
    config.garbage?.maxBytes ?? 0,
  );
  let networkHeadAttempts = 0;
  while (true) {
    networkHeadAttempts++;
    const head = networkHeadHeight(
      requireParsed(await rpc.call("header.NetworkHead", []), "header.NetworkHead"),
    );
    if (head >= BigInt(height)) break;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError();
    await abortableSleep(Math.min(config.verifyPollMs, remaining), rpc.signal, deadlineAt);
  }
  const observedHeaderHeight = headerHeight(
    requireParsed(await rpc.call("header.GetByHeight", [height]), "header.GetByHeight"),
    height,
  );
  let getAllAttempts = 0;
  let matched: ParsedCelestiaBlob | null = null;
  while (!matched) {
    getAllAttempts++;
    const result = requireParsed(
      await rpc.call("blob.GetAll", [height, [namespaceBase64]]),
      "blob.GetAll",
    );
    if (result !== null) {
      if (!Array.isArray(result)) throw new Error("Celestia blob.GetAll result must be null or an array");
      if (result.length > 4096) throw new Error("Celestia blob.GetAll returned too many blobs");
      const parsed = result.map((entry, index) =>
        parseCelestiaBlob(
          entry,
          `Celestia blob.GetAll result[${index}]`,
          namespace,
          maximumPublishedBytes,
        )
      );
      const matches = parsed.filter((blob) =>
        blob.sha256 === expectedHash && Buffer.from(blob.data).equals(Buffer.from(expectedBytes))
      );
      if (matches.length !== 1) {
        throw new Error(
          `Celestia height ${height} contains ${matches.length} exact submitted-byte matches; expected exactly one`,
        );
      }
      matched = matches[0]!;
      break;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw deadlineError();
    await abortableSleep(Math.min(config.verifyPollMs, remaining), rpc.signal, deadlineAt);
  }

  const byCommitmentResult = requireParsed(
    await rpc.call("blob.Get", [height, namespaceBase64, matched.commitmentBase64]),
    "blob.Get",
  );
  if (byCommitmentResult === null) throw new Error("Celestia blob.Get returned null for the observed commitment");
  const byCommitment = parseCelestiaBlob(
    byCommitmentResult,
    "Celestia blob.Get result",
    namespace,
    maximumPublishedBytes,
  );
  if (
    byCommitment.commitmentBase64 !== matched.commitmentBase64 ||
    byCommitment.sha256 !== expectedHash ||
    !Buffer.from(byCommitment.data).equals(Buffer.from(expectedBytes))
  ) {
    throw new Error("Celestia commitment does not resolve to the exact submitted bytes");
  }
  return {
    blob: matched,
    headerHeight: observedHeaderHeight,
    networkHeadAttempts,
    getAllAttempts,
    byCommitmentSha256: byCommitment.sha256,
  };
}

function rpcEndpointEvidence(config: RealPublisherConfig): RealCelestiaPublicationEvidence["celestia"]["rpcEndpoint"] {
  const url = new URL(config.rpcUrl);
  return {
    protocol: url.protocol as "http:" | "https:",
    hostname: url.hostname,
    port: url.port,
    pathnameSha256: sha256(url.pathname),
    hasQuery: url.search.length > 0,
    bearerAuth: config.authToken !== null,
  };
}

export async function publishRealCelestiaBlob(
  config: RealPublisherConfig,
  cleanup: PublisherCleanup = createIdempotentPublisherCleanup(),
  fetchImpl: FetchLike = fetch,
): Promise<RealCelestiaPublicationEvidence> {
  const deadlineAt = Date.now() + config.deadlineMs;
  const manifest = await readAndValidateRealActorManifest(config);
  const bytes = config.mode === "offer" ? manifest.rawOfferBytes : config.garbage!.bytes;
  const payloadHash = sha256(bytes);
  if (config.mode === "offer" && payloadHash !== manifest.offer.offerHash) {
    throw new Error("offer publication payload differs from the sealed actor-manifest hash");
  }
  if (config.mode === "garbage" && payloadHash === manifest.offer.offerHash) {
    throw new Error("garbage publication payload must differ from the valid actor offer");
  }
  const namespace = mip6NamespaceBytes();
  if (namespace.length !== 29) throw new Error("MIP-0006 namespace must contain exactly 29 bytes");
  const namespaceBase64 = Buffer.from(namespace).toString("base64");
  const dataBase64 = Buffer.from(bytes).toString("base64");
  const rpc = new StrictCelestiaRpc(config, deadlineAt, cleanup.signal, fetchImpl);

  const submitResult = requireParsed(
    await rpc.call("blob.Submit", [
      [{ namespace: namespaceBase64, data: dataBase64, share_version: 0 }],
      { gas_price: config.gasPrice },
    ]),
    "blob.Submit",
  );
  const submittedHeight = strictHeight(submitResult, "Celestia blob.Submit result");
  const verification = await verifyPublication(
    rpc,
    config,
    submittedHeight,
    namespace,
    namespaceBase64,
    bytes,
    payloadHash,
    deadlineAt,
  );
  const evidence: RealCelestiaPublicationEvidence = {
    schema: EVIDENCE_SCHEMA,
    runId: config.runId,
    mode: config.mode,
    recordedAt: nowIso(),
    actorManifest: {
      schema: ACTOR_SCHEMA,
      sha256: manifest.manifestSha256,
      networkId: manifest.networkId,
      createdAt: manifest.createdAt,
      offerHash: manifest.offer.offerHash,
      offerTransactionHash: manifest.offer.transactionHash,
    },
    payload: {
      source: config.mode === "offer"
        ? "actor-manifest.offer.offerBlob"
        : "explicit-raw-garbage-base64",
      garbageLabel: config.garbage?.label ?? null,
      byteLength: bytes.length,
      sha256: payloadHash,
      dataBase64,
    },
    celestia: {
      rpcEndpoint: rpcEndpointEvidence(config),
      namespaceBase64,
      shareVersion: 0,
      gasPrice: config.gasPriceSource,
      submittedHeight,
      observedHeaderHeight: verification.headerHeight,
      commitmentBase64: verification.blob.commitmentBase64,
      commitmentSha256: sha256(verification.blob.commitment),
    },
    verification: {
      absoluteDeadlineMs: config.deadlineMs,
      networkHeadAttempts: verification.networkHeadAttempts,
      getAllAttempts: verification.getAllAttempts,
      exactMatchesAtHeight: 1,
      observedByteLength: verification.blob.data.length,
      observedSha256: verification.blob.sha256,
      getByCommitmentSha256: verification.byCommitmentSha256,
      checks: [
        "submitted-height-has-exact-header",
        "namespace-and-share-version-match",
        "exactly-one-byte-identical-blob-at-height",
        "sha256-matches-submitted-bytes",
        "commitment-resolves-to-byte-identical-blob",
      ],
    },
  };
  if (cleanup.signal.aborted) throw cleanup.signal.reason;
  await atomicPrivateJson(config.evidencePath, evidence, cleanup);
  return evidence;
}

function parseCommand(argv: readonly string[]): RealPublisherMode {
  if (argv.length !== 1 || (argv[0] !== "publish-offer" && argv[0] !== "publish-garbage")) {
    throw new Error("usage: solver-offerfiles-real-publisher.ts publish-offer|publish-garbage");
  }
  return argv[0] === "publish-offer" ? "offer" : "garbage";
}

export async function runRealPublisherCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const cleanup = createIdempotentPublisherCleanup();
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  const onSigint = (): void => {
    receivedSignal ??= "SIGINT";
    cleanup.abort(new Error("received SIGINT"));
  };
  const onSigterm = (): void => {
    receivedSignal ??= "SIGTERM";
    cleanup.abort(new Error("received SIGTERM"));
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let failure: unknown = null;
  let evidence: RealCelestiaPublicationEvidence | null = null;
  try {
    const mode = parseCommand(argv);
    evidence = await publishRealCelestiaBlob(readRealPublisherConfig(mode, env), cleanup);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanup.cleanup();
  } catch (error) {
    failure = failure === null
      ? error
      : new AggregateError([failure, error], "publisher operation and cleanup both failed");
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
  if (receivedSignal) {
    console.error(`[real-celestia-publisher] ${receivedSignal}; cleanup complete`);
    return realPublisherSignalExitCode(receivedSignal);
  }
  if (failure !== null) {
    console.error(`[real-celestia-publisher] failed: ${errorMessage(failure)}`);
    return 1;
  }
  console.log(JSON.stringify({
    status: "published-and-verified",
    runId: evidence!.runId,
    mode: evidence!.mode,
    height: evidence!.celestia.submittedHeight,
    payloadSha256: evidence!.payload.sha256,
    commitment: evidence!.celestia.commitmentBase64,
  }));
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runRealPublisherCli();
}
