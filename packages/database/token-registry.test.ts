import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import pg from "pg";
import { closeTestPglite } from "./test-pglite.ts";
import { migrationTable } from "./migration-order.ts";
import { tokenPriceFromAsset } from "./price-map.ts";
import {
  applyCanonicalRegistry,
  readRegistryLabel,
  REGISTRY_NETWORKS,
  validateCanonicalRegistry,
  type RegistryNetwork,
} from "./token-registry.ts";
import {
  EXIT_NOTHING_TO_IMPORT,
  loadRegistryImportConfig,
  registrySourceFor,
  registryUrl,
  runRegistryImport,
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

const NIGHT_ROW = {
  token_color: "0".repeat(64),
  name: "NIGHT",
  kind: "unshielded",
  decimals: 6,
  asset_id: "midnight-3",
};

const network = (key = "preprod") => ({
  key,
  displayName: key[0]!.toUpperCase() + key.slice(1),
  protocolFamily: "midnight-2.x",
  networkId: key,
  chainId: `Midnight ${key}`,
  stackIdentity: `${key}-stack`,
});

const compatibility = () => ({
  profile: "v2",
  compiler: "0.36.0",
  compactRuntime: "0.21.0",
  ledger: "1.0.0",
  midnightJs: "5.0.0",
  walletSdk: "2.0.0",
});

function deployment(symbol: string, index: number, key = "preprod") {
  return {
    deploymentId: `${symbol}:${index}`,
    status: "active",
    contractAddress: (100 + index).toString(16).padStart(64, "0"),
    tokenId: index.toString(16).padStart(64, "0"),
    deploymentTransaction: (200 + index).toString(16).padStart(64, "0"),
    deployedAt: "2026-11-09T12:00:00.000Z",
    verifiedAt: "2026-11-09T12:01:00.000Z",
    network: network(key),
    compatibility: compatibility(),
    deploymentToolchain: { runner: "test", runnerVersion: "1", walletSdk: "2.0.0" },
    confirmation: { blockHeight: String(index), blockHash: `block-${index}` },
    maintenanceAuthority: { status: "retained", address: `authority-${index}` },
    artifact: {
      sourceRevision: "a".repeat(40),
      compilerVersion: "0.36.0",
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
    generatedAt: "2026-11-09T12:02:00.000Z",
    network: network(key),
    compatibility: compatibility(),
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

const V2_FIXTURE = new URL("./fixtures/registry-v2.preprod.synthetic.json", import.meta.url);
const V2_FIXTURE_REVISION = "09cfd670d5670755d49e9162ba268166f78713f75bb518539dcf9165aecd4ce0";

/** The synthetic ledger-9 registry document, labelled for `key`. */
async function v2Registry(key: RegistryNetwork = "preprod"): Promise<any> {
  const document = (await Bun.file(V2_FIXTURE).json()) as any;
  const relabel = (target: any) => {
    target.key = key;
    target.networkId = key;
    target.displayName = key[0]!.toUpperCase() + key.slice(1);
    target.chainId = `Midnight ${target.displayName}`;
  };
  relabel(document.network);
  for (const token of document.tokens) for (const d of token.deployments) relabel(d.network);
  return document;
}

/**
 * The same document labelled the way the published preview and preprod
 * registries were on 2026-11-09: Midnight 1.x, profile v1, ledger 8.1.0.
 */
async function v1Registry(key: RegistryNetwork): Promise<any> {
  const document = await v2Registry(key);
  const relabel = (net: any, compat: any) => {
    net.protocolFamily = "midnight-1.x";
    compat.profile = "v1";
    compat.ledger = "8.1.0";
  };
  relabel(document.network, document.compatibility);
  for (const token of document.tokens) for (const d of token.deployments) relabel(d.network, d.compatibility);
  return document;
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

async function withFreshDatabase(
  run: (client: InstanceType<typeof pg.Client>, port: number) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const { startPglite } = await import("@effectstream/db/start-pglite");
  const handle = await startPglite(port);
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  try {
    await client.connect();
    for (const migration of migrationTable) await client.query(migration.sql);
    await run(client, port);
  } finally {
    await closeTestPglite(handle, client);
  }
}

/** A local registry host serving `documents` by network, 404 for anything else. */
function serveRegistry(documents: Partial<Record<RegistryNetwork, unknown>>) {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      requested.push(path);
      const match = /^\/metadata\.([a-z]+)\.json$/.exec(path);
      const document = match ? documents[match[1] as RegistryNetwork] : undefined;
      return document === undefined ? new Response("not found", { status: 404 }) : Response.json(document);
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}/`, requested };
}

const importConfig = (
  baseUrl: string,
  selected: RegistryImportConfig["network"],
  databasePort = 5432,
  timeoutMs = 2_000,
): RegistryImportConfig => ({
  baseUrl,
  network: selected,
  timeoutMs,
  db: { host: "127.0.0.1", port: databasePort, user: "postgres", password: "postgres", database: "postgres" },
});

const knownTokens = async (client: InstanceType<typeof pg.Client>) =>
  (await client.query("SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name")).rows;
const registryState = async (client: InstanceType<typeof pg.Client>) =>
  (await client.query(
    "SELECT name, token_color, network, registry_revision FROM canonical_token_registry_state ORDER BY name",
  )).rows;

const noDatabase = () => {
  throw new Error("must not open a database connection");
};

describe("canonical registry validation", () => {
  test("accepts the synthetic ledger-9 registry for preview and preprod", async () => {
    for (const key of ["preprod", "preview"] as const) {
      const registry = validateCanonicalRegistry(await v2Registry(key), key);
      expect(registry).toMatchObject({ network: key, revision: V2_FIXTURE_REVISION });
      expect(registry.tokens).toHaveLength(6);
    }
  });

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

  test("accepts superseded history from a prior stack identity, including a ledger-8 deployment", () => {
    const registry = readyRegistry();
    const superseded = clone(registry.tokens[0].deployments[0]);
    superseded.deploymentId = "twBTC:prior-stack";
    superseded.status = "superseded";
    superseded.network.stackIdentity = "prior-preprod-stack";
    superseded.network.chainId = "prior-preprod-chain";
    superseded.network.protocolFamily = "midnight-1.x";
    superseded.compatibility.profile = "v1";
    superseded.tokenId = "f".repeat(64);
    registry.tokens[0].deployments.unshift(superseded);
    expect(validateCanonicalRegistry(registry, "preprod").tokens).toHaveLength(6);
  });

  test("rejects a document that is not labelled for ledger 9, even when called directly", async () => {
    expect(() => validateCanonicalRegistry(readyRegistry("preprod"), "preprod")).not.toThrow();
    for (const key of ["preview", "preprod"] as const) {
      const document = await v1Registry(key);
      expect(() => validateCanonicalRegistry(document, key)).toThrow(/network.protocolFamily.*midnight-2\.x/);
    }
    const profileOnly = readyRegistry();
    profileOnly.compatibility.profile = "v1";
    expect(() => validateCanonicalRegistry(profileOnly, "preprod")).toThrow(/compatibility.profile.*v2/);
  });

  test("an active deployment from a removed network key is refused", () => {
    const registry = readyRegistry();
    registry.tokens[0].deployments[0].network.key = "stagenet";
    expect(() => validateCanonicalRegistry(registry, "preprod")).toThrow(/network.key is invalid/);
  });

  test("rejects unavailable, wrong-network, malformed and ambiguous registries", () => {
    const unavailable = readyRegistry();
    unavailable.status = "unavailable";
    expect(() => validateCanonicalRegistry(unavailable, "preprod")).toThrow(/status.*ready/);

    expect(() => validateCanonicalRegistry(readyRegistry("preview"), "preprod")).toThrow(/network.key.*preprod/);
    expect(() => validateCanonicalRegistry(readyRegistry("preprod"), "mainnet")).toThrow(/network.key.*mainnet/);

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

  test("reads a document's label without validating the rest", async () => {
    expect(readRegistryLabel(await v1Registry("preview"))).toEqual({ protocolFamily: "midnight-1.x", profile: "v1" });
    expect(readRegistryLabel(await v2Registry("preprod"))).toEqual({ protocolFamily: "midnight-2.x", profile: "v2" });
    expect(readRegistryLabel({ network: { protocolFamily: "midnight-2.x" } })).toEqual({
      protocolFamily: "midnight-2.x",
      profile: null,
    });
    for (const unlabelled of [null, [], "x", {}, { network: {} }, { network: { protocolFamily: "" } }]) {
      expect(readRegistryLabel(unlabelled)).toBeNull();
    }
  });
});

describe("fresh database defaults", () => {
  test("a fresh database lists NIGHT only and holds no registry provenance", async () => {
    await withFreshDatabase(async (client) => {
      expect(await knownTokens(client)).toEqual([NIGHT_ROW]);
      expect(await registryState(client)).toEqual([]);
    });
  });

  test("the network CHECK accepts preview, preprod and mainnet and refuses stagenet and undeployed", async () => {
    await withFreshDatabase(async (client) => {
      const insert = (name: string, net: string) =>
        client.query(
          "INSERT INTO canonical_token_registry_state (name, token_color, network, registry_revision) VALUES ($1, $2, $3, 'r')",
          [name, name.toLowerCase().padEnd(64, "0"), net],
        );
      for (const net of REGISTRY_NETWORKS) await insert(`A${net.toUpperCase()}`, net);
      for (const net of ["stagenet", "undeployed"]) {
        await expect(insert(`B${net.toUpperCase()}`, net)).rejects.toThrow(/check constraint/);
      }
      expect((await registryState(client)).map((row) => row.network).sort()).toEqual(["mainnet", "preprod", "preview"]);
    });
  });

  test("the importer's own table definition (a database without the table) has the same CHECK", async () => {
    await withFreshDatabase(async (client) => {
      await client.query("DROP TABLE canonical_token_registry_state");
      await applyCanonicalRegistry(client, validateCanonicalRegistry(await v2Registry("preprod"), "preprod"));
      await client.query(
        "INSERT INTO canonical_token_registry_state (name, token_color, network, registry_revision) VALUES ('M', $1, 'mainnet', 'r')",
        ["c".repeat(64)],
      );
      await expect(
        client.query(
          "INSERT INTO canonical_token_registry_state (name, token_color, network, registry_revision) VALUES ('S', $1, 'stagenet', 'r')",
          ["d".repeat(64)],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });
});

describe("per-network import (registry source → database)", () => {
  test("preview with a 1.x-labelled file: skipped with one reason naming the network and the file, nothing imported", async () => {
    const registry = serveRegistry({ preview: await v1Registry("preview") });
    try {
      await withFreshDatabase(async (client, databasePort) => {
        const outcome = await runRegistryImport(importConfig(registry.baseUrl, "preview", databasePort), {
          createClient: noDatabase,
        });
        expect(outcome).toEqual({
          status: "skipped",
          network: "preview",
          reason:
            `preview registry file ${registry.baseUrl}metadata.preview.json is labelled midnight-1.x (profile v1); ` +
            "only midnight-2.x registries are imported; nothing imported",
        });
        expect(registry.requested).toEqual(["/metadata.preview.json"]);
        expect(await knownTokens(client)).toEqual([NIGHT_ROW]);
        expect(await registryState(client)).toEqual([]);
      });
    } finally {
      registry.server.stop(true);
    }
  });

  test("preprod with a 1.x-labelled file is skipped the same way", async () => {
    const registry = serveRegistry({ preprod: await v1Registry("preprod") });
    try {
      const outcome = await runRegistryImport(importConfig(registry.baseUrl, "preprod"), { createClient: noDatabase });
      expect(outcome.status).toBe("skipped");
      expect(outcome.status === "skipped" && outcome.reason).toContain(
        `preprod registry file ${registry.baseUrl}metadata.preprod.json is labelled midnight-1.x`,
      );
    } finally {
      registry.server.stop(true);
    }
  });

  test("a missing file (404) is skipped naming the network and the file", async () => {
    const registry = serveRegistry({});
    try {
      for (const key of ["preview", "preprod"] as const) {
        const outcome = await runRegistryImport(importConfig(registry.baseUrl, key), { createClient: noDatabase });
        expect(outcome).toEqual({
          status: "skipped",
          network: key,
          reason: `${key} registry file ${registry.baseUrl}metadata.${key}.json is missing (HTTP 404); nothing imported`,
        });
      }
    } finally {
      registry.server.stop(true);
    }
  });

  test("preprod with the 2.x fixture: imports the six tokens at their published price scales", async () => {
    const document = await v2Registry("preprod");
    const registry = serveRegistry({ preprod: document });
    try {
      await withFreshDatabase(async (client, databasePort) => {
        const outcome = await runRegistryImport(importConfig(registry.baseUrl, "preprod", databasePort));
        expect(outcome).toEqual({
          status: "applied",
          network: "preprod",
          revision: V2_FIXTURE_REVISION,
          source: `${registry.baseUrl}metadata.preprod.json`,
        });
        const expected = validateCanonicalRegistry(document, "preprod");
        const rows = await knownTokens(client);
        expect(rows.find((row) => row.name === "NIGHT")).toEqual(NIGHT_ROW);
        expect(rows.filter((row) => row.name !== "NIGHT")).toEqual(
          expected.tokens
            .map((token) => ({
              token_color: token.tokenColor,
              name: token.name,
              kind: token.kind,
              decimals: token.decimals,
              asset_id: token.assetId,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        expect(await registryState(client)).toEqual(
          expected.tokens
            .map((token) => ({
              name: token.name,
              token_color: token.tokenColor,
              network: "preprod",
              registry_revision: V2_FIXTURE_REVISION,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );

        const prices = new Map((await client.query(
          `SELECT kt.name, kt.decimals, ap.price_usd
             FROM known_tokens kt
             JOIN asset_prices ap ON ap.asset_id = kt.asset_id`,
        )).rows.map((row) => [String(row.name), tokenPriceFromAsset(String(row.price_usd), Number(row.decimals))]));
        expect(prices.get("TWBTC")).toBe("0.00077387");
        expect(prices.get("TWETH")).toBe("0.00000000000000239328");
        expect(prices.get("TWUSDC")).toBe("0.000000999818");
        expect(prices.get("TWUSDM")).toBe("0.000001001");
        expect(prices.get("UTWUSDC")).toBe("0.000000999818");
        expect(prices.get("UTWBTC")).toBe("0.00077387");
      });
    } finally {
      registry.server.stop(true);
    }
  });

  test("preview with a 2.x file imports too, and a repeat import is a no-op", async () => {
    const registry = serveRegistry({ preview: await v2Registry("preview") });
    try {
      await withFreshDatabase(async (client, databasePort) => {
        const config = importConfig(registry.baseUrl, "preview", databasePort);
        expect((await runRegistryImport(config)).status).toBe("applied");
        const first = { known: await knownTokens(client), state: await registryState(client) };
        expect(first.known).toHaveLength(7);
        expect(new Set(first.state.map((row) => row.network))).toEqual(new Set(["preview"]));
        expect((await runRegistryImport(config)).status).toBe("applied");
        expect({ known: await knownTokens(client), state: await registryState(client) }).toEqual(first);
      });
    } finally {
      registry.server.stop(true);
    }
  });

  test("mainnet has no source: skipped without fetching or connecting, and NIGHT is the only token", async () => {
    await withFreshDatabase(async (client) => {
      let fetched = false;
      const outcome = await runRegistryImport(importConfig("https://registry.invalid/", "mainnet"), {
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
        createClient: noDatabase,
      });
      expect(outcome).toEqual({
        status: "skipped",
        network: "mainnet",
        reason: "mainnet has no canonical token source yet; NIGHT is the only token listed there",
      });
      expect(fetched).toBe(false);
      expect(await knownTokens(client)).toEqual([NIGHT_ROW]);
    });
  });

  test("undeployed (a local chain) is skipped without fetching", async () => {
    let fetched = false;
    const outcome = await runRegistryImport(importConfig("https://registry.invalid/", "undeployed"), {
      fetchImpl: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      createClient: noDatabase,
    });
    expect(outcome).toEqual({
      status: "skipped",
      network: "undeployed",
      reason: "undeployed is a local network with no public canonical registry",
    });
    expect(fetched).toBe(false);
  });

  test("an unreachable registry fails and leaves the database unchanged", async () => {
    await withFreshDatabase(async (client, databasePort) => {
      const unavailablePort = await freePort();
      const outcome = await runRegistryImport(
        importConfig(`http://127.0.0.1:${unavailablePort}/`, "preprod", databasePort, 75),
      );
      expect(outcome.status).toBe("failed");
      expect(await knownTokens(client)).toEqual([NIGHT_ROW]);
      expect(await registryState(client)).toEqual([]);
    });
  });

  test("a 2.x file for the wrong network fails as invalid instead of being imported", async () => {
    const registry = serveRegistry({ preview: await v2Registry("preprod") });
    try {
      const outcome = await runRegistryImport(importConfig(registry.baseUrl, "preview"), { createClient: noDatabase });
      expect(outcome.status).toBe("failed");
      expect(outcome.status === "failed" && outcome.reason).toMatch(
        /^preview registry file .*metadata\.preview\.json is invalid: network\.key must be "preview"$/,
      );
    } finally {
      registry.server.stop(true);
    }
  });
});

describe("registry sources and configuration", () => {
  test("each network has its source: a file for preview and preprod, none for mainnet and undeployed", () => {
    expect(registrySourceFor("preview", "https://example.test/base")).toEqual({
      kind: "registry-file",
      network: "preview",
      url: "https://example.test/base/metadata.preview.json",
    });
    expect(registrySourceFor("preprod", "https://example.test/")).toEqual({
      kind: "registry-file",
      network: "preprod",
      url: "https://example.test/metadata.preprod.json",
    });
    expect(registrySourceFor("mainnet", "https://example.test/")).toMatchObject({ kind: "none", network: "mainnet" });
    expect(registrySourceFor("undeployed", "https://example.test/")).toMatchObject({ kind: "none", network: "undeployed" });
    expect(registryUrl("https://example.test/base", "preview")).toBe("https://example.test/base/metadata.preview.json");
  });

  test("the network follows TOKEN_REGISTRY_NETWORK, then MIDNIGHT_NETWORK_ID, then the kernel's default undeployed", () => {
    expect(loadRegistryImportConfig({}).network).toBe("undeployed");
    expect(loadRegistryImportConfig({ MIDNIGHT_NETWORK_ID: "mainnet" }).network).toBe("mainnet");
    expect(loadRegistryImportConfig({ MIDNIGHT_NETWORK_ID: "preview", TOKEN_REGISTRY_NETWORK: "preprod" }).network)
      .toBe("preprod");
    expect(loadRegistryImportConfig({ MIDNIGHT_NETWORK_ID: "preview", TOKEN_REGISTRY_NETWORK: "" }).network)
      .toBe("preview");
  });

  test("stagenet and unknown networks are refused naming the supported list", () => {
    for (const env of [{ TOKEN_REGISTRY_NETWORK: "stagenet" }, { MIDNIGHT_NETWORK_ID: "testnet-02" }]) {
      expect(() => loadRegistryImportConfig(env)).toThrow(
        /TOKEN_REGISTRY_NETWORK must be one of preview, preprod, mainnet, undeployed/,
      );
    }
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
         network TEXT NOT NULL CHECK (network IN ('preview', 'preprod', 'mainnet')),
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

    // Rows can be adopted without provenance only when every existing field
    // exactly matches the incoming canonical record.
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
    expect((await client.query("SELECT name FROM known_tokens WHERE name = 'NIGHT'")).rows).toHaveLength(1);
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

describe("fetch failures", () => {
  test("refused connection is bounded and resolves as failed", async () => {
    const port = await freePort();
    const started = performance.now();
    const outcome = await runRegistryImport(importConfig(`http://127.0.0.1:${port}/`, "preprod", 5432, 75));
    expect(outcome.status).toBe("failed");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("stalled response body is aborted and resolves as failed", async () => {
    const port = await freePort();
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue("{"); } })),
    });
    try {
      const started = performance.now();
      const outcome = await runRegistryImport(importConfig(`http://127.0.0.1:${port}/`, "preprod", 5432, 30));
      expect(outcome.status).toBe("failed");
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      server.stop(true);
    }
  });

  test("HTTP error, invalid JSON, an unlabelled document and unavailable metadata all resolve as failed", async () => {
    for (const response of [
      new Response("down", { status: 503 }),
      new Response("{invalid", { status: 200 }),
      Response.json({ schemaVersion: "1.0.0" }),
      Response.json({ ...readyRegistry(), status: "unavailable" }),
    ]) {
      const outcome = await runRegistryImport(importConfig("https://example.test/", "preprod"), {
        fetchImpl: async () => response,
        createClient: noDatabase,
      });
      expect(outcome.status).toBe("failed");
    }
  });
});

describe("import-token-registry CLI", () => {
  const cli = new URL("./import-token-registry.ts", import.meta.url);
  const run = async (args: string[], vars: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, "run", Bun.fileURLToPath(cli), ...args], {
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...vars },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

  test("preview with the published 1.x file: one warning naming the network and the file; exit 3 with --required, 0 without", async () => {
    const registry = serveRegistry({ preview: await v1Registry("preview") });
    try {
      const expected =
        `[token-registry] skipped: preview registry file ${registry.baseUrl}metadata.preview.json ` +
        "is labelled midnight-1.x (profile v1); only midnight-2.x registries are imported; nothing imported";
      for (const [args, code] of [[["--required"], EXIT_NOTHING_TO_IMPORT], [[], 0]] as const) {
        const result = await run([...args], {
          TOKEN_REGISTRY_NETWORK: "preview",
          TOKEN_REGISTRY_BASE_URL: registry.baseUrl,
          // Nothing listens here: a skipped import must never connect.
          DB_HOST: "127.0.0.1",
          DB_PORT: String(await freePort()),
        });
        expect(result.code, result.stderr).toBe(code);
        expect(lines(result.stderr)).toEqual([expected]);
        expect(result.stdout).toBe("");
      }
    } finally {
      registry.server.stop(true);
    }
  });

  test("mainnet: one warning, nothing fetched; exit 3 with --required", async () => {
    const registry = serveRegistry({});
    try {
      const result = await run(["--required"], { MIDNIGHT_NETWORK_ID: "mainnet", TOKEN_REGISTRY_BASE_URL: registry.baseUrl });
      expect(result.code).toBe(EXIT_NOTHING_TO_IMPORT);
      expect(lines(result.stderr)).toEqual([
        "[token-registry] skipped: mainnet has no canonical token source yet; NIGHT is the only token listed there",
      ]);
      expect(registry.requested).toEqual([]);
    } finally {
      registry.server.stop(true);
    }
  });

  test("an unreachable registry: exit 0 without --required, a loud failure (exit 1) with it", async () => {
    const port = await freePort();
    const vars = {
      TOKEN_REGISTRY_NETWORK: "preprod",
      TOKEN_REGISTRY_BASE_URL: `http://127.0.0.1:${port}/`,
      TOKEN_REGISTRY_TIMEOUT_MS: "200",
    };
    const optional = await run([], vars);
    expect(optional.code).toBe(0);
    expect(optional.stderr).toContain("[token-registry] failed (optional step, nothing imported):");
    const required = await run(["--required"], vars);
    expect(required.code).toBe(1);
    expect(required.stderr).toContain("[token-registry] FAILED (required import did not apply)");
  });

  test("a removed network (stagenet) is a configuration failure naming the supported networks", async () => {
    const result = await run(["--required"], { TOKEN_REGISTRY_NETWORK: "stagenet" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("TOKEN_REGISTRY_NETWORK must be one of preview, preprod, mainnet, undeployed");
  });

  test("with --required a served 2.x preprod registry applies to the database and exits 0", async () => {
    const registry = serveRegistry({ preprod: await v2Registry("preprod") });
    try {
      await withFreshDatabase(async (client, databasePort) => {
        const result = await run(["--required"], {
          TOKEN_REGISTRY_NETWORK: "preprod",
          TOKEN_REGISTRY_BASE_URL: registry.baseUrl,
          DB_HOST: "127.0.0.1",
          DB_PORT: String(databasePort),
        });
        expect(result.code, result.stderr).toBe(0);
        expect(lines(result.stdout)).toEqual([
          `[token-registry] applied network=preprod revision=${V2_FIXTURE_REVISION} source=${registry.baseUrl}metadata.preprod.json`,
        ]);
        expect(await knownTokens(client)).toHaveLength(7);
        expect(new Set((await registryState(client)).map((row) => row.network))).toEqual(new Set(["preprod"]));
      });
    } finally {
      registry.server.stop(true);
    }
  });
});
