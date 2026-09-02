import {
  CelestiaAdapter,
  type CelestiaAdapterConfig,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";
import { getBlankRefState, validateZswapOffer, type OfferLeg } from "@zswap-da/validator";
import {
  DedupStore,
  evaluateSponsorship,
  offerHashFromBlob,
  sponsorDiscountFromBps,
  sponsorshipReason,
} from "@zswap-da/offer-guard";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import type { BatcherConfig, SponsorPolicy, UnpricedPolicy } from "./config.ts";
import { PriceCache } from "./price-cache.ts";

// DoS guard on the decoded offer size; mirrors the node's OFFER_MAX_BYTES. The
// base adapter separately caps the on-wire blob at 1.5 MB.
const OFFER_MAX_BYTES = parseInt(
  process.env["OFFER_MAX_BYTES"] ?? String(1024 * 1024),
  10,
);

type ValidationResult = { valid: boolean; error?: string };

/**
 * Everything the fee-sponsorship gate needs. Passed in rather than read from
 * the environment inside the adapter so the policy is testable without env
 * mutation, and so `createCelestiaAdapter` remains the single place that turns
 * configuration into behaviour.
 */
export interface SponsorshipGate {
  /** null = this adapter has no price source; only `off` makes sense then. */
  cache: PriceCache | null;
  policy: SponsorPolicy;
  unpriced: UnpricedPolicy;
  /** Beyond this, a held snapshot no longer counts as an answer. */
  maxAgeMs: number;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * How often the "I have no prices" warning may repeat in `warn` mode. The
 * condition is a property of the BATCHER, not of the offer, so it would
 * otherwise print an identical line for every single submission while the node
 * is down — burying the per-offer lines that `warn` mode exists to produce.
 */
const UNAVAILABLE_WARN_INTERVAL_MS = 60_000;

/** A sponsorship gate that does nothing — the default when none is wired. */
const NO_GATE: SponsorshipGate = {
  cache: null,
  policy: "off",
  unpriced: "allow",
  maxAgeMs: 0,
};

const usd = (value: number): string => value.toFixed(2);

// CelestiaAdapter that validates a ZSwap offer before the batcher posts it (and
// pays a TIA fee). The batcher invokes `validateInput` in `batchInput()` BEFORE
// the blob is queued or submitted, so a rejected offer never costs a fee. This
// is the authoritative pre-fee gate — it also covers producers that hit the
// batcher's `/send-input` directly, bypassing `/api/zswap/submit`.
export class ZswapCelestiaAdapter extends CelestiaAdapter {
  private readonly networkId: string;
  // Published-hash dedup: the batcher's own store (it has no DB). Consulted
  // FIRST in validateInput — a replay must never cost a proof verification,
  // let alone a fee — and written ONLY on successful publish (marking at
  // validation time would block a legitimate retry after a failed submit).
  // In-memory: empties on restart, in which case one duplicate fee can slip
  // through; the node-side STM dedup is permanent, so the network never
  // indexes the duplicate. See DedupStore in @zswap-da/offer-guard.
  private readonly published = new DedupStore();

  private readonly gate: SponsorshipGate;
  // Named `gate*` rather than `now`/`log`/`warn`: CelestiaAdapter already owns
  // a `log` property (a LOGGER OBJECT — it calls `this.log.warn(...)`), and
  // shadowing it with a function silently broke the base class's own readiness
  // probe. Measured, not guessed: the first version of this file crashed
  // `this.log.warn is not a function` on every adapter construction.
  private readonly gateNow: () => number;
  private readonly gateLog: (line: string) => void;
  private readonly gateWarn: (line: string) => void;
  private lastUnavailableWarnAt = -Infinity;

  constructor(
    config: CelestiaAdapterConfig,
    networkId: string,
    gate: SponsorshipGate = NO_GATE,
  ) {
    super(config);
    this.networkId = networkId;
    this.gate = gate;
    this.gateNow = gate.now ?? (() => Date.now());
    this.gateLog = gate.log ?? ((line) => console.log(line));
    this.gateWarn = gate.warn ?? ((line) => console.warn(line));
  }

  /**
   * The seam the SDK calls. It is `any`-typed on purpose: the
   * `BlockchainAdapter` INTERFACE declares
   * `validateInput?(input): ValidationResult | Promise<ValidationResult>`
   * (batcher-sdk adapters/adapter.ts:145) and the core awaits the result
   * (core/batcher.ts:513), so an async gate is fully supported — but the
   * `CelestiaAdapter` BASE CLASS narrows the return to the synchronous half,
   * and TypeScript will not let a subclass widen a method's return type. The
   * honest signature therefore lives on `validateOffer` below, which is what
   * the tests drive; this method only forwards. Same widening the
   * `buildBatchData`/`submitBatch` overrides already use.
   */
  override validateInput(input: DefaultBatcherInput): any {
    return this.validateOffer(input);
  }

  /** The real gate. Callers outside the SDK should use this. */
  async validateOffer(input: DefaultBatcherInput): Promise<ValidationResult> {
    // Base adapter checks: non-empty string input + max blob size.
    const base = super.validateInput(input);
    if (!base.valid) return base;

    // Dedup before any expensive work. Hashing needs only a bech32m decode
    // (cheap, O(n)); if the blob does not even decode, fall through — full
    // validation below rejects it with a precise code.
    try {
      const hash = offerHashFromBlob(input.input);
      if (this.published.has(hash)) {
        return {
          valid: false,
          error:
            `DUPLICATE_OFFER: this batcher already published ${hash} — not paying twice for the same bytes`,
        };
      }
    } catch {
      /* undecodable — let validateZswapOffer produce the real error */
    }

    // Structure + cryptographic proofs (steps 1–5): rejects malformed, forged,
    // and non-swap offers — the bulk of fee-wasting "bad" blobs. This is
    // self-contained (blank reference state + bundled verifier keys; no network
    // call), so the fee gate has no live dependency.
    //
    // Liveness (already-spent coins) is NOT repeated here: the batcher has no DB
    // access and the indexer has no point-lookup ("is X spent?") query — only
    // filtered subscriptions (unshieldedTransactions(address),
    // shieldedNullifierTransactions(nullifierPrefixes)). Liveness is enforced
    // deterministically at STM ingestion and at /api/zswap/submit (both consult
    // the node's permanent spent_* sets). Adding subscription-based best-effort
    // liveness here (indexer unshieldedTransactions / nullifier search) is a
    // clean follow-up.
    // Crypto runs INLINE here (the default), unlike the node's ingestion and
    // submit paths which defer it behind indexed dedup/liveness probes. The
    // batcher has no DB, so it has no cheaper discriminator to put first — and
    // its whole job is deciding whether an offer is worth a Celestia fee, a
    // question only proof verification answers. Note this gate is advisory for
    // the network as a whole: makers can post to the namespace directly, so
    // the STM ingestion ladder remains the authoritative filter.
    const result = validateZswapOffer(input.input, {
      refState: getBlankRefState(this.networkId),
      tblock: new Date(),
      maxBytes: OFFER_MAX_BYTES,
    });
    if (!result.ok) {
      return { valid: false, error: `${result.code}: ${result.reason ?? ""}` };
    }

    // Fee-sponsorship policy gate: the batcher only pays the Celestia posting
    // fee for "good trades". LAST, and deliberately so despite being the
    // cheapest check here — it needs `gives`/`wants`, which only exist once the
    // transaction has been deserialized AND its proofs verified. Running it
    // earlier would mean logging trade values read out of an unverified (and
    // possibly forged) transaction, and refusing offers with numbers that were
    // never real.
    const sponsorship = this.checkForCelestiaSponsorship(result.gives ?? [], result.wants ?? []);
    if (!sponsorship.valid) return sponsorship;

    return { valid: true };
  }

  // Publish the RAW MIP-0005 transaction bytes to Celestia, not the bech32m
  // string (MIP-0006): bech32m is a display encoding and wastes ~1.6× the
  // blob for no benefit. The base adapter base64s `input` as UTF-8, which
  // cannot carry binary — so we decode the bech32m input to bytes here and
  // hand the base adapter a payload it will base64 verbatim. `rawData` stays
  // the bech32m string for logging / the dedup record.
  override buildBatchData(inputs: any[], options?: any): any {
    const built = super.buildBatchData(inputs, options);
    if (!built) return built;
    // rawData moved from the result's top level (batcher-sdk 0.101.x) into
    // `data` (0.103.0). Read both so an SDK bump cannot silently strand it —
    // and if NEITHER is present or the decode fails, THROW instead of
    // shipping the base adapter's UTF-8 payload: validateInput already
    // guaranteed a decodable offer, so failure here is a wiring bug, and
    // "fail safe" here would mean paying a Celestia fee to publish a blob
    // every reader rejects. (That exact silent fallback put bech32m STRINGS
    // on the namespace when 0.103.0 moved the field — live-debugged
    // 2026-08-03; the STM rejected every one with BAD_DESERIALIZE.)
    const raw = built.data?.rawData ?? built.rawData;
    const rawBytes = OfferFiles.decode(raw);
    // Base64 of the raw bytes becomes blob.data (Celestia stores these
    // bytes; the read side recovers them via atob → latin1 → Uint8Array).
    built.data.blob.data = Buffer.from(rawBytes).toString("base64");
    return built;
  }

  override async submitBatch(data: any, fee: string | bigint): Promise<any> {
    const txhash = await super.submitBatch(data, fee);
    // Record AFTER the publish succeeded — this is the moment the fee is
    // irrevocably spent, so it is the moment a repeat becomes "paying twice".
    try {
      this.published.add(offerHashFromBlob(data.rawData ?? data.data?.rawData));
    } catch {
      /* non-offer payload — nothing to record */
    }
    return txhash;
  }

  /**
   * The Celestia fee-sponsorship policy: is this offer a good enough trade to
   * be worth a TIA fee?
   *
   * The RULE is not here — it is `evaluateSponsorship` in
   * `@zswap-da/offer-guard`, the same function the node's `/v1/quote` uses to
   * tell the maker whether they will be sponsored and the same one its
   * `POST /v1/offers` pre-check uses to answer 422 (D4). This method only
   * applies the deployment's POLICY to that verdict: what to do when the
   * prices are missing, and what to do when the tokens have no market at all.
   *
   * The legs come from the `validateZswapOffer` result the caller already
   * computed — the transaction is deserialized and verified exactly once.
   *
   * Note this whole gate is ADVISORY for the network: the MIP-0006 namespace
   * is permissionless, so a maker can post an unsponsored offer to Celestia
   * themselves and it will still be indexed. What it protects is this
   * batcher's wallet.
   */
  private checkForCelestiaSponsorship(
    gives: readonly OfferLeg[],
    wants: readonly OfferLeg[],
  ): ValidationResult {
    const { policy, unpriced, cache, maxAgeMs } = this.gate;
    if (policy === "off") return { valid: true };

    const fresh = cache !== null && cache.isFresh(maxAgeMs);
    if (!fresh) {
      // The batcher cannot tell a good trade from a bad one right now. Which
      // way that should fail is a deployment decision, not a code decision:
      // `enforce` protects the wallet, `warn` protects the site.
      // `cache === null` first, so `age` narrows to `number | null` rather
      // than carrying an `undefined` TypeScript cannot rule out later.
      const age = cache === null ? null : cache.ageMs();
      const detail =
        cache === null
          ? "no price source configured"
          : age === null
            ? `${cache.pricesUrl} has never answered`
            : `last answer from ${cache.pricesUrl} is ${Math.round(age / 1000)}s old ` +
              `(max ${Math.round(maxAgeMs / 1000)}s)`;
      if (policy === "enforce") {
        return {
          valid: false,
          error: `PRICE_UNAVAILABLE: cannot check sponsorship — ${detail}`,
        };
      }
      // warn: sponsor anyway, but say so — at most once a minute, because the
      // condition is the batcher's, not the offer's, and would otherwise print
      // identically for every submission.
      const now = this.gateNow();
      if (now - this.lastUnavailableWarnAt >= UNAVAILABLE_WARN_INTERVAL_MS) {
        this.lastUnavailableWarnAt = now;
        this.gateWarn(
          `[zswap-da-batcher] sponsoring WITHOUT a price check — ${detail} ` +
            "(BATCHER_SPONSOR_POLICY=warn; set enforce to refuse instead)",
        );
      }
      return { valid: true };
    }

    const snapshot = cache!.snapshot()!;
    const discount = snapshot.sponsorDiscount;
    const verdict = evaluateSponsorship({ gives, wants }, snapshot.prices, discount);

    if (verdict.verdict === "unpriced") {
      // Test tokens and anything the faucet minted live here. There is no
      // market to be above or below, so this is NOT a bad trade — it is an
      // unanswerable question, and D7's default is to keep such offers flowing.
      const colors = verdict.unpriced.join(", ");
      if (unpriced === "reject") {
        return { valid: false, error: `UNPRICED_TOKEN: no market price for ${colors}` };
      }
      this.gateLog(
        `[zswap-da-batcher] sponsoring an unpriced offer (no market price for ${colors}; ` +
          "BATCHER_SPONSOR_UNPRICED=allow)",
      );
      return { valid: true };
    }

    if (verdict.verdict === "not_sponsored") {
      const reason =
        `NOT_SPONSORED: ${sponsorshipReason(verdict, discount)} ` +
        `(give_usd ${usd(verdict.give_usd)}, want_usd ${usd(verdict.want_usd)})`;
      if (policy === "enforce") return { valid: false, error: reason };
      // warn: one line PER OFFER, not throttled — these lines are the whole
      // point of a `warn` rollout (D7), they are what an operator counts before
      // switching to `enforce`, and each carries different numbers.
      this.gateWarn(`[zswap-da-batcher] would refuse (policy=warn) — ${reason}`);
      return { valid: true };
    }

    return { valid: true };
  }

  /** One line for the startup log: what will this batcher actually do? */
  describeSponsorship(): string {
    const { policy, unpriced, cache, maxAgeMs } = this.gate;
    if (policy === "off") return "sponsorship: policy=off (every valid offer is sponsored)";
    return (
      `sponsorship: policy=${policy} unpriced=${unpriced} ` +
      `max_age=${Math.round(maxAgeMs / 1000)}s ` +
      (cache === null ? "prices=NONE (no source configured)" : cache.describe())
    );
  }

  /** Stop the price poll. Called on shutdown; safe to call when there is none. */
  stop(): void {
    this.gate.cache?.stop();
  }
}

/**
 * The one place configuration becomes behaviour. All three entrypoints
 * (dev/preview/mainnet) call this, so the fee gate cannot be wired on one
 * network and missing on another.
 *
 * The price poll starts here rather than lazily on the first offer: an
 * operator must be able to read "am I price-aware?" off the startup log,
 * before anything has been submitted.
 */
export function createCelestiaAdapter(
  batcherConfig: BatcherConfig,
): ZswapCelestiaAdapter {
  const sponsorship = batcherConfig.sponsorship;
  const cache =
    sponsorship.policy === "off"
      ? null
      : new PriceCache({
          url: sponsorship.nodeApiUrl,
          refreshMs: sponsorship.priceRefreshMs,
          fallbackDiscount: sponsorDiscountFromBps(sponsorship.fallbackDiscountBps),
        });
  const adapter = new ZswapCelestiaAdapter(
    {
      rpcUrl: batcherConfig.celestia.rpcUrl,
      namespace: batcherConfig.celestia.namespace,
      authToken: batcherConfig.celestia.authToken,
      network: batcherConfig.celestia.network,
      fee: batcherConfig.celestia.fee,
      gasLimit: batcherConfig.celestia.gasLimit,
      gasPrice: batcherConfig.celestia.gasPrice,
      gas: batcherConfig.celestia.gas,
      maxGasPrice: batcherConfig.celestia.maxGasPrice,
      txPriority: batcherConfig.celestia.txPriority,
      syncProtocolName: "parallelCelestia",
    },
    batcherConfig.midnight.id,
    {
      cache,
      policy: sponsorship.policy,
      unpriced: sponsorship.unpriced,
      maxAgeMs: sponsorship.priceMaxAgeMs,
    },
  );
  cache?.start();
  console.log(`[zswap-da-batcher] ${adapter.describeSponsorship()}`);
  return adapter;
}
