// Versioned wire contract for the backend's side-effect-free EXACT-FILES READ:
// content identities in, exact offer bytes out for the ones that are live and
// valid right now, a stable machine-readable refusal for every other one.
//
// It deliberately reuses `validation-contract.ts` rather than inventing a
// second vocabulary: every entry carries the same closed verdict the backend's
// canonical validation pipeline produces, and the bytes are simply what a
// `VALID` verdict entitles the caller to. A refusal is therefore never an
// unexplained absence — it names the reason with the same stable code set the
// backend uses for its own admission and ingestion decisions.

import {
  OFFER_VALIDATION_PROFILE,
  isCanonicalOfferId,
  parseOfferValidationVerdict,
  type OfferValidationVerdict,
} from "./validation-contract.ts";

export const EXACT_FILES_SCHEMA_VERSION = 1 as const;
/** The read answers for exactly the profile the validation contract defines;
 * an unknown but well-formed profile receives UNSUPPORTED_PROFILE verdicts
 * rather than a transport error. */
export const EXACT_FILES_PROFILE = OFFER_VALIDATION_PROFILE;

/** One request may ask for a bounded set of identities. Each identity costs a
 * full canonical validation, including native proof verification, so the batch
 * is small on purpose: it exists to let one swap job resolve its offers in a
 * single round trip, not to bulk-export the book. */
export const MAX_EXACT_FILES_PER_READ = 8;

/** Whole-response decoded ceiling for a client. Ingestion already caps a
 * single offer, so this only bounds a non-conforming or hostile server. */
export const MAX_EXACT_FILES_RESPONSE_BYTES = 16 * 1024 * 1024;

export const EXACT_FILES_MAX_PROFILE_CHARS = 64;

export interface ExactFilesRequest {
  schemaVersion: typeof EXACT_FILES_SCHEMA_VERSION;
  profile: string;
  /** One to MAX_EXACT_FILES_PER_READ distinct canonical content identities. */
  offerIds: string[];
}

export interface ExactFilesEntry {
  offerId: string;
  /** The canonical verdict for this identity, bound to the committed backend
   * state named by its own `stateVersion`/`validatedAt`. */
  verdict: OfferValidationVerdict;
  /** The exact indexed bytes. Present if and only if the verdict is VALID. */
  offer?: string;
}

export interface ExactFilesResponse {
  schemaVersion: typeof EXACT_FILES_SCHEMA_VERSION;
  profile: string;
  /** One entry per requested identity, in request order. */
  files: ExactFilesEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
};

const isProfileIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= EXACT_FILES_MAX_PROFILE_CHARS &&
  /^[a-z0-9][a-z0-9._-]*$/.test(value);

export function parseExactFilesRequest(value: unknown): ExactFilesRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "profile", "offerIds"])) {
    return null;
  }
  if (value.schemaVersion !== EXACT_FILES_SCHEMA_VERSION) return null;
  if (!isProfileIdentifier(value.profile)) return null;
  const offerIds = value.offerIds;
  if (
    !Array.isArray(offerIds) ||
    offerIds.length === 0 ||
    offerIds.length > MAX_EXACT_FILES_PER_READ ||
    !offerIds.every(isCanonicalOfferId) ||
    new Set(offerIds).size !== offerIds.length
  ) return null;
  return value as unknown as ExactFilesRequest;
}

export interface ParseExactFilesResponseOptions {
  /** Content-identity function. Supplying it makes the parser enforce FR-008's
   * byte binding — that returned bytes really hash to the identity they are
   * served under — instead of trusting the server's own claim. */
  hashOffer?: (offer: string) => string;
}

/** Parse and fully bind one exact-files response.
 *
 * The binding rules are the point of this function, and the backend runs them
 * on its own output before answering so a noncanonical response can never
 * leave the node:
 *   - one entry per identity, each identity canonical and distinct;
 *   - every verdict is a canonical v1 verdict for the echoed profile and is
 *     claimed for its own entry's identity;
 *   - bytes are present exactly when the verdict is VALID, and never
 *     otherwise — a refusal cannot smuggle usable bytes;
 *   - when present, the bytes' own content identity is the requested one. */
export function parseExactFilesResponse(
  value: unknown,
  options: ParseExactFilesResponseOptions = {},
): ExactFilesResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "profile", "files"])) {
    return null;
  }
  if (value.schemaVersion !== EXACT_FILES_SCHEMA_VERSION) return null;
  if (!isProfileIdentifier(value.profile)) return null;
  const files = value.files;
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > MAX_EXACT_FILES_PER_READ
  ) return null;

  const seen = new Set<string>();
  for (const entry of files) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["offerId", "verdict"], ["offer"])) {
      return null;
    }
    if (!isCanonicalOfferId(entry.offerId) || seen.has(entry.offerId)) return null;
    seen.add(entry.offerId);

    const verdict = parseOfferValidationVerdict(entry.verdict);
    if (verdict === null) return null;
    if (verdict.profile !== value.profile) return null;
    if (verdict.claimedOfferId !== entry.offerId) return null;
    // `computedOfferId` is deliberately NOT required to equal the entry's
    // identity: HASH_MISMATCH is exactly the refusal that reports a different
    // computed identity for the bytes the backend holds. The verdict contract
    // already forces computed === claimed whenever the verdict is VALID.

    if (verdict.valid) {
      if (typeof entry.offer !== "string" || entry.offer.length === 0) return null;
      if (options.hashOffer !== undefined) {
        let computed: string;
        try {
          computed = options.hashOffer(entry.offer);
        } catch {
          return null;
        }
        if (computed !== entry.offerId) return null;
      }
    } else if (entry.offer !== undefined) {
      return null;
    }
  }
  return value as unknown as ExactFilesResponse;
}

/** The entry for one identity, or null when the response does not carry it.
 * Callers must never fall back to a cached blob on null. */
export function exactFileEntry(
  response: ExactFilesResponse,
  offerId: string,
): ExactFilesEntry | null {
  return response.files.find((entry) => entry.offerId === offerId) ?? null;
}
