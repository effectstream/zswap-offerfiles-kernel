// offer-poster.ts — the long-running service (spec 00007, FR-001…FR-016).
//
// WHAT IT DOES
// ------------
// Every `POST_INTERVAL_MS` it puts exactly one Offer File into the kernel's
// book, and that offer's ONLY input is one coin the poster can name:
//
//   * a coin an earlier offer released (expired/cancelled/rejected AND back in
//     `availableCoins`) — re-offered at today's quote, no mint, no DUST; or
//   * a coin it mints in that tick, `GIVE_AMOUNT` of `GIVE_TOKEN`, fees paid
//     from the poster's own DUST.
//
// Every coin and every offer built from it is written to a durable journal on
// the poster's own volume, so a restart knows what it owns and a settled offer
// can be traced back to the coin it spent.
//
// HOW THE "EXACT COIN" GUARANTEE IS ENFORCED
// ------------------------------------------
// `initSwap` cannot name a coin — it takes `{colour: amount}` and the SDK's
// default selector picks the smallest match. So the poster builds its facade
// through `lib/pinned-wallet.ts`, whose shielded coin selection returns THE
// pinned coin or nothing at all for the give colour, and it then checks the
// result: `collectNullifiers(finalized)` must be exactly `[coin.nullifier]`
// with no fallible inputs, or the recipe is reverted and nothing is posted.
// The kernel's own `computed.inputNullifiers` is compared afterwards as an
// independent cross-check.
//
// FILE LAYOUT / WHY main() IS GUARDED
// -----------------------------------
// The decisions live in `lib/poster-{config,tick,scheduler,health}.ts` behind
// injected dependencies; this file only builds the real implementations of
// those dependencies and runs the loop. `main()` runs only under
// `import.meta.main`, and `packages/solver-core/offer-files.ts` is imported
// DYNAMICALLY — it constructs a `CompiledContract` at module load from the
// Compact build output (`packages/contracts-midnight/contract-offer-files/src/managed`),
// which a fresh clone does not have, so a static import would make this module
// unloadable in CI and in any test.
//
// ENV: see `lib/poster-config.ts` for the whole list and every default.

import { createHash } from "node:crypto";

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import {
  registerNightForDust,
  resolveFacadeDustBalance,
  waitForDustFunds,
} from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { collectNullifiers } from "../../packages/validator/derive.ts";
import { shieldedKeys } from "../../packages/solver-core/wallet.ts";
import { KernelApi } from "./lib/kernel-api.ts";
import { freshNonce, mintFaucetToken, registerAndVerifyTokenName } from "./lib/faucet-mint.ts";
import { buildPinnedWallet, withPinnedCoin, type PinnedWalletResult } from "./lib/pinned-wallet.ts";
import {
  ConfigError,
  configDump,
  parsePosterConfig,
  type PosterConfig,
} from "./lib/poster-config.ts";
import { type Journal, openJournal, JournalError } from "./lib/poster-journal.ts";
import { type GiveSizer, makeGiveSizer } from "./lib/poster-size.ts";
import { baseUnitsToCoins } from "../../packages/solver-core/amount.ts";
import { NotSponsoredError, quoteSnapshot, sizeWant, type SizedWant } from "./lib/poster-quote.ts";
import { PosterScheduler, type SchedulerStats, type TickOutcome } from "./lib/poster-scheduler.ts";
import {
  healthSnapshot,
  startHealthServer,
  type HealthInputs,
  type HealthServer,
} from "./lib/poster-health.ts";
import {
  formatLogFields,
  reconcile,
  runTick,
  type BuildOfferArgs,
  type BuiltOffer,
  type LogFields,
  type SpendableCoin,
  type TickApi,
  type TickBuilder,
  type TickClock,
  type TickDeps,
  type TickMinter,
  type TickWallet,
} from "./lib/poster-tick.ts";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const norm = (value: unknown): string => String(value ?? "").replace(/^0[xX]/, "").toLowerCase();
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const log = (fields: LogFields): void => console.log(`[offer-poster] ${formatLogFields(fields)}`);
const info = (msg: string): void => console.log(`[offer-poster] ${msg}`);
const warn = (msg: string): void => console.warn(`[offer-poster] ${msg}`);

const realClock: TickClock = { now: () => Date.now(), sleep };

/** The printable `mn_shield-addr_…` form of a `ShieldedAddress`. Purely for the
 *  log and the `DRY_RUN` report — the OFFER always carries the address OBJECT
 *  (`maker-offer.ts:133-135`: passing a string kills the SDK). */
function shieldedAddressText(address: unknown, networkId: string): string {
  try {
    return MidnightBech32m.encode(
      networkId as never,
      address as Parameters<typeof MidnightBech32m.encode>[1],
    ).asString();
  } catch (err) {
    const key = (address as { coinPublicKeyString?: () => string }).coinPublicKeyString?.();
    return key ?? `<unprintable shielded address: ${errMessage(err)}>`;
  }
}

// ---------------------------------------------------------------------------
// Observables without rxjs
// ---------------------------------------------------------------------------

/** The slice of `Rx.Observable` the facade's `state()` actually needs to expose.
 *
 *  `rxjs` is a dependency of `packages/solver-core` and of
 *  `@effectstream/midnight-contracts`, but NOT of the repository root — and
 *  `deploy/` is not a workspace member, so a bare `import "rxjs"` here resolves
 *  to nothing (the same resolution rule `maker-offer.ts:35-41` documents for
 *  first-party packages). Subscribing structurally needs no import at all. */
interface StateObservable<T> {
  subscribe(observer: {
    next?(value: T): void;
    error?(err: unknown): void;
    complete?(): void;
  }): { unsubscribe(): void };
}

const stateStream = (wallet: PinnedWalletResult): StateObservable<unknown> =>
  (wallet.wallet as unknown as { state(): StateObservable<unknown> }).state();

/** First emission satisfying `predicate`, or a rejection after `timeoutMs`.
 *  `Rx.firstValueFrom(obs.pipe(filter, timeout))` without the dependency. */
function firstMatch<T>(
  observable: StateObservable<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let subscription: { unsubscribe(): void } | null = null;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      subscription?.unsubscribe();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Unsubscribing from inside `next` can run before `subscribe` returns, so
      // defer it one turn if the handle is not assigned yet.
      if (subscription === null) queueMicrotask(() => subscription?.unsubscribe());
      else subscription.unsubscribe();
      fn();
    };
    subscription = observable.subscribe({
      next: (value: T) => {
        let matched = false;
        try {
          matched = predicate(value);
        } catch (err) {
          finish(() => reject(err));
          return;
        }
        if (matched) finish(() => resolve(value));
      },
      error: (err: unknown) => finish(() => reject(err)),
      complete: () => finish(() => reject(new Error(`${label}: stream completed without a match`))),
    });
    if (done) subscription.unsubscribe();
  });
}

// ---------------------------------------------------------------------------
// Wallet sync — shielded + unshielded STRICTLY complete, dust deliberately not
// ---------------------------------------------------------------------------

/**
 * Wait for the shielded and unshielded subtrees to be strictly complete.
 *
 * DELIBERATELY NOT `packages/solver-core/wallet.ts`'s `waitForSync`: that one
 * also requires `dust.state.progress.isStrictlyComplete()`, and the dust
 * progress tracker can sit incomplete on `undeployed` while the wallet is
 * perfectly usable — the same reason `$HOME/todo/infra/experiments/00005-mint-faucet-colours.ts:141-158`
 * gives for its own copy. Blocking on it here would mean the poster never gets
 * past startup on a fresh stack. DUST readiness is established separately, and
 * with a bound, by `waitForDustFunds`.
 */
async function waitForWalletSync(wallet: PinnedWalletResult, timeoutMs: number): Promise<void> {
  await firstMatch(
    stateStream(wallet),
    (raw: unknown) => {
      const state = raw as {
        isSynced?: boolean;
        shielded?: { state?: { progress?: { isStrictlyComplete?: () => boolean } } };
        unshielded?: { progress?: { isStrictlyComplete?: () => boolean } };
      };
      const isSynced = state.isSynced ?? false;
      const shieldedDone = state.shielded?.state?.progress?.isStrictlyComplete?.() ?? isSynced;
      const unshieldedDone = state.unshielded?.progress?.isStrictlyComplete?.() ?? isSynced;
      return shieldedDone && unshieldedDone;
    },
    timeoutMs,
    "wallet sync (POSTER_SYNC_TIMEOUT_MS)",
  );
}

/** Spendable DUST, read from the facade's current state.
 *
 *  `waitForDustFunds` is the SDK's own reader but it SUBSCRIBES and waits; that
 *  is right at startup and wrong inside a tick, where a stalled dust subtree
 *  would hold the loop. `resolveFacadeDustBalance` is the same arithmetic over
 *  one emission. */
async function readDustBalance(wallet: PinnedWalletResult, timeoutMs = 10_000): Promise<bigint> {
  try {
    const state = await firstMatch(stateStream(wallet), () => true, timeoutMs, "dust balance read");
    return resolveFacadeDustBalance(state);
  } catch (err) {
    warn(`dust balance unreadable (${errMessage(err)}); treating as 0`);
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Dependency implementations
// ---------------------------------------------------------------------------

interface ShieldedStateLike {
  availableCoins: readonly {
    coin: { type: unknown; nonce: unknown; value: unknown };
    nullifier: unknown;
  }[];
}

function makeWallet(walletResult: PinnedWalletResult): TickWallet {
  const shielded = (): Promise<ShieldedStateLike> =>
    (
      walletResult.wallet.shielded as unknown as {
        waitForSyncedState(): Promise<ShieldedStateLike>;
      }
    ).waitForSyncedState();

  return {
    async availableNonces(): Promise<string[]> {
      const state = await shielded();
      return state.availableCoins.map((entry) => norm(entry.coin.nonce));
    },
    async findCoin(nonce: string): Promise<SpendableCoin | undefined> {
      const wanted = norm(nonce);
      const state = await shielded();
      const entry = state.availableCoins.find((c) => norm(c.coin.nonce) === wanted);
      if (entry === undefined) return undefined;
      return {
        nonce: norm(entry.coin.nonce),
        type: norm(entry.coin.type),
        value: BigInt(entry.coin.value as bigint),
        nullifier: norm(entry.nullifier),
      };
    },
    async dustBalance(): Promise<bigint> {
      return await readDustBalance(walletResult);
    },
  };
}

function makeMinter(walletResult: PinnedWalletResult, deployed: unknown, contractAddress: string): TickMinter {
  return {
    freshNonce,
    async mint(name, amount, nonce) {
      const minted = await mintFaucetToken(
        deployed as Parameters<typeof mintFaucetToken>[0],
        name,
        amount,
        nonce,
        {
          contractAddress,
          coinPublicKey: walletResult.zswapSecretKeys.coinPublicKey,
          // A THUNK, not the key: `.coinSecretKey` mints a new wasm wrapper on
          // every access and the secret belongs to the owning `ZswapSecretKeys`,
          // whose finalizer clears it once unreachable. A captured handle starts
          // throwing "Coin secret key was cleared" after a GC (P2 finding 3).
          coinSecretKey: () => walletResult.zswapSecretKeys.coinSecretKey,
        },
      );
      return {
        coin: {
          nonce: norm(minted.coin.nonce),
          type: norm(minted.coin.type),
          value: BigInt(minted.coin.value),
        },
        nullifier: norm(minted.nullifier),
        txHash: minted.txHash,
        mintNonce: minted.mintNonce,
      };
    },
  };
}

/** Inputs in the FALLIBLE section of a finalized transaction. An Offer File is
 *  a guaranteed single-segment swap; a fallible input would be spent only if a
 *  later segment succeeded, which is not what "this offer spends this coin"
 *  means. `fallibleOffer` is a Map keyed by segment id. */
function countFallibleInputs(tx: unknown): number {
  const fallible = (tx as { fallibleOffer?: unknown }).fallibleOffer;
  if (fallible === undefined || fallible === null) return 0;
  const values = (fallible as { values?: () => Iterable<unknown> }).values;
  if (typeof values !== "function") return 0;
  let count = 0;
  for (const offer of values.call(fallible) as Iterable<unknown>) {
    const inputs = (offer as { inputs?: unknown[] } | null)?.inputs;
    count += Array.isArray(inputs) ? inputs.length : 0;
  }
  return count;
}

function makeBuilder(walletResult: PinnedWalletResult): TickBuilder {
  return {
    async build(args: BuildOfferArgs): Promise<BuiltOffer> {
      // The ADDRESS OBJECT, not a string. `api-examples/10-submit-offer.ts`
      // passes `coinPublicKeyString()` and dies inside the SDK; the maintained
      // path (`deploy/scripts/lib/maker-offer.ts:135-152`) passes the object.
      const ownAddress = await walletResult.wallet.shielded.getAddress();

      // `withPinnedCoin` releases the pin in a `finally`, so a throw here can
      // never leave the selector armed for the next tick.
      const recipe = await withPinnedCoin(args.giveColour, args.nonce, () =>
        walletResult.wallet.initSwap(
          { shielded: { [args.giveColour]: args.giveValue } },
          [
            {
              type: "shielded",
              outputs: [
                { type: args.wantColour, amount: args.wantAmount, receiverAddress: ownAddress },
              ],
            } as never,
          ],
          shieldedKeys(walletResult),
          // payFees:false — an Offer File is settled by whoever takes it, and
          // the batcher sponsors the Celestia fee.
          { ttl: new Date(Date.now() + args.ttlMs), payFees: false },
        ),
      );
      const finalized = await walletResult.wallet.finalizeTransaction(recipe.transaction);
      const raw = finalized.serialize();
      const blob = OfferFiles.encode(raw);
      return {
        recipe,
        nullifiers: collectNullifiers(finalized as never),
        fallibleInputCount: countFallibleInputs(finalized),
        blob,
        offerId: OfferFiles.offerId(raw),
        blobSha256: createHash("sha256").update(blob).digest("hex"),
      };
    },
    async revert(recipe: unknown): Promise<void> {
      await walletResult.wallet.revert(recipe as never);
    },
  };
}

function makeApi(api: KernelApi): TickApi {
  return {
    async sizeWant(args): Promise<SizedWant> {
      return await sizeWant(api, {
        giveColour: args.giveColour,
        wantColour: args.wantColour,
        giveValue: args.giveValue,
        ...(args.forcedWantAmount !== undefined ? { forcedWantAmount: args.forcedWantAmount } : {}),
      });
    },
    async postOffer(blob) {
      return await api.post<unknown>("/v1/offers", { offer: blob });
    },
    async offerStatusByBlob(blob) {
      return await api.offerStatusByBlob(blob);
    },
    async offerStatusByHash(hash) {
      return await api.offerStatusByHash(hash);
    },
    async getOffer(hash) {
      const { status, body } = await api.get<{
        offerId: string;
        computed?: { inputNullifiers?: string[]; status?: string };
      }>(`/v1/offers/${hash}`);
      if (status !== 200) {
        throw new Error(`GET /v1/offers/${hash} -> ${status}: ${JSON.stringify(body)}`);
      }
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// Startup (FR-002)
// ---------------------------------------------------------------------------

interface Started {
  cfg: PosterConfig;
  walletResult: PinnedWalletResult;
  api: KernelApi;
  journal: Journal;
  deps: TickDeps;
  shieldedAddress: string;
  dustBalance: bigint;
  firstQuote: SizedWant | null;
  registry: { give: unknown; want: unknown };
  /** `null` unless GIVE_MIN/GIVE_MAX are configured (00027). */
  sizer: GiveSizer | null;
}

/** `100000` -> `0.1 WBTC (100000 base units)`. One spelling for every log line
 *  and report that shows a give size, so an operator never has to count zeros. */
function describeAmount(base: bigint, token: string): string {
  return `${baseUnitsToCoins(base)} ${token} (${base} base units)`;
}

async function startup(cfg: PosterConfig): Promise<Started> {
  const api = new KernelApi(cfg.kernelBase);

  info(`kernel      : ${api.base}`);
  info(`network     : ${cfg.networkId} (indexer ${cfg.networkUrls.indexer})`);
  info(`contract    : ${cfg.contractAddress} (from ${cfg.contractAddressSource})`);
  // 00027: one sizer per process, so a seeded run replays the same sequence of
  // sizes across every tick rather than restarting it each time.
  const sizer =
    cfg.giveRange === undefined ? null : makeGiveSizer(cfg.giveRange, cfg.giveSizeSeed);
  if (sizer === null) {
    info(`give        : ${cfg.giveAmount} of ${cfg.giveToken} = ${cfg.giveColour}`);
  } else {
    info(
      `give        : ${describeAmount(sizer.range.minBase, cfg.giveToken)} … ` +
        `${describeAmount(sizer.range.maxBase, cfg.giveToken)}, drawn log-uniformly per fresh mint ` +
        `(seed ${cfg.giveSizeSeed ?? "<random>"}) = ${cfg.giveColour}`,
    );
  }
  info(`want        : ${cfg.wantToken} = ${cfg.wantColour}${
    cfg.forcedWantAmount === undefined ? " (amount from the kernel quote)" : ` (forced ${cfg.forcedWantAmount})`
  }`);
  info(`wallet seed : from ${cfg.seedSource}`);

  // ── the pinned-coin facade ───────────────────────────────────────────────
  const walletResult = await buildPinnedWallet(
    cfg.seed,
    cfg.networkUrls,
    cfg.networkId as never,
    "all",
  );

  // `ShieldedAddress` has NO `asString()` — unlike the unshielded keystore's
  // bech32m address it is a pair of public keys, and the printable form comes
  // from the bech32m codec (`MidnightBech32m.encode`, the same call
  // `pinned-wallet.ts` makes for `dustAddress`). Falling back to `String(addr)`
  // would log `[object Object]`.
  const shieldedAddressObj = await walletResult.wallet.shielded.getAddress();
  const shieldedAddress = shieldedAddressText(shieldedAddressObj, cfg.networkId);

  info("waiting for wallet sync (shielded + unshielded strictly complete)…");
  await waitForWalletSync(walletResult, cfg.syncTimeoutMs);
  info(`wallet synced: shielded ${shieldedAddress}`);
  info(`             : unshielded ${walletResult.unshieldedAddress}`);

  // ── DUST: register NIGHT, then wait (bounded) for a non-zero balance ─────
  try {
    const registered = await registerNightForDust(walletResult as never);
    info(`registerNightForDust -> ${registered}`);
  } catch (err) {
    // Tolerant by design (FR-002): a wallet already registered, or one whose
    // NIGHT has not arrived yet, must not stop the service from starting — the
    // tick degrades on insufficient DUST and says so on /health.
    warn(`registerNightForDust failed: ${errMessage(err)} (continuing)`);
  }

  let dustBalance = 0n;
  try {
    // `waitForDustFunds` (midnight-contracts 0.200.x) resolves a readiness
    // record — spendable-coin count plus balance — not the bare balance the
    // 0.103 line returned. Only the balance feeds the log and /health.
    const dustFunds = await waitForDustFunds(walletResult.wallet, {
      waitNonZero: true,
      timeoutMs: cfg.dustWaitTimeoutMs,
    });
    dustBalance = dustFunds.balance;
  } catch (err) {
    warn(
      `no spendable DUST within POSTER_DUST_WAIT_TIMEOUT_MS=${cfg.dustWaitTimeoutMs}ms ` +
        `(${errMessage(err)}). Starting anyway: re-offers need no DUST and /health will report ` +
        `degraded until NIGHT arrives.`,
    );
    dustBalance = await readDustBalance(walletResult);
  }
  info(`dust balance: ${dustBalance}`);

  // ── join the deployed offer-files contract ──────────────────────────────
  // DYNAMIC import: the module builds a `CompiledContract` from the Compact
  // build output at load time, so a static import would make this file
  // unloadable wherever `bun run build:midnight` has not been run.
  info(`joining offer-files contract ${cfg.contractAddress}…`);
  const { joinOfferFiles } = await import("../../packages/solver-core/offer-files.ts");
  const deployed = await joinOfferFiles(walletResult as never, cfg.contractAddress);
  info("contract joined");

  // ── token names, so the legs quote against a market price ───────────────
  const registry = { give: null as unknown, want: null as unknown };
  for (const leg of [
    { name: cfg.giveTokenName, colour: cfg.giveColour, slot: "give" as const },
    { name: cfg.wantTokenName, colour: cfg.wantColour, slot: "want" as const },
  ]) {
    if (leg.name === undefined) {
      info(`${leg.slot} leg is a raw colour; no name to register`);
      continue;
    }
    try {
      const result = await registerAndVerifyTokenName(api, leg.colour, leg.name, "shielded", { warn });
      registry[leg.slot] = result;
      info(
        `${leg.slot} ${leg.name}: register=${result.register.reason} verify=${result.verify.reason} ` +
          `priced=${result.verify.priced} ready=${result.ready}`,
      );
      if (result.register.reason === "registry_disabled") {
        warn(
          `ENABLE_TOKEN_REGISTRY is off on ${api.base}: ${leg.name} will quote as unpriced ` +
            `(demo-fallback) and sponsorship then depends on BATCHER_SPONSOR_UNPRICED`,
        );
      }
      if (!result.verify.priced) {
        // Not fatal: PRICE_FEED_MAP on the node can price a token this check
        // cannot see (P2 finding 7).
        warn(
          `${leg.name} maps to no reference asset through known_tokens.asset_id or the default ` +
            `name map — the node's PRICE_FEED_MAP may still price it`,
        );
      }
    } catch (err) {
      warn(`token registration for ${leg.name} failed: ${errMessage(err)} (continuing)`);
    }
  }

  // ── the journal ─────────────────────────────────────────────────────────
  const journal = openJournal({
    file: cfg.journalFile,
    contractAddress: cfg.contractAddress,
    giveColour: cfg.giveColour,
    reset: cfg.journalReset,
  });
  info(`journal     : ${journal.file}`);

  const deps: TickDeps = {
    cfg: {
      giveColour: cfg.giveColour,
      giveTokenName: cfg.giveTokenName ?? cfg.giveToken,
      giveAmount: cfg.giveAmount,
      wantColour: cfg.wantColour,
      forcedWantAmount: cfg.forcedWantAmount,
      offerTtlMinutes: cfg.offerTtlMinutes,
      coinVisibleTimeoutMs: cfg.coinVisibleTimeoutMs,
      minDust: cfg.minDust,
      maxReoffersPerTick: cfg.maxReoffersPerTick,
      postRetries: cfg.postRetries,
      postRetryMs: cfg.postRetryMs,
      liveTries: cfg.liveTries,
      liveIntervalMs: cfg.liveIntervalMs,
    },
    journal,
    wallet: makeWallet(walletResult),
    minter: makeMinter(walletResult, deployed, cfg.contractAddress),
    builder: makeBuilder(walletResult),
    api: makeApi(api),
    clock: realClock,
    log,
    // Absent when no range is configured, which is what keeps the fixed-size
    // path byte-identical to `main` (SC-003).
    ...(sizer === null ? {} : { drawGiveAmount: () => sizer.draw() }),
  };

  // ── first reconcile + first quote, so the log shows the starting picture ─
  const reconciled = await reconcile(deps);
  const summary = journal.summary();
  info(
    `journal     : ${summary.coins.total} coins (${summary.coins.minted} minted, ` +
      `${summary.coins.offered} offered, ${summary.coins.spent} spent, ${summary.coins.lost} lost), ` +
      `${summary.offers.total} offers (${summary.offers.live} live), ` +
      `${reconciled.candidates.length} re-offer candidate(s)`,
  );

  // With a range the first quote is priced for the FIRST DRAW, not for a size
  // no tick will ever post; `sizer.last()` then carries that number into the
  // DRY_RUN report and /health until the first mint replaces it.
  const firstGiveAmount = sizer === null ? cfg.giveAmount : sizer.draw();
  let firstQuote: SizedWant | null = null;
  try {
    firstQuote = await deps.api.sizeWant({
      giveColour: cfg.giveColour,
      wantColour: cfg.wantColour,
      giveValue: firstGiveAmount,
      forcedWantAmount: cfg.forcedWantAmount,
    });
    info(
      `first quote : ${firstGiveAmount} ${cfg.giveToken} -> ${firstQuote.wantAmount} ${cfg.wantToken} ` +
        `(sponsored=${firstQuote.sponsored} rate=${firstQuote.marketRate} ` +
        `sources=${firstQuote.fromSource}/${firstQuote.toSource})`,
    );
    for (const w of firstQuote.warnings) warn(`quote: ${w}`);
  } catch (err) {
    if (err instanceof NotSponsoredError) {
      warn(`first quote is NOT sponsored: ${err.message}`);
    } else {
      warn(`first quote failed: ${errMessage(err)}`);
    }
  }

  return { cfg, walletResult, api, journal, deps, shieldedAddress, dustBalance, firstQuote, registry, sizer };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function stopWallet(walletResult: PinnedWalletResult): Promise<void> {
  // `WalletFacade.stop()` is the documented shutdown (`wallet-sdk-facade`
  // `index.d.ts:330`); `maker-offer.ts:209` calls the same thing optionally.
  // Never let a shutdown failure change the exit code — the journal is already
  // durable and the wallet holds no state we need.
  try {
    await (walletResult.wallet as unknown as { stop?: () => Promise<void> }).stop?.();
  } catch (err) {
    warn(`wallet stop failed: ${errMessage(err)}`);
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  // The kernel's own scripts do both of these before touching the SDK.
  globalThis.WebSocket = WebSocket;

  let cfg: PosterConfig;
  try {
    cfg = await parsePosterConfig(env as Record<string, string | undefined>);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[offer-poster] configuration error (${err.code}): ${err.message}`);
      return 78; // EX_CONFIG, matching `entrypoint-common.sh`'s `require_env`.
    }
    throw err;
  }
  setNetworkId(cfg.networkId as never);
  if (net.id !== cfg.networkId) {
    warn(
      `MIDNIGHT_NETWORK_ID=${cfg.networkId} but @effectstream/midnight-contracts resolved ` +
        `"${net.id}" — the wallet and the contract join follow the latter`,
    );
  }
  info(`configuration: ${configDump(cfg)}`);

  let started: Started;
  try {
    started = await startup(cfg);
  } catch (err) {
    if (err instanceof JournalError) {
      console.error(
        `[offer-poster] journal refused (${err.code}): ${err.message}` +
          (err.movedAside === undefined ? "" : ` (moved aside to ${err.movedAside})`),
      );
      return 78;
    }
    console.error(`[offer-poster] startup failed: ${errMessage(err)}`);
    if (err instanceof Error && err.stack !== undefined) console.error(err.stack);
    return 1;
  }

  // ── DRY_RUN: everything above, nothing that mints or posts ──────────────
  if (cfg.dryRun) {
    const summary = started.journal.summary();
    const report = {
      dryRun: true,
      networkId: cfg.networkId,
      kernel: started.api.base,
      contractAddress: cfg.contractAddress,
      contractAddressSource: cfg.contractAddressSource,
      shieldedAddress: started.shieldedAddress,
      unshieldedAddress: started.walletResult.unshieldedAddress,
      dustBalance: started.dustBalance.toString(),
      give: {
        token: cfg.giveToken,
        colour: cfg.giveColour,
        // With a range, `amount` is the size the quote below was priced for —
        // the first draw — and `range`/`lastGiveAmount` say where it came from.
        amount: (started.sizer?.last() ?? cfg.giveAmount).toString(),
        ...(started.sizer === null
          ? {}
          : {
              range: {
                min: baseUnitsToCoins(started.sizer.range.minBase),
                max: baseUnitsToCoins(started.sizer.range.maxBase),
                minBase: started.sizer.range.minBase.toString(),
                maxBase: started.sizer.range.maxBase.toString(),
                seed: cfg.giveSizeSeed ?? null,
                distribution: "log-uniform",
              },
              lastGiveAmount: started.sizer.last()?.toString() ?? null,
            }),
      },
      want: { token: cfg.wantToken, colour: cfg.wantColour },
      registry: started.registry,
      quote:
        started.firstQuote === null
          ? null
          : {
              wantAmount: started.firstQuote.wantAmount.toString(),
              suggestedWantAmount: started.firstQuote.suggestedWantAmount.toString(),
              forced: started.firstQuote.forced,
              warnings: started.firstQuote.warnings,
              ...quoteSnapshot(started.firstQuote),
            },
      journal: summary,
    };
    console.log(JSON.stringify(report, null, 2));
    await stopWallet(started.walletResult);
    info("DRY_RUN complete — nothing was minted and nothing was posted");
    return 0;
  }

  // ── the loop ────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  let ready = true;
  let shuttingDown = false;
  let tickNumber = 0;
  let lastDust: bigint | null = started.dustBalance;
  let lastCandidates = 0;
  let lastFreeCoins = 0;

  const scheduler = new PosterScheduler({
    intervalMs: cfg.postIntervalMs,
    warn,
    async tick(): Promise<TickOutcome> {
      tickNumber += 1;
      const outcome = await runTick(started.deps, tickNumber);
      // Refresh the numbers `/health` reports, cheaply and out of band.
      try {
        const nonces = await started.deps.wallet.availableNonces();
        lastFreeCoins = nonces.length;
        lastCandidates = started.journal.candidates(nonces).length;
      } catch {
        /* the next tick will try again */
      }
      lastDust = await readDustBalance(started.walletResult).catch(() => lastDust ?? 0n);
      return outcome;
    },
  });

  const healthInputs = (): HealthInputs => ({
    stats: scheduler.stats(),
    staleTicks: cfg.healthStaleTicks,
    dustBalance: lastDust,
    liveOffers: started.journal.summary().offers.live,
    freeCoins: lastFreeCoins,
    candidates: lastCandidates,
    journalSummary: started.journal.summary(),
    startedAt,
    now: Date.now(),
    shuttingDown,
    ready,
    ...(started.sizer === null
      ? {}
      : { giveRange: started.sizer.range, lastGiveAmount: started.sizer.last() }),
  });

  let health: HealthServer | null = null;
  try {
    health = startHealthServer({
      port: cfg.healthPort,
      snapshot: healthInputs,
      journal: () => started.journal.toJSON(),
      log: info,
    });
  } catch (err) {
    // A health port that will not bind is a deployment fault worth failing on:
    // compose's healthcheck would otherwise mark a working poster unhealthy for
    // ever, and an operator has no other window into the loop.
    console.error(`[offer-poster] could not bind POSTER_HEALTH_PORT=${cfg.healthPort}: ${errMessage(err)}`);
    await stopWallet(started.walletResult);
    return 78;
  }

  // ── periodic reconcile, independent of the tick ─────────────────────────
  const reconcileTimer = setInterval(() => {
    void reconcile(started.deps).catch((err: unknown) =>
      warn(`background reconcile failed: ${errMessage(err)}`),
    );
  }, cfg.reconcileIntervalMs);

  // ── shutdown (FR-012 / US3 scenario 2) ──────────────────────────────────
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    shuttingDown = true;
    ready = false;
    info(`${signal} received — finishing the current tick (grace ${cfg.shutdownGraceMs}ms)`);
    clearInterval(reconcileTimer);
    void (async () => {
      const graceful = scheduler.stop();
      const timedOut = Symbol("timeout");
      const outcome = await Promise.race([
        graceful.then(() => "done" as const),
        sleep(cfg.shutdownGraceMs).then(() => timedOut),
      ]);
      if (outcome === timedOut) {
        warn(`tick did not finish within SHUTDOWN_GRACE_MS=${cfg.shutdownGraceMs}ms; exiting anyway`);
      }
      // The journal is written atomically on every mutation, so `flush` is a
      // belt-and-braces final write rather than the only durability guarantee.
      try {
        started.journal.flush();
      } catch (err) {
        warn(`journal flush failed: ${errMessage(err)}`);
      }
      const stats: SchedulerStats = scheduler.stats();
      info(
        `stopping: ticks=${stats.ticks} mints=${stats.mints} reoffers=${stats.reoffers} ` +
          `success=${stats.success} failure=${stats.failure} overruns=${stats.overruns} ` +
          `p50=${stats.p50TickMs}ms p95=${stats.p95TickMs}ms`,
      );
      await health?.stop().catch(() => undefined);
      await stopWallet(started.walletResult);
      resolveExit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const first = healthSnapshot(healthInputs());
  info(`ready: /health -> ${first.status} (${String(first.body["state"])}); ticking every ${cfg.postIntervalMs}ms`);
  scheduler.start();
  return await exited;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
