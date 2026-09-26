import {
  Transaction,
  type FinalizedTransaction,
} from "@midnightntwrk/ledger-v9";
import type { PendingTransactions } from "@midnightntwrk/wallet-sdk-capabilities";

/**
 * Characterization-only implementation of the capabilities package's public
 * transaction-trait contract. The facade 4.1.0 package uses an equivalent
 * internal trait, but does not export it at runtime despite shipping its
 * declaration file. RF code must therefore compose only these public ledger
 * methods and the public generic trait contract, never a private subpath.
 *
 * Polling is intentionally not exercised: RF1 needs durable serialization and
 * explicit reconciliation, so this trait is used only to restore, inspect,
 * and clear a stopped pending service.
 */
export const finalizedTransactionPersistenceTrait:
PendingTransactions.TransactionTrait<FinalizedTransaction> = {
  ids: (tx) => tx.identifiers(),
  firstId: (tx) => tx.identifiers()[0] ?? tx.transactionHash(),
  areAllTxIdsIncluded: (tx, txIds) => {
    const expected = new Set(txIds);
    return tx.identifiers().every((id) => expected.has(id));
  },
  isOneIncludedInOther: (tx, other) => {
    const ids = new Set(tx.identifiers());
    return other.identifiers().some((id) => ids.has(id));
  },
  hasTTLExpired: () => false,
  serialize: (tx) => tx.serialize(),
  deserialize: (bytes) => Transaction.deserialize("signature", "proof", "binding", bytes),
  isTx: (value): value is FinalizedTransaction => value instanceof Transaction,
};
