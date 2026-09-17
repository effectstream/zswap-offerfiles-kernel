// Post one offer from a maker wallet, for exercising the solver against a
// running dev stack.
//
//   bun packages/solver/scripts/post-test-offer.ts \
//     --give <color> --want <color> [--give-amount N] [--want-amount N] [--seed <hex>]
//
// The maker keeps the offer unbalanced and pays no dust (payFees:false) — that
// imbalance is the trade, and whoever fills it supplies the other side.

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { getOfferStatus, submitOffer } from "@zswap-da/solver-core/api-client";
import { buildWallet, shieldedBalances, shieldedKeys, waitForSync } from "@zswap-da/solver-core/wallet";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const give = arg("give");
const want = arg("want");
if (!give || !want) {
  console.error("usage: post-test-offer.ts --give <color> --want <color> [--give-amount N] [--want-amount N] [--seed <hex>]");
  process.exit(1);
}
const giveAmount = BigInt(arg("give-amount") ?? "1000");
const wantAmount = BigInt(arg("want-amount") ?? "1000");
const seed = arg("seed") ?? "0000000000000000000000000000000000000000000000000000000000000001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const maker = await buildWallet(seed);
await waitForSync(maker);

const held = (await shieldedBalances(maker))[give] ?? 0n;
if (held < giveAmount) {
  throw new Error(`maker holds ${held} of ${give.slice(0, 10)}…, needs ${giveAmount}`);
}

const makerAddress = await maker.wallet.shielded.getAddress();

const recipe = await maker.wallet.initSwap(
  { shielded: { [give]: giveAmount } },
  [{ type: "shielded", outputs: [{ type: want, amount: wantAmount, receiverAddress: makerAddress }] } as any],
  shieldedKeys(maker),
  { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
);
const finalized = await maker.wallet.finalizeTransaction(recipe.transaction);
const blob = OfferFiles.encode(finalized.serialize());

// A freshly proved offer can reference a root the node has not synced yet;
// that resolves on its own within a few blocks.
let sub = await submitOffer(blob);
for (let i = 0; i < 24 && sub.status === 400 && sub.body?.error === "ROOT_UNKNOWN"; i++) {
  await sleep(5000);
  sub = await submitOffer(blob);
}
if (sub.status !== 200) {
  throw new Error(`submit rejected: ${sub.status} ${JSON.stringify(sub.body)}`);
}

const offerId = sub.body.offerId as string;
console.log(`[post-offer] submitted ${offerId}`);

for (let i = 0; i < 36; i++) {
  const { status } = await getOfferStatus(offerId).catch(() => ({ status: "not_found" as const }));
  if (status === "live") {
    console.log(`[post-offer] live: ${offerId}`);
    process.exit(0);
  }
  await sleep(5000);
}
throw new Error(`offer ${offerId} never reached live`);
