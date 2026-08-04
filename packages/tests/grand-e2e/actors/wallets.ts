// Wallet pool + funding fan-out + the offer/settle/cancel executors.
//
// Concurrency model: proving is the cost (HANDOFF gotcha #4) and each wallet
// proves sequentially, so throughput comes from wallet-level parallelism.
// PoolWallet.run() serializes work per wallet; different wallets run freely in
// parallel.
//
// Coin model: the wallet SDK reserves every coin a finalized recipe touches
// (pendingTransactionsService), so a wallet can hold many outstanding offers
// ONLY if each offer draws on a distinct coin. The funding fan-out therefore
// splits every wallet's balance into per-offer denominations (SHIELDED_COIN /
// UNSHIELDED_COIN), and every offer gives strictly less than one coin.
//
// Cancel determinism: a cancel must spend the SAME coin(s) the offer's inputs
// reference. Coin selection is not addressable, so cancel-specialist wallets
// hold ONLY the exact coins the current cancel cycle needs — after revert()
// releases them, any spend of that amount must select them. Cycles regenerate
// their own coin structure (self-transfers of exact denominations), so
// specialists never drift; only the `partial` shape consumes a coin, refilled
// from genesis on demand.

import * as fs from "node:fs";
import type { Client } from "pg";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";
import type { WalletResult } from "@effectstream/midnight-contracts/types";
import { offerHashFromBlob } from "@zswap-da/offer-guard";

import {
  buildWallet,
  shieldedKeys,
  unshieldedAddressObj,
  waitForShielded,
  waitForSync,
  waitForUnshielded,
} from "../../lib/wallet.ts";
import { joinOfferFiles, mintShielded, mintUnshielded } from "../../lib/offer-files.ts";
import { nonDustImbalances, settleViaBatcher } from "../../lib/batcher.ts";
import { reconstructOffer } from "../../lib/api.ts";
import {
  CANCEL_SINGLE_SEED,
  CANCEL_DOUBLE_SEED,
  DIRECT_CELESTIA_EVERY,
  GIVE_MIN,
  GIVE_SPAN,
  INDEX_WAIT_TRIES,
  MAKER_SEEDS,
  MINT_AMOUNT,
  PAIR_PRICE,
  SHIELDED_COIN,
  TAKER_COIN,
  TAKER_SEEDS,
  TOKEN_SEPS,
  TX_TTL_MS,
  UNSHIELDED_COIN,
  type TokenKey,
} from "../config.ts";
import { ledger, type CancelShape, type OfferRecord } from "../ledger.ts";
import { detVar, sleep, waitUntil } from "../lib/util.ts";
import { submitOffer2 } from "../lib/api2.ts";
import { submitBlobRaw } from "../lib/celestia.ts";
import { offerRowByHash } from "../lib/db2.ts";
import { publishToIndexed, submitLatencies } from "../metrics.ts";

const TAG = "[actors]";

// Global proving-concurrency cap. 16+ wallets proving at once storms the
// proof server's connection handling (observed: transient "Transport error"
// on /prove); its throughput is bounded anyway, so queueing client-side
// costs nothing and keeps every request answerable.
const PROVE_SLOTS = 3;
let proveActive = 0;
const proveWaiters: (() => void)[] = [];
async function withProveSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (proveActive >= PROVE_SLOTS) {
    await new Promise<void>((resolve) => proveWaiters.push(resolve));
  }
  proveActive++;
  try {
    return await fn();
  } finally {
    proveActive--;
    proveWaiters.shift()?.();
  }
}

export const isShieldedKey = (k: TokenKey): boolean => k === "TA" || k === "TB";

export class PoolWallet {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly name: string,
    readonly seed: string,
    readonly wr: WalletResult,
    readonly shieldedAddr: unknown,
    readonly unshieldedObj: unknown,
  ) {}

  /** Serialize tasks on this wallet (per-wallet proving). */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
}

export interface Actors {
  genesis: WalletResult;
  genesisPw: PoolWallet;
  deployed: any;
  makers: PoolWallet[];
  cancelSingles: PoolWallet[]; // one-coin wallets (single-one-tx shape)
  cancelDoubles: PoolWallet[]; // two-coin wallets (split/partial/consolidated)
  /** One shielded coin, backing two mutually exclusive offers. */
  competingShielded: PoolWallet;
  /** One unshielded UTXO, backing two mutually exclusive offers. */
  competingUnshielded: PoolWallet;
  takers: PoolWallet[];
}

async function buildPoolWallet(name: string, seedHex: string): Promise<PoolWallet> {
  const wr = await buildWallet(seedHex);
  await waitForSync(wr).catch(() => {});
  const shieldedAddr = await wr.wallet.shielded.getAddress();
  return new PoolWallet(name, seedHex, wr, shieldedAddr, unshieldedAddressObj(wr));
}

// Extra single/double cancel specialists beyond the two named config seeds —
// four wallets keep 100 cancel cycles inside the storm window.
const CANCEL_SINGLE_SEEDS = [CANCEL_SINGLE_SEED, "c2".padStart(64, "0")];
const CANCEL_DOUBLE_SEEDS = [CANCEL_DOUBLE_SEED, "c3".padStart(64, "0")];

// Competing-offer specialists: each holds EXACTLY ONE coin/UTXO, so two
// offers built from it are guaranteed to select the same input and therefore
// share a nullifier (or unshielded spend ref). Any wallet with a choice of
// coins would silently pick a different one and the offers would not compete.
const COMPETING_SHIELDED_SEED = "e0".padStart(64, "0");
const COMPETING_UNSHIELDED_SEED = "e1".padStart(64, "0");

export const CANCEL_COIN = 1000n; // exact denomination the cancel cycles use
export const COMPETING_COIN = 1500n; // the single coin two competing offers share

/** Give color per specialist: singles use TA/TB, doubles use TB/TA. */
export const cancelGiveToken = (kind: "single" | "double", i: number): TokenKey =>
  kind === "single" ? (i === 0 ? "TA" : "TB") : i === 0 ? "TB" : "TA";
export const cancelWantToken = (give: TokenKey): TokenKey => (give === "TA" ? "TB" : "TA");

// ── Low-level transfer helpers ───────────────────────────────────────────────

/** Self-transfer exact denominations via the batcher (maker pays no fees).
 *  `outputs` may mix colors of the SAME value layer in one tx. With
 *  wait=false the tx is queued ("no-wait") — bulk funding flows submit
 *  everything and then drain the batcher queue once; fate-critical spends
 *  (cancel cycles) keep wait=true for receipt ordering. */
export async function selfSplit(
  pw: PoolWallet,
  shielded: boolean,
  outputs: { color: string; amount: bigint }[],
  wait = true,
): Promise<void> {
  const outs = outputs.map((o) => ({
    type: o.color,
    amount: o.amount,
    receiverAddress: shielded ? pw.shieldedAddr : pw.unshieldedObj,
  }));
  const recipe = await pw.wr.wallet.transferTransaction(
    [{ type: shielded ? "shielded" : "unshielded", outputs: outs } as any],
    shieldedKeys(pw.wr),
    { ttl: new Date(Date.now() + TX_TTL_MS), payFees: false },
  );
  let tx: any;
  try {
    const maybeSigned = shielded
      ? recipe
      : await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
          pw.wr.unshieldedKeystore.signData(p),
        );
    tx = await withProveSlot(() => pw.wr.wallet.finalizeRecipe(maybeSigned));
  } catch (e) {
    // Release the recipe's coin reservations so a retry can select them.
    await (pw.wr.wallet as any).revert(recipe).catch(() => {});
    throw e;
  }
  if (nonDustImbalances(tx as any).length > 0) {
    throw new Error(`${pw.name} selfSplit produced non-dust imbalance`);
  }
  const res = await submitToBalancer(
    tx,
    wait
      ? { level: "wait-receipt", timeoutMs: 900_000, serverTimeoutMs: 600_000 }
      : { level: "no-wait", timeoutMs: 300_000 },
  );
  if (!res.ok) throw new Error(`${pw.name} selfSplit batcher: ${JSON.stringify(res.body).slice(0, 300)}`);
}

// All /send-input calls are serialized through one client-side chain. The
// batcher's HTTP server shares its event loop with in-process balancing work,
// so concurrent POSTs can sit unanswered long enough to hit any sane fetch
// timeout — and the single worker means concurrency buys nothing anyway.
// no-wait submissions get one retry on a transport timeout: if the first
// attempt actually landed, the duplicate tx fails on-chain inside the batcher
// (same inputs already spent) without affecting wallet state.
let balancerChain: Promise<unknown> = Promise.resolve();
export function submitToBalancer(
  tx: any,
  opts: { level: "no-wait" | "wait-receipt"; timeoutMs: number; serverTimeoutMs?: number },
): Promise<{ ok: boolean; status: number; body: any }> {
  const attempt = async () => settleViaBatcher(tx as any, opts);
  const job = balancerChain.then(async () => {
    try {
      return await attempt();
    } catch (e) {
      if (opts.level === "no-wait") {
        console.warn(`${TAG} no-wait submit timed out — retrying once (${e instanceof Error ? e.message : e})`);
        await sleep(30_000);
        return await attempt();
      }
      throw e;
    }
  });
  balancerChain = job.catch(() => {});
  return job;
}

/** Wait for the batcher's midnight-balancer queue to fully drain — used after
 *  bulk no-wait submissions. The batcher runs ONE worker (~25 s/tx), so bulk
 *  flows queue everything and wait once here instead of per-tx. */
export async function drainBatcherQueue(label: string, timeoutMs = 60 * 60_000): Promise<void> {
  const { BATCHER_URL } = await import("../config.ts");
  const deadline = Date.now() + timeoutMs;
  let quietStreak = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BATCHER_URL}/queue-stats`, { signal: AbortSignal.timeout(5000) });
      const j: any = await r.json();
      const pending = Number(j?.totalPendingInputs ?? -1);
      if (pending === 0) {
        quietStreak++;
        if (quietStreak >= 3) return; // 3 consecutive empty samples ≈ drained
      } else {
        quietStreak = 0;
        console.log(`${TAG} drain(${label}): ${pending} pending in batcher queue…`);
      }
    } catch {
      quietStreak = 0;
    }
    await sleep(10_000);
  }
  throw new Error(`drainBatcherQueue(${label}) timed out after ${timeoutMs / 60000} min`);
}

/** One genesis transfer tx (genesis pays fees). Reverts on any failure so a
 *  retry can reselect the coins. */
async function genesisTransferOnce(
  genesis: WalletResult,
  shielded: boolean,
  color: string,
  outputs: { receiverAddress: unknown; amount: bigint }[],
): Promise<void> {
  const recipe = await genesis.wallet.transferTransaction(
    [
      {
        type: shielded ? "shielded" : "unshielded",
        outputs: outputs.map((o) => ({ type: color, amount: o.amount, receiverAddress: o.receiverAddress })),
      } as any,
    ],
    shieldedKeys(genesis),
    { ttl: new Date(Date.now() + TX_TTL_MS), payFees: true },
  );
  try {
    const maybeSigned = shielded
      ? recipe
      : await (genesis.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
          genesis.unshieldedKeystore.signData(p),
        );
    const finalized = await withProveSlot(() => genesis.wallet.finalizeRecipe(maybeSigned));
    try {
      await genesis.wallet.submitTransaction(finalized);
    } catch (e) {
      await (genesis.wallet as any).revert(finalized).catch(() => {});
      throw e;
    }
  } catch (e) {
    await (genesis.wallet as any).revert(recipe).catch(() => {});
    throw e;
  }
}

/**
 * Genesis → many recipients, chunked ≤12 outputs per tx. Bigger fan-out txs
 * are rejected by the node (Invalid Transaction: Custom error: 170 observed
 * at 26 outputs; 12 is repeatedly fine). Chunks after the first spend the
 * previous chunk's change, which only exists once that tx confirms and the
 * wallet syncs — the retry loop self-synchronizes on that (InsufficientFunds
 * simply means "change not visible yet").
 */
async function genesisFanOut(
  genesis: WalletResult,
  shielded: boolean,
  color: string,
  outputs: { receiverAddress: unknown; amount: bigint }[],
): Promise<void> {
  const FAN_CHUNK = 12;
  for (let i = 0; i < outputs.length; i += FAN_CHUNK) {
    const chunk = outputs.slice(i, i + FAN_CHUNK);
    let lastErr: unknown;
    let done = false;
    for (let attempt = 0; attempt < 20 && !done; attempt++) {
      try {
        await genesisTransferOnce(genesis, shielded, color, chunk);
        done = true;
      } catch (e) {
        lastErr = e;
        console.warn(
          `${TAG} genesis fan-out chunk ${i / FAN_CHUNK + 1}/${Math.ceil(outputs.length / FAN_CHUNK)} retry ${attempt + 1}: ` +
            `${e instanceof Error ? e.message : e}`,
        );
        await sleep(15_000);
      }
    }
    if (!done) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

// ── Setup: build, mint, fund, split ─────────────────────────────────────────

export interface FundingPlan {
  makerShieldedCoins: number;
  makerUnshieldedCoins: number;
  takerCoinsPerColor: number;
}

export function defaultFundingPlan(totalOffers: number): FundingPlan {
  // Size to what the run ACTUALLY spends, not to a fixed ceiling.
  //
  // This used to mint 432 coins for a 25-offer run: `takerCoinsPerColor` was a
  // flat 12 (6 takers x 4 colors x 12 = 288 coins) and the maker figures had a
  // +6 floor that dominated once the per-maker share dropped to ~3 offers.
  // Genesis has only a handful of NIGHT UTXOs to draw on, so 432 coins meant
  // ~36 sequential fan-out chunks, each spending the previous chunk's
  // unconfirmed change — which is the entire source of the benign-but-noisy
  // "Insufficient funds" retries in setup.
  //
  // Coins are consumed one per offer built, and settled/cancelled coins
  // recycle on-chain, so the real need is (offers this wallet makes) plus a
  // small working set for offers in flight.
  const makers = MAKER_SEEDS.length;
  const takers = TAKER_SEEDS.length;
  const perMaker = Math.ceil(totalOffers / makers);
  // Takers spend one coin per settlement they perform, in the want-color only.
  const settlements = Math.ceil(totalOffers * 0.4);
  return {
    makerShieldedCoins: Math.ceil(perMaker * 0.6) + 2,
    makerUnshieldedCoins: Math.ceil(perMaker * 0.4) + 2,
    takerCoinsPerColor: Math.ceil(settlements / takers) + 2,
  };
}

export async function setupActors(totalOffers: number): Promise<Actors> {
  setNetworkId(net.id as any);
  (globalThis as any).WebSocket = WebSocket;

  console.log(`${TAG} building genesis…`);
  const genesis = await buildWallet(net.walletSeed);
  await waitForSync(genesis, { requireUnshieldedFunds: true });
  try {
    await registerNightForDust(genesis as any);
  } catch (e) {
    console.warn(`${TAG} registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`);
  }
  const genesisPw = new PoolWallet(
    "genesis",
    net.walletSeed,
    genesis,
    await genesis.wallet.shielded.getAddress(),
    unshieldedAddressObj(genesis),
  );

  console.log(`${TAG} joining offer-files contract + minting 4 colors…`);
  const deployed = await joinOfferFiles(genesis);
  const nonce = BigInt(Date.now());
  ledger.colors.TA = await mintShielded(deployed, TOKEN_SEPS.TA, MINT_AMOUNT, nonce);
  ledger.colors.TB = await mintShielded(deployed, TOKEN_SEPS.TB, MINT_AMOUNT, nonce + 1n);
  ledger.colors.UA = await mintUnshielded(deployed, TOKEN_SEPS.UA, MINT_AMOUNT, genesis.unshieldedAddress);
  ledger.colors.UB = await mintUnshielded(deployed, TOKEN_SEPS.UB, MINT_AMOUNT, genesis.unshieldedAddress);
  console.log(`${TAG} colors:`, JSON.stringify(ledger.colors));

  for (const key of ["TA", "TB"] as const) {
    const got = await waitForShielded(genesis, ledger.colors[key]!, MINT_AMOUNT, 36);
    if (got < MINT_AMOUNT) throw new Error(`genesis missing shielded mint ${key}`);
  }
  for (const key of ["UA", "UB"] as const) {
    const got = await waitForUnshielded(genesis, ledger.colors[key]!, MINT_AMOUNT, 36);
    if (got < MINT_AMOUNT) throw new Error(`genesis missing unshielded mint ${key}`);
  }

  console.log(`${TAG} building ${MAKER_SEEDS.length} makers + 4 cancel specialists + ${TAKER_SEEDS.length} takers…`);
  const makers = await Promise.all(MAKER_SEEDS.map((s, i) => buildPoolWallet(`M${i}`, s)));
  const cancelSingles = await Promise.all(CANCEL_SINGLE_SEEDS.map((s, i) => buildPoolWallet(`CS${i}`, s)));
  const cancelDoubles = await Promise.all(CANCEL_DOUBLE_SEEDS.map((s, i) => buildPoolWallet(`CD${i}`, s)));
  const takers = await Promise.all(TAKER_SEEDS.map((s, i) => buildPoolWallet(`T${i}`, s)));
  const competingShielded = await buildPoolWallet("CMP-S", COMPETING_SHIELDED_SEED);
  const competingUnshielded = await buildPoolWallet("CMP-U", COMPETING_UNSHIELDED_SEED);

  const plan = defaultFundingPlan(totalOffers);
  // FUNDING: genesis emits the FINAL per-offer denominations directly.
  //
  // Earlier this was two-stage — genesis granted a large coin, then each
  // wallet split it into per-offer coins. Those split txs pay no fees, so they
  // went through the batcher, and at ~100+ of them the batcher exhausted its
  // dust and livelocked (see ISSUES.md: it retries a balance it predicts will
  // fail, forever, draining nothing). Funding a test fixture must not depend
  // on the component under test having spare fee capacity.
  //
  // Genesis pays its own fees and holds the dust to do it, so emitting the
  // final denominations from genesis removes the batcher from setup entirely.
  // It costs more genesis transactions — chunked below — but they are
  // independent of batcher health and of each other's timing.
  interface Grant {
    pw: PoolWallet;
    key: TokenKey;
    denom: bigint;
    coins: number;
  }
  const grants: Grant[] = [];
  makers.forEach((m, i) => {
    grants.push({ pw: m, key: i % 2 === 0 ? "TA" : "TB", denom: SHIELDED_COIN, coins: plan.makerShieldedCoins });
    grants.push({ pw: m, key: i % 2 === 0 ? "UA" : "UB", denom: UNSHIELDED_COIN, coins: plan.makerUnshieldedCoins });
  });
  takers.forEach((t) => {
    for (const key of ["TA", "TB", "UA", "UB"] as const) {
      grants.push({ pw: t, key, denom: TAKER_COIN, coins: plan.takerCoinsPerColor });
    }
  });

  const outsByKey: Record<TokenKey, { receiverAddress: unknown; amount: bigint }[]> = { TA: [], TB: [], UA: [], UB: [] };
  for (const g of grants) {
    const addr = isShieldedKey(g.key) ? g.pw.shieldedAddr : g.pw.unshieldedObj;
    for (let c = 0; c < g.coins; c++) {
      outsByKey[g.key].push({ receiverAddress: addr, amount: g.denom });
    }
  }
  // Specialists hold EXACT coin counts so their coin selection has no freedom:
  // cancel singles one coin, cancel doubles two, competing wallets exactly one.
  cancelSingles.forEach((c, i) =>
    outsByKey[cancelGiveToken("single", i)].push({ receiverAddress: c.shieldedAddr, amount: CANCEL_COIN }),
  );
  cancelDoubles.forEach((c, i) => {
    const key = cancelGiveToken("double", i);
    outsByKey[key].push({ receiverAddress: c.shieldedAddr, amount: CANCEL_COIN });
    outsByKey[key].push({ receiverAddress: c.shieldedAddr, amount: CANCEL_COIN });
  });
  outsByKey.TA.push({ receiverAddress: competingShielded.shieldedAddr, amount: COMPETING_COIN });
  outsByKey.UA.push({ receiverAddress: competingUnshielded.unshieldedObj, amount: COMPETING_COIN });

  const totalOuts = Object.values(outsByKey).reduce((n, a) => n + a.length, 0);
  console.log(`${TAG} funding fan-out: ${totalOuts} coins direct from genesis (no batcher)…`);
  await genesisFanOut(genesis, true, ledger.colors.TA!, outsByKey.TA);
  await genesisFanOut(genesis, true, ledger.colors.TB!, outsByKey.TB);
  await genesisFanOut(genesis, false, ledger.colors.UA!, outsByKey.UA);
  await genesisFanOut(genesis, false, ledger.colors.UB!, outsByKey.UB);

  // Confirm every wallet actually holds what it was granted before any offer
  // is built — a missing coin here surfaces as a confusing build failure later.
  console.log(`${TAG} verifying balances landed…`);
  const expect: { pw: PoolWallet; key: TokenKey; total: bigint }[] = grants.map((g) => ({
    pw: g.pw,
    key: g.key,
    total: g.denom * BigInt(g.coins),
  }));
  cancelSingles.forEach((c, i) => expect.push({ pw: c, key: cancelGiveToken("single", i), total: CANCEL_COIN }));
  cancelDoubles.forEach((c, i) => expect.push({ pw: c, key: cancelGiveToken("double", i), total: CANCEL_COIN * 2n }));
  expect.push({ pw: competingShielded, key: "TA", total: COMPETING_COIN });
  expect.push({ pw: competingUnshielded, key: "UA", total: COMPETING_COIN });

  const landed = await Promise.allSettled(
    expect.map(async (e) => {
      const color = ledger.colors[e.key]!;
      const got = isShieldedKey(e.key)
        ? await waitForShielded(e.pw.wr, color, e.total, 60)
        : await waitForUnshielded(e.pw.wr, color, e.total, 60);
      if (got < e.total) throw new Error(`${e.pw.name}/${e.key}: ${got} < ${e.total}`);
    }),
  );
  const short = landed.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (short.length > 0) {
    throw new Error(`funding did not land for ${short.length} wallet/color pairs: ${short[0]!.reason}`);
  }
  console.log(`${TAG} funding complete (${totalOuts} coins, batcher untouched).`);
  return { genesis, genesisPw, deployed, makers, cancelSingles, cancelDoubles, competingShielded, competingUnshielded, takers };
}

// ── Offer construction / publication ─────────────────────────────────────────

export interface BuiltOffer {
  blob: string;
  hash: string;
  finalized: any;
}

/** Deterministic give/want amounts for offer index i. */
export function amountsFor(index: number, giveToken: TokenKey, wantToken: TokenKey): { give: bigint; want: bigint } {
  const give = GIVE_MIN + BigInt(detVar(index, Number(GIVE_SPAN)));
  const price = PAIR_PRICE[`${giveToken}>${wantToken}`] ?? 1;
  const wiggle = 0.95 + detVar(index, 100, 7) / 1000; // ±5%
  const want = BigInt(Math.max(1, Math.round(Number(give) * price * wiggle)));
  return { give, want };
}

/** Build (prove) an offer on the maker's wallet. Serialized via pw.run().
 *  Retries a few times — a just-settled cancel/settle may not have synced its
 *  replacement coin into the wallet state yet. */
export async function buildOffer(pw: PoolWallet, rec: OfferRecord, tries = 10): Promise<BuiltOffer> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await buildOfferOnce(pw, rec);
    } catch (e) {
      lastErr = e;
      await sleep(10_000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function buildOfferOnce(pw: PoolWallet, rec: OfferRecord): Promise<BuiltOffer> {
  return pw.run(async () => {
    const giveShielded = isShieldedKey(rec.giveToken);
    const wantShielded = isShieldedKey(rec.wantToken);
    const giveColor = ledger.colors[rec.giveToken]!;
    const wantColor = ledger.colors[rec.wantToken]!;
    // Give and want are always on the SAME value layer: cross-layer
    // (shielded↔unshielded) swaps are not a supported offer shape, so the
    // suite never constructs one. See ISSUES.md for why the earlier
    // cross-layer attempt produced a confusing NOT_A_SWAP rather than a
    // clear refusal.
    const desiredInputs = giveShielded
      ? { shielded: { [giveColor]: BigInt(rec.giveAmount) } }
      : ({ unshielded: { [giveColor]: BigInt(rec.giveAmount) } } as any);
    const desiredOutputs = [
      {
        type: wantShielded ? "shielded" : "unshielded",
        outputs: [
          {
            type: wantColor,
            amount: BigInt(rec.wantAmount),
            receiverAddress: wantShielded ? pw.shieldedAddr : pw.unshieldedObj,
          },
        ],
      } as any,
    ];
    const recipe = await pw.wr.wallet.initSwap(desiredInputs, desiredOutputs, shieldedKeys(pw.wr), {
      ttl: new Date(Date.now() + TX_TTL_MS),
      payFees: false,
    });
    let finalized: any;
    try {
      if (giveShielded) {
        try {
          finalized = await withProveSlot(() => pw.wr.wallet.finalizeTransaction(recipe.transaction));
        } catch {
          // Mixed offers (unshielded want) may need the recipe/signing path.
          const signed = await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
            pw.wr.unshieldedKeystore.signData(p),
          );
          finalized = await withProveSlot(() => pw.wr.wallet.finalizeRecipe(signed));
        }
      } else {
        const signed = await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
          pw.wr.unshieldedKeystore.signData(p),
        );
        finalized = await withProveSlot(() => pw.wr.wallet.finalizeRecipe(signed));
      }
    } catch (e) {
      // Release reservations so buildOffer's retry can reselect the coins.
      await (pw.wr.wallet as any).revert(recipe).catch(() => {});
      throw e;
    }
    const blob = OfferFiles.encode(finalized.serialize());

    // Validate what we actually built, at the source. The wallet SDK can
    // return a transaction that silently omits a requested leg — an
    // unshielded desired output next to a shielded input is accepted, then
    // dropped, with no error (see ISSUES.md "mixed offers"). Without this
    // guard the offer looks fine locally and only dies much later as an
    // opaque NOT_A_SWAP at ingestion, attributed to the indexer rather than
    // to construction. Failing here instead makes buildOffer's retry loop
    // surface the real reason.
    const built = validateZswapOffer(blob, {
      refState: getBlankRefState(net.id),
      tblock: new Date(),
      maxBytes: 1024 * 1024,
      crypto: "defer", // proofs are the node's job; we only check structure
    });
    if (!built.ok) {
      throw new Error(
        `offer#${rec.index} (${rec.layer} ${rec.giveToken}->${rec.wantToken}) built INVALID: ` +
          `${built.code} — ${built.reason} ` +
          `[gives=${JSON.stringify(built.gives ?? [])} wants=${JSON.stringify(built.wants ?? [])}]`,
      );
    }

    const hash = offerHashFromBlob(blob);
    rec.hasFillMarkers = wantShielded;
    return { blob, hash, finalized };
  });
}

/** Publish via the planned path and wait for the offer_file row. */
export async function publishAndIndex(
  db: Client,
  rec: OfferRecord,
  built: BuiltOffer,
  opts: { indexTries?: number } = {},
): Promise<boolean> {
  rec.offerHash = built.hash;
  rec.blobChars = built.blob.length;
  rec.submittedAt = Date.now();

  if (rec.publishPath === "celestia") {
    try {
      rec.celestiaHeight = await submitBlobRaw(OfferFiles.decode(built.blob));
    } catch (e) {
      ledger.markCasualty(rec, `blob.Submit failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  } else {
    const started = Date.now();
    let sub = await submitOffer2(built.blob);
    for (
      let r = 0;
      r < 24 &&
      sub.status === 400 &&
      (sub.body?.error === "ROOT_UNKNOWN" || sub.body?.error === "UTXO_NOT_LIVE");
      r++
    ) {
      await sleep(5000); // root/UTXO propagation — same retry as stm/api.test.ts
      sub = await submitOffer2(built.blob);
    }
    submitLatencies.push(Date.now() - started);
    if (sub.status !== 200) {
      ledger.markCasualty(rec, `submit gate: ${sub.status} ${JSON.stringify(sub.body).slice(0, 200)}`);
      return false;
    }
  }
  rec.state = "published";

  const indexed = await waitUntil(
    `offer#${rec.index} indexed`,
    async () => (await offerRowByHash(db, built.hash)) !== null,
    opts.indexTries ?? INDEX_WAIT_TRIES,
    5000,
  );
  if (!indexed) {
    ledger.markCasualty(rec, "published but never indexed (see offer_rejections)");
    return false;
  }
  const row = await offerRowByHash(db, built.hash);
  rec.rowId = row!.id;
  rec.celestiaHeight = rec.celestiaHeight ?? Number(row!.celestia_height);
  rec.indexedAt = Date.now();
  rec.state = "indexed";
  ledger.rowIdToHash.set(row!.id, built.hash);
  publishToIndexed.push(rec.indexedAt - rec.submittedAt!);
  return true;
}

/** Every-Nth offers go via direct Celestia (path-B at scale). */
export function pickPublishPath(index: number): "api" | "celestia" {
  return index % DIRECT_CELESTIA_EVERY === 0 ? "celestia" : "api";
}

// ── Taker settle ─────────────────────────────────────────────────────────────

export async function settleOffer(taker: PoolWallet, rec: OfferRecord, blob: string): Promise<void> {
  await taker.run(async () => {
    const offerTx = reconstructOffer(blob);
    const kinds = new Set<string>();
    kinds.add(isShieldedKey(rec.giveToken) ? "shielded" : "unshielded");
    kinds.add(isShieldedKey(rec.wantToken) ? "shielded" : "unshielded");
    const balRecipe = await (taker.wr.wallet as any).balanceFinalizedTransaction(
      offerTx,
      shieldedKeys(taker.wr),
      { ttl: new Date(Date.now() + TX_TTL_MS), tokenKindsToBalance: [...kinds] },
    );
    let settleTx: any;
    try {
      let recipe = balRecipe;
      if (kinds.has("unshielded")) {
        recipe = await (taker.wr.wallet as any).signRecipe(balRecipe, (p: Uint8Array) =>
          taker.wr.unshieldedKeystore.signData(p),
        );
      }
      settleTx = await withProveSlot(() => taker.wr.wallet.finalizeRecipe(recipe));
    } catch (e) {
      await (taker.wr.wallet as any).revert(balRecipe).catch(() => {});
      throw e;
    }
    const bad = nonDustImbalances(settleTx as any);
    if (bad.length > 0) throw new Error(`settle offer#${rec.index}: non-dust imbalance after balancing`);
    // Long timeouts: the single-worker batcher (~25 s/tx) can hold a settle
    // behind a deep queue; the client must outlast it, not give up.
    const res = await submitToBalancer(settleTx, {
      level: "wait-receipt",
      timeoutMs: 900_000,
      serverTimeoutMs: 600_000,
    });
    if (!res.ok) throw new Error(`settle offer#${rec.index}: batcher ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  });
}

// ── Cancel cycles ────────────────────────────────────────────────────────────

/** Spend `amounts` of the specialist's give color to self in one tx.
 *  wait-receipt on purpose: the split-two-tx shape needs tx1 confirmed before
 *  tx2 to guarantee the spends land in separate transactions. */
async function cancelSpend(pw: PoolWallet, giveToken: TokenKey, amounts: bigint[]): Promise<void> {
  const color = ledger.colors[giveToken]!;
  await selfSplit(pw, isShieldedKey(giveToken), amounts.map((amount) => ({ color, amount })), true);
}

/**
 * One full cancel cycle on a specialist wallet. Regenerates the wallet's coin
 * structure, so cycles chain indefinitely. `refill` is invoked for the
 * `partial` shape (the one shape that permanently consumes a coin).
 */
export async function runCancelCycle(
  db: Client,
  pw: PoolWallet,
  rec: OfferRecord,
  shape: CancelShape,
  refill: () => Promise<void>,
): Promise<boolean> {
  const built = await buildOffer(pw, rec);
  // Store it like every other publish path: the p7b audit reads every ledger
  // offer's blob back to check its status, and a missing file aborts the whole
  // audit with ENOENT rather than failing one assertion.
  storeBlob(built.hash, built.blob);
  const ok = await publishAndIndex(db, rec, built);
  if (!ok) return false;

  // Release the offer's coins so the cancel spends can select them.
  await pw.run(async () => {
    await (pw.wr.wallet as any).revert(built.finalized);
  });

  switch (shape) {
    case "single-one-tx":
      await pw.run(() => cancelSpend(pw, rec.giveToken, [CANCEL_COIN]));
      break;
    case "split-two-tx":
      await pw.run(() => cancelSpend(pw, rec.giveToken, [CANCEL_COIN]));
      await pw.run(() => cancelSpend(pw, rec.giveToken, [CANCEL_COIN]));
      break;
    case "consolidated-one-tx":
      await pw.run(() => cancelSpend(pw, rec.giveToken, [CANCEL_COIN, CANCEL_COIN]));
      break;
    case "partial":
      await pw.run(() => cancelSpend(pw, rec.giveToken, [CANCEL_COIN]));
      await refill();
      break;
  }
  rec.resolvedAt = Date.now();
  rec.state = "resolved";
  return true;
}

/** Genesis-side refill of one exact cancel coin (partial shape only). */
export function makeRefill(genesisPw: PoolWallet, target: PoolWallet, giveToken: TokenKey): () => Promise<void> {
  return () =>
    genesisPw.run(async () => {
      await genesisFanOut(genesisPw.wr, true, ledger.colors[giveToken]!, [
        { receiverAddress: target.shieldedAddr, amount: CANCEL_COIN },
      ]);
      // Wait until the coin lands so the next cycle can select it.
      await waitForShielded(target.wr, ledger.colors[giveToken]!, CANCEL_COIN, 24);
    });
}

export async function stopActors(a: Actors): Promise<void> {
  const all = [a.genesis, ...[...a.makers, ...a.cancelSingles, ...a.cancelDoubles, a.competingShielded, a.competingUnshielded, ...a.takers].map((p) => p.wr)];
  for (const wr of all) await wr.wallet.stop().catch(() => {});
}

/** Persist the give-blob of each offer so cancels/settles can rebuild txs and
 *  the audit can recompute hashes without keeping every blob in memory. */
export function blobStorePath(): string {
  const dir = new URL("../out/blobs/", import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function storeBlob(hash: string, blob: string): void {
  fs.writeFileSync(`${blobStorePath()}${hash}.bech32`, blob);
}

export function loadBlob(hash: string): string {
  return fs.readFileSync(`${blobStorePath()}${hash}.bech32`, "utf-8");
}
