// The canonical price-ladder wire schema, shared by the solver that publishes
// ladders and the node that quotes from them.
//
// This lives in one place because it already diverged once: the solver accepted
// an empty ladder while the node rejected it, and neither enforced that outputs
// increase. Two copies of a protocol rule are two acceptance sets.
//
// A ladder is a nondecreasing (input, output) staircase for ONE directed token
// pair, read from the SOLVER's side: it receives `tokenIn` and pays `tokenOut`.

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
  | "output-decreasing";

/**
 * Validate a ladder's rungs, returning null when they are acceptable.
 *
 * The rules preserve the exact staircase encoding:
 *   - non-empty, so a published pair always quotes something;
 *   - positive amounts;
 *   - strictly ascending input, matching the relay's admission grammar;
 *   - nondecreasing output, so a larger budget never quotes less. Equal output
 *     points delimit whole-offer plateaus and are required. A jump is encoded
 *     between adjacent input base units, so concavity is neither required nor
 *     meaningful for the canonical staircase.
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
    if (BigInt(prev.output) > BigInt(r.output)) return "output-decreasing";
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
