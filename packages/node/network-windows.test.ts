import { describe, expect, test } from "bun:test";

// Guards item #21: the root window mirrors the ledger's zswap `past_roots`
// retention. On ledger 9 that is the `global_ttl` ledger parameter, 1209600 s
// (14 days) on every network, and static (changing it is a hard fork) — so
// every network id resolves to the same default. The regression this
// prevents: a 1 h default on a 14-day chain, which expires and prunes offers
// the chain still accepts and rejects fills whose root is only hours old
// (ROOT_UNKNOWN). The opposite mistake (14 days on a 1 h chain) is why the
// value is pinned here rather than made a tunable per network.
import { LedgerParameters } from "@midnightntwrk/ledger-v9";
import { REFERENCE_PARAMETERS } from "@zswap-da/validator";

import {
  ROOT_WINDOW_DEFAULT_S,
  ROOT_WINDOW_STAGENET_S,
  offerTtlSecondsNotice,
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

describe("OFFER_TTL_SECONDS is only the no-root/no-intent fallback (00056)", () => {
  test("defaults to the resolved window: 14 days with no env set", () => {
    const window = resolveRootWindowSeconds("preprod", undefined);
    expect(resolveOfferTtlSeconds(window, undefined)).toBe(1_209_600);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_STAGENET_S, undefined)).toBe(ROOT_WINDOW_STAGENET_S);
  });

  test("follows a ROOT_WINDOW_SECONDS override when OFFER_TTL_SECONDS is unset", () => {
    const window = resolveRootWindowSeconds("undeployed", "600");
    expect(resolveOfferTtlSeconds(window, undefined)).toBe(600);
  });

  test("an env value still parses (it feeds the fallback only)", () => {
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_DEFAULT_S, "86400")).toBe(86400);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_DEFAULT_S, "0")).toBe(ROOT_WINDOW_DEFAULT_S);
  });

  test("setting it produces a startup warning; unset or blank does not", () => {
    expect(offerTtlSecondsNotice(undefined)).toBeNull();
    expect(offerTtlSecondsNotice("")).toBeNull();
    expect(offerTtlSecondsNotice("  ")).toBeNull();
    const notice = offerTtlSecondsNotice("600");
    expect(notice).toContain("OFFER_TTL_SECONDS=600 no longer caps offer lifetimes (00056)");
    expect(notice).toContain("ROOT_WINDOW_SECONDS");
    expect(notice).toContain("intent TTL");
  });
});

describe("the root window equals the pinned reference parameters' global_ttl", () => {
  test("every ledger-9 snapshot's global_ttl is ROOT_WINDOW_DEFAULT_S", () => {
    for (const snapshot of Object.values(REFERENCE_PARAMETERS)) {
      const parameters = LedgerParameters.deserialize(Buffer.from(snapshot.hex, "hex"));
      const m = parameters.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
      expect({ network: snapshot.networkId, globalTtl: Number(m?.[1]) })
        .toEqual({ network: snapshot.networkId, globalTtl: ROOT_WINDOW_DEFAULT_S });
    }
  });
});
