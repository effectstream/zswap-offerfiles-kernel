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
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
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
  type BuiltOffer,
  type PoolWallet,
} from "../actors/wallets.ts";
import { getChartHistory, getOfferStatus, submitOffer2 } from "../lib/api2.ts";
import { submitBlobRaw } from "../lib/celestia.ts";
import { historyRowByHash, offerRowByHash, rejectionTotalsByCode } from "../lib/db2.ts";
import { beginPhase, check, note, waitUntil } from "../lib/util.ts";

/** How many competitors share one coin. A maker laddering the same coin at
 *  several prices is the NORMAL pattern, not an edge case — two proved only
 *  that the winner beats *a* loser, never that accepting one disables ALL the
 *  others. */
const COMPETITORS = 3;

interface Competitors {
  winner: OfferRecord;
  losers: OfferRecord[];
  winnerBlob: string;
  /** Built from the same coin but NEVER published — submitted only AFTER the
   *  winner settles, so the liveness gate is the only thing that can refuse
   *  it. Detached from the ledger: it is adversarial input, not an offer. */
  heldBack: { rec: OfferRecord; blob: string } | null;
}

/** Build N+1 offers from ONE coin. The wallet reserves an input as soon as a
 *  recipe is finalized, so each offer must be reverted before the next can
 *  select the same coin — revert releases the reservation without
 *  invalidating the already-serialized bytes. */
async function buildCompetingSet(
  db: Client,
  pw: PoolWallet,
  shielded: boolean,
  idxBase: number,
): Promise<Competitors | null> {
  const give = shielded ? ("TA" as const) : ("UA" as const);
  const want = shielded ? ("TB" as const) : ("UB" as const);
  const layer = shielded ? ("ss" as const) : ("uu" as const);

  // Same give coin, different asks — genuinely different offers that happen to
  // be funded by one input. The ask varies by +7·i so no two are byte-identical
  // (a byte-identical sibling is content-hash dedup, a different test).
  const mkFields = (index: number, fate: OfferRecord["fate"], bump: bigint, path: "api" | "celestia") => ({
    index,
    fate,
    layer,
    makerSeed: pw.seed,
    giveToken: give,
    wantToken: want,
    giveAmount: COMPETING_COIN.toString(),
    wantAmount: (amountsFor(idxBase, give, want).want + bump).toString(),
    publishPath: path,
    phase: "p3b" as const,
    state: "planned" as const,
  });

  const built: { rec: OfferRecord; b: BuiltOffer }[] = [];
  for (let i = 0; i <= COMPETITORS; i++) {
    // Competitor 1 publishes via raw blob.Submit so the STM's own dedup and
    // liveness ordering decides, not the API's — the two doors are different
    // code paths and only one of them can be bypassed by an attacker.
    const path = i === 1 ? ("celestia" as const) : ("api" as const);
    const fate: OfferRecord["fate"] = i === 0 ? "settled" : "cancelled";
    const fields = mkFields(idxBase + i, fate, BigInt(7 * i), path);
    // The last one is held back and never published — keep it OUT of the
    // ledger so it is not counted as an unresolved offer.
    const rec: OfferRecord = i === COMPETITORS ? { ...fields } : ledger.addOffer({ ...fields });
    const b = await buildOffer(pw, rec);
    storeBlob(b.hash, b.blob);
    await pw.run(async () => {
      await (pw.wr.wallet as any).revert(b.finalized);
    });
    built.push({ rec, b });
  }

  const published = built.slice(0, COMPETITORS);
  for (const { rec, b } of published) {
    if (!(await publishAndIndex(db, rec, b))) {
      note("competing", `publish failed for #${rec.index} — skipping this set`);
      return null;
    }
  }

  const held = built[COMPETITORS]!;
  return {
    winner: published[0]!.rec,
    losers: published.slice(1).map((p) => p.rec),
    winnerBlob: published[0]!.b.blob,
    heldBack: { rec: held.rec, blob: held.b.blob },
  };
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
    const set = await buildCompetingSet(db, pw, shielded, idxBase);
    if (!set) continue;
    const { winner, losers, winnerBlob, heldBack } = set;
    const loser = losers[0]!; // the one the marker diagnostics report on

    await check(`${label}: all ${COMPETITORS} offers indexed and share one input`, async () => {
      for (const l of losers) if (!(await sharesInput(db, winner, l, shielded))) return false;
      return true;
    });

    // Settle exactly ONE of them.
    const taker = actors.takers[shielded ? 3 : 4]!;
    const settled = await check(`${label}: taker settled the winner`, async () => {
      await settleOffer(taker, winner, winnerBlob);
      return true;
    });
    if (!settled) continue;

    // "Accepting one disables the others" — ALL of them, not just one. A maker
    // laddering a coin at several prices is the normal case, and a taker who
    // acts on any surviving sibling burns fees on an unfillable offer.
    await check(`${label}: ALL ${COMPETITORS} offers archived (one input, mutually exclusive)`, async () =>
      waitUntil(
        "all archived",
        async () => {
          for (const o of [winner, ...losers]) {
            if ((await offerRowByHash(db, o.offerHash!)) !== null) return false;
          }
          return true;
        },
        ARCHIVE_WAIT_TRIES,
        5000,
      ),
    );
    for (const o of [winner, ...losers]) {
      o.state = "resolved";
      o.resolvedAt = Date.now();
    }

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
        for (const l of losers) {
          const s = await getOfferStatus(l.offerHash!);
          if (s.body?.status !== "cancelled") return false;
        }
        return true;
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

    // (C) A competitor that arrives AFTER the coin is gone.
    //
    // This is the only fixture in the suite where LIVENESS is provably the
    // thing that rejects. p4's replay fixture re-submits the SAME offer, so
    // content dedup fires first and its expectedCodes has to accept three
    // different answers — the liveness gate is never proven to be what did the
    // rejecting. A *different* offer over the same spent coin has no dedup
    // match, so nothing but liveness can stop it.
    if (heldBack) {
      const expected = shielded ? "NULLIFIER_SPENT" : "UTXO_NOT_LIVE";
      const res = await submitOffer2(heldBack.blob);
      ledger.addGarbage({
        kind: `api:post-settlement-${shielded ? "shielded" : "unshielded"}`,
        via: "api",
        expectedCodes: [expected],
        offerHash: offerHashFromBlob(heldBack.blob),
        at: Date.now(),
        gotCode: res.body?.error,
        gotStatus: res.status,
      });
      await check(
        `${label}: a NEW offer over the spent coin is refused ${expected} at the API`,
        async () => res.status === 400 && res.body?.error === expected,
        `got ${res.status} ${res.body?.error}`,
      );

      // …and at the door that cannot be bypassed. The API can be skipped
      // entirely by posting to the namespace, so the STM must refuse it too —
      // with the same code, recorded in offer_rejections.
      const before = await rejectionTotalsByCode(db);
      const height = await submitBlobRaw(OfferFiles.decode(heldBack.blob));
      ledger.addGarbage({
        kind: `celestia:post-settlement-${shielded ? "shielded" : "unshielded"}`,
        via: "celestia",
        expectedCodes: [expected],
        offerHash: offerHashFromBlob(heldBack.blob),
        celestiaHeight: height,
        at: Date.now(),
      });
      await check(
        `${label}: the same offer is refused ${expected} at the Celestia door`,
        async () =>
          waitUntil(
            "rejection recorded",
            async () => {
              const now = await rejectionTotalsByCode(db);
              return (now[expected] ?? 0) > (before[expected] ?? 0);
            },
            24,
            5000,
          ),
      );
      await check(
        `${label}: the post-settlement offer was never indexed`,
        async () => (await offerRowByHash(db, offerHashFromBlob(heldBack.blob))) === null,
      );
    }
  }
}
