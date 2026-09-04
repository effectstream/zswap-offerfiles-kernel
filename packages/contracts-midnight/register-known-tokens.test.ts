import { describe, expect, test } from "bun:test";
import { DEFAULT_TOKEN_DECIMALS } from "../solver-core/amount.ts";

import {
  LOCAL_ZSWAP_API,
  registerMintedTokenNames,
  resolveMintApiBase,
  type KnownTokenRegistrationLog,
  type MintedTestTokens,
} from "./register-known-tokens.ts";

const MINTED: MintedTestTokens = {
  shieldedA: "a1".repeat(32),
  shieldedB: "b2".repeat(32),
  unshielded: "c3".repeat(32),
};

interface Call {
  url: string;
  init: RequestInit;
}

function harness(
  respond: (call: Call, index: number) => Response | Promise<Response>,
): {
  fetchImpl: typeof fetch;
  calls: Call[];
  log: KnownTokenRegistrationLog;
  info: string[];
  warnings: string[];
} {
  const calls: Call[] = [];
  const info: string[] = [];
  const warnings: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return await respond(call, calls.length - 1);
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    log: {
      info: (message) => info.push(message),
      warn: (message) => warnings.push(message),
    },
    info,
    warnings,
  };
}

describe("registerMintedTokenNames", () => {
  test("posts the exact v1 URL and all three name/kind/colour payloads with a timeout", async () => {
    const statuses = [201, 204, 299];
    const h = harness((_call, index) => new Response(null, { status: statuses[index] }));

    await registerMintedTokenNames(MINTED, {
      apiBaseUrl: "http://kernel:9999/",
      fetchImpl: h.fetchImpl,
      log: h.log,
      timeoutMs: 1234,
    });

    expect(h.calls).toHaveLength(3);
    expect(h.calls.map((call) => call.url)).toEqual([
      "http://kernel:9999/v1/known-tokens",
      "http://kernel:9999/v1/known-tokens",
      "http://kernel:9999/v1/known-tokens",
    ]);
    expect(h.calls.map((call) => call.init.method)).toEqual(["POST", "POST", "POST"]);
    expect(h.calls.map((call) => call.init.headers)).toEqual([
      { "content-type": "application/json" },
      { "content-type": "application/json" },
      { "content-type": "application/json" },
    ]);
    expect(h.calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { color: MINTED.shieldedA, name: "TestTokenA", kind: "shielded", decimals: DEFAULT_TOKEN_DECIMALS },
      { color: MINTED.shieldedB, name: "TestTokenB", kind: "shielded", decimals: DEFAULT_TOKEN_DECIMALS },
      { color: MINTED.unshielded, name: "TestTokenU", kind: "unshielded", decimals: DEFAULT_TOKEN_DECIMALS },
    ]);
    expect(h.calls.every((call) => call.init.signal instanceof AbortSignal)).toBe(true);
    expect(h.info).toEqual([
      "known-token registered for TestTokenA",
      "known-token registered for TestTokenB",
      "known-token registered for TestTokenU",
    ]);
    expect(h.warnings).toEqual([]);
  });

  test("409, disabled-registry 404, and an unexpected status are observable and non-fatal", async () => {
    const statuses = [409, 404, 503];
    const h = harness((_call, index) => new Response(null, { status: statuses[index] }));

    await registerMintedTokenNames(MINTED, {
      apiBaseUrl: "http://127.0.0.1:9999",
      fetchImpl: h.fetchImpl,
      log: h.log,
    });

    expect(h.calls).toHaveLength(3);
    expect(h.info).toEqual(["known-token already registered for TestTokenA"]);
    expect(h.warnings).toEqual([
      "known-token registry disabled; skipped TestTokenB",
      "known-token registration for TestTokenU returned HTTP 503; continuing",
    ]);
  });

  test("a transport failure logs and later tokens are still processed", async () => {
    const h = harness((_call, index) => {
      if (index === 0) throw new Error("connection refused");
      return new Response(null, { status: 200 });
    });

    await registerMintedTokenNames(MINTED, {
      apiBaseUrl: "http://127.0.0.1:9999",
      fetchImpl: h.fetchImpl,
      log: h.log,
    });

    expect(h.calls).toHaveLength(3);
    expect(h.warnings).toEqual([
      "known-token registration skipped for TestTokenA (connection refused); continuing",
    ]);
    expect(h.info).toEqual([
      "known-token registered for TestTokenB",
      "known-token registered for TestTokenU",
    ]);
  });
});

describe("resolveMintApiBase", () => {
  test("uses and trims the configured ZSWAP_API", () => {
    expect(resolveMintApiBase({ ZSWAP_API: "  http://kernel:9999/  " })).toBe(
      "http://kernel:9999/",
    );
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", " \t "],
  ])("uses local loopback only when ZSWAP_API is %s", (_label, value) => {
    expect(resolveMintApiBase({ ZSWAP_API: value })).toBe(LOCAL_ZSWAP_API);
  });
});
