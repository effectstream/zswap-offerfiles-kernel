/**
 * RF7A focused real-funds release-hardening gate.
 *
 * This is intentionally narrower than the chain-backed feature E2E. It
 * falsifies the RF1/RF2 restart authority directly: an abruptly terminated
 * fresh Bun process leaves a real WAL-backed operation journal, a second
 * process reopens it through the production executor, the production bounded
 * HTTP clients read a relay response tied to the frozen upstream contract and
 * the real backend consumption route reads real PGlite marker evidence.
 * Wallet seams count every mutating call so a restart cannot hide a duplicate
 * commit or revert.
 *
 * Run with:
 *   bun run packages/tests/grand-e2e/solver-release-hardening-e2e.ts --verify-rf7a
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { closeTestPglite } from "../../database/test-pglite.ts";
import { registerOfferConsumptionRoute } from "../../node/offer-consumption-read.ts";
import {
  RELAY_WS_CONTRACT_REVISION,
  parseTxSubmitted,
} from "../../solver-core/relay-ws-contract.ts";
import { Book } from "../../solver/src/book.ts";
import { SolverOperationJournal } from "../../solver/src/operation-journal.ts";
import { Stock } from "../../solver/src/stock.ts";
import { startSwapJobExecutor, type SwapJobWallet } from "../../solver/src/swap-job-executor.ts";
import { RELAY_FIXTURE_REVISION } from "./lib/relay-fixture-n0.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const OFFER_A = "11".repeat(32);
const OFFER_B = "22".repeat(32);
const TOKEN_OUT = "bb".repeat(32);
const NULLIFIER = "31".repeat(32);
const LEDGER_A = "cd".repeat(32);
const LEDGER_B = "ef".repeat(32);
const EXPECTED_RELAY_REVISION = "d444c8379415093460d83a6ba27536af396f759d";
const FIXTURE_ROOT = new URL("../../solver-core/fixtures/relay-ws/v1/", import.meta.url);
const JOURNAL_MODULE = new URL("../../solver/src/operation-journal.ts", import.meta.url).href;
const NODE_REQUIRE = createRequire(new URL("../../node/package.json", import.meta.url));

type CrashState = "AWAITING_RELAY" | "RELAY_SUBMITTED" | "CONFIRMING";

interface MutationCounters {
  initSwap: number;
  balanceDust: number;
  finalize: number;
  revertUnproven: number;
  revertFinalized: number;
}

interface PinnedRelayEvidence {
  jobId: string;
  txId: string;
  manifestHash: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function verifiedFreePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    if (excluded.has(port)) continue;
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
      });
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => error ? reject(error) : resolve()));
      excluded.add(port);
      return port;
    } catch {
      try { probe.close(); } catch { /* failed probes own no listener */ }
    }
  }
  throw new Error("could not verify a free RF7A port >= 10000");
}

async function readPinnedRelayEvidence(): Promise<PinnedRelayEvidence> {
  assertEqual(RELAY_WS_CONTRACT_REVISION, EXPECTED_RELAY_REVISION,
    "solver relay contract revision");
  assertEqual(RELAY_FIXTURE_REVISION, EXPECTED_RELAY_REVISION,
    "Docker relay fixture revision");
  const [manifest, bytes] = await Promise.all([
    readFile(new URL("MANIFEST.sha256", FIXTURE_ROOT), "utf8"),
    readFile(new URL("tx-submitted.json", FIXTURE_ROOT)),
  ]);
  const manifestHash = manifest.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === "tx-submitted.json")?.[0];
  assert(manifestHash !== undefined, "pinned manifest omits tx-submitted.json");
  assertEqual(createHash("sha256").update(bytes).digest("hex"), manifestHash,
    "pinned tx-submitted fixture hash");
  const message = parseTxSubmitted(JSON.parse(bytes.toString("utf8")));
  assert(message !== null, "pinned tx-submitted fixture violates the frozen relay parser");
  return { jobId: message.jobId, txId: message.txId, manifestHash };
}

const ABRUPT_WRITER = String.raw`
const { SolverOperationJournal } = await import(process.env.RF7A_JOURNAL_MODULE);
const path = process.env.RF7A_JOURNAL_PATH;
const jobId = process.env.RF7A_JOB_ID;
const state = process.env.RF7A_CRASH_STATE;
const offerHashes = JSON.parse(process.env.RF7A_OFFER_HASHES);
const tokenOut = process.env.RF7A_TOKEN_OUT;
const nullifier = process.env.RF7A_NULLIFIER;
if (!path || !jobId || !state || !tokenOut || !nullifier || !Array.isArray(offerHashes)) {
  throw new Error("RF7A abrupt writer environment is incomplete");
}
const journal = SolverOperationJournal.open({ path });
const expires = Date.now() + 120000;
const prepare = (kind, label, artifact) => {
  const operationKey = "job:" + jobId + ":g1:" + kind + ":" + label;
  journal.createPrepared({
    operationKey,
    jobId,
    generation: 1,
    offerHashes,
    claim: { inputs: [nullifier], payouts: { [tokenOut]: "5" } },
    operationKind: kind,
    ttlExpiresAtMs: expires,
    deadlineAtMs: expires - 1000,
    ...(artifact === undefined ? {} : {
      walletArtifactKind: "FINALIZED_TRANSACTION",
      walletArtifactBytes: new TextEncoder().encode(artifact),
    }),
  });
  return operationKey;
};
const move = (key) => {
  journal.transition(key, "PREPARED", "APPLIED");
  if (state === "AWAITING_RELAY") {
    journal.transition(key, "APPLIED", "AWAITING_RELAY");
  } else if (state === "RELAY_SUBMITTED") {
    journal.transition(key, "APPLIED", "AWAITING_RELAY");
    journal.transition(key, "AWAITING_RELAY", "RELAY_SUBMITTED");
  } else if (state === "CONFIRMING") {
    journal.transition(key, "APPLIED", "CONFIRMING");
  } else {
    throw new Error("unsupported RF7A crash state " + state);
  }
};
move(prepare("JOB_SETTLEMENT", "settlement"));
move(prepare("FINALIZED_CONTRIBUTION", "wallet", "rf7a-" + state));
// Deliberately do not close the WAL journal: this is the abrupt-exit edge.
process.exit(0);
`;

async function seedAbruptJournal(
  path: string,
  state: CrashState,
  jobId: string,
  offerHashes: string[],
): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", ABRUPT_WRITER], {
    env: {
      ...process.env,
      RF7A_JOURNAL_MODULE: JOURNAL_MODULE,
      RF7A_JOURNAL_PATH: path,
      RF7A_JOB_ID: jobId,
      RF7A_CRASH_STATE: state,
      RF7A_OFFER_HASHES: JSON.stringify(offerHashes),
      RF7A_TOKEN_OUT: TOKEN_OUT,
      RF7A_NULLIFIER: NULLIFIER,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assertEqual(exitCode, 0, `abrupt ${state} writer exit (${stderr})`);
  assertEqual(stdout, "", `abrupt ${state} writer stdout`);
  assertEqual(stderr, "", `abrupt ${state} writer stderr`);
}

async function seedConsumedOffer(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  id: number,
  offerHash: string,
  ledgerTxHash: string,
): Promise<void> {
  const marker = `rf7a-nullifier-${id}`;
  const commitment = `rf7a-commitment-${id}`;
  const height = 700 + id;
  await client.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, first_seen_at,
        archive_reason, archived_at)
     VALUES ($1, $2, $3, $4, NOW(), 'CONSUMED', NOW())`,
    [id, height, `rf7a-blob-${id}`, offerHash],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history
       (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '5', 'GIVING', 'SHIELDED', NOW())`,
    [id, TOKEN_OUT],
  );
  await client.query(
    `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
     VALUES ($1, $2, NOW())`,
    [id, marker],
  );
  await client.query(
    `INSERT INTO nullifiers (nullifier, height, tx_hash) VALUES ($1, $2, $3)`,
    [marker, height, ledgerTxHash],
  );
  await client.query(
    `INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
     VALUES ($1, $2)`,
    [id, commitment],
  );
  await client.query(
    `INSERT INTO commitments (commitment, tx_hash, height) VALUES ($1, $2, $3)`,
    [commitment, ledgerTxHash, height],
  );
}

function zeroCounters(): MutationCounters {
  return { initSwap: 0, balanceDust: 0, finalize: 0, revertUnproven: 0, revertFinalized: 0 };
}

function totalMutations(counters: MutationCounters): number {
  return Object.values(counters).reduce((sum, value) => sum + value, 0);
}

function startReopenedExecutor(
  path: string,
  baseUrl: string,
  counters: MutationCounters,
) {
  const journal = SolverOperationJournal.open({ path });
  const stock = new Stock();
  stock.setBalances({ [TOKEN_OUT]: 100n });
  const fake = (label: string) => ({
    label,
    serialize: () => new TextEncoder().encode(label),
  });
  const wallet: SwapJobWallet = {
    shielded: { getAddress: async () => "rf7a-address" },
    dust: { balanceTransactions: async () => {
      counters.balanceDust += 1;
      return fake("dust");
    } },
    initSwap: async () => {
      counters.initSwap += 1;
      return { transaction: fake("swap") };
    },
    finalizeTransaction: async (transaction) => {
      counters.finalize += 1;
      return transaction as any;
    },
    revertTransaction: async () => { counters.revertUnproven += 1; },
    revert: async () => { counters.revertFinalized += 1; },
  };
  const executor = startSwapJobExecutor({
    cache: { book: new Book(), isCurrent: () => true },
    stock,
    wallet,
    journal,
    keys: { dustSecretKey: "rf7a-dust" },
    api: baseUrl,
    relayHttpUrl: baseUrl,
    maxParallelSwaps: 2,
    expiryMarginSeconds: 120,
    settleTtlMinutes: 1,
    requestTimeoutMs: 5_000,
    sweepIntervalMs: 60_000,
    dependencies: {
      serializeUnproven: (transaction: any) => transaction.serialize(),
      deserializeUnproven: (bytes) => fake(new TextDecoder().decode(bytes)),
      serializeFinalized: (transaction: any) => transaction.serialize(),
      deserializeFinalized: (bytes) => fake(new TextDecoder().decode(bytes)) as any,
    },
  });
  return { executor, journal, stock };
}

async function stopReopened(
  opened: ReturnType<typeof startReopenedExecutor>,
): Promise<void> {
  await opened.executor.stop();
  opened.journal.close();
}

async function main(): Promise<void> {
  assert(process.argv.includes("--verify-rf7a"), "expected --verify-rf7a");
  const pinned = await readPinnedRelayEvidence();
  assert(pinned.txId !== `0x${LEDGER_A}`, "test hashes must occupy distinct evidence domains");
  assert(pinned.txId !== `0x${LEDGER_B}`, "split-evidence hash must differ from relay extrinsic");

  const ports = new Set<number>();
  const pglitePort = await verifiedFreePort(ports);
  const apiPort = await verifiedFreePort(ports);
  const directory = await mkdtemp(join(tmpdir(), "cow-rf7a-release-"));
  let pglite: any;
  let client: any;
  let server: any;
  const routeReads = { relay: 0, backend: 0 };
  try {
    const [{ startPglite }, pgModule, fastifyModule, { migrationTable }] = await Promise.all([
      import(pathToFileURL(NODE_REQUIRE.resolve("@effectstream/db/start-pglite")).href),
      import("pg"),
      import(pathToFileURL(NODE_REQUIRE.resolve("fastify")).href),
      import("../../database/mod.ts"),
    ]);
    pglite = await startPglite(pglitePort);
    const PgClient = pgModule.default.Client;
    client = new PgClient({
      host: "127.0.0.1", port: pglitePort, user: "postgres", database: "postgres",
    });
    await client.connect();
    for (const migration of migrationTable) await client.query(migration.sql);
    await seedConsumedOffer(client, 701, OFFER_A, LEDGER_A);
    await seedConsumedOffer(client, 702, OFFER_B, LEDGER_B);

    server = fastifyModule.default();
    registerOfferConsumptionRoute(server, client);
    server.addHook("onRequest", async (request: any) => {
      if (String(request.url).includes("/consumption")) routeReads.backend += 1;
    });
    server.get("/jobs/:jobId", async (request: any, reply: any) => {
      routeReads.relay += 1;
      if (request.params.jobId !== pinned.jobId) {
        return reply.code(404).send({ error: "not_found" });
      }
      return { status: "done", txId: pinned.txId };
    });
    await server.listen({ host: "127.0.0.1", port: apiPort });
    const baseUrl = `http://127.0.0.1:${apiPort}`;

    let freshProcesses = 0;
    let positiveRestarts = 0;
    for (const state of ["AWAITING_RELAY", "RELAY_SUBMITTED", "CONFIRMING"] as const) {
      const path = join(directory, `${state.toLowerCase()}.sqlite`);
      await seedAbruptJournal(path, state, pinned.jobId, [OFFER_A]);
      freshProcesses += 1;
      const counters = zeroCounters();
      const first = startReopenedExecutor(path, baseUrl, counters);
      await first.executor.ready;
      const settlement = first.journal.list().find((row) => row.operationKind === "JOB_SETTLEMENT");
      assert(settlement !== undefined, `${state} lost its durable settlement row`);
      assert(first.journal.list().every((row) => row.lifecycleState === "SETTLED"),
        `${state} did not settle every durable operation`);
      assertEqual(first.stock.reserved(TOKEN_OUT), 0n, `${state} retained settled stock`);
      assertEqual(totalMutations(counters), 0, `${state} repeated a wallet mutation`);
      assertEqual(settlement.receipt.relayExtrinsicHash, pinned.txId,
        `${state} relay extrinsic evidence`);
      assertEqual(settlement.receipt.ledgerTxHash, LEDGER_A,
        `${state} Midnight ledger evidence`);
      assert(settlement.receipt.relayExtrinsicHash !== settlement.receipt.ledgerTxHash,
        `${state} conflated relay and ledger hash domains`);
      await stopReopened(first);

      const readsBefore = { ...routeReads };
      const twiceCounters = zeroCounters();
      const twice = startReopenedExecutor(path, baseUrl, twiceCounters);
      await twice.executor.ready;
      assert(twice.journal.list().every((row) => row.lifecycleState === "SETTLED"),
        `${state} double restart lost terminal authority`);
      assertEqual(totalMutations(twiceCounters), 0, `${state} double restart mutated wallet`);
      assertEqual(routeReads.relay, readsBefore.relay, `${state} terminal restart reread relay`);
      assertEqual(routeReads.backend, readsBefore.backend, `${state} terminal restart reread backend`);
      await stopReopened(twice);
      positiveRestarts += 2;
    }

    const splitPath = join(directory, "split-ledger.sqlite");
    await seedAbruptJournal(splitPath, "AWAITING_RELAY", pinned.jobId, [OFFER_A, OFFER_B]);
    freshProcesses += 1;
    const splitCounters = zeroCounters();
    const split = startReopenedExecutor(splitPath, baseUrl, splitCounters);
    await split.executor.ready;
    const splitSettlement = split.journal.list().find((row) => row.operationKind === "JOB_SETTLEMENT");
    assert(splitSettlement !== undefined, "split evidence lost the settlement row");
    assert(split.journal.list().every((row) => row.lifecycleState === "QUARANTINED"),
      "split backend ledger evidence must remain quarantined");
    assertEqual(splitSettlement.receipt.relayExtrinsicHash, pinned.txId,
      "split case must retain independent positive relay evidence");
    assertEqual(splitSettlement.receipt.ledgerTxHash, undefined,
      "split ledger evidence must not be persisted as uniform");
    assertEqual(totalMutations(splitCounters), 0, "split evidence repeated a wallet mutation");
    assertEqual(split.stock.reserved(TOKEN_OUT), 5n, "split evidence released durable stock");
    assertEqual(split.executor.unavailableOfferHashes().join(","), [OFFER_A, OFFER_B].join(","),
      "split evidence did not retain global offer unavailability");
    await stopReopened(split);

    const splitTwiceCounters = zeroCounters();
    const splitTwice = startReopenedExecutor(splitPath, baseUrl, splitTwiceCounters);
    await splitTwice.executor.ready;
    assert(splitTwice.journal.list().every((row) => row.lifecycleState === "QUARANTINED"),
      "split evidence double restart escaped quarantine");
    assertEqual(totalMutations(splitTwiceCounters), 0,
      "split evidence double restart repeated a wallet mutation");
    assertEqual(splitTwice.stock.reserved(TOKEN_OUT), 5n,
      "split evidence double restart released durable stock");
    await stopReopened(splitTwice);

    console.log(JSON.stringify({
      gate: "RF7A_RELEASE_HARDENING",
      status: "PASS",
      relayRevision: EXPECTED_RELAY_REVISION,
      relayFixtureSha256: pinned.manifestHash,
      relayExtrinsicHash: pinned.txId,
      ledgerHashes: [LEDGER_A, LEDGER_B],
      hashesDistinct: true,
      abruptFreshProcesses: freshProcesses,
      positiveReconciliations: positiveRestarts,
      quarantinedSplitReconciliations: 2,
      walletMutations: 0,
      routeReads,
      ports: { pglite: pglitePort, evidenceHttp: apiPort },
    }));
  } finally {
    try { await server?.close(); }
    finally {
      await closeTestPglite(pglite, client);
      await rm(directory, { recursive: true, force: true });
    }
  }
}

await main();
