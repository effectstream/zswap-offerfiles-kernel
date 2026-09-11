// Give the batcher enough independent dust streams to settle a real workload.
//
// THE MECHANISM (from the ledger, via acedward/midnight-wallet-dust-utxo-example):
// dust registration is ADDRESS-level — `DustRegistration.night_key` →
// `address_delegation`. Every NIGHT UTXO created for a registered owner AFTER
// registration automatically gets its own dust-generation stream, with no
// further transaction. Only UTXOs predating registration must be passed to
// `registerNightUtxosForDustGeneration`, and the SDK "rotates" those —
// consolidating them into at most TWO outputs.
//
// That consolidation is why the batcher starves. It boots, registers its
// pre-existing NIGHT, and is left with ~1–2 NIGHT UTXOs ⇒ ~1–2 concurrent fee
// sources and a dust balance worth about five balancing transactions. Every
// settlement after that waits on regeneration, and the batcher livelocks
// (ISSUES.md #1).
//
// So the fix is not to give the batcher MORE NIGHT in one lump — one big UTXO
// is still one dust stream. It is to give it MANY SEPARATE NIGHT UTXOs, AFTER
// it has registered. Each becomes an independent, concurrently-spendable fee
// source.
//
// Reference measurements (that repo, node 1.0.0): ~7 UTXOs is enough to keep a
// wallet busy; 20 leaves headroom for any slowdown. We default to 20.
//
// The dev batcher now self-splits during startup, so this is a recovery tool,
// not part of the normal run. Run it only AFTER address registration, then
// restart the batcher so the SDK snapshots the new UTXO count:
//   bun run packages/tests/grand-e2e/provision-batcher-dust.ts [count]

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { createKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { buildWallet, shieldedKeys, unshieldedBalances, waitForSync } from "../lib/wallet.ts";
import { sleep } from "./lib/util.ts";

globalThis.WebSocket = WebSocket as any;

const NIGHT = "0".repeat(64);
// The batcher's own seed (packages/batcher/config.ts BATCHER_SEED[0]). We only
// DERIVE its address — never build a wallet on it, since two wallets sharing a
// seed against one node force each other to disconnect.
const BATCHER_SEED = "0000000000000000000000000000000000000000000000000000000000000003";
const COUNT = Number(process.argv[2] ?? 5);
/** Per-UTXO NIGHT, in STARS (1 NIGHT = 1e6 stars).
 *
 *  Size matters more than total. A dust coin's cap is `NIGHT x 5 DUST` and it
 *  fills over ~a week, while balancing reserves an `additionalFeeOverhead`
 *  margin of 3e14 specks PER COIN. A coin from a tiny NIGHT UTXO is therefore
 *  worthless for a long time and fails with "could not balance dust" — the
 *  reference repo calls these "near-worthless dust coins from micro NIGHT
 *  UTXOs", and an earlier version of this script created exactly that by
 *  sending 1 NIGHT each.
 *
 *  5e12 stars = 5,000,000 NIGHT ⇒ cap 2.5e22 specks, which clears the margin
 *  by eight orders of magnitude even when barely matured. 20 of these still
 *  leaves genesis ~1.5e14 stars for its own (tiny: ~715 specks) fees. */
const PER_UTXO = 5_000_000_000_000n;

/** Pure seed → unshielded keystore. No wallet, no sync, so no seed conflict
 *  with the running batcher. */
function keystoreForSeed(seed: string, networkId: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, "hex"));
  if (hd.type !== "seedOk") throw new Error(`HD wallet from seed failed: ${hd.type}`);
  const derived = hd.hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (derived.type !== "keyDerived") throw new Error(`derivation failed: ${derived.type}`);
  return createKeystore((derived as any).key, networkId as any);
}

async function main(): Promise<void> {
  setNetworkId(net.id as any);
  const keystore = keystoreForSeed(BATCHER_SEED, net.id);
  const targetBech32 = keystore.getBech32Address();
  console.log(`batcher unshielded address : ${targetBech32.asString()}`);
  console.log(`provisioning               : ${COUNT} x ${PER_UTXO} NIGHT as SEPARATE UTXOs`);

  const genesis = await buildWallet(net.walletSeed);
  try {
    await waitForSync(genesis, { requireUnshieldedFunds: true });
    const before = (await unshieldedBalances(genesis))[NIGHT] ?? 0n;
    console.log(`genesis NIGHT before       : ${before}`);
    if (before < PER_UTXO * BigInt(COUNT)) {
      throw new Error(`genesis holds ${before} NIGHT, needs ${PER_UTXO * BigInt(COUNT)}`);
    }

    // Decode the Bech32m OBJECT (not its string form) — same call shape as
    // unshieldedAddressObj() in packages/tests/lib/wallet.ts.
    const { UnshieldedAddress } = await import("@midnightntwrk/wallet-sdk-address-format");
    const receiver = UnshieldedAddress.codec.decode(net.id as any, targetBech32 as any);

    // Chunked: one output per UTXO, ≤12 per tx (the node rejects large
    // fan-outs with "Invalid Transaction: Custom error: 170").
    const CHUNK = 12;
    for (let sent = 0; sent < COUNT; sent += CHUNK) {
      const n = Math.min(CHUNK, COUNT - sent);
      const outputs = Array.from({ length: n }, () => ({
        type: NIGHT,
        amount: PER_UTXO,
        receiverAddress: receiver as any,
      }));
      let lastErr: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const recipe = await genesis.wallet.transferTransaction(
            [{ type: "unshielded", outputs } as any],
            shieldedKeys(genesis),
            { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
          );
          const signed = await (genesis.wallet as any).signRecipe(recipe, (p: Uint8Array) =>
            genesis.unshieldedKeystore.signDataAsync(p),
          );
          const finalized = await genesis.wallet.finalizeRecipe(signed);
          await genesis.wallet.submitTransaction(finalized);
          console.log(`  sent ${sent + n}/${COUNT}`);
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          // Chunks after the first spend the previous one's change, which only
          // exists once that tx confirms; the retry self-synchronizes on it.
          await sleep(15_000);
        }
      }
      if (lastErr) throw lastErr;
    }

    console.log(
      `\ndone. Each of those ${COUNT} UTXOs is an independent dust stream, because the\n` +
        `batcher's address was already registered for dust generation at its startup.\n` +
        `Restart the batcher, then verify its slot line:\n` +
        `  [balancing] Wallet 1/1: worker slots: N (M UTXOs, cost=1/tx, cap=…)\n` +
        `M should approach ${COUNT}; N is capped by BATCHER_MAX_SLOTS_PER_WALLET.`,
    );
  } finally {
    await genesis.wallet.stop().catch(() => {});
  }
}

main().catch((e) => {
  console.error("provisioning failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
