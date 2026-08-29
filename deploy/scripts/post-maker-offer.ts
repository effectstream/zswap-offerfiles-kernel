// post-maker-offer.ts — put ONE real, settle-able maker offer into the kernel.
//
// Why this exists (and why it is not `seed:market` or an api-example):
//
//   * `bun run seed:market` writes rows straight into the database with a
//     PLACEHOLDER blob. Its own header says so: those offers are DISPLAY-real
//     and "NOT settle-able". They would let the solver publish a ladder that
//     could never be filled — a green D2 smoke covering for a broken stack.
//   * `api-examples/10-submit-offer.ts` builds a real offer but is stale against
//     the current wallet SDK: it passes `state.address.coinPublicKeyString()`
//     (a STRING) as `receiverAddress`, and the SDK now dereferences
//     `receiverAddress.coinPublicKey.toHexString()`, so it dies with
//     "TypeError: undefined is not an object". The maintained path
//     (`packages/tests/two-wallet-swap-e2e.ts`) passes the address OBJECT from
//     `wallet.shielded.getAddress()`. This script follows the maintained one.
//     Fixing the api-example itself would be source scope, not deployment
//     scope, so the defect is recorded in the plan instead.
//
// The offer is intentionally UNBALANCED — it GIVES `GIVE_AMOUNT` of GIVE_TOKEN
// and WANTS `WANT_AMOUNT` of WANT_TOKEN routed back to the maker. That is what
// an Offer File is, and it is what the solver mirrors and quotes against.
//
// Note the resulting direction, because it decides which tokens the SOLVER must
// hold: an offer GIVING A / WANTING B is filled by a taker who pays B and
// receives A, so for the solver that pair is tokenIn=B, tokenOut=A. The solver
// needs BOTH (tokenIn for R2's fee-sizing mirror, tokenOut for residuals) —
// `packages/solver/scripts/bootstrap-dev.ts` mints it both.
//
// Env:
//   ZSWAP_API / NODE_URL   kernel API base       (default http://kernel:9999)
//   MAKER_SEED             maker wallet seed     (default genesis …0001, which
//                          is the wallet `mint-test-tokens` credits)
//   GIVE_TOKEN, WANT_TOKEN 64-hex colors; default: read MINTED_TOKENS_FILE
//   GIVE_AMOUNT, WANT_AMOUNT, TTL_MINUTES
//   MINTED_TOKENS_FILE     default /srv/offerfiles-deploy/minted-tokens.json,
//                          published by entrypoint-deploy.sh
//
// Exit 0 only when the offer reaches status "live" in the kernel's book.

import { readFileSync } from "node:fs";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
// RELATIVE, not the `@zswap-da/solver-core/wallet` specifier the in-package
// scripts use. Bun links workspace packages into their DEPENDENTS' node_modules
// (`packages/solver/node_modules/@zswap-da/solver-core`), never into the
// workspace root — and this file lives in `deploy/`, which is not a workspace
// member, so module resolution walks up to `/app/node_modules` and finds no
// `@zswap-da` at all. The npm dependencies above DO resolve from there, so only
// the first-party import needs the relative form. (Same class of trap as the
// pglite entrypoint's resolve, recorded at D1.)
import { buildWallet, shieldedKeys, waitForSync } from "../../packages/solver-core/wallet.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const TAG = "[maker-offer]";
const log = (msg: string) => console.log(`${TAG} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const API = (process.env["ZSWAP_API"] ?? process.env["NODE_URL"] ?? "http://kernel:9999").replace(/\/$/, "");
const MAKER_SEED =
  process.env["MAKER_SEED"] ?? "0000000000000000000000000000000000000000000000000000000000000001";
const MINTED_FILE = process.env["MINTED_TOKENS_FILE"] ?? "/srv/offerfiles-deploy/minted-tokens.json";

function resolveTokens(): { give: string; want: string } {
  let give = process.env["GIVE_TOKEN"] ?? "";
  let want = process.env["WANT_TOKEN"] ?? "";
  if (give && want) return { give, want };

  // The colors are derived from the DEPLOYED contract address, so they differ
  // for every fresh stack and cannot be hard-coded anywhere. The deploy
  // one-shot publishes them next to the contract address on the shared volume.
  let minted: Record<string, string>;
  try {
    minted = JSON.parse(readFileSync(MINTED_FILE, "utf-8")) as Record<string, string>;
  } catch (err) {
    throw new Error(
      `no GIVE_TOKEN/WANT_TOKEN in the environment and ${MINTED_FILE} is unreadable (${String(err)}). ` +
        `That file is written by the offerfiles-deploy one-shot; if the mint step failed, its log says why.`,
    );
  }
  give = give || (minted["shieldedA"] ?? "");
  want = want || (minted["shieldedB"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(give) || !/^[0-9a-f]{64}$/.test(want)) {
    throw new Error(`${MINTED_FILE} does not carry two shielded colors: ${JSON.stringify(minted)}`);
  }
  return { give, want };
}

async function api<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

const { give: GIVE_TOKEN, want: WANT_TOKEN } = resolveTokens();
const GIVE_AMOUNT = BigInt(process.env["GIVE_AMOUNT"] ?? "500000");
const WANT_AMOUNT = BigInt(process.env["WANT_AMOUNT"] ?? "750000");
const TTL_MS = Number(process.env["TTL_MINUTES"] ?? "120") * 60_000;

log(`kernel   : ${API}`);
log(`give     : ${GIVE_AMOUNT} of ${GIVE_TOKEN.slice(0, 16)}…`);
log(`want     : ${WANT_AMOUNT} of ${WANT_TOKEN.slice(0, 16)}…`);
log(`=> the solver quotes this as tokenIn=${WANT_TOKEN.slice(0, 8)}… tokenOut=${GIVE_TOKEN.slice(0, 8)}…`);

const maker = await buildWallet(MAKER_SEED);
try {
  await waitForSync(maker, { requireUnshieldedFunds: true });
  log(`maker wallet synced (seed …${MAKER_SEED.slice(-4)})`);

  const state = await maker.wallet.shielded.waitForSyncedState();
  const balances = (state.balances ?? {}) as Record<string, bigint>;
  const have = balances[GIVE_TOKEN] ?? 0n;
  log(`maker balance of give-token: ${have}`);
  if (have < GIVE_AMOUNT) {
    throw new Error(`insufficient give-token: have ${have}, need ${GIVE_AMOUNT}`);
  }

  // The ADDRESS OBJECT, not a string — see the header. The want leg is routed
  // back to the maker, which is what makes the transaction unbalanced.
  const makerShieldedAddr = await maker.wallet.shielded.getAddress();

  log("building the unbalanced offer (proving…)");
  const recipe = await maker.wallet.initSwap(
    { shielded: { [GIVE_TOKEN]: GIVE_AMOUNT } },
    [
      {
        type: "shielded",
        outputs: [{ type: WANT_TOKEN, amount: WANT_AMOUNT, receiverAddress: makerShieldedAddr }],
      } as never,
    ],
    shieldedKeys(maker),
    // payFees:false — an Offer File is settled by whoever takes it.
    { ttl: new Date(Date.now() + TTL_MS), payFees: false },
  );
  const finalized = await maker.wallet.finalizeTransaction(recipe.transaction);
  const blob = OfferFiles.encode(finalized.serialize());
  log(`encoded blob: ${blob.slice(0, 32)}… (${blob.length} chars)`);

  // ROOT_UNKNOWN just means the node has not yet synced the merkle root the
  // offer was built against; it self-resolves within a few blocks.
  let submitted: { status: number; body: any } | undefined;
  for (let attempt = 1; attempt <= 24; attempt++) {
    submitted = await api<any>("/v1/offers", { offer: blob });
    if (submitted.status === 200) break;
    const err = submitted.body?.error ?? submitted.body;
    if (String(err).includes("ROOT_UNKNOWN")) {
      log(`  ROOT_UNKNOWN — node still syncing the root; retry ${attempt}/24 in 5s`);
      await sleep(5000);
      continue;
    }
    throw new Error(`POST /v1/offers → ${submitted.status}: ${JSON.stringify(err)}`);
  }
  if (!submitted || submitted.status !== 200) {
    throw new Error(`offer never accepted: ${JSON.stringify(submitted?.body)}`);
  }
  log(`submitted: ${JSON.stringify(submitted.body?.result ?? submitted.body)}`);

  log("waiting for the offer to land in the kernel book…");
  for (let i = 1; i <= 40; i++) {
    await sleep(5000);
    const { body } = await api<{ status?: string }>("/v1/offers/status", { offer: blob });
    const status = body?.status;
    log(`  [${i}/40] status: ${status}`);
    if (status === "live") {
      log("offer is LIVE in the kernel order book");
      process.exit(0);
    }
    if (status === "consumed" || status === "cancelled" || status === "expired") {
      throw new Error(`offer reached terminal status "${status}" before going live`);
    }
  }
  throw new Error("offer did not reach status 'live' within the polling window");
} finally {
  await (maker.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
}
