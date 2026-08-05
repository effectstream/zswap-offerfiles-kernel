// Phase 3b — competing offers backed by the SAME input.
//
// (A) Two offers spend one coin/UTXO, so they are mutually exclusive: the
//     schema anticipates this ("a single shielded coin can back multiple
//     competing offers … the first one to land wins").
// (B) Settle exactly one. The settled offer must read `consumed` and appear in
//     trade history; the loser must read `cancelled` — it can never settle,
//     because its only input is gone.
//
// This is the hardest case for fill-vs-cancel classification, because BOTH
// offers archive on the very same nullifier event and are therefore
// indistinguishable by nullifiers alone. Only the fill markers separate them:
// the settling transaction created the winner's output commitments and not the
// loser's.
//
// ORDERING RISK being probed. Nullifier and commitment arrive as separate
// inputs of the `Midnight:NullifierAndCommitment` primitive. If the nullifier
// is processed before its sibling commitments, an archive-time rule would
// misclassify. The design's answer is that classification is READ-time and the
// whole block commits in one DB transaction, so a reader never observes the
// partial state. That holds only while both land in the SAME effectstream
// block — if commitments trail into a later block there is a window where the
// winner reads `cancelled`. That is exactly what this phase measures: on
// failure it reports whether the markers were present, so the fix (a scheduled
// re-check in the next block) can be opened against evidence rather than
// suspicion.

import type { Client } from "pg";
import { ARCHIVE_WAIT_TRIES } from "../config.ts";
import { ledger, type OfferRecord } from "../ledger.ts";
import {
  COMPETING_COIN,
  amountsFor,
  buildOffer,
  publishAndIndex,
  settleOffer,
  storeBlob,
  type Actors,
  type PoolWallet,
} from "../actors/wallets.ts";
import { getChartHistory, getOfferStatus } from "../lib/api2.ts";
import { historyRowByHash, offerRowByHash } from "../lib/db2.ts";
import { beginPhase, check, note, waitUntil } from "../lib/util.ts";

interface Competitors {
  winner: OfferRecord;
  loser: OfferRecord;
  winnerBlob: string;
}

/** Build two offers from ONE coin. The wallet reserves an input as soon as a
 *  recipe is finalized, so the first offer must be reverted before the second
 *  can select the same coin — revert releases the reservation without
 *  invalidating the already-serialized bytes. */
async function buildCompetingPair(
  db: Client,
  pw: PoolWallet,
  shielded: boolean,
  idxBase: number,
): Promise<Competitors | null> {
  const give = shielded ? ("TA" as const) : ("UA" as const);
  const wantA = shielded ? ("TB" as const) : ("UB" as const);
  // Same give coin, DIFFERENT wants — two genuinely different offers that
  // happen to be funded by one input.
  const mk = (index: number, want: typeof wantA, fate: OfferRecord["fate"]): OfferRecord =>
    ledger.addOffer({
      index,
      fate,
      layer: shielded ? "ss" : "uu",
      makerSeed: pw.seed,
      giveToken: give,
      wantToken: want,
      giveAmount: COMPETING_COIN.toString(),
      wantAmount: amountsFor(index, give, want).want.toString(),
      publishPath: "api",
      phase: "p3b",
      state: "planned",
    });

  const winner = mk(idxBase, wantA, "settled");
  const builtWinner = await buildOffer(pw, winner);
  storeBlob(builtWinner.hash, builtWinner.blob);
  // Release the coin so the second offer selects the SAME input.
  await pw.run(async () => {
    await (pw.wr.wallet as any).revert(builtWinner.finalized);
  });

  const loser = mk(idxBase + 1, wantA, "cancelled");
  // Vary the ask so the two offers are not byte-identical (a duplicate would
  // be rejected by content-hash dedup, which is a different test).
  loser.wantAmount = (BigInt(loser.wantAmount) + 7n).toString();
  const builtLoser = await buildOffer(pw, loser);
  storeBlob(builtLoser.hash, builtLoser.blob);
  await pw.run(async () => {
    await (pw.wr.wallet as any).revert(builtLoser.finalized);
  });

  const okW = await publishAndIndex(db, winner, builtWinner);
  const okL = await publishAndIndex(db, loser, builtLoser);
  if (!okW || !okL) {
    note("competing", `publish failed (winner=${okW} loser=${okL}) — skipping this pair`);
    return null;
  }
  return { winner, loser, winnerBlob: builtWinner.blob };
}

/** Do the two offers really share an input? If not, the test proves nothing. */
async function sharesInput(db: Client, a: OfferRecord, b: OfferRecord, shielded: boolean): Promise<boolean> {
  const q = shielded
    ? `SELECT nullifier AS k FROM offer_file_nullifiers WHERE offer_file_id = $1`
    : `SELECT owner||'|'||intent_hash||'|'||output_no AS k FROM offer_file_unshielded_spends WHERE offer_file_id = $1`;
  const ka = (await db.query(q, [a.rowId])).rows.map((r: any) => r.k);
  const kb = (await db.query(q, [b.rowId])).rows.map((r: any) => r.k);
  return ka.length > 0 && ka.some((k: string) => kb.includes(k));
}

export async function p3bCompeting(db: Client, actors: Actors): Promise<void> {
  beginPhase("p3b-competing");

  for (const [label, pw, shielded, idxBase] of [
    ["shielded", actors.competingShielded, true, 20],
    ["unshielded", actors.competingUnshielded, false, 30],
  ] as const) {
    const pair = await buildCompetingPair(db, pw, shielded, idxBase);
    if (!pair) continue;
    const { winner, loser, winnerBlob } = pair;

    await check(`${label}: both offers indexed and share one input`, async () =>
      sharesInput(db, winner, loser, shielded),
    );

    // Settle exactly ONE of them.
    const taker = actors.takers[shielded ? 3 : 4]!;
    const settled = await check(`${label}: taker settled the winner`, async () => {
      await settleOffer(taker, winner, winnerBlob);
      return true;
    });
    if (!settled) continue;

    await check(`${label}: BOTH offers archived (one input, both mutually exclusive)`, async () =>
      waitUntil(
        "both archived",
        async () =>
          (await offerRowByHash(db, winner.offerHash!)) === null &&
          (await offerRowByHash(db, loser.offerHash!)) === null,
        ARCHIVE_WAIT_TRIES,
        5000,
      ),
    );
    winner.state = "resolved";
    winner.resolvedAt = Date.now();
    loser.state = "resolved";
    loser.resolvedAt = Date.now();

    await check(`${label}: winner reads consumed`, async () => {
      const s = await getOfferStatus(winner.offerHash!);
      return s.body?.status === "consumed";
    });

    {
      // The real assertion: the loser must be distinguished from the winner
      // using ONLY the fill markers, since both consume the same input.
      //
      // Asserted for BOTH layers. On the unshielded layer it is a registered
      // red (RED-2, PR-B): midnight-unshielded-spend discards the txHash the
      // primitive already supplies, so unshielded spends cannot be tx-grouped
      // and the loser is indistinguishable from the winner. That is not a
      // limitation to assert as behaviour — it lets anyone mint volume on any
      // unshielded pair for the price of a self-transfer (§2.1).
      const ok = await check(`${label}: loser reads cancelled (fill markers separate them)`, async () => {
        const s = await getOfferStatus(loser.offerHash!);
        return s.body?.status === "cancelled";
      });
      if (!ok && shielded) {
        // Diagnose rather than just fail: was it the ordering risk?
        const st = (await getOfferStatus(loser.offerHash!)).body?.status;
        const markers = await db.query(
          `SELECT count(*)::int AS n FROM offer_file_commitments_history WHERE offer_file_id = $1`,
          [loser.rowId],
        );
        const winnerMarkers = await db.query(
          `SELECT count(*)::int AS n FROM offer_file_commitments_history WHERE offer_file_id = $1`,
          [winner.rowId],
        );
        const onChain = await db.query(
          `SELECT count(*)::int AS n FROM commitments c
           JOIN offer_file_commitments_history o ON o.commitment = c.commitment
           WHERE o.offer_file_id = $1`,
          [winner.rowId],
        );
        note(
          "COMPETING-OFFER MISCLASSIFICATION",
          `loser read '${st}' instead of 'cancelled'. loser markers stored=${markers.rows[0].n}, ` +
            `winner markers stored=${winnerMarkers.rows[0].n}, winner markers seen on-chain=${onChain.rows[0].n}. ` +
            `If the winner's markers are stored but NOT yet on-chain, the commitment events trailed the ` +
            `nullifier into a later block — the ordering risk. Fix: re-check classification on a scheduled ` +
            `input in the following block, once the data has settled. Open an issue with this line attached.`,
        );
      }
    }

    // (B) exactly ONE trade. The loser never traded — its input was taken by
    // the winner — so it must contribute no volume and no history row.
    //
    // On the unshielded layer this is registered red RED-3 (PR-B) and it is
    // the concrete harm behind the wrong status string: the loser is counted
    // as a fill, inflating this pair's history, volume and last price. Anyone
    // can manufacture that with a self-transfer, which is why it is asserted
    // as a defect rather than as documented behaviour.
    await check(
      `${label}: trade history counts 1 (cancel adds no volume)`,
      async () => {
        const base = ledger.colors[winner.giveToken]!;
        const quote = ledger.colors[winner.wantToken]!;
        const hist = await getChartHistory(base, quote);
        if (hist.status !== 200 || !Array.isArray(hist.body)) return false;
        const winnerAmt = Number(winner.giveAmount);
        const trades = hist.body.filter((t: any) => Number(t.amt) === winnerAmt);
        return trades.length === 1;
      },
    );

    const hist = await historyRowByHash(db, loser.offerHash!);
    note(`${label} loser`, `archive_reason=${hist?.archive_reason} (CONSUMED is expected — the read-time rule reclassifies)`);
  }
}
