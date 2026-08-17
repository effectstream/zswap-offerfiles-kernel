// Additive, data-only Offer Files liquidity contract shared by the producer
// implementation and its contract tests. This module describes market data;
// it contains no quote reservation, intent, wallet, or settlement capability.

import {
  isPriceLevels,
  MAX_PAIRS_PER_PUSH,
  MAX_RUNGS_PER_PAIR,
  pairKey,
  type PriceLevels,
} from "./ladder-schema.ts";

export const SOLVER_LIQUIDITY_SCHEMA_VERSION = 1 as const;
export const SOLVER_LIQUIDITY_SOURCE = "offer-files-solver" as const;
export const MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES = 1_048_576;
export const MAX_FILTERED_LIQUIDITY_SNAPSHOTS = 1;

const UINT64_MAX = (1n << 64n) - 1n;
const VERSION_RE = /^[1-9][0-9]{0,19}$/;
const SOLVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SolverLiquiditySnapshot {
  solverId: string;
  version: string;
  updatedAt: string;
  expiresAt: string;
  pairs: PriceLevels[];
}

export interface SolverLiquidityEnvelope {
  schemaVersion: typeof SOLVER_LIQUIDITY_SCHEMA_VERSION;
  source: typeof SOLVER_LIQUIDITY_SOURCE;
  generatedAt: string;
  snapshots: SolverLiquiditySnapshot[];
}

export interface CreateSolverLiquiditySnapshotInput {
  solverId: string;
  version: string;
  updatedAtMs: number;
  expiresAtMs: number;
  pairs: PriceLevels[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Positive canonical decimal u64 strings remain exact beyond Number.MAX_SAFE_INTEGER. */
export function parsePositiveU64String(value: unknown): bigint | null {
  if (typeof value !== "string" || !VERSION_RE.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT64_MAX ? parsed : null;
}

export const isSolverLiquidityId = (value: unknown): value is string =>
  typeof value === "string" && SOLVER_ID_RE.test(value);

/** Decode only canonical four-digit-year UTC timestamps with millisecond precision. */
export function parseLiquidityTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

export function formatLiquidityTimestamp(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new RangeError("liquidity timestamp must be a non-negative safe integer epoch-ms value");
  }
  const formatted = new Date(epochMs).toISOString();
  if (!TIMESTAMP_RE.test(formatted)) {
    throw new RangeError("liquidity timestamp must fit canonical four-digit-year RFC3339");
  }
  return formatted;
}

function isClosedPriceLevels(value: unknown): value is PriceLevels {
  if (!hasExactKeys(value, ["tokenIn", "tokenOut", "levels"])) return false;
  if (!isPriceLevels(value)) return false;
  if (value.tokenIn !== value.tokenIn.toLowerCase()) return false;
  if (value.tokenOut !== value.tokenOut.toLowerCase()) return false;
  if (value.levels.length > MAX_RUNGS_PER_PAIR) return false;
  return value.levels.every((level) => hasExactKeys(level, ["input", "output"]));
}

function areStableUniquePairs(value: unknown): value is PriceLevels[] {
  if (!Array.isArray(value) || value.length > MAX_PAIRS_PER_PUSH) return false;
  let previous: string | null = null;
  for (const pair of value) {
    if (!isClosedPriceLevels(pair)) return false;
    const key = pairKey(pair.tokenIn, pair.tokenOut);
    if (previous !== null && key <= previous) return false;
    previous = key;
  }
  return true;
}

export function isSolverLiquiditySnapshot(value: unknown): value is SolverLiquiditySnapshot {
  if (
    !hasExactKeys(value, ["solverId", "version", "updatedAt", "expiresAt", "pairs"]) ||
    !isSolverLiquidityId(value.solverId) ||
    parsePositiveU64String(value.version) === null ||
    !areStableUniquePairs(value.pairs)
  ) {
    return false;
  }
  const updatedAt = parseLiquidityTimestamp(value.updatedAt);
  const expiresAt = parseLiquidityTimestamp(value.expiresAt);
  return updatedAt !== null && expiresAt !== null && expiresAt >= updatedAt;
}

export function isSolverLiquidityEnvelope(value: unknown): value is SolverLiquidityEnvelope {
  if (
    !hasExactKeys(value, ["schemaVersion", "source", "generatedAt", "snapshots"]) ||
    value.schemaVersion !== SOLVER_LIQUIDITY_SCHEMA_VERSION ||
    value.source !== SOLVER_LIQUIDITY_SOURCE ||
    parseLiquidityTimestamp(value.generatedAt) === null ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length > MAX_FILTERED_LIQUIDITY_SNAPSHOTS
  ) {
    return false;
  }
  return value.snapshots.every(isSolverLiquiditySnapshot);
}

const clonePair = (pair: PriceLevels): PriceLevels => ({
  tokenIn: pair.tokenIn,
  tokenOut: pair.tokenOut,
  levels: pair.levels.map((level) => ({ input: level.input, output: level.output })),
});

const cloneSnapshot = (snapshot: SolverLiquiditySnapshot): SolverLiquiditySnapshot => ({
  solverId: snapshot.solverId,
  version: snapshot.version,
  updatedAt: snapshot.updatedAt,
  expiresAt: snapshot.expiresAt,
  pairs: snapshot.pairs.map(clonePair),
});

export function createSolverLiquiditySnapshot(
  input: CreateSolverLiquiditySnapshotInput,
): SolverLiquiditySnapshot {
  const pairs = input.pairs
    .map((pair) => ({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      levels: pair.levels.map((level) => ({ input: level.input, output: level.output })),
    }))
    .sort((a, b) => pairKey(a.tokenIn, a.tokenOut).localeCompare(pairKey(b.tokenIn, b.tokenOut)));
  const snapshot: SolverLiquiditySnapshot = {
    solverId: input.solverId,
    version: input.version,
    updatedAt: formatLiquidityTimestamp(input.updatedAtMs),
    expiresAt: formatLiquidityTimestamp(input.expiresAtMs),
    pairs,
  };
  if (!isSolverLiquiditySnapshot(snapshot)) {
    throw new TypeError("invalid solver liquidity snapshot");
  }
  return snapshot;
}

export function createSolverLiquidityEnvelope(
  generatedAtMs: number,
  snapshots: SolverLiquiditySnapshot[],
): SolverLiquidityEnvelope {
  const envelope: SolverLiquidityEnvelope = {
    schemaVersion: SOLVER_LIQUIDITY_SCHEMA_VERSION,
    source: SOLVER_LIQUIDITY_SOURCE,
    generatedAt: formatLiquidityTimestamp(generatedAtMs),
    snapshots: snapshots
      .map(cloneSnapshot)
      .sort((a, b) => a.solverId.localeCompare(b.solverId)),
  };
  if (!isSolverLiquidityEnvelope(envelope)) {
    throw new TypeError("invalid solver liquidity envelope");
  }
  if (solverLiquidityEnvelopeByteLength(envelope) > MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES) {
    throw new RangeError(
      `solver liquidity envelope exceeds ${MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES} bytes`,
    );
  }
  return envelope;
}

export function solverLiquidityEnvelopeByteLength(envelope: SolverLiquidityEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}

/** Strictly parse a decoded JSON value and return a detached copy. */
export function parseSolverLiquidityEnvelope(value: unknown): SolverLiquidityEnvelope | null {
  if (!isSolverLiquidityEnvelope(value)) return null;
  return {
    schemaVersion: value.schemaVersion,
    source: value.source,
    generatedAt: value.generatedAt,
    snapshots: value.snapshots.map(cloneSnapshot),
  };
}

/** Bound raw bytes before JSON.parse so an upstream response cannot allocate unbounded state. */
export function parseSolverLiquidityEnvelopeJson(
  raw: string | Uint8Array,
): SolverLiquidityEnvelope | null {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.byteLength > MAX_SOLVER_LIQUIDITY_RESPONSE_BYTES) return null;
  try {
    return parseSolverLiquidityEnvelope(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return null;
  }
}
