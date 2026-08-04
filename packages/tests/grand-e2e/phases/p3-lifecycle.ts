// Phase 3 — every lifecycle transition, precisely, one at a time:
//   consumed (shielded, unshielded), all four cancel shapes, the
//   documented unshielded-only classification gap, and an expiry-fated offer
//   whose sweep is asserted at the end of phase 5.

import type { Client } from "pg";
import { ARCHIVE_WAIT_TRIES } from "../config.ts";
import { ledger, type CancelShape, type OfferRecord } from "../ledger.ts";
import {
  CANCEL_COIN,
  amountsFor,
  buildOffer,
  cancelGiveToken,
  cancelWantToken,
  makeRefill,
  publishAndIndex,
  runCancelCycle,
  selfSplit,
  settleOffer,
  storeBlob,
  type Actors,
  type PoolWallet,
} from "../actors/wallets.ts";
import { buildWallet } from "../../lib/wallet.ts";
import { unshieldedAddressObj, waitForSync, waitForUnshielded } from "../../lib/wallet.ts";
import { mintUnshielded } from "../../lib/offer-files.ts";
import { PoolWallet as PW } from "../actors/wallets.ts";
import { getOfferByHash, getOfferStatus } from "../lib/api2.ts";
import { historyRowByHash, offerRowByHash } from "../lib/db2.ts";
import { beginPhase, check, note, waitUntil } from "../lib/util.ts";
import { TOKEN_SEPS } from "../config.ts";

async function waitArchived(db: Client, hash: string): Promise<boolean> {
  return waitUntil(
    `archived ${hash.slice(0, 8)}`,
    async () => (await offerRowByHash(db, hash)) === null && (await historyRowByHash(db, hash)) !== null,
    ARCHIVE_WAIT_TRIES,
    5000,
  );
}

function mkRecord(
  index: number,
  fate: OfferRecord["fate"],
  layer: OfferRecord["layer"],
  makerSeed: string,
  giveToken: OfferRecord["giveToken"],
  wantToken: OfferRecord["wantToken"],
  give: bigint,
  want: bigint,
  extra: Partial<OfferRecord> = {},
): OfferRecord {
  return ledger.addOffer({
    index,
    fate,
    layer,
    makerSeed,
    giveToken,
    wantToken,
    giveAmount: give.toString(),
    wantAmount: want.toString(),
    publishPath: "api",
    phase: "p3",
    state: "planned",
    ...extra,
  });
}

async function settleAndAssert(db: Client, taker: PoolWallet, rec: OfferRecord, blob: string, label: string) {
  await check(`${label}: settled + archived CONSUMED + status consumed`, async () => {
    await settleOffer(taker, rec, blob);
    if (!(await waitArchived(db, rec.offerHash!))) return false;
    const hist = await historyRowByHash(db, rec.offerHash!);
    if (hist?.archive_reason !== "CONSUMED") return false;
    const s = await getOfferStatus(rec.offerHash!);
    if (s.body?.status !== "consumed") return false;
    rec.state = "resolved";
    rec.resolvedAt = Date.now();
    return true;
  });
}

export async function p3Lifecycle(db: Client, actors: Actors): Promise<void> {
  beginPhase("p3-lifecycle");
  const { makers, takers, cancelSingles, cancelDoubles, genesisPw, deployed } = actors;

  // ── consumed: unshielded↔unshielded ──────────────────────────────────────
  {
    const a = amountsFor(10, "UA", "UB");
    const rec = mkRecord(10, "settled", "uu", makers[2]!.seed, "UA", "UB", a.give, a.want);
    const built = await buildOffer(makers[2]!, rec);
    storeBlob(built.hash, built.blob);
    const ok = await check("uu offer indexed", () => publishAndIndex(db, rec, built));
    if (ok && rec.state === "indexed") await settleAndAssert(db, takers[1]!, rec, built.blob, "uu swap");
  }

  // ── consumed: shielded↔shielded on the second token pair ─────────────────
  // (was a cross-layer offer; that shape is not supported — see ISSUES.md)
  {
    const a = amountsFor(11, "TB", "TA");
    const rec = mkRecord(11, "settled", "ss", makers[3]!.seed, "TB", "TA", a.give, a.want);
    const built = await buildOffer(makers[3]!, rec);
    storeBlob(built.hash, built.blob);
    const ok = await check("second-pair shielded offer indexed", () => publishAndIndex(db, rec, built));
    if (ok && rec.state === "indexed") await settleAndAssert(db, takers[2]!, rec, built.blob, "second-pair shielded swap");
  }

  // ── the four cancel shapes ───────────────────────────────────────────────
  const shapes: { shape: CancelShape; pw: PoolWallet; idx: number; kind: "single" | "double"; ki: number }[] = [
    { shape: "single-one-tx", pw: cancelSingles[0]!, idx: 12, kind: "single", ki: 0 },
    { shape: "split-two-tx", pw: cancelDoubles[0]!, idx: 13, kind: "double", ki: 0 },
    { shape: "partial", pw: cancelDoubles[0]!, idx: 14, kind: "double", ki: 0 },
    { shape: "consolidated-one-tx", pw: cancelDoubles[1]!, idx: 15, kind: "double", ki: 1 },
  ];
  for (const s of shapes) {
    const giveToken = cancelGiveToken(s.kind, s.ki);
    const wantToken = cancelWantToken(giveToken);
    const give = s.kind === "single" ? CANCEL_COIN : CANCEL_COIN * 2n;
    const want = amountsFor(s.idx, giveToken, wantToken).want;
    const rec = mkRecord(s.idx, "cancelled", "ss", s.pw.seed, giveToken, wantToken, give, want, {
      cancelShape: s.shape,
    });
    const refill = makeRefill(genesisPw, s.pw, giveToken);
    const cycled = await runCancelCycle(db, s.pw, rec, s.shape, refill);
    await check(`cancel shape ${s.shape}: archived + status cancelled`, async () => {
      if (!cycled) return false;
      if (!(await waitArchived(db, rec.offerHash!))) return false;
      const st = await getOfferStatus(rec.offerHash!);
      return st.body?.status === "cancelled";
    });
  }

  // ── documented gap: unshielded-only offers cannot classify cancelled ─────
  // Spends are not tx-grouped for unshielded inputs yet, so a maker walking
  // away reads "consumed". Assert CURRENT behavior; do not fix here.
  {
    const gapWallet = await (async () => {
      const wr = await buildWallet("d0".padStart(64, "0"));
      await waitForSync(wr).catch(() => {});
      return new PW("GAP", "d0".padStart(64, "0"), wr, await wr.wallet.shielded.getAddress(), unshieldedAddressObj(wr));
    })();
    const GAP_COIN = 1000n;
    await genesisPw.run(async () => {
      await mintUnshielded(deployed, TOKEN_SEPS.UA, GAP_COIN, gapWallet.wr.unshieldedAddress);
    });
    const landed = await waitForUnshielded(gapWallet.wr, ledger.colors.UA!, GAP_COIN, 36);
    if (landed < GAP_COIN) {
      note("gap wallet", "funding did not land — skipping gap assertion");
    } else {
      const want = amountsFor(16, "UA", "UB").want;
      const rec = mkRecord(16, "cancelled", "uu", gapWallet.seed, "UA", "UB", GAP_COIN, want, {
        cancelShape: "single-one-tx",
      });
      const built = await buildOffer(gapWallet, rec);
      storeBlob(built.hash, built.blob);
      const indexed = await publishAndIndex(db, rec, built);
      if (indexed) {
        await gapWallet.run(async () => {
          await (gapWallet.wr.wallet as any).revert(built.finalized);
        });
        // Maker walks away: spends the offer's UTXO input on itself.
        await gapWallet.run(() =>
          selfSplit(gapWallet, false, [{ color: ledger.colors.UA!, amount: GAP_COIN }], true),
        );
        rec.state = "resolved";
        rec.resolvedAt = Date.now();
        await check(
          "KNOWN GAP: unshielded-only walk-away reads consumed (not cancelled)",
          async () => {
            if (!(await waitArchived(db, built.hash))) return false;
            const st = await getOfferStatus(built.hash);
            // Documented behavior per HANDOFF §1: any spend of an
            // unshielded-only offer classifies consumed — tx grouping for
            // unshielded spends is not implemented yet.
            return st.body?.status === "consumed";
          },
        );
      }
      await gapWallet.wr.wallet.stop().catch(() => {});
    }
  }

  // ── expiry semantics: derived expiresAt is present and sane ──────────────
  {
    const a = amountsFor(17, "TA", "TB");
    const rec = mkRecord(17, "expired", "ss", makers[4]!.seed, "TA", "TB", a.give, a.want);
    const built = await buildOffer(makers[4]!, rec);
    storeBlob(built.hash, built.blob);
    const ok = await check("expiry-fated offer indexed (sweep asserted post-storm)", () =>
      publishAndIndex(db, rec, built),
    );
    if (ok) {
      await check("shielded expiresAt is a near-future timestamp (root-window floor)", async () => {
        const d = await getOfferByHash(built.hash);
        const exp = d.body?.computed?.expiresAt;
        if (!exp) return false;
        const t = Date.parse(exp);
        return t > Date.now() - 60_000 && t < Date.now() + 45 * 60_000;
      });
    }
  }
}
