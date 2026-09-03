// Token → reference-asset mapping, shared by the node (which resolves prices
// for quotes and GET /v1/prices) and by packages/price-feed (which decides
// which assets to fetch).
//
// WHY BY NAME. Faucet-minted colours derive from the deployed contract
// address, so every clean redeploy of a devnet or of preprod produces new
// colours for WBTC/WETH/TESTTOKEN*. A colour-keyed map would be stale the
// moment the stack is rebuilt, and a wrong price is worse than none. Names
// survive redeploys because the faucet and the frontend mint under fixed
// names, so the default map is keyed by NAME. `known_tokens.asset_id` and the
// PRICE_FEED_MAP env var exist for the cases a name cannot express.
//
// Resolution order for one token (D6 of the master plan):
//   1. known_tokens.asset_id      — the operator wrote it into the DB
//   2. PRICE_FEED_MAP by COLOUR   — most specific env key
//   3. PRICE_FEED_MAP by NAME
//   4. DEFAULT_NAME_ASSET_MAP     — this file
// Decimals are independent: PRICE_FEED_MAP's optional `:decimals` overrides
// known_tokens.decimals whenever the env names the token at all, so an
// operator can correct a badly registered token without a DB write.

/** One entry of a name/colour → asset map. */
export interface PriceMapEntry {
  assetId: string;
  /** Overrides known_tokens.decimals when present. */
  decimals?: number;
}

/**
 * The asset ids seeded in 000-init.sql, which are also the assets one
 * price-feed cycle requests, in order.
 *
 * Every one of them is a CoinGecko id and every one is fetched. USD is the
 * numeraire and nothing is pinned to it: `usdm-2` is Moneta's Cardano USDM
 * (the token the VIA Labs bridge carries to Midnight), which trades AROUND a
 * dollar but is not a dollar, so it is observed like bitcoin (Q-10).
 */
export const SEEDED_ASSET_IDS: readonly string[] = [
  "bitcoin",
  "ethereum",
  "usd-coin",
  "midnight-3",
  "usdm-2",
];

/**
 * Default token NAME → asset. Names are compared upper-cased.
 *
 * The wrapped/synthetic spellings are here because the faucet and the bridge
 * both mint under them: on Midnight there is no native BTC or ETH, so every
 * BTC-priced token is a wrapper of some kind and they all track the same
 * reference. NIGHT is coingecko.com/en/coins/midnight-3 and USDM is
 * coingecko.com/en/coins/usdm-2 — Moneta's Cardano USDM, the asset the VIA
 * Labs bridge carries to Midnight (both confirmed 2026-09-02).
 */
export const DEFAULT_NAME_ASSET_MAP: ReadonlyMap<string, PriceMapEntry> = new Map<
  string,
  PriceMapEntry
>([
  ["WBTC", { assetId: "bitcoin" }],
  ["WSBTC", { assetId: "bitcoin" }],
  ["BTC", { assetId: "bitcoin" }],
  ["WETH", { assetId: "ethereum" }],
  ["WSETH", { assetId: "ethereum" }],
  ["ETH", { assetId: "ethereum" }],
  ["USDC", { assetId: "usd-coin" }],
  ["USDM", { assetId: "usdm-2" }],
  ["NIGHT", { assetId: "midnight-3" }],
]);

const COLOR_RE = /^[0-9a-fA-F]{64}$/;

/** Map key for a token name or colour: colours lower-cased, names upper-cased. */
export function priceMapKey(nameOrColor: string): string {
  const trimmed = nameOrColor.trim();
  return COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

/**
 * Parse `PRICE_FEED_MAP` — `NAME_OR_COLOR=<asset_id>[:decimals],…`, e.g.
 * `WBTC=bitcoin,1111…1111=usd-coin:6`.
 *
 * Throws on a malformed entry rather than skipping it: a typo that silently
 * priced nothing would be indistinguishable from "this token has no asset",
 * which is exactly the state the operator set the variable to escape. Call it
 * once at startup, not per request.
 */
export function parsePriceMapEnv(raw: string | undefined | null): Map<string, PriceMapEntry> {
  const out = new Map<string, PriceMapEntry>();
  if (raw === undefined || raw === null || raw.trim() === "") return out;
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(`PRICE_FEED_MAP entry "${entry}" is not NAME_OR_COLOR=asset_id[:decimals]`);
    }
    const key = priceMapKey(entry.slice(0, eq));
    const value = entry.slice(eq + 1).trim();
    const colon = value.indexOf(":");
    const assetId = (colon === -1 ? value : value.slice(0, colon)).trim();
    if (assetId === "") {
      throw new Error(`PRICE_FEED_MAP entry "${entry}" has an empty asset id`);
    }
    let decimals: number | undefined;
    if (colon !== -1) {
      const rawDecimals = value.slice(colon + 1).trim();
      if (!/^[0-9]{1,2}$/.test(rawDecimals)) {
        throw new Error(`PRICE_FEED_MAP entry "${entry}" has a non-integer decimals`);
      }
      decimals = Number(rawDecimals);
      if (decimals > 38) {
        throw new Error(`PRICE_FEED_MAP entry "${entry}" has decimals > 38`);
      }
    }
    out.set(key, decimals === undefined ? { assetId } : { assetId, decimals });
  }
  return out;
}

/** The token shape this module needs — a subset of a `known_tokens` row. */
export interface MappableToken {
  name: string;
  token_color?: string | null;
  asset_id?: string | null;
  decimals?: number | null;
}

/**
 * Resolve one token to its reference asset and the decimals to price it with.
 * Returns null when nothing maps it (the token then falls back to the
 * deterministic demo price and counts as UNPRICED for the sponsorship gate).
 */
export function resolveAssetId(
  token: MappableToken,
  overrides: ReadonlyMap<string, PriceMapEntry> = new Map(),
): { assetId: string; decimals: number } | null {
  const byColor =
    token.token_color === undefined || token.token_color === null
      ? undefined
      : overrides.get(priceMapKey(token.token_color));
  const byName = overrides.get(priceMapKey(token.name));
  const override = byColor ?? byName;
  const fallbackMap = DEFAULT_NAME_ASSET_MAP.get(priceMapKey(token.name));

  const assetId = token.asset_id ?? override?.assetId ?? fallbackMap?.assetId;
  if (assetId === undefined || assetId === null || assetId === "") return null;

  const decimals = override?.decimals ?? token.decimals ?? 0;
  return { assetId, decimals };
}

interface Decimal {
  sign: string;
  digits: string;
  /** value = digits × 10^exponent */
  exponent: number;
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function parseDecimal(input: string | number): Decimal {
  const raw = typeof input === "number" ? String(input) : input.trim();
  const m = DECIMAL_RE.exec(raw);
  if (m === null || ((m[2] ?? "") === "" && (m[3] ?? "") === "")) {
    throw new Error(`not a decimal number: ${JSON.stringify(input)}`);
  }
  const frac = m[3] ?? "";
  return {
    sign: m[1] === "-" ? "-" : "",
    digits: `${m[2] ?? ""}${frac}`,
    exponent: (m[4] === undefined ? 0 : Number(m[4])) - frac.length,
  };
}

function renderDecimal({ sign, digits, exponent }: Decimal): string {
  const significant = digits.replace(/^0+/, "");
  if (significant === "") return "0";
  let out: string;
  if (exponent >= 0) {
    out = significant + "0".repeat(exponent);
  } else {
    const shift = -exponent;
    out =
      significant.length > shift
        ? `${significant.slice(0, significant.length - shift)}.${significant.slice(significant.length - shift)}`
        : `0.${"0".repeat(shift - significant.length)}${significant}`;
  }
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}${out}`;
}

/**
 * Normalise a decimal number or string to its exact plain decimal spelling —
 * no exponent notation, no trailing zeros, no float noise. The price feed uses
 * it on the number JSON.parse hands back so what reaches the NUMERIC column is
 * the value CoinGecko printed, not `1e-7`.
 */
export function toDecimalString(value: string | number): string {
  return renderDecimal(parseDecimal(value));
}

/**
 * Per-base-unit price of a token from its asset's per-coin price:
 * `assetPriceUsd / 10^decimals`, EXACTLY.
 *
 * Decimal-string arithmetic, not floating point and not `toFixed`: the result
 * goes straight into a NUMERIC column and into the API, so `77387 / 10^8` must
 * be `0.00077387` and not `0.0007738699999999999`. `toFixed` would also be
 * wrong in the other direction — it truncates an 18-decimals token's price to
 * nothing.
 */
export function tokenPriceFromAsset(
  assetPriceUsd: string | number,
  decimals: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error(`decimals must be an integer in [0, 38], got ${decimals}`);
  }
  const parsed = parseDecimal(assetPriceUsd);
  return renderDecimal({ ...parsed, exponent: parsed.exponent - decimals });
}
