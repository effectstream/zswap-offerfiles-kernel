// Solver orchestration. Exported as `runSolver` so an e2e can own its lifecycle
// instead of shelling out to an entrypoint.

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";

import { buildWallet, shieldedBalances, shieldedKeys, waitForSync } from "@zswap-da/solver-core/wallet";

import {
  isDryRun,
  SOLVER_EXPIRY_MARGIN_SECONDS,
  SOLVER_ID,
  SOLVER_LADDER_CONFIG,
  SOLVER_LEVELS_PUSH_INTERVAL_MS,
  SOLVER_MAX_CYCLE_LEN,
  SOLVER_RESYNC_INTERVAL_MS,
  SOLVER_SEED,
  SOLVER_SETTLE_TTL_MINUTES,
  SOLVER_STATUS_POLL_MS,
  ZSWAP_API,
} from "../env.ts";
import { Book, type BookOffer } from "./book.ts";
import { loadLadderConfig, type LoadedLadders } from "./config.ts";
import { findCandidates, type Candidate, type EngineConfig } from "./engine.ts";
import { Executor, type FillOutcome, type MatchOutcome } from "./executor.ts";
import { startLevelsPush } from "./levels-push.ts";
import { startBookSync, type BookChange, type SyncHandle } from "./sse-sync.ts";
import { Stock } from "./stock.ts";

export interface SolverOptions {
  /** Defaults to SOLVER_LADDER_CONFIG. */
  ladderConfigPath?: string;
  /** Defaults to ZSWAP_API. */
  api?: string;
  /** Mirror and decide, but never build or submit a transaction. Defaults to
   *  SOLVER_DRY_RUN. A dry run needs no wallet. */
  dryRun?: boolean;
  seed?: string;
  resyncIntervalMs?: number;
  expiryMarginSeconds?: number;
  maxCycleLen?: number;
  solverId?: string;
  levelsPushIntervalMs?: number;
  log?: (msg: string) => void;
  onOutcome?: (outcome: FillOutcome) => void;
  onMatchOutcome?: (outcome: MatchOutcome) => void;
}

export interface SolverHandle {
  readonly ladders: LoadedLadders;
  readonly book: Book;
  readonly stock: Stock;
  /** Resolves once the first full page-through has been applied. */
  ready: Promise<void>;
  /** Resolves when nothing is queued or in flight — for tests that must not
   *  race a settlement. */
  idle: () => Promise<void>;
  stop: () => Promise<void>;
}

const describeOffer = (offer: BookOffer): string => {
  const leg = (l: { token: string; amount: bigint }) => `${l.amount} ${l.token.slice(0, 8)}`;
  return `${offer.offerHash.slice(0, 10)} gives ${offer.gives.map(leg).join("+")} ` +
    `wants ${offer.wants.map(leg).join("+")}`;
};

export async function runSolver(opts: SolverOptions = {}): Promise<SolverHandle> {
  const api = opts.api ?? ZSWAP_API;
  const dryRun = opts.dryRun ?? isDryRun();
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const ladders = await loadLadderConfig(opts.ladderConfigPath ?? SOLVER_LADDER_CONFIG);
  const stock = new Stock();

  log(`[solver] network=${net.id} api=${api}${dryRun ? " DRY-RUN (no transactions)" : ""}`);
  for (const pair of ladders.ladders.pairs()) {
    const top = pair.levels[pair.levels.length - 1];
    log(
      `[solver] posting ${pair.tokenIn.slice(0, 8)}→${pair.tokenOut.slice(0, 8)} ` +
        `${pair.levels.length} rungs, up to ${top.input} in / ${top.output} out`,
    );
  }

  let wallet: Awaited<ReturnType<typeof buildWallet>> | null = null;
  let executor: Executor | null = null;
  const refreshBalances = async (): Promise<void> => {
    if (!wallet) return;
    stock.setBalances(await shieldedBalances(wallet));
  };

  if (!dryRun) {
    wallet = await buildWallet(opts.seed ?? SOLVER_SEED);
    await waitForSync(wallet);
    await refreshBalances();
    log(
      `[solver] inventory: ` +
        stock.tokens().map((t) => `${t.slice(0, 8)}=${stock.balance(t)}`).join(" ") || "[solver] inventory: empty",
    );
    const solverWallet = wallet;
    // The solver's half of a non-exact merge. Same shape as a maker's offer —
    // unbalanced alone, balanced once merged — and it pays no dust, because the
    // batcher covers the whole merged transaction.
    const buildTopUp = async (
      gives: Map<string, bigint>,
      wants: Map<string, bigint>,
    ): Promise<unknown> => {
      const address = await (solverWallet.wallet as any).shielded.getAddress();
      const recipe = await (solverWallet.wallet as any).initSwap(
        { shielded: Object.fromEntries(gives) },
        wants.size === 0
          ? []
          : [
              {
                type: "shielded",
                outputs: [...wants].map(([token, amount]) => ({
                  type: token,
                  amount,
                  receiverAddress: address,
                })),
              },
            ],
        shieldedKeys(solverWallet),
        { ttl: new Date(Date.now() + SOLVER_SETTLE_TTL_MINUTES * 60_000), payFees: false },
      );
      return (solverWallet.wallet as any).finalizeTransaction(recipe.transaction);
    };

    executor = new Executor({
      wallet: wallet.wallet as any,
      keys: shieldedKeys(wallet),
      stock,
      ...(opts.api ? { api: opts.api } : {}),
      settleTtlMinutes: SOLVER_SETTLE_TTL_MINUTES,
      statusPollMs: SOLVER_STATUS_POLL_MS,
      refreshBalances,
      buildTopUp,
      log,
      onOutcome: (outcome) => {
        const tag = outcome.kind === "settled" ? "FILLED" : outcome.kind.toUpperCase();
        log(
          `[solver] ${tag} ${outcome.offerHash.slice(0, 10)}` +
            ("reason" in outcome ? ` — ${outcome.reason}` : ""),
        );
        opts.onOutcome?.(outcome);
      },
      onMatchOutcome: (outcome) => {
        const tag = outcome.kind === "settled" ? "MATCHED" : outcome.kind.toUpperCase();
        log(
          `[solver] ${tag} ${outcome.offerHashes.map((h) => h.slice(0, 10)).join(" + ")}` +
            ("reason" in outcome ? ` — ${outcome.reason}` : ""),
        );
        opts.onMatchOutcome?.(outcome);
      },
    });
  }

  const pending = new Set<Promise<unknown>>();
  // Owned here rather than left to startBookSync, so `decide` can read it
  // without closing over a binding declared later.
  const book = new Book();
  const engineConfig = (): EngineConfig => ({
    ladders: ladders.ladders,
    refPricesUsd: ladders.refPricesUsd,
    stock,
    expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
    maxCycleLen: opts.maxCycleLen ?? SOLVER_MAX_CYCLE_LEN,
  });

  const describeCandidate = (candidate: Candidate): string =>
    candidate.kind === "pathA"
      ? `(A) ${candidate.offers[0].offerHash.slice(0, 10)} at posted ${candidate.maxPay}`
      : `(B) ${candidate.offers.map((o) => o.offerHash.slice(0, 10)).join(" + ")}` +
        (candidate.payouts.size === 0 ? " exact crossing, no inventory" : "");

  const track = (task: Promise<unknown>): void => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  /** Re-decide over the whole book. Cheap: the engine is pure and the book is
   *  in memory, and it keeps a new arrival from being judged in isolation when
   *  it could cross with something already sitting there. */
  const decide = (): void => {
    const candidates = findCandidates(book, engineConfig(), Date.now());
    for (const candidate of candidates) {
      if (dryRun) {
        log(`[solver]     WOULD FILL ${describeCandidate(candidate)}`);
        continue;
      }
      log(`[solver]     FILL ${describeCandidate(candidate)}`);
      track(
        candidate.kind === "pathA"
          ? executor!.fill(candidate.offers[0], candidate.payouts)
          : executor!.settleMatch(candidate.offers, candidate.net),
      );
    }
  };

  const onChange = (change: BookChange): void => {
    if (change.kind === "removed") {
      log(`[solver] − ${change.offerHash.slice(0, 10)} (${change.reason})`);
      if (change.reason === "consumed") executor?.notifyConsumed(change.offerHash);
      return;
    }
    log(`[solver] + ${describeOffer(change.offer)}`);
    decide();
  };

  const sync: SyncHandle = startBookSync({
    book,
    ...(opts.api ? { api: opts.api } : {}),
    resyncIntervalMs: opts.resyncIntervalMs ?? SOLVER_RESYNC_INTERVAL_MS,
    expiryMarginSeconds: opts.expiryMarginSeconds ?? SOLVER_EXPIRY_MARGIN_SECONDS,
    onChange,
    onError: (err) => log(`[solver] sync error: ${err instanceof Error ? err.message : String(err)}`),
    log,
  });

  // A dry run must not advertise prices it will not honour.
  const levels = dryRun
    ? null
    : startLevelsPush({
        api,
        solverId: opts.solverId ?? SOLVER_ID,
        ladders: ladders.ladders,
        stock,
        intervalMs: opts.levelsPushIntervalMs ?? SOLVER_LEVELS_PUSH_INTERVAL_MS,
        log,
      });

  return {
    ladders,
    book: sync.book,
    stock,
    ready: sync.ready,
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    async stop(): Promise<void> {
      levels?.stop();
      sync.stop();
      await this.idle();
      await (wallet?.wallet as any)?.stop?.().catch(() => {});
    },
  };
}
