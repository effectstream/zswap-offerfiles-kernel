// Phase 3 — every lifecycle transition, precisely, one at a time:
//   consumed (shielded, unshielded), all four cancel shapes, the
//   documented unshielded-only classification gap, and an expiry-fated offer
//   whose sweep is asserted at the end of phase 5.

import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";
import { ARCHIVE_WAIT_TRIES } from "../config.ts";
import { ledger, type CancelShape, type OfferRecord } from "../ledger.ts";
import {
  CANCEL_COIN,
  amountsFor,
  buildOffer,
  cancelGiveToken,
  cancelWantToken,
  makeRefill,
  makerUnshieldedKey,
  oppositeKey,
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
import { getChartHistory, getOfferByHash, getOfferStatus } from "../lib/api2.ts";
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

  // ── unshielded walk-away must classify as a CANCEL ──────────────────────
  // A maker who spends their own UTXO on themselves has not sold anything.
  // Recording it as a fill puts a trade that never happened into the chart,
  // the volume and the last price — for the cost of one self-transfer, on a
  // permissionless namespace.
  //
  // Registered red RED-1 (PR-B). The cause is not a missing capability:
  // midnight-unshielded-spend already RECEIVES the spending txHash from the
  // primitive (grammar: owner, intentHash, outputIndex, value, tokenType,
  // txHash) and discards it, so the tx-grouping that makes the shielded path
  // exact is available today. See PRODUCTION-READINESS.md §2.1.
  // All three shapes the shielded loop above covers, so the fix has to handle
  // the whole predicate and not just the single-coin walk-away:
  //   single-one-tx   — one input, spent on itself       (needs fill markers)
  //   split-two-tx    — two inputs, spent in TWO txs     (branch 2, atomicity)
  //   partial         — two inputs, only ONE ever spent  (branch 1)
  // Branches 1 and 2 do not merely misclassify on the unshielded layer today;
  // they cannot fire at all, because nothing records which transaction spent
  // an unshielded UTXO.
  {
    const GAP_COIN = 1000n;
    const shapes: { shape: CancelShape; coins: number; spends: bigint[][]; seed: string; idx: number }[] = [
      { shape: "single-one-tx", coins: 1, spends: [[GAP_COIN]], seed: "d0", idx: 16 },
      { shape: "split-two-tx", coins: 2, spends: [[GAP_COIN], [GAP_COIN]], seed: "d1", idx: 18 },
      { shape: "partial", coins: 2, spends: [[GAP_COIN]], seed: "d2", idx: 19 },
    ];
    for (const s of shapes) {
      const seed = s.seed.padStart(64, "0");
      const pw = await (async () => {
        const wr = await buildWallet(seed);
        await waitForSync(wr).catch(() => {});
        return new PW(`GAP-${s.shape}`, seed, wr, await wr.wallet.shielded.getAddress(), unshieldedAddressObj(wr));
      })();
      const total = GAP_COIN * BigInt(s.coins);
      // Separate mints so the wallet really holds `coins` distinct UTXOs — a
      // single mint of the total would be one coin and the split shapes would
      // silently degrade into the single-input case.
      await genesisPw.run(async () => {
        for (let i = 0; i < s.coins; i++) {
          await mintUnshielded(deployed, TOKEN_SEPS.UA, GAP_COIN, pw.wr.unshieldedAddress);
        }
      });
      const landed = await waitForUnshielded(pw.wr, ledger.colors.UA!, total, 36);
      if (landed < total) {
        note(`gap wallet ${s.shape}`, `funding did not land (${landed}/${total}) — skipping`);
        await pw.wr.wallet.stop().catch(() => {});
        continue;
      }
      const want = amountsFor(s.idx, "UA", "UB").want;
      const rec = mkRecord(s.idx, "cancelled", "uu", pw.seed, "UA", "UB", total, want, {
        cancelShape: s.shape,
      });
      const built = await buildOffer(pw, rec);
      storeBlob(built.hash, built.blob);
      const indexed = await publishAndIndex(db, rec, built);
      if (indexed) {
        await pw.run(async () => {
          await (pw.wr.wallet as any).revert(built.finalized);
        });
        // Maker walks away: spends the offer's UTXO input(s) on itself.
        for (const amounts of s.spends) {
          await pw.run(() =>
            selfSplit(pw, false, amounts.map((amount) => ({ color: ledger.colors.UA!, amount })), true),
          );
        }
        rec.state = "resolved";
        rec.resolvedAt = Date.now();
        await check(
          `unshielded cancel ${s.shape}: archived + status cancelled`,
          async () => {
            if (!(await waitArchived(db, built.hash))) return false;
            const st = await getOfferStatus(built.hash);
            return st.body?.status === "cancelled";
          },
        );
      }
      await pw.wr.wallet.stop().catch(() => {});
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

  // ── expiry semantics, UNSHIELDED: a genuinely different derivation ───────
  // The shielded branch above computes a root-window floor. Unshielded offers
  // have no proof root at all — they expire on `Intent.ttl`, read by
  // P2pAtomicSwaps.earliestIntentTtl and bounded on-chain by `global_ttl`.
  // Only the shielded branch has ever been asserted.
  {
    // Give the color THIS maker is actually funded with (parity rule — see
    // makerUnshieldedKey). Picking maker and color independently asks a wallet
    // to spend something it never held, which surfaces ~100 s later as an
    // opaque Wallet.InsufficientFunds from inside buildOffer's retry loop.
    const mi = 5;
    const give = makerUnshieldedKey(mi);
    const want = oppositeKey(give);
    const a = amountsFor(40, give, want);
    const rec = mkRecord(40, "expired", "uu", makers[mi]!.seed, give, want, a.give, a.want);
    const built = await buildOffer(makers[mi]!, rec);
    storeBlob(built.hash, built.blob);
    const ok = await check("unshielded expiry-fated offer indexed", () => publishAndIndex(db, rec, built));
    if (ok) {
      const intentTtl = P2pAtomicSwaps.earliestIntentTtl(OfferFiles.fromBech32(built.blob) as any);
      await check("unshielded expiresAt equals the offer's own intent TTL", async () => {
        const d = await getOfferByHash(built.hash);
        return !!intentTtl && d.body?.computed?.expiresAt === intentTtl;
      }, `intentTtl=${intentTtl}`);

      // state-machine.ts calls the OFFER_TTL_SECONDS branch "defensive only —
      // it should be unreachable for a well-formed offer", because
      // UnshieldedOffer exists only inside an Intent and Intent.ttl is
      // non-optional. Never checked. If this fails, that comment is wrong and
      // some unshielded offers are getting an invented expiry.
      await check(
        "the OFFER_TTL fallback branch is unreachable for a well-formed unshielded offer",
        async () => intentTtl !== undefined,
      );
    }
  }

  // ── maker self-fill: the exact cancel/fill boundary ──────────────────────
  // cancelledPredicate claims "a tx that recreates the exact commitments is a
  // maker self-fill: the offer's terms executed, so consumed is the right
  // answer". Identical spender, identical outputs to a walk-away — the only
  // difference is that the offer's terms actually executed. If the predicate
  // is wrong anywhere, it is wrong here, and it has never been run.
  {
    // A self-fill needs ONE wallet holding BOTH sides — the give color to make
    // the offer and the want color to settle it. Makers cannot do this: each
    // holds a single shielded color by parity, so a maker can build the offer
    // and then cannot pay for it (measured: `Insufficient funds` at the
    // balancing step). Takers are funded in all four colors, so the self-filler
    // is a taker acting as its own maker — which is what a real self-fill is.
    const selfMaker = takers[5]!;
    const give = "TA" as const;
    const want = oppositeKey(give);
    const a = amountsFor(41, give, want);
    const rec = mkRecord(41, "settled", "ss", selfMaker.seed, give, want, a.give, a.want);
    const built = await buildOffer(selfMaker, rec);
    storeBlob(built.hash, built.blob);
    const ok = await check("self-fill offer indexed", () => publishAndIndex(db, rec, built));
    if (ok) {
      // Release the give coin before self-settling.
      //
      // Every OTHER settlement in the suite is performed by a different wallet,
      // so the maker's reservation is irrelevant to it. This one is not: the
      // same wallet balances the offer it just built, and buildOffer leaves the
      // give coin reserved by the recipe. p3b and the cancel cycles both revert
      // first for exactly this reason, and revert releases the reservation
      // without invalidating the already-serialized bytes.
      //
      // Measured symptom without it: the settle timed out rather than failing
      // fast, which is a slower and less obvious signal than it deserves.
      await selfMaker.run(async () => {
        await (selfMaker.wr.wallet as any).revert(built.finalized).catch(() => {});
      });
      // The maker balances its OWN offer — it holds both colors.
      await settleAndAssert(db, selfMaker, rec, built.blob, "maker self-fill");
      await check("maker self-fill counts as a trade, not a cancel", async () => {
        const base = ledger.colors[give]!;
        const quote = ledger.colors[want]!;
        const hist = await getChartHistory(base, quote);
        if (hist.status !== 200 || !Array.isArray(hist.body)) return false;
        return hist.body.some((t: any) => Number(t.amt) === Number(rec.giveAmount));
      });
    }
  }
}
