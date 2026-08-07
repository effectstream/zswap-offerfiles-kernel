// Gate 3 probe: can the solver close a set that does not cross exactly?
//
//   bun packages/solver/scripts/probe-topup.ts
//
// Ring makers only ever build a single-pair half. The solver's top-up half is
// different: one initSwap that supplies every shortfall and takes every surplus
// across the whole set. This checks that such a half merges to a token-balanced
// transaction the batcher will accept — the one thing a unit test cannot answer,
// because the balance is decided by the ledger, not by our arithmetic.
//
// Needs a running dev stack and a bootstrapped solver
// (scripts/bootstrap-dev.ts).

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import {
  getOfferStatus,
  getZswapByHash,
  reconstructOffer,
  submitOffer,
} from "@zswap-da/solver-core/api-client";
import {
  describeImbalances,
  mergeFinalized,
  nonDustImbalances,
  settleViaBatcher,
} from "@zswap-da/solver-core/batcher";
import { buildWallet, shieldedKeys, waitForSync } from "@zswap-da/solver-core/wallet";

import { loadLadderConfig } from "../src/config.ts";
import { netOf } from "../src/engine.ts";
import { bookOfferFromApi } from "../src/book.ts";
import { SOLVER_LADDER_CONFIG, SOLVER_SEED } from "../env.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const { ladders } = await loadLadderConfig(SOLVER_LADDER_CONFIG);
const [pair] = ladders.pairs();
if (!pair) throw new Error("no ladders configured — run scripts/bootstrap-dev.ts");
const TOKEN_A = pair.tokenIn;
const TOKEN_B = pair.tokenOut;

const solver = await buildWallet(SOLVER_SEED);
await waitForSync(solver);
const maker = await buildWallet(net.walletSeed);
await waitForSync(maker);

/** Post an offer from the maker and wait for it to be indexed. */
async function postOffer(give: string, giveAmount: bigint, want: string, wantAmount: bigint): Promise<string> {
  const address = await maker.wallet.shielded.getAddress();
  const recipe = await maker.wallet.initSwap(
    { shielded: { [give]: giveAmount } },
    [{ type: "shielded", outputs: [{ type: want, amount: wantAmount, receiverAddress: address }] } as any],
    shieldedKeys(maker),
    { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
  );
  const finalized = await maker.wallet.finalizeTransaction(recipe.transaction);
  const blob = OfferFiles.encode(finalized.serialize());

  let sub = await submitOffer(blob);
  for (let i = 0; i < 24 && sub.status === 400 && sub.body?.error === "ROOT_UNKNOWN"; i++) {
    await sleep(5000);
    sub = await submitOffer(blob);
  }
  if (sub.status !== 200) throw new Error(`submit rejected: ${sub.status} ${JSON.stringify(sub.body)}`);

  const offerId = sub.body.offerId as string;
  for (let i = 0; i < 36; i++) {
    const { status } = await getOfferStatus(offerId).catch(() => ({ status: "not_found" as const }));
    if (status === "live") return offerId;
    await sleep(5000);
  }
  throw new Error(`offer ${offerId} never went live`);
}

// Deliberately NOT a crossing: the second offer wants 200 less A than the first
// gives, and gives 100 less B than the first wants. So the solver ends up short
// 100 B and holding 200 A — exactly the shape a top-up half has to close.
console.log("[probe] posting two deliberately non-crossing offers…");
const first = await postOffer(TOKEN_A, 1000n, TOKEN_B, 1000n);
const second = await postOffer(TOKEN_B, 900n, TOKEN_A, 800n);
console.log(`[probe] offers live: ${first.slice(0, 12)}… ${second.slice(0, 12)}…`);

const details = await Promise.all([getZswapByHash(first), getZswapByHash(second)]);
const offers = details.map((d) => bookOfferFromApi(d)!);
const expected = netOf(offers);
console.log(
  `[probe] net from the solver's side: ` +
    [...expected].map(([t, a]) => `${a > 0n ? "+" : ""}${a} ${t.slice(0, 8)}`).join(" "),
);
check(
  "the set genuinely does not cross (a top-up is required)",
  expected.size > 0,
  `${expected.size} non-zero token(s)`,
);

const gives = new Map<string, bigint>();
const wants = new Map<string, bigint>();
for (const [token, amount] of expected) {
  if (amount < 0n) gives.set(token, -amount);
  else wants.set(token, amount);
}

const solverAddress = await solver.wallet.shielded.getAddress();
const topUpRecipe = await solver.wallet.initSwap(
  { shielded: Object.fromEntries(gives) },
  wants.size === 0
    ? []
    : [
        {
          type: "shielded",
          outputs: [...wants].map(([token, amount]) => ({
            type: token,
            amount,
            receiverAddress: solverAddress,
          })),
        } as any,
      ],
  shieldedKeys(solver),
  { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
);
const topUp = await solver.wallet.finalizeTransaction(topUpRecipe.transaction);
console.log("[probe] built the solver's top-up half");

const offerTxs = details.map((d) => reconstructOffer(d.offerBech32));
const merged = mergeFinalized([...offerTxs, topUp] as any);
const imbalance = nonDustImbalances(merged as any);
check(
  "offers + top-up merge to a token-balanced transaction",
  imbalance.length === 0,
  imbalance.length === 0 ? "" : describeImbalances(merged as any),
);

if (imbalance.length === 0) {
  const res = await settleViaBatcher(merged as any, { level: "wait-receipt" });
  check("the batcher accepts and settles the merged set", res.ok, `status=${res.status}`);

  let bothConsumed = true;
  for (const offerId of [first, second]) {
    let consumed = false;
    for (let i = 0; i < 36; i++) {
      const { status } = await getOfferStatus(offerId).catch(() => ({ status: "live" as const }));
      if (status === "consumed") {
        consumed = true;
        break;
      }
      await sleep(5000);
    }
    if (!consumed) bothConsumed = false;
  }
  check("both offers reach consumed", bothConsumed);
}

console.log(failures === 0 ? "\n[probe] ✅ GATE 3 PASS" : `\n[probe] ❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
