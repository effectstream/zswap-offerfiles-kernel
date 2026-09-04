// post-maker-offer.ts — put ONE real, settle-able maker offer into the kernel.
//
// The mechanics live in `lib/maker-offer.ts`, shared with the E2E driver (which
// needs a fresh offer per case, because a settled case consumes the one it
// used). This file is the one-shot CLI: resolve configuration, build a wallet,
// post, exit 0 only when the offer reaches status "live" in the kernel's book.
//
// Env:
//   ZSWAP_API / NODE_URL   kernel API base       (default http://kernel:9999)
//   MAKER_SEED             maker wallet seed     (default genesis …0001, which
//                          is the wallet `mint-test-tokens` credits)
//   GIVE_TOKEN, WANT_TOKEN 64-hex colors; default: read MINTED_TOKENS_FILE
//   GIVE_AMOUNT, WANT_AMOUNT, TTL_MINUTES
//   MINTED_TOKENS_FILE     default /srv/offerfiles-deploy/minted-tokens.json,
//                          published by entrypoint-mint-test-tokens.sh

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { buildWallet } from "../../packages/solver-core/wallet.ts";
import { KernelApi } from "./lib/kernel-api.ts";
import { postMakerOfferWithWallet, resolveMintedTokens } from "./lib/maker-offer.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const log = (msg: string) => console.log(`[maker-offer] ${msg}`);

const api = new KernelApi(
  process.env["ZSWAP_API"] ?? process.env["NODE_URL"] ?? "http://kernel:9999",
);
const MAKER_SEED =
  process.env["MAKER_SEED"] ?? "0000000000000000000000000000000000000000000000000000000000000001";
const { give, want } = resolveMintedTokens({
  file: process.env["MINTED_TOKENS_FILE"] ?? "/srv/offerfiles-deploy/minted-tokens.json",
  give: process.env["GIVE_TOKEN"] ?? "",
  want: process.env["WANT_TOKEN"] ?? "",
});
const giveAmount = BigInt(process.env["GIVE_AMOUNT"] ?? "500000");
const wantAmount = BigInt(process.env["WANT_AMOUNT"] ?? "750000");
const ttlMs = Number(process.env["TTL_MINUTES"] ?? "120") * 60_000;

log(`kernel   : ${api.base}`);
log(`give     : ${giveAmount} of ${give.slice(0, 16)}…`);
log(`want     : ${wantAmount} of ${want.slice(0, 16)}…`);
log(`=> the solver quotes this as tokenIn=${want.slice(0, 8)}… tokenOut=${give.slice(0, 8)}…`);

await postMakerOfferWithWallet(buildWallet, MAKER_SEED, {
  api,
  giveToken: give,
  wantToken: want,
  giveAmount,
  wantAmount,
  ttlMs,
  log,
});
process.exit(0);
