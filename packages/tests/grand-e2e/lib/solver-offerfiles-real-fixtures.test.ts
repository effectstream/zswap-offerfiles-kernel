import { describe, expect, test } from "bun:test";

import {
  attachExactProtocolFee,
  buildRealStockSnapshot,
  createSemanticsPreservingMethodWrapper,
  createSemanticsPreservingSubmitWrapper,
  recordRealValidationTraceEvidence,
  RealSolverCentralRecorder,
  RealSolverEvidenceFailures,
  readRealSolverServiceConfig,
  realSolverSignalExitCode,
  waitForRealEvidenceWithin,
} from "./solver-offerfiles-real-solver-service.ts";
import { Stock } from "../../../solver/src/stock.ts";

const realActorModuleUrl = new URL(
  "./solver-offerfiles-real-actors.ts",
  import.meta.url,
).href;

async function runRealActorModuleSeam(body: string): Promise<void> {
  // The actor module's real Compact import requires generated managed
  // artifacts. Keep the one test-only module mock in a child so it cannot
  // contaminate another Bun test file in this workspace.
  const source = `
    import { mock } from "bun:test";
    mock.module("@zswap-da/solver-core/offer-files", () => ({
      joinOfferFiles() { throw new Error("not used"); },
      mintShielded() { throw new Error("not used"); },
    }));
    const actors = await import(${JSON.stringify(realActorModuleUrl)});
    ${body}
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

describe("semantics-preserving real submission evidence", () => {
  test("returns the exact success promise before fallible inspection/local evidence", async () => {
    const failures = new RealSolverEvidenceFailures();
    const receiver = { calls: 0 };
    const originalResult = Promise.resolve({ transactionHash: "real-result" });
    const original = function (this: typeof receiver, transaction: { hostile: unknown }) {
      this.calls += 1;
      expect(transaction).toBe(hostileTransaction);
      return originalResult;
    };
    const hostileTransaction = Object.defineProperty({}, "hostile", {
      get: () => {
        throw new Error("inspection exploded");
      },
    }) as { hostile: unknown };
    const observed: string[] = [];
    const wrapper = createSemanticsPreservingSubmitWrapper({
      receiver,
      original,
      failures,
      observe: (event) => {
        observed.push(event.kind);
        if (event.kind === "started") void event.transaction.hostile;
        if (event.kind === "succeeded") throw new Error("local telemetry write failed");
      },
    });

    const returned = wrapper.submit(hostileTransaction);
    expect(receiver.calls).toBe(1);
    expect(returned).toBe(originalResult);
    expect(await returned).toEqual({ transactionHash: "real-result" });
    await wrapper.flush();
    expect(observed).toEqual(["started", "succeeded"]);
    expect(failures.messages()).toEqual([
      "submit 1 started evidence: inspection exploded",
      "submit 1 succeeded evidence: local telemetry write failed",
    ]);
    expect(() => failures.assertNone()).toThrow("real solver evidence collection failed");
    await expect(wrapper.flushEvidence()).rejects.toThrow("real solver evidence collection failed");
  });

  test("preserves the exact rejected promise and original rejection object", async () => {
    const failures = new RealSolverEvidenceFailures();
    const originalError = new Error("node rejected transaction");
    const originalResult = Promise.reject(originalError);
    const wrapper = createSemanticsPreservingSubmitWrapper({
      receiver: null,
      original: () => originalResult,
      failures,
      observe: () => undefined,
    });

    const returned = wrapper.submit({});
    expect(returned).toBe(originalResult);
    let caught: unknown;
    try {
      await returned;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(originalError);
    await wrapper.flushEvidence();
  });

  test("preserves an exact synchronous thrown value and records independently", async () => {
    const failures = new RealSolverEvidenceFailures();
    const thrown = { exact: "sync-wallet-error" };
    const observed: string[] = [];
    const wrapper = createSemanticsPreservingSubmitWrapper({
      receiver: null,
      original: () => {
        throw thrown;
      },
      failures,
      observe: (event) => {
        observed.push(event.kind);
      },
    });

    let caught: unknown;
    try {
      wrapper.submit({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    await wrapper.flushEvidence();
    expect(observed).toEqual(["started", "failed"]);
  });

  test("preserves a non-submit async wallet method under observer failure", async () => {
    const failures = new RealSolverEvidenceFailures();
    const exactResult = Promise.resolve({ recipe: "real-recipe" });
    let invoked = false;
    let wrapper!: ReturnType<typeof createSemanticsPreservingMethodWrapper<[object, object], {
      recipe: string;
    }>>;
    wrapper = createSemanticsPreservingMethodWrapper({
      label: "balanceFinalizedTransaction",
      receiver: null,
      original: (_transaction: object, _keys: object) => {
        expect(wrapper.count()).toBe(0);
        invoked = true;
        return exactResult;
      },
      failures,
      observe: () => {
        throw new Error("boundary recorder failed");
      },
    });
    const returned = wrapper.invoke({}, {});
    expect(invoked).toBe(true);
    expect(returned).toBe(exactResult);
    expect(await returned).toEqual({ recipe: "real-recipe" });
    await wrapper.flush();
    expect(wrapper.count()).toBe(1);
    expect(failures.messages()).toEqual([
      "balanceFinalizedTransaction 1 started evidence: boundary recorder failed",
      "balanceFinalizedTransaction 1 succeeded evidence: boundary recorder failed",
    ]);
    expect(() => failures.assertNone()).toThrow("real solver evidence collection failed");
  });

  test("preserves a non-submit method's exact rejected promise and reason", async () => {
    const failures = new RealSolverEvidenceFailures();
    const originalError = new Error("finalize failed");
    const originalResult = Promise.reject(originalError);
    const wrapper = createSemanticsPreservingMethodWrapper({
      label: "finalizeRecipe",
      receiver: null,
      original: () => originalResult,
      failures,
      observe: () => undefined,
    });
    const returned = wrapper.invoke();
    expect(returned).toBe(originalResult);
    let caught: unknown;
    try {
      await returned;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(originalError);
    await wrapper.flush();
    failures.assertNone();
  });

  test("bounds an unresolved evidence drain without touching the original promise", async () => {
    const failures = new RealSolverEvidenceFailures();
    const originalResult = new Promise<never>(() => undefined);
    const wrapper = createSemanticsPreservingMethodWrapper({
      label: "finalizeRecipe",
      receiver: null,
      original: () => originalResult,
      failures,
      observe: () => undefined,
    });
    expect(wrapper.invoke()).toBe(originalResult);
    expect(await waitForRealEvidenceWithin(
      "wallet boundary evidence flush",
      wrapper.flush(),
      10,
      failures,
    )).toBe(false);
    expect(failures.messages()).toEqual([
      "wallet boundary evidence flush: did not settle within 10 ms",
    ]);
  });

  test("binds the exact wallet-calculated protocol fee to the submitted hash", async () => {
    const transaction = {};
    const inspection = Object.freeze({
      count: 1,
      transactionHash: "submitted-hash",
      identifiers: Object.freeze(["id-1"]),
      blobHash: "blob-hash",
      blobBytes: 42,
      imbalanceCount: 0,
      imbalances: Object.freeze([]),
      protocolFee: null,
      inspectionErrors: Object.freeze([]),
    });
    const wallet = {
      calculateTransactionFee: (received: unknown) => {
        expect(received).toBe(transaction);
        return Promise.resolve(290n);
      },
    };
    const withFee = await attachExactProtocolFee(wallet, transaction, inspection);
    expect(withFee.protocolFee).toEqual({
      asset: "DUST",
      specks: "290",
      source: "wallet.calculateTransactionFee",
      transactionHash: "submitted-hash",
    });
    expect(inspection.protocolFee).toBeNull();
  });
});

describe("central solver recorder", () => {
  test("accepts only the exact recorder path and distinct persistent paths", () => {
    const env = {
      E1_RUN_ID: "config-run",
      E1_SOLVER_SEED: "11".repeat(32),
      E1_SOLVER_API: "http://offer-files-backend:3000",
      E1_SOLVER_AUTH_TOKEN: "1234567890abcdef",
      E1_SOLVER_LADDER_CONFIG: "/artifacts/ladder.json",
      E1_SOLVER_TELEMETRY_PATH: "/artifacts/telemetry.jsonl",
      E1_SOLVER_RUNTIME_PATH: "/artifacts/runtime.json",
      E1_SOLVER_RECORDER_URL: "http://telemetry-relay:8080/record",
      E1_SOLVER_RECORDER_TOKEN: "fedcba0987654321",
    };
    expect(readRealSolverServiceConfig(env).recorderUrl).toBe(
      "http://telemetry-relay:8080/record",
    );
    expect(() => readRealSolverServiceConfig({
      ...env,
      E1_SOLVER_RECORDER_URL: "http://telemetry-relay:8080/record/",
    })).toThrow("exact /record path");
    expect(() => readRealSolverServiceConfig({
      ...env,
      E1_SOLVER_RUNTIME_PATH: env.E1_SOLVER_TELEMETRY_PATH,
    })).toThrow("must be distinct");
  });

  test("serializes milestones and trusts only returned central sequences", async () => {
    const failures = new RealSolverEvidenceFailures();
    const bodies: Array<Record<string, unknown>> = [];
    const authorizations: Array<string | null> = [];
    let active = 0;
    let maximumActive = 0;
    const request = (async (_input: string | URL | Request, init?: RequestInit) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      await Promise.resolve();
      active -= 1;
      return new Response(JSON.stringify({ sequence: bodies.length + 40 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const recorder = new RealSolverCentralRecorder({
      url: "http://telemetry-relay:8080/record",
      token: "1234567890abcdef",
      timeoutMs: 1_000,
      runId: "ordered-run",
      failures,
      request,
    });

    recorder.enqueue("validation", "verdict", { offerHash: "a", phase: "hostile" });
    recorder.enqueue("validation", "admitted", { offerHash: "a" });
    recorder.enqueue("submission", "post-invocation", { transactionHash: "tx" });
    await recorder.flush();

    expect(maximumActive).toBe(1);
    expect(bodies.map((body) => body.solverSequence)).toEqual([1, 2, 3]);
    expect(bodies.map((body) => `${body.phase}/${body.event}`)).toEqual([
      "validation/verdict",
      "validation/admitted",
      "submission/post-invocation",
    ]);
    expect(authorizations).toEqual(Array(3).fill("Bearer 1234567890abcdef"));
    expect(recorder.lastSequence).toBe(43);
    failures.assertNone();
  });

  test("retains recorder failure for the outer evidence gate", async () => {
    const failures = new RealSolverEvidenceFailures();
    const recorder = new RealSolverCentralRecorder({
      url: "http://telemetry-relay:8080/record",
      timeoutMs: 1_000,
      runId: "failed-run",
      failures,
      request: (async () => {
        throw new Error("recorder unavailable");
      }) as unknown as typeof fetch,
    });
    recorder.enqueue("validation", "execution-valid", { offerHash: "a" });
    await recorder.flush();
    expect(failures.messages()).toEqual([
      "central recorder validation/execution-valid: recorder unavailable",
    ]);
    expect(() => failures.assertNone()).toThrow("recorder unavailable");
  });
});

describe("real fixture lifecycle seams", () => {
  test("execution-start Stock evidence precedes dequeue response with the reserved claim", async () => {
    const token = "12".repeat(32);
    const offerHash = "34".repeat(32);
    const nullifier = "56".repeat(32);
    const stock = new Stock();
    stock.setBalances({ [token]: 100n });
    expect(stock.reserve({
      offerHashes: [offerHash],
      nullifiers: [nullifier],
      payouts: new Map([[token, 30n]]),
    })).toBe(true);

    const failures = new RealSolverEvidenceFailures();
    const centrallyRecorded: Array<Record<string, unknown>> = [];
    const recorder = new RealSolverCentralRecorder({
      url: "http://telemetry-relay:8080/record",
      token: "1234567890abcdef",
      timeoutMs: 1_000,
      runId: "dequeue-stock-run",
      failures,
      request: (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        centrallyRecorded.push(body);
        return new Response(JSON.stringify({ sequence: centrallyRecorded.length }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    let rememberedOffer: string | null = null;

    recordRealValidationTraceEvidence({
      kind: "execution-start",
      offerHash,
      generation: { streamGeneration: 7, backendBlockL2: "42" },
    }, {
      recordTrace: (event) => recorder.enqueue("validation", event.kind, event),
      rememberOffer: (value) => {
        rememberedOffer = value;
      },
      recordExecutionStartStock: (value) => {
        expect(rememberedOffer).toBe(value);
        recorder.enqueue(
          "stock",
          "execution-start",
          buildRealStockSnapshot(stock, [{ offerHash: value, inputNullifiers: [nullifier] }]),
        );
      },
    });
    // The backend proxy records the matched dequeue response only after the
    // execution-start observer has returned. Use the same serialized seam to
    // prove the central evidence order expected by the real E1 assertion.
    recorder.enqueue("backend", "dequeue-response", { offerHash, status: 200 });
    await recorder.flush();

    expect(centrallyRecorded.map((event) => `${event.phase}/${event.event}`)).toEqual([
      "validation/execution-start",
      "stock/execution-start",
      "backend/dequeue-response",
    ]);
    expect(centrallyRecorded[1]).toMatchObject({
      phase: "stock",
      event: "execution-start",
      runId: "dequeue-stock-run",
      tokens: [{ token, balance: "100", reserved: "30", available: "70" }],
      offers: [{ offerHash, resolvable: true, claimed: true, nullifiers: [nullifier] }],
    });
    failures.assertNone();
  });

  test("stock evidence distinguishes a live reservation from its release", () => {
    const token = "ab".repeat(32);
    const offerHash = "cd".repeat(32);
    const nullifier = "ef".repeat(32);
    const stock = new Stock();
    stock.setBalances({ [token]: 100n });
    const claim = {
      offerHashes: [offerHash],
      nullifiers: [nullifier],
      payouts: new Map([[token, 30n]]),
    };
    expect(stock.reserve(claim)).toBe(true);
    expect(buildRealStockSnapshot(stock, [{ offerHash, inputNullifiers: [nullifier] }])).toEqual({
      tokens: [{ token, balance: "100", reserved: "30", available: "70" }],
      offers: [{ offerHash, resolvable: true, claimed: true, nullifiers: [nullifier] }],
    });
    stock.release(claim);
    expect(buildRealStockSnapshot(stock, [{ offerHash, inputNullifiers: [nullifier] }])).toEqual({
      tokens: [{ token, balance: "100", reserved: "0", available: "100" }],
      offers: [{ offerHash, resolvable: true, claimed: false, nullifiers: [nullifier] }],
    });
  });

  test("pre-spent offer preserves exact identity, source crypto options, and recipe cleanup", async () => {
    await runRealActorModuleSeam(`
      const raw = Uint8Array.from([1, 2, 3, 4]);
      const tokenA = "aa".repeat(32);
      const tokenB = "bb".repeat(32);
      const nullifier = "cc".repeat(32);
      const expiresAt = new Date("2030-01-02T03:04:05.000Z");
      const tblock = new Date("2029-01-02T03:04:05.000Z");
      const blank = { exact: "blank-reference" };
      const recipe = { transaction: { exact: "unfinalized" } };
      let revertCalls = 0;
      let validationCalls = 0;
      const genesis = {
        zswapSecretKeys: { exact: "shielded-keys" },
        dustSecretKey: { exact: "dust-key" },
        wallet: {
          shielded: { async getAddress() { return { exact: "genesis-address" }; } },
          async initSwap(inputs, outputs, keys, options) {
            if (inputs.shielded[tokenA] !== 1000000n) throw new Error("wrong full-coin input");
            if (outputs[0].outputs[0].type !== tokenB || outputs[0].outputs[0].amount !== 900n) {
              throw new Error("wrong wanted output");
            }
            if (keys.shieldedSecretKeys !== genesis.zswapSecretKeys || options.payFees !== false) {
              throw new Error("wrong keys or fee policy");
            }
            if (options.ttl.toISOString() !== expiresAt.toISOString()) throw new Error("wrong ttl");
            return recipe;
          },
          async finalizeTransaction(transaction) {
            if (transaction !== recipe.transaction) throw new Error("wrong transaction finalized");
            return { serialize() { return raw; } };
          },
          async revert(received) {
            if (received !== recipe) throw new Error("wrong recipe reverted");
            revertCalls += 1;
          },
        },
      };
      const dependencies = {
        encodeOffer(bytes) {
          if (!Buffer.from(bytes).equals(Buffer.from(raw))) throw new Error("wrong encoded bytes");
          return "fixture-offer";
        },
        decodeOffer(blob) {
          if (blob !== "fixture-offer") throw new Error("wrong decoded blob");
          return raw;
        },
        blankReferenceState(networkId) {
          if (networkId !== "undeployed") throw new Error("wrong source-validation network");
          return blank;
        },
        validateOffer(blob, options) {
          validationCalls += 1;
          if (
            blob !== "fixture-offer" || options.refState !== blank ||
            options.crypto !== "verify" || options.maxBytes !== 1048576 ||
            options.tblock !== tblock
          ) throw new Error("source validation options changed");
          return {
            ok: true,
            tx: {},
            nullifiers: [nullifier],
            gives: [{ token: tokenA, amount: "1000000", kind: "SHIELDED" }],
            wants: [{ token: tokenB, amount: "900", kind: "SHIELDED" }],
          };
        },
        now() { return tblock; },
      };
      const candidate = await actors.buildRealPreSpentOfferCandidate(genesis, {
        tokenA,
        tokenB,
        giveAmount: 1000000n,
        wantAmount: 900n,
        expiresAt,
      }, dependencies);
      if (validationCalls !== 1 || revertCalls !== 1) {
        throw new Error("successful candidate was not validated/reverted exactly once");
      }
      if (
        candidate.offerBlob !== "fixture-offer" || candidate.rawBase64 !== "AQIDBA==" ||
        candidate.inputNullifiers.join(",") !== nullifier ||
        candidate.sourceValidation.crypto !== "verify" ||
        candidate.sourceValidation.tblock !== tblock.toISOString()
      ) throw new Error("candidate identity/source evidence changed");
      const expectedHash = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
      if (candidate.offerHash !== expectedHash) throw new Error("candidate hash differs from raw bytes");

      let rejected = false;
      try {
        await actors.buildRealPreSpentOfferCandidate(genesis, {
          tokenA,
          tokenB,
          giveAmount: 1000000n,
          wantAmount: 900n,
          expiresAt,
        }, { ...dependencies, validateOffer() { return { ok: false, code: "PROOF_INVALID" }; } });
      } catch (error) {
        rejected = /source validation/.test(String(error));
      }
      if (!rejected || revertCalls !== 2) {
        throw new Error("rejected source validation did not preserve recipe cleanup");
      }
    `);
  });

  test("pre-spent artifact binds every input nullifier to the consuming A-funding transaction", async () => {
    await runRealActorModuleSeam(`
      const raw = Uint8Array.from([9, 8, 7]);
      const hash = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
      const nullifier = "dd".repeat(32);
      const candidate = {
        offerBlob: "bound-offer",
        offerHash: hash,
        rawBase64: Buffer.from(raw).toString("base64"),
        inputNullifiers: [nullifier],
        gives: [{ token: "aa".repeat(32), amount: "1000000", kind: "SHIELDED" }],
        wants: [{ token: "bb".repeat(32), amount: "900", kind: "SHIELDED" }],
        expiresAt: "2030-01-02T03:04:05.000Z",
        sourceValidation: {
          validator: "@zswap-da/validator/validateZswapOffer",
          crypto: "verify",
          referenceState: "blank-network",
          tblock: "2029-01-02T03:04:05.000Z",
          maxBytes: 1048576,
        },
      };
      const artifact = actors.bindRealPreSpentLivenessArtifact(
        "binding-run",
        "undeployed",
        candidate,
        { hash: "funding-tx", identifiers: ["other", nullifier] },
        "2029-01-02T03:05:00.000Z",
      );
      if (artifact.consumingFundingTxHash !== "funding-tx") {
        throw new Error("consuming transaction hash was not retained");
      }
      actors.assertRealPreSpentLivenessArtifact(artifact, (blob) => {
        if (blob !== candidate.offerBlob) throw new Error("wrong identity blob");
        return raw;
      });

      let missingRejected = false;
      try {
        actors.bindRealPreSpentLivenessArtifact(
          "binding-run",
          "undeployed",
          candidate,
          { hash: "unrelated-tx", identifiers: ["other"] },
        );
      } catch (error) {
        missingRejected = /did not consume all/.test(String(error));
      }
      if (!missingRejected) throw new Error("unrelated funding transaction was accepted");

      let identityRejected = false;
      try {
        actors.assertRealPreSpentLivenessArtifact(
          { ...artifact, rawBase64: "AAAA" },
          () => raw,
        );
      } catch (error) {
        identityRejected = /not identical/.test(String(error));
      }
      if (!identityRejected) throw new Error("corrupt raw identity was accepted");
    `);
  });

  test("pre-spent artifact is mode-0600, no-overwrite, and cleans temporary files", async () => {
    await runRealActorModuleSeam(`
      const { createHash } = await import("node:crypto");
      const { mkdtemp, readFile, readdir, rm, stat } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { OfferFiles } = await import("@effectstream/mip-zswap-offer/mip5");
      const directory = await mkdtemp(join(tmpdir(), "zswap-pre-spent-test-"));
      try {
        const raw = Uint8Array.from([5, 4, 3, 2, 1]);
        const offerBlob = OfferFiles.encode(raw);
        const path = join(directory, "pre-spent-liveness.json");
        const artifact = {
          schema: "zswap-offer-files-real-pre-spent-liveness/v1",
          runId: "sealed-run",
          networkId: "undeployed",
          createdAt: "2029-01-02T03:05:00.000Z",
          offerBlob,
          offerHash: createHash("sha256").update(raw).digest("hex"),
          rawBase64: Buffer.from(raw).toString("base64"),
          inputNullifiers: ["ee".repeat(32)],
          gives: [{ token: "aa".repeat(32), amount: "1000000", kind: "SHIELDED" }],
          wants: [{ token: "bb".repeat(32), amount: "900", kind: "SHIELDED" }],
          expiresAt: "2030-01-02T03:04:05.000Z",
          sourceValidation: {
            validator: "@zswap-da/validator/validateZswapOffer",
            crypto: "verify",
            referenceState: "blank-network",
            tblock: "2029-01-02T03:04:05.000Z",
            maxBytes: 1048576,
          },
          consumingFundingTxHash: "funding-tx-one",
        };
        await actors.writeRealPreSpentLivenessArtifact(path, artifact);
        const original = await readFile(path, "utf8");
        if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error("artifact mode is not 0600");

        let overwriteRejected = false;
        try {
          await actors.writeRealPreSpentLivenessArtifact(path, {
            ...artifact,
            consumingFundingTxHash: "funding-tx-two",
          });
        } catch (error) {
          overwriteRejected = error && error.code === "EEXIST";
        }
        if (!overwriteRejected) throw new Error("sealed artifact was overwritten");
        if (await readFile(path, "utf8") !== original) throw new Error("sealed bytes changed");
        if ((await readdir(directory)).join(",") !== "pre-spent-liveness.json") {
          throw new Error("failed sealed write retained temporary files");
        }

        const env = {
          E1_RUN_ID: "sealed-run",
          E1_USER_SEED: "11".repeat(32),
          E1_SOLVER_SEED: "22".repeat(32),
          E1_GENESIS_SEED: "33".repeat(32),
          E1_ACTOR_RESULT_PATH: join(directory, "actor.json"),
          E1_ACTOR_RUNTIME_PATH: join(directory, "runtime.json"),
          E1_ACTOR_LADDER_PATH: join(directory, "ladder.json"),
          E1_ACTOR_PRE_SPENT_PATH: path,
        };
        if (actors.readRealActorConfig(env).preSpentPath !== path) {
          throw new Error("pre-spent config path was not retained");
        }
        let collisionRejected = false;
        try {
          actors.readRealActorConfig({ ...env, E1_ACTOR_RESULT_PATH: path });
        } catch (error) {
          collisionRejected = /must be distinct/.test(String(error));
        }
        if (!collisionRejected) throw new Error("colliding artifact paths were accepted");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    `);
  });

  test("actor cleanup is idempotent, reverse-owned, and aggregates failures", async () => {
    await runRealActorModuleSeam(`
      const { createIdempotentRealActorCleanup, realActorSignalExitCode } = actors;
      const calls = [];
      const cleanup = createIdempotentRealActorCleanup(() => [
        { label: "user", stop() { calls.push("user"); throw new Error("user stop failed"); } },
        { label: "solver", async stop() { calls.push("solver"); throw new Error("solver stop failed"); } },
      ]);
      const first = cleanup();
      if (cleanup() !== first) throw new Error("cleanup promise identity changed");
      let failure;
      try { await first; } catch (error) { failure = error; }
      if (!(failure instanceof AggregateError) || failure.errors.length !== 2) {
        throw new Error("cleanup failures were not aggregated");
      }
      if (calls.join(",") !== "solver,user") throw new Error("cleanup ownership order changed");
      if (cleanup() !== first) throw new Error("settled cleanup promise identity changed");
      if (realActorSignalExitCode("SIGINT") !== 130 || realActorSignalExitCode("SIGTERM") !== 143) {
        throw new Error("actor signal exit mapping changed");
      }
    `);
  });

  test("solver signal codes preserve conventional interrupted exits", () => {
    expect(realSolverSignalExitCode("SIGINT")).toBe(130);
    expect(realSolverSignalExitCode("SIGTERM")).toBe(143);
  });
});
