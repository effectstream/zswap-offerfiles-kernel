// A stagenet database end to end (00050 FR-005, testing catalogue T5 + T6):
// the stagenet registry import replaces the seeded Preprod rows and removes
// the Preprod SNIGHT, and the extra-token route (POST /v1/known-tokens) works
// on a non-`undeployed` profile. The work runs in a child process — see
// test-support/stagenet-registry-child.ts for why.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PREPROD_SNIGHT_TOKEN_COLOR, validateCanonicalRegistry } from "@zswap-da/database";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A free loopback port, synchronously (the child runs at collection time). */
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

type Row = { name: string; token_color: string; kind?: string; decimals?: number };

describe("stagenet database: registry import + extra-token route (00050 T5/T6)", () => {
  // Synchronous on purpose: the child runs while the suite is collected, so no
  // per-hook timeout applies to its PGlite start-up.
  const port = freePort();
  const child = Bun.spawnSync(
    [process.execPath, "run", join(HERE, "test-support", "stagenet-registry-child.ts")],
    {
      cwd: HERE,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        MIDNIGHT_NETWORK_ID: "stagenet",
        ENABLE_TOKEN_REGISTRY: "true",
        EVENT_GATE_POLL_ENABLED: "false",
        DB_USER: "postgres",
        DB_NAME: "postgres",
        PGLITE_DATA_DIR: "memory://",
        TEST_PGLITE_PORT: String(port),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    },
  );
  const stdout = child.stdout.toString();
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  const result = line ? JSON.parse(line.slice("RESULT ".length)) : undefined;

  const expected = validateCanonicalRegistry(
    JSON.parse(readFileSync(join(HERE, "../database/fixtures/mint-test-tokens.stagenet.json"), "utf8")),
    "stagenet",
  );

  test("the child ran to completion", () => {
    expect(child.exitCode, `${stdout}\n${child.stderr.toString()}`).toBe(0);
    expect(result, stdout).toBeDefined();
  });

  test("the API is on the stagenet profile", () => {
    expect(result.networkId).toBe("stagenet");
  });

  test("a fresh database starts with the Preprod seeds, including Preprod SNIGHT", () => {
    const seeded = result.seeded as Row[];
    expect(seeded.find((r) => r.name === "SNIGHT")?.token_color).toBe(PREPROD_SNIGHT_TOKEN_COLOR);
    expect(seeded.find((r) => r.name === "TWBTC")?.token_color).toBe(
      "b11bd7c7ac94a584ef66e53e1ecd91a304cc452a5ad67399ae82e5919d2058dc",
    );
  });

  test("the stagenet import applies the vendored revision 59041d2f… from metadata.stagenet.json", () => {
    expect(result.outcome).toEqual({ status: "applied", network: "stagenet", revision: expected.revision });
    expect(expected.revision.startsWith("59041d2f")).toBe(true);
    expect(result.requestedUrls).toEqual(["https://mint-test-tokens.pages.dev/metadata.stagenet.json"]);
    expect(result.state).toEqual([{ network: "stagenet", registry_revision: expected.revision }]);
  });

  test("it replaces the six Preprod rows with the six stagenet tokens and their decimals", () => {
    const imported = result.imported as Row[];
    const canonical = imported.filter((r) => /^U?TW/.test(r.name));
    expect(canonical).toEqual(
      expected.tokens
        .map((t) => ({ name: t.name, token_color: t.tokenColor, kind: t.kind, decimals: t.decimals }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    const decimals = Object.fromEntries(canonical.map((r) => [r.name, r.decimals]));
    expect(decimals).toEqual({ TWBTC: 8, TWETH: 18, TWUSDC: 6, TWUSDM: 6, UTWBTC: 8, UTWUSDC: 6 });
  });

  test("the Preprod SNIGHT is gone on stagenet; native NIGHT stays", () => {
    const imported = result.imported as Row[];
    expect(imported.some((r) => r.name === "SNIGHT")).toBe(false);
    expect(imported.some((r) => r.token_color === PREPROD_SNIGHT_TOKEN_COLOR)).toBe(false);
    expect(imported.find((r) => r.name === "NIGHT")?.token_color).toBe("0".repeat(64));
    expect(imported).toHaveLength(7); // NIGHT + the six stagenet tokens
  });

  test("POST /v1/known-tokens registers an extra token on stagenet (the route 00053 uses)", () => {
    expect(result.post.status).toBe(200);
    expect(result.post.body).toEqual({
      success: true,
      color: "5a".repeat(32),
      name: "STKA",
      kind: "shielded",
      decimals: 6,
      asset_id: null,
    });
    expect(result.duplicate.status).toBe(409);
    const listed = result.listed as Row[];
    expect(listed.find((r) => r.name === "STKA")?.token_color).toBe("5a".repeat(32));
    expect(listed).toHaveLength(8);
  });
});
