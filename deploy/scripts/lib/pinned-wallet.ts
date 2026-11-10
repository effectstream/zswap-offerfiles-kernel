// A wallet facade whose shielded coin selection can be PINNED to one exact coin.
//
// Why this file exists
// --------------------
// The offer poster must build a ZSwap offer whose ONLY input is the coin it just
// minted (or the exact coin an expired offer released). The public wallet API
// cannot express that: `initSwap` takes `{colour: amount}` and nothing else, and
// the SDK's default selector is smallest-first
// (`chooseCoin` — @midnightntwrk/wallet-sdk-capabilities/balancer/Balancer.js),
// so with several free WBTC coins in the wallet it would pick the wrong one.
//
// The ONLY injection point in the installed SDK is the shielded wallet's
// variant builders. wallet-sdk-shielded 4.x's `ShieldedWallet(config)` is a
// forking wallet: a V1 (ledger 8) variant below `config.forks.v9` and a V2
// (ledger 9) variant from it, the V2 one carrying the cross-ledger migration.
// This module builds the same forking wallet with one change on each builder:
//
//     .withCoinSelection(() => selector)
//
// `@effectstream/midnight-contracts@0.300.3`'s `buildWalletFacade`
// (`src/get-wallet-info.ts`) builds its shielded wallet through a
// module-private `buildShieldedWallet` = `ShieldedWallet(config).startWithSeed(seed)`
// and exposes no hook, so this module reproduces `buildWalletFacade` verbatim
// with that one step swapped. Everything else — HD role derivation, the dust
// wallet's batching and cost parameters, the unshielded keystore, the facade
// wiring, the seed-based `start`, the dust-only option, the returned
// `WalletResult` — is a faithful copy of the upstream function at
// `@effectstream/midnight-contracts@0.300.3` (wallet-sdk 2.0.0: `createKeystore`
// takes a tagged secret, the facade's sub-wallet factories receive their
// configuration, the facade starts from the three role seeds, and the DUST
// address is derived from the DUST public key). If that package is upgraded,
// re-diff `deriveSeedForRole`, `createWalletConfiguration`,
// `buildShieldedWallet`, `resolveDustBatchUpdates`, `buildDustWallet`,
// `buildUnshieldedWallet` and `buildWalletFacade` in `src/get-wallet-info.ts`,
// and `ShieldedWallet` in wallet-sdk-shielded's `dist/ShieldedWallet.js`,
// against this file.
//
// Selector contract (the safety property the whole service rests on)
// ------------------------------------------------------------------
//   * armed AND the requested `tokenType` is the armed type
//         -> the coin whose nonce is the armed nonce, or `undefined`.
//            NEVER a different coin. `undefined` makes the SDK throw
//            `InsufficientFundsError`, which fails the tick loudly. That is the
//            correct outcome: a silently substituted coin would produce an offer
//            that spends someone else's coin and breaks the exact-coin guarantee.
//   * anything else (not armed, or a different colour — including the fee/NIGHT
//     token type `''` the balancer uses)
//         -> the SDK's own `chooseCoin`, unchanged.
//
// `createPinnedSelector` is pure and takes the armed state as a getter, so the
// contract above is unit-testable without a wallet, an indexer or a node.
//
// One facade per seed, ever (SDK rule), so the armed state is a module-level
// singleton: `pin` / `unpin` / `isPinned` drive the same cell that the exported
// `pinnedSelector` reads. `buildPinnedWallet` wires that singleton into the
// wallet it builds and also returns the three controls on the result for
// convenience — they are the same functions, not a per-wallet copy.

import { Buffer } from "node:buffer";

import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from "@midnightntwrk/ledger-v9";
import type { QualifiedShieldedCoinInfo } from "@midnightntwrk/ledger-v9";
import {
  InMemoryTransactionHistoryStorage,
  type NetworkId,
  TransactionHistoryStorage,
} from "@midnightntwrk/wallet-sdk-abstractions";
import { DustAddress } from "@midnightntwrk/wallet-sdk-address-format";
import { type CoinSelection, chooseCoin } from "@midnightntwrk/wallet-sdk-capabilities";
import { makeIndexerChainVersionProbe } from "@midnightntwrk/wallet-sdk-capabilities/chainVersion";
import { DustWallet } from "@midnightntwrk/wallet-sdk-dust-wallet";
import { type DefaultConfiguration, WalletFacade } from "@midnightntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnightntwrk/wallet-sdk-hd";
import { CustomForkingShieldedWallet } from "@midnightntwrk/wallet-sdk-shielded";
import { V1Builder } from "@midnightntwrk/wallet-sdk-shielded/v1";
import { Migration, V2Builder } from "@midnightntwrk/wallet-sdk-shielded/v2";
import {
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from "@midnightntwrk/wallet-sdk-unshielded-wallet";

// CONSTANTS lives behind the package root export ("." -> src/mod.ts); the
// subpath map has no "./constants" entry. The dust fee overhead / blocks margin
// MUST stay identical to `buildWalletFacade`'s, so import them rather than
// copying two magic numbers that could drift silently. P3 imports this barrel
// anyway (registerNightForDust, waitForDustFunds, configureMidnightNodeProviders).
import { CONSTANTS } from "@effectstream/midnight-contracts";
// `suspendAuxWalletSyncForFees` is the same module instance the barrel
// re-exports; the subpath keeps the intent obvious.
import {
  suspendAuxWalletSyncForFees,
  type WalletSyncMode,
} from "@effectstream/midnight-contracts/wallet-info";
import type { WalletResult } from "@effectstream/midnight-contracts/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The coin the selector is currently pinned to. Both fields are normalised
 *  lowercase hex without an `0x` prefix — the form the ledger returns. */
export interface PinnedCoinRef {
  readonly tokenType: string;
  readonly nonce: string;
}

/** Coin selection over the shielded wallet's spendable coins. This is exactly
 *  `CoinSelection<QualifiedShieldedCoinInfo>` — the type `V1Builder.withCoinSelection`
 *  expects — named locally so callers need not import the SDK type. */
export type ShieldedCoinSelection = CoinSelection<QualifiedShieldedCoinInfo>;

/** The endpoints `buildPinnedWallet` needs. Structurally the `NetworkUrls` that
 *  `packages/kernel-client/wallet.ts` already assembles from `midnightNetworkConfig`
 *  (which is why `id` is optional and unused here — it is carried for parity). */
export interface PinnedNetworkUrls {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly id?: string;
}

/** `WalletResult` (the shape `buildWalletFacade` returns, re-exported unchanged)
 *  plus the pin controls. The controls are the module-level singletons. */
export interface PinnedWalletResult extends WalletResult {
  /** Arm the selector. Throws if already armed (see `pin`). */
  pin(tokenType: string, nonce: string): void;
  /** Disarm. Idempotent. */
  unpin(): void;
  /** Currently armed? */
  isPinned(): boolean;
  /** Armed ref, or `null`. */
  pinnedCoin(): PinnedCoinRef | null;
  /** `pin` -> run -> `unpin` in a `finally`, so a throw can never leave the
   *  wallet armed for the next tick. */
  withPinnedCoin<T>(tokenType: string, nonce: string, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Hex normalisation
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

/** Lowercase, `0x`-stripped. Applied to BOTH sides of every comparison so an
 *  unexpectedly-cased value can never silently fail to match (which would look
 *  like "coin not found" rather than a formatting bug). */
function normHex(value: string): string {
  const s = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return s.toLowerCase();
}

/** Colours (`RawTokenType`) and nonces (`Nonce`) are both 32-byte hex strings
 *  per `@midnightntwrk/ledger-v9`'s own type docs, and `maker-offer.ts` already
 *  validates colours with the same expression. Rejecting a malformed value at
 *  `pin()` turns a mystery `InsufficientFundsError` deep inside the balancer
 *  into an error naming the offending string. */
function requireHex64(label: string, value: string): string {
  const normalised = normHex(value);
  if (!HEX64.test(normalised)) {
    throw new Error(
      `pinned-wallet: ${label} must be 64 lowercase hex chars (32 bytes), got ${JSON.stringify(value)}`,
    );
  }
  return normalised;
}

// ---------------------------------------------------------------------------
// The selector (pure — no wallet, no network)
// ---------------------------------------------------------------------------

/**
 * Build a coin selector that honours an armed coin.
 *
 * @param getArmed  reads the current armed ref (`null` when disarmed). A getter,
 *                  not a value, so one selector instance can be handed to the
 *                  SDK once at wallet-build time and still see later `pin` calls.
 * @param fallback  used whenever the armed ref does not apply. Defaults to the
 *                  SDK's own `chooseCoin`, imported from
 *                  `@midnightntwrk/wallet-sdk-capabilities` — NOT reimplemented,
 *                  so unarmed behaviour is the SDK default by construction.
 */
export function createPinnedSelector(
  getArmed: () => PinnedCoinRef | null,
  fallback: ShieldedCoinSelection = chooseCoin,
): ShieldedCoinSelection {
  return (coins, tokenType, amountNeeded, costModel) => {
    const armed = getArmed();
    if (armed !== null && armed.tokenType === normHex(tokenType)) {
      // Match on nonce AND type. If the armed nonce ever named a coin of a
      // different colour, returning it here would spend the wrong coin.
      return coins.find(
        (coin) => normHex(coin.nonce) === armed.nonce && normHex(coin.type) === armed.tokenType,
      );
    }
    return fallback(coins, tokenType, amountNeeded, costModel);
  };
}

// ---------------------------------------------------------------------------
// Module-level armed state (one facade per seed, so one cell)
// ---------------------------------------------------------------------------

let armedCoin: PinnedCoinRef | null = null;

/**
 * Arm the selector for one build.
 *
 * Throws when already armed: a nested `pin` means a caller forgot its `unpin`,
 * and silently overwriting the ref would make the outer build spend the inner
 * build's coin. Use `withPinnedCoin` to make the unpin structural.
 */
export function pin(tokenType: string, nonce: string): void {
  if (armedCoin !== null) {
    throw new Error(
      `pinned-wallet: already pinned to nonce ${armedCoin.nonce} (type ${armedCoin.tokenType}); ` +
        `unpin() before pinning ${normHex(nonce)}`,
    );
  }
  armedCoin = {
    tokenType: requireHex64("tokenType", tokenType),
    nonce: requireHex64("nonce", nonce),
  };
}

/** Disarm. Safe to call when not armed, so it is safe in a `finally`. */
export function unpin(): void {
  armedCoin = null;
}

/** Is the selector currently armed? */
export function isPinned(): boolean {
  return armedCoin !== null;
}

/** The armed ref, or `null`. */
export function pinnedCoin(): PinnedCoinRef | null {
  return armedCoin;
}

/** `pin` -> run -> `unpin`, with the unpin in a `finally`. */
export async function withPinnedCoin<T>(
  tokenType: string,
  nonce: string,
  fn: () => Promise<T>,
): Promise<T> {
  pin(tokenType, nonce);
  try {
    return await fn();
  } finally {
    unpin();
  }
}

/** The selector handed to the shielded wallet, bound to the module singleton. */
export const pinnedSelector: ShieldedCoinSelection = createPinnedSelector(() => armedCoin);

// ---------------------------------------------------------------------------
// Facade construction — a copy of `buildWalletFacade` with one line changed
// ---------------------------------------------------------------------------

/** Upstream `deriveSeedForRole`. Not exported, so reproduced here. */
function deriveSeedForRole(seed: string, role: (typeof Roles)[keyof typeof Roles]): Uint8Array {
  const seedBuffer = Buffer.from(seed, "hex");
  const hdWalletResult = HDWallet.fromSeed(seedBuffer);
  if (hdWalletResult.type !== "seedOk") {
    throw new Error(`Failed to create HD wallet: ${hdWalletResult.type}`);
  }
  const derivationResult = hdWalletResult.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error(`Key derivation out of bounds for role: ${role}`);
  }
  const derivedKey = Buffer.from(derivationResult.key);
  // Upstream clears the HD wallet's key material once the role key is copied out.
  hdWalletResult.hdWallet.clear();
  return derivedKey;
}

/** Upstream `createWalletConfiguration`. */
function createWalletConfiguration(
  networkUrls: PinnedNetworkUrls,
  networkId: NetworkId.NetworkId,
): DefaultConfiguration {
  return {
    indexerClientConnection: {
      indexerHttpUrl: networkUrls.indexer,
      indexerWsUrl: networkUrls.indexerWS,
    },
    provingServerUrl: new URL(networkUrls.proofServer),
    relayURL: new URL(networkUrls.node.replace("http", "ws")),
    networkId,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(
      TransactionHistoryStorage.TransactionHistoryEntryCommonSchema,
    ),
    costParameters: {
      additionalFeeOverhead: CONSTANTS.DUST_FEE_OVERHEAD,
      feeBlocksMargin: CONSTANTS.DUST_FEE_BLOCKS_MARGIN,
    },
    // deno-lint-ignore no-explicit-any -- upstream casts identically; the
    // DefaultConfiguration intersection is wider than what the wallets read.
  } as unknown as DefaultConfiguration;
}

/**
 * THE ONE CHANGED STEP.
 *
 * Upstream `buildShieldedWallet` is `ShieldedWallet(config).startWithSeed(seed)`.
 * In wallet-sdk-shielded 4.x `ShieldedWallet(config)` is
 *
 *     CustomForkingShieldedWallet(
 *       { ...config, chainVersionProbe: config.chainVersionProbe ?? makeIndexerChainVersionProbe(config) },
 *       { builder: new V1Builder().withDefaults(), configuration: config },
 *       { builder: new V2Builder().withDefaults().withMigration(() => Migration.makeCrossLedgerMigration()),
 *         configuration: config },
 *     )
 *
 * Both builders' `withDefaults()` end in `.withCoinSelectionDefaults()` =
 * `.withCoinSelection(() => chooseCoin)`, so appending our own
 * `withCoinSelection` overwrites exactly that one entry of each build state and
 * leaves sync / serialization / transacting / balances / history / keys /
 * migration alone. The selector goes on BOTH variants so the exact-coin
 * guarantee does not depend on which side of the ledger-9 fork the wallet
 * starts on; on a ledger-9 chain the probe starts it on V2.
 */
function buildPinnedShieldedWallet(
  config: DefaultConfiguration,
  seed: Uint8Array,
  selector: ShieldedCoinSelection,
) {
  // deno-lint-ignore no-explicit-any -- upstream casts the configuration identically.
  const configuration = config as any;
  const withProbe = {
    ...configuration,
    chainVersionProbe:
      configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration),
  };
  // The V1 variant's coin type is ledger-8's `QualifiedShieldedCoinInfo`; the
  // selector reads only `type` and `nonce`, which both ledgers expose as hex.
  // deno-lint-ignore no-explicit-any
  const v1Selector = selector as any;
  return CustomForkingShieldedWallet(
    withProbe,
    {
      builder: new V1Builder().withDefaults().withCoinSelection(() => v1Selector),
      configuration,
    },
    {
      builder: new V2Builder()
        .withDefaults()
        .withMigration(() => Migration.makeCrossLedgerMigration())
        .withCoinSelection(() => selector),
      configuration,
    },
    // deno-lint-ignore no-explicit-any
  ).startWithSeed(seed) as any;
}

/** Upstream `resolveDustBatchUpdates`: the dust wallet's sync batching, tuned for a
 *  headless backend. Upstream reads these through `@effectstream/utils`'
 *  `getEnv`; `@effectstream/utils` is not a root dependency, so read
 *  `process.env` directly (identical under bun) and keep the variable names. */
function resolveDustBatchUpdates(): { size: number; timeout: number; spacing: number } {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    size: num("MIDNIGHT_DUST_SYNC_BATCH_SIZE", 100),
    timeout: num("MIDNIGHT_DUST_SYNC_BATCH_TIMEOUT_MS", 1),
    spacing: num("MIDNIGHT_DUST_SYNC_BATCH_SPACING_MS", 1),
  };
}

/** Upstream `buildDustWallet`. */
function buildDustWallet(
  config: DefaultConfiguration,
  seed: Uint8Array,
  serializedState?: string | null,
) {
  const dustConfig = {
    ...config,
    batchUpdates: resolveDustBatchUpdates(),
    costParameters: {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: CONSTANTS.DUST_FEE_OVERHEAD,
      feeBlocksMargin: CONSTANTS.DUST_FEE_BLOCKS_MARGIN,
    },
  };
  if (serializedState) {
    console.info("Restoring dust wallet from cached state");
    // deno-lint-ignore no-explicit-any
    return DustWallet(dustConfig as any).restore(serializedState);
  }
  const dustParameters = LedgerParameters.initialParameters().dust;
  // deno-lint-ignore no-explicit-any
  return DustWallet(dustConfig as any).startWithSeed(seed, dustParameters);
}

/** Upstream `buildUnshieldedWallet`. */
function buildUnshieldedWallet(config: DefaultConfiguration, keystore: UnshieldedKeystore) {
  return UnshieldedWallet({
    ...config,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(
      TransactionHistoryStorage.TransactionHistoryEntryCommonSchema,
    ),
    // deno-lint-ignore no-explicit-any
  } as any).startWithPublicKey(PublicKey.fromKeyStore(keystore));
}

/**
 * Build a wallet facade whose shielded coin selection honours `pin()`.
 *
 * Returns the same `WalletResult` `buildWalletFacade` returns — `wallet`,
 * `zswapSecretKeys`, `walletZswapSecretKeys`, `dustSecretKey`,
 * `walletDustSecretKey`, `dustAddress`, `unshieldedAddress`,
 * `unshieldedKeystore` — plus the pin controls.
 *
 * NOTE the argument order differs from `buildWalletFacade(networkUrls, seed, …)`:
 * this one takes the SEED FIRST. The types differ (string vs object) so a swap
 * is a compile error, but do not pattern-match the upstream call site blindly.
 *
 * Side effect inherited from the upstream module: importing
 * `@effectstream/midnight-contracts` installs a `process.on('unhandledRejection')`
 * handler under bun (top of `src/get-wallet-info.ts`) that swallows graphql-ws close
 * rejections and `process.exit(1)`s on anything else.
 */
export async function buildPinnedWallet(
  seed: string,
  networkUrls: PinnedNetworkUrls,
  networkId: NetworkId.NetworkId,
  syncMode: WalletSyncMode = "all",
  dustSerializedState?: string | null,
  options?: { stopAuxWalletsImmediately?: boolean },
): Promise<PinnedWalletResult> {
  const shieldedSeed = deriveSeedForRole(seed, Roles.Zswap);
  const dustSeed = deriveSeedForRole(seed, Roles.Dust);
  const unshieldedSeed = deriveSeedForRole(seed, Roles.NightExternal);

  const config = createWalletConfiguration(networkUrls, networkId);

  // wallet-sdk-unshielded-wallet 4.x takes a TAGGED secret (`schnorr` is the
  // only kind the v2 SDK signs with); a bare seed is a type error now.
  const unshieldedKeystore = createKeystore(
    { kind: "schnorr", secret: unshieldedSeed },
    networkId,
  );

  const zswapSecretKeys = ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = DustSecretKey.fromSeed(dustSeed);

  // wallet-sdk-facade 5.x hands each sub-wallet factory the facade's own
  // configuration (including the fork schedule the forking shielded wallet
  // reads), so the wallets are built inside the factories, not ahead of `init`.
  const wallet: WalletFacade = await WalletFacade.init({
    configuration: config,
    shielded: (walletConfig) =>
      buildPinnedShieldedWallet(walletConfig, shieldedSeed, pinnedSelector),
    unshielded: (walletConfig) =>
      buildUnshieldedWallet(walletConfig, unshieldedKeystore),
    dust: (walletConfig) =>
      buildDustWallet(walletConfig, dustSeed, dustSerializedState),
  });

  // wallet-sdk 2.0.0 starts every wallet from its role seed: each ledger
  // version derives its own keys from the seed, so the same identity holds on
  // both sides of the ledger-9 fork. Key objects of one ledger version are
  // rejected (the facade wants both versions' keys or the seeds).
  await wallet.start({
    shielded: shieldedSeed,
    unshielded: unshieldedSeed,
    dust: dustSeed,
  });

  const stopAuxNow =
    syncMode === "dust-only" && (options?.stopAuxWalletsImmediately ?? true);
  if (stopAuxNow) {
    // Kept for parity with `buildWalletFacade`. The poster never uses it: it
    // stops the shielded wallet, and a stopped shielded wallet cannot select,
    // pinned or otherwise.
    await suspendAuxWalletSyncForFees(wallet);
  }

  const unshieldedAddress = unshieldedKeystore.getBech32Address().asString();
  // As upstream: on ledger 9 the DUST address is a pure function of the DUST
  // public key, so nothing waits on the dust wallet's first state emission.
  const dustAddress = DustAddress.encodePublicKey(networkId, dustSecretKey.publicKey);

  return {
    wallet,
    zswapSecretKeys,
    walletZswapSecretKeys: zswapSecretKeys,
    dustSecretKey,
    walletDustSecretKey: dustSecretKey,
    dustAddress,
    unshieldedAddress,
    unshieldedKeystore,
    pin,
    unpin,
    isPinned,
    pinnedCoin,
    withPinnedCoin,
    // The upstream `WalletResult` is typed against the copy of the SDK types
    // that `@effectstream/midnight-contracts` resolves; this file resolves the
    // same versions from the root `package.json`, but TS still treats the two
    // `WalletFacade` / `ZswapSecretKeys` declarations as nominally distinct
    // when the barrel and the direct dependency disagree on the file path.
    // deno-lint-ignore no-explicit-any
  } as unknown as PinnedWalletResult;
}
