import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { mip6NamespaceBytes } from "@zswap-da/offer-guard";

import {
  createIdempotentSettlementVerifierCleanup,
  readRealSettlementVerifierConfig,
  realSettlementVerifierSignalExitCode,
  verifyRealBackendSettlement,
  type RealSettlementVerifierConfig,
  type SettlementQueryExecutor,
  type SettlementQueryResult,
} from "./solver-offerfiles-real-settlement-verifier.ts";

const RUN_ID = "settlement-test";
const CREATED_AT = "2026-08-15T12:00:00.000Z";
const A = "a1".repeat(32);
const B = "b2".repeat(32);
const NIGHT = "0".repeat(64);
const IDENTIFIER = "c3".repeat(32);
const NULLIFIER = "d4".repeat(32);
const COMMITMENT = "e5".repeat(32);
const ROOT = "f6".repeat(32);
const TX_HASH = "ab".repeat(32);
const OTHER_TX_HASH = "cd".repeat(32);
const CELESTIA_COMMITMENT = Buffer.alloc(32, 0x5a);
const RAW_OFFER = new Uint8Array([1, 2, 3, 4, 5]);

const temporaryDirectories: string[] = [];
const listeners: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "real-settlement-verifier-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeCanonicalPrivate(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return sha256(text);
}

function balanceSnapshot(userA: string, solverB: string, dust: string): Record<string, unknown> {
  return {
    capturedAt: CREATED_AT,
    user: { shielded: { [A]: userA }, unshielded: {}, dust },
    solver: { shielded: { [B]: solverB }, unshielded: {}, dust },
  };
}

function actorArtifact(): Record<string, unknown> {
  return {
    schema: "zswap-offer-files-real-actors/v1",
    runId: RUN_ID,
    networkId: "undeployed",
    createdAt: CREATED_AT,
    actors: {
      genesis: { seedFingerprint: "11".repeat(8) },
      user: { seedFingerprint: "22".repeat(8) },
      solver: { seedFingerprint: "33".repeat(8) },
    },
    tokens: { A, B, NIGHT },
    funding: {
      mintAmount: "1000000",
      userTokenAAmount: "1000",
      solverTokenBAmount: "1000",
      nightPerUtxo: "5000000000000",
      nightUtxosPerActor: 2,
      nightFundingTransaction: { hash: "night-funding-tx", identifiers: [IDENTIFIER] },
      tokenFundingTransactions: [
        { token: "A", hash: "token-a-funding-tx", identifiers: [IDENTIFIER] },
        { token: "B", hash: "token-b-funding-tx", identifiers: [NULLIFIER] },
      ],
    },
    balances: {
      beforeFunding: balanceSnapshot("0", "0", "0"),
      beforeSettlement: balanceSnapshot("1000", "1000", "5000"),
      expectedAfterSettlement: {
        user: { A: "0", B: "900" },
        solver: { A: "1000", B: "100" },
      },
      dustBalanceEvidence: {
        actor: "solver",
        asset: "DUST",
        balanceSource: "wallet.dust.state/waitForDustFunds",
        before: "5000",
        after: null,
        delta: null,
        interpretation: "net-balance-delta-not-exact-fee",
      },
    },
    offer: {
      offerBlob: OfferFiles.encode(RAW_OFFER),
      offerHash: sha256(RAW_OFFER),
      transactionHash: "midnight-offer-transaction",
      identifiers: [IDENTIFIER],
      expectedNullifiers: [NULLIFIER],
      expectedCommitments: [COMMITMENT],
      inputRoots: [ROOT],
      gives: [{ token: A, amount: "1000", kind: "SHIELDED" }],
      wants: [{ token: B, amount: "900", kind: "SHIELDED" }],
      expiresAt: "2026-08-15T12:30:00.000Z",
    },
    ladder: { path: "/inputs/actor/ladder.json", sha256: "07".repeat(32) },
  };
}

const walletMethods = (): Record<string, unknown> => ({
  balanceFinalizedTransaction: { available: true, calls: 1 },
  finalizeRecipe: { available: true, calls: 1 },
  submitTransaction: { available: true, calls: 1 },
  revert: { available: true, calls: 0 },
  transferTransaction: { available: false, calls: 0 },
  finalizeTransaction: { available: false, calls: 0 },
  initSwap: { available: false, calls: 0 },
});

function solverArtifact(offerHash: string): Record<string, unknown> {
  return {
    schema: "zswap-offer-files-real-solver/v1",
    runId: RUN_ID,
    networkId: "undeployed",
    pid: 42,
    api: "http://offer-files-backend:3000",
    ladderConfigPath: "/inputs/actor/ladder.json",
    telemetryPath: "/inputs/solver/solver-telemetry.jsonl",
    centralRecorderEnabled: true,
    seedFingerprint: "33".repeat(8),
    startedAt: CREATED_AT,
    state: "stopped",
    updatedAt: "2026-08-15T12:05:00.000Z",
    submissionCount: 1,
    ready: false,
    walletBoundaries: {
      features: {
        pathB: false,
        residualTopUps: false,
        cycles: false,
        levelsPublication: false,
      },
      methods: walletMethods(),
    },
    stock: {
      tokens: [
        { token: A, balance: "1000", reserved: "0", available: "1000" },
        { token: B, balance: "100", reserved: "0", available: "100" },
      ],
      offers: [{ offerHash, resolvable: true, claimed: false, nullifiers: [NULLIFIER] }],
    },
    lastSubmission: {
      count: 1,
      transactionHash: `0x${TX_HASH}`,
      identifiers: [IDENTIFIER],
      blobHash: "66".repeat(32),
      blobBytes: 512,
      imbalanceCount: 0,
      imbalances: [],
      protocolFee: {
        asset: "DUST",
        specks: "290",
        source: "wallet.calculateTransactionFee",
        transactionHash: `0x${TX_HASH}`,
      },
      inspectionErrors: [],
      boundary: "post-invocation",
    },
    lastSubmissionOutcome: { kind: "succeeded", count: 1, result: { transactionHash: TX_HASH } },
    reason: "SIGTERM",
    telemetryCount: 12,
    lastCentralSequence: 9,
    evidenceFailures: [],
  };
}

function publicationArtifact(actorSha: string, actor: Record<string, any>): Record<string, unknown> {
  return {
    schema: "zswap-offer-files-real-celestia-publication/v1",
    runId: RUN_ID,
    mode: "offer",
    recordedAt: "2026-08-15T12:01:00.000Z",
    actorManifest: {
      schema: "zswap-offer-files-real-actors/v1",
      sha256: actorSha,
      networkId: "undeployed",
      createdAt: CREATED_AT,
      offerHash: actor.offer.offerHash,
      offerTransactionHash: actor.offer.transactionHash,
    },
    payload: {
      source: "actor-manifest.offer.offerBlob",
      garbageLabel: null,
      byteLength: RAW_OFFER.length,
      sha256: actor.offer.offerHash,
      dataBase64: Buffer.from(RAW_OFFER).toString("base64"),
    },
    celestia: {
      rpcEndpoint: {
        protocol: "http:",
        hostname: "publisher-celestia-proxy",
        port: "8080",
        pathnameSha256: sha256("/"),
        hasQuery: false,
        bearerAuth: false,
      },
      namespaceBase64: Buffer.from(mip6NamespaceBytes()).toString("base64"),
      shareVersion: 0,
      gasPrice: "0.002",
      submittedHeight: 417,
      observedHeaderHeight: 417,
      commitmentBase64: CELESTIA_COMMITMENT.toString("base64"),
      commitmentSha256: sha256(CELESTIA_COMMITMENT),
    },
    verification: {
      absoluteDeadlineMs: 5000,
      networkHeadAttempts: 1,
      getAllAttempts: 2,
      exactMatchesAtHeight: 1,
      observedByteLength: RAW_OFFER.length,
      observedSha256: actor.offer.offerHash,
      getByCommitmentSha256: actor.offer.offerHash,
      checks: [
        "submitted-height-has-exact-header",
        "namespace-and-share-version-match",
        "exactly-one-byte-identical-blob-at-height",
        "sha256-matches-submitted-bytes",
        "commitment-resolves-to-byte-identical-blob",
      ],
    },
  };
}

interface Fixture {
  directory: string;
  actor: Record<string, any>;
  solver: Record<string, any>;
  publisher: Record<string, any>;
  actorPath: string;
  solverPath: string;
  publisherPath: string;
  evidencePath: string;
  config: RealSettlementVerifierConfig;
}

async function fixture(): Promise<Fixture> {
  const directory = await temporaryDirectory();
  const actor = actorArtifact() as Record<string, any>;
  const actorPath = join(directory, "actor-manifest.json");
  const solverPath = join(directory, "solver-runtime.json");
  const publisherPath = join(directory, "offer-publication.json");
  const evidencePath = join(directory, "backend-settlement-evidence.json");
  const actorSha = await writeCanonicalPrivate(actorPath, actor);
  const solver = solverArtifact(actor.offer.offerHash) as Record<string, any>;
  const publisher = publicationArtifact(actorSha, actor) as Record<string, any>;
  await writeCanonicalPrivate(solverPath, solver);
  await writeCanonicalPrivate(publisherPath, publisher);
  const config = readRealSettlementVerifierConfig({
    E1_RUN_ID: RUN_ID,
    E1_ACTOR_RESULT_PATH: actorPath,
    E1_SOLVER_RUNTIME_PATH: solverPath,
    E1_PUBLISHER_EVIDENCE_PATH: publisherPath,
    E1_SETTLEMENT_EVIDENCE_PATH: evidencePath,
    E1_SETTLEMENT_BACKEND_URL: "http://offer-files-backend:3000",
    DB_HOST: "postgres",
    DB_PORT: "5432",
    DB_NAME: "offer_files",
    DB_USER: "offer_files",
    DB_PW: "do-not-leak-this-password",
    E1_SETTLEMENT_DEADLINE_MS: "5000",
    E1_SETTLEMENT_POLL_MS: "10",
    E1_SETTLEMENT_MAX_ARTIFACT_BYTES: "1048576",
    E1_SETTLEMENT_MAX_DB_ROWS: "16",
    E1_SETTLEMENT_MAX_DB_RESULT_BYTES: "65536",
    E1_SETTLEMENT_MAX_HTTP_BYTES: "4096",
  });
  return {
    directory,
    actor,
    solver,
    publisher,
    actorPath,
    solverPath,
    publisherPath,
    evidencePath,
    config,
  };
}

interface DatabaseOverrides {
  offerRows?: Record<string, unknown>[];
  nullifierRows?: Record<string, unknown>[];
  commitmentRows?: Record<string, unknown>[];
  hangOffer?: boolean;
}

class InjectedDatabase implements SettlementQueryExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(
    private readonly offerHash: string,
    private readonly offerBlob: string,
    private readonly overrides: DatabaseOverrides = {},
  ) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SettlementQueryResult<Row>> {
    this.calls.push({ text, values });
    let rows: Record<string, unknown>[];
    if (text.includes("settlement-verifier:offer")) {
      if (this.overrides.hangOffer) return new Promise(() => undefined);
      rows = this.overrides.offerRows ?? [{
        source: "history",
        id: 41,
        offer_hash: this.offerHash,
        transaction_hex: this.offerBlob,
        // Effectstream L2 and Celestia DA heights are independent clocks.
        l2_block_height: "1734",
        archive_reason: "CONSUMED",
        archived_at: "2026-08-15T12:04:00.000Z",
      }];
    } else if (text.includes("settlement-verifier:nullifiers")) {
      rows = this.overrides.nullifierRows ?? [{ marker: NULLIFIER, tx_hash: TX_HASH }];
    } else if (text.includes("settlement-verifier:commitments")) {
      rows = this.overrides.commitmentRows ?? [{ marker: COMMITMENT, tx_hash: TX_HASH }];
    } else {
      rows = [];
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function backendFetch(
  status: "live" | "consumed" | "cancelled" | "expired" | "unknown" | "not_found",
  offerHash: string,
): typeof fetch {
  return (async () => Response.json({ offerId: offerHash, status })) as typeof fetch;
}

async function assertNoEvidence(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("real backend settlement evidence verifier", () => {
  test("binds sealed artifacts to one consumed row, exact marker multisets, and one solver tx", async () => {
    const prepared = await fixture();
    const database = new InjectedDatabase(
      prepared.actor.offer.offerHash,
      prepared.actor.offer.offerBlob,
    );
    const evidence = await verifyRealBackendSettlement(prepared.config, database, {
      fetchImpl: backendFetch("consumed", prepared.actor.offer.offerHash),
    });

    expect(evidence.offer).toMatchObject({
      offerFileId: 41,
      offerHash: prepared.actor.offer.offerHash,
      transactionHex: prepared.actor.offer.offerBlob,
      l2BlockHeight: "1734",
      archiveReason: "CONSUMED",
      backendStatus: "consumed",
      publicationHeight: 417,
    });
    expect(evidence.settlement.transactionHash).toBe(TX_HASH);
    expect(evidence.settlement.expectedNullifiers).toEqual([NULLIFIER]);
    expect(evidence.settlement.observedNullifiers).toEqual([{ marker: NULLIFIER, txHash: TX_HASH }]);
    expect(evidence.settlement.expectedCommitments).toEqual([COMMITMENT]);
    expect(evidence.settlement.observedCommitments).toEqual([{ marker: COMMITMENT, txHash: TX_HASH }]);
    expect(evidence.settlement.distinctMarkerTransactionHashes).toEqual([TX_HASH]);
    expect(evidence.settlement.solver).toMatchObject({
      canonicalTransactionHash: TX_HASH,
      submissionCount: 1,
      submitBoundaryCalls: 1,
    });
    expect(database.calls.filter(({ text }) => text.includes("settlement-verifier:")).length).toBe(3);
    expect(database.calls.some(({ text }) => text === "COMMIT")).toBe(true);
    expect(database.calls.some(({ text }) => text === "ROLLBACK")).toBe(false);

    const metadata = await stat(prepared.evidencePath);
    expect(metadata.mode & 0o777).toBe(0o600);
    const text = await readFile(prepared.evidencePath, "utf8");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(text).not.toContain(prepared.config.database.password);
    expect(text).not.toContain(prepared.config.database.user);
  });

  test("fails closed for cancelled and unknown backend terminal states", async () => {
    for (const status of ["cancelled", "unknown"] as const) {
      const prepared = await fixture();
      const database = new InjectedDatabase(
        prepared.actor.offer.offerHash,
        prepared.actor.offer.offerBlob,
      );
      await expect(verifyRealBackendSettlement(prepared.config, database, {
        fetchImpl: backendFetch(status, prepared.actor.offer.offerHash),
      })).rejects.toThrow(`backend terminal status is ${status}, not consumed`);
      await assertNoEvidence(prepared.evidencePath);
    }
  });

  test("rejects missing, split, and unexpected settlement marker evidence", async () => {
    const cases: Array<{ overrides: DatabaseOverrides; message: string }> = [
      {
        overrides: { nullifierRows: [{ marker: NULLIFIER, tx_hash: null }] },
        message: "no chain transaction hash",
      },
      {
        overrides: { commitmentRows: [{ marker: COMMITMENT, tx_hash: OTHER_TX_HASH }] },
        message: "span 2 transaction hashes",
      },
      {
        overrides: { commitmentRows: [{ marker: "ef".repeat(32), tx_hash: TX_HASH }] },
        message: "commitment history multiset differs",
      },
    ];
    for (const item of cases) {
      const prepared = await fixture();
      const database = new InjectedDatabase(
        prepared.actor.offer.offerHash,
        prepared.actor.offer.offerBlob,
        item.overrides,
      );
      await expect(verifyRealBackendSettlement(prepared.config, database, {
        fetchImpl: backendFetch("consumed", prepared.actor.offer.offerHash),
      })).rejects.toThrow(item.message);
      await assertNoEvidence(prepared.evidencePath);
    }
  });

  test("rejects a second submit, leaked reservation, and solver/DB transaction mismatch", async () => {
    const secondSubmit = await fixture();
    secondSubmit.solver.submissionCount = 2;
    await rm(secondSubmit.solverPath);
    await writeCanonicalPrivate(secondSubmit.solverPath, secondSubmit.solver);
    const firstDatabase = new InjectedDatabase(
      secondSubmit.actor.offer.offerHash,
      secondSubmit.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(secondSubmit.config, firstDatabase, {
      fetchImpl: backendFetch("consumed", secondSubmit.actor.offer.offerHash),
    })).rejects.toThrow("exactly one submission");
    expect(firstDatabase.calls).toHaveLength(0);
    await assertNoEvidence(secondSubmit.evidencePath);

    const extraMutation = await fixture();
    extraMutation.solver.walletBoundaries.methods.revert.calls = 1;
    await rm(extraMutation.solverPath);
    await writeCanonicalPrivate(extraMutation.solverPath, extraMutation.solver);
    const mutationDatabase = new InjectedDatabase(
      extraMutation.actor.offer.offerHash,
      extraMutation.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(extraMutation.config, mutationDatabase, {
      fetchImpl: backendFetch("consumed", extraMutation.actor.offer.offerHash),
    })).rejects.toThrow("wallet boundary revert");
    expect(mutationDatabase.calls).toHaveLength(0);
    await assertNoEvidence(extraMutation.evidencePath);

    const leakedClaim = await fixture();
    leakedClaim.solver.stock.offers[0].claimed = true;
    await rm(leakedClaim.solverPath);
    await writeCanonicalPrivate(leakedClaim.solverPath, leakedClaim.solver);
    const leakedClaimDatabase = new InjectedDatabase(
      leakedClaim.actor.offer.offerHash,
      leakedClaim.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(leakedClaim.config, leakedClaimDatabase, {
      fetchImpl: backendFetch("consumed", leakedClaim.actor.offer.offerHash),
    })).rejects.toThrow("successful offer claim was released");
    expect(leakedClaimDatabase.calls).toHaveLength(0);
    await assertNoEvidence(leakedClaim.evidencePath);

    const leakedCapacity = await fixture();
    leakedCapacity.solver.stock.tokens[0].reserved = "900";
    leakedCapacity.solver.stock.tokens[0].available = "100";
    await rm(leakedCapacity.solverPath);
    await writeCanonicalPrivate(leakedCapacity.solverPath, leakedCapacity.solver);
    const leakedCapacityDatabase = new InjectedDatabase(
      leakedCapacity.actor.offer.offerHash,
      leakedCapacity.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(leakedCapacity.config, leakedCapacityDatabase, {
      fetchImpl: backendFetch("consumed", leakedCapacity.actor.offer.offerHash),
    })).rejects.toThrow("terminal stock retains reserved capacity");
    expect(leakedCapacityDatabase.calls).toHaveLength(0);
    await assertNoEvidence(leakedCapacity.evidencePath);

    const mismatch = await fixture();
    mismatch.solver.lastSubmission.transactionHash = OTHER_TX_HASH;
    mismatch.solver.lastSubmission.protocolFee.transactionHash = OTHER_TX_HASH;
    await rm(mismatch.solverPath);
    await writeCanonicalPrivate(mismatch.solverPath, mismatch.solver);
    const secondDatabase = new InjectedDatabase(
      mismatch.actor.offer.offerHash,
      mismatch.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(mismatch.config, secondDatabase, {
      fetchImpl: backendFetch("consumed", mismatch.actor.offer.offerHash),
    })).rejects.toThrow("differs from database settlement");
    await assertNoEvidence(mismatch.evidencePath);
  });

  test("enforces the absolute deadline on an injected hanging query", async () => {
    const prepared = await fixture();
    const database = new InjectedDatabase(
      prepared.actor.offer.offerHash,
      prepared.actor.offer.offerBlob,
      { hangOffer: true },
    );
    await expect(verifyRealBackendSettlement(prepared.config, database, {
      fetchImpl: backendFetch("consumed", prepared.actor.offer.offerHash),
      deadlineAt: Date.now() + 30,
    })).rejects.toThrow("absolute deadline");
    await assertNoEvidence(prepared.evidencePath);
  });

  test("bounds database rows and backend bodies before accepting evidence", async () => {
    const tooManyRows = await fixture();
    const repeatedRows = Array.from({ length: tooManyRows.config.maxDbRows + 1 }, (_, index) => ({
      source: "history",
      id: index + 1,
      offer_hash: tooManyRows.actor.offer.offerHash,
      transaction_hex: tooManyRows.actor.offer.offerBlob,
      l2_block_height: "1734",
      archive_reason: "CONSUMED",
      archived_at: "2026-08-15T12:04:00.000Z",
    }));
    const rowDatabase = new InjectedDatabase(
      tooManyRows.actor.offer.offerHash,
      tooManyRows.actor.offer.offerBlob,
      { offerRows: repeatedRows },
    );
    await expect(verifyRealBackendSettlement(tooManyRows.config, rowDatabase, {
      fetchImpl: backendFetch("consumed", tooManyRows.actor.offer.offerHash),
    })).rejects.toThrow(`more than ${tooManyRows.config.maxDbRows} rows`);
    await assertNoEvidence(tooManyRows.evidencePath);

    const tooLargeBody = await fixture();
    const bodyDatabase = new InjectedDatabase(
      tooLargeBody.actor.offer.offerHash,
      tooLargeBody.actor.offer.offerBlob,
    );
    const oversizedFetch = (async () => new Response("x".repeat(8192), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(verifyRealBackendSettlement(tooLargeBody.config, bodyDatabase, {
      fetchImpl: oversizedFetch,
    })).rejects.toThrow(`exceeds ${tooLargeBody.config.maxHttpBytes} bytes`);
    await assertNoEvidence(tooLargeBody.evidencePath);
  });

  test("rejects symlinked sealed input and refuses to overwrite evidence", async () => {
    const symlinked = await fixture();
    const actorTarget = join(symlinked.directory, "actor-target.json");
    await writeFile(actorTarget, await readFile(symlinked.actorPath), { mode: 0o600 });
    await rm(symlinked.actorPath);
    await symlink(actorTarget, symlinked.actorPath);
    const symlinkDatabase = new InjectedDatabase(
      symlinked.actor.offer.offerHash,
      symlinked.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(symlinked.config, symlinkDatabase, {
      fetchImpl: backendFetch("consumed", symlinked.actor.offer.offerHash),
    })).rejects.toThrow("could not read sealed actor artifact");
    expect((await lstat(symlinked.actorPath)).isSymbolicLink()).toBe(true);
    await assertNoEvidence(symlinked.evidencePath);

    const occupied = await fixture();
    await writeFile(occupied.evidencePath, "sentinel", { mode: 0o600 });
    const occupiedDatabase = new InjectedDatabase(
      occupied.actor.offer.offerHash,
      occupied.actor.offer.offerBlob,
    );
    await expect(verifyRealBackendSettlement(occupied.config, occupiedDatabase, {
      fetchImpl: backendFetch("consumed", occupied.actor.offer.offerHash),
    })).rejects.toThrow("could not atomically publish settlement evidence");
    expect(await readFile(occupied.evidencePath, "utf8")).toBe("sentinel");
    expect((await readdir(occupied.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("cleanup is idempotent and signal exit codes preserve shell semantics", async () => {
    const directory = await temporaryDirectory();
    const temporary = join(directory, "pending.tmp");
    await writeFile(temporary, "pending", { mode: 0o600 });
    let closes = 0;
    const cleanup = createIdempotentSettlementVerifierCleanup();
    cleanup.temporaryPaths.add(temporary);
    cleanup.addCloser(() => {
      closes++;
    });
    const first = cleanup.cleanup();
    const second = cleanup.cleanup();
    expect(second).toBe(first);
    await first;
    expect(closes).toBe(1);
    await assertNoEvidence(temporary);
    expect(realSettlementVerifierSignalExitCode("SIGINT")).toBe(130);
    expect(realSettlementVerifierSignalExitCode("SIGTERM")).toBe(143);
  });

  test("CLI closes an in-flight Postgres connect on SIGTERM and exits 143", async () => {
    const prepared = await fixture();
    let connectedResolve!: () => void;
    const connected = new Promise<void>((resolve) => {
      connectedResolve = resolve;
    });
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          connectedResolve();
        },
        data() {
          // Deliberately never answer the PostgreSQL startup packet.
        },
      },
    });
    listeners.push(listener);
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "solver-offerfiles-real-settlement-verifier.ts"),
      "verify",
    ], {
      cwd: join(import.meta.dir, "../../../.."),
      env: {
        ...process.env,
        E1_RUN_ID: RUN_ID,
        E1_ACTOR_RESULT_PATH: prepared.actorPath,
        E1_SOLVER_RUNTIME_PATH: prepared.solverPath,
        E1_PUBLISHER_EVIDENCE_PATH: prepared.publisherPath,
        E1_SETTLEMENT_EVIDENCE_PATH: prepared.evidencePath,
        E1_SETTLEMENT_BACKEND_URL: "http://127.0.0.1:1",
        E1_SETTLEMENT_DEADLINE_MS: "5000",
        DB_HOST: "127.0.0.1",
        DB_PORT: String(listener.port),
        DB_NAME: "offer_files",
        DB_USER: "offer_files",
        DB_PW: "do-not-leak-this-password",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.race([
      connected,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("child did not enter PostgreSQL connect")), 3_000)
      ),
    ]);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("SIGTERM; cleanup complete");
    expect(stderr).not.toContain("do-not-leak-this-password");
    await assertNoEvidence(prepared.evidencePath);
    expect((await readdir(prepared.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 10_000);
});
