// Environment -> `PosterConfig`. Pure apart from ONE injectable file read.
//
// Everything the offer poster needs to decide what to do is resolved here, once,
// at startup, and every refusal happens here rather than three minutes later in
// the middle of a proving run. The module is deliberately free of wallet, SDK
// and network code so its whole surface is unit-testable (spec FR-014, FR-001).
//
// Three rules this file encodes that are easy to get wrong:
//
//  1. "" IS NOT UNSET. Compose renders `FOO: ${FOO}` for an absent FOO as the
//     EMPTY STRING, so a knob an operator simply left blank in `.env` arrives as
//     a present-but-empty variable. `entrypoint-common.sh` unsets a hand-picked
//     list before exec, but nothing guarantees the poster's knobs are on it, so
//     `readEnv` treats a blank (or whitespace-only) value as absent. This mirrors
//     the reasoning in `deploy/images/kernel/entrypoint-common.sh:19-55`.
//
//  2. THE SEED IS SECRET AND MUST BE THE POSTER'S OWN. `POSTER_SEED` xor
//     `POSTER_MNEMONIC` (FR-001); a mnemonic is turned into a seed exactly the
//     way `@effectstream/midnight-contracts/src/midnight-env.ts:70-72` does it
//     (`@scure/bip39` `mnemonicToSeed` -> 64 BYTES -> 128 hex chars), so a
//     mnemonic that works in Lace works here. A seed equal to any wallet seed
//     visible in the same environment is refused: two facades on one seed is
//     forbidden by the SDK, and the poster would fight the maker/solver/batcher
//     over the same coins. `redactConfig` is the ONLY way this object should
//     ever reach a log.
//
//  3. COLOURS ARE DERIVED FROM THE CONTRACT, NOT CONFIGURED. `GIVE_TOKEN` /
//     `WANT_TOKEN` accept a faucet preset NAME (WBTC, WETH, …) or a 64-hex
//     colour; a name is resolved offline through `rawTokenType(domainSep, addr)`
//     so it is right for THIS deployment and no other. An unshielded preset is
//     refused outright — a cross-layer offer is rejected by the kernel (FR-014 /
//     US4 scenario 3).

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mnemonicToSeed } from "@scure/bip39";

import {
  assertShieldedPreset,
  isColourHex,
  normaliseHex32,
  normaliseTokenName,
  presetKind,
  resolveColour,
} from "./faucet-mint.ts";
import { coinsToBaseUnits, DEFAULT_TOKEN_DECIMALS } from "../../../packages/solver-core/amount.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `process.env`, or any map a test hands in. */
export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface PosterNetworkUrls {
  readonly id: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export interface PosterConfig {
  // ── wallet (SECRET) ──────────────────────────────────────────────────────
  /** 64 or 128 lowercase hex chars. NEVER log this; use `redactConfig`. */
  readonly seed: string;
  /** Which variable produced `seed` — safe to log. */
  readonly seedSource: "POSTER_SEED" | "POSTER_MNEMONIC";

  // ── endpoints ────────────────────────────────────────────────────────────
  readonly networkUrls: PosterNetworkUrls;
  readonly networkId: string;
  /** Kernel API base (`ZSWAP_API`). */
  readonly kernelBase: string;
  /** The deployed offer-files contract, 64 lowercase hex. */
  readonly contractAddress: string;
  /** Where the contract address came from — safe to log, useful when it is wrong. */
  readonly contractAddressSource: string;

  // ── legs ─────────────────────────────────────────────────────────────────
  /** As configured (a preset NAME, or a 64-hex colour). */
  readonly giveToken: string;
  /** The give-leg NAME when one was configured; `undefined` for a raw colour.
   *  Minting REQUIRES a name — the faucet derives the colour from it. */
  readonly giveTokenName: string | undefined;
  readonly giveColour: string;
  readonly giveAmount: bigint;
  readonly wantToken: string;
  readonly wantTokenName: string | undefined;
  readonly wantColour: string;
  /** `WANT_AMOUNT`, when the operator forces a fixed want leg (FR-005). */
  readonly forcedWantAmount: bigint | undefined;

  // ── loop ─────────────────────────────────────────────────────────────────
  readonly postIntervalMs: number;
  readonly offerTtlMinutes: number;
  readonly coinVisibleTimeoutMs: number;
  readonly reconcileIntervalMs: number;
  readonly maxReoffersPerTick: number;
  readonly shutdownGraceMs: number;
  readonly healthStaleTicks: number;
  readonly healthPort: number;
  readonly dryRun: boolean;

  // ── journal ──────────────────────────────────────────────────────────────
  readonly journalFile: string;
  readonly journalReset: boolean;

  // ── budgets ──────────────────────────────────────────────────────────────
  /** Minimum spendable DUST before a tick is allowed to MINT (FR-010). */
  readonly minDust: bigint;
  readonly syncTimeoutMs: number;
  readonly dustWaitTimeoutMs: number;
  /** Bounded `ROOT_UNKNOWN` / `UTXO_NOT_LIVE` retries on `POST /v1/offers`. */
  readonly postRetries: number;
  readonly postRetryMs: number;
  /** Poll budget for the offer to reach `live`. */
  readonly liveTries: number;
  readonly liveIntervalMs: number;
}

/** A `PosterConfig` with every secret replaced. Safe to `JSON.stringify`. */
export type RedactedPosterConfig = Omit<PosterConfig, "seed"> & { seed: string };

export type ConfigErrorCode =
  | "MISSING"
  | "CONFLICT"
  | "MALFORMED"
  | "SEED_COLLISION"
  | "UNSUPPORTED_TOKEN"
  | "NO_CONTRACT";

/** Every refusal in this module. `code` lets the caller pick an exit status
 *  without matching on prose. The message NEVER contains a secret. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly variable?: string;

  constructor(code: ConfigErrorCode, message: string, variable?: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    if (variable !== undefined) this.variable = variable;
  }
}

// ---------------------------------------------------------------------------
// Primitive readers ("" is not a value)
// ---------------------------------------------------------------------------

/** Trimmed value, or `undefined` for absent / blank / whitespace-only. */
export function readEnv(env: EnvMap, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === "" ? undefined : trimmed;
}

function readString(env: EnvMap, key: string, fallback: string): string {
  return readEnv(env, key) ?? fallback;
}

function readInt(env: EnvMap, key: string, fallback: number, opts: { min?: number } = {}): number {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError("MALFORMED", `${key} must be an integer, got ${JSON.stringify(raw)}`, key);
  }
  const value = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ConfigError("MALFORMED", `${key} must be an integer >= ${min}, got ${raw}`, key);
  }
  return value;
}

function readBigint(env: EnvMap, key: string, fallback: bigint, opts: { min?: bigint } = {}): bigint {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      "MALFORMED",
      `${key} must be a non-negative decimal integer (base units), got ${JSON.stringify(raw)}`,
      key,
    );
  }
  const value = BigInt(raw);
  const min = opts.min ?? 0n;
  if (value < min) {
    throw new ConfigError("MALFORMED", `${key} must be >= ${min}, got ${raw}`, key);
  }
  return value;
}

/** `true`/`1`/`yes`/`on` (case-insensitive) are true; `false`/`0`/`no`/`off`
 *  are false; anything else is a startup error rather than a silent `false`. */
function readBool(env: EnvMap, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  throw new ConfigError("MALFORMED", `${key} must be true or false, got ${JSON.stringify(raw)}`, key);
}

// ---------------------------------------------------------------------------
// Seed resolution
// ---------------------------------------------------------------------------

const HEX_SEED = /^[0-9a-f]+$/;

/**
 * Wallet seeds that may legitimately be present in the poster's environment and
 * that the poster must NOT share.
 *
 * FR-001 names the first four. The remaining three are in `deploy/.env.example`
 * (`:90-94`) and are just as dangerous: one wallet facade per seed is an SDK
 * rule, and two processes on one seed fight over the same coins. A superset is
 * strictly safer here — nothing legitimate wants the poster to run on the
 * genesis, maker or taker wallet.
 */
export const COLLIDING_SEED_VARS: readonly string[] = [
  "MIDNIGHT_WALLET_SEED",
  "BATCHER_WALLET_SEED",
  "SOLVER_SEED",
  "MAKER_OFFER_SEED",
  "MIDNIGHT_GENESIS_SEED",
  "MAKER_SEED",
  "TAKER_SEED",
];

/** Lowercased, `0x`-stripped — so `0xAB…` and `ab…` compare equal. */
function normaliseSeed(value: string): string {
  const s = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return s.trim().toLowerCase();
}

/**
 * `POSTER_SEED` xor `POSTER_MNEMONIC` -> a hex seed.
 *
 * The mnemonic path mirrors `@effectstream/midnight-contracts/src/midnight-env.ts:70-72`
 * byte for byte: `mnemonicToSeed` (BIP-39, empty passphrase) gives 64 bytes,
 * hex-encoded to 128 characters. `HDWallet.fromSeed` accepts both lengths, so
 * the two inputs produce interchangeable wallets and a Lace mnemonic lands on
 * the address Lace shows.
 */
export async function resolveSeed(
  env: EnvMap,
): Promise<{ seed: string; source: "POSTER_SEED" | "POSTER_MNEMONIC" }> {
  const rawSeed = readEnv(env, "POSTER_SEED");
  const mnemonic = readEnv(env, "POSTER_MNEMONIC");

  if (rawSeed !== undefined && mnemonic !== undefined) {
    throw new ConfigError(
      "CONFLICT",
      "POSTER_SEED and POSTER_MNEMONIC are both set; give exactly one " +
        "(two spellings of a wallet cannot be checked against each other, and " +
        "silently preferring one would hide an operator mistake)",
    );
  }
  if (rawSeed === undefined && mnemonic === undefined) {
    throw new ConfigError(
      "MISSING",
      "the poster needs its own wallet: set POSTER_SEED (64 hex chars) or POSTER_MNEMONIC (BIP-39)",
    );
  }

  let seed: string;
  let source: "POSTER_SEED" | "POSTER_MNEMONIC";
  if (rawSeed !== undefined) {
    seed = normaliseSeed(rawSeed);
    // 32 bytes is what every dev seed in this repo is; 64 bytes is what a
    // mnemonic produces. Accept both, reject everything else — a truncated
    // paste would otherwise become a DIFFERENT, silently valid wallet.
    if (!HEX_SEED.test(seed) || (seed.length !== 64 && seed.length !== 128)) {
      throw new ConfigError(
        "MALFORMED",
        `POSTER_SEED must be 64 or 128 hex characters (32 or 64 bytes); got ${seed.length} characters` +
          (HEX_SEED.test(seed) ? "" : " and at least one non-hex character"),
        "POSTER_SEED",
      );
    }
    source = "POSTER_SEED";
  } else {
    const words = mnemonic!.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < 12) {
      throw new ConfigError(
        "MALFORMED",
        `POSTER_MNEMONIC has ${words.length} words; a BIP-39 mnemonic has at least 12`,
        "POSTER_MNEMONIC",
      );
    }
    // `mnemonicToSeed` does NOT validate the checksum (that is `validateMnemonic`),
    // and neither does midnight-env; matching it exactly is the point here.
    seed = Buffer.from(await mnemonicToSeed(words.join(" "))).toString("hex");
    source = "POSTER_MNEMONIC";
  }

  // FR-001: never share a wallet with another service in the same stack.
  for (const name of COLLIDING_SEED_VARS) {
    const other = readEnv(env, name);
    if (other === undefined) continue;
    if (normaliseSeed(other) === seed) {
      throw new ConfigError(
        "SEED_COLLISION",
        `the poster's wallet seed is identical to ${name}. One wallet facade per seed is an SDK ` +
          `rule and the two processes would fight over the same coins — give the poster its own seed.`,
        name,
      );
    }
  }
  const otherMnemonic = readEnv(env, "MIDNIGHT_WALLET_MNEMONIC");
  if (source === "POSTER_MNEMONIC" && otherMnemonic !== undefined) {
    const otherSeed = Buffer.from(await mnemonicToSeed(otherMnemonic.split(/\s+/).join(" "))).toString(
      "hex",
    );
    if (otherSeed === seed) {
      throw new ConfigError(
        "SEED_COLLISION",
        "POSTER_MNEMONIC derives the same wallet as MIDNIGHT_WALLET_MNEMONIC — give the poster its own wallet",
        "MIDNIGHT_WALLET_MNEMONIC",
      );
    }
  }

  return { seed, source };
}

// ---------------------------------------------------------------------------
// Contract address
// ---------------------------------------------------------------------------

/** The repo root, from this file's location (`deploy/scripts/lib` -> up 3).
 *  `fileURLToPath`, not `URL.pathname`: pathname percent-encodes, which breaks
 *  a checkout under a directory with a space (the same note as
 *  `packages/solver-core/offer-files.ts:21-23`). */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface ConfigIO {
  /** Read a UTF-8 file, or return `undefined` when it does not exist. */
  readFile(path: string): string | undefined;
}

const defaultIO: ConfigIO = {
  readFile(path: string): string | undefined {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return undefined;
    }
  },
};

export interface ContractAddressResolution {
  address: string;
  /** Human-readable provenance for the startup log. */
  source: string;
}

/**
 * Where the deployed contract address comes from, in priority order:
 *
 *  1. `MIDNIGHT_CONTRACT_ADDRESS` — what `entrypoint-common.sh`'s
 *     `adopt_contract_address` EXPORTS (`:125`) after waiting for the
 *     `offerfiles-deploy` one-shot. In compose this is always the live path.
 *  2. `${CONTRACT_SHARE_DIR}/contract-offer-files.<networkId>.json` — the shared
 *     volume the same function reads (`:98`), for a poster started without the
 *     entrypoint.
 *  3. `<repo>/packages/contracts-midnight/contract-offer-files.<networkId>.json`
 *     — where the entrypoint INSTALLS it (`:112`) and where
 *     `packages/solver-core/offer-files.ts:53-57` reads it from. That file is
 *     also what a local `bun run` sees after a local deploy.
 *
 * Note the network id in the file name: `getContractAddress()` in solver-core
 * hard-codes `undeployed`, which is right for the compose stack and wrong for
 * preprod. The poster is network-aware because US4 requires a preprod dry run.
 */
export function resolveContractAddress(
  env: EnvMap,
  networkId: string,
  io: ConfigIO = defaultIO,
): ContractAddressResolution {
  const explicit = readEnv(env, "MIDNIGHT_CONTRACT_ADDRESS");
  if (explicit !== undefined) {
    return {
      address: normaliseHex32(explicit, "MIDNIGHT_CONTRACT_ADDRESS"),
      source: "MIDNIGHT_CONTRACT_ADDRESS",
    };
  }

  const fileName = `contract-offer-files.${networkId}.json`;
  const shareDir = readString(env, "CONTRACT_SHARE_DIR", "/srv/offerfiles-deploy");
  const candidates = [
    resolve(shareDir, fileName),
    resolve(REPO_ROOT, "packages/contracts-midnight", fileName),
  ];

  for (const path of candidates) {
    const text = io.readFile(path);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigError("NO_CONTRACT", `${path} is not valid JSON (${String(err)})`);
    }
    const address = (parsed as { contractAddress?: unknown } | null)?.contractAddress;
    if (typeof address !== "string" || address.trim() === "") {
      throw new ConfigError("NO_CONTRACT", `${path} has no string "contractAddress"`);
    }
    return { address: normaliseHex32(address.trim(), `contractAddress in ${path}`), source: path };
  }

  throw new ConfigError(
    "NO_CONTRACT",
    `no deployed offer-files contract: set MIDNIGHT_CONTRACT_ADDRESS, or make one of ` +
      `${candidates.join(" / ")} readable (the offerfiles-deploy one-shot publishes it)`,
  );
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

interface ResolvedLeg {
  /** As configured. */
  token: string;
  /** The preset/faucet NAME, or `undefined` when a raw colour was given. */
  name: string | undefined;
  colour: string;
}

/** A leg is either a faucet token NAME (minted and derived offline) or a raw
 *  64-hex colour (usable as a want leg, never mintable). Unshielded presets are
 *  refused: a cross-layer offer is rejected by the kernel (US4 scenario 3). */
function resolveLeg(env: EnvMap, key: string, fallback: string, contractAddress: string): ResolvedLeg {
  const token = readString(env, key, fallback);
  try {
    assertShieldedPreset(token);
  } catch (err) {
    throw new ConfigError(
      "UNSUPPORTED_TOKEN",
      `${key}=${JSON.stringify(token)}: ${err instanceof Error ? err.message : String(err)}`,
      key,
    );
  }
  if (isColourHex(token)) {
    return { token, name: undefined, colour: normaliseHex32(token, key) };
  }
  const name = normaliseTokenName(token);
  return { token, name, colour: resolveColour(name, contractAddress) };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Parse and validate the poster's whole environment.
 *
 * Async only because BIP-39 seed derivation is. Throws {@link ConfigError} for
 * every refusal; nothing here touches the network, and the only filesystem
 * access is the injectable contract-address read.
 */
export async function parsePosterConfig(env: EnvMap, io: ConfigIO = defaultIO): Promise<PosterConfig> {
  const { seed, source: seedSource } = await resolveSeed(env);

  // Endpoint defaults MUST match `@effectstream/midnight-contracts`'s
  // `midnightNetworkConfig`, which is what the wallet facade and the contract
  // join actually read (`src/midnight-env.ts:29-83`). The poster resolves them
  // itself as well so the startup log can show them and a mismatch is visible.
  const networkId = readString(env, "MIDNIGHT_NETWORK_ID", "undeployed");
  const isUndeployed = networkId === "undeployed";
  const networkUrls: PosterNetworkUrls = {
    id: networkId,
    indexer: readString(
      env,
      "MIDNIGHT_INDEXER_HTTP",
      isUndeployed
        ? "http://127.0.0.1:8088/api/v3/graphql"
        : `https://indexer.${networkId}.midnight.network/api/v3/graphql`,
    ),
    indexerWS: readString(
      env,
      "MIDNIGHT_INDEXER_WS",
      isUndeployed
        ? "ws://127.0.0.1:8088/api/v3/graphql/ws"
        : `wss://indexer.${networkId}.midnight.network/api/v3/graphql/ws`,
    ),
    node: readString(
      env,
      "MIDNIGHT_NODE_HTTP",
      isUndeployed ? "http://127.0.0.1:9944" : `https://rpc.${networkId}.midnight.network`,
    ),
    proofServer:
      readEnv(env, "MIDNIGHT_PROOF_SERVER_URL") ??
      readEnv(env, "MIDNIGHT_PROOF_SERVER") ??
      "http://127.0.0.1:6300",
  };

  const kernelBase = (readEnv(env, "ZSWAP_API") ?? readEnv(env, "NODE_URL") ?? "http://kernel:9999").replace(
    /\/$/,
    "",
  );

  const { address: contractAddress, source: contractAddressSource } = resolveContractAddress(
    env,
    networkId,
    io,
  );

  const give = resolveLeg(env, "GIVE_TOKEN", "WBTC", contractAddress);
  const want = resolveLeg(env, "WANT_TOKEN", "WETH", contractAddress);
  if (give.colour === want.colour) {
    throw new ConfigError(
      "UNSUPPORTED_TOKEN",
      `GIVE_TOKEN and WANT_TOKEN resolve to the same colour ${give.colour.slice(0, 12)}…; ` +
        `the kernel answers 400 VALIDATION for a quote whose legs are equal`,
      "WANT_TOKEN",
    );
  }
  if (give.name === undefined) {
    // The faucet mints from a NAME (`mint_shielded(domainSepFromName(name), …)`),
    // so a raw colour on the give leg can never be minted. Re-offering a coin
    // that is already in the wallet would still work, but a poster that can only
    // re-offer is not what FR-003 describes — refuse rather than degrade.
    throw new ConfigError(
      "UNSUPPORTED_TOKEN",
      `GIVE_TOKEN must be a faucet token NAME (e.g. WBTC), not a raw colour: the poster mints the ` +
        `give leg and the faucet derives the colour from the name`,
      "GIVE_TOKEN",
    );
  }
  // `presetKind` returns undefined for a name the frontend faucet does not
  // offer. That is allowed (the derivation is defined for any name) but worth
  // recording so the startup log can say so.
  void presetKind(give.name);

  const forcedWantAmountRaw = readEnv(env, "WANT_AMOUNT");
  const forcedWantAmount =
    forcedWantAmountRaw === undefined ? undefined : readBigint(env, "WANT_AMOUNT", 0n, { min: 0n });

  const cfg: PosterConfig = {
    seed,
    seedSource,
    networkUrls,
    networkId,
    kernelBase,
    contractAddress,
    contractAddressSource,

    giveToken: give.token,
    giveTokenName: give.name,
    giveColour: give.colour,
    // BASE UNITS, as the env has always been. The default is ONE WHOLE COIN
    // at the registry's 6 decimals (00024 Q5), so a poster journal reads in
    // round coins instead of in millionths.
    giveAmount: readBigint(env, "GIVE_AMOUNT", coinsToBaseUnits(1n, DEFAULT_TOKEN_DECIMALS), {
      min: 1n,
    }),
    wantToken: want.token,
    wantTokenName: want.name,
    wantColour: want.colour,
    forcedWantAmount,

    postIntervalMs: readInt(env, "POST_INTERVAL_MS", 60_000, { min: 1 }),
    offerTtlMinutes: readInt(env, "OFFER_TTL_MINUTES", 60, { min: 1 }),
    coinVisibleTimeoutMs: readInt(env, "COIN_VISIBLE_TIMEOUT_MS", 120_000, { min: 1 }),
    reconcileIntervalMs: readInt(env, "RECONCILE_INTERVAL_MS", 60_000, { min: 1 }),
    maxReoffersPerTick: readInt(env, "POSTER_MAX_REOFFERS_PER_TICK", 1, { min: 1 }),
    shutdownGraceMs: readInt(env, "SHUTDOWN_GRACE_MS", 15_000, { min: 0 }),
    healthStaleTicks: readInt(env, "HEALTH_STALE_TICKS", 3, { min: 1 }),
    healthPort: readInt(env, "POSTER_HEALTH_PORT", 9977, { min: 1 }),
    dryRun: readBool(env, "DRY_RUN", false),

    journalFile: readString(env, "POSTER_JOURNAL_FILE", "/var/lib/offer-poster/journal.json"),
    journalReset: readBool(env, "POSTER_JOURNAL_RESET", false),

    minDust: readBigint(env, "POSTER_MIN_DUST", 1n, { min: 0n }),
    syncTimeoutMs: readInt(env, "POSTER_SYNC_TIMEOUT_MS", 180_000, { min: 1 }),
    dustWaitTimeoutMs: readInt(env, "POSTER_DUST_WAIT_TIMEOUT_MS", 300_000, { min: 1 }),
    postRetries: readInt(env, "POSTER_POST_RETRIES", 24, { min: 1 }),
    postRetryMs: readInt(env, "POSTER_POST_RETRY_MS", 5_000, { min: 1 }),
    liveTries: readInt(env, "POSTER_LIVE_TRIES", 40, { min: 1 }),
    liveIntervalMs: readInt(env, "POSTER_LIVE_INTERVAL_MS", 5_000, { min: 1 }),
  };

  if (cfg.healthPort > 65_535) {
    throw new ConfigError("MALFORMED", `POSTER_HEALTH_PORT must be <= 65535, got ${cfg.healthPort}`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/** The seed replaced by a fixed marker plus its length — enough to tell a
 *  32-byte seed from a 64-byte one when debugging, and nothing else. FR-015. */
export function redactConfig(cfg: PosterConfig): RedactedPosterConfig {
  return { ...cfg, seed: `[redacted ${cfg.seed.length} hex chars]` };
}

/** `JSON.stringify` of the redacted config, with bigints as decimal strings.
 *  The ONLY sanctioned way to dump the configuration. */
export function configDump(cfg: PosterConfig): string {
  return JSON.stringify(
    redactConfig(cfg),
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
