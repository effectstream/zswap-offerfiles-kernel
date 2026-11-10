// What the public API serves never carries the Blockfrost project token:
// GET /v1/midnight/config shows the endpoints as `project_id=<redacted>`, and
// /v1/health and /v1/health/sync carry no endpoint at all. The routes run in
// a child process (test-support/served-endpoints-child.ts) whose endpoint
// overrides embed a token, plain and among other query parameters.

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "servedEndpointsTestToken00000000";

/** A free loopback port, synchronously (the child runs at collection time). */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** A loopback port nothing listens on, so the tip probes fail at once. */
const closedPort = freePort();

describe("served endpoints are redacted", () => {
  const child = Bun.spawnSync([process.execPath, "run", join(HERE, "test-support", "served-endpoints-child.ts")], {
    cwd: HERE,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MIDNIGHT_NETWORK_ID: "undeployed",
      MIDNIGHT_INDEXER_HTTP: `http://127.0.0.1:${closedPort}/api/v0?project_id=${TOKEN}`,
      MIDNIGHT_INDEXER_WS: `ws://127.0.0.1:${closedPort}/api/v0/ws?a=1&project_id=${TOKEN}&b=2`,
      MIDNIGHT_NODE_HTTP: `http://127.0.0.1:${closedPort}?project_id=${TOKEN}`,
      MIDNIGHT_PROOF_SERVER_URL: "http://127.0.0.1:6300",
      CELESTIA_RPC_URL: `http://127.0.0.1:${closedPort}`,
      EVENT_GATE_POLL_ENABLED: "false",
      DB_USER: "postgres",
      DB_NAME: "postgres",
      PGLITE_DATA_DIR: "memory://",
      TEST_PGLITE_PORT: String(freePort()),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  const result = line ? JSON.parse(line.slice("RESULT ".length)) : undefined;

  test("the child ran to completion", () => {
    expect(child.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(result, stdout).toBeDefined();
  });

  test("GET /v1/midnight/config shows project_id=<redacted>, plain and among other parameters", () => {
    expect(result.config.status).toBe(200);
    const body = JSON.parse(result.config.body);
    expect(body.indexerUri).toBe(`http://127.0.0.1:${closedPort}/api/v0?project_id=<redacted>`);
    expect(body.indexerWsUri).toBe(`ws://127.0.0.1:${closedPort}/api/v0/ws?a=1&project_id=<redacted>&b=2`);
    expect(result.config.body).not.toContain(TOKEN);
  });

  test("/v1/health and /v1/health/sync carry no token (also when the sync state is unreadable)", () => {
    // This database has the app migrations only, not the runtime's sync
    // tables, so /v1/health reports "error" and /v1/health/sync fails: the
    // error path must not leak the endpoints either.
    expect(result.health.status).toBe(200);
    expect(JSON.parse(result.health.body).status).toBe("error");
    expect(result.health.body + result.healthSync.body).not.toContain(TOKEN);
  });

  test("nothing the child printed carries the token", () => {
    expect(stdout + stderr).not.toContain(TOKEN);
  });
});
