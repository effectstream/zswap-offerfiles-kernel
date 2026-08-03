// Real per-pair market data derived from the indexer DB:
//   - trade history = CONSUMED offers (offer_file_history), each treated as a
//     fill at its offered price (price = quote/base, size = base leg).
//   - stats        = last / 24h-change / high / low / volume from those fills,
//     falling back to the mid of the current open offers when there are no fills.
//
// Prices are quoted as quote-per-base. An offer GIVING base / WANTING quote is a
// SELL of base (ask); GIVING quote / WANTING base is a BUY of base (bid).

import { getTradeHistory, getOpenLegs, getPairStats24h } from "@zswap-da/database";

export interface HistoryRow { price: number; amt: number; up: boolean; at: string }
export interface Stats {
  base: string; quote: string; last: number; change24: number;
  high: number; low: number; volume_base: number; volume_quote: number;
}

interface LegRow { g_color: string; g_amt: string; w_color: string; w_amt: string }

// One fill, normalised to quote-per-base price + base-denominated size.
function toFill(r: LegRow, base: string): { price: number; amt: number } {
  const gAmt = Number(r.g_amt);
  const wAmt = Number(r.w_amt);
  if (r.g_color === base) {
    return { price: gAmt > 0 ? wAmt / gAmt : 0, amt: gAmt };
  }
  return { price: wAmt > 0 ? gAmt / wAmt : 0, amt: wAmt };
}

/** Trade history (newest first) built from consumed offers for this pair. */
export async function realHistory(dbConn: any, base: string, quote: string): Promise<HistoryRow[]> {
  const rows = await getTradeHistory.run({ base, quote }, dbConn);
  const fills = rows.map((r) => ({
    ...toFill(r, base),
    at: Number(r.at_ms),
  })).filter((f) => f.price > 0 && f.amt > 0);
  return fills.map((f, i) => ({
    price: f.price,
    amt: f.amt,
    up: i + 1 < fills.length ? f.price >= fills[i + 1].price : true,
    at: new Date(f.at).toISOString(),
  }));
}

/** Mid price from current open offers (best ask / best bid), 0 if none. */
async function currentMid(dbConn: any, base: string, quote: string): Promise<number> {
  const rows = await getOpenLegs.run({ base, quote }, dbConn);
  const asks: number[] = [];
  const bids: number[] = [];
  for (const r of rows) {
    const f = toFill(r, base);
    if (f.price <= 0) continue;
    (r.g_color === base ? asks : bids).push(f.price);
  }
  const bestAsk = asks.length ? Math.min(...asks) : 0;
  const bestBid = bids.length ? Math.max(...bids) : 0;
  if (bestAsk && bestBid) return (bestAsk + bestBid) / 2;
  return bestAsk || bestBid || 0;
}

export async function realStats(dbConn: any, base: string, quote: string): Promise<Stats> {
  // Stats come from getPairStats24h — a SQL aggregate over EVERY fill in the
  // 24 h window. They must never be derived from realHistory: that query is
  // display-capped at 120 rows, and inheriting the cap silently understated
  // volume, truncated high/low, and baselined change24 on the 120th-newest
  // trade for any pair with >120 fills a day.
  const rows = await getPairStats24h.run({ base, quote }, dbConn);
  const s = rows[0];
  const last = s?.last_price != null ? Number(s.last_price) : null;

  if (last == null) {
    // No fills ever — quote the mid of the open book, if any.
    const mid = await currentMid(dbConn, base, quote);
    return { base, quote, last: mid, change24: 0, high: mid, low: mid, volume_base: 0, volume_quote: 0 };
  }

  // change24 baseline: the newest fill at/older than the cutoff; for a pair
  // whose entire history is inside the window, the oldest in-window fill
  // (change since inception). Equal to `last` when the window is empty → 0%.
  const ref = s.ref_before_24h != null
    ? Number(s.ref_before_24h)
    : s.oldest_in_24h != null
      ? Number(s.oldest_in_24h)
      : last;
  const change24 = ref > 0 ? ((last - ref) / ref) * 100 : 0;

  // Window empty (no trades in 24 h): volumes are genuinely 0 and high/low
  // collapse to the last price — NOT to aggregates over stale history, which
  // is what the old fallback reported as "24 h" numbers.
  const hasWindow = s.fills_24h > 0;
  return {
    base, quote, last, change24,
    high: hasWindow ? Number(s.high_24h) : last,
    low: hasWindow ? Number(s.low_24h) : last,
    volume_base: hasWindow ? Number(s.volume_base_24h) : 0,
    volume_quote: hasWindow ? Number(s.volume_quote_24h) : 0,
  };
}
