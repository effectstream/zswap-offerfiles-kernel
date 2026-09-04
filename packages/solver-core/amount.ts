/**
 * Whole coins ⇄ base units (00024 FR-004).
 *
 * WHY THIS EXISTS. Amounts on chain and on the wire are integer BASE UNITS —
 * `mint_shielded`/`mint_unshielded` take explicit recipients and `Uint<64>` amounts; `/v1/quote` takes and
 * returns integer strings, and every ledger amount is a bigint. What a human
 * says is a WHOLE COIN: "1.5 WBTC", not "1500000". The bridge between the two
 * is `known_tokens.decimals`, which since 00024 is `6` for every token this
 * stack mints or registers.
 *
 * Before this module every caller hand-rolled that bridge — `1000n`, `× 10n **
 * 6n`, an integer division that silently truncated — and the faucet paths
 * disagreed with the registry about what a "1000" meant. One helper, used by
 * the faucet/mint entry points, keeps them honest.
 *
 * THE RULES.
 *   - String maths only. `Number` cannot hold 2^64 and cannot hold `0.1`, so a
 *     float round-trip would post a different offer than the one asked for.
 *   - Exact or nothing. A coin amount finer than the token's `decimals` is
 *     REFUSED, never rounded (00024 Q9): the amount is what settles on chain.
 *   - No negatives, no exponent notation, no thousands separators. These are
 *     amounts, and the callers are scripts — a throw with the offending value
 *     in it is the useful answer.
 *
 * `decimals` is a parameter everywhere; `DEFAULT_TOKEN_DECIMALS` is the
 * registry's default, not an assumption baked into the arithmetic, so a future
 * token with 8 or 18 decimals needs no change here.
 *
 * This file deliberately has NO imports: it is bundled into the browser docs
 * playground (`docs/src/wallet/mintable.ts`) as well as run by the deploy
 * scripts under bun.
 */

/**
 * Base units per coin for every token the offer-files stack mints or registers
 * (00024 FR-001). Mirrors `known_tokens.decimals DEFAULT 6` in
 * `packages/database/migrations/000-init.sql`.
 */
export const DEFAULT_TOKEN_DECIMALS = 6;

/** Digits, optionally a `.` and more digits. No sign, no exponent, no spaces. */
const COIN_AMOUNT_RE = /^(\d+)(?:\.(\d*))?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error(
      `decimals must be an integer in [0, 38], got ${JSON.stringify(decimals)}`,
    );
  }
}

/**
 * Whole coins → base units, exactly.
 *
 * ```
 * coinsToBaseUnits("1.5", 6)  === 1_500_000n
 * coinsToBaseUnits(1000n, 6)  === 1_000_000_000n
 * coinsToBaseUnits("1.0000005", 6)  // throws — 7 fraction digits
 * ```
 *
 * A `number` is accepted for call sites that already have one, but it is
 * converted through its decimal spelling, so anything a `number` cannot spell
 * exactly (`1e21`, `Infinity`, `NaN`) is refused rather than guessed at.
 * Trailing zeros in the fraction do not count as precision: `"1.5000000"` is
 * exactly representable at 6 decimals and is accepted.
 */
export function coinsToBaseUnits(
  coins: string | number | bigint,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): bigint {
  assertDecimals(decimals);
  const scale = 10n ** BigInt(decimals);

  if (typeof coins === "bigint") {
    if (coins < 0n) throw new Error(`coin amount must not be negative, got ${coins}`);
    return coins * scale;
  }

  const raw = (typeof coins === "number" ? String(coins) : coins).trim();
  const match = COIN_AMOUNT_RE.exec(raw);
  if (match === null) {
    throw new Error(
      `not a whole-coin amount: ${JSON.stringify(coins)} ` +
        `(expected digits with at most one ".", no sign and no exponent)`,
    );
  }

  const whole = match[1] ?? "0";
  // Trailing zeros carry no precision: "1.500000000" is still 1.5.
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new Error(
      `${JSON.stringify(raw)} has ${fraction.length} decimal places, but the ` +
        `token has only ${decimals} — refusing to round an amount that settles on chain`,
    );
  }

  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/**
 * Base units → whole coins, exactly, with no trailing zeros.
 *
 * ```
 * baseUnitsToCoins(1_500_000n, 6) === "1.5"
 * baseUnitsToCoins(1_000_000n, 6) === "1"
 * baseUnitsToCoins(1n, 6)         === "0.000001"
 * ```
 *
 * The exact inverse of {@link coinsToBaseUnits} for every value it produces —
 * no grouping, no locale, no rounding. Grouping belongs to whoever renders it.
 */
export function baseUnitsToCoins(
  value: bigint,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  assertDecimals(decimals);
  if (value < 0n) throw new Error(`base-unit amount must not be negative, got ${value}`);
  if (decimals === 0) return value.toString();

  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
