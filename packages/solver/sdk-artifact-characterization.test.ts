import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Transaction } from "@midnightntwrk/ledger-v9";
import { TransactionLifecycleServiceImpl } from "@midnightntwrk/wallet-sdk-capabilities";

import {
  finalizedCodec,
  finalizedFixture,
  lifecycleTraits,
  OFFLINE_INDEXER,
  submittedFacts,
} from "./sdk-artifact-test-trait.ts";

const CHILD = new URL("./sdk-artifact-child.ts", import.meta.url).pathname;

test("pinned SDK artifacts round-trip and remain actionable in a fresh process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cow-rf1a-sdk-"));
  const inputPath = join(directory, "artifacts.json");
  const { finalized, mirror } = finalizedFixture();
  expect(finalized.identifiers().length).toBeGreaterThan(0);
  const service = await TransactionLifecycleServiceImpl.init({
    txTraits: lifecycleTraits,
    configuration: OFFLINE_INDEXER,
  });

  try {
    await service.submitted(submittedFacts(finalized));
    const lifecycleState = await service.serializeState();
    expect(JSON.parse(lifecycleState)).toMatchObject({ version: "v2" });

    await writeFile(inputPath, JSON.stringify({
      finalizedHex: finalizedCodec.serialize(finalized).toHex(),
      mirrorHex: mirror.serialize().toHex(),
      lifecycleState,
    }));
    await service.stop();

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
      restoredLive: 1,
      restoredState: "Submitted",
      restoredTxHex: finalized.serialize().toHex(),
      liveAfterRevert: 0,
      stateAfterRevert: "Reverted",
    });
  } finally {
    await service.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("pinned SDK restore rejects malformed lifecycle-state and transaction bytes", async () => {
  await expect(
    TransactionLifecycleServiceImpl.restore(
      '{"version":"v9","records":[]}',
      lifecycleTraits,
      OFFLINE_INDEXER,
    ),
  ).rejects.toThrow();
  expect(() => finalizedCodec.deserialize(new Uint8Array([1, 2, 3]))).toThrow();
  expect(() =>
    Transaction.deserialize("signature", "pre-proof", "pre-binding", new Uint8Array([1, 2, 3])),
  ).toThrow();
});
