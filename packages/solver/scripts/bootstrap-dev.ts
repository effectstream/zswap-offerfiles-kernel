// Generate a solver ladder from externally issued, prefunded token inventory.
//
// Required:
//   SOLVER_TOKEN_A / SOLVER_TOKEN_B  distinct 64-hex token colors
//   SOLVER_SEED                     wallet seed holding both tokens and NIGHT
//
// This script never deploys a contract, mints a token, or transfers funds.

import { writeFile } from "node:fs/promises";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { waitForDustFunds } from "@effectstream/midnight-contracts/wallet-info";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import {
  buildWallet,
  shieldedBalances,
  unshieldedBalances,
  waitForSync,
} from "@zswap-da/solver-core/wallet";

import { SOLVER_LADDER_CONFIG, SOLVER_SEED } from "../env.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const NIGHT = "0".repeat(64);
const MIN_TOKEN_BALANCE = 1_000_000n;
const log = (message: string) => console.log(`[bootstrap] ${message}`);

function requiredColor(name: "SOLVER_TOKEN_A" | "SOLVER_TOKEN_B"): string {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `${name} must be the 64-hex color of an externally issued token. ` +
      "Provide same-chain externally issued inventory for SOLVER_SEED before running this bootstrap.",
    );
  }
  return value;
}

const tokenA = requiredColor("SOLVER_TOKEN_A");
const tokenB = requiredColor("SOLVER_TOKEN_B");
if (tokenA === tokenB) throw new Error("SOLVER_TOKEN_A and SOLVER_TOKEN_B must be distinct");

const solver = await buildWallet(SOLVER_SEED);
try {
  await waitForSync(solver);
  const balances = await shieldedBalances(solver);
  for (const [name, color] of [["SOLVER_TOKEN_A", tokenA], ["SOLVER_TOKEN_B", tokenB]] as const) {
    const available = balances[color] ?? 0n;
    if (available < MIN_TOKEN_BALANCE) {
      throw new Error(
        `${name} inventory is insufficient: wallet has ${available}, needs at least ${MIN_TOKEN_BALANCE}. ` +
        "Prefund SOLVER_SEED with same-chain inventory; local minting is unavailable.",
      );
    }
  }

  const night = (await unshieldedBalances(solver))[NIGHT] ?? 0n;
  if (night <= 0n) {
    throw new Error(
      "SOLVER_SEED has no NIGHT for fees. Prefund it before bootstrap; no local funding fallback runs.",
    );
  }
  let registrationFailure: unknown;
  try {
    await registerNightForDust(solver as never);
  } catch (error) {
    registrationFailure = error;
  }
  try {
    await waitForDustFunds(solver.wallet as never, { timeoutMs: 60_000, waitNonZero: true });
  } catch (error) {
    throw new AggregateError(
      [registrationFailure, error].filter((value) => value !== undefined),
      "SOLVER_SEED has no usable DUST after NIGHT registration; provide same-chain fee inventory before bootstrap",
    );
  }
  log("verified usable DUST from existing NIGHT inventory");

  const levels = [
    { input: "1000", output: "1000" },
    { input: "100000", output: "99000" },
    { input: "1000000", output: "970000" },
  ];
  const config = {
    tokens: { TESTA: tokenA, TESTB: tokenB },
    refPricesUsd: { TESTA: "1", TESTB: "1" },
    pairs: [
      { tokenIn: "TESTA", tokenOut: "TESTB", levels },
      { tokenIn: "TESTB", tokenOut: "TESTA", levels },
    ],
  };
  await writeFile(SOLVER_LADDER_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  log(`wrote ${SOLVER_LADDER_CONFIG} from verified prefunded inventory`);
} finally {
  await (solver.wallet as never as { stop?: () => Promise<void> }).stop?.().catch(() => {});
}
