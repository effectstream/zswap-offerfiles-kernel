import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Transaction } from "@midnight-ntwrk/ledger-v8";
import {
  PendingTransactions,
  PendingTransactionsServiceImpl,
} from "@midnightntwrk/wallet-sdk-capabilities";
import { firstValueFrom } from "rxjs";

import { finalizedTransactionPersistenceTrait } from "./sdk-artifact-test-trait.ts";

const CHILD = new URL("./sdk-artifact-child.ts", import.meta.url).pathname;

test("pinned SDK artifacts round-trip and remain actionable in a fresh process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cow-rf1a-sdk-"));
  const inputPath = join(directory, "artifacts.json");
  const mirror = Transaction.fromParts("undeployed");
  const finalized = mirror.mockProve();
  const pending = await PendingTransactionsServiceImpl.init({
    txTrait: finalizedTransactionPersistenceTrait,
    configuration: { indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:1" } },
  });

  try {
    await pending.addPendingTransaction(finalized);
    const pendingState = PendingTransactions.serialize(
      await firstValueFrom(pending.state()),
      finalizedTransactionPersistenceTrait,
    );
    expect(JSON.parse(pendingState)).toMatchObject({ version: "v1" });

    await writeFile(inputPath, JSON.stringify({
      finalizedHex: finalizedTransactionPersistenceTrait.serialize(finalized).toHex(),
      mirrorHex: mirror.serialize().toHex(),
      pendingState,
    }));
    await pending.stop();

    const child = Bun.spawn([process.execPath, CHILD, inputPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      finalizedHex: finalized.serialize().toHex(),
      mirrorHex: mirror.serialize().toHex(),
      revertedStateBytes: expect.any(Number),
      restoredPending: 1,
      pendingCleared: 0,
    });
  } finally {
    await pending.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("pinned SDK restore rejects malformed pending-state and transaction bytes", async () => {
  await expect(
    PendingTransactionsServiceImpl.restore(
      '{"version":"v2","transactions":[]}',
      finalizedTransactionPersistenceTrait,
      { indexerClientConnection: { indexerHttpUrl: "http://127.0.0.1:1" } },
    ),
  ).rejects.toThrow();
  expect(() => finalizedTransactionPersistenceTrait.deserialize(new Uint8Array([1, 2, 3]))).toThrow();
  expect(() =>
    Transaction.deserialize("signature", "pre-proof", "pre-binding", new Uint8Array([1, 2, 3])),
  ).toThrow();
});
