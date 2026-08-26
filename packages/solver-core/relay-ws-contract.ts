// Frozen v1 wire contract for the Midnight Intents relay's RFQ WebSocket.
//
// The COW solver is a WS CLIENT of that relay (spec R2, FR-012). The relay is
// consumed as-is and is never modified, so this module is a faithful port of
// the acceptance predicates in the PINNED relay revision — not a design of our
// own. Every predicate below mirrors one in
// `midnight-intents-swaps` @ d444c8379415093460d83a6ba27536af396f759d:
//
//   packages/relay/src/relay-ws.ts        isAmountString, isHexBytes,
//                                         isPriceLevels, onMessage,
//                                         sendSwap, interpolateQuote,
//                                         sendTxSubmitted, sendSubmitFailed
//   packages/solver/src/solver-service-main.ts
//                                         solver-capabilities / price-levels /
//                                         swap-tx / job-error producers and the
//                                         swap / tx-submitted / submit-failed
//                                         consumer
//
// Deliberately relay-FAITHFUL, not stricter. Two consequences matter and are
// load-bearing for later phases:
//
//   1. The relay does NOT validate that a price-levels pair's token ids are
//      64-hex, nor that the ladder is non-empty. Anything it accepts, we must
//      be able to represent.
//   2. A frame the relay REJECTS is discarded SILENTLY and the solver's
//      previous ladder stays in force at the relay — a malformed push freezes
//      the solver stale instead of withdrawing it. The push loop therefore has
//      to validate frames locally with exactly these predicates before sending.
//
// The canonical JSON bodies live in `fixtures/relay-ws/v1/`, byte-pinned by
// `relay-ws-contract.test.ts` and by that directory's `MANIFEST.sha256`.

export const RELAY_WS_CONTRACT_REVISION = "d444c8379415093460d83a6ba27536af396f759d" as const;

/** Message types the COW must speak, in both directions. */
export type SolverToRelayType = "solver-capabilities" | "price-levels" | "swap-tx" | "job-error";
export type RelayToSolverType = "swap" | "tx-submitted" | "submit-failed";

export interface PriceLevel {
  /** Cumulative input accepted, decimal integer string. */
  input: string;
  /** Cumulative output paid for that input, decimal integer string. */
  output: string;
}

export interface PriceLevelsPair {
  tokenIn: string;
  tokenOut: string;
  levels: PriceLevel[];
}

export interface SolverCapabilitiesMessage {
  type: "solver-capabilities";
  tokenIds: string[];
  maxParallelSwaps?: number;
}

export interface PriceLevelsMessage {
  type: "price-levels";
  levels: PriceLevelsPair[];
}

export interface SwapTxMessage {
  type: "swap-tx";
  jobId: string;
  /** Hex-encoded proved inverse-half FinalizedTransaction bytes. */
  txBytes: string;
}

export interface JobErrorMessage {
  type: "job-error";
  jobId: string;
  reason: string;
}

export interface SwapMessage {
  type: "swap";
  jobId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
}

export interface TxSubmittedMessage {
  type: "tx-submitted";
  jobId: string;
  txId: string;
}

export interface SubmitFailedMessage {
  type: "submit-failed";
  jobId: string;
  reason: string;
}

export type SolverToRelayMessage =
  | SolverCapabilitiesMessage
  | PriceLevelsMessage
  | SwapTxMessage
  | JobErrorMessage;

export type RelayToSolverMessage = SwapMessage | TxSubmittedMessage | SubmitFailedMessage;

/** Decimal, non-negative integer string — relay-ws.ts `isAmountString`. */
export function isAmountString(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

/** Even-length hex byte string — relay-ws.ts `isHexBytes`. Note the relay
 *  accepts the empty string, and accepts mixed case. */
export function isHexBytes(value: unknown): value is string {
  return typeof value === "string" && /^([0-9a-fA-F]{2})*$/.test(value);
}

/** Token id grammar the relay applies to `solver-capabilities.tokenIds` only
 *  (`/^[0-9a-f]{64}$/i` in relay-ws.ts `onMessage`). It lowercases on accept. */
export function isCapabilityTokenId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** relay-ws.ts `isPriceLevels`. Token ids are only required to be strings; the
 *  rungs must be decimal integer strings and STRICTLY ascending in `input`. */
export function isPriceLevelsPair(value: unknown): value is PriceLevelsPair {
  const pair = asRecord(value);
  if (!pair) return false;
  if (typeof pair.tokenIn !== "string" || typeof pair.tokenOut !== "string") return false;
  if (!Array.isArray(pair.levels)) return false;
  return pair.levels.every((rung, index) => {
    const level = asRecord(rung);
    if (!level) return false;
    if (!isAmountString(level.input) || !isAmountString(level.output)) return false;
    if (index > 0) {
      const previous = (pair.levels as PriceLevel[])[index - 1];
      if (BigInt(previous.input) >= BigInt(level.input)) return false;
    }
    return true;
  });
}

/**
 * Parse a `solver-capabilities` frame exactly as the relay admits it.
 *
 * The relay keeps the tokens only when EVERY entry matches the 64-hex grammar,
 * and applies `maxParallelSwaps` only when it is a positive integer — a bad
 * `maxParallelSwaps` alongside good tokens still registers the tokens and
 * leaves capacity at the relay's default of 8. That asymmetry is reproduced
 * here rather than tightened.
 */
export function parseSolverCapabilities(value: unknown): SolverCapabilitiesMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "solver-capabilities") return null;
  const { tokenIds, maxParallelSwaps } = message;
  if (!Array.isArray(tokenIds) || !tokenIds.every(isCapabilityTokenId)) return null;
  const parsed: SolverCapabilitiesMessage = {
    type: "solver-capabilities",
    tokenIds: (tokenIds as string[]).map((token) => token.toLowerCase()),
  };
  if (
    typeof maxParallelSwaps === "number" &&
    Number.isInteger(maxParallelSwaps) &&
    maxParallelSwaps > 0
  ) {
    parsed.maxParallelSwaps = maxParallelSwaps;
  }
  return parsed;
}

/** Parse a `price-levels` frame exactly as the relay admits it. A frame the
 *  relay rejects is discarded silently, leaving the previous ladder live. */
export function parsePriceLevels(value: unknown): PriceLevelsMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "price-levels") return null;
  const { levels } = message;
  if (!Array.isArray(levels) || !levels.every(isPriceLevelsPair)) return null;
  return { type: "price-levels", levels: levels as PriceLevelsPair[] };
}

/** Parse a `swap-tx` frame as the relay admits it. A string `jobId` with
 *  non-hex `txBytes` is NOT silently dropped by the relay — it becomes a
 *  `malformed_swap_tx` job error — so both fields are required here. */
export function parseSwapTx(value: unknown): SwapTxMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "swap-tx") return null;
  if (typeof message.jobId !== "string" || !isHexBytes(message.txBytes)) return null;
  return { type: "swap-tx", jobId: message.jobId, txBytes: message.txBytes };
}

/** Parse a `job-error` frame as the relay admits it. */
export function parseJobError(value: unknown): JobErrorMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "job-error") return null;
  if (typeof message.jobId !== "string" || typeof message.reason !== "string") return null;
  return { type: "job-error", jobId: message.jobId, reason: message.reason };
}

/**
 * Parse a relay-sent `swap` job as the solver admits it.
 *
 * The reference solver drops the frame when any of the six fields is falsy and
 * answers `job-error: invalid_swap` when the amounts do not parse as positive
 * BigInts. Both amounts are stringified BigInts on the relay side, so the
 * decimal-integer grammar plus positivity is the whole admission rule.
 */
export function parseSwap(value: unknown): SwapMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "swap") return null;
  const { jobId, tokenIn, tokenOut, amountIn, amountOut } = message;
  if (typeof jobId !== "string" || jobId === "") return null;
  if (typeof tokenIn !== "string" || tokenIn === "") return null;
  if (typeof tokenOut !== "string" || tokenOut === "") return null;
  if (!isAmountString(amountIn) || !isAmountString(amountOut)) return null;
  if (BigInt(amountIn) <= 0n || BigInt(amountOut) <= 0n) return null;
  return { type: "swap", jobId, tokenIn, tokenOut, amountIn, amountOut };
}

/** Parse a relay-broadcast `tx-submitted` frame. */
export function parseTxSubmitted(value: unknown): TxSubmittedMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "tx-submitted") return null;
  if (typeof message.jobId !== "string" || message.jobId === "") return null;
  if (typeof message.txId !== "string") return null;
  return { type: "tx-submitted", jobId: message.jobId, txId: message.txId };
}

/** Parse a relay-broadcast `submit-failed` frame. */
export function parseSubmitFailed(value: unknown): SubmitFailedMessage | null {
  const message = asRecord(value);
  if (!message || message.type !== "submit-failed") return null;
  if (typeof message.jobId !== "string" || message.jobId === "") return null;
  if (typeof message.reason !== "string") return null;
  return { type: "submit-failed", jobId: message.jobId, reason: message.reason };
}

/**
 * relay-ws.ts `interpolateQuote`: the output the relay will promise a taker for
 * `amountIn` against one published ladder, by flooring linear interpolation
 * between the bracketing rungs.
 *
 * Reproduced here because it defines what the COW is HELD TO. The relay quotes
 * and admits jobs from this function, so every published rung set must be
 * honourable at every interpolated point it implies, not merely at the rungs.
 * `null` is a size the relay refuses: below the first rung or above the last.
 */
export function interpolateQuote(levels: PriceLevel[], amountIn: bigint): bigint | null {
  if (levels.length === 0) return null;
  if (amountIn < BigInt(levels[0]!.input)) return null;
  if (amountIn > BigInt(levels[levels.length - 1]!.input)) return null;
  for (let index = 0; index < levels.length - 1; index += 1) {
    const inputLow = BigInt(levels[index]!.input);
    const inputHigh = BigInt(levels[index + 1]!.input);
    if (amountIn > inputHigh) continue;
    // A well-formed ladder is strictly ascending; never divide by zero on a
    // degenerate rung pair — fall back to the lower rung, as the relay does.
    if (inputHigh <= inputLow) return BigInt(levels[index]!.output);
    const outputLow = BigInt(levels[index]!.output);
    const outputHigh = BigInt(levels[index + 1]!.output);
    return outputLow + ((outputHigh - outputLow) * (amountIn - inputLow)) / (inputHigh - inputLow);
  }
  // Only reachable when amountIn equals a single rung's input.
  return BigInt(levels[levels.length - 1]!.output);
}
