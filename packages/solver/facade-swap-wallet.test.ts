import { describe, expect, test } from "bun:test";

import {
  type SwapFacade,
  swapJobWalletFromFacade,
  type WalletHandleBridge,
  type WalletStage,
} from "./src/facade-swap-wallet.ts";

/** A ledger transaction stand-in: the bridge decides its stage from its bytes. */
interface FakeTx {
  stage: WalletStage;
  name: string;
  serialize(): Uint8Array;
}
const tx = (stage: WalletStage, name: string): FakeTx => ({
  stage,
  name,
  serialize: () => new TextEncoder().encode(`${stage}:${name}`),
});

interface FakeHandle {
  handle: true;
  stage: WalletStage;
  tx: FakeTx;
}

/** Seals only at the transaction's own stage, as the real bridge does (its
 *  decoders refuse bytes of another stage). */
function fakeBridge(log: string[]): WalletHandleBridge {
  return {
    adopt: async (stage, transaction) => {
      const fake = transaction as FakeTx;
      if (fake.stage !== stage) throw new Error(`cannot decode ${fake.name} as ${stage}`);
      log.push(`adopt ${stage} ${fake.name}`);
      return { handle: true, stage, tx: fake } satisfies FakeHandle;
    },
    unwrap: async (handle) => {
      const h = handle as FakeHandle;
      if (h.handle !== true) throw new Error("not a handle");
      log.push(`unwrap ${h.tx.name}`);
      return h.tx;
    },
  };
}

function fakeFacade(log: string[]) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const facade: SwapFacade = {
    shielded: { getAddress: async () => "shielded-address" },
    dust: {
      balanceTransactions: async (transactions, ttl) => {
        record("dust.balanceTransactions", [transactions, ttl]);
        return { transaction: { handle: true, stage: "Unproven", tx: tx("Unproven", "dust-spend") } };
      },
    },
    initSwap: async (...args: unknown[]) => {
      record("initSwap", args);
      return { transaction: { handle: true, stage: "Unproven", tx: tx("Unproven", "swap") } };
    },
    finalizeTransaction: async (...args: unknown[]) => {
      record("finalizeTransaction", args);
      const h = args[0] as FakeHandle;
      return { handle: true, stage: "Finalized", tx: tx("Finalized", `${h.tx.name}-final`) };
    },
    revertTransaction: async (...args: unknown[]) => {
      record("revertTransaction", args);
    },
    revert: async (...args: unknown[]) => {
      record("revert", args);
    },
    state: () => undefined,
  };
  return { facade, calls, log };
}

describe("swapJobWalletFromFacade", () => {
  test("initSwap drops the executor's keys argument and returns the carried ledger transaction", async () => {
    const log: string[] = [];
    const { facade, calls } = fakeFacade(log);
    const wallet = swapJobWalletFromFacade(facade, fakeBridge(log));
    const options = { ttl: new Date(0), payFees: false };
    const result = await wallet.initSwap({ shielded: {} }, [], { secret: "keys" }, options);

    expect(calls["initSwap"]).toEqual([[{ shielded: {} }, [], options]]);
    expect((result.transaction as FakeTx).name).toBe("swap");
    expect(log).toEqual(["unwrap swap"]);
  });

  test("finalizeTransaction seals an unproven ledger transaction and returns the finalized one", async () => {
    const log: string[] = [];
    const { facade, calls } = fakeFacade(log);
    const wallet = swapJobWalletFromFacade(facade, fakeBridge(log));
    const finalized = await wallet.finalizeTransaction(tx("Unproven", "residual"));

    expect((calls["finalizeTransaction"]![0]![0] as FakeHandle).stage).toBe("Unproven");
    expect((finalized as unknown as FakeTx).name).toBe("residual-final");
    expect(log).toEqual(["adopt Unproven residual", "unwrap residual-final"]);
  });

  test("dust balancing drops the DUST key and hands each transaction over at its own stage", async () => {
    const log: string[] = [];
    const { facade, calls } = fakeFacade(log);
    const wallet = swapJobWalletFromFacade(facade, fakeBridge(log));
    const ttl = new Date(1_000);
    const dust = await wallet.dust.balanceTransactions(
      { secret: "dust-key" },
      [tx("Finalized", "maker-merge"), tx("Unproven", "stand-in")],
      ttl,
    );

    const [handles, passedTtl] = calls["dust.balanceTransactions"]![0]! as [FakeHandle[], Date];
    expect(handles.map((h) => [h.stage, h.tx.name])).toEqual([
      ["Finalized", "maker-merge"],
      ["Unproven", "stand-in"],
    ]);
    expect(passedTtl).toBe(ttl);
    expect((dust as FakeTx).name).toBe("dust-spend");
  });

  test("a transaction that decodes at no stage is refused before the facade is called", async () => {
    const log: string[] = [];
    const { facade, calls } = fakeFacade(log);
    const bridge: WalletHandleBridge = {
      adopt: async () => {
        throw new Error("undecodable");
      },
      unwrap: async (handle) => handle,
    };
    const wallet = swapJobWalletFromFacade(facade, bridge);
    await expect(
      wallet.dust.balanceTransactions(null, [tx("Finalized", "x")], new Date(0)),
    ).rejects.toThrow("decodes at none of the wallet stages");
    expect(calls["dust.balanceTransactions"]).toBeUndefined();
  });

  test("rollback seals unproven transactions for revertTransaction and finalized ones for revert", async () => {
    const log: string[] = [];
    const { facade, calls } = fakeFacade(log);
    const wallet = swapJobWalletFromFacade(facade, fakeBridge(log));
    await wallet.revertTransaction(tx("Unproven", "pending"));
    await wallet.revert(tx("Finalized", "contribution"));

    expect((calls["revertTransaction"]![0]![0] as FakeHandle).stage).toBe("Unproven");
    expect((calls["revert"]![0]![0] as FakeHandle).stage).toBe("Finalized");
    // A finalized transaction handed to revertTransaction cannot be sealed as unproven.
    await expect(wallet.revertTransaction(tx("Finalized", "wrong"))).rejects.toThrow(
      "cannot decode wrong as Unproven",
    );
  });

  test("a value without serialize() is refused, not sealed", async () => {
    const log: string[] = [];
    const { facade } = fakeFacade(log);
    const wallet = swapJobWalletFromFacade(facade, fakeBridge(log));
    await expect(wallet.finalizeTransaction({} as never)).rejects.toThrow("serialize()");
  });
});
