// The suite's own record of intent — the oracle the final audit compares the
// system against. Every real offer, every fate action, every piece of garbage
// this suite emits is recorded here; nothing in the audit trusts the API to
// grade its own homework.

import type { TokenKey } from "./config.ts";
import { writeOut } from "./lib/util.ts";

export type Fate = "settled" | "cancelled" | "expired" | "live";
export type CancelShape =
  | "single-one-tx" // one input coin, spent whole in one self-tx (marker-proven cancel)
  | "split-two-tx" // two input coins, spent across two txs
  | "partial" // two input coins, only one ever spent
  | "consolidated-one-tx"; // two input coins, both spent in ONE self-tx without markers
// Give and want always share a value layer. Cross-layer (shielded<->unshielded)
// swaps are not a supported offer shape, so the suite never builds one.
export type Layer = "ss" | "uu";

export interface OfferRecord {
  index: number;
  fate: Fate;
  cancelShape?: CancelShape;
  layer: Layer;
  makerSeed: string;
  giveToken: TokenKey;
  wantToken: TokenKey;
  giveAmount: string;
  wantAmount: string;
  publishPath: "api" | "celestia";
  phase: string;

  // Filled in as the offer progresses.
  offerHash?: string;
  blobChars?: number;
  rowId?: number;
  celestiaHeight?: number;
  submittedAt?: number;
  indexedAt?: number;
  resolvedAt?: number;
  /** Whether the offer carries shielded want outputs (fill markers). */
  hasFillMarkers?: boolean;
  state: "planned" | "published" | "indexed" | "resolved" | "casualty";
  casualtyReason?: string;
}

export interface GarbageRecord {
  kind: string; // fixture family, e.g. BAD_ENCODING, random-bytes…
  via: "api" | "celestia" | "batcher";
  expectedCodes: string[]; // acceptable rejection codes (RATE_LIMITED is implicit for api storms)
  offerHash?: string; // when the bytes decode to a hashable offer
  celestiaHeight?: number;
  at: number;
  gotCode?: string;
  gotStatus?: number;
}

export interface SseLedgerEntry {
  offerHash: string;
  rowId?: number;
  indexedEvents: number;
  terminalEvents: number;
}

class Ledger {
  readonly offers: OfferRecord[] = [];
  readonly garbage: GarbageRecord[] = [];
  /** TokenKey → on-chain color (64-hex), set once minted in setup. */
  readonly colors: Partial<Record<TokenKey, string>> = {};
  /** Colors registered purely via POST /v1/known-tokens (excluded from the
   *  determinism diff — request-driven, instance B never sees the request). */
  readonly apiOnlyTokenColors: string[] = [];
  /** rowId → offerHash learned from offer_indexed SSE events / DB. */
  readonly rowIdToHash = new Map<number, string>();
  suiteStartedAt = Date.now();
  /** Celestia head at p0 — rejections at or below this height predate the
   *  suite (earlier runs / other producers) and are excluded from the
   *  rejection-attribution audit. */
  startCelestiaHeight = 0;

  addOffer(rec: OfferRecord): OfferRecord {
    this.offers.push(rec);
    return rec;
  }

  addGarbage(rec: GarbageRecord): GarbageRecord {
    this.garbage.push(rec);
    return rec;
  }

  byFate(fate: Fate): OfferRecord[] {
    return this.offers.filter((o) => o.fate === fate && o.state !== "casualty");
  }

  casualties(): OfferRecord[] {
    return this.offers.filter((o) => o.state === "casualty");
  }

  markCasualty(rec: OfferRecord, reason: string): void {
    rec.state = "casualty";
    rec.casualtyReason = reason;
    console.warn(`[LEDGER] casualty offer#${rec.index} (${rec.fate}): ${reason}`);
  }

  /**
   * Settled offers aggregated per UNORDERED pair, with volume attributed per
   * COLOR — the shape `/v1/chart/*` actually reports.
   *
   * pair_stats keys on `base|quote` and counts every fill for that pair
   * regardless of direction, so an A→B fill and a B→A fill land in the same
   * row: A's volume is `give` from the first plus `want` from the second.
   * Keying the oracle by direction instead made the API look like it had
   * doubled every trade (api=6 vs ledger=3, and volumes that summed exactly to
   * the two directions combined).
   */
  fillLedger(): Map<string, { count: number; byColor: Record<string, bigint> }> {
    return this.aggregate(false);
  }

  /**
   * The same aggregation with the unshielded gap REMOVED — only genuine
   * settlements count. This is what the numbers should be; `fillLedger()` is
   * what they currently are.
   *
   * Both exist on purpose. `fillLedger()` asserts CURRENT behaviour per-pair so
   * the suite stays a working gate; this one asserts the TRUTH in aggregate and
   * is registered as a known red (RED-5) until PR-B lands tx-grouping for
   * unshielded spends. When they agree, the gap is closed and this method
   * replaces the other.
   */
  settledLedger(): Map<string, { count: number; byColor: Record<string, bigint> }> {
    return this.aggregate(true);
  }

  /**
   * Whether an offer is a single sealed swap — one give colour, one want
   * colour — and therefore a price observation at all.
   *
   * A basket (A+B for C+D) is accepted and tracked, but contributes nothing to
   * charts, stats, pair_stats or open_count (§2.5). It has no per-pair price to
   * contribute: nobody agreed that A alone is worth C alone. Every offer this
   * suite builds is single-swap, so this is a contract statement rather than a
   * live filter — until a basket fixture exists.
   */
  isSingleSwap(o: OfferRecord): boolean {
    return o.giveToken !== undefined && o.wantToken !== undefined;
  }

  private aggregate(settledOnly: boolean): Map<string, { count: number; byColor: Record<string, bigint> }> {
    const m = new Map<string, { count: number; byColor: Record<string, bigint> }>();
    for (const o of this.offers) {
      if (o.state !== "resolved") continue;
      // Settled offers are fills. So — on the UNSHIELDED layer only — are
      // CANCELLED ones, and that is the §2.1 defect, not an oracle fudge:
      // unshielded spends are not tx-grouped, so a cancel is indistinguishable
      // from a fill, reads `consumed`, and lands in chart/volume data.
      //
      // Modelled HERE so the per-pair chart checks keep asserting current
      // behaviour precisely; settledLedger() below asserts the truth. PR-B
      // deletes this branch and the two collapse into one.
      //
      // Measured on pair UA|UB: api reported 6 rows against 4 settled offers,
      // and the two extras were the run's two unshielded cancels — base short
      // by 2500 = 1000+1500 (their gives), quote by 3720 = 2227+1493 (their
      // wants). Exact, to the unit.
      //
      // Shielded cancels are correctly excluded by fill markers, so counting
      // them here would break the pairs that currently agree.
      // Both layers, one rule, since PR-B gave the unshielded path the same
      // evidence the shielded path had. `settledOnly` is retained only so the
      // two call sites keep their distinct names while they converge.
      const countsAsFill = o.fate === "settled";
      if (!countsAsFill) continue;
      const give = this.colors[o.giveToken]!;
      const want = this.colors[o.wantToken]!;
      const key = [give, want].sort().join("|");
      const cur = m.get(key) ?? { count: 0, byColor: {} };
      cur.count++;
      cur.byColor[give] = (cur.byColor[give] ?? 0n) + BigInt(o.giveAmount);
      cur.byColor[want] = (cur.byColor[want] ?? 0n) + BigInt(o.wantAmount);
      m.set(key, cur);
    }
    return m;
  }

  persist(): void {
    writeOut(
      "ledger.json",
      JSON.stringify(
        {
          suiteStartedAt: this.suiteStartedAt,
          colors: this.colors,
          apiOnlyTokenColors: this.apiOnlyTokenColors,
          offers: this.offers,
          garbage: this.garbage,
        },
        (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
  }
}

export const ledger = new Ledger();
