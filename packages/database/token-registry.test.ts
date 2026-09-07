import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import pg from "pg";
import { closeTestPglite } from "./test-pglite.ts";
import { migrationTable } from "./migration-order.ts";
import { applyCanonicalRegistry, validateCanonicalRegistry } from "./token-registry.ts";
import {
  registryUrl,
  runOptionalRegistryImport,
  type RegistryImportConfig,
} from "./import-token-registry.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const TOKEN_DEFINITIONS = [
  ["twBTC", "Test-wrapped BTC", 8, "shielded", "1", "100000000"],
  ["twETH", "Test-wrapped ETH", 18, "shielded", "5", "5000000000000000000"],
  ["twUSDC", "Test-wrapped USDC", 6, "shielded", "10000", "10000000000"],
  ["twUSDM", "Test-wrapped USDM", 6, "shielded", "10000", "10000000000"],
  ["utwUSDC", "Unshielded-test-wrapped USDC", 6, "unshielded", "10000", "10000000000"],
  ["utwBTC", "Unshielded-test-wrapped BTC", 8, "unshielded", "1", "100000000"],
] as const;

const network = (key = "preprod") => ({
  key,
  displayName: key[0]!.toUpperCase() + key.slice(1),
  protocolFamily: key === "stagenet" ? "midnight-2.x" : "midnight-1.x",
  networkId: key,
  chainId: `Midnight ${key}`,
  stackIdentity: `${key}-stack`,
});

const compatibility = (key = "preprod") => ({
  profile: key === "stagenet" ? "v2" : "v1",
  compiler: "0.31.1",
  compactRuntime: "0.16.0",
  ledger: "8.1.0",
  midnightJs: "4.1.1",
  walletSdk: "1.2.0",
});

function deployment(symbol: string, index: number, key = "preprod") {
  return {
    deploymentId: `${symbol}:${index}`,
    status: "active",
    contractAddress: (100 + index).toString(16).padStart(64, "0"),
    tokenId: index.toString(16).padStart(64, "0"),
    deploymentTransaction: (200 + index).toString(16).padStart(64, "0"),
    deployedAt: "2026-09-07T12:00:00.000Z",
    verifiedAt: "2026-09-07T12:01:00.000Z",
    network: network(key),
    compatibility: compatibility(key),
    deploymentToolchain: { runner: "test", runnerVersion: "1", walletSdk: "1.2.0" },
    confirmation: { blockHeight: String(index), blockHash: `block-${index}` },
    maintenanceAuthority: { status: "retained", address: `authority-${index}` },
    artifact: {
      sourceRevision: "a".repeat(40),
      compilerVersion: "0.31.1",
      artifactSha256: "b".repeat(64),
      openZeppelinRelease: null,
    },
  };
}

function readyRegistry(key = "preprod", offset = 0): any {
  return {
    schemaVersion: "1.0.0",
    registryRevision: `revision-${key}-${offset}`,
    status: "ready",
    generatedAt: "2026-09-07T12:02:00.000Z",
    network: network(key),
    compatibility: compatibility(key),
    tokens: TOKEN_DEFINITIONS.map(([symbol, name, decimals, privacy, humanAmount, baseUnits], index) => ({
      symbol,
      name,
      decimals,
      privacy,
      domainSeparator: `mint-test-tokens:${symbol}`,
      faucet: { humanAmount, baseUnits },
      activeDeploymentId: `${symbol}:${index + 1 + offset}`,
      deployments: [deployment(symbol, index + 1 + offset, key)],
    })),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) return reject(new Error("no TCP port"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

describe("canonical registry validation", () => {
  test("accepts exactly six active canonical tokens with 8/18/6 decimal metadata", () => {
    const result = validateCanonicalRegistry(readyRegistry(), "preprod");
    expect(result.tokens.map((token) => [token.name, token.decimals, token.kind, token.assetId])).toEqual([
      ["TWBTC", 8, "shielded", "bitcoin"],
      ["TWETH", 18, "shielded", "ethereum"],
      ["TWUSDC", 6, "shielded", "usd-coin"],
      ["TWUSDM", 6, "shielded", "usdm-2"],
      ["UTWUSDC", 6, "unshielded", "usd-coin"],
      ["UTWBTC", 8, "unshielded", "bitcoin"],
    ]);
  });

  test("accepts superseded history from a prior stack identity", () => {
    const registry = readyRegistry();
    const superseded = clone(registry.tokens[0].deployments[0]);
    superseded.deploymentId = "twBTC:prior-stack";
    superseded.status = "superseded";
    superseded.network.stackIdentity = "prior-preprod-stack";
    superseded.network.chainId = "prior-preprod-chain";
    superseded.tokenId = "f".repeat(64);
    registry.tokens[0].deployments.unshift(superseded);
    expect(validateCanonicalRegistry(registry, "preprod").tokens).toHaveLength(6);
  });

  test("rejects unavailable, wrong-network, malformed and ambiguous registries", () => {
    const unavailable = readyRegistry();
    unavailable.status = "unavailable";
    expect(() => validateCanonicalRegistry(unavailable, "preprod")).toThrow(/status.*ready/);

    expect(() => validateCanonicalRegistry(readyRegistry("preview"), "preprod")).toThrow(/network.key.*preprod/);

    const malformed = readyRegistry();
    malformed.tokens[0].decimals = 6;
    expect(() => validateCanonicalRegistry(malformed, "preprod")).toThrow(/twBTC.decimals/);

    const ambiguous = readyRegistry();
    const second = clone(ambiguous.tokens[0].deployments[0]);
    second.deploymentId = "twBTC:ambiguous";
    second.tokenId = "f".repeat(64);
    ambiguous.tokens[0].deployments.push(second);
    expect(() => validateCanonicalRegistry(ambiguous, "preprod")).toThrow(/exactly one active/);

    const duplicateId = readyRegistry();
    const duplicate = clone(duplicateId.tokens[0].deployments[0]);
    duplicate.status = "superseded";
    duplicateId.tokens[0].deployments.push(duplicate);
    expect(() => validateCanonicalRegistry(duplicateId, "preprod")).toThrow(/duplicate deploymentId/);
  });
});

describe("transactional canonical registry import", () => {
  let handle: Awaited<ReturnType<typeof import("@effectstream/db/start-pglite")["startPglite"]>>;
  let client: InstanceType<typeof pg.Client>;

  beforeAll(async () => {
    const port = await freePort();
    const { startPglite } = await import("@effectstream/db/start-pglite");
    handle = await startPglite(port);
    client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
    await client.connect();
    for (const migration of migrationTable) await client.query(migration.sql);
  });

  beforeEach(async () => {
    await client.query(
      `CREATE TABLE IF NOT EXISTS canonical_token_registry_state (
         name TEXT PRIMARY KEY,
         token_color TEXT UNIQUE NOT NULL,
         network TEXT NOT NULL CHECK (network IN ('preview', 'preprod', 'stagenet')),
         registry_revision TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    await client.query("DELETE FROM canonical_token_registry_state");
    await client.query("DELETE FROM known_tokens WHERE name LIKE 'TW%' OR name LIKE 'UTW%' OR name = 'LOCALONLY'");
    await client.query("DELETE FROM token_prices");
    await client.query("DELETE FROM offer_file_tokens_history WHERE offer_file_id = 7");
  });

  afterAll(async () => closeTestPglite(handle, client));

  test("imports, repeats idempotently, replaces rows and preserves unrelated/history/manual-price data", async () => {
    const first = validateCanonicalRegistry(readyRegistry(), "preprod");
    await applyCanonicalRegistry(client, first);
    const firstRows = (await client.query(
      "SELECT token_color, name, kind, decimals, asset_id FROM known_tokens WHERE name LIKE 'TW%' OR name LIKE 'UTW%' ORDER BY name",
    )).rows;
    expect(firstRows).toHaveLength(6);
    expect(firstRows.find((row) => row.name === "TWBTC")?.decimals).toBe(8);
    expect(firstRows.find((row) => row.name === "TWETH")?.decimals).toBe(18);
    expect(firstRows.find((row) => row.name === "TWUSDC")?.decimals).toBe(6);
    expect((await client.query("SELECT name, token_color, network, registry_revision FROM canonical_token_registry_state")).rows)
      .toHaveLength(6);

    await applyCanonicalRegistry(client, first);
    expect((await client.query(
      "SELECT token_color, name, kind, decimals, asset_id FROM known_tokens WHERE name LIKE 'TW%' OR name LIKE 'UTW%' ORDER BY name",
    )).rows).toEqual(firstRows);

    // A fresh SQL seed can be adopted without provenance only when every
    // existing field exactly matches the incoming canonical record.
    await client.query("DELETE FROM canonical_token_registry_state");
    await applyCanonicalRegistry(client, first);
    expect((await client.query("SELECT * FROM canonical_token_registry_state")).rows).toHaveLength(6);

    const oldTwbtc = first.tokens[0]!.tokenColor;
    await client.query(
      "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1, 'LOCALONLY', 'shielded', 6, NULL)",
      ["e".repeat(64)],
    );
    await client.query(
      "INSERT INTO token_prices (token_color, price_usd, source) VALUES ($1, 42, 'manual')",
      [oldTwbtc],
    );
    await client.query(
      "INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at) VALUES (7, $1, '10', 'GIVING', 'SHIELDED', NOW())",
      [oldTwbtc],
    );

    const replacement = validateCanonicalRegistry(readyRegistry("preprod", 20), "preprod");
    await applyCanonicalRegistry(client, replacement);
    expect((await client.query("SELECT token_color FROM known_tokens WHERE name = 'TWBTC'")).rows[0]?.token_color)
      .toBe(replacement.tokens[0]!.tokenColor);
    expect((await client.query("SELECT token_color FROM known_tokens WHERE name = 'LOCALONLY'")).rows[0]?.token_color)
      .toBe("e".repeat(64));
    expect((await client.query("SELECT price_usd, source FROM token_prices WHERE token_color = $1", [oldTwbtc])).rows[0])
      .toMatchObject({ price_usd: "42", source: "manual" });
    expect((await client.query("SELECT token_color FROM offer_file_tokens_history WHERE offer_file_id = 7")).rows[0]?.token_color)
      .toBe(oldTwbtc);
  });

  test("an unrelated color collision rolls the complete replacement back", async () => {
    await client.query(
      "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1, 'LOCALONLY', 'shielded', 6, NULL)",
      ["e".repeat(64)],
    );
    await applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry("preprod", 20), "preprod"));
    const before = (await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows;
    const collision = readyRegistry("preprod", 40);
    collision.tokens[1].deployments[0].tokenId = "e".repeat(64);
    const validated = validateCanonicalRegistry(collision, "preprod");
    await expect(applyCanonicalRegistry(client, validated)).rejects.toThrow(/collision.*LOCALONLY/);
    const after = (await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows;
    expect(after).toEqual(before);
  });

  test("an unrelated same-name row rolls back without being claimed", async () => {
    await client.query(
      "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1, 'TWBTC', 'shielded', 6, NULL)",
      ["d".repeat(64)],
    );
    const before = (await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows;
    await expect(
      applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry(), "preprod")),
    ).rejects.toThrow(/name collision.*TWBTC/);
    expect((await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows)
      .toEqual(before);
    expect((await client.query("SELECT * FROM canonical_token_registry_state")).rows).toHaveLength(0);
  });

  test("a managed Preprod registry can be replaced by Preview atomically", async () => {
    const preprod = validateCanonicalRegistry(readyRegistry("preprod", 60), "preprod");
    const preview = validateCanonicalRegistry(readyRegistry("preview", 80), "preview");
    await applyCanonicalRegistry(client, preprod);
    await applyCanonicalRegistry(client, preview);
    const rows = (await client.query(
      "SELECT name, token_color FROM known_tokens WHERE name LIKE 'TW%' OR name LIKE 'UTW%' ORDER BY name",
    )).rows;
    expect(rows.map((row) => row.token_color).sort()).toEqual(preview.tokens.map((token) => token.tokenColor).sort());
    const state = (await client.query("SELECT DISTINCT network, registry_revision FROM canonical_token_registry_state")).rows;
    expect(state).toEqual([{ network: "preview", registry_revision: preview.revision }]);
  });

  test("a manually changed managed row is rejected and remains unchanged", async () => {
    await applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry("preprod", 100), "preprod"));
    await client.query("UPDATE known_tokens SET token_color = $1 WHERE name = 'TWBTC'", ["c".repeat(64)]);
    const before = (await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows;
    await expect(
      applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry("preview", 120), "preview")),
    ).rejects.toThrow(/TWBTC.*provenance/);
    expect((await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows)
      .toEqual(before);
  });

  test("an existing database without the provenance table is upgraded inside the successful transaction", async () => {
    await client.query("DROP TABLE canonical_token_registry_state");
    await applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry(), "preprod"));
    expect((await client.query("SELECT name FROM canonical_token_registry_state")).rows).toHaveLength(6);
  });

  test("an existing database does not retain compatibility DDL after a rejected import", async () => {
    await client.query("DROP TABLE canonical_token_registry_state");
    await client.query(
      "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1, 'TWBTC', 'shielded', 6, NULL)",
      ["d".repeat(64)],
    );
    await expect(
      applyCanonicalRegistry(client, validateCanonicalRegistry(readyRegistry(), "preprod")),
    ).rejects.toThrow(/name collision.*TWBTC/);
    expect((await client.query("SELECT to_regclass('canonical_token_registry_state') AS table_name")).rows[0]?.table_name)
      .toBeNull();
  });
});

describe("optional fetch failure", () => {
  const config = (baseUrl: string, timeoutMs = 75): RegistryImportConfig => ({
    baseUrl,
    network: "preprod",
    timeoutMs,
    db: { host: "127.0.0.1", port: 5432, user: "postgres", password: "postgres", database: "postgres" },
  });

  test("builds the selected metadata path", () => {
    expect(registryUrl("https://example.test/base", "preview")).toBe("https://example.test/base/metadata.preview.json");
  });

  test("refused connection is bounded and resolves as skipped", async () => {
    const port = await freePort();
    const started = performance.now();
    const outcome = await runOptionalRegistryImport(config(`http://127.0.0.1:${port}/`));
    expect(outcome.status).toBe("skipped");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("stalled response body is aborted and resolves as skipped", async () => {
    const port = await freePort();
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue("{"); } })),
    });
    try {
      const started = performance.now();
      const outcome = await runOptionalRegistryImport(config(`http://127.0.0.1:${port}/`, 30));
      expect(outcome.status).toBe("skipped");
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test("HTTP error, invalid JSON and unavailable metadata all resolve as skipped", async () => {
    for (const response of [
      new Response("down", { status: 503 }),
      new Response("{invalid", { status: 200 }),
      Response.json({ ...readyRegistry(), status: "unavailable" }),
    ]) {
      const outcome = await runOptionalRegistryImport(config("https://example.test/"), {
        fetchImpl: async () => response,
      });
      expect(outcome.status).toBe("skipped");
    }
  });

  test("an explicit local network skips without fetching", async () => {
    let fetched = false;
    const outcome = await runOptionalRegistryImport({ ...config("https://example.test/"), network: "undeployed" }, {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    });
    expect(outcome).toEqual({
      status: "skipped",
      reason: "undeployed is a local network with no public canonical registry",
    });
    expect(fetched).toBe(false);
  });
});
