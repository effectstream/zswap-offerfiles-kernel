import { describe, expect, test } from "bun:test";

// Guards item #21: the root window mirrors the ledger's zswap `past_roots`
// retention. On ledger 9 that is the `global_ttl` ledger parameter, 1209600 s
// (14 days) on every network, and static (changing it is a hard fork) — so
// every network id resolves to the same default. The regression this
// prevents: a 1 h default on a 14-day chain, which expires and prunes offers
// the chain still accepts and rejects fills whose root is only hours old
// (ROOT_UNKNOWN). The opposite mistake (14 days on a 1 h chain) is why the
// value is pinned here rather than made a tunable per network.
import {
  OFFER_TTL_BOUND_TEXT,
  OFFER_TTL_DEFAULT_MINUTES,
  OFFER_TTL_MAX_MINUTES,
  OFFER_TTL_MAX_S,
  ROOT_WINDOW_DEFAULT_S,
  ROOT_WINDOW_STAGENET_S,
  TTL_SAFETY_MARGIN_S,
  resolveOfferTtlSeconds,
  resolveRootWindowSeconds,
  rootWindowDefaultSeconds,
} from "./network-windows.ts";

const FOURTEEN_DAYS_S = 14 * 24 * 60 * 60;

describe("root window = ledger global_ttl (14 days) on every network", () => {
  test("the static default is 1209600 s", () => {
    expect(ROOT_WINDOW_DEFAULT_S).toBe(1_209_600);
    expect(ROOT_WINDOW_DEFAULT_S).toBe(FOURTEEN_DAYS_S);
  });

  test("every network id resolves to the same default, known or not", () => {
    for (const id of [
      "undeployed",
      "preview",
      "preprod",
      "stagenet",
      "mainnet",
      "devnet",
      "qanet",
      "STAGENET",
      "Preview",
      "some-future-network",
      "",
    ]) {
      expect(rootWindowDefaultSeconds(id)).toBe(1_209_600);
      expect(resolveRootWindowSeconds(id, undefined)).toBe(1_209_600);
    }
  });

  test("the deprecated stagenet alias carries the same value", () => {
    expect(ROOT_WINDOW_STAGENET_S).toBe(ROOT_WINDOW_DEFAULT_S);
  });

  test("stagenet defaults to its 14-day global_ttl (00050 FR-006)", () => {
    expect(ROOT_WINDOW_STAGENET_S).toBe(1_209_600);
    expect(rootWindowDefaultSeconds("stagenet")).toBe(60 * 60 * 24 * 14);
    expect(rootWindowDefaultSeconds("STAGENET")).toBe(ROOT_WINDOW_STAGENET_S);
  });

  test("env override wins over the default", () => {
    expect(resolveRootWindowSeconds("preview", "7200")).toBe(7200);
    expect(resolveRootWindowSeconds("stagenet", "3600")).toBe(3600);
    expect(resolveRootWindowSeconds("undeployed", "600")).toBe(600);
  });

  test("garbage or non-positive env falls back to the default", () => {
    for (const env of [undefined, "", "not-a-number", "0", "-5"]) {
      expect(resolveRootWindowSeconds("preview", env)).toBe(1_209_600);
    }
  });
});

describe("offer TTL tracks the root window", () => {
  test("defaults to the resolved window: 14 days with no env set", () => {
    const window = resolveRootWindowSeconds("preprod", undefined);
    expect(resolveOfferTtlSeconds(window, undefined)).toBe(1_209_600);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_STAGENET_S, undefined)).toBe(ROOT_WINDOW_STAGENET_S);
  });

  test("follows a ROOT_WINDOW_SECONDS override when OFFER_TTL_SECONDS is unset", () => {
    const window = resolveRootWindowSeconds("undeployed", "600");
    expect(resolveOfferTtlSeconds(window, undefined)).toBe(600);
  });

  test("env override wins (e.g. unshielded-heavy books)", () => {
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_DEFAULT_S, "86400")).toBe(86400);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_DEFAULT_S, "0")).toBe(ROOT_WINDOW_DEFAULT_S);
  });
});

// 00055: the poster's and the maker one-shot's offer TTL default and bound are
// derived here, from the root window minus one shared safety margin, so no
// second literal exists. The ledger-level check of the bound is in
// offer-ttl-boundary.test.ts.
describe("client offer TTL = root window minus a 1 h safety margin (00055)", () => {
  test("the margin is 1 hour", () => {
    expect(TTL_SAFETY_MARGIN_S).toBe(3_600);
  });

  test("the bound is derived from the root window: 1,206,000 s = 20,100 min", () => {
    expect(OFFER_TTL_MAX_S).toBe(ROOT_WINDOW_DEFAULT_S - TTL_SAFETY_MARGIN_S);
    expect(OFFER_TTL_MAX_S).toBe(1_206_000);
    expect(OFFER_TTL_MAX_MINUTES).toBe(20_100);
    expect(Number.isInteger(OFFER_TTL_MAX_MINUTES)).toBe(true);
    expect(OFFER_TTL_MAX_MINUTES * 60).toBe(OFFER_TTL_MAX_S);
  });

  test("the default is the bound, strictly below global_ttl", () => {
    expect(OFFER_TTL_DEFAULT_MINUTES).toBe(OFFER_TTL_MAX_MINUTES);
    expect(OFFER_TTL_DEFAULT_MINUTES * 60).toBeLessThan(ROOT_WINDOW_DEFAULT_S);
  });

  test("refusals state the bound, the global_ttl and the margin", () => {
    expect(OFFER_TTL_BOUND_TEXT).toContain("20100 minutes");
    expect(OFFER_TTL_BOUND_TEXT).toContain("1209600 s");
    expect(OFFER_TTL_BOUND_TEXT).toContain("3600 s");
  });
});
