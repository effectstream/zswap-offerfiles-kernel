export type RegistryNetwork = "preview" | "preprod" | "stagenet";

export type CanonicalToken = {
  symbol: CanonicalSymbol;
  name: string;
  kind: "shielded" | "unshielded";
  decimals: number;
  assetId: "bitcoin" | "ethereum" | "usd-coin" | "usdm-2";
  tokenColor: string;
};

export type ValidatedRegistry = {
  network: RegistryNetwork;
  revision: string;
  tokens: CanonicalToken[];
};

type CanonicalSymbol = keyof typeof CANONICAL_TOKENS;

type RegistryDbClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const HEX_32 = /^[0-9a-f]{64}$/i;
const HEX = /^[0-9a-f]+$/i;

const CANONICAL_TOKENS = {
  twBTC: {
    name: "TWBTC",
    registryName: "Test-wrapped BTC",
    kind: "shielded",
    decimals: 8,
    domainSeparator: "mint-test-tokens:twBTC",
    faucet: { humanAmount: "1", baseUnits: "100000000" },
    assetId: "bitcoin",
  },
  twETH: {
    name: "TWETH",
    registryName: "Test-wrapped ETH",
    kind: "shielded",
    decimals: 18,
    domainSeparator: "mint-test-tokens:twETH",
    faucet: { humanAmount: "5", baseUnits: "5000000000000000000" },
    assetId: "ethereum",
  },
  twUSDC: {
    name: "TWUSDC",
    registryName: "Test-wrapped USDC",
    kind: "shielded",
    decimals: 6,
    domainSeparator: "mint-test-tokens:twUSDC",
    faucet: { humanAmount: "10000", baseUnits: "10000000000" },
    assetId: "usd-coin",
  },
  twUSDM: {
    name: "TWUSDM",
    registryName: "Test-wrapped USDM",
    kind: "shielded",
    decimals: 6,
    domainSeparator: "mint-test-tokens:twUSDM",
    faucet: { humanAmount: "10000", baseUnits: "10000000000" },
    assetId: "usdm-2",
  },
  utwUSDC: {
    name: "UTWUSDC",
    registryName: "Unshielded-test-wrapped USDC",
    kind: "unshielded",
    decimals: 6,
    domainSeparator: "mint-test-tokens:utwUSDC",
    faucet: { humanAmount: "10000", baseUnits: "10000000000" },
    assetId: "usd-coin",
  },
  utwBTC: {
    name: "UTWBTC",
    registryName: "Unshielded-test-wrapped BTC",
    kind: "unshielded",
    decimals: 8,
    domainSeparator: "mint-test-tokens:utwBTC",
    faucet: { humanAmount: "1", baseUnits: "100000000" },
    assetId: "bitcoin",
  },
} as const;

const CANONICAL_SYMBOLS = Object.keys(CANONICAL_TOKENS) as CanonicalSymbol[];

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function exactString(value: unknown, expected: string, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${JSON.stringify(expected)}`);
}

function hex(value: unknown, path: string, exact32 = false): string {
  const result = nonEmptyString(value, path);
  if (!(exact32 ? HEX_32 : HEX).test(result)) {
    throw new Error(`${path} must be ${exact32 ? "32-byte " : ""}hex`);
  }
  return result.toLowerCase();
}

function dateTime(value: unknown, path: string): void {
  const raw = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(raw))) throw new Error(`${path} must be a date-time`);
}

function validateNetwork(
  raw: unknown,
  expected: RegistryNetwork,
  path: string,
): Record<string, unknown> {
  const network = object(raw, path);
  exactString(network.key, expected, `${path}.key`);
  exactString(network.networkId, expected, `${path}.networkId`);
  const expectedProtocol = expected === "stagenet" ? "midnight-2.x" : "midnight-1.x";
  exactString(network.protocolFamily, expectedProtocol, `${path}.protocolFamily`);
  nonEmptyString(network.displayName, `${path}.displayName`);
  nonEmptyString(network.chainId, `${path}.chainId`);
  nonEmptyString(network.stackIdentity, `${path}.stackIdentity`);
  return network;
}

function validateCompatibility(raw: unknown, network: RegistryNetwork, path: string): Record<string, unknown> {
  const compatibility = object(raw, path);
  exactString(compatibility.profile, network === "stagenet" ? "v2" : "v1", `${path}.profile`);
  for (const field of ["compiler", "compactRuntime", "ledger", "midnightJs", "walletSdk"]) {
    nonEmptyString(compatibility[field], `${path}.${field}`);
  }
  return compatibility;
}

function validateDeployment(
  raw: unknown,
  symbol: CanonicalSymbol,
): Record<string, unknown> {
  const path = `tokens.${symbol}.deployment`;
  const deployment = object(raw, path);
  nonEmptyString(deployment.deploymentId, `${path}.deploymentId`);
  if (deployment.status !== "active" && deployment.status !== "superseded") {
    throw new Error(`${path}.status is invalid`);
  }
  hex(deployment.contractAddress, `${path}.contractAddress`, true);
  hex(deployment.tokenId, `${path}.tokenId`, true);
  hex(deployment.deploymentTransaction, `${path}.deploymentTransaction`);
  dateTime(deployment.deployedAt, `${path}.deployedAt`);
  dateTime(deployment.verifiedAt, `${path}.verifiedAt`);

  const deploymentNetwork = object(deployment.network, `${path}.network`);
  const deploymentKey = nonEmptyString(deploymentNetwork.key, `${path}.network.key`);
  if (!(["preview", "preprod", "stagenet", "undeployed"] as string[]).includes(deploymentKey)) {
    throw new Error(`${path}.network.key is invalid`);
  }
  for (const field of ["displayName", "networkId", "protocolFamily", "chainId", "stackIdentity"]) {
    nonEmptyString(deploymentNetwork[field], `${path}.network.${field}`);
  }
  const deploymentCompatibility = object(deployment.compatibility, `${path}.compatibility`);
  if (deploymentCompatibility.profile !== "v1" && deploymentCompatibility.profile !== "v2") {
    throw new Error(`${path}.compatibility.profile is invalid`);
  }
  for (const field of ["compiler", "compactRuntime", "ledger", "midnightJs", "walletSdk"]) {
    nonEmptyString(deploymentCompatibility[field], `${path}.compatibility.${field}`);
  }

  if (deployment.deploymentToolchain !== null) {
    const toolchain = object(deployment.deploymentToolchain, `${path}.deploymentToolchain`);
    for (const field of ["runner", "runnerVersion", "walletSdk"]) {
      nonEmptyString(toolchain[field], `${path}.deploymentToolchain.${field}`);
    }
  }
  if (deployment.status === "active" && deployment.deploymentToolchain === null) {
    throw new Error(`${path}.deploymentToolchain is required for an active deployment`);
  }
  const confirmation = object(deployment.confirmation, `${path}.confirmation`);
  if (typeof confirmation.blockHeight !== "string" || !/^(0|[1-9][0-9]*)$/.test(confirmation.blockHeight)) {
    throw new Error(`${path}.confirmation.blockHeight is invalid`);
  }
  nonEmptyString(confirmation.blockHash, `${path}.confirmation.blockHash`);
  const authority = object(deployment.maintenanceAuthority, `${path}.maintenanceAuthority`);
  if (authority.status !== "retained" && authority.status !== "renounced" && authority.status !== "unknown") {
    throw new Error(`${path}.maintenanceAuthority.status is invalid`);
  }
  if (authority.status === "retained") nonEmptyString(authority.address, `${path}.maintenanceAuthority.address`);
  if (authority.status === "renounced" && authority.address !== null) {
    throw new Error(`${path}.maintenanceAuthority.address must be null when renounced`);
  }
  if (authority.status === "unknown" && authority.address !== null) {
    nonEmptyString(authority.address, `${path}.maintenanceAuthority.address`);
  }
  const artifact = object(deployment.artifact, `${path}.artifact`);
  const sourceRevision = hex(artifact.sourceRevision, `${path}.artifact.sourceRevision`);
  if (sourceRevision.length !== 40) throw new Error(`${path}.artifact.sourceRevision must be a git SHA`);
  hex(artifact.artifactSha256, `${path}.artifact.artifactSha256`, true);
  nonEmptyString(artifact.compilerVersion, `${path}.artifact.compilerVersion`);
  if (artifact.openZeppelinRelease !== null) {
    nonEmptyString(artifact.openZeppelinRelease, `${path}.artifact.openZeppelinRelease`);
  }
  return deployment;
}

/** Validate the registry before any database transaction begins. */
export function validateCanonicalRegistry(value: unknown, expectedNetwork: RegistryNetwork): ValidatedRegistry {
  const registry = object(value, "registry");
  exactString(registry.schemaVersion, "1.0.0", "schemaVersion");
  exactString(registry.status, "ready", "status");
  const revision = nonEmptyString(registry.registryRevision, "registryRevision");
  dateTime(registry.generatedAt, "generatedAt");
  const network = validateNetwork(registry.network, expectedNetwork, "network");
  const compatibility = validateCompatibility(registry.compatibility, expectedNetwork, "compatibility");
  const rawTokens = array(registry.tokens, "tokens");
  if (rawTokens.length !== CANONICAL_SYMBOLS.length) {
    throw new Error("registry must contain exactly the six canonical tokens");
  }

  const bySymbol = new Map<string, Record<string, unknown>>();
  for (const raw of rawTokens) {
    const token = object(raw, "token");
    const symbol = nonEmptyString(token.symbol, "token.symbol");
    if (bySymbol.has(symbol)) throw new Error(`duplicate token symbol ${symbol}`);
    bySymbol.set(symbol, token);
  }

  const colors = new Set<string>();
  const tokens = CANONICAL_SYMBOLS.map((symbol): CanonicalToken => {
    const definition = CANONICAL_TOKENS[symbol];
    const token = bySymbol.get(symbol);
    if (!token) throw new Error(`missing canonical token ${symbol}`);
    exactString(token.name, definition.registryName, `${symbol}.name`);
    if (token.decimals !== definition.decimals || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 38) {
      throw new Error(`${symbol}.decimals mismatch or outside database bounds`);
    }
    exactString(token.privacy, definition.kind, `${symbol}.privacy`);
    exactString(token.domainSeparator, definition.domainSeparator, `${symbol}.domainSeparator`);
    if (new TextEncoder().encode(definition.domainSeparator).length > 32) {
      throw new Error(`${symbol}.domainSeparator exceeds 32 UTF-8 bytes`);
    }
    const faucet = object(token.faucet, `${symbol}.faucet`);
    exactString(faucet.humanAmount, definition.faucet.humanAmount, `${symbol}.faucet.humanAmount`);
    exactString(faucet.baseUnits, definition.faucet.baseUnits, `${symbol}.faucet.baseUnits`);

    const activeId = nonEmptyString(token.activeDeploymentId, `${symbol}.activeDeploymentId`);
    const deployments = array(token.deployments, `${symbol}.deployments`).map((deployment) =>
      validateDeployment(deployment, symbol),
    );
    const deploymentIds = new Set<string>();
    for (const deployment of deployments) {
      const deploymentId = String(deployment.deploymentId);
      if (deploymentIds.has(deploymentId)) throw new Error(`${symbol} has duplicate deploymentId ${deploymentId}`);
      deploymentIds.add(deploymentId);
    }
    const active = deployments.filter((deployment) => deployment.status === "active");
    if (active.length !== 1 || active[0]?.deploymentId !== activeId) {
      throw new Error(`${symbol}.activeDeploymentId must select exactly one active deployment`);
    }
    const selected = active[0]!;
    const selectedNetwork = object(selected.network, `${symbol}.active.network`);
    for (const field of ["key", "networkId", "protocolFamily", "chainId", "stackIdentity"] as const) {
      if (selectedNetwork[field] !== network[field]) {
        throw new Error(`${symbol}.active.network.${field} does not match registry network`);
      }
    }
    const selectedCompatibility = object(selected.compatibility, `${symbol}.active.compatibility`);
    if (selectedCompatibility.profile !== compatibility.profile) {
      throw new Error(`${symbol}.active.compatibility.profile does not match registry compatibility`);
    }
    const tokenColor = hex(selected.tokenId, `${symbol}.active.tokenId`, true);
    if (colors.has(tokenColor)) throw new Error(`duplicate active tokenId ${tokenColor}`);
    colors.add(tokenColor);
    return {
      symbol,
      name: definition.name,
      kind: definition.kind,
      decimals: definition.decimals,
      assetId: definition.assetId,
      tokenColor,
    };
  });

  return { network: expectedNetwork, revision, tokens };
}

/**
 * Replace only the six canonical registry rows in one transaction.
 * Historical offers, unrelated known tokens and token_prices are never touched.
 */
export async function applyCanonicalRegistry(
  client: RegistryDbClient,
  registry: ValidatedRegistry,
): Promise<void> {
  const names = registry.tokens.map((token) => token.name);
  const colors = registry.tokens.map((token) => token.tokenColor);
  await client.query("BEGIN");
  try {
    // Compatibility for an already-initialized database. This DDL is inside
    // the same transaction, so a rejected import does not leave schema state.
    await client.query(
      `CREATE TABLE IF NOT EXISTS canonical_token_registry_state (
         name TEXT PRIMARY KEY,
         token_color TEXT UNIQUE NOT NULL,
         network TEXT NOT NULL CHECK (network IN ('preview', 'preprod', 'stagenet')),
         registry_revision TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    const existing = await client.query(
      `SELECT id, name, token_color, kind, decimals, asset_id
         FROM known_tokens
        WHERE name = ANY($1::text[]) OR token_color = ANY($2::text[])
        FOR UPDATE`,
      [names, colors],
    );
    const state = await client.query(
      `SELECT name, token_color
         FROM canonical_token_registry_state
        WHERE name = ANY($1::text[])
        FOR UPDATE`,
      [names],
    );
    const canonicalNames = new Set(names);
    const existingByName = new Map(existing.rows.map((row) => [String(row.name), row]));
    const stateByName = new Map(state.rows.map((row) => [String(row.name), String(row.token_color).toLowerCase()]));
    if (stateByName.size !== 0 && stateByName.size !== names.length) {
      throw new Error("canonical registry provenance is incomplete");
    }
    for (const row of existing.rows) {
      if (colors.includes(String(row.token_color).toLowerCase()) && !canonicalNames.has(String(row.name))) {
        throw new Error(`token color collision with unrelated known token ${String(row.name)}`);
      }
    }
    for (const token of registry.tokens) {
      const row = existingByName.get(token.name);
      const priorColor = stateByName.get(token.name);
      if (priorColor !== undefined) {
        if (!row || String(row.token_color).toLowerCase() !== priorColor) {
          throw new Error(`managed token ${token.name} no longer matches canonical registry provenance`);
        }
      } else if (row) {
        const matchesIncoming =
          String(row.token_color).toLowerCase() === token.tokenColor &&
          row.kind === token.kind &&
          Number(row.decimals) === token.decimals &&
          row.asset_id === token.assetId;
        if (!matchesIncoming) {
          throw new Error(`token name collision with unrelated known token ${token.name}`);
        }
      }
    }

    // Temporary colors permit an atomic A→B/B→A replacement despite the
    // immediate UNIQUE(token_color) constraint. Readers never see them.
    await client.query(
      `UPDATE known_tokens
          SET token_color = 'registry-import:' || id::text || ':' || token_color
        WHERE name = ANY($1::text[])`,
      [names],
    );
    await client.query(
      `UPDATE canonical_token_registry_state
          SET token_color = 'registry-import-state:' || name || ':' || token_color
        WHERE name = ANY($1::text[])`,
      [names],
    );
    for (const token of registry.tokens) {
      await client.query(
        `INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE SET
           token_color = EXCLUDED.token_color,
           kind = EXCLUDED.kind,
           decimals = EXCLUDED.decimals,
           asset_id = EXCLUDED.asset_id`,
        [token.tokenColor, token.name, token.kind, token.decimals, token.assetId],
      );
      await client.query(
        `INSERT INTO canonical_token_registry_state
           (name, token_color, network, registry_revision, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (name) DO UPDATE SET
           token_color = EXCLUDED.token_color,
           network = EXCLUDED.network,
           registry_revision = EXCLUDED.registry_revision,
           updated_at = NOW()`,
        [token.name, token.tokenColor, registry.network, registry.revision],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original rejection; the caller owns connection cleanup.
    }
    throw error;
  }
}
