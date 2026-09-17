// Versioned wire contract shared by the Offer Files node and solver for
// side-effect-free validation of an already-indexed candidate.
//
// This is deliberately independent from the validator package. The validator
// exposes reusable structural/cryptographic primitives; this module defines
// the stable HTTP boundary and normalizes context-specific backend outcomes.

export const OFFER_VALIDATION_SCHEMA_VERSION = 1 as const;
export const OFFER_VALIDATION_PROFILE = "offer-files-solver-v1" as const;

export const OFFER_VALIDATION_MAX_PROFILE_CHARS = 64;
export const OFFER_VALIDATION_MAX_REASON_CHARS = 1_024;

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;

export type OfferValidationCode =
  | "VALID"
  | "UNSUPPORTED_PROFILE"
  | "HASH_MISMATCH"
  | "NOT_INDEXED"
  | "NOT_LIVE"
  | "EXPIRED"
  | "UNSUPPORTED_SHAPE"
  | "BAD_ENCODING"
  | "TOO_LARGE"
  | "BAD_DESERIALIZE"
  | "WRONG_TX_VARIANT"
  | "NO_SPENDABLE_INPUT"
  | "NOT_A_SWAP"
  | "UNKNOWN_TOKEN"
  | "ROOT_UNREADABLE"
  | "NULLIFIER_SPENT"
  | "UTXO_NOT_LIVE"
  | "ROOT_UNKNOWN"
  | "PROOF_INVALID"
  | "SIGNATURE_INVALID";

export type OfferValidationStatus =
  | "live"
  | "consumed"
  | "cancelled"
  | "expired"
  | "unknown"
  | "not_indexed";

export interface OfferValidationRequest {
  schemaVersion: typeof OFFER_VALIDATION_SCHEMA_VERSION;
  /** Parsed as a bounded identifier so an unknown profile can receive the
   * stable UNSUPPORTED_PROFILE domain verdict instead of a transport error. */
  profile: string;
  offerId: string;
  offer: string;
}

export interface ValidatedOfferLeg {
  token: string;
  amount: string;
  kind: "SHIELDED" | "UNSHIELDED";
}

export interface ValidatedOfferSemantics {
  gives: ValidatedOfferLeg[];
  wants: ValidatedOfferLeg[];
  inputNullifiers: string[];
  expiresAt: string;
}

export interface OfferValidationVerdict {
  schemaVersion: typeof OFFER_VALIDATION_SCHEMA_VERSION;
  /** Echoes the requested profile. Unknown bounded profiles receive a stable
   * UNSUPPORTED_PROFILE verdict; they are not transport-malformed. */
  profile: string;
  /** Overall validate-for-use decision for the selected profile. */
  valid: boolean;
  /** Current spend/root/expiry usability. This is deliberately independent
   * from `status`: an indexed row can still have lifecycle status `live` while
   * a current root or spend predicate fails. It is also independent from
   * profile support: a live multi-leg row is not valid for the v1 profile. */
  live: boolean;
  claimedOfferId: string;
  computedOfferId: string | null;
  /** Canonical positive decimal Effectstream block height whose committed
   * state was used for the final liveness read. */
  stateVersion: string;
  /** Canonical ISO timestamp of that committed backend state. */
  validatedAt: string;
  status: OfferValidationStatus;
  code: OfferValidationCode;
  reason?: string;
  computed?: ValidatedOfferSemantics;
}

const validationCodes = new Set<OfferValidationCode>([
  "VALID",
  "UNSUPPORTED_PROFILE",
  "HASH_MISMATCH",
  "NOT_INDEXED",
  "NOT_LIVE",
  "EXPIRED",
  "UNSUPPORTED_SHAPE",
  "BAD_ENCODING",
  "TOO_LARGE",
  "BAD_DESERIALIZE",
  "WRONG_TX_VARIANT",
  "NO_SPENDABLE_INPUT",
  "NOT_A_SWAP",
  "UNKNOWN_TOKEN",
  "ROOT_UNREADABLE",
  "NULLIFIER_SPENT",
  "UTXO_NOT_LIVE",
  "ROOT_UNKNOWN",
  "PROOF_INVALID",
  "SIGNATURE_INVALID",
]);

const validationStatuses = new Set<OfferValidationStatus>([
  "live",
  "consumed",
  "cancelled",
  "expired",
  "unknown",
  "not_indexed",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
};

export const isCanonicalOfferId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isCanonicalU64 = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  return BigInt(value) <= MAX_U64;
};

const isCanonicalPositiveU256 = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) return false;
  return BigInt(value) <= MAX_U256;
};

const isCanonicalIso = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
};

const isProfileIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= OFFER_VALIDATION_MAX_PROFILE_CHARS &&
  /^[a-z0-9][a-z0-9._-]*$/.test(value);

export function parseOfferValidationRequest(value: unknown): OfferValidationRequest | null {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["schemaVersion", "profile", "offerId", "offer"],
  )) return null;
  if (value.schemaVersion !== OFFER_VALIDATION_SCHEMA_VERSION) return null;
  if (!isProfileIdentifier(value.profile)) return null;
  if (!isCanonicalOfferId(value.offerId)) return null;
  if (typeof value.offer !== "string" || value.offer.length === 0) return null;
  return value as unknown as OfferValidationRequest;
}

const isLeg = (value: unknown): value is ValidatedOfferLeg => {
  if (!isRecord(value) || !hasExactKeys(value, ["token", "amount", "kind"])) return false;
  return isCanonicalOfferId(value.token) &&
    isCanonicalPositiveU256(value.amount) &&
    (value.kind === "SHIELDED" || value.kind === "UNSHIELDED");
};

const isComputed = (value: unknown): value is ValidatedOfferSemantics => {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["gives", "wants", "inputNullifiers", "expiresAt"],
  )) return false;
  if (!Array.isArray(value.gives) || value.gives.length === 0 || !value.gives.every(isLeg)) {
    return false;
  }
  if (!Array.isArray(value.wants) || value.wants.length === 0 || !value.wants.every(isLeg)) {
    return false;
  }
  if (!Array.isArray(value.inputNullifiers) ||
    !value.inputNullifiers.every(isCanonicalOfferId) ||
    new Set(value.inputNullifiers).size !== value.inputNullifiers.length) return false;
  return isCanonicalIso(value.expiresAt);
};

/** The initial profile intentionally authorizes only the approved native
 * shielded -A +B shape. Pair/economic allowlisting remains a separate solver
 * policy; this check prevents another value layer or multi-leg transaction
 * from being mislabeled as valid for this profile. */
export function isSupportedOfferValidationSemantics(
  value: ValidatedOfferSemantics,
): boolean {
  return value.gives.length === 1 &&
    value.wants.length === 1 &&
    value.gives[0].kind === "SHIELDED" &&
    value.wants[0].kind === "SHIELDED" &&
    value.gives[0].token !== value.wants[0].token &&
    value.inputNullifiers.length > 0;
}

export function parseOfferValidationVerdict(value: unknown): OfferValidationVerdict | null {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      "schemaVersion",
      "profile",
      "valid",
      "live",
      "claimedOfferId",
      "computedOfferId",
      "stateVersion",
      "validatedAt",
      "status",
      "code",
    ],
    ["reason", "computed"],
  )) return null;
  if (value.schemaVersion !== OFFER_VALIDATION_SCHEMA_VERSION ||
    !isProfileIdentifier(value.profile) ||
    typeof value.valid !== "boolean" ||
    typeof value.live !== "boolean" ||
    !isCanonicalOfferId(value.claimedOfferId) ||
    !(value.computedOfferId === null || isCanonicalOfferId(value.computedOfferId)) ||
    !isCanonicalU64(value.stateVersion) ||
    !isCanonicalIso(value.validatedAt) ||
    !validationStatuses.has(value.status as OfferValidationStatus) ||
    !validationCodes.has(value.code as OfferValidationCode)) return null;
  if (value.reason !== undefined &&
    (typeof value.reason !== "string" || value.reason.length > OFFER_VALIDATION_MAX_REASON_CHARS)) {
    return null;
  }
  if (value.computed !== undefined && !isComputed(value.computed)) return null;

  if (value.valid) {
    if (value.live !== true || value.status !== "live" || value.code !== "VALID" ||
      value.computedOfferId !== value.claimedOfferId || value.computed === undefined ||
      !isSupportedOfferValidationSemantics(value.computed as ValidatedOfferSemantics)) return null;
  } else if (value.code === "VALID") {
    return null;
  }
  // A non-live lifecycle row cannot truthfully be reported as currently live.
  // The reverse does not hold: a stored live row may fail a current liveness
  // predicate or the selected solver profile and therefore be invalid.
  if (value.status !== "live" && value.live) return null;
  if (value.code === "NOT_INDEXED" && value.status !== "not_indexed") return null;
  if (value.code === "NOT_LIVE" &&
    (value.live || !["consumed", "cancelled", "expired", "unknown"].includes(
      value.status as string,
    ))) return null;
  // Expiry is evaluated at validation time. The scheduled cleanup transition
  // may not have archived the row yet, so both stored `live` and already
  // archived `expired` statuses are truthful for an EXPIRED verdict.
  if (value.code === "EXPIRED" &&
    (value.live || !["live", "expired"].includes(value.status as string))) return null;
  if ((value.profile === OFFER_VALIDATION_PROFILE) ===
    (value.code === "UNSUPPORTED_PROFILE")) return null;

  return value as unknown as OfferValidationVerdict;
}
