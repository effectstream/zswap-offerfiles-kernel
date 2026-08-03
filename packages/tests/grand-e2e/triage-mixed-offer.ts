// Triage for ISSUES.md #2 — mixed offer rejected NOT_A_SWAP.
//
// Builds ONE shielded-give / unshielded-want offer through exactly the code
// path the suite uses, then asks the validator what it derives — before any
// node, DB or Celestia involvement. That separates the two candidates:
//
//   product bug : the tx really does carry an unshielded output, but
//                 deriveLegs() does not surface it as a want
//   test bug    : the tx never carried the output, so initSwap/signRecipe
//                 built the wrong thing
//
// Writes the blob to /tmp/mixed-offer.bech32 so you can push the same bytes
// at POST /v1/offers for the authoritative verdict.
//
// Run against an up stack (needs the proof server + a funded wallet):
//   bun run packages/tests/grand-e2e/triage-mixed-offer.ts

import { writeFileSync } from "node:fs";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";

import { buildWallet, shieldedKeys, unshieldedAddressObj, waitForSync } from "../lib/wallet.ts";
import { TX_TTL_MS } from "./config.ts";

setNetworkId(net.id as any);
(globalThis as any).WebSocket = WebSocket;

// Genesis holds both the shielded mint and NIGHT, so one wallet can build the
// mixed offer without the suite's whole funding fan-out.
const w = await buildWallet(net.walletSeed);
await waitForSync(w, { requireUnshieldedFunds: true });

const shieldedBalances = (await w.wallet.shielded.waitForSyncedState()).balances ?? {};
const giveColor = Object.keys(shieldedBalances).find((c) => (shieldedBalances as any)[c] > 0n);
if (!giveColor) throw new Error("no shielded balance on genesis — run mint-test-tokens first");
const NIGHT = "0".repeat(64);

console.log(`give (shielded): ${giveColor.slice(0, 16)}…`);
console.log(`want (unshielded): NIGHT`);

const recipe = await w.wallet.initSwap(
  { shielded: { [giveColor]: 1000n } },
  [
    {
      type: "unshielded",
      outputs: [{ type: NIGHT, amount: 500n, receiverAddress: unshieldedAddressObj(w) }],
    } as any,
  ],
  shieldedKeys(w),
  { ttl: new Date(Date.now() + TX_TTL_MS), payFees: false },
);

// Same dual path buildOffer() uses: try the plain finalize, fall back to the
// sign-recipe route that unshielded legs require.
let finalized: any;
try {
  finalized = await w.wallet.finalizeTransaction((recipe as any).transaction);
  console.log("finalized via finalizeTransaction()");
} catch {
  const signed = await (w.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
    w.unshieldedKeystore.signData(p),
  );
  finalized = await w.wallet.finalizeRecipe(signed);
  console.log("finalized via signRecipe() + finalizeRecipe()");
}

const blob = OfferFiles.encode(finalized.serialize());
writeFileSync("/tmp/mixed-offer.bech32", blob);
console.log(`blob written to /tmp/mixed-offer.bech32 (${blob.length} chars)`);

const v = validateZswapOffer(blob, {
  refState: getBlankRefState(net.id),
  tblock: new Date(),
  maxBytes: 1024 * 1024,
  crypto: "defer",
});

console.log("\n── validator verdict ──");
console.log(`ok:    ${v.ok}`);
console.log(`code:  ${v.code ?? "(none)"}`);
console.log(`reason:${v.reason ?? "(none)"}`);
console.log(`gives: ${JSON.stringify(v.gives ?? [])}`);
console.log(`wants: ${JSON.stringify(v.wants ?? [])}`);

// Ground truth straight off the transaction, independent of deriveLegs().
const imbalances: string[] = [];
for (const seg of [0, 1]) {
  try {
    const m = (finalized as any).imbalances?.(seg);
    if (m?.entries) {
      for (const [k, amt] of m.entries() as Iterable<[any, bigint]>) {
        if (amt !== 0n) imbalances.push(`seg${seg} ${k?.tag ?? "?"} ${String(k?.raw ?? "").slice(0, 12)} = ${amt}`);
      }
    }
  } catch { /* segment absent */ }
}
console.log(`\ntx imbalances (ground truth):\n  ${imbalances.join("\n  ") || "(none)"}`);

console.log("\n── verdict ──");
const wants = v.wants ?? [];
const hasUnshieldedImbalance = imbalances.some((s) => s.includes("unshielded"));
if (wants.length === 0 && hasUnshieldedImbalance) {
  console.log("PRODUCT BUG: the tx carries an unshielded imbalance but deriveLegs() surfaced no want.");
} else if (wants.length === 0) {
  console.log("TEST BUG: the tx never carried an unshielded output — construction is wrong, not derivation.");
} else {
  console.log("NOT REPRODUCED standalone: wants derived fine. Re-run p3 and capture the failing blob.");
}

await w.wallet.stop().catch(() => {});
