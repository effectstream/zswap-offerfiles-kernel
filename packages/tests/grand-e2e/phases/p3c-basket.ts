// Phase 3c — §2.5: a basket offer is ACCEPTED but contributes no market data.
//
// A basket gives more than one colour on a side. It is a legitimate sealed
// settlement — the parties agreed that TA + TC together are worth TB — but it
// is NOT a price observation, because nobody agreed what TA alone is worth in
// TB. Splitting it into per-pair prices invents agreements never made.
//
// Measured before it was ruled: one 2x2 basket rendered as FOUR trades at four
// different prices on four pairs, with every leg's volume double-counted, and
// /v1/pairs manufactured four markets with open counts
// (packages/database/multileg-pairs.test.ts prints the whole thing).
//
// This phase asserts BOTH halves of the ruling against a running stack:
//
//   ACCEPT  — indexed, served on /v1/offers, settleable, archives CONSUMED.
//   EXCLUDE — invisible on every market surface, before AND after settlement:
//             /v1/chart/history, /v1/chart/stats, pair_stats, the open-book
//             mid, and /v1/pairs (both the rows it manufactures and the
//             open_count it contributes).
//
// The acceptance half is not a formality. Every exclusion assertion here would
// also pass if the filter simply broke the five queries, or if the basket were
// rejected at ingestion. Only "accepted AND invisible" distinguishes the
// ruling from either failure.

import type { Client } from "pg";
import { ledger } from "../ledger.ts";
import {
  BASKET_GIVE_TA,
  BASKET_GIVE_TC,
  buildBasketOffer,
  settleOffer,
  storeBlob,
  type Actors,
} from "../actors/wallets.ts";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
import { ARCHIVE_WAIT_TRIES, INDEX_WAIT_TRIES } from "../config.ts";
import { getChartHistory, getChartStats, getPairs, submitOffer2 } from "../lib/api2.ts";
import { historyRowByHash, legsFor, offerRowByHash } from "../lib/db2.ts";
import { beginPhase, check, note, waitUntil } from "../lib/util.ts";

/** Every pair the basket's colours could be read as a market on. */
function basketPairs(gives: string[], wants: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const g of gives) for (const w of wants) out.push([g, w]);
  // Give-vs-give is the pairing a naive self-join also manufactures.
  for (let i = 0; i < gives.length; i++) {
    for (let j = i + 1; j < gives.length; j++) out.push([gives[i]!, gives[j]!]);
  }
  return out;
}

export async function p3cBasket(db: Client, actors: Actors): Promise<void> {
  beginPhase("p3c-basket");

  const built = await buildBasketOffer(actors.basketMaker);
  if ("skipped" in built) {
    note(
      "basket fixture",
      `not built (${built.skipped}) — §2.5 is UNTESTED against a running stack this run. ` +
        "If the reason is that the merge netted the legs back to one colour a side, the " +
        "third-colour construction needs re-checking; the unit coverage in " +
        "packages/database/multileg-pairs.test.ts still holds.",
    );
    return;
  }

  const { blob, gives, wants } = built;
  const hash = offerHashFromBlob(blob);
  const pairs = basketPairs(gives, wants);
  // TC is the clean discriminator: nothing else in the run touches it, so any
  // TC-bearing market surface is unambiguously the basket leaking.
  const tc = ledger.colors.TC!;
  note(
    "basket fixture",
    `gives ${gives.length} colours, wants ${wants.length} — ${pairs.length} pairs a ` +
      `naive market query would manufacture from ONE offer`,
  );

  // Registered in the ledger BEFORE publishing. p7b's live-set audit treats
  // any offer_file row it does not recognise as a stray, so an unregistered
  // fixture fails an unrelated check with a confusing message. `basket: true`
  // is what keeps the ledger's own chart oracle from expecting a per-pair
  // price for it — see isSingleSwap.
  const rec = ledger.addOffer({
    index: -1,
    fate: "settled",
    layer: "ss",
    makerSeed: actors.basketMaker.seed,
    giveToken: "TA",
    wantToken: "TB",
    giveAmount: String(BASKET_GIVE_TA),
    wantAmount: "421",
    publishPath: "api",
    phase: "p3c-basket",
    state: "planned",
    basket: true,
    offerHash: hash,
    hasFillMarkers: true, // the want leg (TB) is shielded
  });

  // open_count per pair BEFORE the basket exists. The basket's pairs include
  // TA|TB, a market this suite trades all run, so "no basket open_count" can
  // only be measured as a DELTA — an absolute zero is unsatisfiable and is
  // exactly how this check failed on the first full run against main.
  const openBefore = new Map<string, number>();
  {
    const r0 = await getPairs();
    if (r0.status === 200) {
      for (const p of (r0.body as any[]) ?? []) {
        openBefore.set(String(p.pair_key), Number(p.open_count ?? 0));
      }
    }
  }

  // ── ACCEPT: it is a real offer, indexed like any other ────────────────────
  const res = await submitOffer2(blob);
  await check(
    "a basket offer is ACCEPTED at submit (not rejected as malformed)",
    async () => res.status === 200 || res.status === 202,
    `got ${res.status} ${res.body?.error ?? ""}`,
  );
  storeBlob(hash, blob);

  const indexed = await waitUntil(
    "basket indexed",
    async () => (await offerRowByHash(db, hash)) != null,
    INDEX_WAIT_TRIES,
    5000,
  );
  await check("the basket is indexed and served on the live book", async () => indexed);
  if (!indexed) {
    ledger.markCasualty(rec, "basket never indexed");
    return;
  }
  rec.state = "indexed";
  rec.indexedAt = Date.now();

  const row = (await offerRowByHash(db, hash))!;
  rec.rowId = row.id;
  await check(
    "all of the basket's legs are stored — nothing was silently dropped",
    async () => {
      const legs = await legsFor(db, row.id, true);
      return legs.length === gives.length + wants.length;
    },
  );

  // ── EXCLUDE: invisible to market data while OPEN ──────────────────────────
  await check("an open basket raises no pair's open_count", async () => {
    const r = await getPairs();
    if (r.status !== 200) return false;
    for (const p of (r.body as any[]) ?? []) {
      const key = String(p.pair_key);
      if (Number(p.open_count ?? 0) > (openBefore.get(key) ?? 0)) return false;
    }
    return true;
  }, `before=${JSON.stringify([...openBefore])}`);

  await check("an open basket manufactures no /v1/pairs markets", async () => {
    const r = await getPairs();
    if (r.status !== 200) return false;
    const keys = new Set(pairs.map(([a, b]) => [a, b].sort().join("|")));
    // A pair that ALSO trades outside the basket may legitimately exist —
    // TA|TB is a real market this suite trades all run. Only pairs unique to
    // the basket (anything involving TC) must be absent entirely.
    return !(r.body as any[]).some((p) => keys.has(String(p.pair_key)) && String(p.pair_key).includes(tc));
  });

  // ── Settle it. A basket that cannot settle is not "accepted" ──────────────
  let settled = true;
  try {
    // A synthetic record: settleOffer only reads the layer of each side, and
    // both are shielded here.
    await settleOffer(actors.takers[0]!, { index: -1, giveToken: "TA", wantToken: "TB" } as any, blob);
  } catch (e) {
    settled = false;
    note("basket settle", `failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await check("a basket offer can actually be SETTLED (the accept half)", async () => settled);

  if (settled) {
    const archived = await waitUntil(
      "basket archived",
      async () => (await historyRowByHash(db, hash))?.archive_reason === "CONSUMED",
      ARCHIVE_WAIT_TRIES,
      5000,
    );
    await check(
      "the settled basket archives CONSUMED — tracked through its full lifecycle",
      async () => archived,
      `archive_reason=${(await historyRowByHash(db, hash))?.archive_reason ?? "(no row)"}`,
    );
    if (archived) {
      rec.state = "resolved";
      rec.resolvedAt = Date.now();
    }
  } else {
    // It never settled, so it will die by TTL. Recording that keeps the
    // live-set audit's expectations honest instead of leaving a resolved-
    // looking record behind.
    rec.fate = "expired";
  }

  // ── EXCLUDE: still invisible AFTER settlement ─────────────────────────────
  // This is the half that matters most: a settled basket is exactly what used
  // to become four fabricated trades.
  // Chart rows carry no offer id, so "did THIS settlement print?" is answered
  // by SIZE. The basket's legs are 337 TA and 293 TC, both below the run's
  // GIVE_MIN of 500, so no ordinary offer can produce a print of that size —
  // on TA/TB, a pair the suite trades all run, that is the only way to ask the
  // question without requiring the pair to be empty.
  const sizes = [Number(BASKET_GIVE_TA), Number(BASKET_GIVE_TC)];
  for (const [base, quote] of pairs) {
    const label = `${base.slice(0, 6)}/${quote.slice(0, 6)}`;
    const r = await getChartHistory(base, quote);
    const rows = ((r.body as any[]) ?? []);
    await check(
      `settled basket prints no trade on ${label}`,
      async () => {
        if (r.status !== 200) return false;
        // Any print at all on a TC pair is the basket — nothing else in the
        // run touches TC. Elsewhere, only a print at one of its own sizes.
        if (base === tc || quote === tc) return rows.length === 0;
        return !rows.some((t: any) => sizes.includes(Number(t.amt)));
      },
      `status=${r.status} rows=${JSON.stringify(rows.slice(0, 3))}`,
    );
  }

  await check("the settled basket contributes no pair_stats row for its own pairs", async () => {
    const q = await db.query(`SELECT pair_key FROM pair_stats WHERE pair_key LIKE $1`, [`%${tc}%`]);
    return q.rows.length === 0;
  });

  await check("the settled basket sets no last_price on a TC pair", async () => {
    for (const [base, quote] of pairs) {
      if (base !== tc && quote !== tc) continue;
      const r = await getChartStats(base, quote);
      if (r.status !== 200) return false;
      if ((r.body as any)?.last) return false;
    }
    return true;
  });

  await check("the settled basket adds no /v1/pairs market on any TC pair", async () => {
    const r = await getPairs();
    if (r.status !== 200) return false;
    return !(r.body as any[]).some((p) => String(p.pair_key).includes(tc));
  });
}
