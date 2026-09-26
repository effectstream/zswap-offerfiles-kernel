/**
 * Validates .env for the zswap-da preview or stagenet environment
 * (MIDNIGHT_NETWORK_ID selects which contract is checked).
 * Reads .env from disk but never prints values — only ✓/✗ status.
 * Usage: bun check-env.ts
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";

import { resolveStagenetNodeProfile, STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX } from "./packages/node/stagenet-profile.ts";
import { isPublicDevSeed } from "./packages/offer-guard/public-dev-seeds.ts";

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

// ── static checks ──────────────────────────────────────────────────────────────

/**
 * Every static check for one parsed .env, in print order. Pure: no network,
 * no filesystem. `preview` keeps its original checks; `stagenet` checks the
 * 00050 contract (see .env.stagenet.example and README "Running against
 * stagenet"). Values are never echoed, only named.
 */
export function staticChecks(env: Map<string, string>): Result[] {
  const get = (k: string) => env.get(k) ?? "";
  if (get("MIDNIGHT_NETWORK_ID") === "stagenet") return stagenetChecks(env);
  return previewChecks(get);
}

function previewChecks(get: (k: string) => string): Result[] {
  const results: Result[] = [];

  // Midnight
  const networkId = get("MIDNIGHT_NETWORK_ID");
  results.push(
    networkId === "preview"
      ? pass("MIDNIGHT_NETWORK_ID = preview")
      : fail("MIDNIGHT_NETWORK_ID", `expected "preview" or "stagenet", got "${networkId || "(unset)"}"`),
  );

  const midnightStart = get("MIDNIGHT_START_BLOCK");
  if (midnightStart && !isPositiveInt(midnightStart)) {
    results.push(fail("MIDNIGHT_START_BLOCK", "must be a positive integer if set"));
  } else {
    results.push(pass(`MIDNIGHT_START_BLOCK — ${midnightStart || "1 (default)"}`));
  }

  // Celestia
  const celestiaNetwork = get("CELESTIA_NETWORK");
  results.push(
    celestiaNetwork === "mocha"
      ? pass("CELESTIA_NETWORK = mocha")
      : fail("CELESTIA_NETWORK", `expected "mocha", got "${celestiaNetwork || "(unset)"}"`),
  );

  const namespace = get("CELESTIA_NAMESPACE");
  results.push(
    isHex(namespace, 10)
      ? pass("CELESTIA_NAMESPACE — 20-char hex (10 bytes)")
      : fail("CELESTIA_NAMESPACE", "must be 20-char hex (10 bytes), e.g. 000000000000deadbeef"),
  );

  const rpcUrl = get("CELESTIA_RPC_URL");
  results.push(
    isUrl(rpcUrl)
      ? pass("CELESTIA_RPC_URL — set")
      : fail("CELESTIA_RPC_URL", "not set or not a valid URL — paste your QuickNode Mocha-4 endpoint"),
  );

  const startHeight = get("CELESTIA_START_HEIGHT");
  if (startHeight && !isPositiveInt(startHeight)) {
    results.push(fail("CELESTIA_START_HEIGHT", "must be a positive integer if set"));
  } else {
    results.push(pass(`CELESTIA_START_HEIGHT — ${startHeight || "(default 1)"}`));
  }

  const pollMs = get("CELESTIA_POLLING_INTERVAL_MS");
  if (pollMs && !isPositiveInt(pollMs)) {
    results.push(fail("CELESTIA_POLLING_INTERVAL_MS", "must be a positive integer if set"));
  } else {
    results.push(pass(`CELESTIA_POLLING_INTERVAL_MS — ${pollMs || "3000 (default)"}`));
  }

  // Batcher wallet
  const batcherSeed = get("BATCHER_WALLET_SEED");
  const seedIsPlaceholder = batcherSeed.startsWith("<") || batcherSeed === "";
  if (seedIsPlaceholder) {
    results.push(fail(
      "BATCHER_WALLET_SEED",
      "not set — batcher will use a dev seed (no real funds).\n       Run: MIDNIGHT_NETWORK_ID=preview bun mnemonic-to-seed.ts",
    ));
  } else if (!isHex(batcherSeed) || (batcherSeed.length !== 64 && batcherSeed.length !== 128)) {
    results.push(fail("BATCHER_WALLET_SEED", `must be hex, 64 chars (32-byte key) or 128 chars (BIP39 64-byte seed); got ${batcherSeed.length} chars`));
  } else {
    results.push(pass("BATCHER_WALLET_SEED — set, 64-char hex"));
  }

  return results;
}

function stagenetChecks(env: Map<string, string>): Result[] {
  const get = (k: string) => (env.get(k) ?? "").trim();
  const results: Result[] = [pass("MIDNIGHT_NETWORK_ID = stagenet")];
  const profile = resolveStagenetNodeProfile(Object.fromEntries(env));
  const problemFor = (name: string) => profile.problems.find((p) => p.startsWith(name));
  const check = (name: string, okLabel: string) => {
    const problem = problemFor(name);
    results.push(problem ? fail(name, problem) : pass(okLabel));
  };

  const midnightStart = get("MIDNIGHT_START_BLOCK");
  results.push(
    midnightStart && !isPositiveInt(midnightStart)
      ? fail("MIDNIGHT_START_BLOCK", "must be a positive integer if set")
      : pass(`MIDNIGHT_START_BLOCK — ${midnightStart || "1 (default)"}`),
  );

  // Kernel (node): the stagenet profile's own rules, so the two cannot drift.
  check("NTP_START_TIME", `NTP_START_TIME — ${profile.resolved.ntpStartTimeMs}${get("NTP_START_TIME") ? "" : " (stagenet block 1, default)"}`);
  check("CELESTIA_NETWORK", `CELESTIA_NETWORK = mocha${get("CELESTIA_NETWORK") ? "" : " (default)"}`);
  const namespace = get("CELESTIA_NAMESPACE");
  results.push(
    namespace === "" || namespace.toLowerCase() === STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX
      ? pass(`CELESTIA_NAMESPACE — MIP-0006 shared namespace ${STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX} (mn-swap-v1)`)
      : fail("CELESTIA_NAMESPACE", "stagenet reads the MIP-0006 shared namespace (owner decision) — leave it unset"),
  );
  check("CELESTIA_RPC_URL", "CELESTIA_RPC_URL — set");
  check("CELESTIA_START_HEIGHT", `CELESTIA_START_HEIGHT — ${profile.resolved.celestiaStartHeight ?? ""} (pinned; frozen after the first boot)`);
  check("CELESTIA_AUTH_TOKEN", `Celestia auth — ${profile.resolved.celestiaAuth === "in-url" ? "credential in CELESTIA_RPC_URL (CELESTIA_AUTH_IN_URL=true)" : "CELESTIA_AUTH_TOKEN set"}`);
  const pollMs = get("CELESTIA_POLLING_INTERVAL_MS");
  results.push(
    pollMs && !isPositiveInt(pollMs)
      ? fail("CELESTIA_POLLING_INTERVAL_MS", "must be a positive integer if set")
      : pass(`CELESTIA_POLLING_INTERVAL_MS — ${pollMs || "3000 (default)"}`),
  );

  // Batcher: a dedicated funded seed (never a repository dev seed) and a volume.
  const seed = get("BATCHER_WALLET_SEED").replace(/^0x/i, "");
  if (seed === "" || seed.startsWith("<")) {
    results.push(fail("BATCHER_WALLET_SEED", "required on stagenet — a dedicated seed whose NIGHT is registered for DUST (no dev-seed fallback)"));
  } else if (!isHex(seed) || (seed.length !== 64 && seed.length !== 128)) {
    results.push(fail("BATCHER_WALLET_SEED", `must be hex, 64 or 128 chars; got ${seed.length} chars`));
  } else if (isPublicDevSeed(seed)) {
    results.push(fail("BATCHER_WALLET_SEED", "is a public dev seed from this repository — refused on stagenet"));
  } else {
    results.push(pass(`BATCHER_WALLET_SEED — set, ${seed.length}-char hex`));
  }
  const storage = get("BATCHER_STORAGE_DIR");
  results.push(
    storage && isAbsolute(storage)
      ? pass("BATCHER_STORAGE_DIR — absolute path (parked inputs + DUST-state cache)")
      : fail("BATCHER_STORAGE_DIR", "required on stagenet: an absolute path on a persistent volume"),
  );
  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  // ── file guard ─────────────────────────────────────────────────────────────────

  if (!existsSync(ENV_PATH)) {
    console.error("✗  .env not found");
    console.error("   Run:  cp .env.preview.example .env  (or .env.stagenet.example)  then fill in the required values");
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

  if (!isUrl(rpcUrl)) {
    console.log("skipped (URL not set)");
    allOk = false;
  } else {
    try {
      // Stagenet may authenticate with a bearer token; preview embeds its
      // credential in the URL and is probed exactly as before.
      const token = get("MIDNIGHT_NETWORK_ID") === "stagenet" ? get("CELESTIA_AUTH_TOKEN").trim() : "";
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
