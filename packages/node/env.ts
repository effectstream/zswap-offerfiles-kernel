import { fileURLToPath } from "node:url";

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

// The websocket update stream (`GET /v1/offers/updates`) never reaches the
// router-wide request budget — an upgrade request bypasses Fastify's routing
// entirely — so, exactly as for SSE, concurrent subscriptions are what has to
// be capped. Excess clients are refused the upgrade with `503 UPDATES_CAPACITY`.
export const apiUpdatesMaxConnections = (): number => {
  const raw = getEnv("API_UPDATES_MAX_CONNECTIONS") ?? "100";
  if (!/^[1-9][0-9]*$/.test(raw)) return 100;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 10_000 ? parsed : 100;
};

// Decision budget for one exact-files read. Keep a hard upper bound so an
// operator typo cannot silently permit unbounded async read work. The route
// observes it at async yields and between validation stages. The ledger's
// synchronous native proof call blocks the event loop and therefore cannot be
// preempted (or notice an elapsed timer) mid-call, so the route retains its
// concurrency slot until any post-deadline read really settles.
export const exactFilesReadTimeoutMs = (): number => {
  const raw = getEnv("OFFER_FILES_READ_TIMEOUT_MS") ?? "15000";
  if (!/^[1-9][0-9]*$/.test(raw)) return 15_000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 60_000 ? parsed : 15_000;
};

// Unit tests can disable upstream's post-commit event gate poll (0358d9e)
// explicitly. Its 1 s tick issues a getLatestEffectstreamBlock on the API's own
// connection, which is indistinguishable from validation-path work to a test
// that counts queries on that connection — and could even be the query a test
// intends to hold. Deployed nodes keep it on: without the poll nothing the
// state machine emits is ever published.
export const isEventGatePollEnabled = (): boolean =>
  (getEnv("EVENT_GATE_POLL_ENABLED") ?? "true") === "true";

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
