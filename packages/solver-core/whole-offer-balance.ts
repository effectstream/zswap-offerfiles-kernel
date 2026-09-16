/** Pure token accounting for sets of eligible, indivisible maker offers. */

/** Coin serialization accepts u128, independently of signed delta support. */
export const MAX_COIN_AMOUNT = (1n << 128n) - 1n;

/**
 * Ledger-v8 transaction deltas are i128 and reject i128::MIN. Every exposed
 * source, endpoint, receipt, and safe merge prefix therefore uses this bound.
 */
export const MAX_SETTLEMENT_AMOUNT = (1n << 127n) - 1n;

export const MAX_PHYSICAL_MAKERS_PER_MERGE = 8;

/** n * 2^(n - 1) transitions for n=8; the fast sorted order costs no fallback work. */
export const MAX_SAFE_MERGE_ORDER_WORK =
  MAX_PHYSICAL_MAKERS_PER_MERGE * 2 ** (MAX_PHYSICAL_MAKERS_PER_MERGE - 1);

export interface WholeOfferBalanceLeg {
  token: string;
  amount: bigint;
}

export interface WholeOfferBalanceSource {
  gives: readonly WholeOfferBalanceLeg[];
  wants: readonly WholeOfferBalanceLeg[];
}

export interface WholeOfferMergeSource extends WholeOfferBalanceSource {
  offerHash: string;
}

/** Gross maker terms and their signed net supply for one canonical token. */
export interface WholeOfferTokenBalance {
  token: string;
  gives: bigint;
  wants: bigint;
  net: bigint;
}

/** JSON-safe provenance form. Signed `net` is encoded as a decimal string. */
export interface SerializedWholeOfferTokenBalance {
  token: string;
  gives: string;
  wants: string;
  net: string;
}

export interface WholeOfferPairBalance {
  tokenIn: string;
  tokenOut: string;
  /** Genuine external input required by the maker net vector. */
  input: bigint;
  /** Maximum external output supplied by the maker net vector. */
  output: bigint;
  /** Canonically sorted gross and net rows, including zero-net rows. */
  tokenBalances: WholeOfferTokenBalance[];
}

export type WholeOfferPairFailureReason =
  | "same-token"
  | "input-not-negative"
  | "output-not-positive"
  | "additional-deficit"
  | "settlement-amount-cap";

export type WholeOfferPairEvaluation =
  | { ok: true; pair: WholeOfferPairBalance }
  | { ok: false; reason: WholeOfferPairFailureReason; token?: string };

export interface WholeOfferTrade {
  tokenIn: string;
  tokenOut: string;
  input: bigint;
  output: bigint;
}

export interface WholeOfferReceipt {
  token: string;
  amount: bigint;
}

export type WholeOfferReceiptFailureReason =
  | WholeOfferPairFailureReason
  | "non-positive-input"
  | "non-positive-output"
  | "insufficient-input"
  | "excess-output";

export type WholeOfferReceiptResult =
  | {
      ok: true;
      requiredInput: bigint;
      availableOutput: bigint;
      receipts: WholeOfferReceipt[];
    }
  | { ok: false; reason: WholeOfferReceiptFailureReason; token?: string };

export interface WholeOfferMergeOrderOptions {
  /** Defaults to the supported ledger-v9 signed-delta maximum. */
  maximumDelta?: bigint;
  /** Defaults to the inherited eight-physical-maker settlement limit. */
  maxSources?: number;
  /** Lower-only fallback transition budget; sorted-hash fast-path work is zero. */
  maxWork?: number;
  /** Checked every 256 fallback transitions. */
  shouldAbort?: () => boolean;
}

export type WholeOfferMergeOrderResult =
  | {
      ok: true;
      /** Execution order only; provenance and tie ranking keep sorted hashes. */
      offerHashes: string[];
      usedFallback: boolean;
      work: number;
    }
  | {
      ok: false;
      reason:
        | "too-many-sources"
        | "unsafe-merge-order"
        | "merge-order-work-cap"
        | "aborted"
        | "abort-check-failed";
      work: number;
    };

const TOKEN_ID = /^[0-9a-f]{64}$/i;

const canonicalToken = (token: string): string => {
  if (typeof token !== "string" || !TOKEN_ID.test(token)) {
    throw new TypeError(`invalid token id: ${String(token)}`);
  }
  return token.toLowerCase();
};

const canonicalBalances = (
  balances: Iterable<WholeOfferTokenBalance>,
): WholeOfferTokenBalance[] => {
  const totals = new Map<string, { gives: bigint; wants: bigint }>();
  for (const balance of balances) {
    const token = canonicalToken(balance.token);
    if (
      typeof balance.gives !== "bigint" ||
      typeof balance.wants !== "bigint" ||
      typeof balance.net !== "bigint" ||
      balance.gives < 0n ||
      balance.wants < 0n ||
      balance.net !== balance.gives - balance.wants
    ) {
      throw new TypeError(`invalid token balance for ${token}`);
    }
    const current = totals.get(token) ?? { gives: 0n, wants: 0n };
    current.gives += balance.gives;
    current.wants += balance.wants;
    totals.set(token, current);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([token, total]) => ({
      token,
      gives: total.gives,
      wants: total.wants,
      net: total.gives - total.wants,
    }));
};

/**
 * Account eligible maker terms exactly with unbounded bigint arithmetic.
 *
 * This function intentionally applies no aggregate settlement cap: gross terms
 * remain available for the later SDK/ledger representation check even when
 * endpoint net amounts cancel into a smaller value.
 */
export function accountWholeOfferBalances(
  sources: Iterable<WholeOfferBalanceSource>,
): WholeOfferTokenBalance[] {
  const totals = new Map<string, { gives: bigint; wants: bigint }>();
  const add = (leg: WholeOfferBalanceLeg, side: "gives" | "wants"): void => {
    const token = canonicalToken(leg.token);
    if (typeof leg.amount !== "bigint" || leg.amount <= 0n) {
      throw new TypeError(`invalid ${side} amount for ${token}`);
    }
    const current = totals.get(token) ?? { gives: 0n, wants: 0n };
    current[side] += leg.amount;
    totals.set(token, current);
  };

  for (const source of sources) {
    for (const leg of source.gives) add(leg, "gives");
    for (const leg of source.wants) add(leg, "wants");
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([token, total]) => ({
      token,
      gives: total.gives,
      wants: total.wants,
      net: total.gives - total.wants,
    }));
}

export function serializeWholeOfferTokenBalances(
  balances: Iterable<WholeOfferTokenBalance>,
): SerializedWholeOfferTokenBalance[] {
  return canonicalBalances(balances).map((balance) => ({
    token: balance.token,
    gives: balance.gives.toString(),
    wants: balance.wants.toString(),
    net: balance.net.toString(),
  }));
}

/** Evaluate one external pair against a complete maker net vector. */
export function evaluateWholeOfferPair(
  balances: Iterable<WholeOfferTokenBalance>,
  tokenIn: string,
  tokenOut: string,
): WholeOfferPairEvaluation {
  const inputToken = canonicalToken(tokenIn);
  const outputToken = canonicalToken(tokenOut);
  if (inputToken === outputToken) return { ok: false, reason: "same-token" };

  const rows = canonicalBalances(balances);
  const input = rows.find((balance) => balance.token === inputToken);
  if (input === undefined || input.net >= 0n) {
    return { ok: false, reason: "input-not-negative", token: inputToken };
  }
  const output = rows.find((balance) => balance.token === outputToken);
  if (output === undefined || output.net <= 0n) {
    return { ok: false, reason: "output-not-positive", token: outputToken };
  }
  const deficit = rows.find((balance) =>
    balance.token !== inputToken && balance.net < 0n
  );
  if (deficit !== undefined) {
    return { ok: false, reason: "additional-deficit", token: deficit.token };
  }

  const outsideSettlementDomain = rows.find((balance) =>
    balance.net > MAX_SETTLEMENT_AMOUNT || balance.net < -MAX_SETTLEMENT_AMOUNT
  );
  if (outsideSettlementDomain !== undefined) {
    return {
      ok: false,
      reason: "settlement-amount-cap",
      token: outsideSettlementDomain.token,
    };
  }

  return {
    ok: true,
    pair: {
      tokenIn: inputToken,
      tokenOut: outputToken,
      input: -input.net,
      output: output.net,
      tokenBalances: rows,
    },
  };
}

/** Build every positive solver receipt for one admitted external trade. */
export function buildWholeOfferReceipts(
  balances: Iterable<WholeOfferTokenBalance>,
  trade: Readonly<WholeOfferTrade>,
): WholeOfferReceiptResult {
  if (typeof trade.input !== "bigint" || trade.input <= 0n) {
    return { ok: false, reason: "non-positive-input" };
  }
  if (typeof trade.output !== "bigint" || trade.output <= 0n) {
    return { ok: false, reason: "non-positive-output" };
  }
  if (trade.input > MAX_SETTLEMENT_AMOUNT) {
    return { ok: false, reason: "settlement-amount-cap", token: canonicalToken(trade.tokenIn) };
  }
  if (trade.output > MAX_SETTLEMENT_AMOUNT) {
    return { ok: false, reason: "settlement-amount-cap", token: canonicalToken(trade.tokenOut) };
  }
  const evaluated = evaluateWholeOfferPair(balances, trade.tokenIn, trade.tokenOut);
  if (!evaluated.ok) return evaluated;
  if (trade.input < evaluated.pair.input) {
    return { ok: false, reason: "insufficient-input", token: evaluated.pair.tokenIn };
  }
  if (trade.output > evaluated.pair.output) {
    return { ok: false, reason: "excess-output", token: evaluated.pair.tokenOut };
  }

  const receipts = evaluated.pair.tokenBalances
    .map((balance) => ({
      token: balance.token,
      amount: balance.net +
        (balance.token === evaluated.pair.tokenIn ? trade.input : 0n) -
        (balance.token === evaluated.pair.tokenOut ? trade.output : 0n),
    }))
    .filter((receipt) => receipt.amount > 0n);

  const oversizedReceipt = receipts.find((receipt) => receipt.amount > MAX_SETTLEMENT_AMOUNT);
  if (oversizedReceipt !== undefined) {
    return { ok: false, reason: "settlement-amount-cap", token: oversizedReceipt.token };
  }

  return {
    ok: true,
    requiredInput: evaluated.pair.input,
    availableOutput: evaluated.pair.output,
    receipts,
  };
}

const sourceNetRows = (source: WholeOfferBalanceSource): WholeOfferTokenBalance[] =>
  accountWholeOfferBalances([source]);

const addNetRows = (
  current: ReadonlyMap<string, bigint>,
  rows: readonly WholeOfferTokenBalance[],
  maximumDelta: bigint,
): Map<string, bigint> | null => {
  const next = new Map(current);
  for (const row of rows) {
    const amount = (next.get(row.token) ?? 0n) + row.net;
    if (amount < -maximumDelta || amount > maximumDelta) return null;
    if (amount === 0n) next.delete(row.token);
    else next.set(row.token, amount);
  }
  return next;
};

/**
 * Find a deterministic physical-maker merge order whose every token prefix is
 * representable as a supported ledger-v9 signed delta.
 *
 * The common sorted-hash order is checked first. Extreme books use a memoized
 * subset-mask DFS: aggregate state is unique per mask, so at most n*2^(n-1)
 * transitions are attempted and no factorial permutation search is possible.
 */
export function findSafeWholeOfferMergeOrder(
  sources: readonly WholeOfferMergeSource[],
  options: Readonly<WholeOfferMergeOrderOptions> = {},
): WholeOfferMergeOrderResult {
  const maximumDelta = options.maximumDelta ?? MAX_SETTLEMENT_AMOUNT;
  const maxSources = options.maxSources ?? MAX_PHYSICAL_MAKERS_PER_MERGE;
  const maxWork = options.maxWork ?? MAX_SAFE_MERGE_ORDER_WORK;
  if (
    typeof maximumDelta !== "bigint" ||
    maximumDelta <= 0n ||
    maximumDelta > MAX_SETTLEMENT_AMOUNT
  ) {
    throw new RangeError(`maximumDelta must be a bigint between 1 and ${MAX_SETTLEMENT_AMOUNT}`);
  }
  if (
    !Number.isSafeInteger(maxSources) ||
    maxSources < 1 ||
    maxSources > MAX_PHYSICAL_MAKERS_PER_MERGE
  ) {
    throw new RangeError(`maxSources must be between 1 and ${MAX_PHYSICAL_MAKERS_PER_MERGE}`);
  }
  if (
    !Number.isSafeInteger(maxWork) ||
    maxWork < 0 ||
    maxWork > MAX_SAFE_MERGE_ORDER_WORK
  ) {
    throw new RangeError(`maxWork must be between 0 and ${MAX_SAFE_MERGE_ORDER_WORK}`);
  }
  if (sources.length > maxSources) return { ok: false, reason: "too-many-sources", work: 0 };

  const ordered = [...sources]
    .map((source) => ({
      source,
      offerHash: canonicalToken(source.offerHash),
      rows: sourceNetRows(source),
    }))
    .sort((left, right) => left.offerHash < right.offerHash ? -1 : left.offerHash > right.offerHash ? 1 : 0);
  if (new Set(ordered.map((entry) => entry.offerHash)).size !== ordered.length) {
    throw new TypeError("duplicate offer hash in merge sources");
  }

  let fastBalances = new Map<string, bigint>();
  let fastPathSafe = true;
  for (const entry of ordered) {
    const next = addNetRows(fastBalances, entry.rows, maximumDelta);
    if (next === null) {
      fastPathSafe = false;
      break;
    }
    fastBalances = next;
  }
  if (fastPathSafe) {
    return {
      ok: true,
      offerHashes: ordered.map((entry) => entry.offerHash),
      usedFallback: false,
      work: 0,
    };
  }

  const fullMask = (1 << ordered.length) - 1;
  const failedMasks = new Set<number>();
  const balancesByMask = new Map<number, ReadonlyMap<string, bigint>>([[0, new Map()]]);
  const path: number[] = [];
  let work = 0;
  let exhausted = false;
  let interruptReason: "aborted" | "abort-check-failed" | null = null;

  const search = (mask: number): boolean => {
    if (mask === fullMask) return true;
    if (failedMasks.has(mask)) return false;
    const balances = balancesByMask.get(mask)!;
    for (let index = 0; index < ordered.length; index += 1) {
      const bit = 1 << index;
      if ((mask & bit) !== 0) continue;
      if (work >= maxWork) {
        exhausted = true;
        return false;
      }
      work += 1;
      if ((work & 255) === 0 && options.shouldAbort !== undefined) {
        try {
          if (options.shouldAbort()) {
            exhausted = true;
            interruptReason = "aborted";
            return false;
          }
        } catch {
          exhausted = true;
          interruptReason = "abort-check-failed";
          return false;
        }
      }
      const nextBalances = addNetRows(balances, ordered[index]!.rows, maximumDelta);
      if (nextBalances === null) continue;
      const nextMask = mask | bit;
      balancesByMask.set(nextMask, nextBalances);
      path.push(index);
      if (search(nextMask)) return true;
      path.pop();
      if (exhausted) return false;
    }
    failedMasks.add(mask);
    return false;
  };

  if (search(0)) {
    return {
      ok: true,
      offerHashes: path.map((index) => ordered[index]!.offerHash),
      usedFallback: true,
      work,
    };
  }
  return {
    ok: false,
    reason: interruptReason ?? (exhausted ? "merge-order-work-cap" : "unsafe-merge-order"),
    work,
  };
}
