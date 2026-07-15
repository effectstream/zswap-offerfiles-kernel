// Unshielded↔unshielded swap folded into Phase B.
// Maker posts give U0 / want U1; taker balances unshielded-only; batcher pays dust.
// Spend is modeled as DELETE from created_unshielded (no spent_unshielded table).

import type { Client } from "pg";
import { assert } from "../helpers.ts";
import { count, offerArchivedConsumed, waitFor } from "../lib/db.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { MidnightBech32m } from "@midnight-ntwrk/wallet-sdk-address-format";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { joinOfferFiles, mintUnshielded } from "../lib/offer-files.ts";
import {
  buildWallet,
  shieldedKeys,
  unshieldedAddressObj,
  waitForSync,
  waitForUnshielded,
} from "../lib/wallet.ts";
import {
  describeImbalances,
  nonDustImbalances,
  settleViaBatcher,
} from "../lib/batcher.ts";
import { submitOffer } from "../lib/api.ts";

globalThis.WebSocket = WebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = "[unshielded-only]";
const SEP = { U0: 0xd0, U1: 0xd1 } as const;
const MINT = 1_000_000_000n;
const AMT = 1_000n;
const M0_SEED = "0000000000000000000000000000000000000000000000000000000000000050";
const M1_SEED = "0000000000000000000000000000000000000000000000000000000000000051";

/** Canonical hex owner as stored in created_unshielded by the STM. */
const ownerHex = (mnAddr: string): string =>
  MidnightBech32m.parse(mnAddr).data.toString("hex").toLowerCase();

type MintUtxo = { owner: string; intent_hash: string; output_no: number };

async function mintUtxosGone(db: Client, refs: MintUtxo[]): Promise<boolean> {
  for (const r of refs) {
    const res = await db.query(
      `SELECT 1 FROM created_unshielded
       WHERE owner = $1 AND intent_hash = $2 AND output_no = $3`,
      [r.owner, r.intent_hash, r.output_no],
    );
    if (res.rows.length > 0) return false;
  }
  return refs.length > 0;
}

export async function unshieldedOnlyTest(db: Client): Promise<void> {
  setNetworkId(net.id as any);

  const before = {
    created_unshielded: await count(db, "created_unshielded"),
    offers: await count(db, "offer_file"),
  };
  console.log(`${TAG} before:`, JSON.stringify(before));

  console.log(`${TAG} building genesis + M0 + M1…`);
  const genesis = await buildWallet(net.walletSeed);
  const m0 = await buildWallet(M0_SEED);
  const m1 = await buildWallet(M1_SEED);

  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    try {
      await registerNightForDust(genesis as any);
    } catch (e) {
      console.warn(
        `${TAG} registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }
    await waitForSync(m0).catch(() => {});
    await waitForSync(m1).catch(() => {});

    const m0Unshielded = unshieldedAddressObj(m0);

    console.log(`${TAG} minting U0→M0, U1→M1…`);
    const deployed = await joinOfferFiles(genesis);
    const U0 = await mintUnshielded(deployed, SEP.U0, MINT, m0.unshieldedAddress);
    const U1 = await mintUnshielded(deployed, SEP.U1, MINT, m1.unshieldedAddress);

    const createdOk = await waitFor(
      "created_unshielded grew",
      async () => (await count(db, "created_unshielded")) >= before.created_unshielded + 2,
      24,
    );
    await assert("U0/U1 minted (UnshieldedCreate primitive)", async () => createdOk);

    const mintOwners = [ownerHex(m0.unshieldedAddress), ownerHex(m1.unshieldedAddress)];
    const mintRows = (
      await db.query<MintUtxo>(
        `SELECT owner, intent_hash, output_no FROM created_unshielded
         WHERE owner = ANY($1::text[])`,
        [mintOwners],
      )
    ).rows;
    await assert(
      "mint UTXOs recorded for M0/M1",
      async () => mintRows.length >= 2,
    );

    const m0HasU0 = (await waitForUnshielded(m0, U0, AMT, 36)) >= AMT;
    const m1HasU1 = (await waitForUnshielded(m1, U1, AMT, 36)) >= AMT;
    await assert("M0 holds U0, M1 holds U1", async () => m0HasU0 && m1HasU1);

    console.log(`${TAG} M0 building unshielded offer (give U0 / want U1)…`);
    const recipe = await m0.wallet.initSwap(
      { unshielded: { [U0]: AMT } } as any,
      [{ type: "unshielded", outputs: [{ type: U1, amount: AMT, receiverAddress: m0Unshielded }] } as any],
      shieldedKeys(m0),
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const signedRecipe = await (m0.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
      m0.unshieldedKeystore.signData(p),
    );
    const offer0 = await m0.wallet.finalizeRecipe(signedRecipe);
    console.log(`${TAG} offer imbalances: ${describeImbalances(offer0 as any)}`);

    const blob = OfferFiles.encode(offer0.serialize());
    let sub = await submitOffer(blob);
    for (
      let r = 0;
      r < 24 &&
      sub.status === 400 &&
      (sub.body?.error === "UTXO_UNKNOWN" || sub.body?.error === "ROOT_UNKNOWN");
      r++
    ) {
      await sleep(5000);
      sub = await submitOffer(blob);
    }
    await assert(
      "unshielded offer accepted by submit gate",
      async () => sub.status === 200,
    );

    const indexedOk = await waitFor(
      "offer indexed",
      async () => (await count(db, "offer_file")) > before.offers,
      24,
    );
    await assert("unshielded offer indexed via Celestia → STM", async () => indexedOk);

    const offerRow = (
      await db.query<{ id: number }>(`SELECT id FROM offer_file ORDER BY id DESC LIMIT 1`)
    ).rows[0];
    if (!offerRow) return;

    console.log(`${TAG} M1 balancing unshielded-only…`);
    const balRecipe = await (m1.wallet as any).balanceFinalizedTransaction(
      offer0,
      shieldedKeys(m1),
      {
        ttl: new Date(Date.now() + 30 * 60_000),
        tokenKindsToBalance: ["unshielded"],
      },
    );
    const balSigned = await (m1.wallet as any).signRecipe(balRecipe, (p: Uint8Array) =>
      m1.unshieldedKeystore.signData(p),
    );
    const balancedTx = await m1.wallet.finalizeRecipe(balSigned);
    await assert(
      "taker produced token-balanced tx",
      async () => nonDustImbalances(balancedTx as any).length === 0,
    );

    const settle = await settleViaBatcher(balancedTx as any);
    await assert("batcher settled unshielded swap", async () => settle.ok);

    // Mint UTXOs spent whole (change is new rows) → those triples DELETE'd
    const spentOk = await waitFor(
      "mint UTXOs deleted from created_unshielded",
      async () => mintUtxosGone(db, mintRows),
      36,
    );
    await assert(
      "mint UTXOs gone from created_unshielded (both legs spent)",
      async () => spentOk,
    );

    const archivedOk = await waitFor(
      "offer archived CONSUMED",
      async () => offerArchivedConsumed(db, offerRow.id),
      24,
    );
    await assert("offer ARCHIVED with CONSUMED after settlement", async () => archivedOk);

    await assert(
      "M0 received U1",
      async () => (await waitForUnshielded(m0, U1, AMT, 24)) >= AMT,
    );
    await assert(
      "M1 received U0",
      async () => (await waitForUnshielded(m1, U0, AMT, 24)) >= AMT,
    );
  } finally {
    await m0.wallet.stop().catch(() => {});
    await m1.wallet.stop().catch(() => {});
    await genesis.wallet.stop().catch(() => {});
  }
}
