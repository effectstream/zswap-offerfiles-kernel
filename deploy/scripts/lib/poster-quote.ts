// Sizing the want leg from the kernel's own quote (spec FR-005, US1 scenario 7).
//
// The poster does not invent a price. Every tick it asks the kernel what the
// offer should want so that the batcher will sponsor the Celestia fee, and posts
// exactly that. The sponsorship rule lives in `packages/offer-guard/sponsorship.ts`
// (`want_usd ≤ give_usd × (1 − sponsor_discount) + 1e-9`) and the kernel's
// `suggested_to_amount` is computed in exact bigint arithmetic to land ON that
// threshold — which is why the poster uses the server's number rather than
// multiplying a float rate itself and hoping it rounds the right way.
//
// Verified against the kernel at f92c7ca (`packages/node/api.ts` `GET /v1/quote`
// at :522-616, `packages/node/market-mock.ts` `quoteWithPrices`, `API.md` under
// "Market data"):
//
//   Query: from_token, to_token  64 lowercase hex, no 0x, MUST be distinct
//          from_amount           canonical decimal base units, > 0, ≤ u256
//          to_amount             optional, same grammar, 0 allowed
//          (anything malformed → 400 VALIDATION; amounts are never sanitised)
//
//   Response: from_token, to_token, from_amount     strings
//             market_rate                            number   (to per 1 from)
//             suggested_to_amount, to_amount         STRINGS  (base units)
//             implied_rate, discount                 number|null
//             sponsored                              boolean
//             from_usd                               number
//             to_usd                                 number|null
//             source                                 "token-prices"|"demo-fallback"
//             sponsor_discount                       number   (fraction, bps/10000)
//             from_source, to_source                 "feed"|"seed"|"fixed"|
//                                                    "manual"|"fallback"|"demo-fallback"
//             prices_updated_at                      string|null (null when either
//                                                    leg is a demo fallback)
//
// Note that `to_amount` echoes the forced amount when one is sent, and equals
// `suggested_to_amount` otherwise, and that `sponsored` is decided against
// whichever of the two applies. API.md's field table describes
// `suggested_to_amount` as "from_amount × market_rate", which understates it: the
// code multiplies by `(10000 − SPONSOR_DISCOUNT_BPS)/10000` as well, so the
// suggestion is already the discounted, sponsorable amount (its own example
// confirms this: 1000000 × 1.46235… × 0.975 = 1425796).
//
// Pure: the only I/O is the caller-supplied `api.get`, so every path here is
// unit-testable with a fake.

/** The `KernelApi.get` shape (`deploy/scripts/lib/kernel-api.ts`), narrowed to
 *  what this module needs so a fake is two lines in a test. */
export interface QuoteApi {
  get<T>(path: string): Promise<{ status: number; body: T }>;
}

/** `GET /v1/quote`'s response, exactly as the kernel spells it. */
export interface QuoteResponse {
  from_token: string;
  to_token: string;
  from_amount: string;
  market_rate: number;
  suggested_to_amount: string;
  to_amount: string;
  implied_rate: number | null;
  discount: number | null;
  sponsored: boolean;
  from_usd: number;
  to_usd: number | null;
  source: string;
  sponsor_discount: number;
  from_source: string;
  to_source: string;
  prices_updated_at: string | null;
}

export interface SizeWantOptions {
  /** Give-leg colour, 64 hex (with or without `0x`). */
  giveColour: string;
  /** Want-leg colour, 64 hex, distinct from the give colour. */
  wantColour: string;
  /** The whole coin's value in base units — the offer gives the coin entire. */
  giveValue: bigint;
  /** `WANT_AMOUNT`, when the operator forces a fixed want amount. The quote is
   *  then asked with `to_amount` so the poster still learns the verdict. */
  forcedWantAmount?: bigint;
}

export interface SizedWant {
  /** What to put on the want leg. */
  wantAmount: bigint;
  /** The kernel's verdict for `wantAmount`. Always `true` on the unforced path
   *  (the request would have thrown otherwise); informational when forced. */
  sponsored: boolean;
  /** True when `wantAmount` came from `forcedWantAmount`, not from the quote. */
  forced: boolean;
  /** What the kernel would have suggested, forced or not — worth logging. */
  suggestedWantAmount: bigint;
  marketRate: number;
  sponsorDiscount: number;
  fromSource: string;
  toSource: string;
  /** `null` whenever either leg is a demo fallback. */
  pricesUpdatedAt: string | null;
  /** Non-fatal things the caller should log: demo/fallback prices, a forced
   *  amount the kernel would not sponsor, an echo that does not match. */
  warnings: string[];
  /** The untouched response, for the journal's quote snapshot. */
  raw: QuoteResponse;
}

export type QuoteErrorCode =
  /** Bad arguments — caught before any request is made. */
  | "INVALID_ARGUMENT"
  /** The kernel answered with a non-200. `status`/`body` carry its words. */
  | "HTTP"
  /** 200, but the body is not a quote (wrong node, a proxy, a schema change). */
  | "MALFORMED";

export class QuoteError extends Error {
  readonly code: QuoteErrorCode;
  readonly status?: number;
  readonly body?: unknown;
  readonly path?: string;

  constructor(
    code: QuoteErrorCode,
    message: string,
    opts?: { status?: number; body?: unknown; path?: string },
  ) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.body !== undefined) this.body = opts.body;
    if (opts?.path !== undefined) this.path = opts.path;
  }
}

/** The quote says this offer would NOT be sponsored, and no fixed `WANT_AMOUNT`
 *  was forced. Posting it anyway would either be refused (`422 NOT_SPONSORED`
 *  under `enforce`) or leave the batcher paying for a bad trade, so the tick
 *  fails here with every number needed to explain why (US1 scenario 7).
 *
 *  On a stock kernel this is unreachable on the unforced path — the suggested
 *  amount lands exactly on the threshold — so seeing it means the node's pricing
 *  changed under us, which is worth failing loudly for. */
export class NotSponsoredError extends Error {
  readonly giveColour: string;
  readonly wantColour: string;
  readonly giveValue: bigint;
  readonly wantAmount: bigint;
  readonly marketRate: number;
  readonly sponsorDiscount: number;
  readonly impliedDiscount: number | null;
  readonly giveUsd: number;
  readonly wantUsd: number | null;
  readonly fromSource: string;
  readonly toSource: string;
  readonly raw: QuoteResponse;

  constructor(fields: {
    giveColour: string;
    wantColour: string;
    giveValue: bigint;
    wantAmount: bigint;
    raw: QuoteResponse;
  }) {
    const { raw } = fields;
    super(
      `quote is not sponsored: give ${fields.giveValue} of ${fields.giveColour.slice(0, 10)}… ` +
        `($${raw.from_usd}) for ${fields.wantAmount} of ${fields.wantColour.slice(0, 10)}… ` +
        `($${raw.to_usd}); implied discount ${raw.discount}, sponsorship needs ${raw.sponsor_discount}`,
    );
    this.name = "NotSponsoredError";
    this.giveColour = fields.giveColour;
    this.wantColour = fields.wantColour;
    this.giveValue = fields.giveValue;
    this.wantAmount = fields.wantAmount;
    this.marketRate = raw.market_rate;
    this.sponsorDiscount = raw.sponsor_discount;
    this.impliedDiscount = raw.discount;
    this.giveUsd = raw.from_usd;
    this.wantUsd = raw.to_usd;
    this.fromSource = raw.from_source;
    this.toSource = raw.to_source;
    this.raw = raw;
  }
}

const COLOUR_RE = /^[0-9a-f]{64}$/;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;

/** Price sources that are NOT market data. `demo-fallback` means the colour is
 *  not registered at all (`POST /v1/known-tokens` never ran, or ran too late);
 *  `fallback` means it is registered but maps to no priced asset. The
 *  sponsorship gate treats both as unpriced, which under
 *  `BATCHER_SPONSOR_UNPRICED=reject` is a `422 UNPRICED_TOKEN`. */
const DEMO_SOURCES = new Set(["demo-fallback", "fallback"]);

function normaliseColour(value: string, what: string): string {
  const hex = String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!COLOUR_RE.test(hex)) {
    throw new QuoteError("INVALID_ARGUMENT", `${what} must be a 64-hex token colour, got ${JSON.stringify(value)}`);
  }
  return hex;
}

function readAmount(body: Record<string, unknown>, field: string, path: string): bigint {
  const raw = body[field];
  if (typeof raw !== "string" || !CANONICAL_UINT.test(raw)) {
    throw new QuoteError(
      "MALFORMED",
      `${path}: "${field}" must be a canonical decimal string, got ${JSON.stringify(raw)}`,
      { body, path },
    );
  }
  return BigInt(raw);
}

/** Ask the kernel what this coin's offer should want.
 *
 *  Unforced (the default): the want amount is `suggested_to_amount`, which is the
 *  largest amount the batcher will sponsor at today's reference prices. If the
 *  kernel nonetheless reports `sponsored: false`, this throws
 *  {@link NotSponsoredError} rather than posting something that will be refused.
 *
 *  Forced (`WANT_AMOUNT` set): the amount is the operator's, the quote is asked
 *  with `to_amount` so the verdict is still known, and an unsponsored verdict is
 *  returned as `sponsored: false` plus a warning for the caller to decide on. */
export async function sizeWant(api: QuoteApi, opts: SizeWantOptions): Promise<SizedWant> {
  const giveColour = normaliseColour(opts.giveColour, "giveColour");
  const wantColour = normaliseColour(opts.wantColour, "wantColour");
  if (giveColour === wantColour) {
    // The kernel answers 400 VALIDATION for this; failing here says why.
    throw new QuoteError("INVALID_ARGUMENT", "giveColour and wantColour must be distinct");
  }
  const { giveValue, forcedWantAmount } = opts;
  if (typeof giveValue !== "bigint" || giveValue <= 0n) {
    throw new QuoteError("INVALID_ARGUMENT", `giveValue must be a positive bigint, got ${String(giveValue)}`);
  }
  const forced = forcedWantAmount !== undefined;
  if (forced && (typeof forcedWantAmount !== "bigint" || forcedWantAmount < 0n)) {
    throw new QuoteError(
      "INVALID_ARGUMENT",
      `forcedWantAmount must be a non-negative bigint, got ${String(forcedWantAmount)}`,
    );
  }

  const path =
    `/v1/quote?from_token=${giveColour}&to_token=${wantColour}&from_amount=${giveValue.toString()}` +
    (forced ? `&to_amount=${(forcedWantAmount as bigint).toString()}` : "");

  const { status, body } = await api.get<unknown>(path);
  if (status !== 200) {
    throw new QuoteError("HTTP", `GET ${path} → ${status}: ${JSON.stringify(body)}`, { status, body, path });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new QuoteError("MALFORMED", `GET ${path} → 200 with a non-object body: ${JSON.stringify(body)}`, {
      status,
      body,
      path,
    });
  }
  const raw = body as Record<string, unknown>;
  const suggested = readAmount(raw, "suggested_to_amount", path);
  const echoed = readAmount(raw, "to_amount", path);
  if (typeof raw["sponsored"] !== "boolean") {
    throw new QuoteError("MALFORMED", `${path}: "sponsored" must be a boolean`, { status, body, path });
  }
  for (const field of ["market_rate", "sponsor_discount"]) {
    if (typeof raw[field] !== "number" || !Number.isFinite(raw[field] as number)) {
      throw new QuoteError("MALFORMED", `${path}: "${field}" must be a finite number`, { status, body, path });
    }
  }

  const quote = raw as unknown as QuoteResponse;
  const wantAmount = forced ? (forcedWantAmount as bigint) : suggested;
  const sponsored = quote.sponsored;
  const warnings: string[] = [];

  // A leg priced from a demo/fallback source is not market data. It still
  // quotes and still (by default, BATCHER_SPONSOR_UNPRICED=allow) gets
  // sponsored — but it means name registration did not take effect, which is
  // exactly the failure US4 scenario 4 warns about.
  const fromSource = typeof quote.from_source === "string" ? quote.from_source : "";
  const toSource = typeof quote.to_source === "string" ? quote.to_source : "";
  if (DEMO_SOURCES.has(fromSource)) {
    warnings.push(`give leg is priced from "${fromSource}" — not market data; register the colour's name`);
  }
  if (DEMO_SOURCES.has(toSource)) {
    warnings.push(`want leg is priced from "${toSource}" — not market data; register the colour's name`);
  }
  if (quote.prices_updated_at === null && warnings.length === 0) {
    warnings.push("prices_updated_at is null — at least one leg has no dated reference price");
  }
  if (forced) {
    if (echoed !== wantAmount) {
      warnings.push(`kernel echoed to_amount ${echoed}, expected the forced ${wantAmount}`);
    }
    if (!sponsored) {
      warnings.push(
        `forced want amount ${wantAmount} is NOT sponsored (suggested ${suggested}, ` +
          `implied discount ${quote.discount}, needs ${quote.sponsor_discount})`,
      );
    }
  } else if (!sponsored) {
    throw new NotSponsoredError({ giveColour, wantColour, giveValue, wantAmount, raw: quote });
  }

  return {
    wantAmount,
    sponsored,
    forced,
    suggestedWantAmount: suggested,
    marketRate: quote.market_rate,
    sponsorDiscount: quote.sponsor_discount,
    fromSource,
    toSource,
    pricesUpdatedAt: typeof quote.prices_updated_at === "string" ? quote.prices_updated_at : null,
    warnings,
    raw: quote,
  };
}

/** The journal's per-offer quote snapshot (FR-005/FR-008), from a sized want. */
export function quoteSnapshot(sized: SizedWant): {
  marketRate: number;
  sponsorDiscount: number;
  fromSource: string;
  toSource: string;
  pricesUpdatedAt: string | null;
  sponsored: boolean;
} {
  return {
    marketRate: sized.marketRate,
    sponsorDiscount: sized.sponsorDiscount,
    fromSource: sized.fromSource,
    toSource: sized.toSource,
    pricesUpdatedAt: sized.pricesUpdatedAt,
    sponsored: sized.sponsored,
  };
}
