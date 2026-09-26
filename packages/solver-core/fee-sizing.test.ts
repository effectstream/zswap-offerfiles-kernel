// Capital-free fee sizing (00006 FR-001/FR-002, SC-001/SC-003).
//
// These run against the REAL ledger WASM — the whole design rests on measured
// ledger behaviour, so the tests measure it too rather than mocking it. Every
// assertion here is either an exact structural fact or an explicitly BOUNDED
// numeric one: `ZswapOutput.new` samples its own ciphertext randomness, so two
// stand-ins of the same shape differ by a few serialized bytes and therefore by
// ~1e11 SPECKs. Exact fee equality is not available and is not asserted.
import { expect, test } from "bun:test";
import { LedgerParameters, Transaction } from "@midnightntwrk/ledger-v9";

import {
  buildTakerHalfStandIn,
  DEFAULT_MODELLED_TAKER_INPUTS,
  FEE_SIZING_PLACEHOLDER_AMOUNT,
  MAX_MODELLED_TAKER_INPUTS,
  MIN_MODELLED_TAKER_INPUTS,
  takerHalfStandInSpec,
  takerInputCoverage,
} from "./fee-sizing.ts";

const NETWORK = "undeployed";
const TOKEN_IN = "0".repeat(64);
const TOKEN_OUT = "1".repeat(64);
const THIRD = "2".repeat(64);

const params = LedgerParameters.initialParameters();
/** The repo's DUST cost parameters, from
 *  `@effectstream/midnight-contracts/src/constants.ts` — the same numbers
 *  `wallet-sdk-dust-wallet`'s `calculateFee` is handed at runtime. */
const FEE_BLOCKS_MARGIN = 5;
const ADDITIONAL_FEE_OVERHEAD = 300_000_000_000_000n;

/**
 * The measured jitter bound.
 *
 * Two stand-ins of the same shape differ only in serialized length (±7 bytes at
 * ~5e10 SPECKs/byte, measured spread ≤ 1.88e11 over 200 samples). 1e12 is ~5×
 * that and ~300× below the ~3.0e14 cost of one zswap element, so a shape change
 * or a ledger cost-model change still fails loudly while nothing flakes.
 */
const JITTER_TOLERANCE = 1_000_000_000_000n;

const shape = (modelledTakerInputs: number) =>
  takerHalfStandInSpec({
    networkId: NETWORK,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    modelledTakerInputs,
  });

const marginFee = (transaction: { feesWithMargin: (p: typeof params, m: number) => bigint }): bigint =>
  transaction.feesWithMargin(params, FEE_BLOCKS_MARGIN);

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

test("FR-001 the stand-in has exactly the modelled shape, in the guaranteed segment only", () => {
  for (const n of [1, 2, 3]) {
    const transaction = buildTakerHalfStandIn(shape(n));
    const guaranteed = transaction.guaranteedOffer;
    expect(guaranteed).toBeDefined();
    // n tokenIn inputs; one tokenIn change output + one tokenOut receive output.
    expect(guaranteed!.inputs).toHaveLength(n);
    expect(guaranteed!.outputs).toHaveLength(2);
    expect(guaranteed!.transients).toHaveLength(0);
    // The taker half carries no contract calls, so nothing may land in the
    // fallible segment — a fallible element would price differently.
    expect(transaction.fallibleOffer).toBeUndefined();
    expect([...transaction.intents?.keys() ?? []]).toEqual([]);
    // The shape's token deltas are the honest statement of what it models:
    // n spent tokenIn minus 1 kept as change, and 1 tokenOut created.
    expect([...guaranteed!.deltas.entries()].sort()).toEqual(
      n === 1
        ? [[TOKEN_OUT, -1n]]
        : [[TOKEN_IN, BigInt(n) - 1n], [TOKEN_OUT, -1n]],
    );
  }
});

test("FR-001 the shape's outputs never scale with the modelled input count", () => {
  for (const n of [1, 4, MAX_MODELLED_TAKER_INPUTS]) {
    const spec = shape(n);
    expect(spec.inputs).toHaveLength(n);
    expect(spec.inputs.every((entry) =>
      entry.token === TOKEN_IN && entry.amount === FEE_SIZING_PLACEHOLDER_AMOUNT)).toBe(true);
    expect(spec.outputs).toEqual([
      { token: TOKEN_IN, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
      { token: TOKEN_OUT, amount: FEE_SIZING_PLACEHOLDER_AMOUNT },
    ]);
  }
});

test("FR-001 the fee does not depend on WHOSE keys built the stand-in, within the jitter bound", () => {
  // The whole point of a fabricated stand-in: the estimate is a function of
  // shape, not of the fabricated coins or their throwaway owner. Ten
  // independent keypairs, one shape.
  const fees = Array.from({ length: 10 }, () => marginFee(buildTakerHalfStandIn(shape(1))));
  const min = fees.reduce((a, b) => (a < b ? a : b));
  const max = fees.reduce((a, b) => (a > b ? a : b));
  expect(max - min).toBeLessThanOrEqual(JITTER_TOLERANCE);
  // …and NOT exact determinism: this is documented, not accidental. If the
  // ledger ever became deterministic here the bound above still holds.
  expect(min).toBeGreaterThan(0n);
});

test("FR-002 the fee ignores coin values and token types", () => {
  const baseline = marginFee(buildTakerHalfStandIn(shape(1)));

  // Values: the placeholder, a job-scale amount, and u64::MAX.
  for (const amount of [1n, 1_000_000n, (1n << 64n) - 1n]) {
    const valued = marginFee(buildTakerHalfStandIn({
      networkId: NETWORK,
      inputs: [{ token: TOKEN_IN, amount }],
      outputs: [{ token: TOKEN_IN, amount }, { token: TOKEN_OUT, amount }],
    }));
    expect(abs(valued - baseline)).toBeLessThanOrEqual(JITTER_TOLERANCE);
  }

  // Token types: a completely different pair prices the same.
  const otherPair = marginFee(buildTakerHalfStandIn(takerHalfStandInSpec({
    networkId: NETWORK, tokenIn: THIRD, tokenOut: TOKEN_OUT, modelledTakerInputs: 1,
  })));
  expect(abs(otherPair - baseline)).toBeLessThanOrEqual(JITTER_TOLERANCE);
});

// US1 acceptance 2 — the characterisation of the OLD mirror-based estimate.
//
// The mirror was a real `initSwap` of the taker's amountIn producing, in every
// deployed 00005 E1 case, 1 zswap input + 1 change output + 1 receive output.
// The stand-in models that same shape, and because the fee is structural the two
// price identically up to serialization jitter. That is what makes 00006-R1 a
// refactor of the fee number rather than a change to it. These constants were
// measured off ledger-v8 8.1.0 with `LedgerParameters.initialParameters()`; they
// are pinned so a ledger cost-model change is a loud test failure and not a
// silently different DUST bill.
const PINNED_FEES_WITH_MARGIN_5: Record<number, bigint> = {
  1: 1_240_985_184_479_904n,
  2: 1_621_939_882_292_979n,
  3: 1_999_013_802_073_060n,
};

test("FR-002 the stand-in prices at the pinned mirror-equivalent fee for each modelled shape", () => {
  for (const [modelled, pinned] of Object.entries(PINNED_FEES_WITH_MARGIN_5)) {
    const measured = marginFee(buildTakerHalfStandIn(shape(Number(modelled))));
    expect(abs(measured - pinned)).toBeLessThanOrEqual(JITTER_TOLERANCE);
  }
  // The default is the shape 00005's deployed run actually observed, so the
  // reserved DUST at this head equals the mirror's for the proven case.
  expect(DEFAULT_MODELLED_TAKER_INPUTS).toBe(1);
  expect(abs(marginFee(buildTakerHalfStandIn(shape(DEFAULT_MODELLED_TAKER_INPUTS))) -
    PINNED_FEES_WITH_MARGIN_5[1]!)).toBeLessThanOrEqual(JITTER_TOLERANCE);
});

/**
 * The two sides of the safety claim, over the transaction that actually gets
 * priced — the MERGED one, not the stand-in alone. That distinction matters:
 * the `feeBlocksMargin = 5` multiplier is applied to the whole merged fee, so
 * the absolute cushion grows with the base, and the coverage rule is a property
 * of the merged shape.
 *
 *   reserved(n) = feesWithMargin(base ⊕ standIn(n), 5) + additionalFeeOverhead
 *   charged(m)  = fees(mockProve(base ⊕ takerHalf(m)))
 *
 * `base` stands in for the consumed maker offer plus the solver's own leg.
 */
const feeBase = () => {
  const makerOffer = buildTakerHalfStandIn({
    networkId: NETWORK,
    inputs: [{ token: TOKEN_OUT, amount: 10_000_000n }],
    outputs: [{ token: TOKEN_IN, amount: 10_000_000n }],
  });
  const solverLeg = buildTakerHalfStandIn({
    networkId: NETWORK,
    inputs: [],
    outputs: [{ token: TOKEN_OUT, amount: 1_000_000n }],
  });
  return { makerOffer, solverLeg };
};

const mergeErased = (parts: ReadonlyArray<ReturnType<typeof buildTakerHalfStandIn>>) =>
  parts.slice(1).reduce<any>((left, right) => left.merge(right.eraseProofs()),
    parts[0]!.eraseProofs());

/** Merge WITHOUT erasing proofs, so `mockProve` still accepts the result. */
const mergeUnproven = (parts: ReadonlyArray<ReturnType<typeof buildTakerHalfStandIn>>) =>
  parts.slice(1).reduce<any>((left, right) => left.merge(right), parts[0]!);

test("FR-002 the n + 2 coverage bound is executable, not prose", () => {
  const { makerOffer, solverLeg } = feeBase();
  const reserved = (modelled: number): bigint =>
    mergeErased([makerOffer, solverLeg, buildTakerHalfStandIn(shape(modelled))])
      .feesWithMargin(params, FEE_BLOCKS_MARGIN) + ADDITIONAL_FEE_OVERHEAD;
  // The real taker half has the same SHAPE as a stand-in modelling that many
  // inputs — that is exactly why the stand-in works — so it is built the same
  // way, then mock-proven because the chain prices a proof-bearing transaction.
  const charged = (realInputs: number): bigint =>
    mergeUnproven([makerOffer, solverLeg, buildTakerHalfStandIn(shape(realInputs))])
      .mockProve().fees(params);

  for (const modelled of [1, 2]) {
    const covered = takerInputCoverage(modelled);
    expect(covered).toBe(modelled + 2);
    // Covered: the reservation is enough for a taker half of `n + 2` inputs.
    expect(reserved(modelled)).toBeGreaterThanOrEqual(charged(covered));
    // And the bound is TIGHT — one input past it underfunds — so `n + 2` is the
    // real number and not an under-claim hiding slack.
    expect(reserved(modelled)).toBeLessThan(charged(covered + 1));
  }
});

// US1 acceptance 2, the direct form: the number that reaches `reserveDust`.
//
// `estimateDustAmount` reads the DUST amount off the transaction
// `dust.balanceTransactions` returns, and the balancer's only fee input is the
// MERGED transaction. So the decision-relevant comparison is not "stand-in
// alone versus mirror alone" — it is the reserved amount over
// `base ⊕ half`, with the mirror's half replaced by the stand-in.
//
// Measured here: delta EXACTLY 0 at n = 1, 2, 3. (Standalone, the two halves can
// differ by a few thousand SPECK-billions — up to ~4.0e12 at n = 1 — because the
// mirror's three coins carry three different real values and therefore serialize
// to a slightly different length. That difference does not survive the merge,
// which is the only place the fee is ever taken.)
test("FR-002 the stand-in reserves exactly what the old mirror's shape reserved", () => {
  const { makerOffer, solverLeg } = feeBase();
  const reserved = (half: ReturnType<typeof buildTakerHalfStandIn>): bigint =>
    mergeErased([makerOffer, solverLeg, half])
      .feesWithMargin(params, FEE_BLOCKS_MARGIN) + ADDITIONAL_FEE_OVERHEAD;

  /** The pre-00006 mirror: same element counts, REAL job-scale coin values,
   *  because it was built by `initSwap` out of the solver's own coins. */
  const mirrorHalf = (modelledInputs: number, amountIn: bigint, amountOut: bigint) =>
    buildTakerHalfStandIn({
      networkId: NETWORK,
      inputs: Array.from({ length: modelledInputs }, () => ({ token: TOKEN_IN, amount: amountIn })),
      outputs: [
        { token: TOKEN_IN, amount: amountIn / 2n },
        { token: TOKEN_OUT, amount: amountOut },
      ],
    });

  for (const n of [1, 2, 3]) {
    const withStandIn = reserved(buildTakerHalfStandIn(shape(n)));
    const withMirror = reserved(mirrorHalf(n, 1_000_000n, 2_000_000n));
    expect(abs(withStandIn - withMirror)).toBeLessThanOrEqual(JITTER_TOLERANCE);
  }

  // And the absolute reservations, pinned: these are the SPECK amounts the
  // deployed solver will hold and spend per settlement at each setting.
  expect(abs(reserved(buildTakerHalfStandIn(shape(1))) - 2_779_466_641_196_585n))
    .toBeLessThanOrEqual(JITTER_TOLERANCE);
  expect(abs(reserved(buildTakerHalfStandIn(shape(2))) - 3_156_603_154_170_746n))
    .toBeLessThanOrEqual(JITTER_TOLERANCE);
});

test("FR-002 each extra modelled input costs a bounded, documented amount of DUST", () => {
  // Q-R0-1's cost side: +12…14% of reserved (and actually SPENT) DUST per extra
  // modelled input. Asserted as a band so the question's numbers stay honest
  // without pinning serialization jitter.
  const { makerOffer, solverLeg } = feeBase();
  const reserved = (modelled: number): bigint =>
    mergeErased([makerOffer, solverLeg, buildTakerHalfStandIn(shape(modelled))])
      .feesWithMargin(params, FEE_BLOCKS_MARGIN) + ADDITIONAL_FEE_OVERHEAD;
  for (const n of [1, 2]) {
    const increasePercent = Number((reserved(n + 1) - reserved(n)) * 1_000n / reserved(n)) / 10;
    expect(increasePercent).toBeGreaterThan(10);
    expect(increasePercent).toBeLessThan(16);
  }
});

test("FR-001 the stand-in survives serialization and merges with a proof-erased half", () => {
  // Both are things the DUST balancer does to it: `dryRunFee` erases proofs and
  // merges, and the facade serializes transactions across its boundaries.
  const standIn = buildTakerHalfStandIn(shape(1));
  const bytes = standIn.serialize();
  const restored = Transaction.deserialize("signature", "pre-proof", "pre-binding", bytes);
  expect(restored.fees(params)).toBe(standIn.fees(params));

  const otherHalf = buildTakerHalfStandIn({
    networkId: NETWORK,
    inputs: [{ token: TOKEN_OUT, amount: 10n }],
    outputs: [{ token: TOKEN_IN, amount: 10n }],
  });
  const merged = otherHalf.mockProve().bind().eraseProofs().merge(standIn.eraseProofs());
  expect(merged.fees(params)).toBeGreaterThan(standIn.fees(params));
});

test("FR-001 two stand-ins merge even with identically fabricated shapes", () => {
  // A fabricated nullifier could in principle collide with another fabricated
  // one. Measured: it is not a merge hazard. Random nonces are kept anyway, so
  // nothing about the stand-in is a fixed forever-reused value.
  const left = buildTakerHalfStandIn(shape(1)).eraseProofs();
  const right = buildTakerHalfStandIn(shape(1)).eraseProofs();
  expect(() => left.merge(right)).not.toThrow();
});

test("FR-001 the network id is carried, required, and only checked by the ledger at merge", () => {
  expect(() => buildTakerHalfStandIn({ ...shape(1), networkId: "" }))
    .toThrow(/network id/);
  // The honest statement of why the executor asserts this at startup: the ledger
  // ACCEPTS any string here and refuses only later, on merge.
  const undeployed = buildTakerHalfStandIn(shape(1));
  const testnet = buildTakerHalfStandIn({ ...shape(1), networkId: "testnet" });
  expect(() => undeployed.eraseProofs().merge(testnet.eraseProofs()))
    .toThrow(/network ID/i);
});

test("FR-001 malformed shapes are refused rather than silently mispriced", () => {
  expect(() => buildTakerHalfStandIn({ networkId: NETWORK, inputs: [], outputs: [] }))
    .toThrow(/at least one zswap element/);
  for (const token of ["", "zz".repeat(32), "ab".repeat(32).toUpperCase(), TOKEN_IN.slice(1)]) {
    expect(() => buildTakerHalfStandIn({
      networkId: NETWORK, inputs: [{ token, amount: 1n }], outputs: [],
    })).toThrow(/64 lowercase hex/);
  }
  for (const invalid of [0, -1, 1.5, Number.NaN, MAX_MODELLED_TAKER_INPUTS + 1]) {
    expect(() => shape(invalid)).toThrow(/modelledTakerInputs/);
  }
  expect(() => shape(MIN_MODELLED_TAKER_INPUTS)).not.toThrow();
  expect(() => shape(MAX_MODELLED_TAKER_INPUTS)).not.toThrow();
});

test("FR-001 the placeholder amount avoids the u128 ceiling a real job amount would hit", () => {
  // `requireCanonicalJob` admits amounts up to u256, but
  // `createShieldedCoinInfo` throws above u128::MAX. Feeding job amounts into
  // the stand-in would turn a large but legal job into a wallet-build failure —
  // this pins the ledger bound the placeholder exists to avoid.
  expect(FEE_SIZING_PLACEHOLDER_AMOUNT).toBe(1n);
  expect(() => buildTakerHalfStandIn({
    networkId: NETWORK,
    inputs: [{ token: TOKEN_IN, amount: 1n << 128n }],
    outputs: [],
  })).toThrow(/u128/);
  // …and the u256 job ceiling really is above it.
  expect((1n << 256n) - 1n).toBeGreaterThan(1n << 128n);
});
