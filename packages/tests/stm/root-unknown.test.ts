// ROOT_UNKNOWN negative: well-formed offer rejected by past_roots gate,
// never reaches Celestia / offer_file.

import type { Client } from "pg";
import { assert } from "../helpers.ts";
import { count, waitFor } from "../lib/db.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";
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
const TAG = "[root-unknown]";
const SEP = { GIVE: 0xc0, ADVANCE: 0xc1 } as const;
const MINT = 1_000_000_000n;
const GIVE = 1_000_000n;
const WANT_TOKEN = "ff".repeat(32);
const WANT = 5_000_000n;

export async function rootUnknownTest(db: Client): Promise<void> {
  setNetworkId(net.id as any);

  console.log(`${TAG} building genesis…`);
  const genesis = await buildWallet(net.walletSeed);

  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    try {
      await registerNightForDust(genesis as any);
    } catch (e) {
      console.warn(
        `${TAG} registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }
    const addr = await genesis.wallet.shielded.getAddress();

    console.log(`${TAG} minting give token + building offer…`);
    const deployed = await joinOfferFiles(genesis);
    const nonce = BigInt(Date.now());
    const G = await mintShielded(deployed, SEP.GIVE, MINT, nonce);
    if ((await waitForShielded(genesis, G, GIVE, 24)) < GIVE)
      throw new Error("genesis missing give token");

    const recipe = await genesis.wallet.initSwap(
      { shielded: { [G]: GIVE } },
      [
        {
          type: "shielded",
          outputs: [{ type: WANT_TOKEN, amount: WANT, receiverAddress: addr }],
        } as any,
      ],
      shieldedKeys(genesis),
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const finalized = await genesis.wallet.finalizeTransaction(recipe.transaction);
    const blob = OfferFiles.encode(finalized.serialize());

    const v = validateZswapOffer(blob, {
      refState: getBlankRefState(net.id),
      tblock: new Date(),
      maxBytes: 4 * 1024 * 1024,
    });
    await assert(
      "offer is well-formed (valid structure + ZK proof)",
      async () => v.ok === true,
    );
    const roots = (v as any).inputRoots as string[] | undefined;
    await assert(
      "offer carries a readable input merkle root",
      async () => !!roots && roots.length > 0,
    );
    if (!v.ok || !roots || roots.length === 0) return;
    const R = roots[0];
    console.log(`${TAG} offer input root: ${R.slice(0, 20)}…`);

    const knownOk = await waitFor(
      "offer root synced into known_roots",
      async () =>
        (await db.query(`SELECT 1 FROM known_roots WHERE root = $1`, [R])).rows
          .length > 0,
      24,
    );
    await assert(
      "offer's root IS a recognised chain root",
      async () => knownOk,
    );

    const hR = Number(
      (
        await db.query<{ height: string }>(
          `SELECT height FROM known_roots WHERE root = $1`,
          [R],
        )
      ).rows[0]?.height ?? 0,
    );

    console.log(`${TAG} advancing the coin tree past the offer's root…`);
    await mintShielded(deployed, SEP.ADVANCE, MINT, nonce + 1n);
    const advanced = await waitFor(
      "tree advanced past offer root",
      async () =>
        Number(
          (
            await db.query<{ m: string }>(
              `SELECT COALESCE(MAX(height),0)::text m FROM known_roots`,
            )
          ).rows[0].m,
        ) > hR,
      24,
    );
    await assert("coin tree advanced past the offer's root", async () => advanced);

    await db.query(`DELETE FROM known_roots WHERE root = $1`, [R]);
    const stillThere = (
      await db.query(`SELECT 1 FROM known_roots WHERE root = $1`, [R])
    ).rows.length;
    await assert(
      "offer root removed from known_roots",
      async () => stillThere === 0,
    );

    const offersBefore = await count(db, "offer_file");
    console.log(`${TAG} submitting well-formed offer with unknown root…`);
    const res = await submitOffer(blob);
    await assert(
      "well-formed offer REJECTED (400 ROOT_UNKNOWN)",
      async () => res.status === 400 && res.body?.error === "ROOT_UNKNOWN",
    );

    await sleep(8000);
    await assert(
      "rejected offer NEVER reached Celestia (offer_file unchanged)",
      async () => (await count(db, "offer_file")) === offersBefore,
    );
  } finally {
    await genesis.wallet.stop().catch(() => {});
  }
}
