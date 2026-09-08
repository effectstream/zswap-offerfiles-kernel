import pg from "pg";
import {
  applyCanonicalRegistry,
  validateCanonicalRegistry,
  type RegistryNetwork,
} from "./token-registry.ts";

export type RegistryImportConfig = {
  baseUrl: string;
  network: RegistryNetwork | "undeployed";
  timeoutMs: number;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
};

export type RegistryImportOutcome =
  | { status: "applied"; revision: string; network: RegistryNetwork }
  | { status: "skipped"; reason: string };

type ImportClient = InstanceType<typeof pg.Client>;

const DEFAULT_BASE_URL = "https://mint-test-tokens.pages.dev/";
const DEFAULT_TIMEOUT_MS = 5_000;

function positiveInt(raw: string | undefined, fallback: number, name: string, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} must be <= ${max}`);
  return parsed;
}

function network(raw: string | undefined): RegistryNetwork | "undeployed" {
  const selected = raw || "preprod";
  if (selected !== "preview" && selected !== "preprod" && selected !== "stagenet" && selected !== "undeployed") {
    throw new Error(`TOKEN_REGISTRY_NETWORK must be preview, preprod, stagenet or undeployed (got ${JSON.stringify(selected)})`);
  }
  return selected;
}

export function loadRegistryImportConfig(env: Record<string, string | undefined> = process.env): RegistryImportConfig {
  const timeoutMs = positiveInt(env.TOKEN_REGISTRY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "TOKEN_REGISTRY_TIMEOUT_MS", 30_000);
  return {
    baseUrl: env.TOKEN_REGISTRY_BASE_URL || DEFAULT_BASE_URL,
    network: network(env.TOKEN_REGISTRY_NETWORK ?? env.MIDNIGHT_NETWORK_ID),
    timeoutMs,
    db: {
      host: env.DB_HOST || "127.0.0.1",
      port: positiveInt(env.DB_PORT, 5432, "DB_PORT", 65_535),
      user: env.DB_USER || "postgres",
      password: env.DB_PW || "postgres",
      database: env.DB_NAME || "postgres",
    },
  };
}

export function registryUrl(baseUrl: string, selectedNetwork: RegistryNetwork): string {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(`metadata.${selectedNetwork}.json`, base).toString();
}

export async function fetchRegistry(
  config: RegistryImportConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (config.network === "undeployed") {
    throw new Error("undeployed is a local network with no public canonical registry");
  }
  const signal = AbortSignal.timeout(config.timeoutMs);
  const response = await fetchImpl(registryUrl(config.baseUrl, config.network), {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  if (!response.body) throw new Error("registry response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 1_000_000) {
      await reader.cancel("registry response exceeds 1 MB");
      throw new Error("registry response exceeds 1 MB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("registry response is not valid JSON");
  }
}

export async function runOptionalRegistryImport(
  config: RegistryImportConfig,
  dependencies: {
    fetchImpl?: typeof fetch;
    createClient?: (config: RegistryImportConfig["db"] & {
      connectionTimeoutMillis: number;
      query_timeout: number;
      statement_timeout: number;
    }) => ImportClient;
  } = {},
): Promise<RegistryImportOutcome> {
  let client: ImportClient | undefined;
  try {
    if (config.network === "undeployed") {
      return { status: "skipped", reason: "undeployed is a local network with no public canonical registry" };
    }
    const value = await fetchRegistry(config, dependencies.fetchImpl);
    const registry = validateCanonicalRegistry(value, config.network);
    const createClient = dependencies.createClient ?? ((dbConfig) => new pg.Client(dbConfig));
    client = createClient({
      ...config.db,
      connectionTimeoutMillis: config.timeoutMs,
      query_timeout: config.timeoutMs,
      statement_timeout: config.timeoutMs,
    });
    await client.connect();
    await applyCanonicalRegistry(client, registry);
    return { status: "applied", revision: registry.revision, network: registry.network };
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // Optional cleanup cannot turn a completed deployment step into failure.
      }
    }
  }
}

export async function runRegistryImportCli(): Promise<RegistryImportOutcome> {
  let outcome: RegistryImportOutcome;
  try {
    outcome = await runOptionalRegistryImport(loadRegistryImportConfig());
  } catch (error) {
    outcome = { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.status === "applied") {
    console.log(`[token-registry] applied network=${outcome.network} revision=${outcome.revision}`);
  } else {
    console.warn(`[token-registry] skipped: ${outcome.reason}`);
  }
  return outcome;
}

if (import.meta.main) await runRegistryImportCli();
