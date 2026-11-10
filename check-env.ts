/**
 * Validates .env for a public-network kernel deployment: preview, preprod or
 * mainnet (MIDNIGHT_NETWORK_ID selects which). The rules are the services'
 * own: the node's public-network profile (packages/node/public-network-profile.ts),
 * the endpoint and dev-seed rules shared through
 * packages/offer-guard/public-networks.ts, and the batcher's seed and storage
 * contract. Reads .env from disk but never prints values — only ✓/✗ status.
 * Usage: bun check-env.ts
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";

import { MIP6_NAMESPACE_SUFFIX_HEX, resolvePublicNodeProfile } from "./packages/node/public-network-profile.ts";
import {
  CELESTIA_NETWORK_FOR,
  isPublicMidnightNetwork,
  publicDevSeedProblem,
  unsupportedNetworkProblem,
} from "./packages/offer-guard/public-networks.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(ROOT, ".env");

// ── env file parser ────────────────────────────────────────────────────────────

export function parseEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  const content = readFileSync(path, "utf-8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Quoted values: keep as-is, strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Unquoted: strip inline comments (# preceded by whitespace)
      val = val.replace(/\s+#.*$/, "").trim();
    }
    if (key) map.set(key, val);
  }
  return map;
}

// ── helpers ────────────────────────────────────────────────────────────────────

const isHex = (s: string, exactBytes?: number) =>
  /^[0-9a-fA-F]+$/.test(s) && (exactBytes === undefined || s.length === exactBytes * 2);

const isPositiveInt = (s: string) => /^\d+$/.test(s) && parseInt(s, 10) > 0;

const isUrl = (s: string) => /^https?:\/\/.+/.test(s);

export type Result = { label: string; ok: boolean; hint?: string };

const pass = (label: string): Result => ({ label, ok: true });
const fail = (label: string, hint?: string): Result => ({ label, ok: false, hint });

/** Seed variables a public deployment's services read; each is checked when set. */
const OPTIONAL_SEED_VARS = ["POSTER_SEED", "MIDNIGHT_WALLET_SEED"] as const;

// ── static checks ──────────────────────────────────────────────────────────────

/**
 * Every static check for one parsed .env, in print order. Pure: no network,
 * no filesystem. Values are never echoed, only named.
 */
export function staticChecks(env: Map<string, string>): Result[] {
  const networkId = (env.get("MIDNIGHT_NETWORK_ID") ?? "").trim();
  if (networkId === "undeployed") {
    // The local devnet runs from `bun run dev` or deploy/ with the repository's
    // dev seeds; none of the public-network contract applies to it.
    return [pass("MIDNIGHT_NETWORK_ID = undeployed (local devnet: the public-network contract does not apply)")];
  }
  if (!isPublicMidnightNetwork(networkId)) {
    return [fail("MIDNIGHT_NETWORK_ID", unsupportedNetworkProblem(networkId))];
  }
  return publicChecks(networkId, env);
}

function publicChecks(networkId: "preview" | "preprod" | "mainnet", env: Map<string, string>): Result[] {
  const get = (k: string) => (env.get(k) ?? "").trim();
  const results: Result[] = [];
  const profile = resolvePublicNodeProfile(Object.fromEntries(env));
  const problemsFor = (...names: string[]) =>
    profile.problems.filter((p) => names.some((name) => p.startsWith(name)));
  const check = (name: string, okLabel: string, ...also: string[]) => {
    const problems = problemsFor(name, ...also);
    results.push(problems.length > 0 ? fail(name, problems.join("\n       ↳ ")) : pass(okLabel));
  };

  // The network itself: supported, and its reference ledger parameters pinned
  // (a supported network that is not pinned yet does not start).
  check("MIDNIGHT_NETWORK_ID", `MIDNIGHT_NETWORK_ID = ${networkId}`);

  // Midnight endpoints: the Blockfrost token, or overrides on live hosts.
  check(
    "MIDNIGHT_BLOCKFROST_PROJECT_ID",
    get("MIDNIGHT_BLOCKFROST_PROJECT_ID")
      ? "MIDNIGHT_BLOCKFROST_PROJECT_ID — set (Blockfrost endpoints)"
      : "Midnight endpoints — all three overrides set",
  );
  for (const name of ["MIDNIGHT_INDEXER_HTTP", "MIDNIGHT_INDEXER_WS", "MIDNIGHT_NODE_HTTP"]) {
    if (get(name)) check(name, `${name} — set (override)`);
  }

  const midnightStart = get("MIDNIGHT_START_BLOCK");
  results.push(
    midnightStart && !isPositiveInt(midnightStart)
      ? fail("MIDNIGHT_START_BLOCK", "must be a positive integer if set")
      : pass(`MIDNIGHT_START_BLOCK — ${midnightStart || "1 (default)"}`),
  );

  // Kernel (node): the profile's own rules, so the two cannot drift.
  check(
    "NTP_START_TIME",
    `NTP_START_TIME — ${profile.resolved.ntpStartTimeMs}${get("NTP_START_TIME") ? "" : ` (${networkId} block 1, default)`}`,
  );
  check(
    "CELESTIA_NETWORK",
    `CELESTIA_NETWORK = ${CELESTIA_NETWORK_FOR[networkId]}${get("CELESTIA_NETWORK") ? "" : " (default)"}`,
  );
  const namespace = get("CELESTIA_NAMESPACE");
  results.push(
    namespace === "" || namespace.toLowerCase() === MIP6_NAMESPACE_SUFFIX_HEX
      ? pass(`CELESTIA_NAMESPACE — MIP-0006 shared namespace ${MIP6_NAMESPACE_SUFFIX_HEX} (mn-swap-v1)`)
      : fail("CELESTIA_NAMESPACE", `${networkId} reads the MIP-0006 shared namespace — leave it unset`),
  );
  check("CELESTIA_RPC_URL", "CELESTIA_RPC_URL — set");
  check(
    "CELESTIA_START_HEIGHT",
    `CELESTIA_START_HEIGHT — ${profile.resolved.celestiaStartHeight ?? ""} (pinned; frozen after the first boot)`,
  );
  check(
    "CELESTIA_AUTH_TOKEN",
    `Celestia auth — ${profile.resolved.celestiaAuth === "in-url" ? "credential in CELESTIA_RPC_URL (CELESTIA_AUTH_IN_URL=true)" : "CELESTIA_AUTH_TOKEN set"}`,
  );
  const pollMs = get("CELESTIA_POLLING_INTERVAL_MS");
  results.push(
    pollMs && !isPositiveInt(pollMs)
      ? fail("CELESTIA_POLLING_INTERVAL_MS", "must be a positive integer if set")
      : pass(`CELESTIA_POLLING_INTERVAL_MS — ${pollMs || "(network default)"}`),
  );

  // Batcher: a dedicated funded seed (never a repository dev seed) and a volume.
  const seed = get("BATCHER_WALLET_SEED").replace(/^0x/i, "");
  if (seed === "" || seed.startsWith("<")) {
    results.push(fail("BATCHER_WALLET_SEED", `required on ${networkId} — a dedicated seed whose NIGHT is registered for DUST (no dev-seed fallback)`));
  } else if (!isHex(seed) || (seed.length !== 64 && seed.length !== 128)) {
    results.push(fail("BATCHER_WALLET_SEED", `must be hex, 64 or 128 chars; got ${seed.length} chars`));
  } else {
    const devSeed = publicDevSeedProblem(networkId, "BATCHER_WALLET_SEED", seed);
    results.push(devSeed ? fail("BATCHER_WALLET_SEED", devSeed) : pass(`BATCHER_WALLET_SEED — set, ${seed.length}-char hex`));
  }
  const storage = get("BATCHER_STORAGE_DIR");
  results.push(
    storage && isAbsolute(storage)
      ? pass("BATCHER_STORAGE_DIR — absolute path (parked inputs + DUST-state cache)")
      : fail("BATCHER_STORAGE_DIR", `required on ${networkId}: an absolute path on a persistent volume`),
  );

  // Every other wallet seed in the same file: a repository dev seed is refused.
  for (const name of OPTIONAL_SEED_VARS) {
    const value = get(name);
    if (value === "" || value.startsWith("<")) continue;
    const devSeed = publicDevSeedProblem(networkId, name, value);
    if (devSeed) results.push(fail(name, devSeed));
  }
  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  // ── file guard ─────────────────────────────────────────────────────────────────

  if (!existsSync(ENV_PATH)) {
    console.error("✗  .env not found");
    console.error("   Run:  cp .env.<preview|preprod|mainnet>.example .env  then fill in the required values");
    process.exit(1);
  }

  const env = parseEnvFile(ENV_PATH);
  const get = (k: string) => env.get(k) ?? "";
  const results = staticChecks(env);
  const rpcUrl = get("CELESTIA_RPC_URL");

  // ── print static results ───────────────────────────────────────────────────────

  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const line = `  ${icon}  ${r.label}`;
    console.log(r.hint ? `${line}\n       ↳ ${r.hint}` : line);
    if (!r.ok) allOk = false;
  }

  // ── live connectivity check ────────────────────────────────────────────────────

  console.log("");
  process.stdout.write("  ⋯  CELESTIA_RPC_URL live check … ");

  if (get("MIDNIGHT_NETWORK_ID").trim() === "undeployed") {
    console.log("skipped (undeployed)");
  } else if (!isUrl(rpcUrl)) {
    console.log("skipped (URL not set)");
    allOk = false;
  } else {
    try {
      // A bearer token when one is set; a credential-in-URL endpoint needs none.
      const token = get("CELESTIA_AUTH_TOKEN").trim();
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "header.NetworkHead", params: [], id: 1 }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json() as any;
      const height = data?.result?.header?.height;
      if (height) {
        console.log(`✓  reachable, chain head = ${height}`);
      } else {
        console.log("✗  responded but unexpected format — wrong URL?");
        console.log(`       response: ${JSON.stringify(data).slice(0, 120)}`);
        allOk = false;
      }
    } catch (e: any) {
      console.log(`✗  ${e.message}`);
      allOk = false;
    }
  }

  // ── summary ────────────────────────────────────────────────────────────────────

  console.log("");
  if (allOk) {
    console.log("  ✓  All checks passed — ready for:  docker compose up --build");
  } else {
    console.log("  ✗  Fix the issues above, then re-run:  bun check-env.ts");
    process.exit(1);
  }
}

if (import.meta.main) await cli();
