// The Midnight networks this kernel runs on, and the configuration rules every
// service shares on the public ones (the node, the batcher, the offer poster
// and the repo-root `check-env.ts`).
//
// Pure on purpose: no imports that load the ledger WASM or
// `@effectstream/midnight-contracts/midnight-env`. The profiles that use these
// rules must run BEFORE midnight-env is evaluated, because midnight-env
// resolves (and, without a Blockfrost token, throws on) the endpoints at import.
//
// Endpoints. `@effectstream/midnight-contracts` 0.300.2's
// `defaultMidnightNetworkConfig` points preview, preprod and mainnet at the
// Blockfrost-hosted indexer and node, with `?project_id=<token>` taken from
// MIDNIGHT_BLOCKFROST_PROJECT_ID; an explicit MIDNIGHT_INDEXER_HTTP,
// MIDNIGHT_INDEXER_WS or MIDNIGHT_NODE_HTTP replaces its URL verbatim. The
// kernel never builds an endpoint URL itself. The Midnight-hosted preprod and
// mainnet endpoints (`indexer.<net>.midnight.network`,
// `rpc.<net>.midnight.network`) were retired on 2026-10-09 (the indexers
// answer HTTP 410), so an override that still names one is refused here
// instead of failing later inside the sync.

import { Buffer } from "node:buffer";
import { formatWithOptions } from "node:util";

import { isPublicDevSeed } from "./public-dev-seeds.ts";

/** Every network id this kernel has a profile and pinned parameters for. */
export const SUPPORTED_MIDNIGHT_NETWORKS = ["undeployed", "preview", "preprod", "mainnet"] as const;
export type SupportedMidnightNetwork = (typeof SUPPORTED_MIDNIGHT_NETWORKS)[number];

/** The hosted networks: real users, Blockfrost endpoints, no dev seeds. */
export const PUBLIC_MIDNIGHT_NETWORKS = ["preview", "preprod", "mainnet"] as const;
export type PublicMidnightNetwork = (typeof PUBLIC_MIDNIGHT_NETWORKS)[number];

export type EnvMap = Readonly<Record<string, string | undefined>>;

export function isSupportedMidnightNetwork(id: string): id is SupportedMidnightNetwork {
  return (SUPPORTED_MIDNIGHT_NETWORKS as readonly string[]).includes(id);
}

export function isPublicMidnightNetwork(id: string): id is PublicMidnightNetwork {
  return (PUBLIC_MIDNIGHT_NETWORKS as readonly string[]).includes(id);
}

/** The refusal for an id outside {@link SUPPORTED_MIDNIGHT_NETWORKS}. */
export function unsupportedNetworkProblem(id: string): string {
  return (
    `MIDNIGHT_NETWORK_ID="${id || "(unset)"}" is not supported ` +
    `(supported: ${SUPPORTED_MIDNIGHT_NETWORKS.join(", ")})`
  );
}

/**
 * The Celestia network each public network posts and reads offers on. Every
 * one of them uses the MIP-0006 shared namespace `mn-swap-v1`; a kernel
 * rejects the other networks' offers it reads there.
 */
export const CELESTIA_NETWORK_FOR: Readonly<Record<PublicMidnightNetwork, "mocha" | "mainnet">> =
  Object.freeze({ preview: "mocha", preprod: "mocha", mainnet: "mainnet" });

export const BLOCKFROST_PROJECT_ID_VAR = "MIDNIGHT_BLOCKFROST_PROJECT_ID";

/** The endpoint overrides midnight-env honours, with the schemes each accepts. */
export const MIDNIGHT_ENDPOINT_VARS: readonly { readonly name: string; readonly schemes: readonly string[] }[] = [
  { name: "MIDNIGHT_INDEXER_HTTP", schemes: ["http:", "https:"] },
  { name: "MIDNIGHT_INDEXER_WS", schemes: ["ws:", "wss:"] },
  { name: "MIDNIGHT_NODE_HTTP", schemes: ["http:", "https:"] },
];

/** Trimmed value, or undefined for absent / blank. */
function read(env: EnvMap, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The host name when `url` points at a retired Midnight-hosted preprod or
 * mainnet endpoint, otherwise undefined. Preview's Midnight-hosted endpoints
 * are still served and are not matched.
 */
export function retiredMidnightHost(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return /^(indexer|rpc)\.(preprod|mainnet)\.midnight\.network$/.test(host) ? host : undefined;
}

/**
 * Every endpoint refusal for a public network, each naming its variable. No
 * message quotes a URL or the token: either may carry a secret.
 *
 *   - an override that is not an absolute URL of the right scheme;
 *   - an override on a retired Midnight-hosted preprod/mainnet host;
 *   - no Blockfrost token while at least one URL is left to its default
 *     (midnight-env would throw at import).
 */
export function midnightEndpointProblems(networkId: PublicMidnightNetwork, env: EnvMap): string[] {
  const problems: string[] = [];
  const defaulted: string[] = [];
  for (const { name, schemes } of MIDNIGHT_ENDPOINT_VARS) {
    const value = read(env, name);
    if (value === undefined) {
      defaulted.push(name);
      continue;
    }
    let protocol = "";
    try {
      protocol = new URL(value).protocol;
    } catch {
      protocol = "";
    }
    if (!schemes.includes(protocol)) {
      problems.push(`${name} must be an absolute ${schemes.map((s) => s.slice(0, -1)).join("/")} URL`);
      continue;
    }
    const retired = retiredMidnightHost(value);
    if (retired !== undefined) {
      problems.push(
        `${name} points at ${retired}, a Midnight-hosted endpoint retired on 2026-10-09: unset it to use ` +
          `the Blockfrost default with ${BLOCKFROST_PROJECT_ID_VAR}, or set a Blockfrost URL`,
      );
    }
  }
  if (defaulted.length > 0 && read(env, BLOCKFROST_PROJECT_ID_VAR) === undefined) {
    problems.push(
      `${BLOCKFROST_PROJECT_ID_VAR} is required on ${networkId}: the default Midnight endpoints are ` +
        `Blockfrost-hosted (${defaulted.join(", ")} not set). Set the network's Blockfrost project token, ` +
        `or set all of ${MIDNIGHT_ENDPOINT_VARS.map((v) => v.name).join(", ")}`,
    );
  }
  return problems;
}

/**
 * The refusal for a repository dev seed on any network but `undeployed`, or
 * undefined. Malformed seeds are not judged here (callers name that).
 */
export function publicDevSeedProblem(
  networkId: string,
  variable: string,
  seed: string | undefined,
): string | undefined {
  if (networkId === "undeployed" || seed === undefined || !isPublicDevSeed(seed)) return undefined;
  return (
    `${variable} is a public dev seed from this repository (anyone can drain it); it is accepted only on ` +
    `undeployed — give this service its own funded seed on ${networkId || "(unset)"}`
  );
}

/** `protocol//host[:port]` of a URL and nothing else (no path, query or userinfo). */
function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable URL>";
  }
}

// ── Blockfrost authentication probe ────────────────────────────────────────

export type EndpointAuthProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly fatal: boolean; readonly message: string };

/**
 * One indexer request, made once at startup, that tells a rejected token apart
 * from an unreachable endpoint. Blockfrost answers a missing or wrong-network
 * project token with HTTP 401/403 (for example "Network token mismatch") on
 * every request, and the sync would retry that forever: such an answer is
 * FATAL and names MIDNIGHT_BLOCKFROST_PROJECT_ID. A network error or any other
 * status is not (the sync retries; an offline boot still proceeds). Every text
 * that could carry the URL goes through `redact`.
 */
export async function probeMidnightIndexerAuth(
  networkId: string,
  indexerUrl: string,
  redact: (text: string) => string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EndpointAuthProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const host = urlOrigin(indexerUrl);
  let response: Response;
  try {
    response = await fetchImpl(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { block { height } }" }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return {
      ok: false,
      fatal: false,
      message: `Midnight indexer ${host} unreachable at startup (${redact(String((error as Error)?.message ?? error))}); the sync will retry`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    let detail = "";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body?.message === "string") detail = `: ${redact(body.message).slice(0, 120)}`;
    } catch {
      detail = "";
    }
    return {
      ok: false,
      fatal: true,
      message:
        `the Midnight indexer ${host} rejected the request (HTTP ${response.status}${detail}): check ` +
        `MIDNIGHT_BLOCKFROST_PROJECT_ID — Blockfrost project tokens are per network, and this one is not ` +
        `accepted for ${networkId}`,
    };
  }
  return { ok: true };
}

// ── process-wide log redaction ─────────────────────────────────────────────

const PROJECT_ID_BYTES = Buffer.from("project_id=");

/**
 * Pass everything the process prints through `redact` (the caller hands in
 * midnight-env's `redactBlockfrostProjectId`): the console methods, and raw
 * writes to stdout/stderr. The kernel's own lines already redact their
 * endpoints; this also covers dependencies that print a URL they were given
 * (a wallet or RPC client logging the node it lost), since a Blockfrost URL
 * carries the project token in its query string. Installing twice is a no-op.
 * The public-network entries call it once all modules are loaded and before
 * any connection is opened.
 */
export function installLogRedaction(redact: (text: string) => string): void {
  const marker = Symbol.for("zswap-da.log-redaction");
  const registry = globalThis as unknown as Record<symbol, boolean>;
  if (registry[marker]) return;
  registry[marker] = true;

  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(redact(formatWithOptions({ colors: false }, ...args)));
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") return write(redact(chunk), ...rest);
      if (chunk instanceof Uint8Array && Buffer.from(chunk).includes(PROJECT_ID_BYTES)) {
        return write(redact(Buffer.from(chunk).toString("utf8")), ...rest);
      }
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
}
