// 11-settle-offer.ts — Take and settle an open offer on Midnight.
//
// What this does:
//   1. Fetches the first open offer from the book (or use OFFER_BLOB env var).
//   2. Builds the taker wallet (TAKER_SEED).
//   3. Calls wallet.balanceFinalizedTransaction() to produce a settlement tx.
//   4. Finalizes and submits to Midnight.
//   5. Polls the nullifier set until the offer is ARCHIVED (CONSUMED).
//
// Env overrides:
//   TAKER_SEED=<64-hex>     taker wallet seed (must have enough NIGHT for dust fees)
//   OFFER_BLOB=swapoffer1… specific offer to settle; defaults to first open offer

import { config, get, post, header } from "./config.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { buildWalletAndWaitForFunds } from "@effectstream/midnight-contracts";
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

globalThis.WebSocket = WebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

header("Settle Offer");

// ── 1. Midnight config ────────────────────────────────────────────────────────
const midnightCfg = await get<any>("/v1/midnight/config");
setNetworkId(midnightCfg.networkId as any);

const networkUrls = {
  id:          midnightCfg.networkId as any,
  indexer:     midnightCfg.indexerUri,
  indexerWS:   midnightCfg.indexerWsUri,
  node:        midnightCfg.indexerUri,
  proofServer: midnightCfg.proofServerUri,
};

// ── 2. Pick an offer ──────────────────────────────────────────────────────────
let blob = process.env.OFFER_BLOB ?? "";
let offerId: number | undefined;

if (!blob) {
  const { offers } = await get<any>("/v1/offers?limit=1");
  if (offers.length === 0) {
    console.error("No open offers. Submit one first with 09-submit-offer.ts.");
    process.exit(1);
  }
  // The list is blob-free — fetch the blob by content hash.
  const detail = await get<any>(`/v1/offers/${offers[0].offerId}`);
  blob    = detail.offerBech32;
  offerId = offers[0].id;
  console.log(`Using offer ${offers[0].offerId}  celestia=#${offers[0].celestiaHeight}`);
  console.log(`  gives: ${JSON.stringify(offers[0].computed.gives)}`);
  console.log(`  wants: ${JSON.stringify(offers[0].computed.wants)}\n`);
} else {
  console.log(`Using OFFER_BLOB (${blob.slice(0, 32)}…)\n`);
}

// ── 3. Build taker wallet ─────────────────────────────────────────────────────
console.log(`Building taker wallet (seed ${config.takerSeed.slice(0, 8)}…)…`);
const { wallet, zswapSecretKeys, dustSecretKey } =
  await buildWalletAndWaitForFunds(networkUrls, config.takerSeed, midnightCfg.networkId as any);
const keys = { shieldedSecretKeys: zswapSecretKeys, dustSecretKey };

// ── 4. Balance and finalize ───────────────────────────────────────────────────
console.log("Balancing settlement transaction (proving…)");
const offerTx = Transaction.deserialize("signature", "proof", "binding", OfferFiles.decode(blob));

const balRecipe = await (wallet as any).balanceFinalizedTransaction(offerTx, keys, {
  ttl: new Date(Date.now() + 30 * 60_000),
});
const settleTx = await wallet.finalizeRecipe(balRecipe);

// ── 5. Submit to Midnight ─────────────────────────────────────────────────────
console.log("Submitting settlement transaction to Midnight…");
await (wallet as any).submitTransaction(settleTx);

const txHash = settleTx.transactionHash?.().toString?.().slice(0, 24) ?? "(tx)";
console.log(`\n✅  Settlement submitted: ${txHash}…`);

// ── 6. Wait for offer to be archived ─────────────────────────────────────────
console.log("\nWaiting for offer to be archived (nullifier consumed)…");
for (let i = 0; i < 36; i++) {
  await sleep(5_000);
  const { status } = await post<any>("/v1/offers/status", { offer: blob });
  console.log(`  status: ${status}`);
  if (status === "consumed") {
    console.log("✅  Offer consumed (all inputs spent in one tx) — settlement confirmed.");
    break;
  }
  if (status === "cancelled" || status === "expired" || status === "not_found") {
    console.log(`Offer ended with status: ${status}`);
    break;
  }
}

await wallet.stop().catch(() => {});
