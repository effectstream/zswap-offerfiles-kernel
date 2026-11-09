import { Intent, Transaction, type FinalizedTransaction } from "@midnightntwrk/ledger-v9";
import type { Lifecycle } from "@midnightntwrk/wallet-sdk-capabilities";
import {
  DefaultForkSchedule,
  lifecycleTransactionTraits,
  type LifecycleTx,
} from "@midnightntwrk/wallet-sdk-facade";

/**
 * Characterization fixtures for the wallet SDK's public transaction-lifecycle
 * store (wallet-sdk-capabilities `TransactionLifecycleServiceImpl`), read with
 * the facade's own exported `lifecycleTransactionTraits`. RF code may compose
 * only public ledger methods and these public SDK contracts, never a private
 * subpath.
 *
 * Polling is intentionally not exercised: durable serialization and explicit
 * reconciliation are what matter, so the service is only restored, inspected
 * and moved while stopped.
 */

/** The protocol version a chain born on ledger 9 forks at (the facade's preset). */
export const V9_FORK_VERSION = DefaultForkSchedule.v9;

export const lifecycleTraits = lifecycleTransactionTraits(V9_FORK_VERSION);

/** An indexer nobody listens on: the service is never started, so never polled. */
export const OFFLINE_INDEXER = { indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:1" } };

/** A finalized ledger-9 transaction with one (empty) intent, so it has an identifier. */
export function finalizedFixture(): { finalized: FinalizedTransaction; mirror: Transaction<any, any, any> } {
  const mirror = Transaction.fromParts("undeployed", undefined, undefined, Intent.new(new Date(Date.now() + 3_600_000)));
  return { finalized: mirror.mockProve(), mirror };
}

/** What the facade records about a finalized transaction it submitted. */
export function submittedFacts(finalized: FinalizedTransaction): Lifecycle.TransactionFacts<LifecycleTx> {
  return {
    tx: { protocolVersion: V9_FORK_VERSION, transaction: finalized, form: "Finalized" },
    identifiers: finalized.identifiers(),
    intentHashes: [],
    inputs: { unshielded: [] },
    ttl: new Date(Date.now() + 3_600_000),
    protocolVersion: V9_FORK_VERSION,
  };
}

/** The finalized-transaction codec the SDK artifacts are written with. */
export const finalizedCodec = {
  serialize: (tx: FinalizedTransaction): Uint8Array => tx.serialize(),
  deserialize: (bytes: Uint8Array): FinalizedTransaction =>
    Transaction.deserialize("signature", "proof", "binding", bytes),
};
