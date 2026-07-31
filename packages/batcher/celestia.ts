import {
  CelestiaAdapter,
  type CelestiaAdapterConfig,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";
import { DedupStore, offerHashFromBlob } from "@zswap-da/offer-guard";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import type { BatcherConfig } from "./config.ts";

// DoS guard on the decoded offer size; mirrors the node's OFFER_MAX_BYTES. The
// base adapter separately caps the on-wire blob at 1.5 MB.
const OFFER_MAX_BYTES = parseInt(
  process.env["OFFER_MAX_BYTES"] ?? String(1024 * 1024),
  10,
);

type ValidationResult = { valid: boolean; error?: string };

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

  constructor(config: CelestiaAdapterConfig, networkId: string) {
    super(config);
    this.networkId = networkId;
  }

  override validateInput(input: DefaultBatcherInput): ValidationResult {
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
    // fee for "good trades". Currently a no-op stub (always sponsors); see
    // checkForCelestiaSponsorship.
    const sponsorship = this.checkForCelestiaSponsorship(input);
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
    try {
      const rawBytes = OfferFiles.decode(built.rawData);
      // Base64 of the raw bytes becomes blob.data (Celestia stores these
      // bytes; the read side recovers them via atob → latin1 → Uint8Array).
      built.data.blob.data = Buffer.from(rawBytes).toString("base64");
    } catch {
      // Non-decodable input never reaches here (validateInput rejected it),
      // but fail safe: leave the base adapter's payload untouched.
    }
    return built;
  }

  override async submitBatch(data: any, fee: string | bigint): Promise<any> {
    const txhash = await super.submitBatch(data, fee);
    // Record AFTER the publish succeeded — this is the moment the fee is
    // irrevocably spent, so it is the moment a repeat becomes "paying twice".
    try {
      this.published.add(offerHashFromBlob(data.rawData));
    } catch {
      /* non-offer payload — nothing to record */
    }
    return txhash;
  }

  // Stub seam for the Celestia fee-sponsorship policy. A real implementation
  // would decode the offer, derive its gives/wants imbalance into an implied
  // rate, compare against a market reference, and require the poster to be at
  // least SPONSOR_DISCOUNT (2.5%) below market — mirroring the node's
  // market-mock policy behind /api/quote. Until that lands, every structurally
  // valid offer is sponsored.
  private checkForCelestiaSponsorship(_input: DefaultBatcherInput): ValidationResult {
    return { valid: true };
  }
}

export function createCelestiaAdapter(
  batcherConfig: BatcherConfig,
): CelestiaAdapter {
  return new ZswapCelestiaAdapter(
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
  );
}
