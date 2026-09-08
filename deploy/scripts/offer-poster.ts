// offer-poster.ts — the long-running service (spec 00007, FR-001…FR-016).
//
// WHAT IT DOES
// ------------
// Every `POST_INTERVAL_MS` it puts exactly one Offer File into the kernel's
// book, and that offer's ONLY input is one coin the poster can name:
//
//   * a coin an earlier offer released (expired/cancelled/rejected AND back in
//     `availableCoins`) — re-offered at today's quote; or
//   * an unjournaled, already-spendable coin from externally prefunded inventory.
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
// `import.meta.main`; importing this module does not touch the network.
//
// ENV: see `lib/poster-config.ts` for the whole list and every default.

import { createHash } from "node:crypto";

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { collectNullifiers } from "../../packages/validator/derive.ts";
import { shieldedKeys } from "../../packages/solver-core/wallet.ts";
import { KernelApi } from "./lib/kernel-api.ts";
import { buildPinnedWallet, withPinnedCoin, type PinnedWalletResult } from "./lib/pinned-wallet.ts";
import {
  ConfigError,
  configDump,
  parsePosterConfig,
  type PosterConfig,
} from "./lib/poster-config.ts";
import { type Journal, openJournal, JournalError } from "./lib/poster-journal.ts";
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
// Wallet sync — shielded + unshielded strictly complete
// ---------------------------------------------------------------------------

/**
 * Wait for the shielded and unshielded subtrees to be strictly complete.
 *
 * The poster only needs the two trees that hold its prefunded coin and address.
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
    async availableCoins(): Promise<SpendableCoin[]> {
      const state = await shielded();
      return state.availableCoins.map((entry) => ({
        nonce: norm(entry.coin.nonce),
        type: norm(entry.coin.type),
        value: BigInt(entry.coin.value as bigint),
        nullifier: norm(entry.nullifier),
      }));
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
  firstQuote: SizedWant | null;
}

async function startup(cfg: PosterConfig): Promise<Started> {
  const api = new KernelApi(cfg.kernelBase);

  info(`kernel      : ${api.base}`);
  info(`network     : ${cfg.networkId} (indexer ${cfg.networkUrls.indexer})`);
  if (cfg.giveRange === undefined) {
    info(`give        : ${cfg.giveToken}, exact prefunded coin size ${cfg.giveAmount} base units`);
  } else {
    info(
      `give        : ${cfg.giveToken}, prefunded coin size ${cfg.giveRange.minBase}..${cfg.giveRange.maxBase} base units`,
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

  // ── the journal ─────────────────────────────────────────────────────────
  const journal = openJournal({
    file: cfg.journalFile,
    networkId: cfg.networkId,
    giveColour: cfg.giveColour,
    reset: cfg.journalReset,
  });
  info(`journal     : ${journal.file}`);

  const deps: TickDeps = {
    cfg: {
      giveColour: cfg.giveColour,
      giveAmount: cfg.giveAmount,
      giveRange: cfg.giveRange,
      wantColour: cfg.wantColour,
      forcedWantAmount: cfg.forcedWantAmount,
      offerTtlMinutes: cfg.offerTtlMinutes,
      maxReoffersPerTick: cfg.maxReoffersPerTick,
      postRetries: cfg.postRetries,
      postRetryMs: cfg.postRetryMs,
      liveTries: cfg.liveTries,
      liveIntervalMs: cfg.liveIntervalMs,
    },
    journal,
    wallet: makeWallet(walletResult),
    builder: makeBuilder(walletResult),
    api: makeApi(api),
    clock: realClock,
    log,
  };

  // ── first reconcile + first quote, so the log shows the starting picture ─
  const reconciled = await reconcile(deps);
  const summary = journal.summary();
  info(
    `journal     : ${summary.coins.total} coins (${summary.coins.available} available, ` +
      `${summary.coins.offered} offered, ${summary.coins.spent} spent, ${summary.coins.lost} lost), ` +
      `${summary.offers.total} offers (${summary.offers.live} live), ` +
      `${reconciled.candidates.length} re-offer candidate(s)`,
  );

  const inventory = await deps.wallet.availableCoins();
  const firstCoin = inventory.find((coin) =>
    coin.type === cfg.giveColour &&
    (cfg.giveRange === undefined
      ? coin.value === cfg.giveAmount
      : coin.value >= cfg.giveRange.minBase && coin.value <= cfg.giveRange.maxBase)
  );
  const firstGiveAmount = firstCoin?.value ?? cfg.giveAmount;
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

  if (firstCoin === undefined) {
    warn(`no matching prefunded GIVE_TOKEN coin is currently spendable; ticks will stay degraded until funded`);
  }
  return { cfg, walletResult, api, journal, deps, shieldedAddress, firstQuote };
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
        `"${net.id}" — the wallet follows the latter`,
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

  // ── DRY_RUN: everything above, nothing posted ───────────────────────────
  if (cfg.dryRun) {
    const summary = started.journal.summary();
    const report = {
      dryRun: true,
      networkId: cfg.networkId,
      kernel: started.api.base,
      shieldedAddress: started.shieldedAddress,
      unshieldedAddress: started.walletResult.unshieldedAddress,
      give: {
        token: cfg.giveToken,
        colour: cfg.giveColour,
        amount: cfg.giveAmount.toString(),
        ...(cfg.giveRange === undefined
          ? {}
          : { range: { minBase: cfg.giveRange.minBase.toString(), maxBase: cfg.giveRange.maxBase.toString() } }),
      },
      want: { token: cfg.wantToken, colour: cfg.wantColour },
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
    info("DRY_RUN complete — no offer was posted");
    return 0;
  }

  // ── the loop ────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  let ready = true;
  let shuttingDown = false;
  let tickNumber = 0;
  let lastGiveAmount: bigint | null = null;
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
      if (outcome.nonce !== undefined) {
        lastGiveAmount = (await started.deps.wallet.findCoin(outcome.nonce).catch(() => undefined))?.value ?? lastGiveAmount;
      }
      return outcome;
    },
  });

  const healthInputs = (): HealthInputs => ({
    stats: scheduler.stats(),
    staleTicks: cfg.healthStaleTicks,
    liveOffers: started.journal.summary().offers.live,
    freeCoins: lastFreeCoins,
    candidates: lastCandidates,
    journalSummary: started.journal.summary(),
    startedAt,
    now: Date.now(),
    shuttingDown,
    ready,
    ...(cfg.giveRange === undefined ? {} : { giveRange: cfg.giveRange, lastGiveAmount }),
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
        `stopping: ticks=${stats.ticks} inventory=${stats.inventoryAdoptions} reoffers=${stats.reoffers} ` +
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
