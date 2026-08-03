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

export const CANCEL_COIN = 1000n; // exact denomination the cancel cycles use

/** Give color per specialist: singles use TA/TB, doubles use TB/TA. */
export const cancelGiveToken = (kind: "single" | "double", i: number): TokenKey =>
  kind === "single" ? (i === 0 ? "TA" : "TB") : i === 0 ? "TB" : "TA";
export const cancelWantToken = (give: TokenKey): TokenKey => (give === "TA" ? "TB" : "TA");

// ── Low-level transfer helpers ───────────────────────────────────────────────

/** Self-transfer exact denominations via the batcher (maker pays no fees). */
export async function selfSplit(
  pw: PoolWallet,
  tokenKey: TokenKey,
  color: string,
  amounts: bigint[],
): Promise<void> {
  const shielded = isShieldedKey(tokenKey);
  const outputs = amounts.map((amount) => ({
    type: color,
    amount,
    receiverAddress: shielded ? pw.shieldedAddr : pw.unshieldedObj,
  }));
  const recipe = await pw.wr.wallet.transferTransaction(
    [{ type: shielded ? "shielded" : "unshielded", outputs } as any],
    shieldedKeys(pw.wr),
    { ttl: new Date(Date.now() + TX_TTL_MS), payFees: false },
  );
  const maybeSigned = shielded
    ? recipe
    : await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
        pw.wr.unshieldedKeystore.signData(p),
      );
  const tx = await pw.wr.wallet.finalizeRecipe(maybeSigned);
  if (nonDustImbalances(tx as any).length > 0) {
    throw new Error(`${pw.name} selfSplit(${tokenKey}) produced non-dust imbalance`);
  }
  const res = await settleViaBatcher(tx as any);
  if (!res.ok) throw new Error(`${pw.name} selfSplit(${tokenKey}) batcher: ${JSON.stringify(res.body).slice(0, 300)}`);
}

/** Genesis → many recipients in ONE shielded tx (genesis pays fees). */
async function transferShieldedMany(
  genesis: WalletResult,
  color: string,
  outputs: { receiverAddress: unknown; amount: bigint }[],
): Promise<void> {
  const recipe = await genesis.wallet.transferTransaction(
    [
      {
        type: "shielded",
        outputs: outputs.map((o) => ({ type: color, amount: o.amount, receiverAddress: o.receiverAddress })),
      } as any,
    ],
    shieldedKeys(genesis),
    { ttl: new Date(Date.now() + TX_TTL_MS), payFees: true },
  );
  const finalized = await genesis.wallet.finalizeRecipe(recipe);
  await genesis.wallet.submitTransaction(finalized);
}

/** Genesis → many recipients in ONE unshielded tx. */
async function transferUnshieldedMany(
  genesis: WalletResult,
  color: string,
  outputs: { receiverAddress: unknown; amount: bigint }[],
): Promise<void> {
  const recipe = await genesis.wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: outputs.map((o) => ({ type: color, amount: o.amount, receiverAddress: o.receiverAddress })),
      } as any,
    ],
    shieldedKeys(genesis),
    { ttl: new Date(Date.now() + TX_TTL_MS), payFees: true },
  );
  const signed = await (genesis.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
    genesis.unshieldedKeystore.signData(p),
  );
  const finalized = await genesis.wallet.finalizeRecipe(signed);
  await genesis.wallet.submitTransaction(finalized);
}

// ── Setup: build, mint, fund, split ─────────────────────────────────────────

export interface FundingPlan {
  makerShieldedCoins: number;
  makerUnshieldedCoins: number;
  takerCoinsPerColor: number;
}

export function defaultFundingPlan(totalOffers: number): FundingPlan {
  const perMaker = Math.ceil(totalOffers / MAKER_SEEDS.length);
  return {
    makerShieldedCoins: Math.ceil(perMaker * 0.75) + 8,
    makerUnshieldedCoins: Math.ceil(perMaker * 0.5) + 8,
    takerCoinsPerColor: 14,
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

  const plan = defaultFundingPlan(totalOffers);
  const makerShTotal = SHIELDED_COIN * BigInt(plan.makerShieldedCoins);
  const makerUnTotal = UNSHIELDED_COIN * BigInt(plan.makerUnshieldedCoins);
  const takerTotal = TAKER_COIN * BigInt(plan.takerCoinsPerColor);

  // Shielded fan-out: one genesis tx per color funds everyone at once.
  // Makers alternate primary give color (even→TA, odd→TB); takers get both.
  console.log(`${TAG} funding fan-out (shielded)…`);
  const taOuts: { receiverAddress: unknown; amount: bigint }[] = [];
  const tbOuts: { receiverAddress: unknown; amount: bigint }[] = [];
  makers.forEach((m, i) => (i % 2 === 0 ? taOuts : tbOuts).push({ receiverAddress: m.shieldedAddr, amount: makerShTotal }));
  cancelSingles.forEach((c, i) =>
    (cancelGiveToken("single", i) === "TA" ? taOuts : tbOuts).push({ receiverAddress: c.shieldedAddr, amount: CANCEL_COIN }),
  );
  cancelDoubles.forEach((c, i) =>
    (cancelGiveToken("double", i) === "TA" ? taOuts : tbOuts).push({ receiverAddress: c.shieldedAddr, amount: CANCEL_COIN * 2n }),
  );
  for (const t of takers) {
    taOuts.push({ receiverAddress: t.shieldedAddr, amount: takerTotal });
    tbOuts.push({ receiverAddress: t.shieldedAddr, amount: takerTotal });
  }
  await transferShieldedMany(genesis, ledger.colors.TA!, taOuts);
  await transferShieldedMany(genesis, ledger.colors.TB!, tbOuts);

  console.log(`${TAG} funding fan-out (unshielded)…`);
  const uaOuts: { receiverAddress: unknown; amount: bigint }[] = [];
  const ubOuts: { receiverAddress: unknown; amount: bigint }[] = [];
  makers.forEach((m, i) => (i % 2 === 0 ? uaOuts : ubOuts).push({ receiverAddress: m.unshieldedObj, amount: makerUnTotal }));
  for (const t of takers) {
    uaOuts.push({ receiverAddress: t.unshieldedObj, amount: takerTotal });
    ubOuts.push({ receiverAddress: t.unshieldedObj, amount: takerTotal });
  }
  await transferUnshieldedMany(genesis, ledger.colors.UA!, uaOuts);
  await transferUnshieldedMany(genesis, ledger.colors.UB!, ubOuts);

  // Wait for funds to land, then self-split into per-offer coins in parallel.
  console.log(`${TAG} waiting for funds + self-splitting into per-offer coins…`);
  const splitCap = 25; // outputs per split tx — bounds proving time per tx
  const splitInto = async (pw: PoolWallet, key: TokenKey, coin: bigint, count: number, expectTotal: bigint) => {
    const color = ledger.colors[key]!;
    const landed = isShieldedKey(key)
      ? await waitForShielded(pw.wr, color, expectTotal, 60)
      : await waitForUnshielded(pw.wr, color, expectTotal, 60);
    if (landed < expectTotal) throw new Error(`${pw.name} funding of ${key} did not land (${landed}/${expectTotal})`);
    for (let done = 0; done < count; done += splitCap) {
      const n = Math.min(splitCap, count - done);
      await pw.run(() => selfSplit(pw, key, color, Array.from({ length: n }, () => coin)));
    }
  };

  const splitJobs: Promise<void>[] = [];
  makers.forEach((m, i) => {
    splitJobs.push(splitInto(m, i % 2 === 0 ? "TA" : "TB", SHIELDED_COIN, plan.makerShieldedCoins - 1, makerShTotal));
    splitJobs.push(splitInto(m, i % 2 === 0 ? "UA" : "UB", UNSHIELDED_COIN, plan.makerUnshieldedCoins - 1, makerUnTotal));
  });
  takers.forEach((t) => {
    for (const key of ["TA", "TB", "UA", "UB"] as const) {
      splitJobs.push(splitInto(t, key, TAKER_COIN, plan.takerCoinsPerColor - 1, takerTotal));
    }
  });
  // Cancel specialists were funded with exact denominations already — the
  // double wallets just split their 2× grant into two exact coins.
  cancelDoubles.forEach((c, i) => {
    splitJobs.push(splitInto(c, cancelGiveToken("double", i), CANCEL_COIN, 2, CANCEL_COIN * 2n));
  });

  const settled = await Promise.allSettled(splitJobs);
  const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
  if (failed.length > 0) {
    throw new Error(`funding self-splits failed (${failed.length}): ${failed[0]!.reason}`);
  }
  console.log(`${TAG} funding complete.`);
  return { genesis, genesisPw, deployed, makers, cancelSingles, cancelDoubles, takers };
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
export async function buildOffer(pw: PoolWallet, rec: OfferRecord, tries = 6): Promise<BuiltOffer> {
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
    if (giveShielded) {
      try {
        finalized = await pw.wr.wallet.finalizeTransaction(recipe.transaction);
      } catch {
        // Mixed offers (unshielded want) may need the recipe/signing path.
        const signed = await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
          pw.wr.unshieldedKeystore.signData(p),
        );
        finalized = await pw.wr.wallet.finalizeRecipe(signed);
      }
    } else {
      const signed = await (pw.wr.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
        pw.wr.unshieldedKeystore.signData(p),
      );
      finalized = await pw.wr.wallet.finalizeRecipe(signed);
    }
    const blob = OfferFiles.encode(finalized.serialize());
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
    let recipe = balRecipe;
    if (kinds.has("unshielded")) {
      recipe = await (taker.wr.wallet as any).signRecipe(balRecipe, (p: Uint8Array) =>
        taker.wr.unshieldedKeystore.signData(p),
      );
    }
    const settleTx = await taker.wr.wallet.finalizeRecipe(recipe);
    const bad = nonDustImbalances(settleTx as any);
    if (bad.length > 0) throw new Error(`settle offer#${rec.index}: non-dust imbalance after balancing`);
    const res = await settleViaBatcher(settleTx as any);
    if (!res.ok) throw new Error(`settle offer#${rec.index}: batcher ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  });
}

// ── Cancel cycles ────────────────────────────────────────────────────────────

/** Spend `amounts` of the specialist's give color to self in one tx. */
async function cancelSpend(pw: PoolWallet, giveToken: TokenKey, amounts: bigint[]): Promise<void> {
  await selfSplit(pw, giveToken, ledger.colors[giveToken]!, amounts);
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
      await transferShieldedMany(genesisPw.wr, ledger.colors[giveToken]!, [
        { receiverAddress: target.shieldedAddr, amount: CANCEL_COIN },
      ]);
      // Wait until the coin lands so the next cycle can select it.
      await waitForShielded(target.wr, ledger.colors[giveToken]!, CANCEL_COIN, 24);
    });
}

export async function stopActors(a: Actors): Promise<void> {
  const all = [a.genesis, ...[...a.makers, ...a.cancelSingles, ...a.cancelDoubles, ...a.takers].map((p) => p.wr)];
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
