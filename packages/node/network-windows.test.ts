import { describe, expect, test } from "bun:test";

// Guards item #21: the root window is a LEDGER parameter mirrored per
// network — all currently deployed networks run ~1 h; STAGENET (placeholder,
// not publicly available) runs the next release's 2 weeks. The regression
// this prevents: the old 14-day default silently shipping on a 1 h network,
// where the book then lists offers whose roots the chain dropped up to two
// weeks ago — phantom, unfillable offers.
import {
  ROOT_WINDOW_CURRENT_NETWORKS_S,
  ROOT_WINDOW_STAGENET_S,
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

describe("offer TTL tracks the root window", () => {
  test("defaults to the resolved window (shielded fillability bound)", () => {
    expect(resolveOfferTtlSeconds(3600, undefined)).toBe(3600);
    expect(resolveOfferTtlSeconds(ROOT_WINDOW_STAGENET_S, undefined)).toBe(
      ROOT_WINDOW_STAGENET_S,
    );
  });

  test("env override wins (e.g. unshielded-heavy books)", () => {
    expect(resolveOfferTtlSeconds(3600, "86400")).toBe(86400);
  });
});
