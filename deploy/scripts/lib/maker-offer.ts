// Build and post ONE real, settle-able maker Offer File into the kernel book.
//
// Why this exists (and why it is not `seed:market` or an api-example):
//
//   * `bun run seed:market` writes rows straight into the database with a
//     PLACEHOLDER blob. Its own header says so: those offers are DISPLAY-real
//     and "NOT settle-able". They would let the solver publish a ladder that
//     could never be filled — a green smoke covering for a broken stack.
//   * `api-examples/10-submit-offer.ts` builds a real offer but is stale against
//     the current wallet SDK: it passes `state.address.coinPublicKeyString()`
//     (a STRING) as `receiverAddress`, and the SDK now dereferences
//     `receiverAddress.coinPublicKey.toHexString()`, so it dies with
//     "TypeError: undefined is not an object". The maintained path
//     (`packages/tests/two-wallet-swap-e2e.ts`) passes the address OBJECT from
//     `wallet.shielded.getAddress()`. This module follows the maintained one.
//     Fixing the api-example itself would be source scope, not deployment
//     scope, so the defect is recorded in the plan instead.
//
// The offer is intentionally UNBALANCED — it GIVES `giveAmount` of `giveToken`
// and WANTS `wantAmount` of `wantToken` routed back to the maker. That is what
// an Offer File is, and it is what the solver mirrors and quotes against.
//
// Note the resulting direction: an offer GIVING A / WANTING B is filled by a
// taker who pays B and receives A, so for the solver that pair is tokenIn=B,
// tokenOut=A. Since 00006-R2 the solver needs NEITHER to quote and settle this
// offer as a whole rung — fee sizing stopped spending tokenIn, and the maker
// offer itself pays the rung. tokenOut buys only INTERPOLATED sizes between
// rungs. `packages/solver/scripts/bootstrap-dev.ts` still mints it both, which
// 00006-V1's unfunded rerun is the control for.

import { readFileSync } from "node:fs";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";

// RELATIVE, not the `@zswap-da/solver-core/wallet` specifier the in-package
// scripts use. Bun links workspace packages into their DEPENDENTS'
// node_modules (`packages/solver/node_modules/@zswap-da/solver-core`), never
// into the workspace root — and this file lives in `deploy/`, which is not a
// workspace member, so module resolution walks up to `/app/node_modules` and
// finds no `@zswap-da` at all. The npm dependencies DO resolve from there, so
// only the first-party imports need the relative form.
import { shieldedKeys, waitForSync } from "../../../packages/solver-core/wallet.ts";
import { KernelApi } from "./kernel-api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MintedTokens {
  give: string;
  want: string;
  raw: Record<string, string>;
}

/** The token colors this stack actually minted.
 *
 *  Colors derive from the DEPLOYED contract address, so they differ for every
 *  fresh stack and cannot be hard-coded anywhere; the deploy one-shot publishes
 *  them next to the contract address on the shared volume. */
export function resolveMintedTokens(opts: {
  file: string;
  give?: string;
  want?: string;
}): MintedTokens {
  let give = opts.give ?? "";
  let want = opts.want ?? "";
  let raw: Record<string, string> = {};
  if (!give || !want) {
    try {
      raw = JSON.parse(readFileSync(opts.file, "utf-8")) as Record<string, string>;
    } catch (err) {
      throw new Error(
        `no give/want token given and ${opts.file} is unreadable (${String(err)}). ` +
          `That file is written by the offerfiles-deploy one-shot; if the mint step failed, ` +
          `its log says why.`,
      );
    }
    give = give || (raw["shieldedA"] ?? "");
    want = want || (raw["shieldedB"] ?? "");
  }
  if (!/^[0-9a-f]{64}$/.test(give) || !/^[0-9a-f]{64}$/.test(want)) {
    throw new Error(`could not resolve two shielded colors: ${JSON.stringify({ give, want, raw })}`);
  }
  return { give, want, raw };
}

export interface PostedOffer {
  /** The bech32m `swapoffer1…` string the kernel accepted. */
  blob: string;
  /** The kernel's own offerId — sha256 of the raw offer bytes, hex. */
  offerId: string;
  giveToken: string;
  wantToken: string;
  giveAmount: bigint;
  wantAmount: bigint;
}

export interface PostMakerOfferOptions {
  /** An ALREADY BUILT and synced maker wallet (`buildWallet` result). */
  maker: any;
  api: KernelApi;
  giveToken: string;
  wantToken: string;
  giveAmount: bigint;
  wantAmount: bigint;
  ttlMs?: number;
  log?: (msg: string) => void;
  /** Poll budget for the offer to reach `live` in the kernel book. */
  liveTries?: number;
  liveIntervalMs?: number;
}

export async function postMakerOffer(opts: PostMakerOfferOptions): Promise<PostedOffer> {
  const {
    maker,
    api,
    giveToken,
    wantToken,
    giveAmount,
    wantAmount,
    ttlMs = 120 * 60_000,
    liveTries = 40,
    liveIntervalMs = 5_000,
  } = opts;
  const log = opts.log ?? ((msg: string) => console.log(`[maker-offer] ${msg}`));

  const state = await maker.wallet.shielded.waitForSyncedState();
  const balances = (state.balances ?? {}) as Record<string, bigint>;
  const have = balances[giveToken] ?? 0n;
  log(`maker balance of give-token ${giveToken.slice(0, 10)}…: ${have}`);
  if (have < giveAmount) {
    throw new Error(`insufficient give-token: have ${have}, need ${giveAmount}`);
  }

  // The ADDRESS OBJECT, not a string — see the header. The want leg is routed
  // back to the maker, which is what makes the transaction unbalanced.
  const makerShieldedAddr = await maker.wallet.shielded.getAddress();

  log(`building the unbalanced offer: give ${giveAmount} want ${wantAmount} (proving…)`);
  const recipe = await maker.wallet.initSwap(
    { shielded: { [giveToken]: giveAmount } },
    [
      {
        type: "shielded",
        outputs: [{ type: wantToken, amount: wantAmount, receiverAddress: makerShieldedAddr }],
      } as never,
    ],
    shieldedKeys(maker),
    // payFees:false — an Offer File is settled by whoever takes it.
    { ttl: new Date(Date.now() + ttlMs), payFees: false },
  );
  const finalized = await maker.wallet.finalizeTransaction(recipe.transaction);
  const blob = OfferFiles.encode(finalized.serialize());
  log(`encoded blob: ${blob.slice(0, 32)}… (${blob.length} chars)`);

  // ROOT_UNKNOWN just means the node has not yet synced the merkle root the
  // offer was built against; it self-resolves within a few blocks.
  let submitted: { status: number; body: any } | undefined;
  for (let attempt = 1; attempt <= 24; attempt++) {
    submitted = await api.post<any>("/v1/offers", { offer: blob });
    if (submitted.status === 200) break;
    const err = submitted.body?.error ?? submitted.body;
    if (String(err).includes("ROOT_UNKNOWN")) {
      log(`  ROOT_UNKNOWN — node still syncing the root; retry ${attempt}/24 in 5s`);
      await sleep(5_000);
      continue;
    }
    throw new Error(`POST /v1/offers → ${submitted.status}: ${JSON.stringify(err)}`);
  }
  if (!submitted || submitted.status !== 200) {
    throw new Error(`offer never accepted: ${JSON.stringify(submitted?.body)}`);
  }
  log(`submitted: ${JSON.stringify(submitted.body?.result ?? submitted.body)}`);

  log("waiting for the offer to land in the kernel book…");
  for (let i = 1; i <= liveTries; i++) {
    await sleep(liveIntervalMs);
    const { offerId, status } = await api.offerStatusByBlob(blob);
    log(`  [${i}/${liveTries}] status: ${status}`);
    if (status === "live") {
      log(`offer ${String(offerId).slice(0, 12)}… is LIVE in the kernel order book`);
      return {
        blob,
        offerId: String(offerId),
        giveToken,
        wantToken,
        giveAmount,
        wantAmount,
      };
    }
    if (status === "consumed" || status === "cancelled" || status === "expired") {
      throw new Error(`offer reached terminal status "${status}" before going live`);
    }
  }
  throw new Error("offer did not reach status 'live' within the polling window");
}

/** Build a maker wallet, post one offer, stop the wallet. The one-shot path. */
export async function postMakerOfferWithWallet(
  buildWallet: (seed: string) => Promise<any>,
  seed: string,
  opts: Omit<PostMakerOfferOptions, "maker">,
): Promise<PostedOffer> {
  const log = opts.log ?? ((msg: string) => console.log(`[maker-offer] ${msg}`));
  const maker = await buildWallet(seed);
  try {
    await waitForSync(maker, { requireUnshieldedFunds: true });
    log(`maker wallet synced (seed …${seed.slice(-4)})`);
    return await postMakerOffer({ ...opts, maker });
  } finally {
    await (maker.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
  }
}
