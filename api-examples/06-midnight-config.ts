// 06-midnight-config.ts — Fetch public Midnight network config from the node.
// bun run api-examples/06-midnight-config.ts

import { get, print, header } from "./config.ts";

header("Midnight Config");

const cfg = await get("/v1/midnight/config");
print("GET /v1/midnight/config", cfg);

const c = cfg as any;
console.log("\nQuick-copy values:");
console.log(`  indexerUri      : ${c.indexerUri}`);
console.log(`  indexerWsUri    : ${c.indexerWsUri}`);
console.log(`  proofServerUri  : ${c.proofServerUri}`);
console.log(`  networkId       : ${c.networkId}`);
