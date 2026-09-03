/**
 * Capital-free DUST fee sizing (00006 FR-001).
 *
 * WHY THIS EXISTS. The DUST fee the solver pays covers the transaction the
 * RELAY submits, which is the merged {consumed maker offers + the solver's own
 * leg + the solver's DUST intent + the TAKER's half}. The taker's half never
 * reaches this process — the relay dispatches a purely numeric job and merges
 * the taker's transaction on its own side — so fee sizing has to model it.
 *
 * Until 00006 the model was a MIRROR: a real `initSwap` that selected the
 * taker's full `amountIn` of tokenIn out of the solver's OWN wallet and
 * reverted it immediately. That worked, but it made an uncapitalized solver
 * impossible (it must hold every token it quotes) and it put a mutate-then-
 * revert wallet call on the mandatory path of every job.
 *
 * WHAT REPLACES IT. The DUST fee is a function of the merged transaction's
 * STRUCTURE ONLY. Measured off the installed ledger WASM (`@midnight-ntwrk/
 * ledger-v8@8.1.0`) against the fee formula in
 * `@midnightntwrk/wallet-sdk-dust-wallet/dist/v1/Transacting.js:222-224`
 * (`tx.feesWithMargin(params, feeBlocksMargin) + additionalFeeOverhead`):
 *
 *   - element counts dominate: ~3.0e14 SPECKs per zswap input, ~3.4e14 per
 *     zswap output, on a ~8.6e12 base (raw; ×1.2519 at `feeBlocksMargin = 5`);
 *   - coin VALUES are irrelevant (1 and 2^64−1 price within ~1e11 SPECKs, i.e.
 *     ±1 serialized byte at ~5e10 SPECKs/byte);
 *   - token TYPES are irrelevant, and so are owners, keys and merkle positions;
 *   - proof erasure is fee-neutral, which matters because the balancer prices
 *     `tx.eraseProofs()`.
 *
 * So a FABRICATED transaction with the taker half's shape prices the same as a
 * real one. `buildTakerHalfStandIn` builds exactly that: an unproven zswap
 * transaction of a chosen shape over a throwaway keypair and a throwaway
 * `ZswapLocalState`, both created and discarded inside the call. No wallet is
 * touched, no real coin is selected or reserved, and the result is only ever
 * MEASURED — handed to `wallet.dust.balanceTransactions` as the taker-half
 * stand-in. It is never finalized, never journalled and never submitted, and
 * there is nothing to revert, so fee sizing stops being a wallet-mutation
 * class at all.
 *
 * THE ONE HONEST LIMIT. The real taker half's zswap input count `M` is decided
 * by the TAKER's coin selection, which is smallest-coin-first
 * (`@midnightntwrk/wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`),
 * so a taker whose tokenIn balance is fragmented across many small coins
 * produces a large `M`. Nothing on the wire tells the solver what `M` is. The
 * modelled count is therefore an explicit parameter, and the measured coverage
 * rule is:
 *
 *     a stand-in modelling `n` inputs funds a real taker half of up to
 *     `n + 2` zswap inputs
 *
 * (the `n + 2` headroom is the `feeBlocksMargin = 5` multiplier plus the flat
 * `additionalFeeOverhead`; each extra modelled input costs ~12–14% more DUST,
 * and it is DUST actually SPENT, not merely reserved). Underfunding is an
 * availability failure, not a loss: the chain rejects the merged transaction,
 * the relay reports `submit-failed`, and the executor's existing revert path
 * reclaims the solver's contribution. This is not a new risk — before 00006
 * the modelled count was whatever the SOLVER's own coin selection happened to
 * produce, equally uncorrelated with `M`, just invisible.
 */
import {
  createShieldedCoinInfo,
  Transaction,
  ZswapLocalState,
  ZswapOffer,
  ZswapOutput,
  ZswapSecretKeys,
  type QualifiedShieldedCoinInfo,
  type UnprovenOffer,
  type UnprovenTransaction,
} from "@midnightntwrk/ledger-v9";
import { randomBytes } from "node:crypto";

/**
 * The value every fabricated coin carries.
 *
 * Deliberately a fixed placeholder rather than the job's real amounts:
 *
 * 1. the fee is value-independent (see the module header), so a real amount
 *    buys no accuracy;
 * 2. `createShieldedCoinInfo` throws `Couldn't deserialize u128 from a BigInt
 *    outside u128::MIN..u128::MAX bounds` above `u128::MAX`, while the job
 *    grammar admits amounts up to `u256` — feeding job amounts straight in
 *    would turn a large but legal job into a wallet-build failure;
 * 3. a fixed value makes the estimate deterministic, which is what the
 *    characterisation test asserts against.
 *
 * `1n` and not `0n`: a zero encodes shorter and prices ~2.75e12 SPECKs lower.
 */
export const FEE_SIZING_PLACEHOLDER_AMOUNT = 1n;

/** Behaviour-preserving default: the shape the old mirror produced in practice
 * (00005 E1 observed 1 input + 1 change + 1 receive in all four deployed
 * cases, byte-identical 15 480-byte taker halves). */
export const DEFAULT_MODELLED_TAKER_INPUTS = 1;

/** Operator floor. Zero modelled inputs under-approximates the real charge by
 * 16–49% (measured), which is an underfunded settlement. */
export const MIN_MODELLED_TAKER_INPUTS = 1;

/**
 * Operator ceiling. Not a protocol limit — a sanity bound. Each modelled input
 * adds ~3.0e14 SPECKs of DUST actually spent and ~10 ms to the per-job build,
 * so a value this large already reserves ~20× the default and is far more
 * likely to be a typo than an intention.
 */
export const MAX_MODELLED_TAKER_INPUTS = 64;

/** How many real taker zswap inputs a stand-in modelling `n` inputs funds.
 * Measured; see the module header. */
export const takerInputCoverage = (modelledTakerInputs: number): number =>
  modelledTakerInputs + 2;

export interface FeeSizingStandInSpec {
  /** The SAME network id the wallet was built with. The ledger accepts any
   * string here (measured: `Transaction.fromParts` does not validate it), and
   * a mismatch surfaces only later, as `invalid network ID - expect 'x' found
   * 'y'` when the balancer merges the stand-in with the solver's own half. It
   * is therefore threaded from one source and asserted at startup. */
  networkId: string;
  /** One entry per MODELLED zswap input. */
  inputs: ReadonlyArray<{ token: string; amount: bigint }>;
  /** One entry per MODELLED zswap output. */
  outputs: ReadonlyArray<{ token: string; amount: bigint }>;
}

const HEX64 = /^[0-9a-f]{64}$/;

const requireRawToken = (where: string, token: string): string => {
  if (!HEX64.test(token)) {
    throw new Error(`fee-sizing stand-in ${where} token must be 64 lowercase hex, got ${JSON.stringify(token)}`);
  }
  return token;
};

/**
 * An unproven zswap transaction with the given SHAPE and nothing else.
 *
 * Pure with respect to every durable boundary: it reads no wallet state,
 * writes none, selects no real coin and reserves nothing. The throwaway
 * secret keys are cleared before returning, so no fabricated key material
 * outlives the call.
 *
 * The result is a measurement input only. Callers must not finalize it,
 * journal it, submit it, or hand it to `revertTransaction` — the wallet never
 * owned these coins, so there is no mutation to undo.
 */
export function buildTakerHalfStandIn(spec: FeeSizingStandInSpec): UnprovenTransaction {
  if (spec.networkId.length === 0) {
    throw new Error("fee-sizing stand-in requires the wallet's network id");
  }
  if (spec.inputs.length + spec.outputs.length === 0) {
    throw new Error("fee-sizing stand-in shape must have at least one zswap element");
  }
  const keys = ZswapSecretKeys.fromSeed(randomBytes(32));
  try {
    // Segment 0 throughout: the taker half is guaranteed-segment only (its
    // `initSwap` carries no contract calls), so the stand-in must be too — a
    // fallible segment would price differently.
    let local = new ZswapLocalState();
    const qualified: QualifiedShieldedCoinInfo[] = [];
    for (const input of spec.inputs) {
      const coin = createShieldedCoinInfo(requireRawToken("input", input.token), input.amount);
      local = local.insertCoin(keys, coin);
      // `insertCoin` returns the state, not the qualified coin; the merkle
      // position it just assigned is only readable back off the state.
      const tracked = Array.from(local.coins).find((candidate) => candidate.nonce === coin.nonce);
      if (tracked === undefined) {
        throw new Error("fee-sizing stand-in coin was not tracked by its own throwaway local state");
      }
      qualified.push(tracked);
    }
    let offer: UnprovenOffer | undefined;
    for (const coin of qualified) {
      const [next, spent] = local.spend(keys, coin, 0);
      local = next;
      const single = ZswapOffer.fromInput(spent, coin.type, coin.value);
      offer = offer === undefined ? single : offer.merge(single);
    }
    for (const output of spec.outputs) {
      const token = requireRawToken("output", output.token);
      const coin = createShieldedCoinInfo(token, output.amount);
      const created = ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
      const single = ZswapOffer.fromOutput(created, token, output.amount);
      offer = offer === undefined ? single : offer.merge(single);
    }
    if (offer === undefined) {
      throw new Error("fee-sizing stand-in produced no zswap offer");
    }
    return Transaction.fromParts(spec.networkId, offer);
  } finally {
    // Fabricated key material has no reason to outlive the measurement. The
    // returned transaction is self-contained and its fee is unaffected
    // (measured: identical SPECKs with and without this call).
    try { keys.clear(); } catch { /* hygiene only, never a fee-sizing failure */ }
  }
}

export interface TakerHalfShapeOptions {
  networkId: string;
  /** The token the taker SPENDS (the job's `tokenIn`). */
  tokenIn: string;
  /** The token the taker RECEIVES (the job's `tokenOut`). */
  tokenOut: string;
  /** How many tokenIn zswap inputs to model. */
  modelledTakerInputs: number;
}

/**
 * The taker half's shape, as one place both the executor and its tests read.
 *
 * `modelledTakerInputs` tokenIn inputs + one tokenIn CHANGE output + one
 * tokenOut RECEIVE output. Sources for that shape:
 *
 *   - the taker half is always a single `initSwap`/`makeIntent` with one
 *     shielded input token, one shielded output and `payFees: false`;
 *   - `@midnightntwrk/wallet-sdk-shielded/dist/v1/Transacting.js:72-116`
 *     passes the desired inputs as TARGET imbalances against empty initial
 *     ones, so the receive output is never balanced away and a change output
 *     appears whenever the selected coins overshoot;
 *   - 00005 E1 observed exactly 1 input + change + receive on chain.
 *
 * The change output is modelled UNCONDITIONALLY. It is present whenever the
 * taker's coins overshoot — the common case — and modelling it when it is
 * absent over-approximates by one output rather than underfunding by one.
 */
export const takerHalfStandInSpec = (
  options: TakerHalfShapeOptions,
): FeeSizingStandInSpec => {
  const tokenIn = options.tokenIn.toLowerCase();
  const tokenOut = options.tokenOut.toLowerCase();
  if (
    !Number.isSafeInteger(options.modelledTakerInputs) ||
    options.modelledTakerInputs < MIN_MODELLED_TAKER_INPUTS ||
    options.modelledTakerInputs > MAX_MODELLED_TAKER_INPUTS
  ) {
    throw new RangeError(
      `modelledTakerInputs must be an integer in [${MIN_MODELLED_TAKER_INPUTS}, ` +
        `${MAX_MODELLED_TAKER_INPUTS}], got ${options.modelledTakerInputs}`,
    );
  }
  return {
    networkId: options.networkId,
    inputs: Array.from({ length: options.modelledTakerInputs }, () => ({
      token: tokenIn,
      amount: FEE_SIZING_PLACEHOLDER_AMOUNT,
    })),
    outputs: [
      { token: tokenIn, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
      { token: tokenOut, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
    ],
  };
};
