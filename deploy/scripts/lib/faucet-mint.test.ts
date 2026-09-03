// Unit tests for the faucet mint helper. Pure: no chain, no kernel, no network
// — `fetch` is stubbed for the registry routes and `deployed.callTx` is a
// hand-built object.
//
// The vector test is the important one. It pins the derivation against the
// colours PREPROD actually has registered, so a change to `mintable.ts`, to the
// ledger binding, or to the hex normalisation shows up here rather than as
// unspendable coins on a live stack.

import { describe, expect, test } from "bun:test";
import { ZswapSecretKeys } from "@midnight-ntwrk/ledger-v8";

import {
  __resetNonceCounter,
  assertShieldedPreset,
  domainSepFromName,
  expectedColour,
  freshNonce,
  isColourHex,
  mintFaucetToken,
  normaliseHex32,
  normaliseTokenName,
  presetKind,
  registerAndVerifyTokenName,
  registerTokenName,
  resolveColour,
  toHex,
  verifyTokenName,
} from "./faucet-mint.ts";
import type { FaucetContract, KnownTokenRow, MintShieldedTx } from "./faucet-mint.ts";
import { KernelApi } from "./kernel-api.ts";
import { MINT_AMOUNT, MINT_COINS } from "../../../docs/src/wallet/mintable.ts";
import { coinsToBaseUnits, DEFAULT_TOKEN_DECIMALS } from "../../../packages/solver-core/amount.ts";

// Preprod's deployed offer-files contract, and the colours it produced.
const PREPROD_CONTRACT = "6fc44c272d866574cefc14e25474fdfa144e6427f299a8222a8ad8a7b374bb7c";
const PREPROD_WBTC = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const PREPROD_WETH = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";
const PREPROD_USDC = "e840515ec4375ffa0f0d6f927730ba0524ff446dacd401896ba4f23ec6282093";

// The THUNK form, for the reason MintContext.coinSecretKey documents: a
// captured `coinSecretKey` does not keep its owning `ZswapSecretKeys` alive, and
// once the owner is collected the secret is cleared and every derived handle
// throws. Reading it through a thunk keeps the owner referenced by live code.
// This fixture is the proof the hazard is real: with
// `const KEY = ZswapSecretKeys.fromSeed(seed).coinSecretKey` these tests pass
// individually and fail part-way through the file, once a GC has run.
const ZSWAP_KEYS = ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3));
const COIN_SECRET_KEY = () => ZSWAP_KEYS.coinSecretKey;
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));

// ── colour derivation ────────────────────────────────────────────────────────

describe("colour derivation (vector)", () => {
  test("the WBTC domain separator matches the frontend faucet", () => {
    // The first 8 bytes are the FNV-1a run over "zswap-da-faucet:WBTC"; the
    // whole 32 are checked implicitly by the colour below.
    expect(toHex(domainSepFromName("WBTC")).startsWith("ad7a77a29661df1a")).toBe(true);
    expect(toHex(domainSepFromName("WBTC"))).toHaveLength(64);
    // Different names must not collide.
    expect(toHex(domainSepFromName("WBTC"))).not.toBe(toHex(domainSepFromName("WETH")));
  });

  test("reproduces preprod's registered colours from its contract address", () => {
    expect(expectedColour("WBTC", PREPROD_CONTRACT)).toBe(PREPROD_WBTC);
    expect(expectedColour("WETH", PREPROD_CONTRACT)).toBe(PREPROD_WETH);
    expect(expectedColour("USDC", PREPROD_CONTRACT)).toBe(PREPROD_USDC);
  });

  test("the colour is a property of the deployment, not of the name", () => {
    const other = "1".repeat(64);
    expect(expectedColour("WBTC", other)).not.toBe(PREPROD_WBTC);
  });

  test("normalises the contract address the way rawTokenType needs it", () => {
    // Upper case is accepted by the binding and must give the same colour…
    expect(expectedColour("WBTC", PREPROD_CONTRACT.toUpperCase())).toBe(PREPROD_WBTC);
    // …a `0x` prefix is NOT ("Invalid character 'x' at position 1"), so we strip it.
    expect(expectedColour("WBTC", `0x${PREPROD_CONTRACT}`)).toBe(PREPROD_WBTC);
    // Wrong length is a clear error, not a WASM panic.
    expect(() => expectedColour("WBTC", PREPROD_CONTRACT.slice(0, 62))).toThrow(/64 hex characters/);
    expect(() => expectedColour("WBTC", "not-an-address")).toThrow(/64 hex characters/);
  });

  test("expectedColour refuses a colour where a name is expected", () => {
    expect(() => expectedColour(PREPROD_WBTC, PREPROD_CONTRACT)).toThrow(/token NAME, not a colour/);
    expect(() => expectedColour("", PREPROD_CONTRACT)).toThrow(/empty/);
  });
});

describe("resolveColour", () => {
  test("derives from a name", () => {
    expect(resolveColour("WBTC", PREPROD_CONTRACT)).toBe(PREPROD_WBTC);
  });

  test("passes a 64-hex colour through, normalised", () => {
    expect(resolveColour(PREPROD_WETH, PREPROD_CONTRACT)).toBe(PREPROD_WETH);
    expect(resolveColour(PREPROD_WETH.toUpperCase(), PREPROD_CONTRACT)).toBe(PREPROD_WETH);
    expect(resolveColour(`0x${PREPROD_WETH}`, PREPROD_CONTRACT)).toBe(PREPROD_WETH);
    // A raw colour needs no contract address at all.
    expect(resolveColour(PREPROD_WETH, "")).toBe(PREPROD_WETH);
  });

  test("isColourHex tells names and colours apart", () => {
    expect(isColourHex(PREPROD_WBTC)).toBe(true);
    expect(isColourHex(`0x${PREPROD_WBTC}`)).toBe(true);
    expect(isColourHex("WBTC")).toBe(false);
    expect(isColourHex("abc")).toBe(false);
  });

  test("normaliseHex32 lower-cases and strips 0x", () => {
    expect(normaliseHex32(`0X${PREPROD_WBTC.toUpperCase()}`, "x")).toBe(PREPROD_WBTC);
  });
});

// ── presets ──────────────────────────────────────────────────────────────────

describe("presets", () => {
  test("kinds come from PRESET_TOKENS, plus NIGHT", () => {
    expect(presetKind("WBTC")).toBe("shielded");
    expect(presetKind("WETH")).toBe("shielded");
    expect(presetKind("USDC")).toBe("shielded");
    expect(presetKind("ZTOKEN")).toBe("shielded");
    expect(presetKind("ATOKEN")).toBe("unshielded");
    expect(presetKind("BTOKEN")).toBe("unshielded");
    expect(presetKind("NIGHT")).toBe("unshielded");
    expect(presetKind("night")).toBe("unshielded");
    // Not a preset — legal, just unknown to the faucet UI.
    expect(presetKind("TESTTOKEN")).toBeUndefined();
  });

  test("assertShieldedPreset refuses every unshielded leg", () => {
    for (const bad of ["ATOKEN", "BTOKEN", "NIGHT", "atoken", " night "]) {
      expect(() => assertShieldedPreset(bad)).toThrow(/unshielded|shielded\/unshielded/i);
    }
  });

  test("assertShieldedPreset allows shielded presets and unknown names", () => {
    for (const ok of ["WBTC", "WETH", "USDC", "ZTOKEN", "TESTTOKEN"]) {
      expect(assertShieldedPreset(ok)).toBe("shielded");
    }
  });

  test("assertShieldedPreset refuses the all-zero NIGHT colour given as hex", () => {
    expect(() => assertShieldedPreset("0".repeat(64))).toThrow(/NIGHT/);
    expect(assertShieldedPreset(PREPROD_WBTC)).toBe("shielded");
    expect(() => assertShieldedPreset("")).toThrow(/empty/);
  });

  test("normaliseTokenName matches the registry's own normalisation", () => {
    // packages/node/api.ts: trim → toUpperCase → slice(0, 16)
    expect(normaliseTokenName("  wbtc ")).toBe("WBTC");
    expect(normaliseTokenName("a".repeat(20))).toBe("A".repeat(16));
  });
});

// ── nonces ───────────────────────────────────────────────────────────────────

describe("freshNonce", () => {
  test("is strictly increasing across a tight burst", () => {
    __resetNonceCounter();
    const seen: bigint[] = [];
    for (let i = 0; i < 500; i++) seen.push(freshNonce());
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]! > seen[i - 1]!).toBe(true);
    }
    expect(new Set(seen.map(String)).size).toBe(seen.length);
  });

  test("carries the millisecond clock in the high digits", () => {
    __resetNonceCounter();
    const before = BigInt(Date.now());
    const n = freshNonce();
    const after = BigInt(Date.now());
    expect(n / 1000n >= before).toBe(true);
    expect(n / 1000n <= after).toBe(true);
    expect(n % 1000n).toBe(0n); // counter was just reset
  });
});

// ── minting ──────────────────────────────────────────────────────────────────

/** A `deployed` whose mint returns a canned Compact ShieldedCoinInfo. */
function fakeContract(
  colour: string,
  opts: { value?: bigint; nonce?: string; txHash?: string; txId?: string; omitResult?: boolean } = {},
): FaucetContract & { calls: Array<{ sep: string; amount: bigint; nonce: bigint }> } {
  const calls: Array<{ sep: string; amount: bigint; nonce: bigint }> = [];
  return {
    calls,
    callTx: {
      async mint_shielded(sep: Uint8Array, amount: bigint, nonce: bigint): Promise<MintShieldedTx> {
        calls.push({ sep: toHex(sep), amount, nonce });
        if (opts.omitResult) return { private: {}, public: { txHash: opts.txHash } };
        return {
          private: {
            result: {
              color: bytes(colour),
              nonce: bytes(opts.nonce ?? "ab".repeat(32)),
              value: opts.value ?? amount,
            },
          },
          public: { txHash: opts.txHash, txId: opts.txId },
        };
      },
    },
  };
}

describe("mintFaucetToken", () => {
  const ctx = { contractAddress: PREPROD_CONTRACT, coinSecretKey: COIN_SECRET_KEY };

  test("accepts the coin when the minted colour is the derived one", async () => {
    // The canned colour is built with the SAME rawTokenType path the assertion
    // uses, so this exercises the passing branch end to end.
    const deployed = fakeContract(expectedColour("WBTC", PREPROD_CONTRACT), {
      txHash: "deadbeef",
      nonce: "07".repeat(32),
    });
    const minted = await mintFaucetToken(deployed, "WBTC", 1000n, 42n, ctx);

    expect(minted.colour).toBe(PREPROD_WBTC);
    expect(minted.coin.type).toBe(PREPROD_WBTC);
    expect(minted.coin.value).toBe(1000n);
    expect(minted.coin.nonce).toBe("07".repeat(32));
    expect(minted.txHash).toBe("deadbeef");
    expect(minted.mintNonce).toBe(42n);
    // The nullifier is real and deterministic for this key + coin.
    expect(minted.nullifier).toMatch(/^[0-9a-f]{64}$/);

    // The circuit saw the faucet separator and our arguments verbatim.
    expect(deployed.calls).toHaveLength(1);
    expect(deployed.calls[0]!.sep).toBe(toHex(domainSepFromName("WBTC")));
    expect(deployed.calls[0]!.amount).toBe(1000n);
    expect(deployed.calls[0]!.nonce).toBe(42n);
  });

  test("the coin nonce is the CHAIN nonce, not the bigint passed in", async () => {
    const deployed = fakeContract(PREPROD_WBTC, { nonce: "5c".repeat(32) });
    const minted = await mintFaucetToken(deployed, "WBTC", 5n, 999n, ctx);
    // evolveNonce(nonce, sep) on chain — this is what availableCoins is keyed by.
    expect(minted.coin.nonce).toBe("5c".repeat(32));
    expect(minted.mintNonce).toBe(999n);
  });

  test("REFUSES a coin whose colour is not the derived one", async () => {
    // The wrong-but-plausible colour: the right name against another contract.
    const wrong = expectedColour("WBTC", "1".repeat(64));
    const deployed = fakeContract(wrong);
    await expect(mintFaucetToken(deployed, "WBTC", 1000n, 1n, ctx)).rejects.toThrow(
      /is NOT the token that name means on this deployment/,
    );
  });

  test("REFUSES another name's colour minted under our name", async () => {
    const deployed = fakeContract(PREPROD_WETH);
    await expect(mintFaucetToken(deployed, "WBTC", 1000n, 1n, ctx)).rejects.toThrow(/minted colour fda14e2e/);
  });

  test("refuses a value that is not what was asked for", async () => {
    const deployed = fakeContract(PREPROD_WBTC, { value: 999n });
    await expect(mintFaucetToken(deployed, "WBTC", 1000n, 1n, ctx)).rejects.toThrow(/minted 999 but 1000/);
  });

  test("reports a missing tx result instead of decoding undefined", async () => {
    const deployed = fakeContract(PREPROD_WBTC, { omitResult: true });
    await expect(mintFaucetToken(deployed, "WBTC", 1000n, 1n, ctx)).rejects.toThrow(/no private.result/);
  });

  test("falls back to txId when the SDK sets no txHash", async () => {
    const deployed = fakeContract(PREPROD_WBTC, { txId: "cafe" });
    expect((await mintFaucetToken(deployed, "WBTC", 1n, 1n, ctx)).txHash).toBe("cafe");
  });

  test("accepts a bare CoinSecretKey as well as a thunk, with the same result", async () => {
    // The owner is kept alive by COIN_SECRET_KEY's closure, so reading a handle
    // out of it here is safe; this covers the non-thunk branch.
    const viaThunk = await mintFaucetToken(fakeContract(PREPROD_WBTC), "WBTC", 7n, 1n, ctx);
    const viaBare = await mintFaucetToken(fakeContract(PREPROD_WBTC), "WBTC", 7n, 1n, {
      contractAddress: PREPROD_CONTRACT,
      coinSecretKey: ZSWAP_KEYS.coinSecretKey,
    });
    expect(viaBare.nullifier).toBe(viaThunk.nullifier);
    expect(viaBare.nullifier).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses unshielded and malformed arguments before touching the chain", async () => {
    const deployed = fakeContract(PREPROD_WBTC);
    await expect(mintFaucetToken(deployed, "NIGHT", 1n, 1n, ctx)).rejects.toThrow(/unshielded/i);
    await expect(mintFaucetToken(deployed, "ATOKEN", 1n, 1n, ctx)).rejects.toThrow(/unshielded/i);
    await expect(mintFaucetToken(deployed, PREPROD_WBTC, 1n, 1n, ctx)).rejects.toThrow(/token NAME/);
    await expect(mintFaucetToken(deployed, "WBTC", 0n, 1n, ctx)).rejects.toThrow(/positive bigint/);
    await expect(mintFaucetToken(deployed, "WBTC", -5n, 1n, ctx)).rejects.toThrow(/positive bigint/);
    await expect(mintFaucetToken(deployed, "WBTC", 1n, -1n, ctx)).rejects.toThrow(/non-negative bigint/);
    expect(deployed.calls).toHaveLength(0);
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

interface Route {
  status: number;
  body: unknown;
}

/** Install a `fetch` that answers the two registry routes from a script. */
function mockRegistry(script: {
  post?: Route | ((body: any) => Route);
  tokens?: KnownTokenRow[] | Route;
}): { posts: any[]; gets: number; restore: () => void } {
  const original = globalThis.fetch;
  const posts: any[] = [];
  let gets = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const path = String(url);
    if (init?.method === "POST" && path.includes("/v1/known-tokens")) {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      const r = typeof script.post === "function" ? script.post(body) : script.post;
      const route = r ?? { status: 200, body: { success: true } };
      return new Response(JSON.stringify(route.body), { status: route.status });
    }
    if (path.includes("/v1/known-tokens")) {
      gets++;
      const t = script.tokens;
      const route: Route = Array.isArray(t) ? { status: 200, body: t } : (t ?? { status: 200, body: [] });
      return new Response(JSON.stringify(route.body), { status: route.status });
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${path}`);
  }) as typeof fetch;
  return { posts, gets, restore: () => { globalThis.fetch = original; } };
}

const API = { base: "http://kernel.test:9999" };
const row = (color: string, name: string, extra: Partial<KnownTokenRow> = {}): KnownTokenRow => ({
  token_color: color,
  name,
  kind: "shielded",
  decimals: 6,
  asset_id: null,
  ...extra,
});
const quiet = { warn: () => {} };

describe("the faucet allotment (00024 FR-003)", () => {
  test("one press is 1 000 WHOLE COINS, scaled to base units for the circuit", () => {
    // The browser playground and every deploy script mint this exact value, so
    // the constant is the one place the allotment can be read or changed.
    expect(MINT_COINS).toBe(1000n);
    expect(MINT_AMOUNT).toBe(1_000_000_000n);
    expect(MINT_AMOUNT).toBe(coinsToBaseUnits(MINT_COINS, DEFAULT_TOKEN_DECIMALS));
  });
});

describe("registerTokenName", () => {
  test("200 — the row was created", async () => {
    const m = mockRegistry({ post: { status: 200, body: { success: true, name: "WBTC" } } });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r).toMatchObject({ registered: true, reason: "registered", status: 200 });
      // The body is exactly what the route's schema requires, and it STATES
      // decimals (00024 FR-002) instead of leaning on the column default.
      expect(m.posts[0]).toEqual({
        color: PREPROD_WBTC,
        name: "WBTC",
        kind: "shielded",
        decimals: 6,
      });
    } finally {
      m.restore();
    }
  });

  test("normalises the colour and the name the way the route does", async () => {
    const m = mockRegistry({ post: { status: 200, body: {} } });
    try {
      await registerTokenName(API, `0x${PREPROD_WBTC.toUpperCase()}`, " wbtc ", "shielded", quiet);
      expect(m.posts[0]).toEqual({
        color: PREPROD_WBTC,
        name: "WBTC",
        kind: "shielded",
        decimals: 6,
      });
    } finally {
      m.restore();
    }
  });

  test("409 colour-already-registered under the SAME name is success", async () => {
    const m = mockRegistry({
      post: { status: 409, body: { error: 'Token color already registered as "WBTC"' } },
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r).toMatchObject({ registered: true, reason: "already_registered", existingName: "WBTC" });
    } finally {
      m.restore();
    }
  });

  test("409 colour-already-registered under a DIFFERENT name is not", async () => {
    const warnings: string[] = [];
    const m = mockRegistry({
      post: { status: 409, body: { error: 'Token color already registered as "WETH"' } },
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", {
        warn: (w) => warnings.push(w),
      });
      expect(r).toMatchObject({ registered: false, reason: "colour_renamed", existingName: "WETH" });
      expect(warnings.join()).toMatch(/priced as WETH/);
    } finally {
      m.restore();
    }
  });

  test("409 name-taken by OUR OWN colour is the ordinary restart path", async () => {
    // The route checks the NAME before the COLOUR (api.ts:693-701), so a
    // restart of an already-registered pair produces the NAME 409 — not the
    // colour one. The lookup is what tells it apart from a real clash.
    const m = mockRegistry({
      post: { status: 409, body: { error: 'Token name "WBTC" is already taken' } },
      tokens: [row(PREPROD_WBTC, "WBTC")],
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r).toMatchObject({
        registered: true,
        reason: "already_registered",
        existingColour: PREPROD_WBTC,
      });
    } finally {
      m.restore();
    }
  });

  test("409 name-taken by a DIFFERENT colour leaves the leg unpriced", async () => {
    const warnings: string[] = [];
    const stale = "9".repeat(64);
    const m = mockRegistry({
      post: { status: 409, body: { error: 'Token name "WBTC" is already taken' } },
      tokens: [row(stale, "WBTC")],
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", {
        warn: (w) => warnings.push(w),
      });
      expect(r).toMatchObject({ registered: false, reason: "name_taken", existingColour: stale });
      expect(warnings.join()).toMatch(/UNNAMED/);
      expect(warnings.join()).toMatch(/outlived a contract redeploy/);
    } finally {
      m.restore();
    }
  });

  test("409 name-taken with an unreadable registry fails safe", async () => {
    const m = mockRegistry({
      post: { status: 409, body: { error: 'Token name "WBTC" is already taken' } },
      tokens: { status: 500, body: "boom" },
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r).toMatchObject({ registered: false, reason: "name_taken" });
    } finally {
      m.restore();
    }
  });

  test("404 NOT_ENABLED warns and continues", async () => {
    const warnings: string[] = [];
    const m = mockRegistry({
      post: { status: 404, body: { error: "NOT_ENABLED", reason: "Token registry is disabled." } },
    });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", {
        warn: (w) => warnings.push(w),
      });
      expect(r).toMatchObject({ registered: false, reason: "registry_disabled", status: 404 });
      expect(warnings.join()).toMatch(/ENABLE_TOKEN_REGISTRY/);
    } finally {
      m.restore();
    }
  });

  test("an unexpected status is reported, not thrown", async () => {
    const m = mockRegistry({ post: { status: 400, body: { error: "Invalid token color" } } });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r).toMatchObject({ registered: false, reason: "error", status: 400 });
      expect(r.message).toMatch(/Invalid token color/);
    } finally {
      m.restore();
    }
  });

  test("a bare-string error body (the kernel's text fallback) is handled", async () => {
    const m = mockRegistry({ post: { status: 409, body: 'Token name "WBTC" is already taken' } });
    try {
      const r = await registerTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r.reason).toBe("name_taken");
    } finally {
      m.restore();
    }
  });

  test("takes a KernelApi instance as well as a bare base URL", async () => {
    const m = mockRegistry({ post: { status: 200, body: {} } });
    try {
      const r = await registerTokenName(new KernelApi("http://kernel.test:9999/"), PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r.registered).toBe(true);
    } finally {
      m.restore();
    }
  });
});

describe("verifyTokenName", () => {
  test("ok + priced when the pairing holds and the name maps to an asset", async () => {
    const m = mockRegistry({ tokens: [row(PREPROD_WBTC, "WBTC")] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "WBTC");
      expect(v).toMatchObject({
        ok: true,
        priced: true,
        reason: "ok",
        pricedBy: "default_name_map",
        assetId: "bitcoin",
      });
    } finally {
      m.restore();
    }
  });

  test("an explicit asset_id prices a name the default map does not know", async () => {
    const m = mockRegistry({ tokens: [row(PREPROD_WBTC, "TESTTOKEN", { asset_id: "bitcoin" })] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "TESTTOKEN");
      expect(v).toMatchObject({ ok: true, priced: true, pricedBy: "asset_id", assetId: "bitcoin" });
    } finally {
      m.restore();
    }
  });

  test("registered but unpriced when neither path maps the name", async () => {
    const m = mockRegistry({ tokens: [row(PREPROD_WBTC, "TESTTOKEN")] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "TESTTOKEN");
      expect(v).toMatchObject({ ok: true, priced: false, reason: "ok" });
      expect(v.message).toMatch(/UNPRICED/);
    } finally {
      m.restore();
    }
  });

  test("catches the stale-volume case: the name is held by another colour", async () => {
    const stale = "9".repeat(64);
    const m = mockRegistry({ tokens: [row(stale, "WBTC")] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "WBTC");
      expect(v).toMatchObject({ ok: false, priced: false, reason: "name_held_by_other_colour" });
      expect(v.nameHolder?.token_color).toBe(stale);
    } finally {
      m.restore();
    }
  });

  test("catches the other direction: our colour carries a different name", async () => {
    const m = mockRegistry({ tokens: [row(PREPROD_WBTC, "WETH")] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "WBTC");
      // Still priced — as ETHEREUM, which is exactly the trap a presence-only
      // check would miss.
      expect(v).toMatchObject({ ok: false, priced: true, reason: "colour_name_mismatch", assetId: "ethereum" });
    } finally {
      m.restore();
    }
  });

  test("an unregistered colour is not ok and not priced", async () => {
    const m = mockRegistry({ tokens: [] });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "WBTC");
      expect(v).toMatchObject({ ok: false, priced: false, reason: "colour_unregistered" });
    } finally {
      m.restore();
    }
  });

  test("an unreachable registry is reported, not thrown", async () => {
    const m = mockRegistry({ tokens: { status: 500, body: "nope" } });
    try {
      const v = await verifyTokenName(API, PREPROD_WBTC, "WBTC");
      expect(v).toMatchObject({ ok: false, priced: false, reason: "registry_unreachable" });
    } finally {
      m.restore();
    }
  });

  test("matches the colour case-insensitively", async () => {
    const m = mockRegistry({ tokens: [row(PREPROD_WBTC.toUpperCase(), "WBTC")] });
    try {
      expect((await verifyTokenName(API, PREPROD_WBTC, "WBTC")).ok).toBe(true);
    } finally {
      m.restore();
    }
  });
});

describe("registerAndVerifyTokenName", () => {
  test("ready when the pair registers and prices", async () => {
    const m = mockRegistry({
      post: { status: 200, body: { success: true } },
      tokens: [row(PREPROD_WBTC, "WBTC")],
    });
    try {
      const r = await registerAndVerifyTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r.ready).toBe(true);
      expect(r.register.reason).toBe("registered");
      expect(r.verify.reason).toBe("ok");
    } finally {
      m.restore();
    }
  });

  test("not ready when the registry is disabled", async () => {
    const m = mockRegistry({
      post: { status: 404, body: { error: "NOT_ENABLED" } },
      tokens: [],
    });
    try {
      const r = await registerAndVerifyTokenName(API, PREPROD_WBTC, "WBTC", "shielded", quiet);
      expect(r.ready).toBe(false);
      expect(r.register.reason).toBe("registry_disabled");
      expect(r.verify.reason).toBe("colour_unregistered");
    } finally {
      m.restore();
    }
  });
});
