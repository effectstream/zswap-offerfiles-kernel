// Unit tests for want-leg sizing. No network: the `api` is a fake whose `get`
// records the path it was asked for and returns a canned kernel response.
//
// The fixtures are shaped exactly like `GET /v1/quote` at f92c7ca — amounts as
// canonical decimal STRINGS, rates and the discount as numbers, `prices_updated_at`
// nullable — so a schema drift on the kernel side shows up here as a failing
// test rather than as a poster that posts an unsponsorable offer.

import { describe, expect, test } from "bun:test";

import {
  NotSponsoredError,
  QuoteError,
  quoteSnapshot,
  sizeWant,
  type QuoteApi,
  type QuoteResponse,
} from "./poster-quote.ts";
import { KernelApi } from "./kernel-api.ts";

const GIVE = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912"; // preprod WBTC
const WANT = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5"; // preprod WETH

/** A quote as the kernel returns it: 1000 WBTC at the seeded prices
 *  (bitcoin 77387, ethereum 2393.28) with the default 250 bps discount →
 *  1000 × (77387/2393.28) × 0.975 = 31526 (floor). */
function quote(over: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    from_token: GIVE,
    to_token: WANT,
    from_amount: "1000",
    market_rate: 32.33512167402059,
    suggested_to_amount: "31526",
    to_amount: "31526",
    implied_rate: 31.526,
    discount: 0.02502299766110594,
    sponsored: true,
    from_usd: 77387000,
    to_usd: 75450545.28,
    source: "token-prices",
    sponsor_discount: 0.025,
    from_source: "seed",
    to_source: "seed",
    prices_updated_at: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

interface Fake extends QuoteApi {
  paths: string[];
}

function fakeApi(reply: { status?: number; body: unknown } | ((path: string) => { status?: number; body: unknown })): Fake {
  const paths: string[] = [];
  return {
    paths,
    async get<T>(path: string): Promise<{ status: number; body: T }> {
      paths.push(path);
      const r = typeof reply === "function" ? reply(path) : reply;
      return { status: r.status ?? 200, body: r.body as T };
    },
  };
}

describe("the api seam", () => {
  test("the real KernelApi satisfies QuoteApi (compile-time and at run time)", () => {
    // If `KernelApi.get` ever changes shape, this stops compiling here rather
    // than at the poster's first live tick.
    const api: QuoteApi = new KernelApi("http://kernel:9999");
    expect(typeof api.get).toBe("function");
  });
});

describe("sizeWant — the sponsored path", () => {
  test("uses suggested_to_amount and reports the quote's provenance", async () => {
    const api = fakeApi({ body: quote() });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });

    expect(sized.wantAmount).toBe(31526n);
    expect(sized.suggestedWantAmount).toBe(31526n);
    expect(sized.sponsored).toBe(true);
    expect(sized.forced).toBe(false);
    expect(sized.marketRate).toBeCloseTo(32.3351, 3);
    expect(sized.sponsorDiscount).toBe(0.025);
    expect(sized.fromSource).toBe("seed");
    expect(sized.toSource).toBe("seed");
    expect(sized.pricesUpdatedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(sized.warnings).toEqual([]);
    expect(sized.raw.to_amount).toBe("31526");
  });

  test("asks the exact query the kernel documents", async () => {
    const api = fakeApi({ body: quote() });
    await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(api.paths).toEqual([
      `/v1/quote?from_token=${GIVE}&to_token=${WANT}&from_amount=1000`,
    ]);
  });

  test("colours are normalised (0x prefix, upper case) before they hit the wire", async () => {
    const api = fakeApi({ body: quote() });
    await sizeWant(api, {
      giveColour: `0x${GIVE.toUpperCase()}`,
      wantColour: ` ${WANT} `,
      giveValue: 7n,
    });
    expect(api.paths[0]).toBe(`/v1/quote?from_token=${GIVE}&to_token=${WANT}&from_amount=7`);
  });

  test("a u256-scale give value survives as an exact decimal", async () => {
    const huge = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const api = fakeApi({ body: quote({ suggested_to_amount: "1", to_amount: "1" }) });
    await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: huge });
    expect(api.paths[0]).toContain(`from_amount=${huge.toString()}`);
  });

  test("the journal snapshot carries exactly the FR-005 fields", async () => {
    const api = fakeApi({ body: quote() });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(quoteSnapshot(sized)).toEqual({
      marketRate: 32.33512167402059,
      sponsorDiscount: 0.025,
      fromSource: "seed",
      toSource: "seed",
      pricesUpdatedAt: "2026-09-03T00:00:00.000Z",
      sponsored: true,
    });
  });
});

describe("sizeWant — unsponsored", () => {
  test("throws NotSponsoredError with the numbers needed to explain it", async () => {
    const api = fakeApi({
      body: quote({ sponsored: false, discount: 0.01, to_amount: "40000", suggested_to_amount: "40000" }),
    });
    let err: NotSponsoredError | undefined;
    try {
      await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    } catch (e) {
      err = e as NotSponsoredError;
    }
    expect(err).toBeInstanceOf(NotSponsoredError);
    expect(err!.wantAmount).toBe(40000n);
    expect(err!.giveValue).toBe(1000n);
    expect(err!.impliedDiscount).toBe(0.01);
    expect(err!.sponsorDiscount).toBe(0.025);
    expect(err!.giveUsd).toBe(77387000);
    expect(err!.wantUsd).toBe(75450545.28);
    expect(err!.fromSource).toBe("seed");
    expect(err!.raw.sponsored).toBe(false);
    expect(err!.message).toContain("not sponsored");
  });
});

describe("sizeWant — forced WANT_AMOUNT", () => {
  test("sends to_amount, returns the forced value and the kernel's verdict", async () => {
    const api = fakeApi({ body: quote({ to_amount: "31000", implied_rate: 31, discount: 0.041 }) });
    const sized = await sizeWant(api, {
      giveColour: GIVE,
      wantColour: WANT,
      giveValue: 1000n,
      forcedWantAmount: 31000n,
    });
    expect(api.paths[0]).toBe(
      `/v1/quote?from_token=${GIVE}&to_token=${WANT}&from_amount=1000&to_amount=31000`,
    );
    expect(sized.wantAmount).toBe(31000n);
    expect(sized.forced).toBe(true);
    expect(sized.sponsored).toBe(true);
    expect(sized.suggestedWantAmount).toBe(31526n); // still reported, for logs
    expect(sized.warnings).toEqual([]);
  });

  test("an unsponsored forced amount warns instead of throwing (US4: the caller decides)", async () => {
    const api = fakeApi({
      body: quote({ to_amount: "40000", sponsored: false, implied_rate: 40, discount: -0.237 }),
    });
    const sized = await sizeWant(api, {
      giveColour: GIVE,
      wantColour: WANT,
      giveValue: 1000n,
      forcedWantAmount: 40000n,
    });
    expect(sized.wantAmount).toBe(40000n);
    expect(sized.sponsored).toBe(false);
    expect(sized.warnings.join(" ")).toContain("NOT sponsored");
    expect(sized.warnings.join(" ")).toContain("40000");
  });

  test("a forced amount of 0 is still a forced amount (and is sent)", async () => {
    const api = fakeApi({ body: quote({ to_amount: "0", sponsored: true }) });
    const sized = await sizeWant(api, {
      giveColour: GIVE,
      wantColour: WANT,
      giveValue: 1000n,
      forcedWantAmount: 0n,
    });
    expect(api.paths[0]).toContain("&to_amount=0");
    expect(sized.wantAmount).toBe(0n);
  });

  test("warns when the kernel echoes a different to_amount", async () => {
    const api = fakeApi({ body: quote({ to_amount: "31526" }) }); // ignored the force
    const sized = await sizeWant(api, {
      giveColour: GIVE,
      wantColour: WANT,
      giveValue: 1000n,
      forcedWantAmount: 31000n,
    });
    expect(sized.wantAmount).toBe(31000n);
    expect(sized.warnings.join(" ")).toContain("echoed to_amount 31526");
  });
});

describe("sizeWant — demo and fallback prices", () => {
  test("an unregistered colour (demo-fallback) is surfaced as a warning, not a failure", async () => {
    const api = fakeApi({
      body: quote({
        source: "demo-fallback",
        from_source: "demo-fallback",
        to_source: "seed",
        prices_updated_at: null,
      }),
    });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(sized.warnings).toHaveLength(1);
    expect(sized.warnings[0]).toContain("give leg");
    expect(sized.warnings[0]).toContain("demo-fallback");
    expect(sized.pricesUpdatedAt).toBeNull();
    expect(sized.wantAmount).toBe(31526n); // still usable
  });

  test("a registered-but-unpriced colour (fallback) warns on the want leg", async () => {
    const api = fakeApi({ body: quote({ to_source: "fallback", prices_updated_at: null }) });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(sized.warnings).toHaveLength(1);
    expect(sized.warnings[0]).toContain("want leg");
    expect(sized.warnings[0]).toContain("fallback");
  });

  test("both legs demo → two warnings", async () => {
    const api = fakeApi({
      body: quote({ from_source: "demo-fallback", to_source: "demo-fallback", prices_updated_at: null }),
    });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(sized.warnings).toHaveLength(2);
  });

  test("a null prices_updated_at with real sources still warns", async () => {
    const api = fakeApi({ body: quote({ prices_updated_at: null }) });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(sized.warnings.join(" ")).toContain("prices_updated_at is null");
  });

  test("feed and manual sources are not warned about", async () => {
    const api = fakeApi({ body: quote({ from_source: "feed", to_source: "manual" }) });
    const sized = await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    expect(sized.warnings).toEqual([]);
  });
});

describe("sizeWant — failures", () => {
  test("a non-200 carries the kernel's status and body", async () => {
    const api = fakeApi({
      status: 400,
      body: { error: "VALIDATION", reason: "from_token and to_token must be distinct" },
    });
    let err: QuoteError | undefined;
    try {
      await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
    } catch (e) {
      err = e as QuoteError;
    }
    expect(err).toBeInstanceOf(QuoteError);
    expect(err!.code).toBe("HTTP");
    expect(err!.status).toBe(400);
    expect((err!.body as { error: string }).error).toBe("VALIDATION");
  });

  test("a 200 that is not a quote is MALFORMED, not a silent zero", async () => {
    for (const body of [
      "plain text the kernel sometimes answers with",
      null,
      [],
      { ...quote(), suggested_to_amount: 31526 }, // number, not string
      { ...quote(), suggested_to_amount: "0x7b" },
      { ...quote(), to_amount: undefined },
      { ...quote(), sponsored: "true" },
      { ...quote(), market_rate: "32.3" },
      { ...quote(), sponsor_discount: null },
    ]) {
      const api = fakeApi({ body });
      let err: QuoteError | undefined;
      try {
        await sizeWant(api, { giveColour: GIVE, wantColour: WANT, giveValue: 1000n });
      } catch (e) {
        err = e as QuoteError;
      }
      expect(err?.code).toBe("MALFORMED");
    }
  });

  test("bad arguments are refused before any request is made", async () => {
    const api = fakeApi({ body: quote() });
    const bad = [
      { giveColour: "nothex", wantColour: WANT, giveValue: 1n },
      { giveColour: GIVE, wantColour: `${WANT}ff`, giveValue: 1n },
      { giveColour: GIVE, wantColour: GIVE, giveValue: 1n },
      { giveColour: GIVE, wantColour: WANT, giveValue: 0n },
      { giveColour: GIVE, wantColour: WANT, giveValue: -5n },
      { giveColour: GIVE, wantColour: WANT, giveValue: 1000 as unknown as bigint },
      { giveColour: GIVE, wantColour: WANT, giveValue: 1n, forcedWantAmount: -1n },
    ];
    for (const opts of bad) {
      await expect(sizeWant(api, opts)).rejects.toThrow(QuoteError);
    }
    expect(api.paths).toEqual([]);
  });
});
