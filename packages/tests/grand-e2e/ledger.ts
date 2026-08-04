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

  /** Settled offers grouped per (giveColor, wantColor) with summed amounts —
   *  the chart-volume oracle. */
  fillLedger(): Map<string, { count: number; give: bigint; want: bigint }> {
    const m = new Map<string, { count: number; give: bigint; want: bigint }>();
    for (const o of this.offers) {
      if (o.fate !== "settled" || o.state !== "resolved") continue;
      const key = `${this.colors[o.giveToken]}|${this.colors[o.wantToken]}`;
      const cur = m.get(key) ?? { count: 0, give: 0n, want: 0n };
      cur.count++;
      cur.give += BigInt(o.giveAmount);
      cur.want += BigInt(o.wantAmount);
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
