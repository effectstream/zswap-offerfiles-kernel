// The canonical price-ladder wire schema, shared by the solver that publishes
// ladders and the node that quotes from them.
//
// This lives in one place because it already diverged once: the solver accepted
// an empty ladder while the node rejected it, and neither enforced that outputs
// increase. Two copies of a protocol rule are two acceptance sets.
//
// A ladder is a cumulative (input, output) curve for ONE directed token pair,
// read from the SOLVER's side: it receives `tokenIn` and pays `tokenOut`.

export interface PriceLevel {
  input: string;
  output: string;
}

export interface PriceLevels {
  tokenIn: string;
  tokenOut: string;
  levels: PriceLevel[];
}

export const MAX_PAIRS_PER_PUSH = 64;
export const MAX_RUNGS_PER_PAIR = 64;

/** Key for a directed pair. Never build this string ad hoc — the separator is
 *  what keeps `a|b` from colliding with a token containing a separator. */
export const pairKey = (tokenIn: string, tokenOut: string): string =>
  `${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;

const MAX_U256 = (1n << 256n) - 1n;

const isAmountString = (v: unknown): v is string =>
  typeof v === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX_U256;

const isTokenColor = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/** Why a ladder was refused, for an error a publisher can act on. */
export type LadderRejection =
  | "empty"
  | "too-many-rungs"
  | "malformed-rung"
  | "non-positive"
  | "input-not-ascending"
  | "output-not-ascending"
  | "not-concave";

/**
 * Validate a ladder's rungs, returning null when they are acceptable.
 *
 * The rules are what make interpolation trustworthy:
 *   - non-empty, so a published pair always quotes something;
 *   - positive amounts;
 *   - strictly ascending input AND output, so more input never buys less and
 *     affordability is a prefix (which is what lets a publisher clip a ladder
 *     to its stock by truncation);
 *   - concave, i.e. a non-increasing marginal rate. Interpolating between two
 *     rungs is only CONSERVATIVE if the curve they sample is concave; on a
 *     convex ladder the chord sits above the curve and the quote would promise
 *     more than the solver can honour.
 */
export function rejectLevels(value: unknown): LadderRejection | null {
  if (!Array.isArray(value) || value.length === 0) return "empty";
  if (value.length > MAX_RUNGS_PER_PAIR) return "too-many-rungs";

  for (let i = 0; i < value.length; i++) {
    const rung = value[i];
    if (typeof rung !== "object" || rung === null) return "malformed-rung";
    const r = rung as Record<string, unknown>;
    if (!isAmountString(r.input) || !isAmountString(r.output)) return "malformed-rung";
    if (BigInt(r.input) <= 0n || BigInt(r.output) <= 0n) return "non-positive";
    if (i === 0) continue;

    const prev = value[i - 1] as PriceLevel;
    if (BigInt(prev.input) >= BigInt(r.input)) return "input-not-ascending";
    if (BigInt(prev.output) >= BigInt(r.output)) return "output-not-ascending";
    if (i === 1) continue;

    // Concavity by cross-multiplication, so no division and no floats:
    //   (out[i]-out[i-1]) / (in[i]-in[i-1])  <=  (out[i-1]-out[i-2]) / (in[i-1]-in[i-2])
    const before = value[i - 2] as PriceLevel;
    const dOutPrev = BigInt(prev.output) - BigInt(before.output);
    const dInPrev = BigInt(prev.input) - BigInt(before.input);
    const dOut = BigInt(r.output) - BigInt(prev.output);
    const dIn = BigInt(r.input) - BigInt(prev.input);
    if (dOut * dInPrev > dOutPrev * dIn) return "not-concave";
  }
  return null;
}

export const isPriceLevelArray = (value: unknown): value is PriceLevel[] =>
  rejectLevels(value) === null;

export function rejectPair(value: unknown): LadderRejection | "bad-tokens" | null {
  if (typeof value !== "object" || value === null) return "bad-tokens";
  const v = value as Record<string, unknown>;
  if (!isTokenColor(v.tokenIn) || !isTokenColor(v.tokenOut)) return "bad-tokens";
  if ((v.tokenIn as string).toLowerCase() === (v.tokenOut as string).toLowerCase()) {
    return "bad-tokens";
  }
  return rejectLevels(v.levels);
}

export const isPriceLevels = (value: unknown): value is PriceLevels =>
  rejectPair(value) === null;

/**
 * Conservative output for `amountIn`, by linear interpolation between the two
 * bracketing rungs. Floored.
 *
 * Returns null when `amountIn` falls outside the ladder — below the smallest
 * trade the solver accepts, or above its size cap. Refusing beats
 * extrapolating: outside the published range there is no committed price.
 */
export function interpolateQuote(levels: PriceLevel[], amountIn: bigint): bigint | null {
  if (levels.length === 0) return null;
  if (amountIn < BigInt(levels[0].input)) return null;
  if (amountIn > BigInt(levels[levels.length - 1].input)) return null;
  for (let i = 0; i < levels.length - 1; i++) {
    const inLo = BigInt(levels[i].input);
    const inHi = BigInt(levels[i + 1].input);
    if (amountIn > inHi) continue;
    // Defensive: a validated ladder is strictly ascending, but never divide by
    // zero on a degenerate rung pair — fall back to the lower rung.
    if (inHi <= inLo) return BigInt(levels[i].output);
    const outLo = BigInt(levels[i].output);
    const outHi = BigInt(levels[i + 1].output);
    return outLo + ((outHi - outLo) * (amountIn - inLo)) / (inHi - inLo);
  }
  // Only reachable when amountIn equals a single rung's input.
  return BigInt(levels[levels.length - 1].output);
}
