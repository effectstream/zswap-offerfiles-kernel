// The batcher's view of the node's reference prices: PER COLOUR, on demand.
//
// The batcher holds the wallet that pays the Celestia fee, so it is the
// authoritative sponsorship gate (anyone can POST to /send-input directly,
// bypassing the node's own pre-check). But it has no database — by design; see
// the DedupStore note in @zswap-da/offer-guard — so it cannot read
// `asset_prices` or apply the node's resolution order itself.
//
// It therefore asks the node's `GET /v1/prices?tokens=`, which is exactly the
// answer the node's quote and its own pre-check are built on. One source of
// prices, three readers, no drift (D4).
//
// WHY NOT A TABLE MIRROR (Q-11). This used to poll the whole price table every
// ten minutes and hold a snapshot. That is fine for six tokens and wrong for
// thousands: the payload grows with the registry, the batcher downloads prices
// for colours no offer will ever mention, and a token minted since the last
// poll is invisible until the next one. Now each offer's LEG COLOURS are looked
// up in one request, and answers are cached per colour for `ttlMs` — so a busy
// pair costs one request per TTL, not one per offer, and an unfamiliar colour
// is answered immediately rather than ten minutes later.
//
// What a missing answer MEANS is not decided here — this class reports which
// colours it could not answer for. The policy (`BATCHER_SPONSOR_POLICY`) lives
// in celestia.ts, because "we could not reach the node" and "this offer is a
// bad trade" are different questions with different right answers per
// deployment.

import { sponsorDiscountFromBps, type PriceRow, type PriceSource } from "@zswap-da/offer-guard";

/**
 * Sources that carry a real market price. `fallback` is the demo hash price.
 *
 * Anything else the node sends is downgraded to `fallback` rather than
 * trusted — including `fixed`, which older nodes served for the USDM peg
 * before every asset became a fetched USD price. Downgrading is the safe
 * direction: the offer becomes "unpriced" and BATCHER_SPONSOR_UNPRICED
 * decides, instead of a fee being paid against a price this build cannot
 * vouch for.
 */
const MARKET_SOURCES: ReadonlySet<string> = new Set<PriceSource>(["feed", "seed", "manual"]);

/** The node's `feed` block, carried through so an operator can see it. */
export interface FeedStatus {
  provider: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
}

export interface PriceLookupOptions {
  /** Base URL of the node API — `BATCHER_NODE_API_URL`. */
  url: string;
  /** How long a per-colour answer counts as current. `BATCHER_PRICE_TTL_MS`. */
  ttlMs: number;
  /**
   * How old a cached answer may be and still be served when a refresh FAILS.
   * `BATCHER_PRICE_MAX_AGE_MS`. Past it the colour is unavailable and the
   * policy decides. Must be >= ttlMs to mean anything.
   */
  maxAgeMs: number;
  /**
   * Threshold to use while the node has NEVER answered. Deliberately only a
   * bootstrap value: once an answer exists the node's number wins, so the two
   * processes cannot disagree about what the UI promised the maker.
   */
  fallbackDiscount: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The node's cap on one request (Q-11). Colours are looked up in pages of this. */
export const MAX_TOKENS_PER_REQUEST = 50;

/**
 * The colour used for the optional startup probe: NIGHT, whose colour is
 * 0x00…00 on every network and is seeded in `000-init.sql` everywhere. The
 * probe exists so an operator can read "am I price-aware?" off the startup
 * log instead of discovering it on the first offer.
 */
export const PROBE_COLOR = "0".repeat(64);

interface RawToken {
  token_color?: unknown;
  price_usd?: unknown;
  source?: unknown;
}

/**
 * One cached answer about one colour.
 *
 * `row === null` is a real answer, not a gap: the node replied and does not
 * price this colour. Caching it is what stops every offer on a test token from
 * re-asking.
 */
interface Entry {
  row: PriceRow | null;
  fetchedAt: number;
}

/**
 * Turn a `GET /v1/prices` body into the rows it carries.
 *
 * Exported because this — not the HTTP plumbing — is the part that decides
 * whether a token is priced, and it is worth pinning against master §3's
 * fixture directly.
 *
 * Throws when the body is not the documented shape at all. An INDIVIDUAL token
 * entry that is malformed, or carries a `source` this build does not know, is
 * kept as `fallback` instead: "I cannot vouch for this as a market price" is
 * the safe reading, and it keeps a newer node adding a source from silently
 * making the batcher sponsor at a price it does not understand. The count of
 * such entries is returned so the caller can say so out loud.
 */
export function parsePricesBody(
  body: unknown,
  fallbackDiscount: number,
): {
  prices: Map<string, PriceRow>;
  sponsorDiscount: number;
  downgraded: number;
  feed: FeedStatus | null;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("prices body is not an object");
  }
  const record = body as { sponsor_discount?: unknown; tokens?: unknown; feed?: unknown };
  if (!Array.isArray(record.tokens)) {
    throw new Error("prices body has no `tokens` array");
  }

  const rawDiscount = Number(record.sponsor_discount);
  const sponsorDiscount =
    Number.isFinite(rawDiscount) && rawDiscount >= 0 && rawDiscount < 1
      ? rawDiscount
      : fallbackDiscount;

  const rawFeed = record.feed;
  const feed: FeedStatus | null =
    typeof rawFeed === "object" && rawFeed !== null && !Array.isArray(rawFeed)
      ? {
          provider: str((rawFeed as Record<string, unknown>)["provider"]),
          last_run_at: str((rawFeed as Record<string, unknown>)["last_run_at"]),
          last_ok_at: str((rawFeed as Record<string, unknown>)["last_ok_at"]),
          last_error: str((rawFeed as Record<string, unknown>)["last_error"]),
        }
      : null;

  const prices = new Map<string, PriceRow>();
  let downgraded = 0;
  for (const entry of record.tokens as RawToken[]) {
    if (typeof entry !== "object" || entry === null) {
      downgraded++;
      continue;
    }
    const color = typeof entry.token_color === "string" ? entry.token_color.toLowerCase() : null;
    if (color === null || color === "") {
      downgraded++;
      continue;
    }
    const price = entry.price_usd;
    const priceOk =
      (typeof price === "string" || typeof price === "number") &&
      Number.isFinite(Number(price));
    const sourceOk = typeof entry.source === "string" && MARKET_SOURCES.has(entry.source);
    if (!priceOk || !sourceOk) {
      // Present but not usable as a market price: `evaluateSponsorship` reads
      // `fallback` as "unpriced", which is the honest verdict here.
      if (!(typeof entry.source === "string" && entry.source === "fallback")) downgraded++;
      prices.set(color, { price_usd: priceOk ? (price as string | number) : "0", source: "fallback" });
      continue;
    }
    prices.set(color, { price_usd: price as string | number, source: entry.source as PriceSource });
  }
  return { prices, sponsorDiscount, downgraded, feed };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** What one lookup produced. */
export interface LookupResult {
  /** Colours with a usable answer, as `evaluateSponsorship` wants them. */
  prices: ReadonlyMap<string, PriceRow>;
  /**
   * Colours the node could not be asked about and for which no cached answer
   * is young enough to serve. NOT the same as "the node does not price this",
   * which is an answer and shows up as an absence from `prices`.
   */
  unavailable: string[];
  /** The threshold to apply: the node's, once it has ever answered. */
  discount: number;
  /** Why `unavailable` is non-empty, ready for a log line or a refusal. */
  detail: string | null;
  /** True when this lookup made an HTTP request. */
  requested: boolean;
}

/**
 * Per-colour price lookups against `${url}/v1/prices?tokens=`.
 *
 * A failed request never erases what is already cached: entries keep their
 * original `fetchedAt`, so they age past the TTL, get served while they are
 * still within `maxAgeMs`, and only then become unavailable. That is the whole
 * point — the batcher must be able to tell "the node said this ten minutes
 * ago" from "the node has been unreachable for two days".
 */
export class PriceLookup {
  private readonly entries = new Map<string, Entry>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;
  private readonly requestTimeoutMs: number;
  private sponsorDiscount: number | null = null;
  private feed: FeedStatus | null = null;
  private lastOkAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private requests = 0;

  constructor(private readonly options: PriceLookupOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
    this.logError = options.logError ?? ((line) => console.error(line));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get pricesUrl(): string {
    return `${this.options.url.replace(/\/+$/, "")}/v1/prices`;
  }

  /** How many HTTP requests this lookup has made. The live check reads it. */
  get requestCount(): number {
    return this.requests;
  }

  /**
   * One optional request at startup so the startup log can say whether the
   * node answers and what threshold it publishes. Non-fatal: a batcher that
   * refused to start because the node was not up yet would make the node a
   * hard dependency of the component whose entire job is to keep working when
   * other things are down.
   */
  async probe(): Promise<boolean> {
    const result = await this.lookup([PROBE_COLOR]);
    return result.unavailable.length === 0;
  }

  /**
   * Look up these colours, fetching only the ones that are missing or past the
   * TTL — in ONE request (paged at the node's 50-colour cap).
   */
  async lookup(colors: readonly string[]): Promise<LookupResult> {
    const wanted = [...new Set(colors.map((c) => c.toLowerCase()))];
    const now = this.now();
    const stale = wanted.filter((color) => {
      const entry = this.entries.get(color);
      return entry === undefined || now - entry.fetchedAt > this.options.ttlMs;
    });

    let requested = false;
    let fetchError: string | null = null;
    for (let i = 0; i < stale.length; i += MAX_TOKENS_PER_REQUEST) {
      requested = true;
      const page = stale.slice(i, i + MAX_TOKENS_PER_REQUEST);
      const error = await this.fetchColors(page);
      if (error !== null) {
        fetchError = error;
        // A failed page means the node is not answering; asking again for the
        // next page would only multiply the timeout.
        break;
      }
    }

    const prices = new Map<string, PriceRow>();
    const unavailable: string[] = [];
    const after = this.now();
    for (const color of wanted) {
      const entry = this.entries.get(color);
      if (entry === undefined) {
        // Never answered for, and this attempt did not fix that.
        unavailable.push(color);
        continue;
      }
      const age = after - entry.fetchedAt;
      if (age > this.options.maxAgeMs) {
        // Too old to stand behind, even as a stale answer.
        unavailable.push(color);
        continue;
      }
      // Within maxAge: usable. `null` is the node's answer that it does not
      // price this colour, which `evaluateSponsorship` reads as unpriced.
      if (entry.row !== null) prices.set(color, entry.row);
    }

    return {
      prices,
      unavailable,
      discount: this.discount(),
      detail: unavailable.length === 0 ? null : this.describeUnavailable(fetchError),
      requested,
    };
  }

  /** One page. Returns null on success, or the error text. Never throws. */
  private async fetchColors(colors: readonly string[]): Promise<string | null> {
    const url = `${this.pricesUrl}?tokens=${colors.join(",")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    this.requests++;
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parsePricesBody(await response.json(), this.options.fallbackDiscount);
      const at = this.now();
      for (const color of colors) {
        // A colour the node did not return is an ANSWER: it has no price.
        this.entries.set(color, { row: parsed.prices.get(color) ?? null, fetchedAt: at });
      }
      // Refreshed from every response, per §3a.
      this.sponsorDiscount = parsed.sponsorDiscount;
      this.feed = parsed.feed;
      this.lastOkAt = at;
      this.lastError = null;
      this.log(
        `[zswap-da-batcher] prices: asked for ${colors.length} color(s), ` +
          `${parsed.prices.size} priced, discount ${(parsed.sponsorDiscount * 100).toFixed(2)}% ` +
          `from ${this.pricesUrl}` +
          (parsed.downgraded > 0 ? ` (${parsed.downgraded} entries not usable as market prices)` : ""),
      );
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.lastErrorAt = this.now();
      // Logged, never thrown: the caller is a validation path that must keep a
      // deployment policy in charge of what a missing price means.
      this.logError(`[zswap-da-batcher] price lookup failed (${this.pricesUrl}): ${message}`);
      return message;
    }
  }

  private describeUnavailable(fetchError: string | null): string {
    if (fetchError !== null) {
      return this.lastOkAt === null
        ? `${this.pricesUrl} has never answered (${fetchError})`
        : `${this.pricesUrl} failed (${fetchError}); last good answer ` +
          `${Math.round((this.now() - this.lastOkAt) / 1000)}s ago, ` +
          `max ${Math.round(this.options.maxAgeMs / 1000)}s`;
    }
    return (
      `no answer within ${Math.round(this.options.maxAgeMs / 1000)}s for some colors ` +
      `from ${this.pricesUrl}`
    );
  }

  /**
   * The threshold to apply. The node's value once it has ever answered; the
   * `SPONSOR_DISCOUNT_BPS` bootstrap only before that.
   */
  discount(): number {
    return this.sponsorDiscount ?? this.options.fallbackDiscount;
  }

  /** The node's feed status from the last good answer, if any. */
  feedStatus(): FeedStatus | null {
    return this.feed;
  }

  /** Drop everything cached. Only tests and an operator-triggered reset need this. */
  clear(): void {
    this.entries.clear();
  }

  /** One line an operator can read: is this batcher actually price-aware? */
  describe(): string {
    if (this.lastOkAt === null) {
      const why = this.lastError === null ? "not asked yet" : `never answered: ${this.lastError}`;
      return `prices=NONE (${why}) node=${this.pricesUrl}`;
    }
    return (
      `prices=${this.entries.size} color(s) cached, last answer ` +
      `${Math.round((this.now() - this.lastOkAt) / 1000)}s ago, ` +
      `ttl=${Math.round(this.options.ttlMs / 1000)}s max_age=${Math.round(this.options.maxAgeMs / 1000)}s ` +
      `discount=${(this.discount() * 100).toFixed(2)}% node=${this.pricesUrl}` +
      (this.lastError === null
        ? ""
        : ` (last error ${this.lastError}` +
          (this.lastErrorAt === null
            ? ")"
            : ` ${Math.round((this.now() - this.lastErrorAt) / 1000)}s ago)`))
    );
  }
}

/** Basis points → fraction, re-exported so config.ts has one import for it. */
export { sponsorDiscountFromBps };
