// Wallet helpers shared by the swap e2e scripts: build a facade for a seed,
// wait for sync, read shielded balances, and move shielded tokens between
// wallets. Built on @effectstream/midnight-contracts (the same SDK the
// template's contracts-midnight scripts use).

import * as Rx from "rxjs";
import { UnshieldedAddress, type MidnightBech32m } from "@midnightntwrk/wallet-sdk-address-format";
import { buildWalletFacade } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import type { WalletResult } from "@effectstream/midnight-contracts/types";

const networkUrls = {
  id: net.id,
  indexer: net.indexer,
  indexerWS: net.indexerWS,
  node: net.node,
  proofServer: net.proofServer,
} as any;

export async function buildWallet(seed: string): Promise<WalletResult> {
  return buildWalletFacade(networkUrls, seed, net.id as any);
}

export function shieldedKeys(w: WalletResult) {
  return { shieldedSecretKeys: w.zswapSecretKeys, dustSecretKey: w.dustSecretKey };
}

const sumBalances = (b: Map<string, bigint> | Record<string, bigint> | undefined): bigint => {
  if (!b) return 0n;
  const vals = b instanceof Map ? Array.from(b.values()) : Object.values(b);
  return vals.reduce<bigint>((acc, v) => acc + ((v as bigint) ?? 0n), 0n);
};

/** Wait until shielded + unshielded (+ dust) subtrees are strictly synced.
 *  When `requireUnshieldedFunds` is set, also wait for NIGHT > 0 (genesis). */
export async function waitForSync(
  w: WalletResult,
  opts: { requireUnshieldedFunds?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const { requireUnshieldedFunds = false, timeoutMs = 180_000 } = opts;
  await Rx.firstValueFrom(
    (w.wallet as any).state().pipe(
      Rx.filter((s: any) => {
        const isSynced = s.isSynced ?? false;
        const shieldedDone = s.shielded?.state?.progress?.isStrictlyComplete?.() ?? isSynced;
        const unshieldedDone = s.unshielded?.progress?.isStrictlyComplete?.() ?? isSynced;
        const dustDone = s.dust?.state?.progress?.isStrictlyComplete?.() ?? isSynced;
        if (!shieldedDone || !unshieldedDone || !dustDone) return false;
        return requireUnshieldedFunds ? sumBalances(s.unshielded?.balances) > 0n : true;
      }),
      Rx.timeout({
        each: timeoutMs,
        with: () => Rx.throwError(() => new Error(`waitForSync timeout after ${timeoutMs}ms`)),
      }),
    ),
  );
}

/**
 * Wait until a facade is fully SETTLED — not merely synced. `isSynced` /
 * strict-complete progress only proves catch-up to the previously observed
 * tip, NOT that the wallet has replayed its own just-finalized transaction
 * (proven by the 00016 ledger-v9 migration's lifecycle diagnostic). Reusing a
 * facade for a second prove+submit while its DUST state is stale is exactly
 * what node rc.4 rejects with `1010: Invalid Transaction: Custom error: 170`
 * (= MalformedError::InvalidDustSpendProof). Gate on: zero pending
 * transactions, zero pending coins on all three subtrees, strict-complete
 * progress. Port of the settlement gate that took the effectstream e2e from
 * a timing-sensitive 170 to a deterministic pass.
 */
export async function waitForWalletSettlement(
  w: WalletResult,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 180_000, label = "wallet-settlement" } = opts;
  const progress = (part: any) => part?.progress ?? part?.state?.progress;
  const strictlyComplete = (part: any) => progress(part)?.isStrictlyComplete?.() === true;
  const pendingCoins = (part: any) =>
    (part?.pendingCoins ?? part?.state?.pendingCoins)?.length ?? 0;
  // DELIBERATELY NOT the full-quiescence gate the effectstream e2e uses
  // (pending.all == 0 && every subtree's pendingCoins == 0): in THIS repo the
  // wallet finalizes offer transactions that are never submitted on-chain —
  // they are published to Celestia and only land when a taker settles — so
  // pending.all and the shielded pendingCoins stay non-zero BY DESIGN and a
  // full-quiescence gate deadlocks (measured: 180s timeout on the first run).
  // Error 170 is InvalidDustSpendProof, a DUST-state disagreement — so the
  // gate is DUST-subtree quiescence (the fee-paying state the next
  // balance+prove will declare) plus strict-complete progress everywhere.
  let last: any = null;
  try {
    await Rx.firstValueFrom(
      (w.wallet as any).state().pipe(
        Rx.tap((s: any) => { last = s; }),
        Rx.filter((s: any) =>
          strictlyComplete(s.shielded) &&
          strictlyComplete(s.unshielded) &&
          strictlyComplete(s.dust) &&
          pendingCoins(s.dust) === 0,
        ),
        Rx.timeout({
          each: timeoutMs,
          with: () =>
            Rx.throwError(() => new Error(`${label}: settlement timeout after ${timeoutMs}ms`)),
        }),
      ),
    );
  } catch (e) {
    // Dump what the gate saw so a timeout is diagnosable from the log alone.
    console.error(`[${label}] last state: ` + JSON.stringify({
      pendingAll: last?.pending?.all?.length ?? null,
      shielded: { strict: strictlyComplete(last?.shielded), pendingCoins: pendingCoins(last?.shielded) },
      unshielded: { strict: strictlyComplete(last?.unshielded), pendingCoins: pendingCoins(last?.unshielded) },
      dust: { strict: strictlyComplete(last?.dust), pendingCoins: pendingCoins(last?.dust) },
    }));
    throw e;
  }
}

/** Read the current shielded balances (color → amount). */
export async function shieldedBalances(w: WalletResult): Promise<Record<string, bigint>> {
  const st = await w.wallet.shielded.waitForSyncedState();
  return (st.balances ?? {}) as Record<string, bigint>;
}

/** Poll the wallet's shielded balance for `color` until it reaches `min`. */
export async function waitForShielded(
  w: WalletResult,
  color: string,
  min: bigint,
  tries = 36,
  ms = 5000,
): Promise<bigint> {
  for (let i = 0; i < tries; i++) {
    const bal = (await shieldedBalances(w))[color] ?? 0n;
    if (bal >= min) return bal;
    await new Promise((r) => setTimeout(r, ms));
  }
  return (await shieldedBalances(w))[color] ?? 0n;
}

/** The wallet's UnshieldedAddress object (for unshielded swap-output recipients).
 *
 * The bech32m cast is a duplicate-install artifact, not a conversion: the same
 * library is present under two npm scopes — this workspace pins
 * `@midnight-ntwrk/wallet-sdk-address-format@3.1.0` while
 * `@effectstream/midnight-contracts` (which produces the keystore) depends on
 * `@midnightntwrk/wallet-sdk-address-format@3.1.2`. The two `MidnightBech32m`
 * classes are structurally identical bech32m wrappers whose branded `network`
 * field makes them nominally distinct to the compiler. Importing the codec from
 * the facade's copy instead would swap the codec implementation at runtime,
 * which is a behaviour change; the cast keeps runtime semantics exactly as they
 * have always been. */
export function unshieldedAddressObj(w: WalletResult): unknown {
  return UnshieldedAddress.codec.decode(
    net.id as any,
    w.unshieldedKeystore.getBech32Address() as unknown as MidnightBech32m,
  );
}

/** Read current unshielded balances (color → amount). */
export async function unshieldedBalances(w: WalletResult): Promise<Record<string, bigint>> {
  const st: any = await (w.wallet as any).unshielded?.waitForSyncedState?.().catch(() => null);
  return (st?.balances ?? {}) as Record<string, bigint>;
}

/** Poll the wallet's unshielded balance for `color` until it reaches `min`. */
export async function waitForUnshielded(
  w: WalletResult,
  color: string,
  min: bigint,
  tries = 36,
  ms = 5000,
): Promise<bigint> {
  for (let i = 0; i < tries; i++) {
    const bal = (await unshieldedBalances(w))[color] ?? 0n;
    if (bal >= min) return bal;
    await new Promise((r) => setTimeout(r, ms));
  }
  return (await unshieldedBalances(w))[color] ?? 0n;
}

/** Send `amount` of a shielded `color` from `from` to a shielded address. */
export async function transferShielded(
  from: WalletResult,
  color: string,
  amount: bigint,
  toShieldedAddress: unknown,
  ttlMs = 30 * 60_000,
): Promise<void> {
  const recipe = await from.wallet.transferTransaction(
    [{ type: "shielded", outputs: [{ type: color, amount, receiverAddress: toShieldedAddress as any }] }],
    shieldedKeys(from),
    { ttl: new Date(Date.now() + ttlMs), payFees: true },
  );
  const finalized = await from.wallet.finalizeRecipe(recipe);
  await from.wallet.submitTransaction(finalized);
  // Never leave the facade with stale DUST state: a caller that immediately
  // sends again (serial transfers are common in these tests) would hit rc.4
  // error 170 (InvalidDustSpendProof). See waitForWalletSettlement.
  await waitForWalletSettlement(from, { label: "post-transfer" });
}
