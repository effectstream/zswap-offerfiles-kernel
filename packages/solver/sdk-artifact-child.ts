import { readFile } from "node:fs/promises";

import { Transaction, ZswapLocalState } from "@midnightntwrk/ledger-v9";
import {
  PendingTransactions,
  PendingTransactionsServiceImpl,
} from "@midnightntwrk/wallet-sdk-capabilities";
import { firstValueFrom } from "rxjs";

import { finalizedTransactionPersistenceTrait } from "./sdk-artifact-test-trait.ts";

interface CharacterizationInput {
  finalizedHex: string;
  mirrorHex: string;
  pendingState: string;
}

const path = process.argv[2];
if (!path) throw new Error("expected characterization input path");

const input = JSON.parse(await readFile(path, "utf8")) as CharacterizationInput;
const finalizedBytes = Uint8Array.fromHex(input.finalizedHex);
const mirrorBytes = Uint8Array.fromHex(input.mirrorHex);

// Both transaction variants use ledger-v9's public, marker-typed codec. The
// restored mirror handle is acted on by a fresh local state, proving that no
// identity/private field from the originating facade is required to revert it.
const finalized = finalizedTransactionPersistenceTrait.deserialize(finalizedBytes);
const mirror = Transaction.deserialize("signature", "pre-proof", "pre-binding", mirrorBytes);
const freshState = new ZswapLocalState().revertTransaction(mirror);

// The pending service has a public versioned restore entrypoint. Do not start
// polling: this characterization is deliberately network-free.
const pending = await PendingTransactionsServiceImpl.restore(
  input.pendingState,
  finalizedTransactionPersistenceTrait,
  { indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:1" } },
);
const restoredState = await firstValueFrom(pending.state());
const restoredTransactions = PendingTransactions.all(restoredState);
await pending.clear(finalized);
const clearedState = await firstValueFrom(pending.state());
await pending.stop();

console.log(JSON.stringify({
  finalizedHex: finalized.serialize().toHex(),
  mirrorHex: mirror.serialize().toHex(),
  revertedStateBytes: freshState.serialize().length,
  restoredPending: restoredTransactions.length,
  pendingCleared: PendingTransactions.all(clearedState).length,
}));
