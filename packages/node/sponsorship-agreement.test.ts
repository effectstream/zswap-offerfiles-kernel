import { expect, test } from "bun:test";

import type { OfferLeg } from "@zswap-da/validator";
import { evaluateSponsorship, sponsorDiscountFromBps, type PriceRow } from "@zswap-da/offer-guard";

import { quoteWithPrices } from "./market-mock.ts";

// The one mechanical proof that GET /v1/quote's `sponsored` flag and the
// shared gate in @zswap-da/offer-guard are the SAME rule.
//
// They are written differently on purpose: the quote answers "is this rate far
// enough below market?" in exact bigint arithmetic over one pair, while the
// gate answers "is the USD the maker wants far enough below the USD they
// give?" in doubles over a whole basket. sponsorship.ts carries the algebra
// showing the two collapse to one inequality for a single-leg pair; this test
// is what stops that paragraph from quietly becoming false.
//
// It lives in packages/node because node depends on offer-guard and owns
// quoteWithPrices — offer-guard must not reach back into the node.

const BTC = "b".repeat(64);
const ETH = "e".repeat(64);

const leg = (token: string, amount: string): OfferLeg => ({ token, amount, kind: "SHIELDED" });

const priced = (entries: [string, number][]) =>
  new Map<string, PriceRow>(
    entries.map(([color, price]) => [color, { price_usd: price, source: "feed" }]),
  );

// ── the property that keeps the quote and the gate in step ─────────────────

test("random single-leg pairs agree with quoteWithPrices().sponsored", () => {
  // Deterministic PRNG: a failure must be reproducible, and this test is the
  // only mechanical proof that the doc comment's algebra holds.
  let seed = 0x5eed_1234;
  const rnd = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return seed / 4294967296;
  };

  let sponsoredSeen = 0;
  let refusedSeen = 0;
  for (let i = 0; i < 2000; i++) {
    const bps = [0, 25, 250, 500, 1000][Math.floor(rnd() * 5)]!;
    const discount = sponsorDiscountFromBps(bps);
    // Prices spanning five orders of magnitude, amounts up to 10^6 units.
    const pf = Number((0.01 + rnd() * 1000).toPrecision(8));
    const pt = Number((0.01 + rnd() * 1000).toPrecision(8));
    const fromAmount = BigInt(1 + Math.floor(rnd() * 1_000_000));

    const q0 = quoteWithPrices(BTC, ETH, fromAmount, pf, pt, undefined, bps);
    // Probe the auto-suggested amount (which lands exactly on the threshold)
    // and neighbours either side of it, so boundary behaviour is exercised
    // rather than only comfortably-inside cases.
    const suggested = BigInt(q0.suggested_to_amount);
    const offsets = [-1n, 0n, 1n, suggested / 10n === 0n ? 2n : suggested / 10n];
    const toAmount = suggested + offsets[Math.floor(rnd() * offsets.length)]!;
    if (toAmount < 0n) continue;

    const quoted = quoteWithPrices(BTC, ETH, fromAmount, pf, pt, toAmount, bps);
    const gate = evaluateSponsorship(
      {
        gives: [leg(BTC, fromAmount.toString())],
        wants: [leg(ETH, toAmount.toString())],
      },
      priced([[BTC, pf], [ETH, pt]]),
      discount,
    );

    const gateSponsored = gate.verdict === "sponsored";
    if (gateSponsored !== quoted.sponsored) {
      throw new Error(
        `disagreement at i=${i}: quote=${quoted.sponsored} gate=${gateSponsored} ` +
          `bps=${bps} pf=${pf} pt=${pt} from=${fromAmount} to=${toAmount} ` +
          `give_usd=${gate.give_usd} want_usd=${gate.want_usd}`,
      );
    }
    if (gateSponsored) sponsoredSeen++;
    else refusedSeen++;

    // The quote's own discount field is the same number, from the other side.
    if (quoted.discount !== null && gate.implied_discount !== null) {
      expect(gate.implied_discount).toBeCloseTo(quoted.discount, 8);
    }
  }
  // A test that only ever saw one verdict would prove nothing.
  expect(sponsoredSeen).toBeGreaterThan(200);
  expect(refusedSeen).toBeGreaterThan(200);
});
