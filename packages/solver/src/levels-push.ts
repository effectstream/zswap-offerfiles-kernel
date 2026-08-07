// Publishing the solver's posted prices to the node, so `GET /v1/quote` serves
// a price someone will actually honour instead of a placeholder.
//
// Rungs are clipped to what the solver can currently pay. Publishing a rung it
// cannot honour is worse than publishing nothing: the node quotes it, a maker
// builds an offer against that quote, and the solver then refuses for want of
// stock — a wasted proof and a wasted round trip for the maker.

import type { LadderBook, PriceLevels } from "./ladder.ts";
import type { Stock } from "./stock.ts";

export interface LevelsPushOptions {
  api: string;
  solverId: string;
  ladders: LadderBook;
  stock: Stock;
  intervalMs: number;
  log?: (msg: string) => void;
}

export interface LevelsPushHandle {
  push: () => Promise<void>;
  stop: () => void;
}

/** Drop the rungs the solver cannot currently pay out.
 *
 *  Rungs ascend in both input and output, so affordability is a prefix: once
 *  one rung's output exceeds available stock, every later rung does too. A pair
 *  with no affordable rung is omitted entirely rather than published empty. */
export function clipToStock(ladders: LadderBook, stock: Stock): PriceLevels[] {
  const out: PriceLevels[] = [];
  for (const pair of ladders.pairs()) {
    const budget = stock.available(pair.tokenOut);
    const affordable = [];
    for (const rung of pair.levels) {
      if (BigInt(rung.output) > budget) break;
      affordable.push(rung);
    }
    if (affordable.length > 0) {
      out.push({ tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, levels: affordable });
    }
  }
  return out;
}

export function startLevelsPush(opts: LevelsPushOptions): LevelsPushHandle {
  const log = opts.log ?? (() => {});
  let stopped = false;

  const push = async (): Promise<void> => {
    const pairs = clipToStock(opts.ladders, opts.stock);
    if (pairs.length === 0) return;
    try {
      const res = await fetch(`${opts.api}/v1/solver/levels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ solverId: opts.solverId, pairs }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log(`[solver] levels push rejected: ${res.status}`);
    } catch (err) {
      // Prices are re-pushed on the next tick, so a failed push is a gap in
      // quoting, never a lost update worth retrying here.
      log(`[solver] levels push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  void push();
  const timer = setInterval(() => {
    if (!stopped) void push();
  }, opts.intervalMs);
  timer.unref?.();

  return {
    push,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
