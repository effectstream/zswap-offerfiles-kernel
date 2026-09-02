import { expect, test } from "bun:test";

import type { OfferLeg } from "@zswap-da/validator";
import {
  evaluateSponsorship,
  sponsorDiscountFromBps,
  sponsorshipReason,
  type PriceRow,
} from "./sponsorship.ts";

const BTC = "b".repeat(64);
const ETH = "e".repeat(64);
const USDC = "c".repeat(64);
const TEST = "a".repeat(64);

const leg = (token: string, amount: string | number | bigint): OfferLeg => ({
  token,
  amount: String(amount),
  kind: "SHIELDED",
});

const priced = (entries: [string, string | number, PriceRow["source"]?][]) =>
  new Map<string, PriceRow>(
    entries.map(([color, price, source]) => [color, { price_usd: price, source: source ?? "feed" }]),
  );

const MARKET = priced([
  [BTC, "77387"],
  [ETH, "2393.28"],
  [USDC, "0.999818"],
]);

const D = sponsorDiscountFromBps(250);

// ── the threshold ──────────────────────────────────────────────────────────

test("bps convert to the fraction the rule uses", () => {
  expect(sponsorDiscountFromBps(250)).toBe(0.025);
  expect(sponsorDiscountFromBps(0)).toBe(0);
  expect(sponsorDiscountFromBps(9999)).toBe(0.9999);
  expect(() => sponsorDiscountFromBps(10_000)).toThrow(/\[0, 10000\)/);
  expect(() => sponsorDiscountFromBps(-1)).toThrow(/\[0, 10000\)/);
  expect(() => sponsorDiscountFromBps(NaN)).toThrow(/\[0, 10000\)/);
});

test("an offer exactly at the threshold is sponsored", () => {
  // 1000 BTC-units given; want exactly 97.5% of that value back in ETH.
  const giveUsd = 1000 * 77387;
  const wantUnits = (giveUsd * 0.975) / 2393.28;
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1000)], wants: [leg(ETH, wantUnits)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("sponsored");
  expect(v.implied_discount).toBeCloseTo(0.025, 12);
});

test("an offer a hair above the threshold is refused", () => {
  const giveUsd = 1000 * 77387;
  const wantUnits = (giveUsd * 0.9750001) / 2393.28;
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1000)], wants: [leg(ETH, wantUnits)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("not_sponsored");
  expect(v.implied_discount!).toBeLessThan(0.025);
});

test("an offer priced AT reference — 0% discount — is refused (SC-002)", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1000)], wants: [leg(ETH, (1000 * 77387) / 2393.28)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("not_sponsored");
  expect(v.implied_discount).toBeCloseTo(0, 12);
  expect(v.give_usd).toBeCloseTo(77_387_000, 6);
  expect(v.want_usd).toBeCloseTo(77_387_000, 6);
  expect(sponsorshipReason(v, D)).toMatch(/0\.0% below reference, sponsorship needs ≥ 2\.5% below/);
});

test("an offer far below reference is sponsored and reads as a big discount", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1000)], wants: [leg(ETH, (1000 * 77387 * 0.5) / 2393.28)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("sponsored");
  expect(v.implied_discount).toBeCloseTo(0.5, 12);
});

test("an offer ABOVE reference reports a negative discount and says so", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1000)], wants: [leg(ETH, (1000 * 77387 * 1.1) / 2393.28)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("not_sponsored");
  expect(v.implied_discount).toBeCloseTo(-0.1, 12);
  expect(sponsorshipReason(v, D)).toMatch(/10\.0% above reference/);
});

test("discount 0 sponsors exactly when want ≤ give", () => {
  const zero = sponsorDiscountFromBps(0);
  const atPar = evaluateSponsorship(
    { gives: [leg(BTC, 1)], wants: [leg(USDC, 77387 / 0.999818)] },
    MARKET,
    zero,
  );
  expect(atPar.verdict).toBe("sponsored");

  const above = evaluateSponsorship(
    { gives: [leg(BTC, 1)], wants: [leg(USDC, (77387 * 1.001) / 0.999818)] },
    MARKET,
    zero,
  );
  expect(above.verdict).toBe("not_sponsored");
});

test("the discount argument is validated, not silently coerced", () => {
  const legs = { gives: [leg(BTC, 1)], wants: [leg(ETH, 1)] };
  expect(() => evaluateSponsorship(legs, MARKET, 1)).toThrow(/\[0, 1\)/);
  expect(() => evaluateSponsorship(legs, MARKET, -0.1)).toThrow(/\[0, 1\)/);
  expect(() => evaluateSponsorship(legs, MARKET, NaN)).toThrow(/\[0, 1\)/);
});

// ── baskets ────────────────────────────────────────────────────────────────

test("a basket is decided on the USD sums of both sides", () => {
  // Give 1 BTC + 10 ETH; want USDC worth 97% of that.
  const giveUsd = 77387 + 10 * 2393.28;
  const v = evaluateSponsorship(
    {
      gives: [leg(BTC, 1), leg(ETH, 10)],
      wants: [leg(USDC, (giveUsd * 0.97) / 0.999818)],
    },
    MARKET,
    D,
  );
  expect(v.give_usd).toBeCloseTo(giveUsd, 6);
  expect(v.verdict).toBe("sponsored");

  const tooDear = evaluateSponsorship(
    {
      gives: [leg(BTC, 1), leg(ETH, 10)],
      wants: [leg(USDC, (giveUsd * 0.99) / 0.999818)],
    },
    MARKET,
    D,
  );
  expect(tooDear.verdict).toBe("not_sponsored");
});

test("the same colour on both sides of a basket is summed, not cancelled", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 1), leg(BTC, 1)], wants: [leg(ETH, 1)] },
    MARKET,
    D,
  );
  expect(v.give_usd).toBeCloseTo(2 * 77387, 6);
});

// ── unpriced ───────────────────────────────────────────────────────────────

test("a leg with no price row makes the whole verdict unpriced (SC-003)", () => {
  const v = evaluateSponsorship(
    { gives: [leg(TEST, 1000)], wants: [leg(ETH, 1)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("unpriced");
  expect(v.unpriced).toEqual([TEST]);
  expect(v.implied_discount).toBeNull();
  expect(sponsorshipReason(v, D)).toBe(`no market price for ${TEST}`);
});

test("a `fallback` row is NOT a market price", () => {
  const withDemo = priced([[BTC, "77387"], [TEST, "13.02", "fallback"]]);
  const v = evaluateSponsorship(
    { gives: [leg(TEST, 1000)], wants: [leg(BTC, 1)] },
    withDemo,
    D,
  );
  expect(v.verdict).toBe("unpriced");
  expect(v.unpriced).toEqual([TEST]);
});

test("seed and manual rows ARE market prices", () => {
  for (const source of ["seed", "manual"] as const) {
    const prices = priced([[BTC, "100", source], [ETH, "1", source]]);
    const v = evaluateSponsorship(
      { gives: [leg(BTC, 1)], wants: [leg(ETH, 90)] },
      prices,
      D,
    );
    expect(v.verdict).toBe("sponsored");
  }
});

test("unpriced colours are deduped and listed once, in order", () => {
  const other = "d".repeat(64);
  const v = evaluateSponsorship(
    {
      gives: [leg(TEST, 1), leg(other, 1), leg(TEST, 2)],
      wants: [leg(other, 1), leg(ETH, 1)],
    },
    MARKET,
    D,
  );
  expect(v.unpriced).toEqual([TEST, other]);
});

test("colour matching is case-insensitive", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC.toUpperCase(), 1)], wants: [leg(ETH.toUpperCase(), 1)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("sponsored");
  expect(v.give_usd).toBeCloseTo(77387, 6);
});

// ── degenerate inputs ──────────────────────────────────────────────────────

test("a zero give value is not sponsored and produces no NaN", () => {
  const v = evaluateSponsorship(
    { gives: [leg(BTC, 0)], wants: [leg(ETH, 1)] },
    MARKET,
    D,
  );
  expect(v.verdict).toBe("not_sponsored");
  expect(v.give_usd).toBe(0);
  expect(v.implied_discount).toBeNull();
  expect(Number.isNaN(v.want_usd)).toBe(false);
  expect(sponsorshipReason(v, D)).toMatch(/gives no priced value/);
});

test("an empty give side is not sponsored; an empty want side is", () => {
  expect(evaluateSponsorship({ gives: [], wants: [leg(ETH, 1)] }, MARKET, D).verdict).toBe(
    "not_sponsored",
  );
  expect(evaluateSponsorship({ gives: [leg(BTC, 1)], wants: [] }, MARKET, D).verdict).toBe(
    "sponsored",
  );
});
