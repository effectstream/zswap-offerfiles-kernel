// Full swap lifecycle folded into the Phase-B runner.
// Infra is already up when this runs (Phase A + migrations + startup mint).
//
// Flow: mint A/B via offer-files helpers → create A↔B offer
//   → /api/zswap/submit → wait for Celestia indexing
//   → balance + settle on Midnight → nullifier consumed → offer ARCHIVED.
//
// Does NOT call mintTestTokens() — that races the orchestrator's
// midnight-mint-test-tokens process (TransactionInvalidError).

import type { Client } from "pg";
import { assert } from "../helpers.ts";
import {
  count,
  nullifiersGrew,
  offerArchivedConsumed,
  waitFor,
} from "../lib/db.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { joinOfferFiles, mintShielded } from "../lib/offer-files.ts";
import {
  buildWallet,
  shieldedKeys,
  waitForShielded,
  waitForSync,
} from "../lib/wallet.ts";
import { submitOffer } from "../lib/api.ts";

globalThis.WebSocket = WebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEP = { A: 0xe0, B: 0xe1 } as const;
const MINT_AMOUNT = 1_000_000_000n;
const GIVE_AMOUNT = 500_000n;
const WANT_AMOUNT = 750_000n;

export async function zswapFlowTest(db: Client): Promise<void> {
  setNetworkId(net.id as any);

  const before = {
    known_roots: await count(db, "known_roots"),
    created_unshielded: await count(db, "created_unshielded"),
    nullifiers: await count(db, "nullifiers"),
    offers: await count(db, "offer_file"),
  };
  console.log("[lifecycle] before:", JSON.stringify(before));

  // Startup mint (orchestrator) should have produced UnshieldedCreate events.
  const createdOk = await waitFor(
    "created_unshielded > 0",
    async () => (await count(db, "created_unshielded")) > 0,
    24,
  );
  await assert(
    "created_unshielded populated (UnshieldedCreate primitive live)",
    async () => createdOk,
  );

  console.log("[lifecycle] building genesis wallet + minting A/B…");
  const genesis = await buildWallet(net.walletSeed);

  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    try {
      await registerNightForDust(genesis as any);
    } catch (e) {
      console.warn(
        `[lifecycle] registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }

    const deployed = await joinOfferFiles(genesis);
    const nonce = BigInt(Date.now());
    const shieldedA = await mintShielded(deployed, SEP.A, MINT_AMOUNT, nonce);
    const shieldedB = await mintShielded(deployed, SEP.B, MINT_AMOUNT, nonce + 1n);

    const haveMinted =
      (await waitForShielded(genesis, shieldedA, GIVE_AMOUNT, 24)) >= GIVE_AMOUNT &&
      (await waitForShielded(genesis, shieldedB, WANT_AMOUNT, 12)) >= WANT_AMOUNT;
    await assert("genesis wallet holds both minted shielded colors", async () => haveMinted);

    const address = await genesis.wallet.shielded.getAddress();
    const keys = shieldedKeys(genesis);
    const recipe = await genesis.wallet.initSwap(
      { shielded: { [shieldedA]: GIVE_AMOUNT } },
      [
        {
          type: "shielded",
          outputs: [{ type: shieldedB, amount: WANT_AMOUNT, receiverAddress: address }],
        } as any,
      ],
      keys,
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const offerFinalized = await genesis.wallet.finalizeTransaction(recipe.transaction);
    const blob = OfferFiles.encode(offerFinalized.serialize());
    console.log(
      `[lifecycle] offer: give ${GIVE_AMOUNT} of A(${shieldedA.slice(0, 8)}…), ` +
        `want ${WANT_AMOUNT} of B(${shieldedB.slice(0, 8)}…)`,
    );

    let sub = await submitOffer(blob);
    for (let r = 0; r < 24 && sub.status === 400 && sub.body?.error === "ROOT_UNKNOWN"; r++) {
      await sleep(5000);
      sub = await submitOffer(blob);
    }
    await assert(
      "offer accepted by submit gate (crypto + liveness + root-known)",
      async () => sub.status === 200,
    );

    const indexedOk = await waitFor(
      "offer indexed",
      async () => (await count(db, "offer_file")) > before.offers,
      24,
    );
    await assert("offer indexed via Celestia → STM ingestion", async () => indexedOk);
    if (!indexedOk) return;

    const offerRow = (
      await db.query<{ id: number }>("SELECT id FROM offer_file ORDER BY id DESC LIMIT 1")
    ).rows[0];
    if (!offerRow) return;

    console.log("[lifecycle] balancing + settling the A↔B offer on Midnight…");
    const offerTx = Transaction.deserialize(
      "signature",
      "proof",
      "binding",
      OfferFiles.decode(blob),
    );
    const balRecipe = await (genesis.wallet as any).balanceFinalizedTransaction(
      offerTx,
      keys,
      { ttl: new Date(Date.now() + 30 * 60_000) },
    );
    const settleTx = await genesis.wallet.finalizeRecipe(balRecipe);
    await (genesis.wallet as any).submitTransaction(settleTx);
    console.log(
      "[lifecycle] settle submitted:",
      settleTx.transactionHash?.().toString?.().slice(0, 24) ?? "(tx)",
    );

    const spentOk = await waitFor(
      "nullifiers > before",
      async () => nullifiersGrew(db, before.nullifiers, 1),
      36,
    );
    await assert("nullifiers populated (Nullifier primitive live)", async () => spentOk);

    const archivedOk = await waitFor(
      "offer archived CONSUMED",
      async () => offerArchivedConsumed(db, offerRow.id),
      24,
    );
    await assert("offer ARCHIVED with CONSUMED after settlement", async () => archivedOk);

    const rootsNow = await count(db, "known_roots");
    await assert(
      "known_roots advanced (ZswapRoot primitive live)",
      async () => rootsNow > before.known_roots,
    );

    console.log(
      "[lifecycle] after:",
      JSON.stringify({
        known_roots: await count(db, "known_roots"),
        created_unshielded: await count(db, "created_unshielded"),
        nullifiers: await count(db, "nullifiers"),
      }),
    );
  } finally {
    await genesis.wallet.stop().catch(() => {});
  }
}
