// Adapts a wallet-sdk 2.x `WalletFacade` to the swap-job executor's
// `SwapJobWallet` contract.
//
// The executor works on ledger-v9 transaction objects: it merges them,
// measures their imbalances, serializes them into its journal and hands them
// back for finalization or revert. The facade (wallet-sdk-facade 5.x) instead
// takes and returns sealed `WalletTransaction` handles, stamped with the
// protocol version they were built at, and it holds the secret keys it was
// started with, so none of its transaction builders take keys any more.
//
// This adapter is the one place that crosses between the two: every handle the
// facade returns is unwrapped into the ledger transaction it carries, every
// ledger transaction the executor hands back is adopted into a handle at the
// stage the facade expects, and the key arguments of the executor contract are
// not forwarded.
import { adoptInWallet, unwrapInWallet } from "@effectstream/midnight-contracts";
import type { FinalizedTransaction } from "@midnightntwrk/ledger-v9";

import type { SwapJobWallet } from "./swap-job-executor.ts";

/** The stages a transaction is handed to the wallet at. */
export type WalletStage = "Unproven" | "Unbound" | "Finalized";

/** Seals ledger transactions into facade handles and opens them again. */
export interface WalletHandleBridge {
  /** Seals `transaction` as a handle at `stage`; rejects when its bytes are
   *  not a transaction at that stage. */
  adopt(stage: WalletStage, transaction: { serialize(): Uint8Array }): Promise<unknown>;
  /** The ledger transaction a handle carries. */
  unwrap(handle: unknown): Promise<unknown>;
}

/** The part of the wallet-sdk 2.x facade the swap-job executor drives. */
export interface SwapFacade {
  shielded: { getAddress: () => Promise<unknown> };
  dust: {
    balanceTransactions: (
      transactions: readonly unknown[],
      ttl: Date,
    ) => Promise<{ transaction: unknown }>;
  };
  initSwap: (
    inputs: never,
    outputs: never,
    options: { ttl: Date; payFees: boolean },
  ) => Promise<{ transaction: unknown }>;
  finalizeTransaction: (transaction: never) => Promise<unknown>;
  revertTransaction: (transaction: never) => Promise<void>;
  revert: (transaction: never) => Promise<void>;
  state: () => unknown;
}

/** The bridge `@effectstream/midnight-contracts` provides: handles are sealed
 *  at, and opened within, the protocol version the facade is acting at. */
export function facadeHandleBridge(facade: SwapFacade): WalletHandleBridge {
  const versioned = facade as unknown as Parameters<typeof adoptInWallet>[0];
  return {
    adopt: (stage, transaction) => adoptInWallet(versioned, stage, transaction),
    unwrap: (handle) => unwrapInWallet(versioned, handle as never),
  };
}

/** Stages tried, in order, for a transaction whose stage the caller does not
 *  name. The bytes of a transaction decode at exactly one stage. */
const STAGES_BY_LIKELIHOOD: readonly WalletStage[] = ["Finalized", "Unproven", "Unbound"];

async function adoptAtItsStage(
  bridge: WalletHandleBridge,
  transaction: { serialize(): Uint8Array },
): Promise<unknown> {
  let lastError: unknown;
  for (const stage of STAGES_BY_LIKELIHOOD) {
    try {
      return await bridge.adopt(stage, transaction);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `transaction decodes at none of the wallet stages (${STAGES_BY_LIKELIHOOD.join(", ")})`,
    { cause: lastError },
  );
}

function serializable(transaction: unknown): { serialize(): Uint8Array } {
  if (
    transaction === null ||
    typeof transaction !== "object" ||
    typeof (transaction as { serialize?: unknown }).serialize !== "function"
  ) {
    throw new TypeError("expected a ledger transaction with serialize()");
  }
  return transaction as { serialize(): Uint8Array };
}

/**
 * The executor's wallet, backed by a wallet-sdk 2.x facade.
 *
 * - `initSwap` and `dust.balanceTransactions` return the ledger transaction the
 *   facade's handle carries (an unproven one);
 * - `finalizeTransaction` takes an unproven ledger transaction and returns the
 *   finalized ledger transaction;
 * - `revertTransaction` takes an unproven ledger transaction and `revert` a
 *   finalized one, as the executor's rollback does;
 * - `dust.balanceTransactions` hands the facade each transaction at the stage
 *   its bytes decode at (the executor passes a finalized maker/receipt merge
 *   and an unproven fee-sizing stand-in).
 */
export function swapJobWalletFromFacade(
  facade: SwapFacade,
  bridge: WalletHandleBridge = facadeHandleBridge(facade),
): SwapJobWallet {
  return {
    shielded: facade.shielded,
    dust: {
      balanceTransactions: async (_dustSecretKey, transactions, ttl) => {
        const handles = [];
        for (const transaction of transactions) {
          handles.push(await adoptAtItsStage(bridge, serializable(transaction)));
        }
        const balanced = await facade.dust.balanceTransactions(handles, ttl);
        return bridge.unwrap(balanced.transaction);
      },
    },
    initSwap: async (inputs, outputs, _keys, options) => {
      const recipe = await facade.initSwap(inputs as never, outputs as never, options);
      return { transaction: await bridge.unwrap(recipe.transaction) };
    },
    finalizeTransaction: async (transaction) => {
      const handle = await bridge.adopt("Unproven", serializable(transaction));
      const finalized = await facade.finalizeTransaction(handle as never);
      return (await bridge.unwrap(finalized)) as FinalizedTransaction;
    },
    revertTransaction: async (transaction) => {
      await facade.revertTransaction(
        (await bridge.adopt("Unproven", serializable(transaction))) as never,
      );
    },
    revert: async (transaction) => {
      await facade.revert((await bridge.adopt("Finalized", serializable(transaction))) as never);
    },
  };
}
