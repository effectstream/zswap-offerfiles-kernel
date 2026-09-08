// Inspect externally prefunded solver inventory, register existing NIGHT for
// DUST, and write a ladder for two explicit token IDs. This script never funds,
// transfers, deploys or mints anything.

import { writeFileSync } from "node:fs";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import {
  buildWallet,
  shieldedBalances,
  unshieldedBalances,
  waitForSync,
} from "../../packages/solver-core/wallet.ts";
import { ensureSolverDustReady } from "./lib/solver-provision.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

const log = (message: string): void => console.log(`[provision-external] ${message}`);
const HEX_TOKEN = /^[0-9a-f]{64}$/;
const NIGHT = "0".repeat(64);

function required(name: string): string {
  const value = (process.env[name] ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const seed = required("SOLVER_SEED");
const tokenIn = required("SOLVER_PROVISION_TOKEN_IN");
const tokenOut = required("SOLVER_PROVISION_TOKEN_OUT");
const ladderPath = process.env["SOLVER_LADDER_CONFIG"] ?? "/srv/solver-config/ladders.dev.json";
const receiptPath =
  process.env["SOLVER_PROVISION_RECEIPT"] ?? "/srv/solver-config/provision-receipt.json";

if (!HEX_TOKEN.test(seed)) throw new Error("SOLVER_SEED must be a 64-hex seed");
if (!HEX_TOKEN.test(tokenIn)) throw new Error("SOLVER_PROVISION_TOKEN_IN must be a 64-hex token ID");
if (!HEX_TOKEN.test(tokenOut)) throw new Error("SOLVER_PROVISION_TOKEN_OUT must be a 64-hex token ID");
if (tokenIn === tokenOut) throw new Error("SOLVER_PROVISION_TOKEN_IN and SOLVER_PROVISION_TOKEN_OUT must differ");
if (tokenIn === NIGHT || tokenOut === NIGHT) {
  throw new Error("solver pair token IDs must be shielded assets; native NIGHT is not a swap leg");
}

const solver = await buildWallet(seed);
try {
  await waitForSync(solver);
  const unshieldedBefore = await unshieldedBalances(solver);
  const night = unshieldedBefore[NIGHT] ?? 0n;
  if (night <= 0n) {
    throw new Error(
      `SOLVER_SEED has no NIGHT. Prefund it externally on ${net.id}; this deployment cannot fund the wallet`,
    );
  }

  const dust = await ensureSolverDustReady(() => registerNightForDust(solver as never));
  log("verified usable DUST from externally prefunded NIGHT (new or existing registration)");

  const shielded = await shieldedBalances(solver);
  const levels = [
    { input: "1000", output: "1000" },
    { input: "100000", output: "99000" },
    { input: "1000000", output: "970000" },
  ];
  const config = {
    tokens: { TOKEN_IN: tokenIn, TOKEN_OUT: tokenOut },
    refPricesUsd: { TOKEN_IN: "1", TOKEN_OUT: "1" },
    pairs: [
      { tokenIn: "TOKEN_IN", tokenOut: "TOKEN_OUT", levels },
      { tokenIn: "TOKEN_OUT", tokenOut: "TOKEN_IN", levels },
    ],
  };
  writeFileSync(ladderPath, `${JSON.stringify(config, null, 2)}\n`);

  const receipt = {
    mode: "external-prefunded",
    script: "deploy/scripts/provision-solver-fees.ts",
    measuredAt: new Date().toISOString(),
    network: net.id,
    seedSuffix: seed.slice(-4),
    tokenIn,
    tokenOut,
    inventorySource: "external",
    dustReady: dust.dustReady,
    nightPrefunded: true,
    nightBeforeDustRegistrationSpecks: night.toString(),
    solverShielded: Object.fromEntries(Object.entries(shielded).map(([key, value]) => [key, String(value)])),
    solverShieldedNonZeroCount: Object.values(shielded).filter((value) => value !== 0n).length,
    solverUnshielded: Object.fromEntries(
      Object.entries(await unshieldedBalances(solver)).map(([key, value]) => [key, String(value)]),
    ),
    ladderConfig: ladderPath,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  log(`verified prefunded NIGHT=${night}; wrote ${ladderPath} and ${receiptPath}`);
} finally {
  await (solver.wallet as unknown as { stop?: () => Promise<void> }).stop?.().catch(() => undefined);
}
