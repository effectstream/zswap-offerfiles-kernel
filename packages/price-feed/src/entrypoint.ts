// Shared body of the three network entrypoints.
//
// The network id does not change what this process does — it writes to the
// database its DB_* variables point at, and CoinGecko has no notion of a
// Midnight network. It is logged so a preprod log line cannot be mistaken for
// a dev one, and the entrypoints exist for symmetry with every other component
// (packages/solver, packages/batcher), which is what deploy/ expects to find.

import { loadPriceFeedConfig } from "./config.ts";
import { main } from "./run.ts";

export async function startPriceFeed(network: string): Promise<never> {
  console.log(`[price-feed] starting (network=${network})`);
  const code = await main(process.argv.slice(2), loadPriceFeedConfig());
  process.exit(code);
}
