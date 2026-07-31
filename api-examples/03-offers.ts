// 03-offers.ts — Read the live offer book; optionally filter by token/direction.
// bun run api-examples/03-offers.ts
// TOKEN=0000...0000 DIRECTION=GIVING bun run api-examples/03-offers.ts

import { config, get, print, header } from "./config.ts";

header("Live Offer Book");

const params = new URLSearchParams({ limit: "10" });
if (process.env.TOKEN)     params.set("token",     process.env.TOKEN);
if (process.env.DIRECTION) params.set("direction", process.env.DIRECTION);

const { offers, nextCursor } = await get<any>(`/v1/offers?${params}`);
print(`GET /v1/offers?${params}`, { offers, nextCursor });

if (offers.length === 0) {
  console.log("\nNo open offers found.");
} else {
  console.log(`\n${offers.length} open offer(s):\n`);
  for (const o of offers) {
    const gives = o.computed.gives.map((g: any) => `${g.amount} ${g.token.slice(0, 8)}…`).join(", ");
    const wants = o.computed.wants.map((w: any) => `${w.amount} ${w.token.slice(0, 8)}…`).join(", ");
    const hash = o.offerId ? o.offerId.slice(0, 12) + "…" : "(no hash)";
    console.log(`  [${hash}] gives: ${gives}  →  wants: ${wants}  (Celestia #${o.celestiaHeight})`);
  }

  // The list is blob-free; the content hash addresses each offer.
  const first = offers[0];
  if (first?.offerId) {
    console.log(`\nStatus check for offer ${first.offerId.slice(0, 12)}…:`);
    const status = await get<any>(`/v1/offers/${first.offerId}/status`);
    print("GET /v1/offers/:hash/status", status);

    console.log(`\nFull offer (with blob) for ${first.offerId.slice(0, 12)}…:`);
    const detail = await get<any>(`/v1/offers/${first.offerId}`);
    print("GET /v1/offers/:hash", { ...detail, blob: `${detail.offerBech32.slice(0, 40)}… (${detail.offerBech32.length} chars)` });
  }
}
