// 08-wallet.ts — Build a Midnight wallet and print its address + balances.
// Requires: WALLET_SEED env var (hex, 64 chars) OR falls back to the dev
// genesis seed (only has funds on undeployed / local dev).
//
// On Preview/Mainnet you need a funded wallet seed:
//   MIDNIGHT_NETWORK_ID=preview bun mnemonic-to-seed.ts  # converts a 24-word phrase
//   export WALLET_SEED=<printed hex>
//   export MIDNIGHT_NODE_HTTP=<the network's Midnight node RPC URL>
//   bun run api-examples/08-wallet.ts

import { config, header, midnightNodeUrl } from "./config.ts";
import { buildWalletAndWaitForFunds } from "@effectstream/midnight-contracts";
import { get } from "./config.ts";

globalThis.WebSocket = WebSocket;

header("Wallet");

// The indexer and proof-server URLs are served by the kernel; the Midnight
// node's RPC URL is not (see midnightNodeUrl in config.ts).
const midnightCfg = await get<{
  indexerUri: string;
  indexerWsUri: string;
  proofServerUri: string;
  networkId: string;
}>("/v1/midnight/config");

const networkUrls = {
  id:          midnightCfg.networkId as any,
  indexer:     midnightCfg.indexerUri,
  indexerWS:   midnightCfg.indexerWsUri,
  node:        midnightNodeUrl(),
  proofServer: midnightCfg.proofServerUri,
};

console.log(`Building wallet for seed ${config.walletSeed.slice(0, 8)}… on ${midnightCfg.networkId}`);
console.log("(This syncs the wallet state from the indexer — may take a minute.)\n");

const { wallet, dustAddress, zswapSecretKeys, dustSecretKey } =
  await buildWalletAndWaitForFunds(networkUrls, config.walletSeed, midnightCfg.networkId as any);

const state = await wallet.shielded.waitForSyncedState();
const address = state.address.coinPublicKeyString();

console.log("─── Wallet ──────────────────────────────────────────────────────");
console.log(`  Shielded address : ${address}`);
console.log(`  Dust address     : ${dustAddress}`);

const balances: Record<string, bigint> = state.balances as any;
const STARS_PER_NIGHT = 1_000_000n;

if (Object.keys(balances).length === 0) {
  console.log("  Shielded balances: (none)");
} else {
  console.log("  Shielded balances:");
  for (const [color, amount] of Object.entries(balances)) {
    const night = color === "0000000000000000000000000000000000000000000000000000000000000000"
      ? `  (${(BigInt(amount as any) / STARS_PER_NIGHT).toString()} NIGHT)`
      : "";
    console.log(`    ${color.slice(0, 16)}…  ${amount}${night}`);
  }
}

console.log("\nKeys available for offer construction:");
console.log(`  zswapSecretKeys : ${zswapSecretKeys ? "yes" : "no"}`);
console.log(`  dustSecretKey   : ${dustSecretKey ? "yes" : "no"}`);

await wallet.stop().catch(() => {});
console.log("\n✅  Wallet synced and stopped cleanly.");
