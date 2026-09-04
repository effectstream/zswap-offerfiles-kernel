// provision-solver-fees.ts — give the solver FEE CURRENCY ONLY (00006 SC-004).
//
// The counterpart to `packages/solver/scripts/bootstrap-dev.ts`, which is kept
// unchanged as the funded control. Both are run by the same `solver-provision`
// one-shot; `SOLVER_PROVISION_MINT_TOKENS` chooses between them.
//
// WHAT THIS DOES
//   1. funds the solver's NIGHT from genesis (same four large UTXOs — a dust
//      coin's capacity is tied to the size of the NIGHT UTXO backing it);
//   2. registers NIGHT for dust;
//   3. writes the ladder config with THIS stack's real token colors, read from
//      the post-kernel mint one-shot's `minted-tokens.json` rather than
//      derived by minting;
//   4. writes a machine-readable RECEIPT of the solver wallet's balances as
//      measured right here, with the facade, at the moment provisioning ended.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It mints the solver NOTHING. Not tokenIn, not tokenOut, not any other
//   color. Since 00006 fee sizing models the taker half with a fabricated
//   transaction instead of spending real tokenIn, and a whole-maker rung is
//   paid by the maker offers it consumes — so a solver holding zero of every
//   swap token can publish and settle whole-rung jobs. Proving that at the real
//   chain boundary is this script's whole reason to exist.
//
// WHY THE RECEIPT
//   The E2E driver must be able to assert "the solver received no token
//   provisioning" as an OBSERVATION rather than a configuration claim, and it
//   cannot open the solver's wallet itself: the solver service holds a live
//   facade on SOLVER_SEED by then, and two facades on one seed against one node
//   force each other's connection down. This process is the only one entitled
//   to look, so it looks, and records what it saw.
//
// Run with the solver stopped — Compose enforces that (`solver` waits on this
// one-shot's `service_completed_successfully`).
//
// DEVNET ONLY: it moves genesis NIGHT to a public dev seed on a throwaway chain.

import { writeFileSync } from "node:fs";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

// RELATIVE first-party imports: `deploy/` is not a bun workspace member, so
// `@zswap-da/*` does not resolve from here. See lib/maker-offer.ts's header.
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  unshieldedAddressObj,
  unshieldedBalances,
  waitForSync,
} from "../../packages/solver-core/wallet.ts";
import { resolveMintedTokens } from "./lib/maker-offer.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const log = (msg: string) => console.log(`[provision-fees] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NIGHT = "0".repeat(64);
/** Identical to bootstrap-dev.ts: a dust coin's capacity is tied to the size of
 *  the NIGHT UTXO backing it, so a few large UTXOs are usable immediately where
 *  many tiny ones are worthless for days. */
const NIGHT_PER_UTXO = 5_000_000_000_000n;
const NIGHT_UTXO_COUNT = 4;

const SOLVER_SEED = process.env["SOLVER_SEED"] ?? "";
const LADDER_CONFIG =
  process.env["SOLVER_LADDER_CONFIG"] ?? "/srv/solver-config/ladders.dev.json";
const RECEIPT_PATH =
  process.env["SOLVER_PROVISION_RECEIPT"] ?? "/srv/solver-config/provision-receipt.json";
const MINTED_FILE =
  process.env["MINTED_TOKENS_FILE"] ?? "/srv/offerfiles-deploy/minted-tokens.json";

if (!/^[0-9a-f]{64}$/.test(SOLVER_SEED)) {
  log("SOLVER_SEED must be a 64-hex seed");
  process.exit(78); // EX_CONFIG
}

// The colors this stack minted TO GENESIS. Reading them is not provisioning:
// nothing is transferred to the solver here, the names are simply what the
// ladder config and the driver have to agree on.
const minted = resolveMintedTokens({ file: MINTED_FILE });
log(`this stack's colors: shieldedA=${minted.give.slice(0, 12)}… shieldedB=${minted.want.slice(0, 12)}…`);

const solver = await buildWallet(SOLVER_SEED);
let exitCode = 1;
try {
  await waitForSync(solver);
  log(`solver wallet synced (seed …${SOLVER_SEED.slice(-4)})`);

  const beforeShielded = await shieldedBalances(solver);
  const beforeNight = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
  log(`solver BEFORE: NIGHT=${beforeNight} shielded=${JSON.stringify(
    Object.fromEntries(Object.entries(beforeShielded).map(([k, v]) => [k, String(v)])),
  )}`);

  // ── 1. NIGHT ───────────────────────────────────────────────────────────────
  if (beforeNight < NIGHT_PER_UTXO) {
    log(`solver holds ${beforeNight} NIGHT — funding from genesis`);
    const genesis = await buildWallet(net.walletSeed);
    try {
      await waitForSync(genesis, { requireUnshieldedFunds: true });
      const available = (await unshieldedBalances(genesis))[NIGHT] ?? 0n;
      const needed = NIGHT_PER_UTXO * BigInt(NIGHT_UTXO_COUNT);
      if (available < needed) throw new Error(`genesis holds ${available} NIGHT, needs ${needed}`);

      const receiver = unshieldedAddressObj(solver);
      const outputs = Array.from({ length: NIGHT_UTXO_COUNT }, () => ({
        type: NIGHT,
        amount: NIGHT_PER_UTXO,
        receiverAddress: receiver as never,
      }));

      let lastErr: unknown;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const recipe = await genesis.wallet.transferTransaction(
            [{ type: "unshielded", outputs } as never],
            shieldedKeys(genesis),
            { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
          );
          const signed = await (genesis.wallet as never as {
            signRecipe: (r: unknown, s: (p: Uint8Array) => unknown) => Promise<unknown>;
          }).signRecipe(recipe, (p: Uint8Array) => genesis.unshieldedKeystore.signData(p));
          await genesis.wallet.submitTransaction(
            await genesis.wallet.finalizeRecipe(signed as never),
          );
          lastErr = undefined;
          break;
        } catch (err) {
          // A transfer spends the previous one's change, which only exists once
          // that transaction confirms; retrying self-synchronises on it.
          lastErr = err;
          log(`  NIGHT transfer attempt ${attempt + 1} failed: ${String(err).slice(0, 180)}`);
          await sleep(15_000);
        }
      }
      if (lastErr) throw lastErr;
      log(`sent ${NIGHT_UTXO_COUNT} x ${NIGHT_PER_UTXO} NIGHT to the solver`);
    } finally {
      await (genesis.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
    }

    for (let i = 0; i < 36; i++) {
      if (((await unshieldedBalances(solver))[NIGHT] ?? 0n) >= NIGHT_PER_UTXO) break;
      await sleep(5_000);
    }
  }

  // The funding fact, measured on a CONFIRMED balance and BEFORE dust
  // registration touches those UTXOs. This — not the post-registration reading
  // below — is what the driver asserts the solver was given fee currency on.
  const nightBeforeDustRegistration = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
  log(`solver NIGHT before dust registration: ${nightBeforeDustRegistration}`);

  // ── 2. dust ────────────────────────────────────────────────────────────────
  await registerNightForDust(solver as never);
  log("registered NIGHT for dust");

  // Registration SPENDS the unregistered NIGHT UTXOs and re-creates them
  // registered, so for a few seconds after it returns the wallet's unshielded
  // view can legitimately read 0 — measured: 20000000000000 on one run of this
  // exact script and 0 on the next, with `Dust wallet balance` above 1.7e18 on
  // both. Wait for the view to come back rather than recording the trough, but
  // do not fail on it: the funding fact above is already measured, and the
  // registration's own success is the dust fact.
  let nightAfterDustRegistration = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
  for (let i = 0; i < 24 && nightAfterDustRegistration === 0n; i++) {
    await sleep(5_000);
    nightAfterDustRegistration = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
  }
  log(`solver NIGHT after dust registration: ${nightAfterDustRegistration}`);

  // ── 3. ladder config, from the PUBLISHED colors (no mint) ──────────────────
  // Publication derives from the mirrored maker book and ignores this file, but
  // the direct-fill engine's `ladders.maxPayout()` does not, and the solver
  // reads the path unconditionally. Same curve as bootstrap-dev.ts so the two
  // provisioning modes differ in exactly one thing: the inventory.
  const levels = [
    { input: "1000", output: "1000" },
    { input: "100000", output: "99000" },
    { input: "1000000", output: "970000" },
  ];
  const config = {
    tokens: { TESTA: minted.give, TESTB: minted.want },
    refPricesUsd: { TESTA: "1", TESTB: "1" },
    pairs: [
      { tokenIn: "TESTA", tokenOut: "TESTB", levels },
      { tokenIn: "TESTB", tokenOut: "TESTA", levels },
    ],
  };
  writeFileSync(LADDER_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  log(`wrote ${LADDER_CONFIG} (colors read from ${MINTED_FILE}, nothing minted)`);

  // ── 4. the receipt — the measurement the driver asserts on ─────────────────
  const afterShieldedRaw = await shieldedBalances(solver);
  const afterShielded = Object.fromEntries(
    Object.entries(afterShieldedRaw).map(([k, v]) => [k, String(v)]),
  );
  const afterUnshielded = Object.fromEntries(
    Object.entries(await unshieldedBalances(solver)).map(([k, v]) => [k, String(v)]),
  );
  const nonZeroShielded = Object.entries(afterShieldedRaw).filter(([, v]) => v !== 0n);

  const receipt = {
    mode: "fee-currency-only",
    script: "deploy/scripts/provision-solver-fees.ts",
    measuredAt: new Date().toISOString(),
    network: net.id,
    seedSuffix: SOLVER_SEED.slice(-4),
    /** Empty BY CONSTRUCTION: this script has no mint or transfer of any
     *  shielded color in it. Listed so the assertion is over data. */
    mintedTokens: [] as string[],
    tokensTransferredToSolver: [] as string[],
    dustRegistered: true,
    nightFunded: nightBeforeDustRegistration > 0n,
    /** The funding measurement the driver asserts on: a CONFIRMED unshielded
     *  NIGHT balance, read before dust registration spent those UTXOs. */
    nightBeforeDustRegistrationSpecks: nightBeforeDustRegistration.toString(),
    /** Informational. Can legitimately read 0 for a few seconds after
     *  registration — see the comment at the poll above. */
    nightAfterDustRegistrationSpecks: nightAfterDustRegistration.toString(),
    solverShielded: afterShielded,
    solverUnshielded: afterUnshielded,
    solverShieldedNonZeroCount: nonZeroShielded.length,
    stackColors: { shieldedA: minted.give, shieldedB: minted.want },
    ladderConfig: LADDER_CONFIG,
  };
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  log(`wrote ${RECEIPT_PATH}`);
  log(`solver AFTER: NIGHT=${afterUnshielded[NIGHT] ?? "0"} shielded=${JSON.stringify(afterShielded)}`);

  // Fail LOUDLY rather than let a stack claim an unfunded-solver proof it did
  // not run. If any swap token is present the premise of SC-004 is already
  // broken — most likely a re-used chain volume from a funded run.
  if (nonZeroShielded.length > 0) {
    log("ERROR: the solver wallet holds swap tokens, so this is NOT an unfunded solver:");
    for (const [color, amount] of nonZeroShielded) log(`ERROR:   ${color} = ${amount}`);
    log("ERROR: tear the stack down (deploy/down.sh removes the chain-keyed volumes) and retry.");
    exitCode = 1;
  } else {
    log("solver holds ZERO of every shielded token — fee currency only, as intended");
    exitCode = 0;
  }
} catch (err) {
  log(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  exitCode = 1;
} finally {
  await (solver.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
}
process.exit(exitCode);
