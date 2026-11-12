import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_PROOF_REQUEST_TIMEOUT_MS,
  DEFAULT_WALLET_SYNC_TIMEOUT_MS,
  ProofDeadlineError,
  proofRequestTimeoutMs,
  proofServerOrigin,
  WalletTimeoutConfigError,
  walletSyncTimeoutMs,
  walletTimeoutProblems,
  withProofDeadline,
  withProvingDeadline,
} from "./wallet-timeouts.ts";

/** Fail the test, instead of hanging it, when `promise` has not settled in `ms`. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no deadline fired within ${ms} ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PRIOR = {
  sync: process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"],
  proof: process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"],
};
afterEach(() => {
  for (const [name, value] of [
    ["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS", PRIOR.sync],
    ["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS", PRIOR.proof],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("wallet timeout env", () => {
  test("unset or blank: 180 s sync wait and 10 min proof deadline", () => {
    expect(DEFAULT_WALLET_SYNC_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_PROOF_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(walletSyncTimeoutMs({})).toBe(180_000);
    expect(proofRequestTimeoutMs({})).toBe(600_000);
    expect(walletSyncTimeoutMs({ MIDNIGHT_WALLET_SYNC_TIMEOUT_MS: " " })).toBe(180_000);
    expect(walletTimeoutProblems({})).toEqual([]);
  });

  test("a set value replaces the default, and the process environment is the default source", () => {
    expect(walletSyncTimeoutMs({ MIDNIGHT_WALLET_SYNC_TIMEOUT_MS: "3600000" })).toBe(3_600_000);
    expect(proofRequestTimeoutMs({ MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS: "120000" })).toBe(120_000);
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "2400000";
    process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"] = "90000";
    expect(walletSyncTimeoutMs()).toBe(2_400_000);
    expect(proofRequestTimeoutMs()).toBe(90_000);
  });

  test.each(["0", "999", "-1", "1.5", "60s", "abc", "86400001"])(
    "%j is refused, naming the variable",
    (value) => {
      expect(walletTimeoutProblems({ MIDNIGHT_WALLET_SYNC_TIMEOUT_MS: value })).toEqual([
        `MIDNIGHT_WALLET_SYNC_TIMEOUT_MS must be an integer number of milliseconds from 1000 to 86400000 ` +
          `(default 180000), got "${value}"`,
      ]);
      expect(() => walletSyncTimeoutMs({ MIDNIGHT_WALLET_SYNC_TIMEOUT_MS: value })).toThrow(WalletTimeoutConfigError);
      expect(() => proofRequestTimeoutMs({ MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS: value }))
        .toThrow("MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS must be an integer number of milliseconds");
    },
  );
});

describe("proof deadline", () => {
  test("only the proof server's origin is reported", () => {
    expect(proofServerOrigin("http://user:secret@prover.internal:6300/v1?key=abc")).toBe("http://prover.internal:6300");
    expect(proofServerOrigin("not a url")).toBe("<unparseable proof server URL>");
  });

  test("a proof that settles in time passes through, value and error alike", async () => {
    const opts = { proofServerUrl: "http://127.0.0.1:6300", timeoutMs: 1_000 };
    expect(await withProofDeadline(async () => "proven", opts)).toBe("proven");
    await expect(withProofDeadline(async () => { throw new Error("server said no"); }, opts))
      .rejects.toThrow("server said no");
  });

  test("a proof that never settles fails at the deadline, naming the proof server", async () => {
    const started = Date.now();
    let caught: unknown;
    try {
      await within(2_000, withProofDeadline(() => new Promise(() => undefined), {
        proofServerUrl: "http://prover.internal:6300",
        timeoutMs: 50,
      }));
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    expect(caught).toBeInstanceOf(ProofDeadlineError);
    expect((caught as ProofDeadlineError).message).toContain(
      "proof request to http://prover.internal:6300 did not finish within 50 ms (MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS)",
    );
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("without an explicit deadline the environment's applies", async () => {
    process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"] = "1000";
    const started = Date.now();
    await expect(within(3_000, withProofDeadline(() => new Promise(() => undefined), { proofServerUrl: "http://p:1" })))
      .rejects.toThrow("did not finish within 1000 ms");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("a service wrapped for the wallet facade gets the deadline on every prove call, arguments intact", async () => {
    const calls: unknown[][] = [];
    const service = {
      prove: async (...args: unknown[]) => {
        calls.push(args);
        if (args[0] === "hang") return new Promise<never>(() => undefined);
        return `proved ${String(args[0])}`;
      },
    };
    const wrapped = withProvingDeadline(service, { proofServerUrl: "http://prover:6300", timeoutMs: 50 });
    expect(await wrapped.prove("tx-1", 2_000_000)).toBe("proved tx-1");
    await expect(within(2_000, wrapped.prove("hang", 2_000_000))).rejects.toBeInstanceOf(ProofDeadlineError);
    expect(calls).toEqual([["tx-1", 2_000_000], ["hang", 2_000_000]]);
  });
});
