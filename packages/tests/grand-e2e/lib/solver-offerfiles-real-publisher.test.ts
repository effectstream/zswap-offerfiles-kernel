import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { mip6NamespaceBytes } from "@zswap-da/offer-guard";

import {
  createIdempotentPublisherCleanup,
  publishRealCelestiaBlob,
  readRealPublisherConfig,
  realPublisherSignalExitCode,
  type RealPublisherConfig,
} from "./solver-offerfiles-real-publisher.ts";

const temporaryDirectories: string[] = [];
const servers: Bun.Server<unknown>[] = [];
const A = "a1".repeat(32);
const B = "b2".repeat(32);
const NIGHT = "0".repeat(64);
const IDENTIFIER = "c3".repeat(32);
const NULLIFIER = "d4".repeat(32);
const COMMITMENT_HEX = "e5".repeat(32);
const ROOT = "f6".repeat(32);
const COMMITMENT = Buffer.alloc(32, 0x5a);

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "real-publisher-test-"));
  temporaryDirectories.push(path);
  return path;
}

function actorManifest(rawOffer: Uint8Array): Record<string, unknown> {
  const createdAt = "2026-08-15T12:00:00.000Z";
  const snapshot = (userA: string, solverB: string, dust: string) => ({
    capturedAt: createdAt,
    user: { shielded: { [A]: userA }, unshielded: {}, dust },
    solver: { shielded: { [B]: solverB }, unshielded: {}, dust },
  });
  return {
    schema: "zswap-offer-files-real-actors/v1",
    runId: "publisher-test",
    networkId: "undeployed",
    createdAt,
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
      nightFundingTransaction: { hash: "night-tx", identifiers: [IDENTIFIER] },
      tokenFundingTransactions: [
        { token: "A", hash: "token-a-tx", identifiers: [IDENTIFIER] },
        { token: "B", hash: "token-b-tx", identifiers: [NULLIFIER] },
      ],
    },
    balances: {
      beforeFunding: snapshot("0", "0", "0"),
      beforeSettlement: snapshot("1000", "1000", "5000"),
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
      offerBlob: OfferFiles.encode(rawOffer),
      offerHash: sha256(rawOffer),
      transactionHash: "midnight-offer-tx",
      identifiers: [IDENTIFIER],
      expectedNullifiers: [NULLIFIER],
      expectedCommitments: [COMMITMENT_HEX],
      inputRoots: [ROOT],
      gives: [{ token: A, amount: "1000", kind: "SHIELDED" }],
      wants: [{ token: B, amount: "900", kind: "SHIELDED" }],
      expiresAt: "2026-08-15T12:30:00.000Z",
    },
    ladder: { path: "/e1/ladder.json", sha256: "07".repeat(32) },
  };
}

async function writeManifest(directory: string, value: unknown): Promise<string> {
  const path = join(directory, "actors.json");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function rpcServer(expectedBytes: Uint8Array, nullGetAllOnce = true): {
  server: Bun.Server<unknown>;
  calls: Array<{ method: string; params: unknown[] }>;
} {
  const namespace = Buffer.from(mip6NamespaceBytes()).toString("base64");
  const data = Buffer.from(expectedBytes).toString("base64");
  const commitment = COMMITMENT.toString("base64");
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let getAllCalls = 0;
  const blob = { namespace, data, share_version: 0, commitment, index: 4 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as {
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown[];
      };
      calls.push({ method: body.method, params: body.params });
      let result: unknown;
      switch (body.method) {
        case "blob.Submit":
          result = 417;
          break;
        case "header.GetByHeight":
          result = { header: { height: "417" } };
          break;
        case "header.NetworkHead":
          result = { header: { height: "417" } };
          break;
        case "blob.GetAll":
          getAllCalls++;
          result = nullGetAllOnce && getAllCalls === 1 ? null : [blob];
          break;
        case "blob.Get":
          result = blob;
          break;
        default:
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601 } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  servers.push(server);
  return { server, calls };
}

async function configFor(
  directory: string,
  rpcUrl: string,
  mode: "offer" | "garbage",
  rawGarbage?: Uint8Array,
): Promise<RealPublisherConfig> {
  const manifestPath = await writeManifest(directory, actorManifest(new Uint8Array([1, 2, 3, 4, 5])));
  return readRealPublisherConfig(mode, {
    E1_RUN_ID: "publisher-test",
    E1_ACTOR_RESULT_PATH: manifestPath,
    E1_PUBLISHER_EVIDENCE_PATH: join(directory, `${mode}-evidence.json`),
    E1_CELESTIA_RPC_URL: rpcUrl,
    E1_PUBLISHER_DEADLINE_MS: "5000",
    E1_PUBLISHER_VERIFY_POLL_MS: "10",
    E1_PUBLISHER_MAX_RESPONSE_BYTES: "4096",
    ...(mode === "garbage"
      ? {
          E1_PUBLISHER_RAW_BLOB_BASE64: Buffer.from(rawGarbage!).toString("base64"),
          E1_PUBLISHER_GARBAGE_LABEL: "bad-deserialize-1",
          E1_PUBLISHER_GARBAGE_MAX_BYTES: "1024",
        }
      : {}),
  });
}

describe("real direct-Celestia publisher", () => {
  test("publishes the manifest's exact raw offer and independently verifies height/bytes/commitment", async () => {
    const directory = await fixtureDirectory();
    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    const rpc = rpcServer(expected);
    const config = await configFor(directory, rpc.server.url.toString(), "offer");
    const cleanup = createIdempotentPublisherCleanup();
    const evidence = await publishRealCelestiaBlob(config, cleanup);
    await cleanup.cleanup();

    expect(evidence.mode).toBe("offer");
    expect(evidence.payload.dataBase64).toBe(Buffer.from(expected).toString("base64"));
    expect(evidence.payload.sha256).toBe(sha256(expected));
    expect(evidence.celestia.submittedHeight).toBe(417);
    expect(evidence.celestia.observedHeaderHeight).toBe(417);
    expect(evidence.celestia.commitmentBase64).toBe(COMMITMENT.toString("base64"));
    expect(evidence.verification.networkHeadAttempts).toBe(1);
    expect(evidence.verification.getAllAttempts).toBe(2);
    expect(evidence.verification.getByCommitmentSha256).toBe(sha256(expected));
    expect(rpc.calls.map(({ method }) => method)).toEqual([
      "blob.Submit",
      "header.NetworkHead",
      "header.GetByHeight",
      "blob.GetAll",
      "blob.GetAll",
      "blob.Get",
    ]);
    const submit = rpc.calls[0]!.params as any[];
    expect(submit[0]).toEqual([{
      namespace: Buffer.from(mip6NamespaceBytes()).toString("base64"),
      data: Buffer.from(expected).toString("base64"),
      share_version: 0,
    }]);
    expect(submit[1]).toEqual({ gas_price: 0.002 });
    const get = rpc.calls.at(-1)!.params;
    expect(get).toEqual([417, Buffer.from(mip6NamespaceBytes()).toString("base64"), COMMITMENT.toString("base64")]);

    const metadata = await stat(config.evidencePath);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(config.evidencePath, "utf8"))).toEqual(evidence);
  });

  test("publishes one explicit bounded raw garbage blob through the same real RPC path", async () => {
    const directory = await fixtureDirectory();
    const garbage = new Uint8Array([0, 255, 3, 9, 127]);
    const rpc = rpcServer(garbage, false);
    const config = await configFor(directory, rpc.server.url.toString(), "garbage", garbage);
    const cleanup = createIdempotentPublisherCleanup();
    const evidence = await publishRealCelestiaBlob(config, cleanup);
    await cleanup.cleanup();

    expect(evidence.mode).toBe("garbage");
    expect(evidence.payload.source).toBe("explicit-raw-garbage-base64");
    expect(evidence.payload.garbageLabel).toBe("bad-deserialize-1");
    expect(evidence.payload.dataBase64).toBe(Buffer.from(garbage).toString("base64"));
    expect(evidence.payload.sha256).toBe(sha256(garbage));
    expect(rpc.calls[0]!.method).toBe("blob.Submit");
  });

  test("fails before any RPC when the sealed manifest hash is corrupt", async () => {
    const directory = await fixtureDirectory();
    const expected = new Uint8Array([1, 2, 3, 4, 5]);
    const rpc = rpcServer(expected, false);
    const config = await configFor(directory, rpc.server.url.toString(), "offer");
    const decoded = JSON.parse(await readFile(config.actorManifestPath, "utf8"));
    decoded.offer.offerHash = "00".repeat(32);
    await writeFile(config.actorManifestPath, `${JSON.stringify(decoded)}\n`, { mode: 0o600 });
    await chmod(config.actorManifestPath, 0o600);

    await expect(publishRealCelestiaBlob(config)).rejects.toThrow("offer hash differs");
    expect(rpc.calls).toHaveLength(0);
    await expect(stat(config.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("caps responses and refuses evidence when verification is not strict", async () => {
    const directory = await fixtureDirectory();
    const huge = "x".repeat(8192);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(huge, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    servers.push(server);
    const config = await configFor(directory, server.url.toString(), "offer");
    await expect(publishRealCelestiaBlob(config)).rejects.toThrow("exceeds 4096 bytes");
    await expect(stat(config.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("cleanup is idempotent and signal exit codes preserve shell semantics", async () => {
    const directory = await fixtureDirectory();
    const temporary = join(directory, "pending.tmp");
    await writeFile(temporary, "pending", { mode: 0o600 });
    const cleanup = createIdempotentPublisherCleanup();
    cleanup.temporaryPaths.add(temporary);
    const first = cleanup.cleanup();
    const second = cleanup.cleanup();
    expect(second).toBe(first);
    await first;
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(realPublisherSignalExitCode("SIGINT")).toBe(130);
    expect(realPublisherSignalExitCode("SIGTERM")).toBe(143);
  });

  test("the CLI aborts an in-flight RPC on SIGTERM, cleans up, and exits 143", async () => {
    const directory = await fixtureDirectory();
    const manifestPath = await writeManifest(
      directory,
      actorManifest(new Uint8Array([1, 2, 3, 4, 5])),
    );
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        enteredResolve();
        return new Promise<Response>(() => undefined);
      },
    });
    servers.push(server);
    const evidencePath = join(directory, "signal-evidence.json");
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "solver-offerfiles-real-publisher.ts"),
      "publish-offer",
    ], {
      cwd: join(import.meta.dir, "../../../.."),
      env: {
        ...process.env,
        E1_RUN_ID: "publisher-test",
        E1_ACTOR_RESULT_PATH: manifestPath,
        E1_PUBLISHER_EVIDENCE_PATH: evidencePath,
        E1_CELESTIA_RPC_URL: server.url.toString(),
        E1_PUBLISHER_DEADLINE_MS: "5000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not enter RPC")), 3_000)),
    ]);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("SIGTERM; cleanup complete");
    await expect(stat(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }, 10_000);
});
