// Child-process body for ../proof-deadline.test.ts: builds the offer poster's
// pinned-coin wallet facade (the real `buildPinnedWallet`) against a proof
// server URL the parent controls, then asks the facade's own proving service
// to prove a real unproven ledger-9 transaction (one shielded output, so one
// proof). The indexer and node point at a closed local port, so the wallets'
// background sync only logs connection errors. Prints one RESULT line.
//
// A child process because the wallet SDK starts background sync fibres and
// `@effectstream/midnight-contracts` installs a process-wide unhandled-rejection
// handler; neither should run inside the shared test process.

import {
  createShieldedCoinInfo,
  Transaction,
  ZswapOffer,
  ZswapOutput,
  ZswapSecretKeys,
} from "@midnightntwrk/ledger-v9";

import { buildPinnedWallet } from "../pinned-wallet.ts";

const proofServer = process.env["TEST_PROOF_SERVER_URL"] ?? "";
const closedPort = process.env["TEST_CLOSED_PORT"] ?? "1";
const deadlineRaw = process.env["TEST_PROOF_DEADLINE_MS"];
// The fork version every new transaction is stamped with on a ledger-9 chain.
const LEDGER_9_PROTOCOL_VERSION = 2_000_000;

const local = `127.0.0.1:${closedPort}`;
const wallet: any = await buildPinnedWallet(
  "ab".repeat(32),
  {
    id: "undeployed",
    indexer: `http://${local}/api/v4/graphql`,
    indexerWS: `ws://${local}/api/v4/graphql/ws`,
    node: `http://${local}`,
    proofServer,
  } as never,
  "undeployed" as never,
  "all",
  undefined,
  deadlineRaw === undefined ? undefined : { proofRequestTimeoutMs: Number(deadlineRaw) },
);

const keys = ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(7));
const colour = "11".repeat(32);
const output = ZswapOutput.new(createShieldedCoinInfo(colour, 5n), 0, keys.coinPublicKey, keys.encryptionPublicKey);
const unproven = Transaction.fromParts("undeployed", ZswapOffer.fromOutput(output, colour, 5n));

const started = Date.now();
let result: Record<string, unknown>;
try {
  await wallet.wallet.provingService.prove(unproven, LEDGER_9_PROTOCOL_VERSION);
  result = { outcome: "proved", elapsedMs: Date.now() - started };
} catch (error: any) {
  result = { outcome: "rejected", name: error?.name, message: String(error?.message ?? error), elapsedMs: Date.now() - started };
}
await wallet.wallet.stop().catch(() => undefined);
console.log("RESULT " + JSON.stringify(result));
process.exit(0);
