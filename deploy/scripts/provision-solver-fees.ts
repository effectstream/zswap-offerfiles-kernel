// Inspect externally prefunded solver fee inventory and register existing NIGHT
// for DUST. Pricing comes only from the live Offer Files book; this script never
// writes prices and never funds, transfers, deploys or mints anything.

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
const receiptPath =
  process.env["SOLVER_PROVISION_RECEIPT"] ?? "/srv/solver-provision/provision-receipt.json";

if (!HEX_TOKEN.test(seed)) throw new Error("SOLVER_SEED must be a 64-hex seed");

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
  const receipt = {
    mode: "external-prefunded",
    script: "deploy/scripts/provision-solver-fees.ts",
    measuredAt: new Date().toISOString(),
    network: net.id,
    seedSuffix: seed.slice(-4),
    inventorySource: "external",
    pricingSource: "live-offer-files-book",
    dustReady: dust.dustReady,
    nightPrefunded: true,
    nightBeforeDustRegistrationSpecks: night.toString(),
    solverShielded: Object.fromEntries(Object.entries(shielded).map(([key, value]) => [key, String(value)])),
    solverShieldedNonZeroCount: Object.values(shielded).filter((value) => value !== 0n).length,
    solverUnshielded: Object.fromEntries(
      Object.entries(await unshieldedBalances(solver)).map(([key, value]) => [key, String(value)]),
    ),
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  log(`verified prefunded NIGHT=${night}; wrote ${receiptPath}`);
} finally {
  await (solver.wallet as unknown as { stop?: () => Promise<void> }).stop?.().catch(() => undefined);
}
