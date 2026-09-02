import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { PriceRow } from "@zswap-da/offer-guard";

import { ZswapCelestiaAdapter, type SponsorshipGate } from "./celestia.ts";
import { PriceCache } from "./price-cache.ts";

// The fee gate, driven through the REAL adapter and the REAL proven offer
// fixture — not a synthetic leg list. Everything here therefore also proves
// the ordering: a blob only reaches the sponsorship branch after deserialize
// and full proof verification have passed.
//
// The fixture (packages/validator/fixtures/valid-offer.bech32):
//   gives 1_000_000 × 0000…0000   wants 5_000_000 × ffff…ffff
// Price NIGHT at 0.01918181/unit (the seeded reference) and give_usd is
// 19181.81; the wanted colour's price is then the only dial, and it moves the
// offer across the threshold with numbers that can be checked by hand.

const GIVE_COLOR = "0".repeat(64);
const WANT_COLOR = "f".repeat(64);
const NIGHT_PRICE = 0.01918181;
const GIVE_USD = 1_000_000 * NIGHT_PRICE; // 19181.81

const blob = readFileSync(
  new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
  "utf-8",
).trim();

/** Per-unit price for the wanted leg that puts want_usd at `fraction` × give_usd. */
const wantPriceFor = (fraction: number) => (GIVE_USD * fraction) / 5_000_000;

const inputFor = (b: string) => ({ address: "tester", addressType: 0, input: b, timestamp: "1" });

/**
 * A PriceCache holding a chosen snapshot, without any HTTP. `fetchedAt` is
 * `now`, so `isFresh` is true for any sane maxAge; the staleness cases below
 * move the clock instead.
 */
function cacheOf(
  tokens: Record<string, PriceRow>,
  { discount = 0.025, now = () => 1_000_000 } = {},
): PriceCache {
  const cache = new PriceCache({
    url: "http://node.test:9999",
    refreshMs: 600_000,
    fallbackDiscount: 0.025,
    now,
    log: () => {},
    logError: () => {},
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          sponsor_discount: discount,
          tokens: Object.entries(tokens).map(([token_color, row]) => ({
            token_color,
            price_usd: row.price_usd,
            source: row.source,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
  return cache;
}

interface Harness {
  adapter: ZswapCelestiaAdapter;
  warnings: string[];
  logs: string[];
}

function harness(gate: Partial<SponsorshipGate> & { cache: PriceCache | null }): Harness {
  const warnings: string[] = [];
  const logs: string[] = [];
  const adapter = new ZswapCelestiaAdapter(
    {
      rpcUrl: "http://127.0.0.1:1", // never contacted
      namespace: "000000000000deadbeef",
      authToken: "",
      network: "devnet",
      fee: 2000,
      gasLimit: 100000,
      syncProtocolName: "parallelCelestia",
    } as any,
    "undeployed",
    {
      policy: "enforce",
      unpriced: "allow",
      maxAgeMs: 172_800_000,
      now: () => 1_000_000,
      warn: (line) => warnings.push(line),
      log: (line) => logs.push(line),
      ...gate,
    },
  );
  return { adapter, warnings, logs };
}

/** Build a warmed cache + adapter for a wanted-leg price. */
async function gateAt(fraction: number, gate: Partial<SponsorshipGate> = {}) {
  const cache = cacheOf({
    [GIVE_COLOR]: { price_usd: String(NIGHT_PRICE), source: "seed" },
    [WANT_COLOR]: { price_usd: String(wantPriceFor(fraction)), source: "manual" },
  });
  await cache.refresh();
  return harness({ cache, ...gate });
}

describe("the fee gate — an offer at reference is no longer sponsored", () => {
  test("GREEN: priced EXACTLY at reference → NOT_SPONSORED (this is the RED probe's assertion, flipped)", async () => {
    const { adapter } = await gateAt(1.0);
    const verdict = await adapter.validateOffer(inputFor(blob) as any);

    expect(verdict.valid).toBe(false);
    expect(verdict.error).toStartWith("NOT_SPONSORED:");
    // The numbers are IN the message: an operator reading the batcher log must
    // be able to see why, without re-deriving anything.
    expect(verdict.error).toContain("wants 0.0% below reference");
    expect(verdict.error).toContain("needs ≥ 2.5%");
    expect(verdict.error).toContain("give_usd 19181.81");
    expect(verdict.error).toContain("want_usd 19181.81");
  });

  test("2.5% below reference → sponsored", async () => {
    const { adapter } = await gateAt(0.975);
    expect(await adapter.validateOffer(inputFor(blob) as any)).toEqual({ valid: true });
  });

  test("the exact threshold is INCLUSIVE — the quote's own suggested amount must pass", async () => {
    // The quote hands the maker an amount priced exactly at the threshold. If
    // the boundary were exclusive, the UI would promise sponsorship for an
    // offer the batcher then refuses — the one failure mode the shared rule
    // exists to prevent.
    const { adapter } = await gateAt(1 - 0.025);
    expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
  });

  test("a hair above the threshold is refused", async () => {
    const { adapter } = await gateAt(0.9751);
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("wants 2.5% below reference");
  });

  test("far above reference → refused, and the message says `above`", async () => {
    const { adapter } = await gateAt(1.1);
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("wants 10.0% above reference");
  });

  test("the node's discount is what applies, not the batcher's env fallback", async () => {
    // Node says 10%; an offer 5% below reference is therefore NOT enough, even
    // though the batcher's own bootstrap default (2.5%) would have allowed it.
    const cache = cacheOf(
      {
        [GIVE_COLOR]: { price_usd: String(NIGHT_PRICE), source: "seed" },
        [WANT_COLOR]: { price_usd: String(wantPriceFor(0.95)), source: "manual" },
      },
      { discount: 0.1 },
    );
    await cache.refresh();
    const { adapter } = harness({ cache });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("needs ≥ 10.0%");
  });
});

describe("policy — enforce | warn | off", () => {
  test("warn sponsors the same offer but logs the numbers, once per offer", async () => {
    const { adapter, warnings } = await gateAt(1.0, { policy: "warn" });
    expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("would refuse (policy=warn)");
    expect(warnings[0]).toContain("give_usd 19181.81");
  });

  test("off does not evaluate at all — no verdict, no log", async () => {
    const { adapter, warnings, logs } = await gateAt(1.0, { policy: "off" });
    expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
    expect(warnings).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  test("the same offer flips verdict on policy alone — nothing else changes", async () => {
    const enforce = await gateAt(1.0, { policy: "enforce" });
    const warn = await gateAt(1.0, { policy: "warn" });
    expect((await enforce.adapter.validateOffer(inputFor(blob) as any)).valid).toBe(false);
    expect((await warn.adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
  });
});

describe("unpriced tokens (SC-003 — the test site must keep working)", () => {
  const unpricedCache = async () => {
    // Only the give leg is priced. The wanted colour is absent entirely, which
    // is what every faucet-minted test token looks like.
    const cache = cacheOf({ [GIVE_COLOR]: { price_usd: String(NIGHT_PRICE), source: "seed" } });
    await cache.refresh();
    return cache;
  };

  test("allow (the default): sponsored, with an info log naming the colour", async () => {
    const { adapter, logs } = harness({ cache: await unpricedCache(), unpriced: "allow" });
    expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("sponsoring an unpriced offer");
    expect(logs[0]).toContain(WANT_COLOR);
  });

  test("reject: refused as UNPRICED_TOKEN, naming the colour", async () => {
    const { adapter } = harness({ cache: await unpricedCache(), unpriced: "reject" });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toStartWith("UNPRICED_TOKEN:");
    expect(verdict.error).toContain(WANT_COLOR);
  });

  test("a `fallback` (demo-hash) price counts as unpriced, not as a market price", async () => {
    // The whole point of carrying `source` through: a colour-hash demo price
    // is a number, but it is not a market, so it must not be used to refuse.
    const cache = cacheOf({
      [GIVE_COLOR]: { price_usd: String(NIGHT_PRICE), source: "seed" },
      [WANT_COLOR]: { price_usd: "13.02", source: "fallback" },
    });
    await cache.refresh();
    const { adapter } = harness({ cache, unpriced: "reject" });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toStartWith("UNPRICED_TOKEN:");
  });

  test("unpriced is decided BEFORE the threshold — a bad rate on unpriced tokens is not NOT_SPONSORED", async () => {
    const cache = cacheOf({
      [GIVE_COLOR]: { price_usd: String(NIGHT_PRICE), source: "seed" },
      [WANT_COLOR]: { price_usd: "999999", source: "fallback" },
    });
    await cache.refresh();
    const { adapter } = harness({ cache, unpriced: "allow" });
    expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
  });
});

describe("no usable snapshot", () => {
  const deadCache = (now: () => number) => {
    const cache = new PriceCache({
      url: "http://node.test:9999",
      refreshMs: 600_000,
      fallbackDiscount: 0.025,
      now,
      log: () => {},
      logError: () => {},
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    return cache;
  };

  test("enforce + node never answered → PRICE_UNAVAILABLE, no fee paid", async () => {
    const cache = deadCache(() => 1_000_000);
    await cache.refresh();
    const { adapter } = harness({ cache, policy: "enforce" });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toStartWith("PRICE_UNAVAILABLE:");
    expect(verdict.error).toContain("has never answered");
  });

  test("enforce + a snapshot older than maxAge → PRICE_UNAVAILABLE, with both ages", async () => {
    let t = 1_000_000;
    const cache = cacheOf(
      { [GIVE_COLOR]: { price_usd: "1", source: "seed" }, [WANT_COLOR]: { price_usd: "1", source: "seed" } },
      { now: () => t },
    );
    await cache.refresh();
    t += 100_000; // 100 s later, with a 60 s ceiling
    const { adapter } = harness({ cache, policy: "enforce", maxAgeMs: 60_000, now: () => t });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("is 100s old");
    expect(verdict.error).toContain("max 60s");
  });

  test("warn + no snapshot → sponsored, and the warning is throttled to once a minute", async () => {
    let t = 1_000_000;
    const cache = deadCache(() => t);
    await cache.refresh();
    const { adapter, warnings } = harness({ cache, policy: "warn", now: () => t });

    for (let i = 0; i < 3; i++) {
      expect((await adapter.validateOffer(inputFor(blob) as any)).valid).toBe(true);
    }
    // Three offers, ONE warning: the condition belongs to the batcher, not to
    // the offers, so repeating it per submission would bury everything else.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sponsoring WITHOUT a price check");

    t += 60_000;
    await adapter.validateOffer(inputFor(blob) as any);
    expect(warnings).toHaveLength(2);
  });

  test("a null cache is the same as an unreachable node", async () => {
    const { adapter } = harness({ cache: null, policy: "enforce" });
    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("no price source configured");
  });
});

describe("ordering — the gate never sees an unverified offer", () => {
  test("a forged/undecodable blob is refused by the validator, and the gate never logs it", async () => {
    const { adapter, warnings, logs } = await gateAt(1.0, { policy: "warn" });
    const verdict = await adapter.validateOffer(inputFor("definitely-not-an-offer") as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("BAD_ENCODING");
    // Nothing about trade values was logged: the legs were never trusted.
    expect(warnings).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  test("a duplicate is still caught before the gate", async () => {
    const { adapter, warnings } = await gateAt(1.0, { policy: "warn" });
    (adapter as any).rpcCall = async () => ({ txhash: "stub-tx", height: 7 });
    await adapter.submitBatch({ blob: { namespace: "ns", data: "x", share_version: 0 }, rawData: blob, inputKey: "k" } as any, 2000n);

    const verdict = await adapter.validateOffer(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("DUPLICATE_OFFER");
    expect(warnings).toHaveLength(0);
  });
});

describe("describeSponsorship — what an operator reads at startup", () => {
  test("names the policy, the node and the cache age", async () => {
    const { adapter } = await gateAt(1.0);
    expect(adapter.describeSponsorship()).toBe(
      "sponsorship: policy=enforce unpriced=allow max_age=172800s " +
        "prices=2 tokens age=0s discount=2.50% node=http://node.test:9999/v1/prices",
    );
  });

  test("says so plainly when the gate is off", async () => {
    const { adapter } = await gateAt(1.0, { policy: "off" });
    expect(adapter.describeSponsorship()).toContain("policy=off");
  });
});
