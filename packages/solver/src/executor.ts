// Settlement, one fill at a time.
//
// Strictly serialised on purpose: a single wallet's coin selection would race
// itself across concurrent balances, and serialisation plus the Stock claim
// registry makes it impossible for two fills to touch the same offer.
//
// The failure path is the load-bearing part. A balance that is never submitted
// leaves its inputs locked in the wallet, so every abandoned attempt MUST
// revert or the solver silently bleeds inventory (verified in
// scripts/probe-settle.ts).

import {
  getOfferStatus,
  getZswapByHash,
  reconstructOffer,
  type OfferStatus,
} from "@zswap-da/solver-core/api-client";
import {
  describeImbalances,
  mergeFinalized,
  nonDustImbalances,
  settleViaBatcher,
} from "@zswap-da/solver-core/batcher";

import type { BookOffer } from "./book.ts";
import { claimFor, Stock, type Claim } from "./stock.ts";

export type FillOutcome =
  | { kind: "settled"; offerHash: string }
  | { kind: "skipped"; offerHash: string; reason: string }
  | { kind: "failed"; offerHash: string; reason: string };

/** Outcome of settling a merged set. `offerHashes` is every member, so a caller
 *  can release or re-evaluate the whole set rather than one leg. */
export type MatchOutcome =
  | { kind: "settled"; offerHashes: string[] }
  | { kind: "skipped"; offerHashes: string[]; reason: string }
  | { kind: "failed"; offerHashes: string[]; reason: string };

const BATCHER_ATTEMPTS = 3;

export interface WalletLike {
  balanceFinalizedTransaction: (tx: unknown, keys: unknown, opts: unknown) => Promise<any>;
  finalizeRecipe: (recipe: unknown) => Promise<any>;
  submitTransaction: (tx: unknown) => Promise<unknown>;
  revert?: (txOrRecipe: unknown) => Promise<void>;
}

export interface ExecutorOptions {
  wallet: WalletLike;
  keys: unknown;
  stock: Stock;
  api?: string;
  settleTtlMinutes?: number;
  statusPollMs?: number;
  /** Give up waiting for a settlement to be observed on chain. */
  confirmTimeoutMs?: number;
  /** Re-read balances after every terminal outcome. */
  refreshBalances?: () => Promise<void>;
  /** Build the solver's own half of a merge — supplying `gives`, receiving
   *  `wants` — already proven and finalized, ready to merge. Only called when a
   *  set does not cross exactly. Without it, only exact crossings can settle. */
  buildTopUp?: (gives: Map<string, bigint>, wants: Map<string, bigint>) => Promise<unknown>;
  log?: (msg: string) => void;
  onOutcome?: (outcome: FillOutcome) => void;
  onMatchOutcome?: (outcome: MatchOutcome) => void;
}

const MAX_ATTEMPTS = 2;

export class Executor {
  readonly #opts: Required<Pick<ExecutorOptions, "settleTtlMinutes" | "statusPollMs" | "confirmTimeoutMs">> &
    ExecutorOptions;
  readonly #stock: Stock;
  /** Resolved by the sync layer the moment an offer leaves the book, so a
   *  settlement is usually confirmed by an event rather than a poll. */
  readonly #awaitingConsumption = new Map<string, () => void>();
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: ExecutorOptions) {
    this.#opts = {
      settleTtlMinutes: 30,
      statusPollMs: 5000,
      confirmTimeoutMs: 180_000,
      ...opts,
    };
    this.#stock = opts.stock;
  }

  #log(msg: string): void {
    this.#opts.log?.(msg);
  }

  /** Tell the executor an offer left the book. Confirmation falls back to
   *  polling, so a missed call costs latency, never correctness. */
  notifyConsumed(offerHash: string): void {
    this.#awaitingConsumption.get(offerHash)?.();
  }

  /** Admit a Path A fill: the solver takes `offer` from its own inventory,
   *  paying what the offer wants. Returns once the fill reaches a terminal
   *  outcome. Offers already committed elsewhere are refused here, so the
   *  caller may enqueue optimistically. */
  fill(offer: BookOffer, payouts: Map<string, bigint>): Promise<FillOutcome> {
    const claim = claimFor([offer], payouts);
    if (!this.#stock.reserve(claim)) {
      return Promise.resolve<FillOutcome>({
        kind: "skipped",
        offerHash: offer.offerHash,
        reason: "already claimed by an in-flight fill",
      });
    }

    let settle: (outcome: FillOutcome) => void;
    const result = new Promise<FillOutcome>((resolve) => {
      settle = resolve;
    });

    this.#queue = this.#queue.then(async () => {
      let outcome: FillOutcome;
      try {
        outcome = await this.#runFill(offer);
      } catch (err) {
        outcome = {
          kind: "failed",
          offerHash: offer.offerHash,
          reason: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.#stock.release(claim);
      }
      try {
        await this.#opts.refreshBalances?.();
      } catch (err) {
        this.#log(`[solver] balance refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#opts.onOutcome?.(outcome);
      settle(outcome);
    });

    return result;
  }

  /** Admit a Path B settlement: merge `offers` into one transaction and hand it
   *  to the batcher, which adds dust and submits.
   *
   *  `net` is the set's per-token balance from the solver's side — negative
   *  entries are what it must supply. An exactly-crossing set nets to nothing
   *  and costs no inventory; anything else needs a top-up half. */
  settleMatch(offers: BookOffer[], net: Map<string, bigint>): Promise<MatchOutcome> {
    const offerHashes = offers.map((o) => o.offerHash);
    const payouts = new Map<string, bigint>();
    for (const [token, amount] of net) {
      if (amount < 0n) payouts.set(token, -amount);
    }
    const claim = claimFor(offers, payouts);
    if (!this.#stock.reserve(claim)) {
      return Promise.resolve<MatchOutcome>({
        kind: "skipped",
        offerHashes,
        reason: "a member is already claimed by an in-flight fill",
      });
    }

    let settle: (outcome: MatchOutcome) => void;
    const result = new Promise<MatchOutcome>((resolve) => {
      settle = resolve;
    });

    this.#queue = this.#queue.then(async () => {
      let outcome: MatchOutcome;
      try {
        outcome = await this.#runMatch(offers, net);
      } catch (err) {
        outcome = {
          kind: "failed",
          offerHashes,
          reason: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.#stock.release(claim);
      }
      try {
        await this.#opts.refreshBalances?.();
      } catch (err) {
        this.#log(`[solver] balance refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.#opts.onMatchOutcome?.(outcome);
      settle(outcome);
    });

    return result;
  }

  async #runMatch(offers: BookOffer[], net: Map<string, bigint>): Promise<MatchOutcome> {
    const offerHashes = offers.map((o) => o.offerHash);

    // Re-check every member at dequeue time: the queue wait may have straddled
    // another taker, and one dead member makes the whole merge unsettleable.
    for (const offer of offers) {
      const status = await this.#status(offer.offerHash);
      if (status !== "live") {
        return {
          kind: "skipped",
          offerHashes,
          reason: `${offer.offerHash.slice(0, 10)} is ${status}`,
        };
      }
    }

    const txs = [];
    for (const offer of offers) {
      const blob = offer.blob ?? (await getZswapByHash(offer.offerHash, this.#opts.api)).offerBech32;
      txs.push(reconstructOffer(blob));
    }

    // A set that does not cross exactly needs the solver's own half to close
    // it: supplying every shortfall and taking every surplus. Built like any
    // maker's half — deliberately unbalanced on its own, balanced once merged.
    const gives = new Map<string, bigint>();
    const wants = new Map<string, bigint>();
    for (const [token, amount] of net) {
      if (amount < 0n) gives.set(token, -amount);
      else if (amount > 0n) wants.set(token, amount);
    }
    if (gives.size > 0 || wants.size > 0) {
      if (!this.#opts.buildTopUp) {
        return {
          kind: "skipped",
          offerHashes,
          reason: "set does not cross exactly and no top-up builder is configured",
        };
      }
      txs.push(await this.#opts.buildTopUp(gives, wants));
    }

    const merged = mergeFinalized(txs as any);

    // The batcher balances dust only — it never supplies counterparty tokens.
    // Handing it a merge with a non-dust imbalance would spend the makers'
    // inputs without delivering what they asked for. settleViaBatcher refuses
    // too; checking here turns a throw into a clean skip.
    //
    // An UNREADABLE imbalance is refused just as firmly as an unbalanced one:
    // the check not running is not evidence that it would have passed.
    let imbalance;
    try {
      imbalance = nonDustImbalances(merged as any);
    } catch (err) {
      return {
        kind: "skipped",
        offerHashes,
        reason: `imbalance guard could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (imbalance.length > 0) {
      return {
        kind: "skipped",
        offerHashes,
        reason: `merge is not a complete swap: ${describeImbalances(merged as any)}`,
      };
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= BATCHER_ATTEMPTS; attempt++) {
      const res = await settleViaBatcher(merged as any, { level: "wait-receipt" }).catch((err) => ({
        ok: false,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      }));
      if (res.ok) break;

      lastReason = `batcher ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`;
      // A member taken by someone else mid-flight is not worth retrying.
      for (const offer of offers) {
        const status = await this.#status(offer.offerHash);
        if (status !== "live" && status !== "consumed") {
          return { kind: "skipped", offerHashes, reason: `${offer.offerHash.slice(0, 10)} is ${status}` };
        }
      }
      if (attempt === BATCHER_ATTEMPTS) return { kind: "failed", offerHashes, reason: lastReason };
      this.#log(`[solver] batcher attempt ${attempt} failed: ${lastReason}`);
      await new Promise((r) => setTimeout(r, this.#opts.statusPollMs * attempt));
    }

    // The whole set settles atomically, so one member reaching consumed is the
    // settlement; the rest are confirmed for completeness.
    for (const offerHash of offerHashes) {
      const confirmed = await this.#confirm(offerHash);
      if (confirmed !== "consumed") {
        return { kind: "failed", offerHashes, reason: `${offerHash.slice(0, 10)} ${confirmed} after settle` };
      }
    }
    return { kind: "settled", offerHashes };
  }

  async #status(offerHash: string): Promise<OfferStatus> {
    try {
      return (await getOfferStatus(offerHash, this.#opts.api)).status;
    } catch {
      // A transient API error is not evidence the offer changed state.
      return "live";
    }
  }

  async #runFill(offer: BookOffer): Promise<FillOutcome> {
    const { offerHash } = offer;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Re-check at dequeue time, not admission time: the queue wait may have
      // straddled someone else's fill or the offer's expiry.
      const status = await this.#status(offerHash);
      if (status !== "live") {
        return { kind: "skipped", offerHash, reason: `no longer live (${status})` };
      }

      const blob = offer.blob ?? (await getZswapByHash(offerHash, this.#opts.api)).offerBech32;
      const offerTx = reconstructOffer(blob);

      let recipe: unknown;
      try {
        recipe = await this.#opts.wallet.balanceFinalizedTransaction(offerTx, this.#opts.keys, {
          ttl: new Date(Date.now() + this.#opts.settleTtlMinutes * 60_000),
        });
        const settleTx = await this.#opts.wallet.finalizeRecipe(recipe);
        await this.#opts.wallet.submitTransaction(settleTx);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Whatever this attempt locked has to go back before the next one, or
        // the retry cannot fund itself from the same coins.
        await this.#revert(recipe, offerHash);

        const after = await this.#status(offerHash);
        if (after !== "live") {
          return { kind: "skipped", offerHash, reason: `${after} during settlement` };
        }
        if (attempt === MAX_ATTEMPTS) {
          return { kind: "failed", offerHash, reason };
        }
        this.#log(`[solver] fill ${offerHash.slice(0, 10)} attempt ${attempt} failed: ${reason}`);
        continue;
      }

      const confirmed = await this.#confirm(offerHash);
      if (confirmed === "consumed") return { kind: "settled", offerHash };
      return { kind: "failed", offerHash, reason: `submitted but ${confirmed}` };
    }

    return { kind: "failed", offerHash, reason: "retries exhausted" };
  }

  async #revert(recipe: unknown, offerHash: string): Promise<void> {
    if (!recipe || !this.#opts.wallet.revert) return;
    try {
      await this.#opts.wallet.revert(recipe);
    } catch (err) {
      // Nothing else can free those coins; the next balance attempt will fail
      // for want of funds, so make the cause visible rather than silent.
      this.#log(
        `[solver] revert failed for ${offerHash.slice(0, 10)} — inventory may be stranded: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Wait for the chain to show the offer consumed, preferring the event the
   *  sync layer delivers and falling back to polling. */
  async #confirm(offerHash: string): Promise<OfferStatus | "timeout"> {
    const deadline = Date.now() + this.#opts.confirmTimeoutMs;

    let onEvent: () => void;
    const consumedEvent = new Promise<void>((resolve) => {
      onEvent = resolve;
    });
    this.#awaitingConsumption.set(offerHash, onEvent!);

    try {
      while (Date.now() < deadline) {
        const status = await this.#status(offerHash);
        if (status !== "live") return status;
        await Promise.race([
          consumedEvent,
          new Promise((r) => setTimeout(r, this.#opts.statusPollMs)),
        ]);
      }
      // One last read: the event may have arrived as the deadline passed.
      const final = await this.#status(offerHash);
      return final === "live" ? "timeout" : final;
    } finally {
      this.#awaitingConsumption.delete(offerHash);
    }
  }
}
