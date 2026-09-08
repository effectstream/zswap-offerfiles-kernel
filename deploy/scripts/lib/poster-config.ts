// Environment -> `PosterConfig`. Pure and free of deployment artefacts.
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
//  3. TOKEN IDS ARE EXPLICIT. `GIVE_TOKEN` and `WANT_TOKEN` are required 64-hex
//     shielded token IDs from the selected network's external registry. No
//     issuer address, deployment JSON or local derivation participates.

import { Buffer } from "node:buffer";
import { mnemonicToSeed } from "@scure/bip39";

export interface GiveRange {
  minBase: bigint;
  maxBase: bigint;
}

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
  // ── legs ─────────────────────────────────────────────────────────────────
  /** Explicit 64-hex token ID. */
  readonly giveToken: string;
  readonly giveColour: string;
  /** Required prefunded coin size, in base units (`GIVE_AMOUNT`). */
  readonly giveAmount: bigint;
  /** Optional accepted prefunded coin-size interval, in base units. */
  readonly giveRange: GiveRange | undefined;
  readonly wantToken: string;
  readonly wantColour: string;
  /** `WANT_AMOUNT`, when the operator forces a fixed want leg (FR-005). */
  readonly forcedWantAmount: bigint | undefined;

  // ── loop ─────────────────────────────────────────────────────────────────
  readonly postIntervalMs: number;
  readonly offerTtlMinutes: number;
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
  readonly syncTimeoutMs: number;
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
  | "UNSUPPORTED_TOKEN";

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

function readOptionalBigint(env: EnvMap, key: string): bigint | undefined {
  const raw = readEnv(env, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      "MALFORMED",
      `${key} must be a positive decimal integer in the token's base units, got ${JSON.stringify(raw)}`,
      key,
    );
  }
  return BigInt(raw);
}

/**
 * `GIVE_MIN`/`GIVE_MAX` -> a validated {@link GiveRange}, or `undefined` when
 * neither is set (FR-005: unset range == today's behaviour, byte for byte).
 *
 * Every refusal names the offending variable (AC-5). Half a range is refused
 * too: an operator who set only `GIVE_MIN` meant something, and guessing the
 * other end — today's fixed amount? the same value? — would post offers nobody
 * asked for.
 */
export function parseGiveRange(env: EnvMap): GiveRange | undefined {
  const minBase = readOptionalBigint(env, "GIVE_MIN");
  const maxBase = readOptionalBigint(env, "GIVE_MAX");

  if (minBase === undefined && maxBase === undefined) return undefined;
  if (minBase === undefined) {
    throw new ConfigError("MISSING", "GIVE_MAX is set but GIVE_MIN is not; a range needs both ends", "GIVE_MIN");
  }
  if (maxBase === undefined) {
    throw new ConfigError("MISSING", "GIVE_MIN is set but GIVE_MAX is not; a range needs both ends", "GIVE_MAX");
  }
  if (minBase < 1n) {
    throw new ConfigError(
      "MALFORMED",
      `GIVE_MIN must be greater than zero base units, got ${minBase}`,
      "GIVE_MIN",
    );
  }
  if (maxBase < minBase) {
    throw new ConfigError(
      "MALFORMED",
      `GIVE_MAX (${maxBase}) must be >= GIVE_MIN (${minBase}) base units`,
      "GIVE_MAX",
    );
  }
  return { minBase, maxBase };
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
// Legs
// ---------------------------------------------------------------------------

interface ResolvedLeg {
  token: string;
  colour: string;
}

function resolveLeg(env: EnvMap, key: string): ResolvedLeg {
  const raw = readEnv(env, key);
  if (raw === undefined) {
    throw new ConfigError(
      "MISSING",
      `${key} is required: set the 64-hex token ID from the selected network's external registry`,
      key,
    );
  }
  const colour = raw.replace(/^0[xX]/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(colour)) {
    throw new ConfigError("MALFORMED", `${key} must be a 64-hex token ID`, key);
  }
  if (colour === "0".repeat(64)) {
    throw new ConfigError("UNSUPPORTED_TOKEN", `${key} is native NIGHT; offer legs must be shielded`, key);
  }
  return { token: colour, colour };
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Parse and validate the poster's whole environment.
 *
 * Async only because BIP-39 seed derivation is. Throws {@link ConfigError} for
 * every refusal; nothing here touches the network or filesystem.
 */
export async function parsePosterConfig(env: EnvMap): Promise<PosterConfig> {
  const { seed, source: seedSource } = await resolveSeed(env);

  // Endpoint defaults MUST match `@effectstream/midnight-contracts`'s
  // `midnightNetworkConfig`, which is what the wallet facade reads. The poster resolves them
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

  const give = resolveLeg(env, "GIVE_TOKEN");
  const want = resolveLeg(env, "WANT_TOKEN");
  if (give.colour === want.colour) {
    throw new ConfigError(
      "UNSUPPORTED_TOKEN",
      `GIVE_TOKEN and WANT_TOKEN are the same token ID ${give.colour.slice(0, 12)}…; ` +
        `the kernel answers 400 VALIDATION for a quote whose legs are equal`,
      "WANT_TOKEN",
    );
  }
  // ── prefunded coin size: one exact amount, or an accepted base-unit range ──
  const giveRange = parseGiveRange(env);
  if (giveRange !== undefined && readEnv(env, "GIVE_AMOUNT") !== undefined) {
    throw new ConfigError(
      "CONFLICT",
      "GIVE_AMOUNT (a fixed size) and GIVE_MIN/GIVE_MAX (a range to draw from) are both set; " +
        "give exactly one. In deploy/.env that is OFFER_POSTER_GIVE_AMOUNT versus " +
        "OFFER_POSTER_GIVE_MIN/OFFER_POSTER_GIVE_MAX — blank the one you do not want, because a " +
        "blank value means \"the code's default\" and an empty string is not a size",
      "GIVE_AMOUNT",
    );
  }

  const forcedWantAmountRaw = readEnv(env, "WANT_AMOUNT");
  const forcedWantAmount =
    forcedWantAmountRaw === undefined ? undefined : readBigint(env, "WANT_AMOUNT", 0n, { min: 0n });

  const cfg: PosterConfig = {
    seed,
    seedSource,
    networkUrls,
    networkId,
    kernelBase,

    giveToken: give.token,
    giveColour: give.colour,
    // Base units are explicit because tokens may have 6, 8, 18 or other
    // registry-defined decimals. The default accepts a one-base-unit coin.
    giveAmount: readBigint(env, "GIVE_AMOUNT", 1n, {
      min: 1n,
    }),
    giveRange,
    wantToken: want.token,
    wantColour: want.colour,
    forcedWantAmount,

    postIntervalMs: readInt(env, "POST_INTERVAL_MS", 60_000, { min: 1 }),
    offerTtlMinutes: readInt(env, "OFFER_TTL_MINUTES", 60, { min: 1 }),
    reconcileIntervalMs: readInt(env, "RECONCILE_INTERVAL_MS", 60_000, { min: 1 }),
    maxReoffersPerTick: readInt(env, "POSTER_MAX_REOFFERS_PER_TICK", 1, { min: 1 }),
    shutdownGraceMs: readInt(env, "SHUTDOWN_GRACE_MS", 15_000, { min: 0 }),
    healthStaleTicks: readInt(env, "HEALTH_STALE_TICKS", 3, { min: 1 }),
    healthPort: readInt(env, "POSTER_HEALTH_PORT", 9977, { min: 1 }),
    dryRun: readBool(env, "DRY_RUN", false),

    journalFile: readString(env, "POSTER_JOURNAL_FILE", "/var/lib/offer-poster/journal.json"),
    journalReset: readBool(env, "POSTER_JOURNAL_RESET", false),

    syncTimeoutMs: readInt(env, "POSTER_SYNC_TIMEOUT_MS", 180_000, { min: 1 }),
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
