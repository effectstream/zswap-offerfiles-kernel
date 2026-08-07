// Gate 2 probe: does Path A settlement work, and does wallet.revert() actually
// release the coins a failed settlement locked?
//
//   bun packages/solver/scripts/probe-settle.ts
//
// The revert half is the part only a live run can answer. `revert` is in the
// facade's typings, but the executor depends on a specific behaviour: after
// balancing a transaction that is then abandoned, the inputs it selected must
// become spendable again. If they do not, every failed fill permanently strands
// inventory and the solver silently bleeds capacity.
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
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  waitForSync,
} from "@zswap-da/solver-core/wallet";

import { loadLadderConfig } from "../src/config.ts";
import { SOLVER_LADDER_CONFIG, SOLVER_SEED } from "../env.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SWAP = 1000n;
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const { ladders } = await loadLadderConfig(SOLVER_LADDER_CONFIG);
const [pair] = ladders.pairs();
if (!pair) throw new Error("no ladders configured — run scripts/bootstrap-dev.ts");
// The maker gives what the solver receives, and wants what the solver pays.
const GIVE = pair.tokenIn;
const WANT = pair.tokenOut;
console.log(`[probe] maker gives ${GIVE.slice(0, 10)}… wants ${WANT.slice(0, 10)}…`);

/** Post an offer from the genesis wallet and wait for the node to index it. */
async function postOffer(maker: any): Promise<string> {
  const makerAddress = await maker.wallet.shielded.getAddress();
  const recipe = await maker.wallet.initSwap(
    { shielded: { [GIVE]: SWAP } },
    [{ type: "shielded", outputs: [{ type: WANT, amount: SWAP, receiverAddress: makerAddress }] } as any],
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

const solver = await buildWallet(SOLVER_SEED);
await waitForSync(solver);
const maker = await buildWallet(net.walletSeed);
await waitForSync(maker);

const solverBefore = await shieldedBalances(solver);
console.log(
  `[probe] solver before: give=${solverBefore[GIVE] ?? 0n} want=${solverBefore[WANT] ?? 0n}`,
);

// ── Part 1: a Path A fill actually settles ───────────────────────────────────
const offerId = await postOffer(maker);
console.log(`[probe] offer live: ${offerId.slice(0, 12)}…`);

const detail = await getZswapByHash(offerId);
const offerTx = reconstructOffer(detail.offerBech32);
const recipe = await solver.wallet.balanceFinalizedTransaction(
  offerTx as any,
  shieldedKeys(solver) as any,
  { ttl: new Date(Date.now() + 30 * 60_000) } as any,
);
const settleTx = await solver.wallet.finalizeRecipe(recipe);
await solver.wallet.submitTransaction(settleTx);
console.log("[probe] settlement submitted");

let settled = false;
for (let i = 0; i < 36; i++) {
  const { status } = await getOfferStatus(offerId).catch(() => ({ status: "live" as const }));
  if (status === "consumed") {
    settled = true;
    break;
  }
  if (status === "cancelled" || status === "expired") break;
  await sleep(5000);
}
check("Path A settles an offer from the solver's own inventory", settled);

const solverAfter = await shieldedBalances(solver);
console.log(`[probe] solver after: give=${solverAfter[GIVE] ?? 0n} want=${solverAfter[WANT] ?? 0n}`);
check(
  "solver received the offered token",
  (solverAfter[GIVE] ?? 0n) > (solverBefore[GIVE] ?? 0n),
  `${solverBefore[GIVE] ?? 0n} → ${solverAfter[GIVE] ?? 0n}`,
);
check(
  "solver paid out the wanted token",
  (solverAfter[WANT] ?? 0n) < (solverBefore[WANT] ?? 0n),
  `${solverBefore[WANT] ?? 0n} → ${solverAfter[WANT] ?? 0n}`,
);

// ── Part 2: revert releases what a failed settlement locked ──────────────────
// Balance a second offer, abandon it, revert, then balance the SAME offer
// again. Without a working revert the coins the first balance selected stay
// locked and the second attempt cannot fund itself.
const secondOfferId = await postOffer(maker);
const secondDetail = await getZswapByHash(secondOfferId);

const firstAttempt = await solver.wallet.balanceFinalizedTransaction(
  reconstructOffer(secondDetail.offerBech32) as any,
  shieldedKeys(solver) as any,
  { ttl: new Date(Date.now() + 30 * 60_000) } as any,
);
console.log("[probe] balanced once, abandoning without submitting");

let reverted = true;
try {
  await (solver.wallet as any).revert(firstAttempt);
} catch (err) {
  reverted = false;
  console.log(`[probe] revert threw: ${err instanceof Error ? err.message : String(err)}`);
}
check("wallet.revert(recipe) is callable on an abandoned balance", reverted);

let rebalanced = true;
let rebalanceErr = "";
try {
  const retry = await solver.wallet.balanceFinalizedTransaction(
    reconstructOffer(secondDetail.offerBech32) as any,
    shieldedKeys(solver) as any,
    { ttl: new Date(Date.now() + 30 * 60_000) } as any,
  );
  await solver.wallet.submitTransaction(await solver.wallet.finalizeRecipe(retry));
} catch (err) {
  rebalanced = false;
  rebalanceErr = err instanceof Error ? err.message : String(err);
}
check("the reverted coins fund a second attempt at the same offer", rebalanced, rebalanceErr);

let secondSettled = false;
for (let i = 0; i < 36; i++) {
  const { status } = await getOfferStatus(secondOfferId).catch(() => ({ status: "live" as const }));
  if (status === "consumed") {
    secondSettled = true;
    break;
  }
  await sleep(5000);
}
check("the retried settlement reaches the chain", secondSettled);

console.log(failures === 0 ? "\n[probe] ✅ GATE 2 PASS" : `\n[probe] ❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
