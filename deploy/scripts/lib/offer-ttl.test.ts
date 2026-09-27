import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OFFER_TTL_DEFAULT_MINUTES,
  OFFER_TTL_MAX_S,
  ROOT_WINDOW_DEFAULT_S,
  TTL_SAFETY_MARGIN_S,
} from "../../../packages/node/network-windows.ts";
import {
  OFFER_TTL_DEFAULT_MS,
  OFFER_TTL_MAX_MS,
  OfferTtlError,
  assertOfferTtlMs,
  resolveOfferTtlMinutes,
} from "./offer-ttl.ts";
import { parsePosterConfig } from "./poster-config.ts";

// 00055 FR-002 / T2: the maker one-shot's TTL default and bound equal the
// poster's (T1), and compose plus the env examples add no second literal.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("TTL_MINUTES for the maker one-shot", () => {
  test("unset or blank is the derived default, 20,100 minutes", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(resolveOfferTtlMinutes("TTL_MINUTES", raw)).toBe(OFFER_TTL_DEFAULT_MINUTES);
    }
    expect(OFFER_TTL_DEFAULT_MINUTES).toBe((ROOT_WINDOW_DEFAULT_S - TTL_SAFETY_MARGIN_S) / 60);
    expect(OFFER_TTL_DEFAULT_MS).toBe(20_100 * 60_000);
  });

  test("an explicit value wins, up to and including the bound", () => {
    expect(resolveOfferTtlMinutes("TTL_MINUTES", "120")).toBe(120);
    expect(resolveOfferTtlMinutes("TTL_MINUTES", " 30 ")).toBe(30);
    expect(resolveOfferTtlMinutes("TTL_MINUTES", "20100")).toBe(20_100);
  });

  test("a value above the bound is refused by name, stating the bound", () => {
    let caught: unknown;
    try {
      resolveOfferTtlMinutes("TTL_MINUTES", "20101");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OfferTtlError);
    expect((caught as OfferTtlError).variable).toBe("TTL_MINUTES");
    expect((caught as OfferTtlError).name).toBe("OfferTtlError");
    expect(String((caught as Error).message)).toBe(
      "TTL_MINUTES must be <= 20100 minutes (the ledger global_ttl of 1209600 s minus the " +
        "3600 s safety margin), got 20101",
    );
    expect(() => resolveOfferTtlMinutes("TTL_MINUTES", String(ROOT_WINDOW_DEFAULT_S / 60))).toThrow(
      OfferTtlError,
    );
  });

  test("zero, negative, fractional and non-numeric values are refused by name", () => {
    // The old parser turned "0" (and "") into a zero TTL, and "abc" into NaN.
    for (const bad of ["0", "-5", "1.5", "abc", "12abc"]) {
      expect(() => resolveOfferTtlMinutes("TTL_MINUTES", bad)).toThrow(/^TTL_MINUTES must be/);
    }
  });
});

describe("postMakerOffer's ttlMs guard", () => {
  test("accepts the default and the bound, refuses more by name", () => {
    expect(assertOfferTtlMs("ttlMs", OFFER_TTL_DEFAULT_MS)).toBe(OFFER_TTL_DEFAULT_MS);
    expect(OFFER_TTL_MAX_MS).toBe(OFFER_TTL_MAX_S * 1000);
    expect(assertOfferTtlMs("ttlMs", OFFER_TTL_MAX_MS)).toBe(OFFER_TTL_MAX_MS);
    expect(() => assertOfferTtlMs("ttlMs", OFFER_TTL_MAX_MS + 1)).toThrow(
      /^ttlMs must be <= 1206000000 ms = 20100 minutes/,
    );
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertOfferTtlMs("ttlMs", bad)).toThrow(OfferTtlError);
    }
  });

  test("postMakerOffer refuses an over-long ttlMs before touching the wallet", async () => {
    // Dynamic: maker-offer.ts pulls in the wallet stack. The wallet is a trap,
    // so reaching it at all fails the test.
    const { postMakerOffer } = await import("./maker-offer.ts");
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error("the wallet was touched before the TTL was checked");
        },
      },
    );
    await expect(
      postMakerOffer({
        maker: { wallet: trap },
        api: {} as never,
        giveToken: "11".repeat(32),
        wantToken: "22".repeat(32),
        giveAmount: 1n,
        wantAmount: 1n,
        ttlMs: OFFER_TTL_MAX_MS + 60_000,
      }),
    ).rejects.toBeInstanceOf(OfferTtlError);
  });
});

describe("compose and the env examples carry no second TTL literal", () => {
  const compose = read("deploy/compose.yml");
  const envExample = read("deploy/.env.example");

  test("compose passes both TTL knobs through blank, so the tools' defaults apply", () => {
    expect(compose).toContain("TTL_MINUTES: ${MAKER_OFFER_TTL_MINUTES:-}\n");
    expect(compose).toContain("OFFER_TTL_MINUTES: ${OFFER_POSTER_TTL_MINUTES:-}\n");
    expect(compose).not.toMatch(/TTL_MINUTES:-\d/);
  });

  test("deploy/.env.example leaves both knobs blank (bootstrap.sh copies it to .env)", () => {
    expect(envExample).toMatch(/^MAKER_OFFER_TTL_MINUTES=$/m);
    expect(envExample).toMatch(/^OFFER_POSTER_TTL_MINUTES=$/m);
  });

  test(".env.stagenet.example documents the same default", () => {
    const m = read(".env.stagenet.example").match(/^# OFFER_TTL_MINUTES=(\d+)$/m);
    expect(m?.[1]).toBe(String(OFFER_TTL_DEFAULT_MINUTES));
  });

  test("what compose renders reaches both tools as the same TTL", async () => {
    const maker = resolveOfferTtlMinutes("TTL_MINUTES", "");
    const poster = await parsePosterConfig({
      POSTER_SEED: "ab".repeat(32),
      GIVE_TOKEN: "12".repeat(32),
      WANT_TOKEN: "34".repeat(32),
      OFFER_TTL_MINUTES: "",
    });
    expect(maker).toBe(20_100);
    expect(poster.offerTtlMinutes).toBe(maker);
  });
});
