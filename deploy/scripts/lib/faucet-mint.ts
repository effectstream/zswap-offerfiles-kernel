// Faucet minting for the offer poster: derive a token colour offline, mint one
// shielded coin through the offer-files contract, and register the colour's
// name with the kernel so the leg quotes at a real price.
//
// WHY THE COLOUR IS DERIVED OFFLINE AND THEN ASSERTED.
//
// `mint_shielded` mints `rawTokenType(domain_sep, contractAddress)`, so the
// colour of "WBTC" is a property of the DEPLOYMENT, not of the name — every
// fresh stack mints a different WBTC. Deriving it before the call and checking
// the mint returned exactly that colour is what turns "we minted something" into
// "we minted the token the frontend, the price map and the operator all mean by
// WBTC". A silent mismatch would produce coins nobody can price and offers the
// batcher refuses to sponsor, which is far more expensive to diagnose after the
// fact than one equality check here.
//
// Verified offline against preprod's contract 6fc44c27…bb7c (see the vector
// test): WBTC → e7580bfc…a912, WETH → fda14e2e…a0a5, USDC → e840515e…2093 —
// the colours preprod actually has registered.
//
// IMPORTS. First-party code is imported by RELATIVE path with an explicit `.ts`
// extension and third-party packages by bare specifier resolved from the ROOT
// package.json — `deploy/` is not a workspace member, so nothing else resolves
// (see `maker-offer.ts`'s header and P0 note 3 of the plan).

import { coinNullifier, decodeShieldedCoinInfo, rawTokenType } from "@midnight-ntwrk/ledger-v8";
import type { CoinSecretKey, ShieldedCoinInfo } from "@midnight-ntwrk/ledger-v8";

// The faucet derivation itself, imported rather than copied. `mintable.ts` has
// no imports of its own — it is 40 lines of TextEncoder and Math.imul — so
// reaching into `docs/` costs nothing and pulls in no frontend dependency, and
// the kernel image `COPY . .`s the whole tree, so it is present at runtime too.
// Importing it (instead of copying) is what guarantees the poster can never
// drift from the browser faucet.
import {
  domainSepFromName,
  NIGHT_COLOR,
  PRESET_TOKENS,
} from "../../../docs/src/wallet/mintable.ts";
import type { MintableKind } from "../../../docs/src/wallet/mintable.ts";

// The same map the node uses to price a token BY NAME. Also import-only-pure.
// Knowing it here lets `verifyTokenName` answer "will this leg be priced?"
// before the first quote instead of after the first refused offer.
import { DEFAULT_NAME_ASSET_MAP } from "../../../packages/database/price-map.ts";

import { KernelApi } from "./kernel-api.ts";

export { domainSepFromName, NIGHT_COLOR, PRESET_TOKENS };
export type { MintableKind };

// ── hex helpers ──────────────────────────────────────────────────────────────

/** Lower-case hex, no `0x`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes from lower/upper hex, with or without `0x`. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0[xX]/, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`not hex: "${hex.slice(0, 32)}"`);
  }
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 32 bytes as 64 lower-case hex, `0x` stripped.
 *
 * `rawTokenType` REJECTS a `0x` prefix ("Invalid character 'x' at position 1")
 * and any length other than 32 bytes, but accepts upper-case hex and returns
 * the same colour for it — so normalising here is not cosmetic: an operator who
 * pastes `0x…` gets a clear error instead of a WASM panic, and one who pastes
 * upper-case gets the right answer instead of a spurious mismatch.
 */
export function normaliseHex32(value: string, label: string): string {
  const clean = String(value ?? "").trim().replace(/^0[xX]/, "").toLowerCase();
  if (!HEX64.test(clean)) {
    throw new Error(`${label} must be 64 hex characters (32 bytes), got "${String(value).slice(0, 24)}…"`);
  }
  return clean;
}

/** True when the string is already a 64-hex colour rather than a token name. */
export function isColourHex(nameOrHex: string): boolean {
  return /^(0[xX])?[0-9a-fA-F]{64}$/.test(String(nameOrHex ?? "").trim());
}

// ── presets ──────────────────────────────────────────────────────────────────

/**
 * NIGHT is not a faucet preset (it is the native token, colour all-zero), but
 * an operator can still name it in `GIVE_TOKEN`/`WANT_TOKEN`, and it is
 * unshielded — so it belongs in the refusal set next to ATOKEN/BTOKEN.
 */
const NIGHT_NAME = "NIGHT";

/** Token name as the registry stores it: trimmed, upper-cased, ≤16 chars. */
export function normaliseTokenName(name: string): string {
  return String(name ?? "").trim().toUpperCase().slice(0, 16);
}

/**
 * The kind of a KNOWN preset name, or `undefined` for a name the faucet has no
 * opinion about. `undefined` is not an error: the derivation is defined for any
 * name, so a stack that mints "TESTTOKEN" is perfectly legal — it just is not
 * one of the six the frontend offers.
 */
export function presetKind(name: string): MintableKind | undefined {
  const wanted = normaliseTokenName(name);
  if (wanted === NIGHT_NAME) return "unshielded";
  return PRESET_TOKENS.find((t) => t.name.toUpperCase() === wanted)?.kind;
}

/**
 * Refuse an unshielded leg, and return the kind to register the token under.
 *
 * Cross-layer offers are rejected by the kernel, so BOTH legs of a poster offer
 * must be shielded. This is checked at config time, not at post time, because
 * the failure otherwise surfaces 30 seconds into a proof as an opaque refusal.
 *
 * Accepts a 64-hex colour too, in which case only the all-zero NIGHT colour can
 * be recognised as unshielded — the kind of an arbitrary colour is not knowable
 * offline, so a caller pinning a raw colour is trusted (and `verifyTokenName`
 * will report the registry's `kind` afterwards).
 */
export function assertShieldedPreset(nameOrHex: string): MintableKind {
  const raw = String(nameOrHex ?? "").trim();
  if (raw === "") throw new Error("token name/colour is empty");
  if (isColourHex(raw)) {
    if (normaliseHex32(raw, "token colour") === NIGHT_COLOR) {
      throw new Error(
        `token colour ${NIGHT_COLOR.slice(0, 12)}… is NIGHT, which is unshielded; ` +
          "offers may not cross the shielded/unshielded boundary",
      );
    }
    return "shielded";
  }
  const kind = presetKind(raw);
  if (kind === "unshielded") {
    throw new Error(
      `token "${normaliseTokenName(raw)}" is an UNSHIELDED ${
        normaliseTokenName(raw) === NIGHT_NAME ? "native token" : "faucet preset"
      }; offers may not cross the shielded/unshielded boundary — use a shielded ` +
        `preset (${PRESET_TOKENS.filter((t) => t.kind === "shielded").map((t) => t.name).join(", ")}) ` +
        "or a 64-hex shielded colour",
    );
  }
  return "shielded";
}

// ── colour derivation ────────────────────────────────────────────────────────

/**
 * The colour `mint_shielded(domainSepFromName(name), …)` produces on the
 * contract at `contractAddress`. Pure; no network, no wallet.
 */
export function expectedColour(name: string, contractAddress: string): string {
  const trimmed = String(name ?? "").trim();
  if (trimmed === "") throw new Error("token name is empty");
  if (isColourHex(trimmed)) {
    throw new Error(
      `expectedColour() takes a token NAME, not a colour ("${trimmed.slice(0, 12)}…") — use resolveColour()`,
    );
  }
  const contract = normaliseHex32(contractAddress, "contract address");
  return rawTokenType(domainSepFromName(trimmed), contract).toLowerCase();
}

/**
 * Colour for a leg the operator named either way round: a faucet token name
 * ("WBTC") is derived against this deployment's contract; a 64-hex colour is
 * taken as-is (normalised), because a colour minted somewhere else has no name
 * we could derive it from.
 */
export function resolveColour(nameOrHex: string, contractAddress: string): string {
  const trimmed = String(nameOrHex ?? "").trim();
  if (trimmed === "") throw new Error("token name/colour is empty");
  return isColourHex(trimmed)
    ? normaliseHex32(trimmed, "token colour")
    : expectedColour(trimmed, contractAddress);
}

// ── nonces ───────────────────────────────────────────────────────────────────

let nonceCounter = 0;

/**
 * A mint nonce that is unique for the life of the process and increasing.
 *
 * Re-using a `(domain_sep, nonce)` pair recreates an IDENTICAL coin commitment
 * and the node rejects the transaction as a duplicate, so this must never
 * repeat. `Date.now() * 1000` leaves a thousand slots per millisecond and the
 * counter never resets, which makes the sequence strictly increasing regardless
 * of clock resolution.
 *
 * Caveat for a restart: the counter starts at 0 again, so a value could in
 * principle be reissued if a PREVIOUS process had burned ≥1000 nonces within
 * the same millisecond-times-1000 window — i.e. ≥1000 mints in under a second.
 * The poster mints at most once per tick (default 60 s), so this cannot happen
 * in service; a caller that mints in a tight loop should carry its own counter.
 */
export function freshNonce(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(nonceCounter++);
}

/** Test seam: reset the in-process counter. Not used in service. */
export function __resetNonceCounter(): void {
  nonceCounter = 0;
}

// ── minting ──────────────────────────────────────────────────────────────────

/** The Compact `ShieldedCoinInfo` as midnight-js hands it back on `tx.private.result`. */
export interface CompactShieldedCoinInfo {
  color?: Uint8Array | string | null;
  /** Older/looser shapes have called it `type`; `mint-test-tokens.ts` reads both. */
  type?: Uint8Array | string | null;
  nonce?: Uint8Array | string | null;
  value?: bigint | number | string | null;
}

export interface MintShieldedTx {
  private?: { result?: CompactShieldedCoinInfo | null } | null;
  public?: { txHash?: unknown; txId?: unknown } | null;
}

/** The slice of a midnight-js `DeployedContract` this module needs. */
export interface FaucetContract {
  callTx: {
    mint_shielded(
      domainSep: Uint8Array,
      amount: bigint,
      nonce: bigint,
    ): Promise<MintShieldedTx>;
  };
}

export interface MintContext {
  /** The offer-files contract the wallet joined — the colour derives from it. */
  contractAddress: string;
  /**
   * `walletResult.zswapSecretKeys.coinSecretKey`, or better a thunk that reads
   * it. Never logged.
   *
   * LIFETIME — READ THIS BEFORE PASSING A BARE KEY. `.coinSecretKey` mints a NEW
   * wasm-bindgen wrapper on every access, but the secret itself belongs to the
   * owning `ZswapSecretKeys`. When that owner becomes unreachable its finalizer
   * clears the secret, and every handle previously derived from it starts
   * throwing "Coin secret key was cleared" — a captured `coinSecretKey` does NOT
   * keep its owner alive. Measured on ledger-v8 8.1.0 under bun 1.3.11: a module
   * whose only reference to the owner was the initialiser
   * `ZswapSecretKeys.fromSeed(seed).coinSecretKey` failed part-way through a test
   * file, once a GC ran.
   *
   * So prefer the thunk form, which keeps the owner referenced by live code and
   * hands back a fresh handle each time:
   *
   *     coinSecretKey: () => walletResult.zswapSecretKeys.coinSecretKey
   *
   * A bare `CoinSecretKey` is still accepted and is safe as long as the caller
   * independently keeps the owning `ZswapSecretKeys` (in practice the whole
   * `walletResult`) reachable for the life of the process.
   */
  coinSecretKey: CoinSecretKey | (() => CoinSecretKey);
}

export interface MintedCoin {
  /**
   * The ledger coin. `nonce` is the CHAIN nonce (32-byte hex) the contract
   * derived via `evolveNonce(nonce, domain_sep)` — NOT the bigint passed to
   * `mint_shielded`. It is what `availableCoins` is keyed by, so it is the
   * identity the journal and the pinned selector must use.
   */
  coin: ShieldedCoinInfo;
  /** `coinNullifier(coin, coinSecretKey)` — what the offer will spend. */
  nullifier: string;
  /** The mint transaction, for the journal. Empty only if the SDK gave neither field. */
  txHash: string;
  /** The bigint handed to the circuit, kept for the log line. */
  mintNonce: bigint;
  /** The colour that was expected AND observed. */
  colour: string;
}

function coinBytes(value: Uint8Array | string | null | undefined, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return fromHex(value);
  throw new Error(`mint result: ${label} is ${value === null ? "null" : typeof value}, expected bytes or hex`);
}

/**
 * Mint one shielded coin of `name` into the wallet that joined `deployed`, and
 * return it with its nullifier already computed.
 *
 * The nullifier comes from `coinNullifier`, not from the wallet, so the caller
 * knows what the offer must spend BEFORE the wallet has even seen the coin —
 * that is the value the exact-coin assertion compares `computed.inputNullifiers`
 * against.
 */
export async function mintFaucetToken(
  deployed: FaucetContract,
  name: string,
  amount: bigint,
  nonce: bigint,
  ctx: MintContext,
): Promise<MintedCoin> {
  assertShieldedPreset(name);
  if (isColourHex(name)) {
    throw new Error("mintFaucetToken() needs a token NAME (the faucet derives the colour from it), not a colour");
  }
  if (typeof amount !== "bigint" || amount <= 0n) {
    throw new Error(`mint amount must be a positive bigint, got ${String(amount)}`);
  }
  if (typeof nonce !== "bigint" || nonce < 0n) {
    throw new Error(`mint nonce must be a non-negative bigint, got ${String(nonce)}`);
  }

  const contractAddress = normaliseHex32(ctx.contractAddress, "contract address");
  const wanted = expectedColour(name, contractAddress);
  const sep = domainSepFromName(String(name).trim());

  const tx = await deployed.callTx.mint_shielded(sep, amount, nonce);

  const result = tx?.private?.result;
  if (result === undefined || result === null) {
    throw new Error(
      `mint_shielded(${normaliseTokenName(name)}): no private.result on the tx ` +
        `(keys: ${tx ? Object.keys(tx).join(",") : "no tx"})`,
    );
  }

  const rawColour = result.color ?? result.type;
  const coin = decodeShieldedCoinInfo({
    color: coinBytes(rawColour, "color"),
    nonce: coinBytes(result.nonce, "nonce"),
    value: BigInt(result.value ?? 0n),
  });
  const observed = coin.type.toLowerCase();

  // The whole point of the module. A colour that is not the derived one means
  // the contract address, the separator or the SDK moved under us, and every
  // downstream assumption (price map, registry, sponsorship) is void.
  if (observed !== wanted) {
    throw new Error(
      `mint_shielded(${normaliseTokenName(name)}) minted colour ${observed} but ` +
        `rawTokenType(domainSepFromName("${normaliseTokenName(name)}"), ${contractAddress.slice(0, 12)}…) ` +
        `is ${wanted} — this is NOT the token that name means on this deployment`,
    );
  }
  if (coin.value !== amount) {
    throw new Error(
      `mint_shielded(${normaliseTokenName(name)}) minted ${coin.value} but ${amount} was requested`,
    );
  }

  // See MintContext.coinSecretKey: a collected `ZswapSecretKeys` turns this into
  // an opaque "Coin secret key was cleared". The coin is already ON CHAIN at
  // this point, so the message has to say what to do about it.
  let nullifier: string;
  try {
    const key =
      typeof ctx.coinSecretKey === "function"
        ? (ctx.coinSecretKey as () => CoinSecretKey)()
        : ctx.coinSecretKey;
    nullifier = coinNullifier(coin, key);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `coin ${observed.slice(0, 12)}…/${coin.nonce.slice(0, 12)}… was MINTED but its nullifier ` +
        `could not be computed: ${why}. If this says the key was cleared, the ZswapSecretKeys that ` +
        `owns coinSecretKey was garbage-collected — keep walletResult referenced. The coin is on ` +
        `chain; journal the nonce so it is not lost.`,
    );
  }

  // `txHash` is what the plan names; `txId` is what some SDK versions set and
  // what `mint-test-tokens.ts` reads first. Prefer the documented field, accept
  // the other, and never fail a mint that SUCCEEDED just because the receipt
  // field moved — the coin is already on chain by then.
  const txHash = String(tx?.public?.txHash ?? tx?.public?.txId ?? "");

  return { coin, nullifier, txHash, mintNonce: nonce, colour: observed };
}

// ── token-name registry ──────────────────────────────────────────────────────

/** `KernelApi`, or just the base URL to build one from. */
export type RegistryApi = KernelApi | { base: string };

function asKernelApi(api: RegistryApi): KernelApi {
  return typeof (api as KernelApi).post === "function"
    ? (api as KernelApi)
    : new KernelApi((api as { base: string }).base);
}

/** A `known_tokens` row as `GET /v1/known-tokens` (`SELECT *`) returns it. */
export interface KnownTokenRow {
  id?: number;
  token_color: string;
  name: string;
  kind: string;
  decimals?: number | null;
  asset_id?: string | null;
}

export type RegisterReason =
  /** 200/201 — the row was created by this call. */
  | "registered"
  /** The (colour, name) pair the caller wanted is already the registry's. Benign. */
  | "already_registered"
  /** 404 NOT_ENABLED — `ENABLE_TOKEN_REGISTRY` is off. Legs will quote unpriced. */
  | "registry_disabled"
  /** The NAME belongs to a DIFFERENT colour. This leg will quote unpriced. */
  | "name_taken"
  /** The COLOUR is registered under a different name. This leg prices as that name. */
  | "colour_renamed"
  /** The kernel answered something unexpected. */
  | "error";

export interface RegisterTokenNameResult {
  /** True when the registry ends up holding exactly this (colour, name) pair. */
  registered: boolean;
  reason: RegisterReason;
  status: number;
  /** The name the registry holds for this colour, when the kernel told us. */
  existingName?: string;
  /** The colour that holds the name, when a lookup resolved it. */
  existingColour?: string;
  message: string;
}

interface RegisterOptions {
  /** Warning sink; defaults to `console.warn`. Tests pass a collector. */
  warn?: (msg: string) => void;
}

function bodyError(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b["error"], b["reason"], b["message"]].filter((p) => typeof p === "string");
    if (parts.length > 0) return parts.join(": ");
  }
  return JSON.stringify(body);
}

/**
 * Register `colour` under `name` with the kernel.
 *
 * TWO KINDS OF 409, AND THE ORDER MATTERS (packages/node/api.ts:693-701).
 * The route checks the NAME first and the COLOUR second:
 *
 *     if (name exists)   → 409 `Token name "WBTC" is already taken`
 *     if (colour exists) → 409 `Token color already registered as "<name>"`
 *
 * So the ordinary restart path — same colour, same name, already registered —
 * comes back as the NAME 409, never the colour one (the plan's P0 note 5 has
 * this the other way round; corrected here and in the plan). The name 409 alone
 * therefore cannot distinguish "our own row, benign" from "someone else's
 * colour owns this name, our leg will be unpriced", so this function resolves it
 * with one `GET /v1/known-tokens` before answering.
 */
export async function registerTokenName(
  api: RegistryApi,
  colour: string,
  name: string,
  kind: MintableKind = "shielded",
  opts: RegisterOptions = {},
): Promise<RegisterTokenNameResult> {
  const warn = opts.warn ?? ((msg: string) => console.warn(`[faucet-mint] ${msg}`));
  const client = asKernelApi(api);
  const color = normaliseHex32(colour, "token colour");
  const wantedName = normaliseTokenName(name);
  if (wantedName === "") throw new Error("token name is empty");

  // `decimals` is deliberately omitted: the faucet mints BASE units (1 coin ==
  // 1 base unit) and the column defaults to 0. Sending a wrong non-zero value
  // would scale the USD price by 10^decimals and break sponsorship silently.
  const { status, body } = await client.post<unknown>("/v1/known-tokens", {
    color,
    name: wantedName,
    kind,
  });

  if (status === 200 || status === 201) {
    return {
      registered: true,
      reason: "registered",
      status,
      message: `registered ${wantedName} = ${color.slice(0, 12)}…`,
    };
  }

  const err = bodyError(body);

  if (status === 404 && /NOT_ENABLED/i.test(err)) {
    const message =
      `token registry is disabled on this kernel (ENABLE_TOKEN_REGISTRY) — ` +
      `${wantedName} stays unnamed, so the leg quotes as "demo-fallback" and ` +
      `sponsorship depends on BATCHER_SPONSOR_UNPRICED`;
    warn(message);
    return { registered: false, reason: "registry_disabled", status, message };
  }

  if (status === 409) {
    const colourHolder = /already registered as\s+"?([^"]*)"?/i.exec(err)?.[1];
    if (colourHolder !== undefined) {
      const existingName = normaliseTokenName(colourHolder);
      if (existingName === wantedName) {
        return {
          registered: true,
          reason: "already_registered",
          status,
          existingName,
          message: `${wantedName} = ${color.slice(0, 12)}… already registered`,
        };
      }
      const message =
        `colour ${color.slice(0, 12)}… is registered as "${existingName}", not "${wantedName}" — ` +
        `the leg will be priced as ${existingName}`;
      warn(message);
      return { registered: false, reason: "colour_renamed", status, existingName, message };
    }

    if (/already taken/i.test(err)) {
      // The name check fires before the colour check, so this is ALSO what a
      // clean restart of an already-registered pair looks like. One lookup
      // tells the two apart.
      const holder = await findKnownToken(client, { name: wantedName });
      if (holder === "unreachable") {
        const message =
          `name "${wantedName}" is already taken and GET /v1/known-tokens could not ` +
          `say by which colour — assuming NOT ours; the leg may quote unpriced`;
        warn(message);
        return { registered: false, reason: "name_taken", status, message };
      }
      const existingColour = holder === undefined ? undefined : normaliseHex32(holder.token_color, "token colour");
      if (existingColour === color) {
        return {
          registered: true,
          reason: "already_registered",
          status,
          existingName: wantedName,
          existingColour,
          message: `${wantedName} = ${color.slice(0, 12)}… already registered (name pre-check)`,
        };
      }
      const message =
        `name "${wantedName}" is already taken by colour ${
          existingColour === undefined ? "(not found in the registry)" : `${existingColour.slice(0, 12)}…`
        }, not by ours (${color.slice(0, 12)}…) — this deployment's ${wantedName} stays UNNAMED and ` +
        `its leg will quote unpriced. Most likely a database volume that outlived a contract redeploy.`;
      warn(message);
      return { registered: false, reason: "name_taken", status, existingColour, message };
    }
  }

  const message = `POST /v1/known-tokens → ${status}: ${err}`;
  warn(message);
  return { registered: false, reason: "error", status, message };
}

async function fetchKnownTokens(client: KernelApi): Promise<KnownTokenRow[] | "unreachable"> {
  try {
    const { status, body } = await client.get<KnownTokenRow[]>("/v1/known-tokens");
    if (status !== 200 || !Array.isArray(body)) return "unreachable";
    return body;
  } catch {
    return "unreachable";
  }
}

async function findKnownToken(
  client: KernelApi,
  by: { name?: string; colour?: string },
): Promise<KnownTokenRow | undefined | "unreachable"> {
  const rows = await fetchKnownTokens(client);
  if (rows === "unreachable") return "unreachable";
  return rows.find((r) => {
    if (by.name !== undefined && normaliseTokenName(r.name) !== by.name) return false;
    if (by.colour !== undefined && String(r.token_color ?? "").toLowerCase() !== by.colour) return false;
    return true;
  });
}

export type VerifyReason =
  | "ok"
  | "colour_unregistered"
  | "colour_name_mismatch"
  | "name_held_by_other_colour"
  | "registry_unreachable";

export interface VerifyTokenNameResult {
  /** The colour maps to this name AND nothing else holds the name. */
  ok: boolean;
  /**
   * The colour resolves to a reference asset, so `GET /v1/prices` will return a
   * market price for it and the sponsorship gate will not see UNPRICED.
   *
   * Judged from the two paths visible from here — `known_tokens.asset_id` and
   * the default NAME map. `PRICE_FEED_MAP` (an env var on the node) can price a
   * token this reports as unpriced; it cannot un-price one reported priced.
   */
  priced: boolean;
  reason: VerifyReason;
  /** Which path priced it. */
  pricedBy?: "asset_id" | "default_name_map";
  assetId?: string;
  /** The registry row holding the colour, if any. */
  row?: KnownTokenRow;
  /** The registry row holding the NAME, when a different colour holds it. */
  nameHolder?: KnownTokenRow;
  message: string;
}

/**
 * Read the registry back and answer the only two questions that matter to a
 * poster leg: does this colour carry this name (in BOTH directions), and will
 * the kernel be able to put a market price on it?
 *
 * Checking both directions is what catches the case a plain presence check
 * misses: a database volume that outlived a contract redeploy still holds
 * `WBTC = <old colour>`, so the new colour is nameless and unpriced while the
 * name looks perfectly registered.
 */
export async function verifyTokenName(
  api: RegistryApi,
  colour: string,
  name: string,
): Promise<VerifyTokenNameResult> {
  const client = asKernelApi(api);
  const color = normaliseHex32(colour, "token colour");
  const wantedName = normaliseTokenName(name);

  const rows = await fetchKnownTokens(client);
  if (rows === "unreachable") {
    return {
      ok: false,
      priced: false,
      reason: "registry_unreachable",
      message: "GET /v1/known-tokens did not answer with a row array",
    };
  }

  const row = rows.find((r) => String(r.token_color ?? "").toLowerCase() === color);
  const nameHolder = rows.find((r) => normaliseTokenName(r.name) === wantedName);

  if (row === undefined) {
    if (nameHolder !== undefined) {
      return {
        ok: false,
        priced: false,
        reason: "name_held_by_other_colour",
        nameHolder,
        message:
          `colour ${color.slice(0, 12)}… is not registered and "${wantedName}" is held by ` +
          `${String(nameHolder.token_color).slice(0, 12)}… — this leg will quote UNPRICED`,
      };
    }
    return {
      ok: false,
      priced: false,
      reason: "colour_unregistered",
      message: `colour ${color.slice(0, 12)}… is not in the registry — this leg will quote UNPRICED`,
    };
  }

  // Pricing follows the row that actually holds the COLOUR, because that is
  // what the node looks up; the name we wanted is irrelevant to the price.
  const rowName = normaliseTokenName(row.name);
  const assetId = row.asset_id ?? undefined;
  const mapped = DEFAULT_NAME_ASSET_MAP.get(rowName);
  const priced = assetId !== undefined && assetId !== null ? true : mapped !== undefined;
  const pricedBy = assetId ? "asset_id" : mapped ? "default_name_map" : undefined;
  const resolvedAsset = assetId ?? mapped?.assetId;

  if (rowName !== wantedName) {
    return {
      ok: false,
      priced,
      reason: "colour_name_mismatch",
      pricedBy,
      assetId: resolvedAsset,
      row,
      nameHolder,
      message:
        `colour ${color.slice(0, 12)}… is registered as "${rowName}", not "${wantedName}" — ` +
        `it will be priced as ${resolvedAsset ?? "nothing (UNPRICED)"}`,
    };
  }

  return {
    ok: true,
    priced,
    reason: "ok",
    pricedBy,
    assetId: resolvedAsset,
    row,
    message: priced
      ? `${wantedName} = ${color.slice(0, 12)}… → ${resolvedAsset} (${pricedBy})`
      : `${wantedName} = ${color.slice(0, 12)}… is registered but maps to no reference asset — UNPRICED`,
  };
}

export interface RegisterAndVerifyResult {
  register: RegisterTokenNameResult;
  verify: VerifyTokenNameResult;
  /** The registry holds the pair AND the leg will price. What the poster wants. */
  ready: boolean;
}

/** `registerTokenName` then `verifyTokenName` — the sequence FR-002 prescribes. */
export async function registerAndVerifyTokenName(
  api: RegistryApi,
  colour: string,
  name: string,
  kind: MintableKind = "shielded",
  opts: RegisterOptions = {},
): Promise<RegisterAndVerifyResult> {
  const register = await registerTokenName(api, colour, name, kind, opts);
  const verify = await verifyTokenName(api, colour, name);
  return { register, verify, ready: verify.ok && verify.priced };
}
