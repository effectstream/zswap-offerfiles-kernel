// The solver's posted prices, indexed by directed pair.
//
// The wire schema and interpolation live in @zswap-da/solver-core/ladder-schema
// so the publisher and the node that quotes from it cannot drift apart.

import {
  interpolateQuote,
  pairKey,
  rejectPair,
  type PriceLevels,
} from "@zswap-da/solver-core/ladder-schema";

export {
  interpolateQuote,
  isPriceLevelArray,
  isPriceLevels,
  MAX_PAIRS_PER_PUSH,
  pairKey,
  rejectLevels,
  rejectPair,
  type PriceLevel,
  type PriceLevels,
} from "@zswap-da/solver-core/ladder-schema";

/** Every posted ladder, indexed by directed pair. */
export class LadderBook {
  readonly #byPair = new Map<string, PriceLevels>();

  static fromPairs(pairs: PriceLevels[]): LadderBook {
    const book = new LadderBook();
    for (const pair of pairs) book.set(pair);
    return book;
  }

  set(pair: PriceLevels): void {
    const rejection = rejectPair(pair);
    if (rejection !== null) {
      throw new Error(
        `invalid ladder for ${pair?.tokenIn ?? "?"}→${pair?.tokenOut ?? "?"}: ${rejection}`,
      );
    }
    this.#byPair.set(pairKey(pair.tokenIn, pair.tokenOut), pair);
  }

  get(tokenIn: string, tokenOut: string): PriceLevels | undefined {
    return this.#byPair.get(pairKey(tokenIn, tokenOut));
  }

  /** Most the solver will pay in `tokenOut` to receive `amountIn` of `tokenIn`,
   *  or null if the pair is unpriced or the size is outside the ladder. */
  maxPayout(tokenIn: string, tokenOut: string, amountIn: bigint): bigint | null {
    const pair = this.get(tokenIn, tokenOut);
    if (!pair) return null;
    return interpolateQuote(pair.levels, amountIn);
  }

  pairs(): PriceLevels[] {
    return [...this.#byPair.values()];
  }

  get size(): number {
    return this.#byPair.size;
  }
}
