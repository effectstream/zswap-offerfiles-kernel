import {
  getInitialDustState,
  registerNightForDust,
} from "@effectstream/midnight-contracts";
import type { WalletResult } from "@effectstream/midnight-contracts/types";

const NIGHT = "0".repeat(64);

/** One registered NIGHT output per dev worker slot. */
export const BATCHER_NIGHT_UTXO_TARGET = 5;

/**
 * The SDK requires roughly 0.3 DUST of fee overhead per selected coin. The
 * batching adapter uses 1.5x that value as its own spendability floor; startup
 * must use the same definition or it can announce five slots backed by coins
 * that the capacity gate immediately refuses.
 */
export const DEFAULT_MIN_SPENDABLE_DUST_PER_COIN = 450_000_000_000_000n;

/**
 * A tiny NIGHT output creates a dust stream but takes far too long to become
 * useful. Five million NIGHT per output is the already-measured dev-chain
 * floor used by the old provisioning helper.
 */
const MIN_NIGHT_PER_SPLIT_OUTPUT = 5_000_000_000_000n;

interface UnshieldedCoin {
  utxo?: { type?: unknown; value?: bigint | string | number };
  meta?: { registeredForDustGeneration?: boolean };
}

interface UnshieldedState {
  availableCoins?: readonly UnshieldedCoin[];
}

export interface NightUtxoBootstrapOptions {
  target?: number;
  timeoutMs?: number;
  pollMs?: number;
  minSpendableDustPerCoin?: bigint;
}

export interface NightUtxoBootstrapResult {
  registeredNightUtxos: number;
  spendableDustUtxos: number;
  split: boolean;
}

export interface NightUtxoBootstrapOps {
  readUnshieldedState(walletResult: WalletResult): Promise<UnshieldedState>;
  registerNight(walletResult: WalletResult): Promise<boolean>;
  submitSelfSplit(walletResult: WalletResult, outputCount: number): Promise<void>;
  readDustValues(walletResult: WalletResult): Promise<bigint[]>;
  sleep(ms: number): Promise<void>;
}

function rawTokenType(value: unknown): string {
  return String(value ?? "").replace(/^0x/, "").toLowerCase();
}

function availableNightUtxos(state: UnshieldedState): UnshieldedCoin[] {
  return [...(state.availableCoins ?? [])].filter(
    (coin) => rawTokenType(coin.utxo?.type) === NIGHT,
  );
}

export function countRegisteredNightUtxos(state: UnshieldedState): number {
  return availableNightUtxos(state).filter(
    (coin) => coin.meta?.registeredForDustGeneration === true,
  ).length;
}

async function defaultSubmitSelfSplit(
  walletResult: WalletResult,
  outputCount: number,
): Promise<void> {
  const state = (await (walletResult.wallet as any).unshielded.waitForSyncedState()) as
    UnshieldedState;
  const night = availableNightUtxos(state);
  const total = night.reduce(
    (sum, coin) => sum + BigInt(coin.utxo?.value ?? 0),
    0n,
  );
  const amount = total / BigInt(outputCount + 1);
  if (amount < MIN_NIGHT_PER_SPLIT_OUTPUT) {
    throw new Error(
      `batcher NIGHT bootstrap needs at least ${
        MIN_NIGHT_PER_SPLIT_OUTPUT * BigInt(outputCount + 1)
      } stars to create ${outputCount} fee-capable outputs; wallet has ${total}`,
    );
  }

  const receiverAddress = await (walletResult.wallet as any).unshielded.getAddress();
  const recipe = await walletResult.wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: Array.from({ length: outputCount }, () => ({
          type: NIGHT,
          amount,
          receiverAddress,
        })),
      } as any,
    ],
    {
      shieldedSecretKeys: walletResult.zswapSecretKeys,
      dustSecretKey: walletResult.dustSecretKey,
    },
    { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
  );

  let finalized: any;
  try {
    const signed = await (walletResult.wallet as any).signRecipe(
      recipe,
      (payload: Uint8Array) => walletResult.unshieldedKeystore.signDataAsync(payload),
    );
    finalized = await walletResult.wallet.finalizeRecipe(signed);
    await walletResult.wallet.submitTransaction(finalized);
  } catch (error) {
    await (walletResult.wallet as any).revert(finalized ?? recipe).catch(() => {});
    throw error;
  }
}

const defaultOps: NightUtxoBootstrapOps = {
  readUnshieldedState: async (walletResult) =>
    (await (walletResult.wallet as any).unshielded.waitForSyncedState()) as
      UnshieldedState,
  registerNight: (walletResult) => registerNightForDust(walletResult),
  submitSelfSplit: defaultSubmitSelfSplit,
  readDustValues: async (walletResult) => {
    const state = (await getInitialDustState(
      (walletResult.wallet as any).dust,
      { timeoutMs: 30_000 },
    )) as { availableCoins?: readonly { generatedNow?: bigint | string }[] };
    return (state.availableCoins ?? []).map((coin) =>
      BigInt(coin.generatedNow ?? 0),
    );
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Make the dev batcher wallet's concurrency real before the SDK snapshots its
 * worker count. Registration is address-level, so outputs created by the
 * self-transfer after registration each acquire their own dust stream.
 */
export async function ensureBatcherNightUtxos(
  walletResult: WalletResult,
  options: NightUtxoBootstrapOptions = {},
  ops: NightUtxoBootstrapOps = defaultOps,
): Promise<NightUtxoBootstrapResult> {
  const target = options.target ?? BATCHER_NIGHT_UTXO_TARGET;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 5_000;
  const minSpendable =
    options.minSpendableDustPerCoin ?? DEFAULT_MIN_SPENDABLE_DUST_PER_COIN;
  const deadline = Date.now() + timeoutMs;
  let split = false;

  let state = await ops.readUnshieldedState(walletResult);
  let registered = countRegisteredNightUtxos(state);
  if (registered === 0) {
    const nightCount = availableNightUtxos(state).length;
    if (nightCount === 0) {
      throw new Error("batcher NIGHT bootstrap found no spendable NIGHT UTXOs");
    }
    if (!(await ops.registerNight(walletResult))) {
      throw new Error("batcher NIGHT bootstrap could not register NIGHT for dust");
    }
    state = await ops.readUnshieldedState(walletResult);
    registered = countRegisteredNightUtxos(state);
  }

  if (registered < target) {
    await ops.submitSelfSplit(walletResult, target);
    split = true;
  }

  while (registered < target && Date.now() <= deadline) {
    state = await ops.readUnshieldedState(walletResult);
    registered = countRegisteredNightUtxos(state);
    if (registered < target) await ops.sleep(pollMs);
  }
  if (registered < target) {
    throw new Error(
      `batcher NIGHT bootstrap timed out with ${registered}/${target} registered spendable UTXOs`,
    );
  }

  let spendableDust = 0;
  while (spendableDust < target && Date.now() <= deadline) {
    const values = await ops.readDustValues(walletResult);
    spendableDust = values.filter((value) => value >= minSpendable).length;
    if (spendableDust < target) await ops.sleep(pollMs);
  }
  if (spendableDust < target) {
    throw new Error(
      `batcher NIGHT bootstrap timed out with ${spendableDust}/${target} spendable dust UTXOs`,
    );
  }

  return {
    registeredNightUtxos: registered,
    spendableDustUtxos: spendableDust,
    split,
  };
}
