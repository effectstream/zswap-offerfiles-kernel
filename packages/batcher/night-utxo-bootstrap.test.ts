import { describe, expect, test } from "bun:test";

import {
  BATCHER_NIGHT_UTXO_TARGET,
  countRegisteredNightUtxos,
  ensureBatcherNightUtxos,
} from "./night-utxo-bootstrap.ts";
import { defaultMaxSlotsPerWallet } from "./config.ts";

const NIGHT = "0".repeat(64);

function coin(value: bigint, registeredForDustGeneration = true, type = NIGHT) {
  return {
    utxo: { value, type },
    meta: { registeredForDustGeneration },
  };
}

describe("batcher NIGHT UTXO bootstrap", () => {
  test("the dev stack defaults to five slots without changing deployed defaults", () => {
    expect(defaultMaxSlotsPerWallet("undeployed")).toBe(5);
    expect(defaultMaxSlotsPerWallet("preview")).toBe(1);
    expect(defaultMaxSlotsPerWallet("mainnet")).toBe(1);
  });

  test("counts only available, registered NIGHT UTXOs", () => {
    expect(
      countRegisteredNightUtxos({
        availableCoins: [
          coin(1n),
          coin(2n, false),
          coin(3n, true, "f".repeat(64)),
          coin(4n),
        ],
      }),
    ).toBe(2);
  });

  test("self-splits when genesis supplies fewer than five and waits for five spendable dust streams", async () => {
    let nightCount = 1;
    let dustPoll = 0;
    const splitOutputCounts: number[] = [];

    const result = await ensureBatcherNightUtxos(
      {} as any,
      {
        target: BATCHER_NIGHT_UTXO_TARGET,
        timeoutMs: 1_000,
        pollMs: 0,
        minSpendableDustPerCoin: 10n,
      },
      {
        readUnshieldedState: async () => ({
          availableCoins: Array.from({ length: nightCount }, () => coin(100n)),
        }),
        registerNight: async () => true,
        submitSelfSplit: async (_wallet, outputCount) => {
          splitOutputCounts.push(outputCount);
          nightCount = outputCount;
        },
        readDustValues: async () => {
          dustPoll++;
          return dustPoll === 1 ? [10n, 10n] : [10n, 10n, 10n, 10n, 10n];
        },
        sleep: async () => {},
      },
    );

    expect(splitOutputCounts).toEqual([5]);
    expect(result.registeredNightUtxos).toBe(5);
    expect(result.spendableDustUtxos).toBe(5);
    expect(result.split).toBe(true);
  });

  test("does not mutate a wallet that already has five registered NIGHT UTXOs", async () => {
    let split = false;
    const result = await ensureBatcherNightUtxos(
      {} as any,
      {
        target: BATCHER_NIGHT_UTXO_TARGET,
        timeoutMs: 1_000,
        pollMs: 0,
        minSpendableDustPerCoin: 10n,
      },
      {
        readUnshieldedState: async () => ({
          availableCoins: Array.from({ length: 5 }, () => coin(100n)),
        }),
        registerNight: async () => true,
        submitSelfSplit: async () => {
          split = true;
        },
        readDustValues: async () => [10n, 10n, 10n, 10n, 10n],
        sleep: async () => {},
      },
    );

    expect(split).toBe(false);
    expect(result).toEqual({
      registeredNightUtxos: 5,
      spendableDustUtxos: 5,
      split: false,
    });
  });
});
