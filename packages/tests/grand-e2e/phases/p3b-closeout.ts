/** Exact-denomination fixture for T-E2. */
export const PARTIAL_OVERLAP_COINS = [1000n, 1500n, 2000n] as const;
export const PARTIAL_OVERLAP_GIVES = [2500n, 3500n] as const;

/** Enumerate exact subsets so a fixture cannot silently rely on ambiguous coin selection. */
export function exactSubsetIndexes(
  coins: readonly bigint[],
  amount: bigint,
): number[][] {
  const matches: number[][] = [];
  for (let mask = 1; mask < 1 << coins.length; mask++) {
    const indexes: number[] = [];
    let sum = 0n;
    for (let i = 0; i < coins.length; i++) {
      if ((mask & (1 << i)) !== 0) {
        indexes.push(i);
        sum += coins[i]!;
      }
    }
    if (sum === amount) matches.push(indexes);
  }
  return matches;
}

/** The SDK's failed-input callback currently ages out as a receipt timeout.
 * Require the transaction-specific adapter trace as proof that the underlying
 * result was the expected Midnight submission rejection. */
export function hasBatcherChainRejection(log: string, fingerprint: string): boolean {
  return log.split("\n").some((line) =>
    line.includes(`#${fingerprint}`) &&
    /Submit failed.*Transaction submission error/i.test(line)
  );
}
