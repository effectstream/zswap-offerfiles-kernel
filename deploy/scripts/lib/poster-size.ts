// How big should THIS offer be? (00027 FR-002)
//
// The poster used to mint one coin of exactly `GIVE_AMOUNT` every tick, so the
// book filled up with N identical offers. A taker holding one faucet mint of
// WETH (1 000 coins) could afford some of them and not others, and never had a
// choice of sizes. `GIVE_MIN`/`GIVE_MAX` replace the single number with a
// range, and every FRESH mint draws its own size from it.
//
// WHY LOG-UNIFORM AND NOT UNIFORM. Over 0.1 … 10 a uniform draw puts ~90 % of
// the mass above 1 coin: the book would be almost entirely large offers and the
// small ones the range exists to produce would be rare. A log-uniform draw is
// uniform over the ORDERS OF MAGNITUDE — 0.1–1 is exactly as likely as 1–10 —
// which is what "mostly small, with the occasional large one" means, and it
// makes the median the geometric mean (1 coin for 0.1 … 10) instead of 5.05.
//
// WHY THE ARITHMETIC IS IN BASE UNITS. A coin amount at 6 decimals IS an
// integer number of base units, so "round the drawn coin amount to 6 decimals"
// and "round the drawn base-unit amount to an integer" are the same operation —
// done once, on the value that settles on chain, with no decimal-string
// round-trip in between. The ratio `max/min` is identical in either unit, so
// the distribution is unchanged by working in the smaller one.
//
// THE DOUBLE-PRECISION LIMIT. `Math.log`/`Math.exp` are the only sane way to
// draw log-uniformly and they are `number` maths, so the draw is exact only
// while the bounds fit in a double's integer range. `MAX_DRAWABLE_BASE_UNITS`
// pins that limit and `parsePosterConfig` refuses a `GIVE_MAX` above it, rather
// than silently posting an amount that differs from the one drawn. At 6
// decimals the ceiling is ~9.007 billion coins — nine orders of magnitude above
// anything this faucet mints.

/** A uniform draw in `[0, 1)`. `Math.random` satisfies it; so does `makeRng`. */
export type Rng = () => number;

/** The give-size range, in BASE UNITS, as `parsePosterConfig` validated it:
 *  `1 <= minBase <= maxBase <= MAX_DRAWABLE_BASE_UNITS`. */
export interface GiveRange {
  readonly minBase: bigint;
  readonly maxBase: bigint;
}

/**
 * The largest bound the log-uniform draw can honour exactly (`2^53 - 1`).
 *
 * Above it `Math.exp` lands between representable doubles and `Math.round`
 * cannot get back to the integer that was drawn, so the coin minted would not
 * be the coin the distribution asked for. Refusing is the only honest answer;
 * an operator who genuinely wants amounts that large wants a fixed
 * `GIVE_AMOUNT`, which is bigint all the way down.
 */
export const MAX_DRAWABLE_BASE_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** xmur3 — a string to a well-mixed 32-bit seed. Avalanches, so `"1"` and
 *  `"2"` start `mulberry32` in unrelated places rather than adjacent ones. */
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — 32 bits of state, one multiply-shift round, period 2^32.
 *  Chosen because the property that matters here is REPRODUCIBILITY, not
 *  cryptographic strength: a seeded run must draw the same sizes on any host,
 *  in any bun version, for ever. A generator small enough to read is the one
 *  that keeps that promise. Unseeded runs use `crypto.getRandomValues`. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `GIVE_SIZE_SEED` set -> a deterministic stream; unset -> the platform CSPRNG.
 *
 * FR-007/SC-001: a test, a reproduction and an operator debugging "why did it
 * post 7 WBTC" all need the same sequence twice. Nothing here is a secret and
 * nothing depends on the numbers being unpredictable — the sizes are public the
 * moment the offer is posted.
 */
export function makeRng(seed?: string | undefined): Rng {
  if (seed === undefined) {
    const buf = new Uint32Array(1);
    return () => {
      crypto.getRandomValues(buf);
      return (buf[0] ?? 0) / 4294967296;
    };
  }
  return mulberry32(xmur3(seed));
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

function assertRange(range: GiveRange): void {
  const { minBase, maxBase } = range;
  if (minBase < 1n) throw new Error(`give range minBase must be >= 1, got ${minBase}`);
  if (maxBase < minBase) throw new Error(`give range maxBase ${maxBase} is below minBase ${minBase}`);
  if (maxBase > MAX_DRAWABLE_BASE_UNITS) {
    throw new Error(
      `give range maxBase ${maxBase} exceeds ${MAX_DRAWABLE_BASE_UNITS}, above which the ` +
        `log-uniform draw cannot round back to the exact base-unit amount`,
    );
  }
}

/**
 * One log-uniform draw in `[minBase, maxBase]`, in base units.
 *
 * `x = min · (max/min)^u` for `u ~ U(0,1)`, rounded to the nearest base unit
 * and clamped — the clamp is not decoration: `Math.exp(Math.log(min))` can land
 * a half-ulp below `min`, and `Math.round` at the top end can land a unit above
 * `max`, and AC-1 says both ends are INCLUSIVE.
 *
 * `min === max` degenerates to that constant (spec edge case 3), which is what
 * makes `GIVE_MIN=GIVE_MAX=1` a legal spelling of today's fixed size.
 */
export function drawGiveAmount(range: GiveRange, rng: Rng): bigint {
  assertRange(range);
  const { minBase, maxBase } = range;
  if (minBase === maxBase) return minBase;

  const u = rng();
  if (!Number.isFinite(u)) throw new Error(`rng() returned ${String(u)}; expected a number in [0, 1)`);
  const clamped = u < 0 ? 0 : u > 1 ? 1 : u;

  const lnMin = Math.log(Number(minBase));
  const lnMax = Math.log(Number(maxBase));
  const drawn = Math.round(Math.exp(lnMin + clamped * (lnMax - lnMin)));
  const value = BigInt(drawn);
  return value < minBase ? minBase : value > maxBase ? maxBase : value;
}

// ---------------------------------------------------------------------------
// The sizer the service holds
// ---------------------------------------------------------------------------

/** A range plus its RNG, remembering the last draw so `/health` and the
 *  `DRY_RUN` report can show what the poster actually asked the faucet for
 *  (FR-003) without the tick having to thread it back up. */
export interface GiveSizer {
  readonly range: GiveRange;
  /** The most recent draw, or `null` before the first one. */
  last(): bigint | null;
  draw(): bigint;
}

export function makeGiveSizer(range: GiveRange, seed?: string | undefined): GiveSizer {
  assertRange(range);
  const rng = makeRng(seed);
  let lastDrawn: bigint | null = null;
  return {
    range,
    last: () => lastDrawn,
    draw: () => {
      lastDrawn = drawGiveAmount(range, rng);
      return lastDrawn;
    },
  };
}
