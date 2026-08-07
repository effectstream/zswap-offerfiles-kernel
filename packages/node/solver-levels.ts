// Price ladders published by connected solvers.
//
// The wire schema and interpolation come from @zswap-da/solver-core so the
// publisher and this consumer share one acceptance set. They previously had
// separate copies and had already diverged — the solver accepted an empty
// ladder that this side rejected.
//
// Held in memory, not in the database, for three reasons: the API router and
// the state machine run in one process; a ladder is a momentary quote its
// solver re-pushes every few seconds; and a stale ladder must disappear on its
// own rather than outlive the solver that posted it.

import { getEnv } from "@effectstream/utils/runtime";
import {
  interpolateQuote,
  pairKey,
  rejectPair,
  type PriceLevels,
} from "@zswap-da/solver-core/ladder-schema";

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

interface StoredLevels extends PriceLevels {
  solverId: string;
  updatedAt: number;
}

/** A ladder older than this is ignored: a solver that has stopped pushing has
 *  stopped standing behind its prices. */
export const solverLevelsTtlSeconds = (): number =>
  parseInt(getEnv("SOLVER_LEVELS_TTL_SECONDS") ?? "60");

export class SolverLevelsRegistry {
  readonly #byPair = new Map<string, StoredLevels>();

  /** Replace this solver's ladders for the pairs it names. Pairs it stops
   *  publishing age out via the TTL rather than being deleted here — a push is
   *  an update, not a full declaration of everything the solver trades.
   *
   *  TODO(solver-auth): keyed by pair alone, so the last publisher wins and any
   *  caller can replace another's prices. Re-key to (solverId, pair) and select
   *  the best live quote once publications are authenticated — see F-01. */
  publish(solverId: string, pairs: PriceLevels[], nowMs: number): void {
    for (const pair of pairs) {
      this.#byPair.set(pairKey(pair.tokenIn, pair.tokenOut), {
        tokenIn: pair.tokenIn.toLowerCase(),
        tokenOut: pair.tokenOut.toLowerCase(),
        levels: pair.levels,
        solverId,
        updatedAt: nowMs,
      });
    }
  }

  /** The freshest ladder for a directed pair, or undefined if none is fresh. */
  get(tokenIn: string, tokenOut: string, nowMs: number): StoredLevels | undefined {
    const stored = this.#byPair.get(pairKey(tokenIn, tokenOut));
    if (!stored) return undefined;
    if (nowMs - stored.updatedAt > solverLevelsTtlSeconds() * 1000) return undefined;
    return stored;
  }

  /** Best output any fresh ladder offers for this size, or null. */
  quote(tokenIn: string, tokenOut: string, amountIn: bigint, nowMs: number): bigint | null {
    const stored = this.get(tokenIn, tokenOut, nowMs);
    if (!stored) return null;
    return interpolateQuote(stored.levels, amountIn);
  }

  /** Every fresh ladder, for introspection. Stale entries are dropped as they
   *  are found, so a pair that stops being published cannot accumulate. */
  all(nowMs: number): StoredLevels[] {
    const out: StoredLevels[] = [];
    for (const [key, stored] of this.#byPair) {
      if (nowMs - stored.updatedAt <= solverLevelsTtlSeconds() * 1000) out.push(stored);
      else this.#byPair.delete(key);
    }
    return out;
  }

  clear(): void {
    this.#byPair.clear();
  }
}

export const solverLevels = new SolverLevelsRegistry();
