// Full swap lifecycle folded into the Phase-B runner.
// Infra is already up when this runs (Phase A + migrations + startup mint).
//
// Flow: mint A/B via offer-files helpers → create A↔B offer
//   → /v1/offers → wait for Celestia indexing
//   → balance + settle on Midnight → nullifier consumed → offer ARCHIVED.
//
// Does NOT call mintTestTokens() — that races the orchestrator's
// midnight-mint-test-tokens process (TransactionInvalidError).

import type { Client } from "pg";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "../helpers.ts";
import {
  count,
  nullifiersGrew,
  offerArchivedConsumed,
  waitFor,
} from "../lib/db.ts";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  rawTokenType,
  sampleContractAddress,
  Transaction,
} from "@midnightntwrk/ledger-v9";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { joinOfferFiles, mintShielded } from "../lib/offer-files.ts";
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  waitForShielded,
  waitForSync,
  waitForWalletSettlement,
} from "../lib/wallet.ts";
import { submitOffer } from "../lib/api.ts";
import {
  shieldedContractRecipient,
  shieldedUserRecipient,
  unshieldedUserRecipient,
} from "@zswap-da/contract-offer-files/mint-recipient";

globalThis.WebSocket = WebSocket;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEP = { A: 0xe0, B: 0xe1 } as const;
const MINT_AMOUNT = 1_000_000_000n;
const GIVE_AMOUNT = 500_000n;
const WANT_AMOUNT = 750_000n;
const LEDGER_V9_CONTRACT_OUTPUT_ERROR =
  "a contract-owned coin output was left unclaimed";
const LEDGER_V9_CONTRACT_OUTPUT_NODE_ERROR =
  "1010: Invalid Transaction: Custom error: 218";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function causeChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current =
      typeof current === "object" && current !== null
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return messages.join(" <- ");
}

async function requireRejection(
  label: string,
  expected: string,
  action: () => Promise<unknown>,
): Promise<void> {
  let rejection: unknown;
  try {
    await action();
  } catch (error) {
    rejection = error;
  }
  if (rejection === undefined) {
    throw new Error(`${label}: call unexpectedly succeeded; expected "${expected}"`);
  }
  const chain = causeChain(rejection);
  if (!chain.includes(expected)) {
    throw new Error(
      `${label}: expected full cause chain to include "${expected}", got "${chain}"`,
      { cause: rejection },
    );
  }
}

async function assertPinnedLedgerContractOutputError(): Promise<void> {
  const ledgerEntry = fileURLToPath(
    import.meta.resolve("@midnightntwrk/ledger-v9"),
  );
  const ledgerDir = dirname(ledgerEntry);
  const packageJson = JSON.parse(
    await readFile(resolve(ledgerDir, "package.json"), "utf8"),
  ) as { version?: string };
  if (packageJson.version !== "1.0.0-rc.3") {
    throw new Error(
      `expected the pinned ledger-v9 1.0.0-rc.3 diagnostic mapping, got ${packageJson.version ?? "unknown"}`,
    );
  }
  const ledgerWasm = await readFile(
    resolve(ledgerDir, "midnight_ledger_wasm_v9_bg.wasm"),
  );
  if (!ledgerWasm.includes(LEDGER_V9_CONTRACT_OUTPUT_ERROR)) {
    throw new Error(
      `pinned ledger-v9 WASM is missing exact diagnostic "${LEDGER_V9_CONTRACT_OUTPUT_ERROR}"`,
    );
  }
}

export async function zswapFlowTest(db: Client): Promise<void> {
  setNetworkId(net.id as any);

  const before = {
    known_roots: await count(db, "known_roots"),
    created_unshielded: await count(db, "created_unshielded"),
    nullifiers: await count(db, "nullifiers"),
    offers: await count(db, "offer_file"),
  };
  console.log("[lifecycle] before:", JSON.stringify(before));

  // Startup mint (orchestrator) should have produced UnshieldedCreate events.
  const createdOk = await waitFor(
    "created_unshielded > 0",
    async () => (await count(db, "created_unshielded")) > 0,
    24,
  );
  await assert(
    "created_unshielded populated (UnshieldedCreate primitive live)",
    async () => createdOk,
  );

  console.log("[lifecycle] building genesis wallet + minting A/B…");
  const genesis = await buildWallet(net.walletSeed);

  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    try {
      await registerNightForDust(genesis as any);
    } catch (e) {
      console.warn(
        `[lifecycle] registerNightForDust: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }

    const deployed = await joinOfferFiles(genesis);
    const contractAddress = String(
      (deployed as any).deployTxData?.public?.contractAddress ?? "",
    ).toLowerCase();
    const expectedA = rawTokenType(
      new Uint8Array(32).fill(SEP.A),
      contractAddress,
    ).toLowerCase();
    const expectedB = rawTokenType(
      new Uint8Array(32).fill(SEP.B),
      contractAddress,
    ).toLowerCase();
    const balancesBeforeMint = await shieldedBalances(genesis);
    const balanceABefore = balancesBeforeMint[expectedA] ?? 0n;
    const balanceBBefore = balancesBeforeMint[expectedB] ?? 0n;
    const nonce = BigInt(Date.now());
    const shieldedA = await mintShielded(
      deployed,
      SEP.A,
      MINT_AMOUNT,
      nonce,
      genesis.zswapSecretKeys.coinPublicKey,
    );
    // Same error-170 guard as multi-token: never reuse the facade for a second
    // prove+submit before it has replayed the first.
    await waitForWalletSettlement(genesis, { label: "post-mint-A" });
    const shieldedB = await mintShielded(
      deployed,
      SEP.B,
      MINT_AMOUNT,
      nonce + 1n,
      genesis.zswapSecretKeys.coinPublicKey,
    );
    await waitForWalletSettlement(genesis, { label: "post-mint-B" });

    await assert("genesis wallet holds both minted shielded colors", async () => {
      if (shieldedA !== expectedA) {
        throw new Error(
          `explicit-user mint colour mismatch: expected rawTokenType ${expectedA}, got ${shieldedA}`,
        );
      }
      if (shieldedB !== expectedB) {
        throw new Error(
          `second explicit-user mint colour mismatch: expected rawTokenType ${expectedB}, got ${shieldedB}`,
        );
      }

      const balanceA = await waitForShielded(
        genesis,
        shieldedA,
        balanceABefore + MINT_AMOUNT,
        24,
      );
      if (balanceA - balanceABefore !== MINT_AMOUNT) {
        throw new Error(
          `explicit-user mint balance delta mismatch: requested ${MINT_AMOUNT}, before ${balanceABefore}, settled ${balanceA}`,
        );
      }
      const balanceB = await waitForShielded(
        genesis,
        shieldedB,
        balanceBBefore + MINT_AMOUNT,
        12,
      );
      if (balanceB - balanceBBefore !== MINT_AMOUNT) {
        throw new Error(
          `second explicit-user mint balance delta mismatch: requested ${MINT_AMOUNT}, before ${balanceBBefore}, settled ${balanceB}`,
        );
      }

      // ledger-v9 rc.3's WASM contains the semantic rejection, while its node
      // submission surface reduces that reason to the stable custom code 218.
      // Pin both exact surfaces so this cannot pass on an unrelated failure.
      await assertPinnedLedgerContractOutputError();
      let nonSelfContract = sampleContractAddress();
      while (nonSelfContract.toLowerCase() === contractAddress) {
        nonSelfContract = sampleContractAddress();
      }
      await requireRejection(
        "non-self contract recipient without receive",
        LEDGER_V9_CONTRACT_OUTPUT_NODE_ERROR,
        () =>
          (deployed.callTx as any).mint_shielded(
            new Uint8Array(32).fill(0xe2),
            1n,
            nonce + 2n,
            shieldedContractRecipient(nonSelfContract),
          ),
      );

      await requireRejection(
        "zero shielded mint",
        "mint amount must be positive",
        () =>
          (deployed.callTx as any).mint_shielded(
            new Uint8Array(32).fill(0xe3),
            0n,
            nonce + 3n,
            shieldedUserRecipient(genesis.zswapSecretKeys.coinPublicKey),
          ),
      );

      const parsedUnshielded = MidnightBech32m.parse(
        genesis.unshieldedAddress,
      );
      const userAddress = toHex(
        Uint8Array.prototype.slice.call(parsedUnshielded.data, 0, 32),
      );
      await requireRejection(
        "zero unshielded mint",
        "mint amount must be positive",
        () =>
          (deployed.callTx as any).mint_unshielded(
            new Uint8Array(32).fill(0xe4),
            0n,
            unshieldedUserRecipient(userAddress),
          ),
      );

      return true;
    });

    const address = await genesis.wallet.shielded.getAddress();
    const keys = shieldedKeys(genesis);
    const recipe = await genesis.wallet.initSwap(
      { shielded: { [shieldedA]: GIVE_AMOUNT } },
      [
        {
          type: "shielded",
          outputs: [{ type: shieldedB, amount: WANT_AMOUNT, receiverAddress: address }],
        } as any,
      ],
      keys,
      { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
    );
    const offerFinalized = await genesis.wallet.finalizeTransaction(recipe.transaction);
    const blob = OfferFiles.encode(offerFinalized.serialize());
    console.log(
      `[lifecycle] offer: give ${GIVE_AMOUNT} of A(${shieldedA.slice(0, 8)}…), ` +
        `want ${WANT_AMOUNT} of B(${shieldedB.slice(0, 8)}…)`,
    );

    let sub = await submitOffer(blob);
    for (let r = 0; r < 24 && sub.status === 400 && sub.body?.error === "ROOT_UNKNOWN"; r++) {
      await sleep(5000);
      sub = await submitOffer(blob);
    }
    await assert(
      "offer accepted by submit gate (crypto + liveness + root-known)",
      async () => sub.status === 200,
    );

    const indexedOk = await waitFor(
      "offer indexed",
      async () => (await count(db, "offer_file")) > before.offers,
      24,
    );
    await assert("offer indexed via Celestia → STM ingestion", async () => indexedOk);
    if (!indexedOk) return;

    const offerRow = (
      await db.query<{ id: number }>("SELECT id FROM offer_file ORDER BY id DESC LIMIT 1")
    ).rows[0];
    if (!offerRow) return;

    console.log("[lifecycle] balancing + settling the A↔B offer on Midnight…");
    // The genesis facade just minted and made offers; reusing it for a second
    // prove+submit before it has replayed its own transactions is the exact
    // rc.4 error-170 (InvalidDustSpendProof) trap — see waitForWalletSettlement.
    await waitForWalletSettlement(genesis, { label: "pre-settle" });
    const offerTx = Transaction.deserialize(
      "signature",
      "proof",
      "binding",
      OfferFiles.decode(blob),
    );
    const balRecipe = await (genesis.wallet as any).balanceFinalizedTransaction(
      offerTx,
      keys,
      { ttl: new Date(Date.now() + 30 * 60_000) },
    );
    const settleTx = await genesis.wallet.finalizeRecipe(balRecipe);
    await (genesis.wallet as any).submitTransaction(settleTx);
    console.log(
      "[lifecycle] settle submitted:",
      settleTx.transactionHash?.().toString?.().slice(0, 24) ?? "(tx)",
    );

    const spentOk = await waitFor(
      "nullifiers > before",
      async () => nullifiersGrew(db, before.nullifiers, 1),
      36,
    );
    await assert("nullifiers populated (Nullifier primitive live)", async () => spentOk);

    const archivedOk = await waitFor(
      "offer archived CONSUMED",
      async () => offerArchivedConsumed(db, offerRow.id),
      24,
    );
    await assert("offer ARCHIVED with CONSUMED after settlement", async () => archivedOk);

    const rootsNow = await count(db, "known_roots");
    await assert(
      "known_roots advanced (ZswapRoot primitive live)",
      async () => rootsNow > before.known_roots,
    );

    console.log(
      "[lifecycle] after:",
      JSON.stringify({
        known_roots: await count(db, "known_roots"),
        created_unshielded: await count(db, "created_unshielded"),
        nullifiers: await count(db, "nullifiers"),
      }),
    );
  } finally {
    await genesis.wallet.stop().catch(() => {});
  }
}
