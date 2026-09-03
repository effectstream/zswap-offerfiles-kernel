// One tick of the offer poster, and the reconciliation that precedes it.
//
// WHY THIS IS A SEPARATE FILE FROM `offer-poster.ts`
// -------------------------------------------------
// Every decision the loop makes lives here, behind injected dependencies, and
// nothing here imports the wallet SDK, the ledger or the contract. That is not
// tidiness for its own sake: `deploy/scripts/offer-poster.ts` transitively pulls
// in `packages/solver-core/offer-files.ts`, which constructs a `CompiledContract`
// AT MODULE LOAD from `packages/contracts-midnight/contract-offer-files/src/managed`
// — a Compact build artefact that a fresh clone does not have (`bun run
// build:midnight` produces it). Importing the poster in a unit test therefore
// fails on a clean checkout, and CI has no reason to compile Compact to test a
// scheduling decision. Keeping the decisions here makes them testable with
// fakes and a real `Journal` on a temp directory.
//
// THE ORDER OF A TICK (spec FR-009, FR-010)
// -----------------------------------------
//   reconcile               refresh every non-terminal offer's kernel status;
//                           `consumed` closes the coin; compute the candidate
//                           set against the wallet's CURRENT `availableCoins`
//   candidate?              re-offer that exact coin — no mint, no DUST needed
//   else DUST sufficient?   mint one coin, wait for the wallet to see it, offer it
//   else                    degrade, and say why
//
// and then, for whichever coin was chosen:
//
//   sizeWant -> build (pinned) -> ASSERT the inputs -> post -> live -> verify
//
// THE ASSERTION IS THE PRODUCT. `build()` returns the nullifiers the finalized
// transaction actually spends; this file compares them to the ONE nullifier the
// chosen coin has, refuses anything else, and reverts the recipe so the SDK
// releases the coins it reserved. Without that comparison the poster is just a
// wallet that posts offers; with it, every offer is provably a single-coin swap.

import {
  type Journal,
  type JournalCoin,
  mapKernelStatus,
  type OfferStatus,
  type QuoteSnapshot,
} from "./poster-journal.ts";
import { NotSponsoredError, type SizedWant } from "./poster-quote.ts";
import type { TickMode, TickOutcome } from "./poster-scheduler.ts";

// ---------------------------------------------------------------------------
// Failure taxonomy (FR-015). One label per way a tick can go wrong.
// ---------------------------------------------------------------------------

export const FAILURES = {
  insufficientDust: "insufficient_dust",
  coinNotVisible: "coin_not_visible",
  wrongInputNullifier: "wrong_input_nullifier",
  notSponsored: "not_sponsored",
  unpriced: "unpriced",
  postTimeout: "post_timeout",
  kernelUnreachable: "kernel_unreachable",
  mintFailed: "mint_failed",
  buildFailed: "build_failed",
  quoteFailed: "quote_failed",
  coinVanished: "coin_vanished",
} as const;

/** `post_rejected:NOT_SPONSORED`, `post_rejected:409`, … */
export function postRejected(code: string): string {
  return `post_rejected:${code}`;
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** A spendable shielded coin as the wallet reports it. `nullifier` is what an
 *  offer spending this coin must list, and is the exact-coin assertion's
 *  reference value. */
export interface SpendableCoin {
  /** 64 lowercase hex — the CHAIN nonce `availableCoins` is keyed by. */
  nonce: string;
  /** Token colour, 64 lowercase hex. */
  type: string;
  value: bigint;
  nullifier: string;
}

export interface TickWallet {
  /** Nonces of every currently spendable shielded coin, any colour. The proof
   *  a journaled coin is free (FR-009 — the kernel status is only a hint). */
  availableNonces(): Promise<string[]>;
  /** The spendable coin with this nonce, or `undefined` when it is not free. */
  findCoin(nonce: string): Promise<SpendableCoin | undefined>;
  /** Spendable DUST, in the ledger's own units. */
  dustBalance(): Promise<bigint>;
}

export interface MintedCoinRef {
  coin: { nonce: string; type: string; value: bigint };
  nullifier: string;
  txHash: string;
  mintNonce: bigint;
}

export interface TickMinter {
  /** A nonce never used before in this process (`faucet-mint.freshNonce`). */
  freshNonce(): bigint;
  /** `mint_shielded(domainSepFromName(name), amount, nonce)`; resolves once the
   *  transaction is on chain, with the coin the contract created. */
  mint(name: string, amount: bigint, nonce: bigint): Promise<MintedCoinRef>;
}

export interface BuiltOffer {
  /** Opaque handle for `revert`. */
  recipe: unknown;
  /** `collectNullifiers(finalized)` — every shielded nullifier, guaranteed AND
   *  fallible, inputs AND transients. */
  nullifiers: string[];
  /** Inputs in the FALLIBLE section. Must be 0: an offer file is a guaranteed
   *  single-segment swap, and a fallible input would be spent conditionally. */
  fallibleInputCount: number;
  /** `swapoffer1…`. */
  blob: string;
  /** `OfferFiles.offerId(rawBytes)` — sha256 of the raw transaction bytes, the
   *  same content address the kernel keys on. */
  offerId: string;
  /** sha256 of the bech32m blob string, for the journal (FR-008). */
  blobSha256: string;
}

export interface BuildOfferArgs {
  giveColour: string;
  giveValue: bigint;
  /** The coin to pin. */
  nonce: string;
  wantColour: string;
  wantAmount: bigint;
  ttlMs: number;
}

export interface TickBuilder {
  /** pin -> `initSwap` -> `finalizeTransaction` -> encode, with the pin released
   *  in a `finally`. Never posts. */
  build(args: BuildOfferArgs): Promise<BuiltOffer>;
  /** Release the coins a recipe reserved (`wallet.revert`). */
  revert(recipe: unknown): Promise<void>;
}

export interface SizeWantArgs {
  giveColour: string;
  wantColour: string;
  giveValue: bigint;
  forcedWantAmount?: bigint | undefined;
}

export interface PostResult {
  status: number;
  body: unknown;
}

export interface KernelOfferView {
  offerId: string;
  computed?: { inputNullifiers?: string[]; status?: string } | undefined;
}

export interface TickApi {
  /** `poster-quote.sizeWant` with the kernel client already bound. */
  sizeWant(args: SizeWantArgs): Promise<SizedWant>;
  /** `POST /v1/offers`. Returns the status and body; never throws for a 4xx. */
  postOffer(blob: string): Promise<PostResult>;
  /** `POST /v1/offers/status` by blob — also the cheapest way to learn the
   *  kernel's own `offerId` for a blob. */
  offerStatusByBlob(blob: string): Promise<{ offerId?: string; status: string }>;
  /** `GET /v1/offers/:hash/status`. */
  offerStatusByHash(hash: string): Promise<{ offerId: string; status: string }>;
  /** `GET /v1/offers/:hash`. */
  getOffer(hash: string): Promise<KernelOfferView>;
}

export interface TickClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface LogFields {
  tick?: number | undefined;
  mode?: string | undefined;
  phase: string;
  ms?: number | undefined;
  nonce?: string | undefined;
  offerId?: string | undefined;
  [key: string]: unknown;
}

export type TickLog = (fields: LogFields) => void;

/** Everything a tick can size, wait for or refuse. A narrowed `PosterConfig`,
 *  so a test need not build a whole config. */
export interface TickConfig {
  giveColour: string;
  /** Faucet token NAME — minting needs the name, not the colour. */
  giveTokenName: string;
  /** The fixed per-mint size. Ignored when `TickDeps.drawGiveAmount` is
   *  supplied (00027: the operator configured a RANGE instead). */
  giveAmount: bigint;
  wantColour: string;
  forcedWantAmount?: bigint | undefined;
  offerTtlMinutes: number;
  coinVisibleTimeoutMs: number;
  /** Poll spacing while waiting for the minted coin to appear. */
  coinVisiblePollMs?: number;
  minDust: bigint;
  maxReoffersPerTick: number;
  postRetries: number;
  postRetryMs: number;
  liveTries: number;
  liveIntervalMs: number;
}

export interface TickDeps {
  cfg: TickConfig;
  journal: Journal;
  wallet: TickWallet;
  minter: TickMinter;
  builder: TickBuilder;
  api: TickApi;
  clock: TickClock;
  log: TickLog;
  /**
   * How big should THIS mint be, in base units (00027 FR-002)?
   *
   * Absent — the default — every mint is `cfg.giveAmount`, exactly as before.
   * Present, it is called ONCE PER FRESH MINT and its answer is what the faucet
   * is asked for. Injected rather than computed here for the same reason the
   * clock is: this module must stay free of randomness so a tick is replayable,
   * and `poster-size.ts` owns the distribution and the seed.
   *
   * RE-OFFERS NEVER CALL IT (AC-4). A released coin is re-offered at the value
   * it already has; its size was drawn when it was minted and cannot change.
   */
  drawGiveAmount?: (() => bigint) | undefined;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** `tick=3 mode=mint phase=post ms=812 nonce=ab… offerId=cd…` — one line per
 *  phase per tick (FR-015). Field order is fixed so `grep`/`awk` work; extra
 *  fields follow in insertion order. Nothing here can carry a secret: the
 *  caller only ever passes identifiers and durations. */
export function formatLogFields(fields: LogFields): string {
  const ordered: string[] = [];
  const push = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    const text = typeof value === "bigint" ? value.toString() : String(value);
    ordered.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  };
  push("tick", fields.tick);
  push("mode", fields.mode);
  push("phase", fields.phase);
  push("ms", fields.ms);
  push("nonce", fields.nonce);
  push("offerId", fields.offerId);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "tick" || key === "mode" || key === "phase") continue;
    if (key === "ms" || key === "nonce" || key === "offerId") continue;
    push(key, value);
  }
  return ordered.join(" ");
}

const shortHex = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : `${value.slice(0, 12)}…`;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Reconciliation (FR-009)
// ---------------------------------------------------------------------------

/** A `CoinRecord` as `Journal.candidates` returns it (deep-copied, keyed). */
export type CandidateCoin = JournalCoin & { nonce: string };

export interface ReconcileResult {
  /** Coins that are journaled, releasable AND provably free right now. */
  candidates: CandidateCoin[];
  /** The nonces the wallet reports as spendable. */
  availableNonces: string[];
  /** Offers whose status changed in this pass. */
  updated: { offerId: string; nonce: string; from: OfferStatus; to: OfferStatus }[];
  /** Coins closed as `spent` because their offer was `consumed`. */
  spent: string[];
  /** Per-offer failures (the kernel was unreachable, etc.). Never fatal. */
  errors: { offerId: string; message: string }[];
}

/**
 * Refresh every non-terminal offer against the kernel and recompute the
 * re-offer candidate set.
 *
 * Three rules from the spec that this function encodes and must not soften:
 *
 *   * `consumed` closes the COIN (`markSpent`), not just the offer. P2b's
 *     `setOfferStatus` deliberately does not do it, because…
 *   * …`cancelled` does NOT mean the coin came back. Settlement is atomic, so a
 *     partial or split spend is also reported `cancelled` — the coin may be
 *     gone. Candidacy therefore never rests on a status.
 *   * A kernel that cannot be reached leaves everything as it is, with the
 *     reason logged (US2 scenario 4). Guessing here would either double-offer a
 *     consumed coin or strand a free one.
 */
export async function reconcile(deps: TickDeps): Promise<ReconcileResult> {
  const { journal, api, wallet, log } = deps;
  const updated: ReconcileResult["updated"] = [];
  const spent: string[] = [];
  const errors: ReconcileResult["errors"] = [];

  for (const { nonce, offer } of journal.nonTerminalOffers()) {
    let raw: string;
    try {
      raw = (await api.offerStatusByHash(offer.offerId)).status;
    } catch (err) {
      errors.push({ offerId: offer.offerId, message: errMessage(err) });
      log({
        phase: "reconcile",
        nonce: shortHex(nonce),
        offerId: shortHex(offer.offerId),
        result: "unreachable",
        detail: errMessage(err),
      });
      continue;
    }
    const status = mapKernelStatus(raw);
    if (status === offer.status) continue;
    journal.setOfferStatus(nonce, offer.offerId, status);
    updated.push({ offerId: offer.offerId, nonce, from: offer.status, to: status });
    if (status === "consumed") {
      journal.markSpent(nonce);
      spent.push(nonce);
    }
    log({
      phase: "reconcile",
      nonce: shortHex(nonce),
      offerId: shortHex(offer.offerId),
      from: offer.status,
      to: status,
    });
  }

  // The `availableCoins` gate. Everything above is a hint; this is the proof.
  let availableNonces: string[] = [];
  try {
    availableNonces = await wallet.availableNonces();
  } catch (err) {
    errors.push({ offerId: "-", message: `availableCoins unreadable: ${errMessage(err)}` });
    log({ phase: "reconcile", result: "wallet_unreadable", detail: errMessage(err) });
  }
  const candidates = journal.candidates(availableNonces) as CandidateCoin[];
  log({
    phase: "reconcile",
    candidates: candidates.length,
    free: availableNonces.length,
    updated: updated.length,
    spent: spent.length,
    errors: errors.length,
  });
  return { candidates, availableNonces, updated, spent, errors };
}

// ---------------------------------------------------------------------------
// Offering one coin (FR-005 … FR-007)
// ---------------------------------------------------------------------------

export interface OfferCoinResult {
  ok: boolean;
  offerId?: string;
  failure?: string;
  error?: string;
  wantAmount?: bigint;
  sponsored?: boolean;
}

/** Turn `SizedWant` into the journal's per-offer snapshot without importing
 *  `quoteSnapshot`'s whole module graph into a test. */
function snapshotOf(sized: SizedWant): QuoteSnapshot {
  return {
    marketRate: sized.marketRate,
    sponsorDiscount: sized.sponsorDiscount,
    fromSource: sized.fromSource,
    toSource: sized.toSource,
    pricesUpdatedAt: sized.pricesUpdatedAt,
    sponsored: sized.sponsored,
  };
}

/**
 * `recordOffer`, tolerating an offer id the coin already carries.
 *
 * `Journal.recordOffer` refuses a duplicate `offerId` on one coin, which is the
 * right default — an offer id is a content address, so appending the same one
 * twice would mean the journal had lost track. But the poster CAN meet that id
 * again legitimately: `409 DUPLICATE_OFFER` says the kernel already holds this
 * exact blob, which happens when a post succeeded and the acknowledgement was
 * lost. Updating the existing entry's status is then the truthful record, and
 * it must not turn into an uncaught throw that the scheduler reports as
 * `tick_threw`.
 */
function recordOrUpdateOffer(
  journal: Journal,
  nonce: string,
  input: Parameters<Journal["recordOffer"]>[1],
): void {
  try {
    journal.recordOffer(nonce, input);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "DUPLICATE_OFFER") throw err;
    journal.setOfferStatus(nonce, input.offerId, input.status ?? "live");
  }
}

/** The kernel's refusal code, from whatever shape the body arrived in. */
export function refusalCode(status: number, body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error ?? body;
  const text = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const match = /\b([A-Z][A-Z0-9_]{3,})\b/.exec(text ?? "");
  return match?.[1] ?? String(status);
}

/** `ROOT_UNKNOWN` means the node has not yet synced the merkle root the offer
 *  was built against and `UTXO_NOT_LIVE` that it has not yet seen the coin;
 *  both self-resolve within a few blocks, and both are retried with the SAME
 *  blob — never with a fresh mint (US1 scenario 5). */
export function isRetryablePostError(body: unknown): boolean {
  const err = (body as { error?: unknown } | null)?.error ?? body;
  const text = typeof err === "string" ? err : JSON.stringify(err ?? null);
  return /ROOT_UNKNOWN|UTXO_NOT_LIVE/.test(text ?? "");
}

/**
 * Quote, build, assert, post and verify ONE offer for ONE coin.
 *
 * The coin is passed in already proven free — either straight out of the mint,
 * or out of `availableCoins` for a re-offer.
 */
export async function offerCoin(
  deps: TickDeps,
  coin: SpendableCoin,
  ctx: { tick: number; mode: TickMode },
): Promise<OfferCoinResult> {
  const { cfg, journal, builder, api, clock, log } = deps;
  const base = { tick: ctx.tick, mode: ctx.mode, nonce: shortHex(coin.nonce) };

  // ── FR-005: what should this offer want? ────────────────────────────────
  const quoteStartedAt = clock.now();
  let sized: SizedWant;
  try {
    sized = await api.sizeWant({
      giveColour: cfg.giveColour,
      wantColour: cfg.wantColour,
      giveValue: coin.value,
      forcedWantAmount: cfg.forcedWantAmount,
    });
  } catch (err) {
    if (err instanceof NotSponsoredError) {
      // US1 scenario 7: never retry blindly. Print the arithmetic and stop; the
      // coin stays journaled and free, so the next tick re-offers it.
      log({
        ...base,
        phase: "quote",
        ms: clock.now() - quoteStartedAt,
        result: "not_sponsored",
        give_usd: err.giveUsd,
        want_usd: err.wantUsd,
        implied_discount: err.impliedDiscount,
        sponsor_discount: err.sponsorDiscount,
        from_source: err.fromSource,
        to_source: err.toSource,
      });
      return { ok: false, failure: FAILURES.notSponsored, error: err.message };
    }
    log({ ...base, phase: "quote", ms: clock.now() - quoteStartedAt, result: "error", detail: errMessage(err) });
    return { ok: false, failure: FAILURES.quoteFailed, error: errMessage(err) };
  }
  for (const warning of sized.warnings) log({ ...base, phase: "quote", warning });
  log({
    ...base,
    phase: "quote",
    ms: clock.now() - quoteStartedAt,
    give: coin.value,
    want: sized.wantAmount,
    sponsored: sized.sponsored,
    forced: sized.forced,
    market_rate: sized.marketRate,
  });

  // ── FR-006: build the offer with this coin and no other ─────────────────
  const buildStartedAt = clock.now();
  let built: BuiltOffer;
  try {
    built = await builder.build({
      giveColour: cfg.giveColour,
      giveValue: coin.value,
      nonce: coin.nonce,
      wantColour: cfg.wantColour,
      wantAmount: sized.wantAmount,
      ttlMs: cfg.offerTtlMinutes * 60_000,
    });
  } catch (err) {
    log({ ...base, phase: "build", ms: clock.now() - buildStartedAt, result: "error", detail: errMessage(err) });
    return { ok: false, failure: FAILURES.buildFailed, error: errMessage(err) };
  }

  // THE ASSERTION. Exactly one input, exactly this coin's nullifier, nothing in
  // the fallible section. Anything else is reverted and never posted (US1
  // scenario 4) — a mis-built offer would spend a coin the journal does not
  // know about, which is the one failure this whole design exists to prevent.
  const expected = coin.nullifier.toLowerCase();
  const got = built.nullifiers.map((n) => n.toLowerCase());
  if (got.length !== 1 || got[0] !== expected || built.fallibleInputCount !== 0) {
    const detail =
      `expected exactly [${expected.slice(0, 16)}…], got [${got.map((n) => `${n.slice(0, 16)}…`).join(", ")}]` +
      (built.fallibleInputCount === 0 ? "" : ` plus ${built.fallibleInputCount} fallible input(s)`);
    log({ ...base, phase: "assert", offerId: shortHex(built.offerId), result: "mismatch", detail });
    try {
      await builder.revert(built.recipe);
      log({ ...base, phase: "revert", result: "ok" });
    } catch (err) {
      log({ ...base, phase: "revert", result: "error", detail: errMessage(err) });
    }
    return { ok: false, failure: FAILURES.wrongInputNullifier, error: detail };
  }
  log({
    ...base,
    phase: "build",
    ms: clock.now() - buildStartedAt,
    offerId: shortHex(built.offerId),
    chars: built.blob.length,
  });

  // ── FR-007: post, with the bounded retry `maker-offer.ts` established ───
  const postStartedAt = clock.now();
  let accepted = false;
  let lastBody: unknown = null;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= cfg.postRetries; attempt++) {
    let result: PostResult;
    try {
      result = await api.postOffer(built.blob);
    } catch (err) {
      // A transport failure is not a refusal: the kernel may be restarting.
      log({ ...base, phase: "post", attempt, result: "unreachable", detail: errMessage(err) });
      if (attempt === cfg.postRetries) {
        await revertQuietly(deps, built, base);
        return { ok: false, failure: FAILURES.kernelUnreachable, error: errMessage(err) };
      }
      await clock.sleep(cfg.postRetryMs);
      continue;
    }
    lastStatus = result.status;
    lastBody = result.body;
    if (result.status === 200 || result.status === 201) {
      accepted = true;
      break;
    }
    if (isRetryablePostError(result.body)) {
      log({ ...base, phase: "post", attempt, result: "retry", status: result.status });
      if (attempt === cfg.postRetries) break;
      await clock.sleep(cfg.postRetryMs);
      continue;
    }
    // A real refusal (422 NOT_SPONSORED / UNPRICED_TOKEN / PRICE_UNAVAILABLE,
    // 409 DUPLICATE_*). Record the attempt so the coin's history shows it, then
    // stop — retrying an identical blob cannot change the answer.
    const code = refusalCode(result.status, result.body);
    recordOrUpdateOffer(journal, coin.nonce, {
      offerId: built.offerId,
      blobSha256: built.blobSha256,
      ttlSec: cfg.offerTtlMinutes * 60,
      wantColour: cfg.wantColour,
      wantAmount: sized.wantAmount,
      quote: snapshotOf(sized),
      status: "rejected",
    });
    log({
      ...base,
      phase: "post",
      ms: clock.now() - postStartedAt,
      offerId: shortHex(built.offerId),
      result: "rejected",
      status: result.status,
      code,
      body: JSON.stringify(result.body ?? null).slice(0, 400),
    });
    await revertQuietly(deps, built, base);
    return {
      ok: false,
      failure: code === "UNPRICED_TOKEN" ? FAILURES.unpriced : postRejected(code),
      error: `POST /v1/offers -> ${result.status}: ${JSON.stringify(result.body ?? null).slice(0, 400)}`,
    };
  }

  if (!accepted) {
    log({
      ...base,
      phase: "post",
      ms: clock.now() - postStartedAt,
      result: "exhausted",
      status: lastStatus,
      body: JSON.stringify(lastBody ?? null).slice(0, 400),
    });
    await revertQuietly(deps, built, base);
    return {
      ok: false,
      failure: FAILURES.postTimeout,
      error: `offer never accepted after ${cfg.postRetries} attempts (last ${lastStatus}: ${JSON.stringify(
        lastBody ?? null,
      ).slice(0, 300)})`,
    };
  }

  // Journal the offer AS SOON AS the kernel accepts it, before the liveness
  // poll. A crash in the polling window would otherwise lose an offer the
  // kernel is holding, and the coin would look free while a live offer claims
  // it. `live` is the status a just-accepted offer has; reconciliation corrects
  // it if that turns out to be wrong.
  recordOrUpdateOffer(journal, coin.nonce, {
    offerId: built.offerId,
    blobSha256: built.blobSha256,
    ttlSec: cfg.offerTtlMinutes * 60,
    wantColour: cfg.wantColour,
    wantAmount: sized.wantAmount,
    quote: snapshotOf(sized),
    status: "live",
  });
  log({
    ...base,
    phase: "post",
    ms: clock.now() - postStartedAt,
    offerId: shortHex(built.offerId),
    result: "accepted",
  });

  // ── wait for the kernel's book to show it ───────────────────────────────
  const liveStartedAt = clock.now();
  let live = false;
  for (let attempt = 1; attempt <= cfg.liveTries; attempt++) {
    await clock.sleep(cfg.liveIntervalMs);
    let status: string;
    let kernelOfferId: string | undefined;
    try {
      const answer = await api.offerStatusByBlob(built.blob);
      status = answer.status;
      kernelOfferId = answer.offerId;
    } catch (err) {
      log({ ...base, phase: "live", attempt, result: "unreachable", detail: errMessage(err) });
      continue;
    }
    if (kernelOfferId !== undefined && kernelOfferId.toLowerCase() !== built.offerId.toLowerCase()) {
      // Locally computed content address vs the kernel's. A disagreement means
      // the two are hashing different bytes, which invalidates every journal
      // lookup — fail loudly rather than journal a wrong id.
      const detail = `kernel offerId ${kernelOfferId} != locally computed ${built.offerId}`;
      log({ ...base, phase: "live", result: "id_mismatch", detail });
      journal.setOfferStatus(coin.nonce, built.offerId, "unknown");
      return { ok: false, failure: FAILURES.postTimeout, error: detail };
    }
    if (status === "live") {
      live = true;
      break;
    }
    if (status === "consumed" || status === "cancelled" || status === "expired") {
      journal.setOfferStatus(coin.nonce, built.offerId, mapKernelStatus(status));
      const detail = `offer reached terminal status "${status}" before going live`;
      log({ ...base, phase: "live", offerId: shortHex(built.offerId), result: status });
      return { ok: false, failure: FAILURES.postTimeout, error: detail };
    }
    log({ ...base, phase: "live", attempt, status });
  }
  if (!live) {
    journal.setOfferStatus(coin.nonce, built.offerId, "unknown");
    log({ ...base, phase: "live", ms: clock.now() - liveStartedAt, result: "timeout" });
    return {
      ok: false,
      failure: FAILURES.postTimeout,
      error: `offer ${built.offerId} did not reach "live" within ${cfg.liveTries} polls`,
    };
  }

  // ── the kernel's own view of what this offer spends (FR-007) ────────────
  try {
    const view = await api.getOffer(built.offerId);
    const kernelNullifiers = (view.computed?.inputNullifiers ?? []).map((n) => n.toLowerCase());
    if (kernelNullifiers.length !== 1 || kernelNullifiers[0] !== expected) {
      const detail =
        `kernel reports inputNullifiers [${kernelNullifiers.join(", ")}] for offer ${built.offerId}, ` +
        `expected exactly [${expected}]`;
      log({ ...base, phase: "verify", offerId: shortHex(built.offerId), result: "mismatch", detail });
      // The offer IS live and IS recorded; do not rewrite its status. The tick
      // fails so the operator sees it, because this can only mean the local
      // assertion and the kernel disagree about the same bytes.
      return { ok: false, failure: FAILURES.wrongInputNullifier, error: detail };
    }
    log({ ...base, phase: "verify", offerId: shortHex(built.offerId), result: "ok" });
  } catch (err) {
    // The offer is live and journaled; a failed read-back is worth a warning,
    // not a failed tick.
    log({ ...base, phase: "verify", offerId: shortHex(built.offerId), result: "unread", detail: errMessage(err) });
  }

  return { ok: true, offerId: built.offerId, wantAmount: sized.wantAmount, sponsored: sized.sponsored };
}

async function revertQuietly(deps: TickDeps, built: BuiltOffer, base: Record<string, unknown>): Promise<void> {
  try {
    await deps.builder.revert(built.recipe);
    deps.log({ ...base, phase: "revert", result: "ok" } as LogFields);
  } catch (err) {
    deps.log({ ...base, phase: "revert", result: "error", detail: errMessage(err) } as LogFields);
  }
}

// ---------------------------------------------------------------------------
// Mint (FR-003 / FR-004)
// ---------------------------------------------------------------------------

export interface MintOutcome {
  ok: boolean;
  coin?: SpendableCoin;
  /** The mint transaction landed, whatever happened afterwards. */
  minted: boolean;
  failure?: string;
  error?: string;
}

/**
 * Mint one coin and wait until the wallet can spend it.
 *
 * ON THE ORDER OF THE JOURNAL WRITES — this differs from FR-003's letter, and
 * it has to. FR-003 says "journal the nonce BEFORE submit", but the identity a
 * coin has is `evolveNonce(mintNonce, domainSep)`, computed INSIDE the circuit
 * (`offer-files.compact:22`); `evolveNonce` is not exported by `ledger-v8`, by
 * `onchain-runtime-v3` or by `compact-runtime` (checked at these versions), and
 * the generated circuit module is a Compact build artefact `deploy/` cannot
 * import. So the chain nonce simply does not exist until `mint_shielded`
 * returns, and there is nothing to write down before it does.
 *
 * What is preserved is the guarantee FR-003 was reaching for: the FIRST thing
 * that happens after the mint returns is the journal write, before the quote,
 * the build or the post. The crash window is a couple of synchronous file
 * operations, and SC-004's kill point ("after the mint log line, before post")
 * is safely inside the journaled region.
 */
export async function mintCoin(deps: TickDeps, ctx: { tick: number }): Promise<MintOutcome> {
  const { cfg, journal, minter, wallet, clock, log } = deps;
  const base = { tick: ctx.tick, mode: "mint" as const };
  const mintNonce = minter.freshNonce();
  const startedAt = clock.now();
  // 00027 FR-002: one draw per FRESH mint. The want leg is sized further down
  // in `offerCoin` from the coin's OWN value, so it follows this number without
  // any change there.
  const giveAmount = deps.drawGiveAmount === undefined ? cfg.giveAmount : deps.drawGiveAmount();

  let minted: MintedCoinRef;
  try {
    minted = await minter.mint(cfg.giveTokenName, giveAmount, mintNonce);
  } catch (err) {
    const message = errMessage(err);
    log({ ...base, phase: "mint", ms: clock.now() - startedAt, result: "error", mintNonce, detail: message });
    return {
      ok: false,
      minted: false,
      // A dust shortfall surfaces from deep inside the SDK's balancer; the
      // pre-check cannot see the exact fee, so classify it here too.
      failure: /dust|fee|insufficient/i.test(message) ? FAILURES.insufficientDust : FAILURES.mintFailed,
      error: message,
    };
  }

  const nonce = minted.coin.nonce.toLowerCase();
  journal.recordMintIntent(nonce, minted.coin.type, minted.coin.value);
  journal.recordMinted(nonce, { txHash: minted.txHash, nullifier: minted.nullifier });
  log({
    ...base,
    phase: "mint",
    ms: clock.now() - startedAt,
    nonce: shortHex(nonce),
    mintNonce,
    give: giveAmount,
    value: minted.coin.value,
    tx: shortHex(minted.txHash),
  });

  // FR-004: the wallet has to SEE the coin before it can spend it.
  const visibleStartedAt = clock.now();
  const pollMs = cfg.coinVisiblePollMs ?? 2_000;
  const deadline = visibleStartedAt + cfg.coinVisibleTimeoutMs;
  for (;;) {
    let found: SpendableCoin | undefined;
    try {
      found = await wallet.findCoin(nonce);
    } catch (err) {
      log({ ...base, phase: "visible", nonce: shortHex(nonce), result: "error", detail: errMessage(err) });
    }
    if (found !== undefined) {
      log({ ...base, phase: "visible", ms: clock.now() - visibleStartedAt, nonce: shortHex(nonce) });
      // Trust the wallet's nullifier over the locally computed one when they
      // disagree — but they must not, so say so rather than paper over it.
      if (found.nullifier.toLowerCase() !== minted.nullifier.toLowerCase()) {
        log({
          ...base,
          phase: "visible",
          nonce: shortHex(nonce),
          result: "nullifier_disagreement",
          wallet: found.nullifier,
          computed: minted.nullifier,
        });
      }
      return { ok: true, minted: true, coin: found };
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(pollMs);
  }

  // US1 scenario 3: the coin is journaled as `minted`, NOT lost. It is on chain;
  // a later tick will find it in `availableCoins` and re-offer it.
  log({
    ...base,
    phase: "visible",
    ms: clock.now() - visibleStartedAt,
    nonce: shortHex(nonce),
    result: "timeout",
  });
  return {
    ok: false,
    minted: true,
    failure: FAILURES.coinNotVisible,
    error: `minted coin ${nonce} was not spendable within COIN_VISIBLE_TIMEOUT_MS=${cfg.coinVisibleTimeoutMs}`,
  };
}

// ---------------------------------------------------------------------------
// The tick (FR-010)
// ---------------------------------------------------------------------------

/**
 * Reconcile, then re-offer released coins if there are any, else mint one, else
 * degrade. At most `POSTER_MAX_REOFFERS_PER_TICK` offers per tick.
 *
 * A candidate ALWAYS wins over a mint, even when DUST is plentiful: re-offering
 * keeps the wallet's coin count bounded by the number of live offers (US2), and
 * it needs no DUST at all, which is what makes US1 scenario 6 ("insufficient
 * DUST still services a re-offer") work without a special case.
 */
export async function runTick(deps: TickDeps, tick: number): Promise<TickOutcome> {
  const { cfg, wallet, clock, log } = deps;
  const startedAt = clock.now();
  log({ tick, phase: "start" });

  let reconciled: ReconcileResult;
  try {
    reconciled = await reconcile(deps);
  } catch (err) {
    return {
      ok: false,
      mode: "degraded",
      failure: FAILURES.kernelUnreachable,
      error: `reconcile failed: ${errMessage(err)}`,
    };
  }

  // ── re-offer branch ─────────────────────────────────────────────────────
  const budget = Math.max(1, cfg.maxReoffersPerTick);
  let posted = 0;
  let lastOfferId: string | undefined;
  let lastNonce: string | undefined;
  for (const candidate of reconciled.candidates.slice(0, budget)) {
    const coin = await wallet.findCoin(candidate.nonce).catch(() => undefined);
    if (coin === undefined) {
      // It was free when `reconcile` looked and is not now — another offer's
      // TTL reservation, or the coin was just spent. Not an error.
      log({ tick, mode: "reoffer", phase: "select", nonce: shortHex(candidate.nonce), result: "vanished" });
      continue;
    }
    const result = await offerCoin(deps, coin, { tick, mode: "reoffer" });
    lastNonce = coin.nonce;
    if (!result.ok) {
      log({ tick, mode: "reoffer", phase: "end", ms: clock.now() - startedAt, result: "failed", failure: result.failure });
      return {
        ok: false,
        mode: "reoffer",
        nonce: coin.nonce,
        ...(result.offerId !== undefined ? { offerId: result.offerId } : {}),
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    }
    posted += 1;
    lastOfferId = result.offerId;
  }
  if (posted > 0) {
    log({ tick, mode: "reoffer", phase: "end", ms: clock.now() - startedAt, offerId: shortHex(lastOfferId), offers: posted });
    return {
      ok: true,
      mode: "reoffer",
      ...(lastOfferId !== undefined ? { offerId: lastOfferId } : {}),
      ...(lastNonce !== undefined ? { nonce: lastNonce } : {}),
    };
  }

  // ── mint branch ─────────────────────────────────────────────────────────
  let dust = 0n;
  try {
    dust = await wallet.dustBalance();
  } catch (err) {
    log({ tick, phase: "dust", result: "error", detail: errMessage(err) });
  }
  if (dust < cfg.minDust) {
    // US1 scenario 6. Not a FAILURE — the world is in a state the poster cannot
    // fix, and `/health` says so through `mode=degraded`. A run of these does
    // not trip the 503, which is deliberate: a poster waiting for NIGHT is
    // working correctly.
    log({
      tick,
      mode: "degraded",
      phase: "end",
      ms: clock.now() - startedAt,
      result: FAILURES.insufficientDust,
      dust,
      min_dust: cfg.minDust,
    });
    return {
      ok: true,
      mode: "degraded",
      failure: FAILURES.insufficientDust,
      error: `spendable DUST ${dust} < POSTER_MIN_DUST ${cfg.minDust}; skipping the mint (re-offers need no DUST)`,
    };
  }

  const mint = await mintCoin(deps, { tick });
  if (!mint.ok || mint.coin === undefined) {
    log({ tick, mode: "mint", phase: "end", ms: clock.now() - startedAt, result: "failed", failure: mint.failure });
    return {
      ok: false,
      mode: "mint",
      minted: mint.minted,
      ...(mint.failure !== undefined ? { failure: mint.failure } : {}),
      ...(mint.error !== undefined ? { error: mint.error } : {}),
    };
  }

  const result = await offerCoin(deps, mint.coin, { tick, mode: "mint" });
  log({
    tick,
    mode: "mint",
    phase: "end",
    ms: clock.now() - startedAt,
    nonce: shortHex(mint.coin.nonce),
    offerId: shortHex(result.offerId),
    result: result.ok ? "ok" : "failed",
    ...(result.failure !== undefined ? { failure: result.failure } : {}),
  });
  return {
    ok: result.ok,
    mode: "mint",
    minted: true,
    nonce: mint.coin.nonce,
    ...(result.offerId !== undefined ? { offerId: result.offerId } : {}),
    ...(result.failure !== undefined ? { failure: result.failure } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
