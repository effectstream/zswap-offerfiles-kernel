// The kernel-client wallet waits and proof call against facades whose state
// stream and prover the test controls: the env default of the sync wait, the
// per-call override, the settlement wait's own default, and the proof
// deadline of transferShielded.

import { afterEach, describe, expect, test } from "bun:test";
import * as Rx from "rxjs";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import type { WalletResult } from "@effectstream/midnight-contracts/types";

import { transferShielded, waitForSync, waitForWalletSettlement } from "./wallet.ts";
import { ProofDeadlineError, proofServerOrigin, WalletTimeoutConfigError } from "./wallet-timeouts.ts";

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

/** A facade whose state stream is `states` and whose other members are `extra`. */
const facade = (states: Rx.Observable<unknown>, extra: Record<string, unknown> = {}): WalletResult =>
  ({ wallet: { state: () => states, ...extra } }) as unknown as WalletResult;

const unsynced = { isSynced: false };
const synced = { isSynced: true };

async function rejection(promise: Promise<unknown>): Promise<{ error: unknown; elapsedMs: number }> {
  const started = Date.now();
  try {
    await promise;
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  }
  throw new Error("expected a rejection");
}

describe("waitForSync", () => {
  test("waits up to MIDNIGHT_WALLET_SYNC_TIMEOUT_MS when the call gives no timeout", async () => {
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "1000";
    const { error, elapsedMs } = await rejection(waitForSync(facade(Rx.concat(Rx.of(unsynced), Rx.NEVER))));
    expect(String(error)).toContain("waitForSync timeout after 1000ms");
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("a per-call timeoutMs wins over the environment", async () => {
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "3600000";
    const { error, elapsedMs } = await rejection(waitForSync(facade(Rx.NEVER), { timeoutMs: 50 }));
    expect(String(error)).toContain("waitForSync timeout after 50ms");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("a synced wallet resolves at once, whatever the timeout", async () => {
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "1000";
    await waitForSync(facade(Rx.of(unsynced, synced)));
  });

  test("a malformed MIDNIGHT_WALLET_SYNC_TIMEOUT_MS throws naming it, before any wait", async () => {
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "3m";
    const { error, elapsedMs } = await rejection(waitForSync(facade(Rx.NEVER)));
    expect(error).toBeInstanceOf(WalletTimeoutConfigError);
    expect(String(error)).toContain('MIDNIGHT_WALLET_SYNC_TIMEOUT_MS must be an integer number of milliseconds');
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("waitForWalletSettlement", () => {
  test("keeps its own default: MIDNIGHT_WALLET_SYNC_TIMEOUT_MS does not shorten it", async () => {
    process.env["MIDNIGHT_WALLET_SYNC_TIMEOUT_MS"] = "1000";
    const states = new Rx.Subject<unknown>();
    let settled = false;
    const waiting = waitForWalletSettlement(facade(states), { label: "settlement-default" })
      .finally(() => { settled = true; });
    void waiting.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(settled).toBe(false);
    states.error(new Error("test over"));
    await expect(waiting).rejects.toThrow("test over");
  });
});

describe("transferShielded", () => {
  test("a proof that never returns fails at MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS, naming the proof server", async () => {
    process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"] = "1000";
    let submitted = false;
    const from = facade(Rx.NEVER, {
      transferTransaction: async () => ({ type: "recipe" }),
      finalizeRecipe: () => new Promise(() => undefined),
      submitTransaction: async () => { submitted = true; },
    });
    const { error, elapsedMs } = await rejection(transferShielded(from, "11".repeat(32), 5n, {}));
    expect(error).toBeInstanceOf(ProofDeadlineError);
    expect(String(error)).toContain(
      `proof request to ${proofServerOrigin(midnightNetworkConfig.proofServer)} did not finish within 1000 ms`,
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(950);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(submitted).toBe(false);
  });
});
