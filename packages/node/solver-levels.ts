// Authenticated, short-lived price ladders published by connected solvers.
//
// The wire schema and interpolation come from @zswap-da/solver-core so the
// publisher and this consumer share one acceptance set. Registry identity is
// supplied by the authenticated API boundary, never by the request body.

import { getEnv } from "@effectstream/utils/runtime";
import {
  interpolateQuote,
  pairKey,
  rejectPair,
  type PriceLevels,
} from "@zswap-da/solver-core/ladder-schema";
import {
  createSolverLiquidityEnvelope,
  createSolverLiquiditySnapshot,
  formatLiquidityTimestamp,
  parsePositiveU64String,
  type SolverLiquidityEnvelope,
  type SolverLiquiditySnapshot,
} from "@zswap-da/solver-core/liquidity-contract";

export {
  interpolateQuote,
  isPriceLevelArray as validateLevels,
  isPriceLevels as validatePair,
  MAX_PAIRS_PER_PUSH,
  MAX_RUNGS_PER_PAIR,
  rejectPair,
  type PriceLevel,
  type PriceLevels,
} from "@zswap-da/solver-core/ladder-schema";

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;
const DEFAULT_MAX_SOLVERS = 128;

export interface StoredLevels extends PriceLevels {
  solverId: string;
  version: string;
  updatedAt: number;
}

interface SolverDeclaration {
  version: bigint;
  versionText: string;
  updatedAt: number;
  expiresAt: number;
  pairs: Map<string, StoredLevels>;
}

export interface SolverQuote {
  amountOut: bigint;
  solverId: string;
  version: string;
  updatedAt: number;
}

export type PublishResult =
  | { ok: true; accepted: number; withdrawn: number }
  | {
      ok: false;
      code: "STALE_VERSION";
      reason: string;
      /** Canonical server-side replay watermark used by a restarted publisher. */
      lastVersion: string;
    }
  | { ok: false; code: "DUPLICATE_PAIR" | "REGISTRY_FULL"; reason: string };

export interface SolverLevelsRegistryOptions {
  ttlMs?: number | (() => number);
  maxSolvers?: number;
}

/** A ladder older than this is ignored. Invalid configuration fails closed at
 * the documented default instead of turning NaN into an immortal quote. */
export const solverLevelsTtlSeconds = (): number => {
  const raw = getEnv("SOLVER_LEVELS_TTL_SECONDS") ?? String(DEFAULT_TTL_SECONDS);
  if (!/^[1-9][0-9]*$/.test(raw)) return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= MAX_TTL_SECONDS
    ? parsed
    : DEFAULT_TTL_SECONDS;
};

/** Canonical unsigned 64-bit declaration version. JSON numbers are not
 * accepted by the API because they stop being exact above 2^53-1. */
export function parseLevelsVersion(value: unknown): bigint | null {
  return parsePositiveU64String(value);
}

export class SolverLevelsRegistry {
  readonly #bySolver = new Map<string, SolverDeclaration>();
  readonly #ttlMs: () => number;
  readonly #maxSolvers: number;

  constructor(options: SolverLevelsRegistryOptions = {}) {
    const ttl = options.ttlMs ?? (() => solverLevelsTtlSeconds() * 1000);
    this.#ttlMs = typeof ttl === "function" ? ttl : () => ttl;
    this.#maxSolvers = options.maxSolvers ?? DEFAULT_MAX_SOLVERS;
    if (!Number.isSafeInteger(this.#maxSolvers) || this.#maxSolvers <= 0) {
      throw new Error("maxSolvers must be a positive safe integer");
    }
  }

  /** Resolve and store one immutable expiry at accepted-publication time.
   * Invalid injected TTLs fail closed at the publication timestamp. */
  #publicationExpiresAt(nowMs: number): number {
    // Also proves the update timestamp can be represented by the frozen wire
    // contract before any registry state changes.
    formatLiquidityTimestamp(nowMs);
    const ttlMs = this.#ttlMs();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return nowMs;
    const candidate = nowMs + ttlMs;
    if (!Number.isSafeInteger(candidate)) return nowMs;
    try {
      formatLiquidityTimestamp(candidate);
      return candidate;
    } catch {
      return nowMs;
    }
  }

  /** Clear stale pair declarations eagerly while retaining the last accepted
   * version and immutable freshness tombstone. Keeping the bounded version
   * tombstone prevents an old, replayed publication from becoming valid again
   * merely because its prices expired. */
  #expire(nowMs: number): void {
    for (const declaration of this.#bySolver.values()) {
      if (declaration.pairs.size > 0 && nowMs >= declaration.expiresAt) {
        declaration.pairs.clear();
      }
    }
  }

  /** Replace one authenticated solver's COMPLETE declaration. Omitted pairs
   * are withdrawn atomically; an empty array is an explicit full withdrawal. */
  publish(
    solverId: string,
    pairs: PriceLevels[],
    version: bigint,
    nowMs: number,
  ): PublishResult {
    // Validate observation time before #expire can mutate any prior state.
    formatLiquidityTimestamp(nowMs);
    this.#expire(nowMs);
    const previous = this.#bySolver.get(solverId);
    if (previous && version <= previous.version) {
      return {
        ok: false,
        code: "STALE_VERSION",
        reason: `version must be greater than ${previous.versionText}`,
        lastVersion: previous.versionText,
      };
    }
    if (!previous && this.#bySolver.size >= this.#maxSolvers) {
      return {
        ok: false,
        code: "REGISTRY_FULL",
        reason: `solver registry is capped at ${this.#maxSolvers} identities`,
      };
    }

    const expiresAt = this.#publicationExpiresAt(nowMs);
    const replacement = new Map<string, StoredLevels>();
    for (const pair of pairs) {
      const key = pairKey(pair.tokenIn, pair.tokenOut);
      if (replacement.has(key)) {
        return {
          ok: false,
          code: "DUPLICATE_PAIR",
          reason: `pair ${pair.tokenIn.toLowerCase()}->${pair.tokenOut.toLowerCase()} appears more than once`,
        };
      }
      replacement.set(key, {
        tokenIn: pair.tokenIn.toLowerCase(),
        tokenOut: pair.tokenOut.toLowerCase(),
        levels: pair.levels.map((level) => ({ ...level })),
        solverId,
        version: version.toString(),
        updatedAt: nowMs,
      });
    }

    const withdrawn = previous
      ? [...previous.pairs.keys()].filter((key) => !replacement.has(key)).length
      : 0;
    this.#bySolver.set(solverId, {
      version,
      versionText: version.toString(),
      updatedAt: nowMs,
      expiresAt,
      pairs: replacement,
    });
    return { ok: true, accepted: replacement.size, withdrawn };
  }

  /** Deterministically select the highest live output. A lexical solver-id
   * tie-break makes replicas agree even if arrival order differs. */
  quoteDetails(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    nowMs: number,
  ): SolverQuote | null {
    // Fail before eager expiry can mutate registry state on an invalid clock.
    formatLiquidityTimestamp(nowMs);
    this.#expire(nowMs);
    const key = pairKey(tokenIn, tokenOut);
    let best: SolverQuote | null = null;
    for (const declaration of this.#bySolver.values()) {
      const stored = declaration.pairs.get(key);
      if (!stored) continue;
      const amountOut = interpolateQuote(stored.levels, amountIn);
      if (amountOut === null) continue;
      if (
        best === null ||
        amountOut > best.amountOut ||
        (amountOut === best.amountOut && stored.solverId < best.solverId)
      ) {
        best = {
          amountOut,
          solverId: stored.solverId,
          version: stored.version,
          updatedAt: stored.updatedAt,
        };
      }
    }
    return best;
  }

  /** Backward-compatible amount-only view for internal callers. */
  quote(tokenIn: string, tokenOut: string, amountIn: bigint, nowMs: number): bigint | null {
    return this.quoteDetails(tokenIn, tokenOut, amountIn, nowMs)?.amountOut ?? null;
  }

  /** Every currently live declaration, stable-sorted for deterministic API
   * output. Calling this also eagerly removes stale pair payloads. */
  all(nowMs: number): StoredLevels[] {
    // Fail before eager expiry can mutate registry state on an invalid clock.
    formatLiquidityTimestamp(nowMs);
    this.#expire(nowMs);
    return [...this.#bySolver.values()]
      .flatMap((declaration) => [...declaration.pairs.values()])
      .sort((a, b) =>
        a.solverId.localeCompare(b.solverId) ||
        pairKey(a.tokenIn, a.tokenOut).localeCompare(pairKey(b.tokenIn, b.tokenOut))
      )
      .map((stored) => ({
        ...stored,
        levels: stored.levels.map((level) => ({ ...level })),
      }));
  }

  /** One identity's complete declaration, including explicit-withdrawal and
   * expiry tombstones. Unknown identities return null; expired identities keep
   * their immutable version/times and expose an empty pair set. */
  liquiditySnapshot(solverId: string, nowMs: number): SolverLiquiditySnapshot | null {
    // Fail before eager expiry can mutate registry state on an invalid clock.
    formatLiquidityTimestamp(nowMs);
    this.#expire(nowMs);
    const declaration = this.#bySolver.get(solverId);
    if (!declaration) return null;
    const pairs = [...declaration.pairs.values()].map((stored) => ({
      tokenIn: stored.tokenIn,
      tokenOut: stored.tokenOut,
      levels: stored.levels.map((level) => ({ ...level })),
    }));
    return createSolverLiquiditySnapshot({
      solverId,
      version: declaration.versionText,
      updatedAtMs: declaration.updatedAt,
      expiresAtMs: declaration.expiresAt,
      pairs,
    });
  }

  /** Filtered grouped source envelope for one requested solver identity. */
  liquidityEnvelope(solverId: string, nowMs: number): SolverLiquidityEnvelope {
    const snapshot = this.liquiditySnapshot(solverId, nowMs);
    return createSolverLiquidityEnvelope(nowMs, snapshot ? [snapshot] : []);
  }

  get solverCount(): number {
    return this.#bySolver.size;
  }

  clear(): void {
    this.#bySolver.clear();
  }
}

export const solverLevels = new SolverLevelsRegistry();
