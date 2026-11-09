import { readFile } from "node:fs/promises";

import { Transaction, ZswapLocalState } from "@midnightntwrk/ledger-v9";
import { Lifecycle, TransactionLifecycleServiceImpl } from "@midnightntwrk/wallet-sdk-capabilities";
import { firstValueFrom } from "rxjs";

import { finalizedCodec, lifecycleTraits, OFFLINE_INDEXER } from "./sdk-artifact-test-trait.ts";

interface CharacterizationInput {
  finalizedHex: string;
  mirrorHex: string;
  lifecycleState: string;
}

const path = process.argv[2];
if (!path) throw new Error("expected characterization input path");

const input = JSON.parse(await readFile(path, "utf8")) as CharacterizationInput;
const finalizedBytes = Uint8Array.fromHex(input.finalizedHex);
const mirrorBytes = Uint8Array.fromHex(input.mirrorHex);

// Both transaction variants use ledger-v9's public, marker-typed codec. The
// restored mirror handle is acted on by a fresh local state, proving that no
// identity/private field from the originating facade is required to revert it.
const finalized = finalizedCodec.deserialize(finalizedBytes);
const mirror = Transaction.deserialize("signature", "pre-proof", "pre-binding", mirrorBytes);
const freshState = new ZswapLocalState().revertTransaction(mirror);

// The lifecycle store has a public versioned restore entrypoint. Do not start
// polling: this characterization is deliberately network-free.
const service = await TransactionLifecycleServiceImpl.restore(
  input.lifecycleState,
  lifecycleTraits,
  OFFLINE_INDEXER,
);
const restored = await firstValueFrom(service.state());
const restoredRecord = restored.records[0];
const restoredTx = restoredRecord?.tx._tag === "Some" ? restoredRecord.tx.value.transaction : undefined;
await service.reverted([...finalized.identifiers()]);
const moved = await firstValueFrom(service.state());
await service.stop();

console.log(JSON.stringify({
  finalizedHex: finalized.serialize().toHex(),
  mirrorHex: mirror.serialize().toHex(),
  revertedStateBytes: freshState.serialize().length,
  restoredLive: restored.records.filter(Lifecycle.isLive).length,
  restoredState: restoredRecord?.state._tag,
  restoredTxHex: restoredTx?.serialize().toHex(),
  liveAfterRevert: moved.records.filter(Lifecycle.isLive).length,
  stateAfterRevert: moved.records[0]?.state._tag,
}));
