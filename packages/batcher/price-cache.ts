// The batcher's view of the node's reference prices.
//
// The batcher holds the wallet that pays the Celestia fee, so it is the
// authoritative sponsorship gate (anyone can POST to /send-input directly,
// bypassing the node's own pre-check). But it has no database — by design; see
// the DedupStore note in @zswap-da/offer-guard — so it cannot read
// `asset_prices` or apply the node's resolution order itself.
//
// It therefore POLLS the node's `GET /v1/prices`, which is exactly the answer
// the node's quote and its own pre-check are built on. One source of prices,
// three readers, no drift (D4). The poll is cheap (one small JSON body every
// ten minutes) and deliberately NOT per-offer: a per-offer lookup would put the
// node on the critical path of every fee decision and turn a node restart into
// a batcher outage.
//
// What a stale or missing snapshot means is NOT decided here — this class only
// reports `ageMs()`/`isFresh()`. The policy (`BATCHER_SPONSOR_POLICY`) lives in
// celestia.ts, because "we could not reach the node" and "this offer is a bad
// trade" are different questions with different right answers per deployment.

import { sponsorDiscountFromBps, type PriceRow, type PriceSource } from "@zswap-da/offer-guard";

/** Sources that carry a real market price. `fallback` is the demo hash price. */
const MARKET_SOURCES: ReadonlySet<string> = new Set<PriceSource>([
  "feed",
  "seed",
  "fixed",
  "manual",
]);

/** One consistent read of the node's price table. */
export interface PriceSnapshot {
  /** Token colour (lower-case hex) → price row, as `evaluateSponsorship` wants it. */
  prices: ReadonlyMap<string, PriceRow>;
  /** The node's own sponsorship threshold, as a fraction. */
  sponsorDiscount: number;
  /** Epoch ms at which this body was received. */
  fetchedAt: number;
}

export interface PriceCacheOptions {
  /** Base URL of the node API — `BATCHER_NODE_API_URL`. */
  url: string;
  /** Poll period. */
  refreshMs: number;
  /**
   * Threshold to use while the node has NEVER answered. Deliberately only a
   * bootstrap value: once a snapshot exists the node's number wins, so the two
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

interface RawToken {
  token_color?: unknown;
  price_usd?: unknown;
  source?: unknown;
}

/**
 * Turn a `GET /v1/prices` body into a snapshot's payload.
 *
 * Exported because this — not the HTTP plumbing — is the part that decides
 * whether a token is priced, and it is worth pinning against master §3's
 * fixture directly.
 *
 * Throws when the body is not the documented shape at all. An INDIVIDUAL token
 * entry that is malformed, or carries a `source` this build does not know, is
 * kept as `fallback` instead: "I cannot vouch for this as a market price" is
 * the safe reading, and it keeps a newer node adding a sixth source from
 * silently making the batcher sponsor at a price it does not understand. The
 * count of such entries is returned so the caller can say so out loud.
 */
export function parsePricesBody(
  body: unknown,
  fallbackDiscount: number,
): { prices: Map<string, PriceRow>; sponsorDiscount: number; downgraded: number } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("prices body is not an object");
  }
  const record = body as { sponsor_discount?: unknown; tokens?: unknown };
  if (!Array.isArray(record.tokens)) {
    throw new Error("prices body has no `tokens` array");
  }

  const rawDiscount = Number(record.sponsor_discount);
  const sponsorDiscount =
    Number.isFinite(rawDiscount) && rawDiscount >= 0 && rawDiscount < 1
      ? rawDiscount
      : fallbackDiscount;

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
  return { prices, sponsorDiscount, downgraded };
}

/**
 * Polls `${url}/v1/prices` and holds the last body that parsed.
 *
 * A failed refresh keeps the previous snapshot untouched — `fetchedAt` does
 * not move, so `ageMs()` keeps growing and `isFresh()` eventually turns false.
 * That is the whole point: the batcher must be able to tell "the node said
 * this ten minutes ago" from "the node has been unreachable for two days",
 * and a refresh that bumped the timestamp on failure would erase exactly that
 * difference.
 */
export class PriceCache {
  private current: PriceSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly logError: (line: string) => void;
  private readonly requestTimeoutMs: number;
  /** True once any fetch has succeeded — the env discount applies only before it. */
  private everAnswered = false;

  constructor(private readonly options: PriceCacheOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
    this.logError = options.logError ?? ((line) => console.error(line));
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get pricesUrl(): string {
    return `${this.options.url.replace(/\/+$/, "")}/v1/prices`;
  }

  /**
   * Fetch immediately, then every `refreshMs`. The first fetch is
   * fire-and-forget and NON-FATAL: a batcher that refused to start because the
   * node was not up yet would make the node a hard dependency of the component
   * whose entire job is to keep working when other things are down. What a
   * missing snapshot means is the policy's business.
   */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs);
    // The refresh loop must never be the reason this process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll. Returns whether the snapshot was replaced. Never throws. */
  async refresh(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.pricesUrl, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parsePricesBody(await response.json(), this.options.fallbackDiscount);
      this.current = {
        prices: parsed.prices,
        sponsorDiscount: parsed.sponsorDiscount,
        fetchedAt: this.now(),
      };
      this.everAnswered = true;
      this.log(
        `[zswap-da-batcher] prices: ${parsed.prices.size} tokens, ` +
          `discount ${(parsed.sponsorDiscount * 100).toFixed(2)}% from ${this.pricesUrl}` +
          (parsed.downgraded > 0 ? ` (${parsed.downgraded} entries not usable as market prices)` : ""),
      );
      return true;
    } catch (error) {
      // Keep the old snapshot and let it age. Logged, never thrown: this runs
      // on a timer with no caller to catch it.
      this.logError(
        `[zswap-da-batcher] price refresh failed (${this.pricesUrl}): ` +
          `${error instanceof Error ? error.message : String(error)}` +
          (this.current === null
            ? " — no prices yet"
            : ` — keeping the snapshot from ${new Date(this.current.fetchedAt).toISOString()}`),
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot(): PriceSnapshot | null {
    return this.current;
  }

  /** Age of the held snapshot in ms, or null when there has never been one. */
  ageMs(): number | null {
    return this.current === null ? null : this.now() - this.current.fetchedAt;
  }

  isFresh(maxAgeMs: number): boolean {
    const age = this.ageMs();
    return age !== null && age <= maxAgeMs;
  }

  /**
   * The threshold to apply. The node's value once it has ever answered; the
   * `SPONSOR_DISCOUNT_BPS` bootstrap only before that.
   */
  discount(): number {
    return this.current?.sponsorDiscount ?? this.options.fallbackDiscount;
  }

  /** One line an operator can read: is this batcher actually price-aware? */
  describe(): string {
    const age = this.ageMs();
    return this.current === null
      ? `prices=NONE (${this.everAnswered ? "cleared" : "never answered"}) node=${this.pricesUrl}`
      : `prices=${this.current.prices.size} tokens age=${Math.round(age! / 1000)}s ` +
        `discount=${(this.current.sponsorDiscount * 100).toFixed(2)}% node=${this.pricesUrl}`;
  }
}

/** Basis points → fraction, re-exported so config.ts has one import for it. */
export { sponsorDiscountFromBps };
