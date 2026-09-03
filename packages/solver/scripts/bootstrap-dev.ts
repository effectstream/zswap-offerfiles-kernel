// Provision the solver on a fresh dev stack and regenerate its ladder config.
//
//   bun packages/solver/scripts/bootstrap-dev.ts
//
// Token colors derive from the deployed offer-files contract, so they change
// with every deployment and cannot be checked in. This mints the solver its own
// inventory using the SAME fixed domain separators as the startup mint
// (packages/contracts-midnight/mint-test-tokens.ts), which yields the SAME
// colors — so the solver and the startup-minted wallets trade the same tokens —
// and then writes those colors into config/ladders.dev.json.
//
// Minting to the solver directly, rather than transferring from genesis, keeps
// the shielded side to one circuit call per token instead of a transfer whose
// change output has to confirm first.
//
// Run with the solver stopped: two wallets on one seed against one node force
// each other's connection down.

import { writeFile } from "node:fs/promises";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { joinOfferFiles, mintShielded } from "@zswap-da/solver-core/offer-files";
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  unshieldedAddressObj,
  unshieldedBalances,
  waitForShielded,
  waitForSync,
} from "@zswap-da/solver-core/wallet";

import { SOLVER_LADDER_CONFIG, SOLVER_SEED } from "../env.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as any);

const NIGHT = "0".repeat(64);
/** Fixed separators shared with the startup mint — same sep, same color. */
const SEP_A = 0xa1;
const SEP_B = 0xb2;
// 1 000 whole coins at the registry's 6 decimals (00024 Q5) — the value is
// unchanged. The ladder rungs below are BASE UNITS and stay that way: the
// solver has no decimals awareness by design, so its dev rungs quote
// millionths of a coin. Quoting in coins is a separate project.
const MINT_AMOUNT = 1_000_000_000n;

/** A dust coin's capacity is tied to the size of the NIGHT UTXO backing it, so
 *  a few large UTXOs are usable immediately where many tiny ones are worthless
 *  for days. See grand-e2e/provision-batcher-dust.ts for the full reasoning. */
const NIGHT_PER_UTXO = 5_000_000_000_000n;
const NIGHT_UTXO_COUNT = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[bootstrap] ${msg}`);

const solver = await buildWallet(SOLVER_SEED);
await waitForSync(solver);
log(`solver wallet synced (seed …${SOLVER_SEED.slice(-4)})`);

const solverNight = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
if (solverNight < NIGHT_PER_UTXO) {
  log(`solver holds ${solverNight} NIGHT — funding from genesis`);
  const genesis = await buildWallet(net.walletSeed);
  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    const available = (await unshieldedBalances(genesis))[NIGHT] ?? 0n;
    const needed = NIGHT_PER_UTXO * BigInt(NIGHT_UTXO_COUNT);
    if (available < needed) {
      throw new Error(`genesis holds ${available} NIGHT, needs ${needed}`);
    }

    const receiver = unshieldedAddressObj(solver);
    const outputs = Array.from({ length: NIGHT_UTXO_COUNT }, () => ({
      type: NIGHT,
      amount: NIGHT_PER_UTXO,
      receiverAddress: receiver as any,
    }));

    let lastErr: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const recipe = await genesis.wallet.transferTransaction(
          [{ type: "unshielded", outputs } as any],
          shieldedKeys(genesis),
          { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
        );
        const signed = await (genesis.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
          genesis.unshieldedKeystore.signDataAsync(p),
        );
        await genesis.wallet.submitTransaction(await genesis.wallet.finalizeRecipe(signed));
        lastErr = undefined;
        break;
      } catch (err) {
        // A transfer spends the previous one's change, which only exists once
        // that transaction confirms; retrying self-synchronises on it.
        lastErr = err;
        await sleep(15_000);
      }
    }
    if (lastErr) throw lastErr;
    log(`sent ${NIGHT_UTXO_COUNT} x ${NIGHT_PER_UTXO} NIGHT to the solver`);
  } finally {
    await (genesis.wallet as any).stop?.().catch(() => {});
  }

  for (let i = 0; i < 36; i++) {
    if (((await unshieldedBalances(solver))[NIGHT] ?? 0n) >= NIGHT_PER_UTXO) break;
    await sleep(5000);
  }
}

await registerNightForDust(solver as any);
log("registered NIGHT for dust");

const deployed = await joinOfferFiles(solver);
const nonceBase = BigInt(Date.now());
const tokenA = await mintShielded(deployed, SEP_A, MINT_AMOUNT, nonceBase);
const tokenB = await mintShielded(deployed, SEP_B, MINT_AMOUNT, nonceBase + 1n);
log(`minted TESTA=${tokenA.slice(0, 10)}… TESTB=${tokenB.slice(0, 10)}…`);

await waitForShielded(solver, tokenA, 1n, 36);
await waitForShielded(solver, tokenB, 1n, 36);
const balances = await shieldedBalances(solver);
log(`solver inventory: TESTA=${balances[tokenA] ?? 0n} TESTB=${balances[tokenB] ?? 0n}`);

// A mild concave curve either way: 1:1 at the smallest size, widening with
// size. Rungs stay well inside the minted inventory so the solver can honour
// every published size.
const levels = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
  { input: "1000000", output: "970000" },
];

const config = {
  tokens: { TESTA: tokenA, TESTB: tokenB },
  refPricesUsd: { TESTA: "1", TESTB: "1" },
  pairs: [
    { tokenIn: "TESTA", tokenOut: "TESTB", levels },
    { tokenIn: "TESTB", tokenOut: "TESTA", levels },
  ],
};

await writeFile(SOLVER_LADDER_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
log(`wrote ${SOLVER_LADDER_CONFIG}`);

process.exit(0);
