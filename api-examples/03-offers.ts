// 03-offers.ts — Read the live offer book; optionally filter by token/direction.
// bun run api-examples/03-offers.ts
// TOKEN=0000...0000 DIRECTION=GIVING bun run api-examples/03-offers.ts

import { config, get, print, header } from "./config.ts";

header("Live Offer Book");

const params = new URLSearchParams({ limit: "10" });
if (process.env.TOKEN)     params.set("token",     process.env.TOKEN);
if (process.env.DIRECTION) params.set("direction", process.env.DIRECTION);

const offers = await get<any[]>(`/api/zswaps?${params}`);
print(`GET /api/zswaps?${params}`, offers);

if (offers.length === 0) {
  console.log("\nNo open offers found.");
} else {
  console.log(`\n${offers.length} open offer(s):\n`);
  for (const o of offers) {
    const gives = o.gives.map((g: any) => `${g.amount} ${g.token.slice(0, 8)}…`).join(", ");
    const wants = o.wants.map((w: any) => `${w.amount} ${w.token.slice(0, 8)}…`).join(", ");
    const hash = o.offer_hash ? o.offer_hash.slice(0, 12) + "…" : "(no hash)";
    console.log(`  [${hash}] gives: ${gives}  →  wants: ${wants}  (Celestia #${o.celestia_height})`);
  }

  // The list is blob-free; the content hash addresses each offer.
  const first = offers[0];
  if (first?.offer_hash) {
    console.log(`\nStatus check for offer ${first.offer_hash.slice(0, 12)}…:`);
    const status = await get<any>(`/api/zswaps/${first.offer_hash}/status`);
    print("GET /api/zswaps/:hash/status", status);

    console.log(`\nFull offer (with blob) for ${first.offer_hash.slice(0, 12)}…:`);
    const detail = await get<any>(`/api/zswaps/${first.offer_hash}`);
    print("GET /api/zswaps/:hash", { ...detail, blob: `${detail.blob.slice(0, 40)}… (${detail.blob.length} chars)` });
  }
}
