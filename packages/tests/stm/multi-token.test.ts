// Multi-give / multi-want swap folded into Phase B.
// P0 give {T0,T1} / want T2; P1 give T2 / want {T0,T1} → merge + batcher settle.

import type { Client } from "pg";
import { assert } from "../helpers.ts";
import {
  count,
  nullifiersGrew,
  offerArchivedConsumed,
  offersGone,
  waitFor,
} from "../lib/db.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { joinOfferFiles, mintShielded } from "../lib/offer-files.ts";
import {
  buildWallet,
  shieldedKeys,
  transferShielded,
  waitForShielded,
  waitForSync,
  waitForWalletSettlement,
} from "../lib/wallet.ts";
import {
  describeImbalances,
  mergeFinalized,
  settleViaBatcher,
} from "../lib/batcher.ts";
import { submitOffer } from "../lib/api.ts";

globalThis.WebSocket = WebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = "[multi-token]";
const SEP = { T0: 0x80, T1: 0x81, T2: 0x82 } as const;
const MINT_AMOUNT = 1_000_000_000n;
const FUND = 5_000_000n;
const A0 = 1_000n;
const A1 = 1_000n;
const A2 = 2_000n;
const P0_SEED = "0000000000000000000000000000000000000000000000000000000000000010";
const P1_SEED = "0000000000000000000000000000000000000000000000000000000000000011";

export async function multiTokenTest(db: Client): Promise<void> {
  setNetworkId(net.id as any);

  async function submitIndexed(blob: string, label: string): Promise<void> {
    let sub = await submitOffer(blob);
    for (let r = 0; r < 24 && sub.status === 400 && sub.body?.error === "ROOT_UNKNOWN"; r++) {
      await sleep(5000);
      sub = await submitOffer(blob);
    }
    await assert(`${label} accepted by submit gate`, async () => sub.status === 200);
  }

  const before = {
    nullifiers: await count(db, "nullifiers"),
    offers: await count(db, "offer_file"),
  };
  console.log(`${TAG} before:`, JSON.stringify(before));

  console.log(`${TAG} building genesis + P0 + P1…`);
  const genesis = await buildWallet(net.walletSeed);
  const p0 = await buildWallet(P0_SEED);
  const p1 = await buildWallet(P1_SEED);

  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    try {
      await registerNightForDust(genesis as any);
    } catch (e) {
      console.warn(
        `${TAG} registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }

    const p0Addr = await p0.wallet.shielded.getAddress();
    const p1Addr = await p1.wallet.shielded.getAddress();

    console.log(`${TAG} minting T0,T1,T2…`);
    const deployed = await joinOfferFiles(genesis);
    const nonce = BigInt(Date.now());
    // Serial mints on ONE facade: each mint is a prove+submit, and reusing the
    // facade before it replays its own submission is the rc.4 error-170
    // (InvalidDustSpendProof) trap — gate between them (see waitForWalletSettlement).
    const T0 = await mintShielded(deployed, SEP.T0, MINT_AMOUNT, nonce);
    await waitForWalletSettlement(genesis, { label: `${TAG} post-mint-T0` });
    const T1 = await mintShielded(deployed, SEP.T1, MINT_AMOUNT, nonce + 1n);
    await waitForWalletSettlement(genesis, { label: `${TAG} post-mint-T1` });
    const T2 = await mintShielded(deployed, SEP.T2, MINT_AMOUNT, nonce + 2n);
    await waitForWalletSettlement(genesis, { label: `${TAG} post-mint-T2` });
    await assert("T0,T1,T2 minted", async () => !!T0 && !!T1 && !!T2);

    for (const [color, label] of [[T0, "T0"], [T1, "T1"], [T2, "T2"]] as const) {
      if ((await waitForShielded(genesis, color, FUND, 24)) < FUND)
        throw new Error(`genesis missing ${label}`);
    }
    await transferShielded(genesis, T0, FUND, p0Addr);
    await transferShielded(genesis, T1, FUND, p0Addr);
    await transferShielded(genesis, T2, FUND, p1Addr);
    const p0Funded =
      (await waitForShielded(p0, T0, A0, 36)) >= A0 &&
      (await waitForShielded(p0, T1, A1, 12)) >= A1;
    const p1Funded = (await waitForShielded(p1, T2, A2, 36)) >= A2;
    await assert("P0 funded with {T0,T1}", async () => p0Funded);
    await assert("P1 funded with {T2}", async () => p1Funded);

    const r0 = await p0.wallet.initSwap(
      { shielded: { [T0]: A0, [T1]: A1 } },
      [{ type: "shielded", outputs: [{ type: T2, amount: A2, receiverAddress: p0Addr }] } as any],
      shieldedKeys(p0),
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const offer0 = await p0.wallet.finalizeTransaction(r0.transaction);

    const r1 = await p1.wallet.initSwap(
      { shielded: { [T2]: A2 } },
      [
        {
          type: "shielded",
          outputs: [
            { type: T0, amount: A0, receiverAddress: p1Addr },
            { type: T1, amount: A1, receiverAddress: p1Addr },
          ],
        } as any,
      ],
      shieldedKeys(p1),
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const offer1 = await p1.wallet.finalizeTransaction(r1.transaction);

    await submitIndexed(OfferFiles.encode(offer0.serialize()), "P0 multi-give");
    await submitIndexed(OfferFiles.encode(offer1.serialize()), "P1 multi-want");

    const indexedOk = await waitFor(
      "2 multi-token offers indexed",
      async () => (await count(db, "offer_file")) >= before.offers + 2,
      24,
    );
    await assert("2 multi-token offers indexed", async () => indexedOk);

    const ids = (
      await db.query<{ id: number }>(
        `SELECT id FROM offer_file ORDER BY id DESC LIMIT 2`,
      )
    ).rows.map((r) => r.id);

    console.log(`${TAG} merging multi-give + multi-want…`);
    const merged = mergeFinalized([offer0, offer1]);
    console.log(`${TAG} merged imbalances: ${describeImbalances(merged)}`);
    const settle = await settleViaBatcher(merged);
    await assert("batcher settled multi-token tx", async () => settle.ok);

    const spentOk = await waitFor(
      "nullifiers += 2",
      async () => nullifiersGrew(db, before.nullifiers, 2),
      36,
    );
    await assert("nullifiers grew by 2", async () => spentOk);

    const archivedOk = await waitFor(
      "offers archived",
      async () => offersGone(db, ids),
      24,
    );
    await assert("both offers ARCHIVED", async () => archivedOk);

    for (const id of ids) {
      const ok = await waitFor(
        `offer ${id} CONSUMED`,
        async () => offerArchivedConsumed(db, id),
        12,
      );
      await assert(`offer ${id} archive_reason=CONSUMED`, async () => ok);
    }

    await assert(
      "P0 received T2",
      async () => (await waitForShielded(p0, T2, A2, 24)) >= A2,
    );
    await assert(
      "P1 received T0 + T1",
      async () =>
        (await waitForShielded(p1, T0, A0, 24)) >= A0 &&
        (await waitForShielded(p1, T1, A1, 12)) >= A1,
    );
  } finally {
    await p0.wallet.stop().catch(() => {});
    await p1.wallet.stop().catch(() => {});
    await genesis.wallet.stop().catch(() => {});
  }
}
