// Pure unit tests for the pinned coin selector.
//
// No wallet, no indexer, no node, no proof server: `createPinnedSelector` takes
// the armed state as a getter precisely so the safety property can be tested in
// isolation. Importing this file DOES load the whole shielded/dust/facade SDK
// and the ledger wasm (that is deliberate — it doubles as the module-load smoke
// that would otherwise only surface in P3).
//
// The property under test, in one line: while armed, the give colour resolves to
// the armed coin or to NOTHING — never to a different coin.

import { beforeEach, describe, expect, test } from "bun:test";

import { chooseCoin } from "@midnightntwrk/wallet-sdk-capabilities";

import {
  createPinnedSelector,
  isPinned,
  pin,
  pinnedCoin,
  pinnedSelector,
  type ShieldedCoinSelection,
  unpin,
  withPinnedCoin,
} from "./pinned-wallet.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Two real preprod faucet colours (plan finding 1) — 64 hex chars, so they also
// exercise the `pin()` validation with values of the exact production shape.
const WBTC = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const WETH = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";

const nonce = (marker: string) => marker.repeat(64).slice(0, 64);

const N_SMALL = nonce("1a");
const N_TARGET = nonce("2b");
const N_LARGE = nonce("3c");
const N_ABSENT = nonce("9f");
const N_WETH = nonce("4d");

/** A `QualifiedShieldedCoinInfo` as the balancer hands them to the selector:
 *  `getAvailableCoins(state).map(c => c.coin)` (`Transacting.js:126-131,165-176`). */
const coin = (type: string, coinNonce: string, value: bigint) => ({
  type,
  nonce: coinNonce,
  value,
  mt_index: 0n,
});

// Deliberately ordered so that neither "first in the array" nor "smallest"
// coincides with the pinned coin: the pinned one is in the middle by value and
// last but one by position.
const COINS = [
  coin(WBTC, N_SMALL, 100n),
  coin(WETH, N_WETH, 5n),
  coin(WBTC, N_LARGE, 9_000n),
  coin(WBTC, N_TARGET, 1_000n),
];

const COST_MODEL = { inputFeeOverhead: 0n, outputFeeOverhead: 0n };

/** Call a selector the way the balancer does. */
const select = (selector: ShieldedCoinSelection, type: string, amountNeeded = 1_000n) =>
  selector(COINS, type, amountNeeded, COST_MODEL);

// ---------------------------------------------------------------------------
// createPinnedSelector — the pure contract
// ---------------------------------------------------------------------------

describe("createPinnedSelector", () => {
  test("armed: returns EXACTLY the pinned coin, ignoring smaller and larger ones", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_TARGET }));

    // Control: the SDK default would have taken the 100n coin.
    expect(chooseCoin(COINS, WBTC)?.nonce).toBe(N_SMALL);

    const picked = select(selector, WBTC);
    expect(picked?.nonce).toBe(N_TARGET);
    expect(picked?.value).toBe(1_000n);
    expect(picked).toBe(COINS[3]);
  });

  test("armed: nonce absent from the wallet -> undefined, never a substitute", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_ABSENT }));
    expect(select(selector, WBTC)).toBeUndefined();
  });

  test("unarmed: identical to the SDK's chooseCoin", () => {
    const selector = createPinnedSelector(() => null);
    for (const type of [WBTC, WETH, "", "ff".repeat(32)]) {
      expect(select(selector, type)).toBe(chooseCoin(COINS, type) as never);
    }
    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("armed: a DIFFERENT token type still resolves through the default", () => {
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_TARGET }));
    expect(select(selector, WETH)).toBe(chooseCoin(COINS, WETH) as never);
    expect(select(selector, WETH)?.nonce).toBe(N_WETH);
    // The balancer asks for the fee/NIGHT token as `''` (`Transacting.js:127,166`).
    expect(select(selector, "")).toBe(chooseCoin(COINS, "") as never);
  });

  test("armed nonce belonging to another colour is never returned", () => {
    // N_WETH exists, but as a WETH coin. Asking for WBTC must yield nothing.
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_WETH }));
    expect(select(selector, WBTC)).toBeUndefined();
  });

  test("the armed ref is read per call, not captured at construction", () => {
    let armed: { tokenType: string; nonce: string } | null = null;
    const selector = createPinnedSelector(() => armed);

    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
    armed = { tokenType: WBTC, nonce: N_LARGE };
    expect(select(selector, WBTC)?.nonce).toBe(N_LARGE);
    armed = null;
    expect(select(selector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("the fallback receives all four arguments unchanged", () => {
    const seen: unknown[][] = [];
    const spy: ShieldedCoinSelection = (...args) => {
      seen.push([...args]);
      return undefined;
    };
    const selector = createPinnedSelector(() => null, spy);

    expect(select(selector, WBTC, 42n)).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(COINS);
    expect(seen[0]?.[1]).toBe(WBTC);
    expect(seen[0]?.[2]).toBe(42n);
    expect(seen[0]?.[3]).toBe(COST_MODEL);
  });

  test("armed: the fallback is never consulted for the armed colour", () => {
    let calls = 0;
    const spy: ShieldedCoinSelection = (...args) => {
      calls += 1;
      return chooseCoin(args[0], args[1]);
    };
    const selector = createPinnedSelector(() => ({ tokenType: WBTC, nonce: N_ABSENT }), spy);

    expect(select(selector, WBTC)).toBeUndefined();
    expect(calls).toBe(0);

    expect(select(selector, WETH)?.nonce).toBe(N_WETH);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pin / unpin / isPinned and the exported singleton selector
// ---------------------------------------------------------------------------

describe("pin / unpin / isPinned", () => {
  beforeEach(() => {
    unpin();
  });

  test("the exported pinnedSelector follows the module-level armed state", () => {
    expect(isPinned()).toBe(false);
    expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_SMALL);

    pin(WBTC, N_TARGET);
    expect(isPinned()).toBe(true);
    expect(pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_TARGET);
    expect(select(pinnedSelector, WETH)?.nonce).toBe(N_WETH);

    unpin();
    expect(isPinned()).toBe(false);
    expect(pinnedCoin()).toBeNull();
    expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_SMALL);
  });

  test("pin() while armed throws and leaves the original ref in place", () => {
    pin(WBTC, N_TARGET);
    expect(() => pin(WBTC, N_LARGE)).toThrow(/already pinned/);
    expect(pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_TARGET);
  });

  test("unpin() is idempotent, so it is safe in a finally", () => {
    unpin();
    unpin();
    expect(isPinned()).toBe(false);
  });

  test("pin() normalises 0x prefixes and upper case", () => {
    pin(`0X${WBTC.toUpperCase()}`, `0x${N_TARGET.toUpperCase()}`);
    expect(pinnedCoin()).toEqual({ tokenType: WBTC, nonce: N_TARGET });
    expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_TARGET);
  });

  test("pin() rejects malformed colours and nonces", () => {
    expect(() => pin("not-hex", N_TARGET)).toThrow(/tokenType/);
    expect(() => pin(WBTC, "abc")).toThrow(/nonce/);
    expect(() => pin(WBTC, "")).toThrow(/nonce/);
    expect(isPinned()).toBe(false);
  });

  test("withPinnedCoin unpins on success and on throw", async () => {
    const result = await withPinnedCoin(WBTC, N_TARGET, async () => {
      expect(select(pinnedSelector, WBTC)?.nonce).toBe(N_TARGET);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(isPinned()).toBe(false);

    await expect(
      withPinnedCoin(WBTC, N_TARGET, async () => {
        expect(isPinned()).toBe(true);
        throw new Error("build failed");
      }),
    ).rejects.toThrow("build failed");
    expect(isPinned()).toBe(false);
  });
});
