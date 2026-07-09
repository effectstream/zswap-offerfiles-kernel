/**
 * MIP-0006 — an offer MUST be two-sided.
 *
 * A valid swap offer's net imbalance MUST contain at least one give AND at
 * least one want. Give-only offers are rejected (they are giveaways, not swaps).
 */

import type { TokenLeg } from "./types.ts";

/** Accepts any leg array (tagged TokenLeg or untagged {token,amount}). */
export function isTwoSidedSwap(
  gives: readonly unknown[],
  wants: readonly unknown[],
): boolean {
  return gives.length > 0 && wants.length > 0;
}

export class NotASwapError extends Error {
  constructor(
    public readonly gives: readonly TokenLeg[],
    public readonly wants: readonly TokenLeg[],
  ) {
    super(
      `expected ≥1 give and ≥1 want; got ${gives.length} give(s), ${wants.length} want(s)`,
    );
    this.name = "NotASwapError";
  }
}

/** Throws NotASwapError when the offer is give-only, want-only, or empty. */
export function assertTwoSided(
  gives: readonly TokenLeg[],
  wants: readonly TokenLeg[],
): void {
  if (!isTwoSidedSwap(gives, wants)) {
    throw new NotASwapError(gives, wants);
  }
}
