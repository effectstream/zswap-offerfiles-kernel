import pg from "pg";
import {
  applyCanonicalRegistry,
  isLedger9Label,
  LEDGER9_PROTOCOL_FAMILY,
  readRegistryLabel,
  validateCanonicalRegistry,
  type RegistryNetwork,
  type ValidatedRegistry,
} from "./token-registry.ts";

export type ImportNetwork = RegistryNetwork | "undeployed";

export type RegistryImportConfig = {
  baseUrl: string;
  network: ImportNetwork;
  timeoutMs: number;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
};

/**
 * Where one network's canonical token list comes from.
 *
 * - `registry-file`: a published registry document (`metadata.<network>.json`).
 * - `none`: the network has no source; nothing is imported and the database
 *   keeps only the schema's own rows (NIGHT).
 *
 * Every source yields a document for validateCanonicalRegistry, and the
 * database side (applyCanonicalRegistry, the `known_tokens` and
 * `canonical_token_registry_state` tables) does not depend on the kind, so a
 * new kind (an HTTP API) replaces a file without a schema change.
 */
export type RegistrySource =
  | { kind: "registry-file"; network: RegistryNetwork; url: string }
  | { kind: "none"; network: ImportNetwork; reason: string };

/**
 * - `applied`: the network's registry was validated and written.
 * - `skipped`: by policy there is nothing to import for this network (no
 *   source, a missing file, or a file that is not labelled for ledger 9).
 *   Nothing is written. Not an error, also not with `--required`.
 * - `failed`: the source could not be read, validated or applied. Nothing is
 *   written.
 */
export type RegistryImportOutcome =
  | { status: "applied"; network: RegistryNetwork; revision: string; source: string }
  | { status: "skipped"; network: ImportNetwork; reason: string }
  | { status: "failed"; network: ImportNetwork | null; reason: string };

/** `--required` exit status when there is nothing to import by policy. */
export const EXIT_NOTHING_TO_IMPORT = 3;

type ImportClient = InstanceType<typeof pg.Client>;

const DEFAULT_BASE_URL = "https://mint-test-tokens.pages.dev/";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 1_000_000;
const IMPORT_NETWORKS: readonly ImportNetwork[] = ["preview", "preprod", "mainnet", "undeployed"];

function positiveInt(raw: string | undefined, fallback: number, name: string, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} must be <= ${max}`);
  return parsed;
}

/**
 * The registry follows the kernel's network: an explicit
 * TOKEN_REGISTRY_NETWORK, else MIDNIGHT_NETWORK_ID, else `undeployed` (the
 * network the kernel itself runs on when MIDNIGHT_NETWORK_ID is unset).
 */
function network(raw: string | undefined): ImportNetwork {
  const selected = raw || "undeployed";
  if (!(IMPORT_NETWORKS as readonly string[]).includes(selected)) {
    throw new Error(
      `TOKEN_REGISTRY_NETWORK must be one of ${IMPORT_NETWORKS.join(", ")} (got ${JSON.stringify(selected)})`,
    );
  }
  return selected as ImportNetwork;
}

export function loadRegistryImportConfig(env: Record<string, string | undefined> = process.env): RegistryImportConfig {
  const timeoutMs = positiveInt(env.TOKEN_REGISTRY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "TOKEN_REGISTRY_TIMEOUT_MS", 30_000);
  return {
    baseUrl: env.TOKEN_REGISTRY_BASE_URL || DEFAULT_BASE_URL,
    network: network(env.TOKEN_REGISTRY_NETWORK || env.MIDNIGHT_NETWORK_ID),
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

/** The per-network source table. */
export function registrySourceFor(selectedNetwork: ImportNetwork, baseUrl: string): RegistrySource {
  switch (selectedNetwork) {
    case "preview":
    case "preprod":
      return { kind: "registry-file", network: selectedNetwork, url: registryUrl(baseUrl, selectedNetwork) };
    case "mainnet":
      return {
        kind: "none",
        network: "mainnet",
        reason: "mainnet has no canonical token source yet; NIGHT is the only token listed there",
      };
    case "undeployed":
      return {
        kind: "none",
        network: "undeployed",
        reason: "undeployed is a local network with no public canonical registry",
      };
  }
}

type FetchedDocument = { kind: "document"; value: unknown } | { kind: "missing"; httpStatus: number };

/** Read one registry document; 404 and 410 mean the file does not exist. */
export async function fetchRegistryDocument(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedDocument> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "missing", httpStatus: response.status };
  }
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  if (!response.body) throw new Error("registry response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
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
    return { kind: "document", value: JSON.parse(text) };
  } catch {
    throw new Error("registry response is not valid JSON");
  }
}

type LoadedRegistry =
  | { kind: "registry"; registry: ValidatedRegistry; source: string }
  | { kind: "nothing"; reason: string };

/**
 * Turn a source into a validated registry, or into the policy reason there is
 * nothing to import. Throws when the source exists but cannot be read or does
 * not validate.
 */
export async function loadRegistry(
  source: RegistrySource,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedRegistry> {
  if (source.kind === "none") return { kind: "nothing", reason: source.reason };
  const fetched = await fetchRegistryDocument(source.url, timeoutMs, fetchImpl);
  if (fetched.kind === "missing") {
    return {
      kind: "nothing",
      reason: `${source.network} registry file ${source.url} is missing (HTTP ${fetched.httpStatus}); nothing imported`,
    };
  }
  const label = readRegistryLabel(fetched.value);
  if (label !== null && !isLedger9Label(label)) {
    const profile = label.profile === null ? "" : ` (profile ${label.profile})`;
    return {
      kind: "nothing",
      reason:
        `${source.network} registry file ${source.url} is labelled ${label.protocolFamily}${profile}; ` +
        `only ${LEDGER9_PROTOCOL_FAMILY} registries are imported; nothing imported`,
    };
  }
  try {
    return { kind: "registry", registry: validateCanonicalRegistry(fetched.value, source.network), source: source.url };
  } catch (error) {
    throw new Error(
      `${source.network} registry file ${source.url} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runRegistryImport(
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
    const source = registrySourceFor(config.network, config.baseUrl);
    const loaded = await loadRegistry(source, config.timeoutMs, dependencies.fetchImpl);
    if (loaded.kind === "nothing") return { status: "skipped", network: config.network, reason: loaded.reason };
    const createClient = dependencies.createClient ?? ((dbConfig) => new pg.Client(dbConfig));
    client = createClient({
      ...config.db,
      connectionTimeoutMillis: config.timeoutMs,
      query_timeout: config.timeoutMs,
      statement_timeout: config.timeoutMs,
    });
    await client.connect();
    await applyCanonicalRegistry(client, loaded.registry);
    return {
      status: "applied",
      network: loaded.registry.network,
      revision: loaded.registry.revision,
      source: loaded.source,
    };
  } catch (error) {
    return { status: "failed", network: config.network, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // Cleanup after an outcome is decided must not change that outcome.
      }
    }
  }
}

/**
 * The CLI. It prints exactly one line per run: `applied`, `skipped` (nothing
 * to import for this network by policy) or a failure.
 *
 * Without `--required` (the dev orchestrator's optional step) the exit status
 * is always 0. With `--required` (the image's one-shot) it is 0 when applied,
 * EXIT_NOTHING_TO_IMPORT when skipped by policy, and 1 when the import failed,
 * so a deployment step that did not import never looks like one that did and
 * a transient failure is retried.
 */
export async function runRegistryImportCli(
  options: { required?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<RegistryImportOutcome> {
  let outcome: RegistryImportOutcome;
  try {
    outcome = await runRegistryImport(loadRegistryImportConfig(options.env ?? process.env));
  } catch (error) {
    outcome = { status: "failed", network: null, reason: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.status === "applied") {
    console.log(
      `[token-registry] applied network=${outcome.network} revision=${outcome.revision} source=${outcome.source}`,
    );
  } else if (outcome.status === "skipped") {
    console.warn(`[token-registry] skipped: ${outcome.reason}`);
    if (options.required) process.exitCode = EXIT_NOTHING_TO_IMPORT;
  } else if (options.required) {
    console.error(`[token-registry] FAILED (required import did not apply): ${outcome.reason}`);
    process.exitCode = 1;
  } else {
    console.warn(`[token-registry] failed (optional step, nothing imported): ${outcome.reason}`);
  }
  return outcome;
}

if (import.meta.main) await runRegistryImportCli({ required: process.argv.includes("--required") });
