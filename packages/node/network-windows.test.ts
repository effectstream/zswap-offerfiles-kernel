import { describe, expect, test } from "bun:test";

// Guards item #21: the root window mirrors the ledger per network — the
// ledger-8 networks this line serves run ~1 h (hardcoded in the zswap crate);
// STAGENET runs ledger 9's 2 weeks (served by the kernel's ledger-v9 line). The regression
// this prevents: the old 14-day default silently shipping on a 1 h network,
// where the book then lists offers whose roots the chain dropped up to two
// weeks ago — phantom, unfillable offers.
import { LedgerParameters } from "@midnight-ntwrk/ledger-v8";
import { REFERENCE_PARAMETERS } from "@zswap-da/validator";

import {
  ROOT_WINDOW_CURRENT_NETWORKS_S,
  ROOT_WINDOW_STAGENET_S,
  offerTtlSecondsNotice,
  resolveOfferTtlSeconds,
  resolveRootWindowSeconds,
  rootWindowDefaultSeconds,
} from "./network-windows.ts";

describe("root window per network", () => {
  test("all current networks default to 1 h", () => {
    for (const id of ["undeployed", "preview", "mainnet", "devnet"]) {
      expect(rootWindowDefaultSeconds(id)).toBe(3600);
    }
    expect(ROOT_WINDOW_CURRENT_NETWORKS_S).toBe(3600);
  });

  test("STAGENET placeholder defaults to 2 weeks", () => {
    expect(rootWindowDefaultSeconds("stagenet")).toBe(60 * 60 * 24 * 14);
    expect(rootWindowDefaultSeconds("STAGENET")).toBe(ROOT_WINDOW_STAGENET_S);
  });

  test("env override wins over the network default", () => {
    expect(resolveRootWindowSeconds("preview", "7200")).toBe(7200);
    expect(resolveRootWindowSeconds("stagenet", "3600")).toBe(3600);
  });

  test("garbage or non-positive env falls back to the network default", () => {
    expect(resolveRootWindowSeconds("preview", undefined)).toBe(3600);
    expect(resolveRootWindowSeconds("preview", "")).toBe(3600);
    expect(resolveRootWindowSeconds("preview", "not-a-number")).toBe(3600);
    expect(resolveRootWindowSeconds("preview", "0")).toBe(3600);
    expect(resolveRootWindowSeconds("preview", "-5")).toBe(3600);
  });
});

describe("OFFER_TTL_SECONDS is only the no-root/no-intent fallback (00056)", () => {
  test("defaults to the resolved window", () => {
    expect(resolveOfferTtlSeconds(3600, undefined)).toBe(3600);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_STAGENET_S, undefined)).toBe(
      ROOT_WINDOW_STAGENET_S,
    );
  });

  test("an env value still parses (it feeds the fallback only)", () => {
    expect(resolveOfferTtlSeconds(3600, "86400")).toBe(86400);
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

describe("ledger 8: the root window (1 h) is NOT global_ttl (14 days)", () => {
  test("every pinned snapshot's global_ttl is 14 days, while the root window stays 1 h", () => {
    for (const snapshot of Object.values(REFERENCE_PARAMETERS)) {
      const parameters = LedgerParameters.deserialize(Buffer.from(snapshot.hex, "hex"));
      const m = parameters.toString().match(/global_ttl:\s*Duration\(\s*([0-9]+)/);
      expect({ network: snapshot.networkId, globalTtl: Number(m?.[1]) })
        .toEqual({ network: snapshot.networkId, globalTtl: 1_209_600 });
      expect(rootWindowDefaultSeconds(snapshot.networkId)).toBe(ROOT_WINDOW_CURRENT_NETWORKS_S);
    }
  });
});
