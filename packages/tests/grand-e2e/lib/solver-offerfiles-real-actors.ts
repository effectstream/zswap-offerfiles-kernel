/**
 * Focused real-chain actors for the Offer Files solver E1/E4 acceptance run.
 *
 * This fixture deliberately owns no HTTP or Celestia behavior. It provisions
 * two fresh Midnight wallets from a funded undeployed genesis wallet, creates
 * a real shielded A -> B offer, and persists the exact oracle that the outer
 * Compose runner must later compare with the live solver/chain result.
 *
 * CLI contract:
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts provision
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts build-intent
 *   bun packages/tests/grand-e2e/lib/solver-offerfiles-real-actors.ts verify-settlement
 *
 * Required environment:
 *   E1_RUN_ID, E1_USER_SEED, E1_SOLVER_SEED,
 *   E1_ACTOR_RESULT_PATH, E1_ACTOR_RUNTIME_PATH, E1_ACTOR_LADDER_PATH,
 *   E1_ACTOR_PRE_SPENT_PATH
 * verify-settlement uses E1_ACTOR_SETTLEMENT_PATH in place of the ladder path.
 *
 * All paths must be absolute bind-mounted artifact paths. Seeds are accepted
 * only from the environment and are never written to an artifact.
 */

import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { waitForDustFunds } from "@effectstream/midnight-contracts/wallet-info";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { WalletResult } from "@effectstream/midnight-contracts/types";

import { joinOfferFiles, mintShielded } from "@zswap-da/solver-core/offer-files";
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  unshieldedAddressObj,
  unshieldedBalances,
  waitForShielded,
  waitForSync,
  waitForUnshielded,
} from "@zswap-da/solver-core/wallet";
import {
  collectNullifiers,
  collectOutputCommitments,
  getBlankRefState,
  validateZswapOffer,
  type OfferLeg,
  type OfferValidation,
  type ValidateOpts,
} from "@zswap-da/validator";

const SCHEMA = "zswap-offer-files-real-actors/v1";
const PRE_SPENT_SCHEMA = "zswap-offer-files-real-pre-spent-liveness/v1";
const NIGHT = "0".repeat(64);
const MAX_OFFER_BYTES = 1024 * 1024;
const REQUIRED_STABLE_OBSERVATIONS = 3;
const STABLE_OBSERVATION_INTERVAL_MS = 1_000;

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const seedFingerprint = (seed: string): string => sha256(seed).slice(0, 16);

function requireAbsolutePath(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requireRunId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) {
    throw new Error("E1_RUN_ID must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}");
  }
  return value;
}

function requireSeed(name: string, value: string | undefined): string {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be exactly 64 hexadecimal characters`);
  }
  return value.toLowerCase();
}

function positiveBigint(name: string, value: string | undefined, fallback: bigint): bigint {
  const raw = value ?? fallback.toString();
  if (!/^[1-9][0-9]{0,29}$/.test(raw)) {
    throw new Error(`${name} must be a positive decimal integer of at most 30 digits`);
  }
  return BigInt(raw);
}

function positiveSafeInteger(name: string, value: string | undefined, fallback: number): number {
  const raw = value ?? String(fallback);
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function separatorByte(name: string, value: string | undefined, fallback: number): number {
  const parsed = positiveSafeInteger(name, value, fallback);
  if (parsed > 255) throw new Error(`${name} must be in [1, 255]`);
  return parsed;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function atomicText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

let sealedWriteSequence = 0;

/** Publish a complete private artifact without ever replacing an existing path. */
async function sealedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${++sealedWriteSequence}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    // A hard-link publication is atomic and fails with EEXIST rather than
    // replacing a prior sealed oracle. The temporary inode is already fully
    // written, fsynced, and mode-restricted before it becomes visible here.
    await link(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function normalizedBalances(values: Record<string, bigint>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([token, amount]) => [token.toLowerCase(), amount.toString()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function txIdentifiers(transaction: unknown): string[] {
  if (!transaction || typeof (transaction as { identifiers?: unknown }).identifiers !== "function") {
    throw new Error("real Midnight transaction does not expose identifiers()");
  }
  const identifiers = (transaction as { identifiers(): unknown[] }).identifiers();
  if (!Array.isArray(identifiers) || identifiers.length === 0) {
    throw new Error("real Midnight transaction returned no identifiers");
  }
  return identifiers.map(String).sort();
}

/**
 * The shielded input nullifiers a finalized transaction actually consumes.
 *
 * NOT `identifiers()`. ledger-v8's `Transaction::identifiers()`
 * (`structure.rs:1454`) returns the Pedersen VALUE commitments of inputs,
 * outputs and transients plus the intent binding commitments — a different
 * cryptographic domain from a nullifier, so a nullifier can never appear in
 * it. Binding pre-spent liveness to that list could not pass against a real
 * chain, and no coin-selection change would have fixed it (e2e plan, open
 * question E1-Q1).
 *
 * `collectNullifiers` is the production traversal the validator and the node's
 * state machine already share: guaranteed offer plus every fallible segment,
 * across both `inputs` and `transients`, normalized to lowercase hex. Reusing
 * it — rather than restating the walk here — is what makes the candidate's
 * `validation.nullifiers` and this set comparable byte-for-byte, since the
 * candidate side is produced by exactly the same function.
 *
 * An empty result is returned, not thrown on: an unshielded-only transfer
 * legitimately consumes no zswap input. The fail-closed judgement belongs to
 * `bindRealPreSpentLivenessArtifact`, which still rejects an empty or
 * incomplete match.
 */
function txInputNullifiers(transaction: unknown): string[] {
  if (!transaction || typeof transaction !== "object") {
    throw new Error("real Midnight transaction is not an object");
  }
  return collectNullifiers(transaction as never).map(String).sort();
}

/** The manifest's transaction oracle shape — hash plus genuine transaction
 * identifiers. Deliberately drops the input nullifiers that `submitTransfer`
 * also returns: those are pre-spent liveness evidence, and the actor manifest
 * schema is exact-keyed (`hash`, `identifiers`) by the publisher. */
function manifestTransactionOracle(
  transfer: { hash: string; identifiers: string[] },
): { hash: string; identifiers: string[] } {
  return { hash: transfer.hash, identifiers: transfer.identifiers };
}

function txHash(transaction: unknown): string {
  if (!transaction || typeof (transaction as { transactionHash?: unknown }).transactionHash !== "function") {
    throw new Error("real Midnight transaction does not expose transactionHash()");
  }
  const value = String((transaction as { transactionHash(): unknown }).transactionHash());
  if (value.length === 0) throw new Error("real Midnight transaction returned an empty hash");
  return value;
}

export interface RealActorConfig {
  runId: string;
  userSeed: string;
  solverSeed: string;
  genesisSeed: string;
  resultPath: string;
  runtimePath: string;
  ladderPath: string;
  preSpentPath: string;
  tokenASeparator: number;
  tokenBSeparator: number;
  mintAmount: bigint;
  giveAmount: bigint;
  wantAmount: bigint;
  solverTokenBAmount: bigint;
  nightPerUtxo: bigint;
  nightUtxosPerActor: number;
  offerTtlMs: number;
  syncTimeoutMs: number;
  fundingTimeoutMs: number;
  mintNonce: bigint;
}

export interface RealActorSettlementConfig {
  runId: string;
  userSeed: string;
  solverSeed: string;
  resultPath: string;
  runtimePath: string;
  settlementPath: string;
  syncTimeoutMs: number;
  settlementTimeoutMs: number;
}

export function readRealActorSettlementConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealActorSettlementConfig {
  if (net.id !== "undeployed") {
    throw new Error(`real settlement verifier requires MIDNIGHT_NETWORK_ID=undeployed, got ${net.id}`);
  }
  const userSeed = requireSeed("E1_USER_SEED", env["E1_USER_SEED"]);
  const solverSeed = requireSeed("E1_SOLVER_SEED", env["E1_SOLVER_SEED"]);
  if (userSeed === solverSeed) throw new Error("E1 user and solver seeds must be distinct");
  const resultPath = requireAbsolutePath("E1_ACTOR_RESULT_PATH", env["E1_ACTOR_RESULT_PATH"]);
  const runtimePath = requireAbsolutePath("E1_ACTOR_RUNTIME_PATH", env["E1_ACTOR_RUNTIME_PATH"]);
  const settlementPath = requireAbsolutePath(
    "E1_ACTOR_SETTLEMENT_PATH",
    env["E1_ACTOR_SETTLEMENT_PATH"],
  );
  if (new Set([resultPath, runtimePath, settlementPath]).size !== 3) {
    throw new Error("actor result, runtime, and settlement paths must be distinct");
  }
  return {
    runId: requireRunId(env["E1_RUN_ID"]),
    userSeed,
    solverSeed,
    resultPath,
    runtimePath,
    settlementPath,
    syncTimeoutMs: positiveSafeInteger("E1_SYNC_TIMEOUT_MS", env["E1_SYNC_TIMEOUT_MS"], 240_000),
    settlementTimeoutMs: positiveSafeInteger(
      "E1_SETTLEMENT_TIMEOUT_MS",
      env["E1_SETTLEMENT_TIMEOUT_MS"],
      300_000,
    ),
  };
}

export function readRealActorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealActorConfig {
  if (net.id !== "undeployed") {
    throw new Error(`real actor fixture requires MIDNIGHT_NETWORK_ID=undeployed, got ${net.id}`);
  }
  const userSeed = requireSeed("E1_USER_SEED", env["E1_USER_SEED"]);
  const solverSeed = requireSeed("E1_SOLVER_SEED", env["E1_SOLVER_SEED"]);
  const genesisSeed = requireSeed(
    "E1_GENESIS_SEED/MIDNIGHT_WALLET_SEED",
    env["E1_GENESIS_SEED"] ?? net.walletSeed,
  );
  if (new Set([userSeed, solverSeed, genesisSeed]).size !== 3) {
    throw new Error("E1 user, solver, and genesis seeds must all be distinct");
  }
  const runId = requireRunId(env["E1_RUN_ID"]);

  const giveAmount = positiveBigint("E1_GIVE_AMOUNT", env["E1_GIVE_AMOUNT"], 1_000n);
  const wantAmount = positiveBigint("E1_WANT_AMOUNT", env["E1_WANT_AMOUNT"], 900n);
  const solverTokenBAmount = positiveBigint(
    "E1_SOLVER_TOKEN_B_AMOUNT",
    env["E1_SOLVER_TOKEN_B_AMOUNT"],
    wantAmount,
  );
  if (solverTokenBAmount < wantAmount) {
    throw new Error("E1_SOLVER_TOKEN_B_AMOUNT must cover E1_WANT_AMOUNT");
  }
  const mintAmount = positiveBigint("E1_MINT_AMOUNT", env["E1_MINT_AMOUNT"], 1_000_000n);
  if (mintAmount < giveAmount || mintAmount < solverTokenBAmount) {
    throw new Error("E1_MINT_AMOUNT must cover both actor token grants");
  }

  const tokenASeparator = separatorByte("E1_TOKEN_A_SEPARATOR", env["E1_TOKEN_A_SEPARATOR"], 0xd4);
  const tokenBSeparator = separatorByte("E1_TOKEN_B_SEPARATOR", env["E1_TOKEN_B_SEPARATOR"], 0xd5);
  if (tokenASeparator === tokenBSeparator) {
    throw new Error("E1 token A and token B separators must differ");
  }
  const resultPath = requireAbsolutePath("E1_ACTOR_RESULT_PATH", env["E1_ACTOR_RESULT_PATH"]);
  const runtimePath = requireAbsolutePath("E1_ACTOR_RUNTIME_PATH", env["E1_ACTOR_RUNTIME_PATH"]);
  const ladderPath = requireAbsolutePath("E1_ACTOR_LADDER_PATH", env["E1_ACTOR_LADDER_PATH"]);
  const preSpentPath = requireAbsolutePath(
    "E1_ACTOR_PRE_SPENT_PATH",
    env["E1_ACTOR_PRE_SPENT_PATH"],
  );
  if (new Set([resultPath, runtimePath, ladderPath, preSpentPath]).size !== 4) {
    throw new Error("actor result, runtime, ladder, and pre-spent paths must be distinct");
  }

  return {
    runId,
    userSeed,
    solverSeed,
    genesisSeed,
    resultPath,
    runtimePath,
    ladderPath,
    preSpentPath,
    tokenASeparator,
    tokenBSeparator,
    mintAmount,
    giveAmount,
    wantAmount,
    solverTokenBAmount,
    nightPerUtxo: positiveBigint(
      "E1_NIGHT_PER_UTXO",
      env["E1_NIGHT_PER_UTXO"],
      5_000_000_000_000n,
    ),
    nightUtxosPerActor: (() => {
      const count = positiveSafeInteger(
        "E1_NIGHT_UTXOS_PER_ACTOR",
        env["E1_NIGHT_UTXOS_PER_ACTOR"],
        2,
      );
      if (count > 4) throw new Error("E1_NIGHT_UTXOS_PER_ACTOR must be in [1, 4]");
      return count;
    })(),
    offerTtlMs: positiveSafeInteger("E1_OFFER_TTL_MS", env["E1_OFFER_TTL_MS"], 30 * 60_000),
    syncTimeoutMs: positiveSafeInteger("E1_SYNC_TIMEOUT_MS", env["E1_SYNC_TIMEOUT_MS"], 240_000),
    fundingTimeoutMs: positiveSafeInteger(
      "E1_FUNDING_TIMEOUT_MS",
      env["E1_FUNDING_TIMEOUT_MS"],
      240_000,
    ),
    mintNonce: positiveBigint(
      "E1_MINT_NONCE",
      env["E1_MINT_NONCE"],
      BigInt(`0x${sha256(`${runId}:mint-nonce`).slice(0, 24)}`) + 1n,
    ),
  };
}

export interface RealBalanceSnapshot {
  capturedAt: string;
  user: { shielded: Record<string, string>; unshielded: Record<string, string>; dust: string };
  solver: { shielded: Record<string, string>; unshielded: Record<string, string>; dust: string };
}

export interface RealBalanceDelta {
  user: { shielded: Record<string, string>; unshielded: Record<string, string>; dust: string };
  solver: { shielded: Record<string, string>; unshielded: Record<string, string>; dust: string };
}

export interface RealSettlementBalanceEvidence {
  schema: "zswap-offer-files-real-settlement-balances/v1";
  runId: string;
  capturedAt: string;
  before: RealBalanceSnapshot;
  after: RealBalanceSnapshot;
  delta: RealBalanceDelta;
  finality: {
    source: "wallet-facade-strict-sync";
    requiredStableObservations: 3;
    observations: readonly RealBalanceSnapshot[];
  };
  netDustBalanceDelta: {
    actor: "solver";
    asset: "DUST";
    balanceSource: "wallet.dust.state/waitForDustFunds";
    before: string;
    after: string;
    delta: string;
    /** Generation continues with wall time, so this is not an exact fee. */
    interpretation: "net-balance-delta-not-exact-fee";
  };
}

export interface RealOfferOracle {
  offerBlob: string;
  offerHash: string;
  transactionHash: string;
  identifiers: string[];
  expectedNullifiers: string[];
  expectedCommitments: string[];
  inputRoots: string[];
  gives: Array<{ token: string; amount: string; kind: "SHIELDED" | "UNSHIELDED" }>;
  wants: Array<{ token: string; amount: string; kind: "SHIELDED" | "UNSHIELDED" }>;
  expiresAt: string;
}

export interface RealPreSpentOfferCandidate {
  offerBlob: string;
  offerHash: string;
  rawBase64: string;
  inputNullifiers: string[];
  gives: OfferLeg[];
  wants: OfferLeg[];
  expiresAt: string;
  sourceValidation: {
    validator: "@zswap-da/validator/validateZswapOffer";
    crypto: "verify";
    referenceState: "blank-network";
    tblock: string;
    maxBytes: number;
  };
}

export interface RealPreSpentLivenessArtifact extends RealPreSpentOfferCandidate {
  schema: typeof PRE_SPENT_SCHEMA;
  runId: string;
  networkId: string;
  createdAt: string;
  consumingFundingTxHash: string;
}

export interface RealPreSpentOfferDependencies {
  encodeOffer: (bytes: Uint8Array) => string;
  decodeOffer: (blob: string) => Uint8Array;
  blankReferenceState: (networkId: string) => ValidateOpts["refState"];
  validateOffer: (blob: string, options: ValidateOpts) => OfferValidation;
  now: () => Date;
}

const REAL_PRE_SPENT_OFFER_DEPENDENCIES: RealPreSpentOfferDependencies = {
  encodeOffer: (bytes) => OfferFiles.encode(bytes),
  decodeOffer: (blob) => OfferFiles.decode(blob),
  blankReferenceState: (networkId) => getBlankRefState(networkId),
  validateOffer: (blob, options) => validateZswapOffer(blob, options),
  now: () => new Date(),
};

/**
 * Build and source-validate an offer against the genesis wallet's one large
 * token-A coin, then always release the wallet recipe. No transaction is
 * submitted here: the later token-A funding transaction is the intentional
 * and independently bound consumer of the same nullifier.
 */
export async function buildRealPreSpentOfferCandidate(
  genesis: WalletResult,
  options: {
    tokenA: string;
    tokenB: string;
    giveAmount: bigint;
    wantAmount: bigint;
    expiresAt: Date;
  },
  dependencies: Partial<RealPreSpentOfferDependencies> = {},
): Promise<RealPreSpentOfferCandidate> {
  const deps = { ...REAL_PRE_SPENT_OFFER_DEPENDENCIES, ...dependencies };
  const genesisShieldedAddress = await genesis.wallet.shielded.getAddress();
  const recipe = await genesis.wallet.initSwap(
    { shielded: { [options.tokenA]: options.giveAmount } },
    [{
      type: "shielded",
      outputs: [{
        type: options.tokenB,
        amount: options.wantAmount,
        receiverAddress: genesisShieldedAddress,
      }],
    } as never],
    shieldedKeys(genesis),
    { ttl: options.expiresAt, payFees: false },
  );

  let candidate: RealPreSpentOfferCandidate | undefined;
  let workFailed = false;
  let workFailure: unknown;
  try {
    const finalized = await genesis.wallet.finalizeTransaction(recipe.transaction);
    const serialized = finalized.serialize();
    if (!(serialized instanceof Uint8Array) || serialized.byteLength === 0) {
      throw new Error("pre-spent offer finalized to no transaction bytes");
    }
    const offerBlob = deps.encodeOffer(serialized);
    const decoded = deps.decodeOffer(offerBlob);
    if (
      !(decoded instanceof Uint8Array) ||
      !Buffer.from(decoded).equals(Buffer.from(serialized))
    ) {
      throw new Error("pre-spent offer codec did not preserve the finalized transaction bytes");
    }
    const validationBlock = deps.now();
    if (Number.isNaN(validationBlock.getTime())) {
      throw new Error("pre-spent source-validation time is invalid");
    }
    const validationOptions: ValidateOpts = {
      refState: deps.blankReferenceState(net.id),
      tblock: validationBlock,
      maxBytes: MAX_OFFER_BYTES,
      crypto: "verify",
    };
    const validation = deps.validateOffer(offerBlob, validationOptions);
    if (!validation.ok || !validation.tx || !validation.gives || !validation.wants) {
      throw new Error(
        `pre-spent A->B offer failed source validation: ${validation.code ?? "UNKNOWN"} ` +
          `${validation.reason ?? "no reason"}`,
      );
    }
    if (
      validation.gives.length !== 1 ||
      validation.gives[0]?.kind !== "SHIELDED" ||
      validation.gives[0]?.token !== options.tokenA ||
      validation.gives[0]?.amount !== options.giveAmount.toString() ||
      validation.wants.length !== 1 ||
      validation.wants[0]?.kind !== "SHIELDED" ||
      validation.wants[0]?.token !== options.tokenB ||
      validation.wants[0]?.amount !== options.wantAmount.toString()
    ) {
      throw new Error("pre-spent source validation returned different A->B economics");
    }
    const inputNullifiers = [...(validation.nullifiers ?? [])].map(String).sort();
    if (inputNullifiers.length !== 1 || inputNullifiers[0]!.length === 0) {
      throw new Error(
        `pre-spent offer must consume exactly the one large genesis token-A coin; ` +
          `got ${inputNullifiers.length} shielded nullifiers`,
      );
    }
    candidate = {
      offerBlob,
      offerHash: sha256(decoded),
      rawBase64: Buffer.from(decoded).toString("base64"),
      inputNullifiers,
      gives: validation.gives.map((leg) => ({ ...leg })),
      wants: validation.wants.map((leg) => ({ ...leg })),
      expiresAt: options.expiresAt.toISOString(),
      sourceValidation: {
        validator: "@zswap-da/validator/validateZswapOffer",
        crypto: "verify",
        referenceState: "blank-network",
        tblock: validationBlock.toISOString(),
        maxBytes: MAX_OFFER_BYTES,
      },
    };
  } catch (error) {
    workFailed = true;
    workFailure = error;
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    await Promise.resolve((genesis.wallet as any).revert(recipe));
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }
  if (workFailed && cleanupFailed) {
    throw new AggregateError(
      [workFailure, cleanupFailure],
      "pre-spent offer construction and recipe cleanup both failed",
    );
  }
  if (workFailed) throw workFailure;
  if (cleanupFailed) {
    throw new Error("pre-spent offer recipe cleanup failed", { cause: cleanupFailure });
  }
  if (!candidate) throw new Error("pre-spent offer construction produced no candidate");
  return candidate;
}

export function bindRealPreSpentLivenessArtifact(
  runId: string,
  networkId: string,
  candidate: RealPreSpentOfferCandidate,
  // The funding transaction's own consumed shielded inputs, from
  // `txInputNullifiers`. Named for what it carries: this is deliberately NOT
  // `identifiers()`, which returns value/binding commitments and therefore can
  // never contain a nullifier (e2e plan, open question E1-Q1).
  fundingTransaction: { hash: string; inputNullifiers: readonly string[] },
  createdAt = nowIso(),
): RealPreSpentLivenessArtifact {
  const fundingNullifiers = new Set(fundingTransaction.inputNullifiers.map(String));
  const missing = candidate.inputNullifiers.filter((nullifier) => !fundingNullifiers.has(nullifier));
  if (candidate.inputNullifiers.length === 0 || missing.length > 0) {
    throw new Error(
      `token-A funding transaction did not consume all pre-spent offer nullifiers: ` +
        `${missing.join(",") || "candidate exposed none"}`,
    );
  }
  if (!fundingTransaction.hash) {
    throw new Error("token-A funding transaction has no hash");
  }
  return {
    schema: PRE_SPENT_SCHEMA,
    runId,
    networkId,
    createdAt,
    ...candidate,
    consumingFundingTxHash: fundingTransaction.hash,
  };
}

export function assertRealPreSpentLivenessArtifact(
  artifact: RealPreSpentLivenessArtifact,
  decodeOffer: (blob: string) => Uint8Array = (blob) => OfferFiles.decode(blob),
): void {
  if (
    artifact.schema !== PRE_SPENT_SCHEMA ||
    !artifact.runId ||
    !artifact.networkId ||
    Number.isNaN(Date.parse(artifact.createdAt)) ||
    !artifact.consumingFundingTxHash
  ) {
    throw new Error("pre-spent liveness artifact has invalid identity metadata");
  }
  const raw = decodeOffer(artifact.offerBlob);
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength === 0 ||
    sha256(raw) !== artifact.offerHash ||
    Buffer.from(raw).toString("base64") !== artifact.rawBase64
  ) {
    throw new Error("pre-spent offer blob, raw bytes, and hash are not identical");
  }
  if (
    artifact.inputNullifiers.length !== 1 ||
    !/^[0-9a-f]{64}$/.test(artifact.inputNullifiers[0]!) ||
    new Set(artifact.inputNullifiers).size !== artifact.inputNullifiers.length
  ) {
    throw new Error("pre-spent liveness artifact has invalid input nullifiers");
  }
  const give = artifact.gives[0];
  const want = artifact.wants[0];
  if (
    artifact.gives.length !== 1 ||
    artifact.wants.length !== 1 ||
    give?.kind !== "SHIELDED" ||
    want?.kind !== "SHIELDED" ||
    !/^[0-9a-f]{64}$/.test(give.token) ||
    !/^[0-9a-f]{64}$/.test(want.token) ||
    give.token === want.token ||
    !/^[1-9][0-9]*$/.test(give.amount) ||
    !/^[1-9][0-9]*$/.test(want.amount) ||
    Number.isNaN(Date.parse(artifact.expiresAt))
  ) {
    throw new Error("pre-spent liveness artifact has invalid shielded A-to-B economics");
  }
  if (
    artifact.sourceValidation.validator !== "@zswap-da/validator/validateZswapOffer" ||
    artifact.sourceValidation.crypto !== "verify" ||
    artifact.sourceValidation.referenceState !== "blank-network" ||
    artifact.sourceValidation.maxBytes !== MAX_OFFER_BYTES ||
    Number.isNaN(Date.parse(artifact.sourceValidation.tblock))
  ) {
    throw new Error("pre-spent liveness artifact lacks source cryptographic validation evidence");
  }
}

export async function writeRealPreSpentLivenessArtifact(
  path: string,
  artifact: RealPreSpentLivenessArtifact,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("pre-spent liveness artifact path must be absolute");
  assertRealPreSpentLivenessArtifact(artifact);
  await sealedJson(path, artifact);
}

export interface RealActorManifest {
  schema: typeof SCHEMA;
  runId: string;
  networkId: string;
  createdAt: string;
  actors: {
    genesis: { seedFingerprint: string };
    user: { seedFingerprint: string };
    solver: { seedFingerprint: string };
  };
  tokens: { A: string; B: string; NIGHT: string };
  funding: {
    mintAmount: string;
    userTokenAAmount: string;
    solverTokenBAmount: string;
    nightPerUtxo: string;
    nightUtxosPerActor: number;
    nightFundingTransaction: { hash: string; identifiers: string[] };
    tokenFundingTransactions: Array<{
      token: "A" | "B";
      hash: string;
      identifiers: string[];
    }>;
  };
  balances: {
    beforeFunding: RealBalanceSnapshot;
    beforeSettlement: RealBalanceSnapshot;
    expectedAfterSettlement: {
      user: { A: string; B: string };
      solver: { A: string; B: string };
    };
    dustBalanceEvidence: {
      actor: "solver";
      asset: "DUST";
      balanceSource: "wallet.dust.state/waitForDustFunds";
      before: string;
      after: null;
      delta: null;
      interpretation: "net-balance-delta-not-exact-fee";
    };
  };
  offer: RealOfferOracle;
  ladder: { path: string; sha256: string };
}

export interface RealSettlementActors {
  readonly user: WalletResult;
  readonly solver: WalletResult;
  readonly manifest: RealActorManifest;
}

export interface RealSettlementActorFixture extends RealSettlementActors {
  captureBalances: () => Promise<RealBalanceSnapshot>;
  captureSettlementEvidence: (timeoutMs?: number) => Promise<RealSettlementBalanceEvidence>;
  close: () => Promise<void>;
}

export interface RealActorFixture extends RealSettlementActorFixture {
  readonly genesis: WalletResult;
  readonly preSpentLiveness: RealPreSpentLivenessArtifact;
}

export interface RealActorStoppable {
  label: string;
  stop: () => unknown | Promise<unknown>;
}

/** Testable cleanup owner used by the real fixture as wallets are acquired. */
export function createIdempotentRealActorCleanup(
  owners: () => readonly RealActorStoppable[],
): () => Promise<void> {
  let cleanup: Promise<void> | null = null;
  return (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const current = [...owners()].reverse();
      const results = await Promise.allSettled(current.map(({ stop }) => Promise.resolve().then(stop)));
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [new Error(
              `${current[index]?.label ?? `owner-${index + 1}`} shutdown failed: ` +
                `${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              { cause: result.reason },
            )]
          : []
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "real actor wallet shutdown failed");
    })();
    return cleanup;
  };
}

export function realActorSignalExitCode(signal: "SIGINT" | "SIGTERM"): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

async function captureBalances(
  user: WalletResult,
  solver: WalletResult,
  dustTimeoutMs = 60_000,
  requirePositiveDust = true,
): Promise<RealBalanceSnapshot> {
  // The aggregate facade proves all three sub-wallets are strictly caught up.
  // waitNonZero then forces the dust-specific progress catch-up path before
  // resolving the generated balance. A plain first dust emission is not
  // sufficient finality evidence.
  const deadline = Date.now() + dustTimeoutMs;
  await Promise.all([
    waitForSync(user, { timeoutMs: dustTimeoutMs }),
    waitForSync(solver, { timeoutMs: dustTimeoutMs }),
  ]);
  const dustBudgetMs = Math.max(1, deadline - Date.now());
  const [
    userShielded,
    userUnshielded,
    userDust,
    solverShielded,
    solverUnshielded,
    solverDust,
  ] = await Promise.all([
    shieldedBalances(user),
    unshieldedBalances(user),
    waitForDustFunds(user.wallet as any, {
      timeoutMs: dustBudgetMs,
      waitNonZero: requirePositiveDust,
    }),
    shieldedBalances(solver),
    unshieldedBalances(solver),
    waitForDustFunds(solver.wallet as any, {
      timeoutMs: dustBudgetMs,
      waitNonZero: requirePositiveDust,
    }),
  ]);
  return {
    capturedAt: nowIso(),
    user: {
      shielded: normalizedBalances(userShielded),
      unshielded: normalizedBalances(userUnshielded),
      dust: userDust.toString(),
    },
    solver: {
      shielded: normalizedBalances(solverShielded),
      unshielded: normalizedBalances(solverUnshielded),
      dust: solverDust.toString(),
    },
  };
}

export async function captureRealActorBalances(fixture: RealActorFixture): Promise<RealBalanceSnapshot> {
  return fixture.captureBalances();
}

function stableFinalizedAssets(left: RealBalanceSnapshot, right: RealBalanceSnapshot): boolean {
  const sameAssets =
    JSON.stringify(left.user.shielded) === JSON.stringify(right.user.shielded) &&
    JSON.stringify(left.user.unshielded) === JSON.stringify(right.user.unshielded) &&
    JSON.stringify(left.solver.shielded) === JSON.stringify(right.solver.shielded) &&
    JSON.stringify(left.solver.unshielded) === JSON.stringify(right.solver.unshielded);
  // DUST generation is time-based. Once strict sync has completed, a later
  // resolved facade balance may increase without a transaction, but must not
  // regress. Therefore exact equality would manufacture a false fee oracle.
  return sameAssets &&
    BigInt(right.user.dust) >= BigInt(left.user.dust) &&
    BigInt(right.solver.dust) >= BigInt(left.solver.dust);
}

function matchesExpectedSettlement(
  manifest: RealActorManifest,
  snapshot: RealBalanceSnapshot,
): boolean {
  const expected = manifest.balances.expectedAfterSettlement;
  return (snapshot.user.shielded[manifest.tokens.A] ?? "0") === expected.user.A &&
    (snapshot.user.shielded[manifest.tokens.B] ?? "0") === expected.user.B &&
    (snapshot.solver.shielded[manifest.tokens.A] ?? "0") === expected.solver.A &&
    (snapshot.solver.shielded[manifest.tokens.B] ?? "0") === expected.solver.B;
}

async function captureStableBalances(
  user: WalletResult,
  solver: WalletResult,
  timeoutMs: number,
  predicate: (snapshot: RealBalanceSnapshot) => boolean,
): Promise<readonly RealBalanceSnapshot[]> {
  const deadline = Date.now() + timeoutMs;
  let stable: RealBalanceSnapshot[] = [];
  let lastObserved: RealBalanceSnapshot | null = null;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const observed = await captureBalances(user, solver, remainingMs, true);
    lastObserved = observed;
    if (!predicate(observed)) {
      stable = [];
    } else if (stable.length === 0 || stableFinalizedAssets(stable.at(-1)!, observed)) {
      stable.push(observed);
      if (stable.length === REQUIRED_STABLE_OBSERVATIONS) return Object.freeze(stable);
    } else {
      stable = [observed];
    }
    if (Date.now() < deadline) await sleep(STABLE_OBSERVATION_INTERVAL_MS);
  }
  throw new Error(
    `finalized actor balances were not stable across ${REQUIRED_STABLE_OBSERVATIONS} observations ` +
      `before ${timeoutMs} ms: ${JSON.stringify(lastObserved)}`,
  );
}

function balanceMapDelta(
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, string> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(
    keys.map((token) => [
      token,
      (BigInt(after[token] ?? "0") - BigInt(before[token] ?? "0")).toString(),
    ]),
  );
}

export function buildRealActorSettlementEvidence(
  manifest: RealActorManifest,
  after: RealBalanceSnapshot,
  stableObservations: readonly RealBalanceSnapshot[] = [after],
): RealSettlementBalanceEvidence {
  const before = manifest.balances.beforeSettlement;
  const delta: RealBalanceDelta = {
    user: {
      shielded: balanceMapDelta(before.user.shielded, after.user.shielded),
      unshielded: balanceMapDelta(before.user.unshielded, after.user.unshielded),
      dust: (BigInt(after.user.dust) - BigInt(before.user.dust)).toString(),
    },
    solver: {
      shielded: balanceMapDelta(before.solver.shielded, after.solver.shielded),
      unshielded: balanceMapDelta(before.solver.unshielded, after.solver.unshielded),
      dust: (BigInt(after.solver.dust) - BigInt(before.solver.dust)).toString(),
    },
  };
  return {
    schema: "zswap-offer-files-real-settlement-balances/v1",
    runId: manifest.runId,
    capturedAt: nowIso(),
    before,
    after,
    delta,
    finality: {
      source: "wallet-facade-strict-sync",
      requiredStableObservations: REQUIRED_STABLE_OBSERVATIONS,
      observations: Object.freeze([...stableObservations]),
    },
    netDustBalanceDelta: {
      actor: "solver",
      asset: "DUST",
      balanceSource: "wallet.dust.state/waitForDustFunds",
      before: before.solver.dust,
      after: after.solver.dust,
      delta: delta.solver.dust,
      interpretation: "net-balance-delta-not-exact-fee",
    },
  };
}

export async function captureRealActorSettlementEvidence(
  fixture: RealSettlementActors,
  timeoutMs = 240_000,
): Promise<RealSettlementBalanceEvidence> {
  const observations = await captureStableBalances(
    fixture.user,
    fixture.solver,
    timeoutMs,
    (snapshot) => matchesExpectedSettlement(fixture.manifest, snapshot),
  );
  const evidence = buildRealActorSettlementEvidence(
    fixture.manifest,
    observations.at(-1)!,
    observations,
  );
  assertRealActorSettlementEvidence(fixture.manifest, evidence);
  return evidence;
}

async function submitTransfer(
  from: WalletResult,
  layer: "shielded" | "unshielded",
  outputs: Array<{ type: string; amount: bigint; receiverAddress: unknown }>,
  ttlMs: number,
): Promise<{ hash: string; identifiers: string[]; inputNullifiers: string[] }> {
  // E1-Q7 policy. `Custom error: 170` is midnight-node's
  // MalformedError::InvalidDustSpendProof — a Dust spend-PROOF validity
  // refusal, not a balance problem — and the observed 1-in-5 rate with an
  // immediately successful rerun is consistent with a proof-freshness race.
  // At most TWO retries, scoped to exactly that code, and each attempt REBUILDS
  // the transaction from scratch so the Dust proof is regenerated against
  // current state. Resubmitting the same bytes would re-present the same stale
  // proof and is never done. Any other rejection propagates untouched on the
  // first attempt. This applies ONLY to provisioning; no retry exists anywhere
  // in the refusal matrix or any system-under-test path.
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await submitTransferOnce(from, layer, outputs, ttlMs, attempt);
    } catch (error) {
      if (attempt > DUST_PROOF_RETRY_LIMIT || !isInvalidDustSpendProofRejection(error)) throw error;
      dustProofRetries.push({ layer, attempt, outputs: outputs.length });
      console.log(
        `[real-actors] E1-Q7 InvalidDustSpendProof (code 170) on ${layer} transfer attempt ${attempt}; ` +
          `rebuilding the transaction for attempt ${attempt + 1} of ${DUST_PROOF_RETRY_LIMIT + 1}`,
      );
    }
  }
}

/** At most two retries, i.e. three attempts total. */
const DUST_PROOF_RETRY_LIMIT = 2;

/** Every code-170 occurrence observed this run, surfaced in run evidence. */
const dustProofRetries: Array<{ layer: string; attempt: number; outputs: number }> = [];

export function realActorDustProofRetryEvidence(): {
  occurrences: number;
  attempts: Array<{ layer: string; attempt: number; outputs: number }>;
} {
  return { occurrences: dustProofRetries.length, attempts: dustProofRetries.map((entry) => ({ ...entry })) };
}

/**
 * Match ONLY midnight-node's InvalidDustSpendProof. The code must be visible in
 * the thrown error or its cause chain; if it is not, this returns false and the
 * caller rethrows, so an unrecognised rejection can never be retried by
 * accident.
 */
function isInvalidDustSpendProofRejection(error: unknown): boolean {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current) && parts.length < 8) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  const text = parts.join(" | ");
  return /Custom error:\s*170\b/.test(text) || /InvalidDustSpendProof/.test(text);
}

async function submitTransferOnce(
  from: WalletResult,
  layer: "shielded" | "unshielded",
  outputs: Array<{ type: string; amount: bigint; receiverAddress: unknown }>,
  ttlMs: number,
  attempt: number,
): Promise<{ hash: string; identifiers: string[]; inputNullifiers: string[] }> {
  void attempt;
  const recipe = await from.wallet.transferTransaction(
    [{ type: layer, outputs } as never],
    shieldedKeys(from),
    { ttl: new Date(Date.now() + ttlMs), payFees: true },
  );
  let finalized: unknown;
  try {
    const signed = layer === "unshielded"
      ? await (from.wallet as any).signRecipe(recipe, (payload: Uint8Array) =>
          from.unshieldedKeystore.signDataAsync(payload),
        )
      : recipe;
    finalized = await from.wallet.finalizeRecipe(signed as never);
    await from.wallet.submitTransaction(finalized as never);
  } catch (error) {
    await (from.wallet as any).revert(finalized ?? recipe).catch(() => undefined);
    throw error;
  }
  return {
    hash: txHash(finalized),
    identifiers: txIdentifiers(finalized),
    inputNullifiers: txInputNullifiers(finalized),
  };
}

async function waitForExactTokenBalances(
  user: WalletResult,
  solver: WalletResult,
  tokenA: string,
  tokenB: string,
  giveAmount: bigint,
  solverTokenBAmount: bigint,
  timeoutMs: number,
): Promise<RealBalanceSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let observed = await captureBalances(user, solver);
  while (Date.now() < deadline) {
    const userA = BigInt(observed.user.shielded[tokenA] ?? "0");
    const userB = BigInt(observed.user.shielded[tokenB] ?? "0");
    const solverA = BigInt(observed.solver.shielded[tokenA] ?? "0");
    const solverB = BigInt(observed.solver.shielded[tokenB] ?? "0");
    if (userA === giveAmount && userB === 0n && solverA === 0n && solverB === solverTokenBAmount) {
      const stable = await captureStableBalances(
        user,
        solver,
        Math.max(1, deadline - Date.now()),
        (candidate) =>
          BigInt(candidate.user.shielded[tokenA] ?? "0") === giveAmount &&
          BigInt(candidate.user.shielded[tokenB] ?? "0") === 0n &&
          BigInt(candidate.solver.shielded[tokenA] ?? "0") === 0n &&
          BigInt(candidate.solver.shielded[tokenB] ?? "0") === solverTokenBAmount,
      );
      return stable.at(-1)!;
    }
    await sleep(2_000);
    observed = await captureBalances(user, solver);
  }
  throw new Error(
    `exact A/B funding did not land before ${timeoutMs} ms: ${JSON.stringify(observed)}`,
  );
}

function expectedAfterSettlement(
  before: RealBalanceSnapshot,
  tokenA: string,
  tokenB: string,
  giveAmount: bigint,
  wantAmount: bigint,
): RealActorManifest["balances"]["expectedAfterSettlement"] {
  const amount = (
    actor: RealBalanceSnapshot["user"],
    token: string,
  ): bigint => BigInt(actor.shielded[token] ?? "0");
  return {
    user: {
      A: (amount(before.user, tokenA) - giveAmount).toString(),
      B: (amount(before.user, tokenB) + wantAmount).toString(),
    },
    solver: {
      A: (amount(before.solver, tokenA) + giveAmount).toString(),
      B: (amount(before.solver, tokenB) - wantAmount).toString(),
    },
  };
}

export function assertRealActorSettlementBalances(
  manifest: RealActorManifest,
  after: RealBalanceSnapshot,
): void {
  if (!matchesExpectedSettlement(manifest, after)) {
    throw new Error("settlement A/B balances differ from the fixture oracle");
  }
}

export function assertRealActorSettlementEvidence(
  manifest: RealActorManifest,
  evidence: RealSettlementBalanceEvidence,
): void {
  if (evidence.runId !== manifest.runId || evidence.schema !== "zswap-offer-files-real-settlement-balances/v1") {
    throw new Error("settlement balance evidence belongs to a different run or schema");
  }
  if (JSON.stringify(evidence.before) !== JSON.stringify(manifest.balances.beforeSettlement)) {
    throw new Error("settlement balance evidence does not use the fixture's exact pre-balance snapshot");
  }
  const expected = manifest.balances.expectedAfterSettlement;
  const actual = {
    user: {
      A: evidence.after.user.shielded[manifest.tokens.A] ?? "0",
      B: evidence.after.user.shielded[manifest.tokens.B] ?? "0",
    },
    solver: {
      A: evidence.after.solver.shielded[manifest.tokens.A] ?? "0",
      B: evidence.after.solver.shielded[manifest.tokens.B] ?? "0",
    },
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `settlement A/B balances differ from fixture oracle: ` +
        `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
  if (
    evidence.finality.source !== "wallet-facade-strict-sync" ||
    evidence.finality.requiredStableObservations !== REQUIRED_STABLE_OBSERVATIONS ||
    evidence.finality.observations.length !== REQUIRED_STABLE_OBSERVATIONS ||
    JSON.stringify(evidence.finality.observations.at(-1)) !== JSON.stringify(evidence.after)
  ) {
    throw new Error("settlement evidence lacks the required strict, repeated finality observations");
  }
  for (let index = 0; index < evidence.finality.observations.length; index += 1) {
    const observed = evidence.finality.observations[index]!;
    if (!matchesExpectedSettlement(manifest, observed)) {
      throw new Error(`settlement finality observation ${index + 1} does not match the A/B oracle`);
    }
    if (index > 0 && !stableFinalizedAssets(evidence.finality.observations[index - 1]!, observed)) {
      throw new Error(`settlement finality observation ${index + 1} regressed or changed`);
    }
  }
  const canonicalInteger = /^-?(?:0|[1-9][0-9]*)$/;
  if (
    evidence.netDustBalanceDelta.actor !== "solver" ||
    evidence.netDustBalanceDelta.asset !== "DUST" ||
    evidence.netDustBalanceDelta.balanceSource !== "wallet.dust.state/waitForDustFunds" ||
    evidence.netDustBalanceDelta.interpretation !== "net-balance-delta-not-exact-fee" ||
    !canonicalInteger.test(evidence.netDustBalanceDelta.before) ||
    !canonicalInteger.test(evidence.netDustBalanceDelta.after) ||
    !canonicalInteger.test(evidence.netDustBalanceDelta.delta) ||
    BigInt(evidence.netDustBalanceDelta.before) < 0n ||
    BigInt(evidence.netDustBalanceDelta.after) < 0n ||
    BigInt(evidence.netDustBalanceDelta.after) - BigInt(evidence.netDustBalanceDelta.before) !==
      BigInt(evidence.netDustBalanceDelta.delta) ||
    evidence.netDustBalanceDelta.before !== manifest.balances.dustBalanceEvidence.before ||
    evidence.netDustBalanceDelta.after !== evidence.after.solver.dust ||
    evidence.netDustBalanceDelta.delta !== evidence.delta.solver.dust
  ) {
    throw new Error(
      "settlement net DUST delta is malformed or not derived from the real solver dust wallet",
    );
  }
}

export async function writeRealActorSettlementEvidence(
  path: string,
  evidence: RealSettlementBalanceEvidence,
): Promise<void> {
  if (!isAbsolute(path)) throw new Error("settlement evidence path must be absolute");
  await atomicJson(path, evidence);
}

async function registerActorForDust(
  label: string,
  wallet: WalletResult,
  timeoutMs: number,
): Promise<void> {
  try {
    await registerNightForDust(wallet as any);
  } catch (error) {
    throw new Error(
      `${label} NIGHT-to-dust registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await waitForSync(wallet, { timeoutMs });
  await waitForDustFunds(wallet.wallet as any, { timeoutMs, waitNonZero: true });
}

export async function writeRealActorArtifacts(
  config: RealActorConfig,
  manifest: RealActorManifest,
): Promise<void> {
  const ladder = {
    tokens: { A: manifest.tokens.A, B: manifest.tokens.B },
    refPricesUsd: { A: "1", B: "1" },
    pairs: [
      {
        tokenIn: "A",
        tokenOut: "B",
        levels: [{ input: config.giveAmount.toString(), output: config.wantAmount.toString() }],
      },
    ],
  };
  const ladderSource = `${JSON.stringify(ladder, null, 2)}\n`;
  if (sha256(ladderSource) !== manifest.ladder.sha256) {
    throw new Error("ladder manifest hash does not match generated source");
  }
  await atomicText(config.ladderPath, ladderSource);
  await atomicJson(config.resultPath, manifest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readRealActorManifest(
  config: RealActorSettlementConfig,
): Promise<RealActorManifest> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(config.resultPath, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read actor provision manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(decoded)) throw new Error("actor provision manifest must be a JSON object");
  const manifest = decoded as unknown as RealActorManifest;
  if (manifest.schema !== SCHEMA || manifest.runId !== config.runId || manifest.networkId !== net.id) {
    throw new Error("actor provision manifest has the wrong schema, run, or network");
  }
  if (
    manifest.actors?.user?.seedFingerprint !== seedFingerprint(config.userSeed) ||
    manifest.actors?.solver?.seedFingerprint !== seedFingerprint(config.solverSeed)
  ) {
    throw new Error("actor provision manifest does not belong to the supplied user/solver seeds");
  }
  if (
    !/^[0-9a-f]{64}$/.test(manifest.tokens?.A ?? "") ||
    !/^[0-9a-f]{64}$/.test(manifest.tokens?.B ?? "") ||
    manifest.tokens.A === manifest.tokens.B ||
    manifest.tokens.NIGHT !== NIGHT
  ) {
    throw new Error("actor provision manifest has invalid token identities");
  }
  const canonicalUnsigned = /^(?:0|[1-9][0-9]*)$/;
  const expected = manifest.balances?.expectedAfterSettlement;
  if (
    !expected ||
    !canonicalUnsigned.test(expected.user?.A ?? "") ||
    !canonicalUnsigned.test(expected.user?.B ?? "") ||
    !canonicalUnsigned.test(expected.solver?.A ?? "") ||
    !canonicalUnsigned.test(expected.solver?.B ?? "") ||
    !canonicalUnsigned.test(manifest.balances?.beforeSettlement?.solver?.dust ?? "") ||
    BigInt(manifest.balances.beforeSettlement.solver.dust) <= 0n
  ) {
    throw new Error("actor provision manifest has invalid settlement balance or DUST oracles");
  }
  const give = manifest.offer?.gives?.[0];
  const want = manifest.offer?.wants?.[0];
  if (
    manifest.offer?.gives?.length !== 1 ||
    manifest.offer?.wants?.length !== 1 ||
    give?.kind !== "SHIELDED" ||
    give.token !== manifest.tokens.A ||
    !/^[1-9][0-9]*$/.test(give.amount) ||
    want?.kind !== "SHIELDED" ||
    want.token !== manifest.tokens.B ||
    !/^[1-9][0-9]*$/.test(want.amount)
  ) {
    throw new Error("actor provision manifest no longer describes one shielded A-to-B offer");
  }
  const recomputedExpected = expectedAfterSettlement(
    manifest.balances.beforeSettlement,
    manifest.tokens.A,
    manifest.tokens.B,
    BigInt(give.amount),
    BigInt(want.amount),
  );
  if (
    JSON.stringify(recomputedExpected) !== JSON.stringify(expected) ||
    manifest.balances.dustBalanceEvidence?.before !==
      manifest.balances.beforeSettlement.solver.dust ||
    manifest.balances.dustBalanceEvidence?.interpretation !== "net-balance-delta-not-exact-fee"
  ) {
    throw new Error("actor provision manifest settlement oracle is not derived from its exact pre-state");
  }
  if (
    !/^[0-9a-f]{64}$/.test(manifest.offer?.offerHash ?? "") ||
    !manifest.offer.transactionHash ||
    !Array.isArray(manifest.offer.expectedNullifiers) ||
    manifest.offer.expectedNullifiers.length === 0 ||
    !Array.isArray(manifest.offer.expectedCommitments) ||
    manifest.offer.expectedCommitments.length === 0
  ) {
    throw new Error("actor provision manifest has invalid offer/settlement identity oracles");
  }
  try {
    if (sha256(OfferFiles.decode(manifest.offer.offerBlob)) !== manifest.offer.offerHash) {
      throw new Error("offer blob hash differs");
    }
  } catch (error) {
    throw new Error(
      `actor provision manifest offer blob is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return manifest;
}

export async function openRealSettlementActors(
  config: RealActorSettlementConfig,
  onPhase: (phase: string) => void | Promise<void> = () => undefined,
  signal?: AbortSignal,
): Promise<RealSettlementActorFixture> {
  setNetworkId(net.id as any);
  globalThis.WebSocket = WebSocket;
  const owned: Array<{ label: string; result: WalletResult }> = [];
  const cleanupWallets = createIdempotentRealActorCleanup(() =>
    owned.map(({ label, result }) => ({
      label,
      stop: () => Promise.resolve((result.wallet as any).stop?.()),
    })),
  );
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    signal?.removeEventListener("abort", abortForSignal);
    closePromise = cleanupWallets();
    return closePromise;
  };
  function abortForSignal(): void {
    void close().catch(() => undefined);
  }
  signal?.addEventListener("abort", abortForSignal, { once: true });
  const abortError = (): Error =>
    signal?.reason instanceof Error ? signal.reason : new Error("settlement verification aborted");
  const assertNotAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };
  const phase = async (value: string): Promise<void> => {
    assertNotAborted();
    await onPhase(value);
    assertNotAborted();
  };
  const buildOwned = async (label: string, seed: string): Promise<WalletResult> => {
    assertNotAborted();
    const result = await buildWallet(seed);
    if (signal?.aborted || closePromise) {
      try {
        await Promise.resolve((result.wallet as any).stop?.());
      } catch (cleanupError) {
        throw new AggregateError(
          [abortError(), cleanupError],
          `${label} wallet completed startup after settlement verification was aborted`,
        );
      }
      throw abortError();
    }
    owned.push({ label, result });
    return result;
  };

  try {
    await phase("reading-provision-manifest");
    const manifest = await readRealActorManifest(config);
    await phase("reopening-settlement-wallets");
    const user = await buildOwned("user", config.userSeed);
    const solver = await buildOwned("solver", config.solverSeed);
    await phase("syncing-settlement-wallets");
    await Promise.all([
      waitForSync(user, { timeoutMs: config.syncTimeoutMs }),
      waitForSync(solver, { timeoutMs: config.syncTimeoutMs }),
    ]);
    await Promise.all([
      waitForDustFunds(user.wallet as any, {
        timeoutMs: config.syncTimeoutMs,
        waitNonZero: true,
      }),
      waitForDustFunds(solver.wallet as any, {
        timeoutMs: config.syncTimeoutMs,
        waitNonZero: true,
      }),
    ]);
    assertNotAborted();
    let fixture!: RealSettlementActorFixture;
    fixture = {
      user,
      solver,
      manifest,
      captureBalances: () => captureBalances(user, solver, config.syncTimeoutMs, true),
      captureSettlementEvidence: (timeoutMs = config.settlementTimeoutMs) =>
        captureRealActorSettlementEvidence(fixture, timeoutMs),
      close,
    };
    await phase("settlement-wallets-ready");
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "settlement actor startup and cleanup both failed",
      );
    }
    throw error;
  }
}

export async function provisionRealActors(
  config: RealActorConfig,
  onPhase: (phase: string) => void | Promise<void> = () => undefined,
  signal?: AbortSignal,
): Promise<RealActorFixture> {
  setNetworkId(net.id as any);
  globalThis.WebSocket = WebSocket;

  const wallets: WalletResult[] = [];
  const cleanupWallets = createIdempotentRealActorCleanup(() =>
    wallets.map((result, index) => ({
      label: `wallet-${index + 1}/${wallets.length}`,
      stop: () => Promise.resolve((result.wallet as any).stop?.()),
    })),
  );
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    signal?.removeEventListener("abort", abortForSignal);
    closePromise = cleanupWallets();
    return closePromise;
  };
  function abortForSignal(): void {
    void close().catch(() => undefined);
  }
  signal?.addEventListener("abort", abortForSignal, { once: true });
  const abortError = (): Error => {
    const reason = signal?.reason;
    return reason instanceof Error ? reason : new Error("real actor provisioning aborted");
  };
  const assertNotAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };
  const phase = async (name: string): Promise<void> => {
    assertNotAborted();
    await onPhase(name);
    assertNotAborted();
  };
  const buildOwnedWallet = async (seed: string): Promise<WalletResult> => {
    assertNotAborted();
    const result = await buildWallet(seed);
    if (signal?.aborted || closePromise) {
      try {
        await Promise.resolve((result.wallet as any).stop?.());
      } catch (cleanupError) {
        throw new AggregateError(
          [abortError(), cleanupError],
          "wallet completed startup after actor provisioning was aborted",
        );
      }
      throw abortError();
    }
    wallets.push(result);
    return result;
  };

  try {
    await phase("building-wallets");
    const genesis = await buildOwnedWallet(config.genesisSeed);
    await waitForSync(genesis, { requireUnshieldedFunds: true, timeoutMs: config.syncTimeoutMs });
    assertNotAborted();

    const user = await buildOwnedWallet(config.userSeed);
    await waitForSync(user, { timeoutMs: config.syncTimeoutMs });
    assertNotAborted();

    const solver = await buildOwnedWallet(config.solverSeed);
    await waitForSync(solver, { timeoutMs: config.syncTimeoutMs });
    assertNotAborted();

    const beforeFunding = await captureBalances(user, solver, config.syncTimeoutMs, false);
    const hasNonZeroBalance = (values: Record<string, string>): boolean =>
      Object.values(values).some((amount) => BigInt(amount) !== 0n);
    if (
      hasNonZeroBalance(beforeFunding.user.shielded) ||
      hasNonZeroBalance(beforeFunding.user.unshielded) ||
      BigInt(beforeFunding.user.dust) !== 0n ||
      hasNonZeroBalance(beforeFunding.solver.shielded) ||
      hasNonZeroBalance(beforeFunding.solver.unshielded) ||
      BigInt(beforeFunding.solver.dust) !== 0n
    ) {
      throw new Error("E1 user and solver seeds must resolve to completely fresh zero-balance wallets");
    }

    await phase("registering-genesis");
    try {
      await registerNightForDust(genesis as any);
    } catch (error) {
      // The contract deploy/mint process may have registered the shared
      // genesis first. Only that one pre-existing registration is tolerated.
      if (!/already|registered|exists/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
    await waitForSync(genesis, { requireUnshieldedFunds: true, timeoutMs: config.syncTimeoutMs });
    await waitForDustFunds(genesis.wallet as any, {
      timeoutMs: config.syncTimeoutMs,
      waitNonZero: true,
    });

    await phase("minting-tokens");
    const deployed = await joinOfferFiles(genesis);
    const tokenA = await mintShielded(
      deployed,
      config.tokenASeparator,
      config.mintAmount,
      config.mintNonce,
    );
    const tokenB = await mintShielded(
      deployed,
      config.tokenBSeparator,
      config.mintAmount,
      config.mintNonce + 1n,
    );
    if (tokenA === tokenB || !/^[0-9a-f]{64}$/.test(tokenA) || !/^[0-9a-f]{64}$/.test(tokenB)) {
      throw new Error("real mint returned invalid or identical A/B token colors");
    }
    const genesisTokenA = await waitForShielded(
      genesis,
      tokenA,
      config.mintAmount,
      60,
      2_000,
    );
    if (genesisTokenA !== config.mintAmount) {
      throw new Error(
        `genesis must expose exactly one newly minted token-A balance: ` +
          `observed=${genesisTokenA} expected=${config.mintAmount}`,
      );
    }
    if ((await waitForShielded(genesis, tokenB, config.solverTokenBAmount, 60, 2_000)) < config.solverTokenBAmount) {
      throw new Error("genesis did not observe minted token B");
    }

    await phase("building-pre-spent-liveness-offer");
    const preSpentCandidate = await buildRealPreSpentOfferCandidate(genesis, {
      tokenA,
      tokenB,
      giveAmount: config.mintAmount,
      wantAmount: config.wantAmount,
      expiresAt: new Date(Date.now() + config.offerTtlMs),
    });

    await phase("funding-night-utxos");
    const userUnshielded = unshieldedAddressObj(user);
    const solverUnshielded = unshieldedAddressObj(solver);
    const nightOutputs = [
      ...Array.from({ length: config.nightUtxosPerActor }, () => ({
        type: NIGHT,
        amount: config.nightPerUtxo,
        receiverAddress: userUnshielded,
      })),
      ...Array.from({ length: config.nightUtxosPerActor }, () => ({
        type: NIGHT,
        amount: config.nightPerUtxo,
        receiverAddress: solverUnshielded,
      })),
    ];
    const nightFundingTransaction = await submitTransfer(
      genesis,
      "unshielded",
      nightOutputs,
      config.offerTtlMs,
    );
    const expectedNight = config.nightPerUtxo * BigInt(config.nightUtxosPerActor);
    const [userNight, solverNight] = await Promise.all([
      waitForUnshielded(user, NIGHT, expectedNight, 120, 2_000),
      waitForUnshielded(solver, NIGHT, expectedNight, 120, 2_000),
    ]);
    if (userNight !== expectedNight || solverNight !== expectedNight) {
      throw new Error(
        `separate NIGHT UTXO funding was not exact: user=${userNight} solver=${solverNight} expected=${expectedNight}`,
      );
    }

    await phase("registering-actors");
    await registerActorForDust("user", user, config.syncTimeoutMs);
    await registerActorForDust("solver", solver, config.syncTimeoutMs);

    await phase("funding-shielded-inventory");
    const [userShieldedAddress, solverShieldedAddress] = await Promise.all([
      user.wallet.shielded.getAddress(),
      solver.wallet.shielded.getAddress(),
    ]);
    const tokenFundingTransactions: RealActorManifest["funding"]["tokenFundingTransactions"] = [];
    const tokenAFundingTransaction = await submitTransfer(
      genesis,
      "shielded",
      [{ type: tokenA, amount: config.giveAmount, receiverAddress: userShieldedAddress }],
      config.offerTtlMs,
    );
    tokenFundingTransactions.push({
      token: "A",
      ...manifestTransactionOracle(tokenAFundingTransaction),
    });
    const preSpentLiveness = bindRealPreSpentLivenessArtifact(
      config.runId,
      net.id,
      preSpentCandidate,
      tokenAFundingTransaction,
    );
    tokenFundingTransactions.push({
      token: "B",
      ...manifestTransactionOracle(await submitTransfer(
        genesis,
        "shielded",
        [{ type: tokenB, amount: config.solverTokenBAmount, receiverAddress: solverShieldedAddress }],
        config.offerTtlMs,
      )),
    });

    const beforeSettlement = await waitForExactTokenBalances(
      user,
      solver,
      tokenA,
      tokenB,
      config.giveAmount,
      config.solverTokenBAmount,
      config.fundingTimeoutMs,
    );
    if (BigInt(beforeSettlement.user.dust) <= 0n || BigInt(beforeSettlement.solver.dust) <= 0n) {
      throw new Error(
        `registered actors must expose positive real DUST balances: ` +
          `user=${beforeSettlement.user.dust} solver=${beforeSettlement.solver.dust}`,
      );
    }

    await phase("building-offer");
    const expiresAt = new Date(Date.now() + config.offerTtlMs);
    const recipe = await user.wallet.initSwap(
      { shielded: { [tokenA]: config.giveAmount } },
      [
        {
          type: "shielded",
          outputs: [{
            type: tokenB,
            amount: config.wantAmount,
            receiverAddress: userShieldedAddress,
          }],
        } as never,
      ],
      shieldedKeys(user),
      { ttl: expiresAt, payFees: false },
    );
    const finalized = await user.wallet.finalizeTransaction(recipe.transaction);
    const offerBlob = OfferFiles.encode(finalized.serialize());
    const validation = validateZswapOffer(offerBlob, {
      refState: getBlankRefState(net.id),
      tblock: new Date(),
      maxBytes: MAX_OFFER_BYTES,
      crypto: "verify",
    });
    if (!validation.ok || !validation.tx || !validation.gives || !validation.wants) {
      await (user.wallet as any).revert(recipe).catch(() => undefined);
      throw new Error(
        `real A->B offer failed source validation: ${validation.code ?? "UNKNOWN"} ` +
          `${validation.reason ?? "no reason"}`,
      );
    }
    if (
      validation.gives.length !== 1 ||
      validation.gives[0]?.kind !== "SHIELDED" ||
      validation.gives[0]?.token !== tokenA ||
      validation.gives[0]?.amount !== config.giveAmount.toString() ||
      validation.wants.length !== 1 ||
      validation.wants[0]?.kind !== "SHIELDED" ||
      validation.wants[0]?.token !== tokenB ||
      validation.wants[0]?.amount !== config.wantAmount.toString()
    ) {
      await (user.wallet as any).revert(recipe).catch(() => undefined);
      throw new Error(
        `real offer economics differ from requested A->B terms: ` +
          `gives=${JSON.stringify(validation.gives)} wants=${JSON.stringify(validation.wants)}`,
      );
    }
    const expectedNullifiers = [...(validation.nullifiers ?? [])].sort();
    const expectedCommitments = collectOutputCommitments(validation.tx).sort();
    if (expectedNullifiers.length === 0 || expectedCommitments.length === 0) {
      await (user.wallet as any).revert(recipe).catch(() => undefined);
      throw new Error("real A->B offer did not expose nullifier and commitment oracles");
    }

    const ladderSource = `${JSON.stringify({
      tokens: { A: tokenA, B: tokenB },
      refPricesUsd: { A: "1", B: "1" },
      pairs: [{
        tokenIn: "A",
        tokenOut: "B",
        levels: [{ input: config.giveAmount.toString(), output: config.wantAmount.toString() }],
      }],
    }, null, 2)}\n`;

    const manifest: RealActorManifest = {
      schema: SCHEMA,
      runId: config.runId,
      networkId: net.id,
      createdAt: nowIso(),
      actors: {
        genesis: { seedFingerprint: seedFingerprint(config.genesisSeed) },
        user: { seedFingerprint: seedFingerprint(config.userSeed) },
        solver: { seedFingerprint: seedFingerprint(config.solverSeed) },
      },
      tokens: { A: tokenA, B: tokenB, NIGHT },
      funding: {
        mintAmount: config.mintAmount.toString(),
        userTokenAAmount: config.giveAmount.toString(),
        solverTokenBAmount: config.solverTokenBAmount.toString(),
        nightPerUtxo: config.nightPerUtxo.toString(),
        nightUtxosPerActor: config.nightUtxosPerActor,
        nightFundingTransaction: manifestTransactionOracle(nightFundingTransaction),
        tokenFundingTransactions,
      },
      balances: {
        beforeFunding,
        beforeSettlement,
        expectedAfterSettlement: expectedAfterSettlement(
          beforeSettlement,
          tokenA,
          tokenB,
          config.giveAmount,
          config.wantAmount,
        ),
        dustBalanceEvidence: {
          actor: "solver",
          asset: "DUST",
          balanceSource: "wallet.dust.state/waitForDustFunds",
          before: beforeSettlement.solver.dust,
          after: null,
          delta: null,
          interpretation: "net-balance-delta-not-exact-fee",
        },
      },
      offer: {
        offerBlob,
        offerHash: sha256(OfferFiles.decode(offerBlob)),
        transactionHash: txHash(finalized),
        identifiers: txIdentifiers(finalized),
        expectedNullifiers,
        expectedCommitments,
        inputRoots: [...(validation.inputRoots ?? [])].sort(),
        gives: validation.gives,
        wants: validation.wants,
        expiresAt: expiresAt.toISOString(),
      },
      ladder: { path: config.ladderPath, sha256: sha256(ladderSource) },
    };

    // E1-Q7 evidence: occurrences and attempt counts land in the provisioner
    // log, which the runner captures into the acceptance diagnostics bundle.
    console.log(
      `[real-actors] E1-Q7 dust-proof retry evidence: ${JSON.stringify(realActorDustProofRetryEvidence())}`,
    );
    await phase("provisioned");
    const fixture: RealActorFixture = {
      genesis,
      user,
      solver,
      manifest,
      preSpentLiveness,
      captureBalances: () => captureBalances(user, solver, config.syncTimeoutMs, true),
      captureSettlementEvidence: (timeoutMs = config.fundingTimeoutMs) =>
        captureRealActorSettlementEvidence(fixture, timeoutMs),
      close,
    };
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "actor provisioning and cleanup both failed");
    }
    throw error;
  }
}

async function runProvisionCli(): Promise<void> {
  const config = readRealActorConfig();
  const owner = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  const receiveSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (receivedSignal) return;
    receivedSignal = signal;
    owner.abort(new Error(`real actor fixture received ${signal}`));
  };
  const onTerm = (): void => receiveSignal("SIGTERM");
  const onInt = (): void => receiveSignal("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const runtime = async (state: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await atomicJson(config.runtimePath, {
      schema: SCHEMA,
      runId: config.runId,
      networkId: net.id,
      pid: process.pid,
      state,
      updatedAt: nowIso(),
      resultPath: config.resultPath,
      ladderPath: config.ladderPath,
      preSpentPath: config.preSpentPath,
      actors: {
        user: seedFingerprint(config.userSeed),
        solver: seedFingerprint(config.solverSeed),
      },
      ...extra,
    });
  };

  let fixture: RealActorFixture | undefined;
  let failure: unknown;
  try {
    await runtime("starting");
    fixture = await provisionRealActors(
      config,
      (phase) => runtime("working", { phase }),
      owner.signal,
    );
    if (owner.signal.aborted) throw owner.signal.reason;
    await writeRealPreSpentLivenessArtifact(
      config.preSpentPath,
      fixture.preSpentLiveness,
    );
    if (owner.signal.aborted) throw owner.signal.reason;
    await writeRealActorArtifacts(config, fixture.manifest);
    if (owner.signal.aborted) throw owner.signal.reason;
    await runtime("complete", {
      offerHash: fixture.manifest.offer.offerHash,
      nullifierCount: fixture.manifest.offer.expectedNullifiers.length,
      commitmentCount: fixture.manifest.offer.expectedCommitments.length,
      preSpentOfferHash: fixture.preSpentLiveness.offerHash,
      preSpentNullifierCount: fixture.preSpentLiveness.inputNullifiers.length,
      consumingFundingTxHash: fixture.preSpentLiveness.consumingFundingTxHash,
    });
  } catch (error) {
    failure = error;
  }
  try {
    await fixture?.close();
  } catch (cleanupError) {
    failure = failure === undefined
      ? cleanupError
      : new AggregateError([failure, cleanupError], "actor CLI work and cleanup both failed");
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }

  if (receivedSignal) {
    await runtime("interrupted", {
      signal: receivedSignal,
      ...(failure === undefined
        ? {}
        : { error: failure instanceof Error ? failure.message : String(failure) }),
    }).catch(() => undefined);
    if (failure !== undefined) {
      console.error(
        `[real-actors] ${receivedSignal} cleanup: ` +
          `${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`,
      );
    }
    process.exitCode = realActorSignalExitCode(receivedSignal);
    return;
  }
  if (failure !== undefined) {
    await runtime("failed", {
      error: failure instanceof Error ? failure.message : String(failure),
    }).catch(() => undefined);
    throw failure;
  }
}

async function runSettlementVerificationCli(): Promise<void> {
  const config = readRealActorSettlementConfig();
  const owner = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | null = null;
  const receiveSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (receivedSignal) return;
    receivedSignal = signal;
    owner.abort(new Error(`real settlement verifier received ${signal}`));
  };
  const onTerm = (): void => receiveSignal("SIGTERM");
  const onInt = (): void => receiveSignal("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const runtime = async (state: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await atomicJson(config.runtimePath, {
      schema: SCHEMA,
      runId: config.runId,
      networkId: net.id,
      pid: process.pid,
      state,
      updatedAt: nowIso(),
      resultPath: config.resultPath,
      settlementPath: config.settlementPath,
      actors: {
        user: seedFingerprint(config.userSeed),
        solver: seedFingerprint(config.solverSeed),
      },
      ...extra,
    });
  };

  let fixture: RealSettlementActorFixture | undefined;
  let failure: unknown;
  try {
    await runtime("starting", { operation: "verify-settlement" });
    fixture = await openRealSettlementActors(
      config,
      (phase) => runtime("working", { operation: "verify-settlement", phase }),
      owner.signal,
    );
    if (owner.signal.aborted) throw owner.signal.reason;
    const evidence = await fixture.captureSettlementEvidence(config.settlementTimeoutMs);
    if (owner.signal.aborted) throw owner.signal.reason;
    await writeRealActorSettlementEvidence(config.settlementPath, evidence);
    if (owner.signal.aborted) throw owner.signal.reason;
    await runtime("complete", {
      operation: "verify-settlement",
      offerHash: fixture.manifest.offer.offerHash,
      settlementEvidenceSha256: sha256(`${JSON.stringify(evidence, null, 2)}\n`),
      stableObservations: evidence.finality.observations.length,
      netSolverDustDelta: evidence.netDustBalanceDelta.delta,
    });
  } catch (error) {
    failure = error;
  }
  try {
    await fixture?.close();
  } catch (cleanupError) {
    failure = failure === undefined
      ? cleanupError
      : new AggregateError(
          [failure, cleanupError],
          "settlement verifier work and cleanup both failed",
        );
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  }

  if (receivedSignal) {
    await runtime("interrupted", {
      operation: "verify-settlement",
      signal: receivedSignal,
      ...(failure === undefined
        ? {}
        : { error: failure instanceof Error ? failure.message : String(failure) }),
    }).catch(() => undefined);
    if (failure !== undefined) {
      console.error(
        `[real-actors] ${receivedSignal} settlement cleanup: ` +
          `${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`,
      );
    }
    process.exitCode = realActorSignalExitCode(receivedSignal);
    return;
  }
  if (failure !== undefined) {
    await runtime("failed", {
      operation: "verify-settlement",
      error: failure instanceof Error ? failure.message : String(failure),
    }).catch(() => undefined);
    throw failure;
  }
}

async function runBuildIntentCli(): Promise<void> {
  if (net.id !== "undeployed") throw new Error(`real intent builder requires undeployed, got ${net.id}`);
  const runId = requireRunId(process.env["E1_RUN_ID"]);
  const solverSeed = requireSeed("E1_SOLVER_SEED", process.env["E1_SOLVER_SEED"]);
  const manifestPath = requireAbsolutePath("E1_ACTOR_RESULT_PATH", process.env["E1_ACTOR_RESULT_PATH"]);
  const intentPath = requireAbsolutePath("E1_INTENT_PATH", process.env["E1_INTENT_PATH"]);
  const runtimePath = requireAbsolutePath("E1_INTENT_RUNTIME_PATH", process.env["E1_INTENT_RUNTIME_PATH"]);
  const syncTimeoutMs = positiveSafeInteger("E1_SYNC_TIMEOUT_MS", process.env["E1_SYNC_TIMEOUT_MS"], 300_000);
  const ttlMs = positiveSafeInteger("E1_INTENT_TTL_MS", process.env["E1_INTENT_TTL_MS"], 30 * 60_000);
  if (new Set([manifestPath, intentPath, runtimePath]).size !== 3) {
    throw new Error("intent manifest/result/runtime paths must be distinct");
  }
  const runtime = (state: string, extra: Record<string, unknown> = {}) => atomicJson(runtimePath, {
    schema: "zswap-offer-files-real-intent-runtime/v1",
    runId,
    state,
    updatedAt: nowIso(),
    ...extra,
  });
  await runtime("starting");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RealActorManifest;
  const gives = manifest.offer?.gives?.[0];
  const wants = manifest.offer?.wants?.[0];
  if (
    manifest.schema !== SCHEMA || manifest.runId !== runId || manifest.networkId !== "undeployed" ||
    manifest.actors?.solver?.seedFingerprint !== seedFingerprint(solverSeed) ||
    manifest.offer?.gives?.length !== 1 || manifest.offer.wants.length !== 1 ||
    gives?.kind !== "SHIELDED" || wants?.kind !== "SHIELDED" ||
    gives.token !== manifest.tokens.A || wants.token !== manifest.tokens.B ||
    !/^[1-9][0-9]*$/.test(gives.amount) || !/^[1-9][0-9]*$/.test(wants.amount)
  ) {
    throw new Error("intent builder actor manifest is not the exact funded A/B oracle");
  }
  setNetworkId(net.id as any);
  globalThis.WebSocket = WebSocket;
  const solver = await buildWallet(solverSeed);
  let recipe: unknown;
  let failure: unknown;
  try {
    await runtime("working", { phase: "syncing-taker-wallet" });
    await waitForSync(solver, { timeoutMs: syncTimeoutMs });
    const amountIn = BigInt(wants.amount);
    const amountOut = BigInt(gives.amount);
    if ((await waitForShielded(solver, wants.token, amountIn, 120, 2_000)) < amountIn) {
      throw new Error("taker wallet does not hold the exact token-B input");
    }
    const receiverAddress = await solver.wallet.shielded.getAddress();
    const expiresAt = new Date(Date.now() + ttlMs);
    await runtime("working", { phase: "proving-taker-intent", expiresAt: expiresAt.toISOString() });
    recipe = await solver.wallet.initSwap(
      { shielded: { [wants.token]: amountIn } },
      [{
        type: "shielded",
        outputs: [{ type: gives.token, amount: amountOut, receiverAddress }],
      } as never],
      shieldedKeys(solver),
      { ttl: expiresAt, payFees: false },
    );
    const finalized = await (solver.wallet as any).finalizeRecipe(recipe);
    const serialized = Uint8Array.from(finalized.serialize());
    if (serialized.length === 0 || serialized.length > MAX_OFFER_BYTES) {
      throw new Error("proved taker intent bytes are empty or oversized");
    }
    const guaranteed = finalized.guaranteedOffer?.deltas;
    if (!(guaranteed instanceof Map)) throw new Error("proved taker intent exposes no guaranteed deltas");
    const guaranteedDeltas = [...guaranteed].map(([token, amount]) =>
      [token, BigInt(String(amount))] as const
    );
    const positive = guaranteedDeltas.filter(([, amount]) => amount > 0n);
    const negative = guaranteedDeltas.filter(([, amount]) => amount < 0n);
    if (
      positive.length !== 1 || negative.length !== 1 ||
      String(positive[0]![0]).toLowerCase() !== wants.token || positive[0]![1] !== amountIn ||
      String(negative[0]![0]).toLowerCase() !== gives.token || -negative[0]![1] !== amountOut
    ) {
      throw new Error("proved taker intent deltas differ from the exact relay quote");
    }
    const artifact = {
      schema: "zswap-offer-files-real-taker-intent/v1",
      runId,
      networkId: net.id,
      createdAt: nowIso(),
      expiresAt: expiresAt.toISOString(),
      actor: "solver-as-taker",
      seedFingerprint: seedFingerprint(solverSeed),
      proofBoundary: "wallet.finalizeRecipe",
      quote: {
        tokenIn: wants.token,
        tokenOut: gives.token,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
      },
      transaction: {
        rawBase64: Buffer.from(serialized).toString("base64"),
        bytes: serialized.length,
        sha256: sha256(serialized),
        transactionHash: txHash(finalized),
        identifiers: txIdentifiers(finalized),
        inputNullifiers: txInputNullifiers(finalized),
      },
    };
    await Promise.resolve((solver.wallet as any).stop?.());
    await sealedJson(intentPath, artifact);
    await runtime("complete", {
      intentSha256: artifact.transaction.sha256,
      intentBytes: artifact.transaction.bytes,
      inputNullifierCount: artifact.transaction.inputNullifiers.length,
    });
    return;
  } catch (error) {
    failure = error;
  }
  if (recipe !== undefined) await (solver.wallet as any).revert?.(recipe).catch(() => undefined);
  try {
    await Promise.resolve((solver.wallet as any).stop?.());
  } catch (cleanupError) {
    failure = new AggregateError([failure, cleanupError], "intent build and wallet cleanup both failed");
  }
  await runtime("failed", { error: failure instanceof Error ? failure.message : String(failure) }).catch(() => undefined);
  throw failure;
}

async function runCli(): Promise<void> {
  const command = process.argv[2];
  if (command === "provision") return runProvisionCli();
  if (command === "build-intent") return runBuildIntentCli();
  if (command === "verify-settlement") return runSettlementVerificationCli();
  throw new Error(
    "usage: solver-offerfiles-real-actors.ts provision|build-intent|verify-settlement",
  );
}

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(`[real-actors] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
