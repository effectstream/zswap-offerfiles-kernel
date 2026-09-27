// Offer-TTL parsing for the maker one-shot (00055 FR-002). Pure: no wallet, no
// SDK and no network, so the whole surface is unit-testable. The poster parses
// its own `OFFER_TTL_MINUTES` in poster-config.ts, against the same constants.
//
// The default and the upper bound come from packages/node/network-windows.ts:
// the kernel's root window (the ledger-9 `global_ttl`, 1,209,600 s) minus one
// shared safety margin (3,600 s), which gives 20,100 minutes. Ledger 9 rejects
// an intent whose `ttl > tblock + global_ttl`, and `tblock` is the chain's
// block time, which can lag the wall clock the TTL is computed from. So a
// larger TTL is refused here, at startup, by variable name.
//
// Relative import: `deploy/` is not a workspace member (see maker-offer.ts).
import {
  OFFER_TTL_BOUND_TEXT,
  OFFER_TTL_DEFAULT_MINUTES,
  OFFER_TTL_MAX_MINUTES,
  OFFER_TTL_MAX_S,
} from "../../../packages/node/network-windows.ts";

/** Default offer TTL in milliseconds (20,100 minutes). */
export const OFFER_TTL_DEFAULT_MS = OFFER_TTL_DEFAULT_MINUTES * 60_000;

/** Upper bound in milliseconds (the root window minus the safety margin). */
export const OFFER_TTL_MAX_MS = OFFER_TTL_MAX_S * 1000;

/** A refused offer TTL. `variable` names the setting that carried it. */
export class OfferTtlError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "OfferTtlError";
    this.variable = variable;
  }
}

/**
 * A TTL-in-minutes env value (`TTL_MINUTES`) -> whole minutes.
 *
 * Absent, blank or whitespace-only means the derived default: compose renders
 * `${MAKER_OFFER_TTL_MINUTES:-}` for an unset knob as the empty string, which
 * must not become a zero TTL. Anything else must be a whole number of minutes
 * in `1..20100`, or it is refused naming `variable` (and the bound, when it is
 * too large).
 */
export function resolveOfferTtlMinutes(variable: string, raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return OFFER_TTL_DEFAULT_MINUTES;
  if (!/^\d+$/.test(value)) {
    throw new OfferTtlError(
      variable,
      `${variable} must be a whole number of minutes, got ${JSON.stringify(raw)}`,
    );
  }
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 1) {
    throw new OfferTtlError(variable, `${variable} must be at least 1 minute, got ${value}`);
  }
  if (minutes > OFFER_TTL_MAX_MINUTES) {
    throw new OfferTtlError(variable, `${variable} must be <= ${OFFER_TTL_BOUND_TEXT}, got ${value}`);
  }
  return minutes;
}

/**
 * The same bound for library callers that pass milliseconds
 * (`postMakerOffer({ ttlMs })`). Returns the value unchanged when it is valid.
 */
export function assertOfferTtlMs(variable: string, ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new OfferTtlError(variable, `${variable} must be a positive number of ms, got ${ttlMs}`);
  }
  if (ttlMs > OFFER_TTL_MAX_MS) {
    throw new OfferTtlError(
      variable,
      `${variable} must be <= ${OFFER_TTL_MAX_MS} ms = ${OFFER_TTL_BOUND_TEXT}, got ${ttlMs}`,
    );
  }
  return ttlMs;
}
