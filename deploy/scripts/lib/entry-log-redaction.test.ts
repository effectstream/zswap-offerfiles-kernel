// Every entry that can open a Midnight connection on a public network installs
// the process-wide log guard (`installLogRedaction(redactBlockfrostProjectId)`)
// before it reaches any exit: a Blockfrost endpoint carries the project token
// in its query string, and dependencies print the URL of a connection they
// lose (the wallet SDK's RPC client does), outside the entry's own redaction.
//
// Each entry runs as a child process under a preload
// (`test-support/print-token-url-at-exit.ts`) that prints a token-bearing
// Blockfrost URL through console.log, console.error and a raw stderr write
// when the process exits. Each entry is driven to an early exit that needs no
// network beyond this host (a missing required setting, a
// refused connection to a closed local port, or a local stand-in for a
// Blockfrost indexer that answers 403 "Network token mismatch"), after the
// point where the guard must be installed. The token must not appear anywhere
// in the output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `new URL(...).pathname`: a working tree of this repo
// may live under a path with a space in it.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const PRELOAD = join(HERE, "test-support", "print-token-url-at-exit.ts");

const TOKEN = "logGuardTestProjectId000000000000";
const REDACTED = "project_id=<redacted>";
/** A seed that is not a public dev seed. */
const NON_DEV_SEED = "5a".repeat(32);
/** Port 1 is closed in every test environment: a request there is refused at once. */
const CLOSED = `http://127.0.0.1:1/api/v0?project_id=${TOKEN}`;
/** The public services' required Celestia settings (unreachable on purpose). */
const CELESTIA = {
  CELESTIA_START_HEIGHT: "9000000",
  CELESTIA_RPC_URL: "http://127.0.0.1:1",
  CELESTIA_AUTH_TOKEN: "entry-test-bearer",
};

// A stand-in for a Blockfrost indexer refusing the token: the public node and
// batcher probe it right after installing the guard and stop with exit 78.
let indexer: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  indexer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({ status_code: 403, error: "Forbidden", message: "Network token mismatch" }, { status: 403 }),
  });
});
afterAll(() => indexer.stop(true));
const refusingIndexer = (): Record<string, string> => ({
  MIDNIGHT_INDEXER_HTTP: `http://127.0.0.1:${indexer.port}/api/v0?project_id=${TOKEN}`,
  MIDNIGHT_INDEXER_WS: `ws://127.0.0.1:${indexer.port}/api/v0/ws?project_id=${TOKEN}`,
  MIDNIGHT_NODE_HTTP: `http://127.0.0.1:${indexer.port}?project_id=${TOKEN}`,
});
const TOKEN_REFUSED = "rejected the request (HTTP 403: Network token mismatch)";

type EntryCase = {
  /** Path from the repository root. */
  entry: string;
  args?: string[];
  env: Record<string, string> | (() => Record<string, string>);
  exitCode: number;
  /** Text the entry itself prints at that exit: proves it ran, not just loaded. */
  marker: string;
};

const CASES: EntryCase[] = [
  // Public-network services.
  {
    entry: "packages/node/main.public.ts",
    env: () => ({ MIDNIGHT_NETWORK_ID: "preprod", ...CELESTIA, ...refusingIndexer() }),
    exitCode: 78,
    marker: TOKEN_REFUSED,
  },
  {
    entry: "packages/batcher/batcher.public.ts",
    env: () => ({
      MIDNIGHT_NETWORK_ID: "preprod",
      BATCHER_WALLET_SEED: NON_DEV_SEED,
      BATCHER_STORAGE_DIR: join(tmpdir(), "entry-log-redaction-batcher"),
      ...CELESTIA,
      ...refusingIndexer(),
    }),
    exitCode: 78,
    marker: TOKEN_REFUSED,
  },
  {
    entry: "deploy/scripts/offer-poster.ts",
    env: { MIDNIGHT_NETWORK_ID: "preprod" },
    exitCode: 78,
    marker: "[offer-poster] configuration error",
  },
  // Operator scripts.
  {
    entry: "deploy/scripts/provision-solver-fees.ts",
    env: { MIDNIGHT_NETWORK_ID: "preprod" },
    exitCode: 1,
    marker: "SOLVER_SEED is required",
  },
  {
    entry: "deploy/scripts/read-wallet.ts",
    env: { MIDNIGHT_NETWORK_ID: "preprod" },
    exitCode: 78,
    marker: "[read-wallet] READ_SEED must be a 64-hex seed",
  },
  {
    entry: "deploy/scripts/post-maker-offer.ts",
    env: { MIDNIGHT_NETWORK_ID: "preprod" },
    exitCode: 1,
    marker: "GIVE_TOKEN and WANT_TOKEN are required",
  },
  {
    entry: "deploy/scripts/probe-backend-currentness.ts",
    env: { MIDNIGHT_NETWORK_ID: "preprod", DB_PORT: "1" },
    exitCode: 1,
    marker: "ECONNREFUSED",
  },
  // A refused request at top level: the uncaught fetch error carries the URL.
  {
    entry: "packages/validator/scripts/check-preview-indexer.ts",
    args: ["preprod"],
    env: { MIDNIGHT_INDEXER_HTTP: CLOSED, MIDNIGHT_NODE_HTTP: CLOSED },
    exitCode: 1,
    marker: `Indexer: http://127.0.0.1:1/api/v0?${REDACTED}`,
  },
];

describe("entries install the process-wide log guard before any exit", () => {
  test.each(CASES.map((c) => [c.entry, c] as const))("%s", async (_name, c) => {
    // Asynchronous on purpose: the stand-in indexer runs in this process.
    const child = Bun.spawn(
      [process.execPath, "--preload", PRELOAD, join(REPO, c.entry), ...(c.args ?? [])],
      {
        cwd: REPO,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: process.env["HOME"] ?? "",
          MIDNIGHT_BLOCKFROST_PROJECT_ID: TOKEN,
          LOG_GUARD_TEST_TOKEN: TOKEN,
          ...(typeof c.env === "function" ? c.env() : c.env),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      },
    );
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const all = out + err;
    expect(exitCode, all).toBe(c.exitCode);
    expect(all).toContain(c.marker);
    expect(all).not.toContain(TOKEN);
    // The preload's three lines, each redacted.
    expect(out).toContain(`API-WS: disconnected from wss://rpc.midnight-preprod.blockfrost.io/?${REDACTED}`);
    expect(err).toContain(`connection lost: wss://rpc.midnight-preprod.blockfrost.io/?${REDACTED}`);
    expect(err).toContain(`raw write wss://rpc.midnight-preprod.blockfrost.io/?${REDACTED}`);
  }, 120_000);
});
