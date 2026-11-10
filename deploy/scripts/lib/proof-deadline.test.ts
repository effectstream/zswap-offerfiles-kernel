// Proof requests the kernel's own tools send are bounded by
// MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS, and a malformed wallet timeout stops an
// entry with exit 78 naming it.
//
// The stub proof server accepts every request and never answers: what a proof
// server whose worker was killed for memory looks like from the client.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";

import { ProofDeadlineError, proofServerOrigin } from "../../../packages/kernel-client/wallet-timeouts.ts";
import { postMakerOffer } from "./maker-offer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

let silentProver: ReturnType<typeof Bun.serve>;
const proveRequests: string[] = [];
/** Releases the held requests so the server can stop. */
const held: Array<() => void> = [];
let closedPort = 0;

beforeAll(() => {
  silentProver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      proveRequests.push(new URL(req.url).pathname);
      await new Promise<void>((release) => held.push(release));
      return new Response("released at teardown", { status: 503 });
    },
  });
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  closedPort = listener.port;
  listener.stop(true);
});
afterAll(async () => {
  for (const release of held.splice(0)) release();
  await silentProver.stop(true);
});

const PRIOR_PROOF = process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"];
const restoreProofEnv = () => {
  if (PRIOR_PROOF === undefined) delete process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"];
  else process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"] = PRIOR_PROOF;
};

async function runChild(file: string, env: Record<string, string>, args: string[] = []) {
  // Asynchronous on purpose: the stub proof server runs in this process.
  const child = Bun.spawn([process.execPath, file, ...args], {
    cwd: REPO,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => child.kill(), 90_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(killer);
  return { stdout, stderr, exitCode };
}

describe("the offer poster's wallet facade (real SDK prover, silent proof server)", () => {
  test("a proof request fails at the deadline, naming the proof server, after reaching /prove", async () => {
    const before = proveRequests.length;
    const run = await runChild(join(HERE, "test-support", "pinned-facade-proof-child.ts"), {
      MIDNIGHT_NETWORK_ID: "undeployed",
      TEST_PROOF_SERVER_URL: `http://127.0.0.1:${silentProver.port}`,
      TEST_CLOSED_PORT: String(closedPort),
      TEST_PROOF_DEADLINE_MS: "1500",
    });
    const line = run.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
    const result = JSON.parse(line!.slice("RESULT ".length));
    expect(result.outcome).toBe("rejected");
    expect(result.name).toBe("ProofDeadlineError");
    expect(result.message).toContain(
      `proof request to http://127.0.0.1:${silentProver.port} did not finish within 1500 ms (MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS)`,
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1_450);
    expect(result.elapsedMs).toBeLessThan(10_000);
    expect(proveRequests.slice(before)).toContain("/prove");
  }, 120_000);

  test("without an explicit deadline the facade uses MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS", async () => {
    const run = await runChild(join(HERE, "test-support", "pinned-facade-proof-child.ts"), {
      MIDNIGHT_NETWORK_ID: "undeployed",
      MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS: "1000",
      TEST_PROOF_SERVER_URL: `http://127.0.0.1:${silentProver.port}`,
      TEST_CLOSED_PORT: String(closedPort),
    });
    const line = run.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
    const result = JSON.parse(line!.slice("RESULT ".length));
    expect(result).toMatchObject({ outcome: "rejected", name: "ProofDeadlineError" });
    expect(result.message).toContain("did not finish within 1000 ms");
  }, 120_000);
});

describe("the maker offer", () => {
  test("a proof that never returns fails at MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS, naming the proof server, and posts nothing", async () => {
    process.env["MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS"] = "1000";
    const posted: unknown[] = [];
    const give = "12".repeat(32);
    const maker = {
      wallet: {
        shielded: {
          waitForSyncedState: async () => ({ balances: { [give]: 1_000n } }),
          getAddress: async () => ({ address: "maker" }),
        },
        initSwap: async () => ({ transaction: { unproven: true } }),
        finalizeTransaction: () => new Promise(() => undefined),
      },
    };
    const api = { post: async (...args: unknown[]) => { posted.push(args); return { status: 500, body: {} }; } };
    const started = Date.now();
    let caught: unknown;
    try {
      await postMakerOffer({
        maker,
        api: api as never,
        giveToken: give,
        wantToken: "34".repeat(32),
        giveAmount: 10n,
        wantAmount: 20n,
        log: () => undefined,
      });
    } catch (error) {
      caught = error;
    } finally {
      restoreProofEnv();
    }
    expect(caught).toBeInstanceOf(ProofDeadlineError);
    expect(String(caught)).toContain(
      `proof request to ${proofServerOrigin(midnightNetworkConfig.proofServer)} did not finish within 1000 ms`,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(posted).toEqual([]);
  });
});

describe("a malformed wallet timeout stops the entry with exit 78, naming it", () => {
  test.each([
    ["deploy/scripts/read-wallet.ts", "read-wallet", "MIDNIGHT_WALLET_SYNC_TIMEOUT_MS", "10m"],
    ["deploy/scripts/post-maker-offer.ts", "maker-offer", "MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS", "0"],
    ["deploy/scripts/provision-solver-fees.ts", "provision-external", "MIDNIGHT_WALLET_SYNC_TIMEOUT_MS", "999"],
    ["deploy/scripts/offer-poster.ts", "offer-poster", "MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS", "-5"],
  ])("%s", async (entry, tag, name, value) => {
    const run = await runChild(join(REPO, entry), {
      MIDNIGHT_NETWORK_ID: "undeployed",
      POSTER_SEED: "5a".repeat(32),
      GIVE_TOKEN: "12".repeat(32),
      WANT_TOKEN: "34".repeat(32),
      [name]: value,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(78);
    expect(run.stderr).toContain(`[${tag}]`);
    expect(run.stderr).toContain(`${name} must be an integer number of milliseconds from 1000 to 86400000`);
  }, 120_000);
});
