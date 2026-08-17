import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";

import { getEnv } from "@effectstream/utils/runtime";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { readMidnightContract } from "@effectstream/midnight-contracts/read-contract";
import {
  resolveOfferTtlSeconds,
  resolveRootWindowSeconds,
} from "./network-windows.ts";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";

// Instance name of the Celestia blob primitive. This is the value the
// framework writes to effectstream.primitive_accounting.primitive_name, and
// that table's only usable index is
// (primitive_name, effectstream_block_height, payload_hash) — so any query
// against it MUST constrain primitive_name or it degrades into a full index
// scan over every primitive's rows. Shared here so the config blocks and the
// rejected-blob cleanup can never drift apart.
export const CELESTIA_PRIMITIVE_NAME = "ZswapBlob";

export const CELESTIA_RPC_URL = getEnv("CELESTIA_RPC_URL") ?? "http://127.0.0.1:26658";
// MIP-0006 shared namespace by default — see MIP6_NAMESPACE_ID_SUFFIX_HEX in
// @zswap-da/offer-guard for why overriding re-silos liquidity (dev/e2e only).
export const CELESTIA_NAMESPACE =
  getEnv("CELESTIA_NAMESPACE") ?? MIP6_NAMESPACE_ID_SUFFIX_HEX;
export const CELESTIA_FEE = parseInt(getEnv("CELESTIA_FEE") ?? "2000");
export const CELESTIA_GAS_LIMIT = parseInt(getEnv("CELESTIA_GAS_LIMIT") ?? "100000");
export const CELESTIA_AUTH_TOKEN = getEnv("CELESTIA_AUTH_TOKEN") ?? "";
export const CELESTIA_NETWORK = getEnv("CELESTIA_NETWORK") ?? "devnet";
export const CELESTIA_START_HEIGHT = getEnv("CELESTIA_START_HEIGHT");
// Concurrent fetcher knobs — see packages/sync celestia/fetcher.ts.
// stepSize controls how many blocks are batched per fetch window;
// concurrency controls how many heights are fetched in parallel within each window.
// Both default to values safe for Mocha-4 (~21 blocks/min with ~10% stalls).
export const CELESTIA_STEP_SIZE = parseInt(getEnv("CELESTIA_STEP_SIZE") ?? "200");
export const CELESTIA_FETCH_CONCURRENCY = parseInt(getEnv("CELESTIA_FETCH_CONCURRENCY") ?? "12");

// NTP / sync timing — override via env to adjust for a different network epoch.
export const BLOCK_TIME_MS     = parseInt(getEnv("BLOCK_TIME_MS")     ?? "600000");
export const NTP_STEP_SIZE     = parseInt(getEnv("NTP_STEP_SIZE")     ?? "1000");
export const NTP_START_TIME    = parseInt(getEnv("NTP_START_TIME")    ?? "1774400742000");
export const MIDNIGHT_DELAY_MS = parseInt(getEnv("MIDNIGHT_DELAY_MS") ?? "30000");

// Local batcher endpoint for forwarding zswap blob submissions.
export const BATCHER_SUBMIT_URL = getEnv("BATCHER_SUBMIT_URL") ??
  `http://127.0.0.1:${getEnv("BATCHER_PORT") ?? "3334"}`;

// Sync poll cadence. Mainnet public gRPC endpoints rate-limit aggressively;
// 30s (≈2.5 blocks) is safe and cuts call volume ~5x vs the 6s devnet default.
export const CELESTIA_POLLING_INTERVAL_MS = parseInt(
  getEnv("CELESTIA_POLLING_INTERVAL_MS") ??
    (CELESTIA_NETWORK === "mainnet"
      ? "30000"
      : CELESTIA_NETWORK === "mocha"
        ? "3000"
        : "6000"),
);

// celestia-node v0.30+ TxConfig. Each explicit field removes one consensus-gRPC
// call from the submit path. Leave unset to let the node auto-estimate.
const _gasPrice = getEnv("CELESTIA_GAS_PRICE");
const _gas = getEnv("CELESTIA_GAS");
const _maxGasPrice = getEnv("CELESTIA_MAX_GAS_PRICE");
const _txPriority = getEnv("CELESTIA_TX_PRIORITY");
export const CELESTIA_GAS_PRICE = _gasPrice ? parseFloat(_gasPrice) : undefined;
export const CELESTIA_GAS = _gas ? parseInt(_gas) : undefined;
export const CELESTIA_MAX_GAS_PRICE = _maxGasPrice ? parseFloat(_maxGasPrice) : undefined;
export const CELESTIA_TX_PRIORITY = _txPriority ? parseInt(_txPriority) : undefined;

// Root-recency window and offer TTL — per-network defaults live in
// network-windows.ts (1 h on all current networks; STAGENET placeholder at
// 2 weeks, not publicly available yet). Env vars override both.
//
// OFFER_TTL_SECONDS defaults to the root window: a shielded offer is fillable
// only while the Merkle root its `Input`/`Transient` proves against is still
// inside the chain's window; once it ages out the input fails with
// `UnknownMerkleRoot` at apply time — silently, with no event the indexer can
// observe. Keeping offers indexed past that only serves unfillable offers.
//
// Caveats:
//   - The window bounds *proof freshness*, not coin age: a maker proves an
//     old coin against a recent root, so old coins are unaffected.
//   - Unshielded-only offers have no root window (a UTXO is valid until
//     spent); if you need them to live longer, override OFFER_TTL_SECONDS.
//   - Makers should publish promptly after proving — the fill window starts
//     at the referenced root, not at publication.
export const ROOT_WINDOW_SECONDS = resolveRootWindowSeconds(
  midnightNetworkConfig.id,
  getEnv("ROOT_WINDOW_SECONDS"),
);

export const OFFER_TTL_SECONDS = resolveOfferTtlSeconds(
  ROOT_WINDOW_SECONDS,
  getEnv("OFFER_TTL_SECONDS"),
);

// Midnight network id the offers are created against. Used as the `wellFormed`
// reference-state network (offer validation) — must match the network whose
// proofs the offers carry.
export const MIDNIGHT_NETWORK_ID = midnightNetworkConfig.id;

// Upper bound on a decoded offer transaction, in bytes. A DoS guard for the
// validator (the Celestia adapter separately caps the on-wire blob at 1.5 MB);
// set generously so legitimate proof-bearing offers are never rejected.
export const OFFER_MAX_BYTES = parseInt(
  getEnv("OFFER_MAX_BYTES") ?? String(1024 * 1024),
);

// Per-IP request budget for the /v1 API, and IPs exempt from it. A co-located
// automated client (a solver mirroring the book) bursts well past the shared
// default during an initial page-through plus a settlement's status polls, so
// its host is allowlisted rather than the global budget being raised for
// everyone. Empty allowlist by default — an operator opts in per deployment.
//
// Read per call, not once at import, so a caller that sets the vars before
// building a router gets them — the same reason isTokenRegistryEnabled below
// is a function.
export const apiRateLimitMax = (): number =>
  parseInt(getEnv("API_RATE_LIMIT_MAX") ?? "60");

export const apiRateLimitAllowList = (): string[] =>
  (getEnv("API_RATE_LIMIT_ALLOWLIST") ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0);

// SSE requests remain open, so the per-minute request limiter cannot bound
// their steady-state memory/socket cost. Cap concurrent streams per node.
export const apiSseMaxConnections = (): number => {
  const raw = getEnv("API_SSE_MAX_CONNECTIONS") ?? "100";
  if (!/^[1-9][0-9]*$/.test(raw)) return 100;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 10_000 ? parsed : 100;
};

// Decision budget for one solver validate-for-use request. Keep a hard upper
// bound so an operator typo cannot silently permit unbounded async read work.
// The endpoint observes it at async yields and between validation stages. The
// ledger's synchronous native proof call blocks the event loop and therefore
// cannot be preempted (or notice an elapsed timer) mid-call. The route retains
// its per-solver active slot until any post-deadline read really settles.
export const offerValidationTimeoutMs = (): number => {
  const raw = getEnv("OFFER_VALIDATION_TIMEOUT_MS") ?? "15000";
  if (!/^[1-9][0-9]*$/.test(raw)) return 15_000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 60_000 ? parsed : 15_000;
};

export interface SolverLevelsCredential {
  solverId: string;
  secret: string;
}

const validSolverId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/**
 * Server-side credentials for authenticated solver publications.
 *
 * Preferred multi-solver form:
 *   SOLVER_LEVELS_AUTH_KEYS='{"maker-a":"secret-a","maker-b":"secret-b"}'
 *
 * A single-secret deployment may instead set SOLVER_LEVELS_AUTH_SECRET. Its
 * public identity is derived from the secret, so a caller cannot choose or
 * spoof another solverId. The publisher supplies the matching value via its
 * SOLVER_LEVELS_AUTH_TOKEN environment variable.
 */
export function solverLevelsCredentials(): SolverLevelsCredential[] {
  const rawKeys = getEnv("SOLVER_LEVELS_AUTH_KEYS")?.trim();
  if (rawKeys) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawKeys);
    } catch {
      throw new Error("SOLVER_LEVELS_AUTH_KEYS must be a JSON object of solverId to secret");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("SOLVER_LEVELS_AUTH_KEYS must be a JSON object of solverId to secret");
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      throw new Error("SOLVER_LEVELS_AUTH_KEYS must contain at least one credential");
    }
    const seenSecrets = new Set<string>();
    return entries.map(([solverId, value]) => {
      if (!validSolverId(solverId)) {
        throw new Error(`invalid solver identity in SOLVER_LEVELS_AUTH_KEYS: ${solverId}`);
      }
      if (typeof value !== "string" || value.length < 16 || /\s/.test(value)) {
        throw new Error(
          `secret for solver '${solverId}' must contain at least 16 non-whitespace characters`,
        );
      }
      if (seenSecrets.has(value)) {
        throw new Error("SOLVER_LEVELS_AUTH_KEYS secrets must be unique per solver identity");
      }
      seenSecrets.add(value);
      return { solverId, secret: value };
    });
  }

  const secret = getEnv("SOLVER_LEVELS_AUTH_SECRET");
  if (secret === undefined || secret === "") return [];
  if (secret.length < 16 || /\s/.test(secret)) {
    throw new Error(
      "SOLVER_LEVELS_AUTH_SECRET must contain at least 16 non-whitespace characters",
    );
  }
  return [{
    solverId: `solver-${createHash("sha256").update(secret).digest("hex").slice(0, 32)}`,
    secret,
  }];
}

/** Constant-time bearer lookup over the configured credential set. */
export function authenticateSolverLevelsToken(
  token: string,
  credentials = solverLevelsCredentials(),
): string | null {
  const supplied = Buffer.from(token);
  let authenticated: string | null = null;
  for (const credential of credentials) {
    const expected = Buffer.from(credential.secret);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      authenticated = credential.solverId;
    }
  }
  return authenticated;
}

/** Dedicated read-only credential for the grouped solver-liquidity source.
 * It is intentionally not part of the levels-write registry: the relay may
 * read indicative data but must never gain publication authority. */
export function solverLiquidityReadAuthSecret(): string {
  const secret = getEnv("SOLVER_LIQUIDITY_READ_AUTH_SECRET");
  if (secret === undefined || secret === "" || secret.length < 32 || /\s/.test(secret)) {
    throw new Error(
      "SOLVER_LIQUIDITY_READ_AUTH_SECRET must contain at least 32 non-whitespace characters",
    );
  }

  // Parsing the write registry is part of the read boundary's fail-closed
  // configuration check: if it cannot be understood, credential separation
  // cannot be established safely.
  const writeCredentials = solverLevelsCredentials();
  const configuredSingleWriteSecret = getEnv("SOLVER_LEVELS_AUTH_SECRET");
  if (
    writeCredentials.some((credential) => credential.secret === secret) ||
    (configuredSingleWriteSecret !== undefined && configuredSingleWriteSecret === secret)
  ) {
    throw new Error(
      "SOLVER_LIQUIDITY_READ_AUTH_SECRET must differ from every levels-write credential",
    );
  }
  return secret;
}

/** Compare fixed-size digests so correct, wrong, and differently sized bearer
 * values use the same timing-safe equality primitive. */
export function authenticateSolverLiquidityReadToken(
  token: string,
  expectedSecret: string,
): boolean {
  const suppliedDigest = createHash("sha256").update(token).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

/** Solver-backed precedence changes the established /v1/quote contract and is
 * therefore opt-in until protocol scope is approved. Only literal "true"
 * enables it; missing or malformed values fail closed. */
export const isSolverLevelsQuoteEnabled = (): boolean =>
  (getEnv("SOLVER_LEVELS_QUOTE_ENABLED") ?? "false") === "true";

// Unit tests can disable the MQTT subscriber explicitly; deployed nodes keep
// it on by default because SSE/pair projections must observe committed events.
export const isPostCommitEventBridgeEnabled = (): boolean =>
  (getEnv("POST_COMMIT_EVENT_BRIDGE_ENABLED") ?? "true") === "true";

// Demo token registry (POST /api/known-tokens). known_tokens is a manually
// curated convenience table: the Midnight token-metadata standard is not live,
// so any name written here is unverified and any operator can claim any name
// for any color. Off by default — enable only for local dev and e2e, never on
// a deployment whose data anyone trusts.
export const isTokenRegistryEnabled = (): boolean =>
  (getEnv("ENABLE_TOKEN_REGISTRY") ?? "false").toLowerCase() === "true";

// NOTE: there is deliberately no nullifier TTL. Shielded spends are permanent,
// so the nullifier set must be complete for `isNullifierSpent` to be a sound
// double-spend gate — see the note in the midnight-zswap-event transition.
// Unshielded liveness needs no TTL either: created_unshielded is a live-set
// (create inserts, spend deletes), so it is self-trimming. Only known_roots is
// TTL-limited, because root validity genuinely expires — ROOT_WINDOW_SECONDS.


export const midnightContract = (() => {
  try {
    return readMidnightContract("contract-offer-files", {
      // fileURLToPath, not URL.pathname: pathname percent-encodes, breaking
      // checkouts under a directory with a space.
      baseDir: fileURLToPath(new URL("../contracts-midnight/", import.meta.url)),
      networkId: midnightNetworkConfig.id,
    });
  } catch (error) {
    console.error("[Midnight contract read error]", error);
    return null;
  }
})();
