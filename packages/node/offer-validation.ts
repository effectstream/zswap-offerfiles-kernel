import { OFFER_HRP } from "@effectstream/mip-zswap-offer/mip5";
import {
  getLatestEffectstreamBlock,
  getOfferByHash,
} from "@zswap-da/database";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
import {
  OFFER_VALIDATION_MAX_REASON_CHARS,
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  isSupportedOfferValidationSemantics,
  parseOfferValidationRequest,
  parseOfferValidationVerdict,
  type OfferValidationCode,
  type OfferValidationRequest,
  type OfferValidationStatus,
  type OfferValidationVerdict,
  type ValidatedOfferSemantics,
} from "@zswap-da/solver-core/validation-contract";
import {
  getBlankRefState,
  validateZswapOffer,
  verifyOfferCrypto,
  type OfferValidation,
} from "@zswap-da/validator";

import {
  authenticateSolverLevelsToken,
  MIDNIGHT_NETWORK_ID,
  OFFER_MAX_BYTES,
  offerValidationTimeoutMs,
  ROOT_WINDOW_SECONDS,
  solverLevelsCredentials,
} from "./env.ts";
import { evaluateOfferLivenessFromDatabase } from "./offer-liveness.ts";
import { getFreshSyncStatus, getSyncStatus } from "./sync-health.ts";

const MAX_U64 = (1n << 64n) - 1n;
const CONSISTENT_READ_ATTEMPTS = 3;

/** The route-level JSON bound is deliberately a little larger than the
 * validator's exact bech32m ceiling so a just-oversized offer receives the
 * stable domain `TOO_LARGE` verdict. Larger transport bodies stop at 413
 * before JSON parsing or proof work. */
export function offerValidationBodyLimit(maxDecodedBytes = OFFER_MAX_BYTES): number {
  const safeMax = Number.isSafeInteger(maxDecodedBytes) && maxDecodedBytes > 0
    ? maxDecodedBytes
    : 1024 * 1024;
  const encodedOfferChars = Math.ceil((safeMax * 8) / 5) + OFFER_HRP.length + 7;
  return encodedOfferChars + 2_048;
}

export class OfferValidationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferValidationUnavailableError";
  }
}

export type ValidationStateAnchor = {
  version: string;
  atMs: number;
  atIso: string;
};

type StateFailure = {
  code: OfferValidationCode;
  reason: string;
};

type BoundOfferState = {
  anchor: ValidationStateAnchor;
  status: OfferValidationStatus;
  live: boolean;
  expiresAt: string | null;
  failure: StateFailure | null;
};

export interface ValidateOfferForUseOptions {
  signal?: AbortSignal;
}

const checkSignal = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error
    ? signal.reason.message
    : "validation request cancelled";
  throw new OfferValidationUnavailableError(reason);
};

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value ?? "");
  if (reason.length <= OFFER_VALIDATION_MAX_REASON_CHARS) return reason;
  return reason.slice(0, OFFER_VALIDATION_MAX_REASON_CHARS - 1) + "…";
}

function checkedVerdict(
  request: OfferValidationRequest,
  anchor: ValidationStateAnchor,
  fields: Omit<
    OfferValidationVerdict,
    "schemaVersion" | "profile" | "claimedOfferId" | "stateVersion" | "validatedAt"
  >,
): OfferValidationVerdict {
  const candidate: OfferValidationVerdict = {
    schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
    profile: request.profile,
    claimedOfferId: request.offerId,
    stateVersion: anchor.version,
    validatedAt: anchor.atIso,
    ...fields,
    ...(fields.reason === undefined ? {} : { reason: boundedReason(fields.reason) }),
  };
  const parsed = parseOfferValidationVerdict(candidate);
  if (parsed === null) {
    throw new OfferValidationUnavailableError(
      `refusing to emit a noncanonical validation verdict (${candidate.code})`,
    );
  }
  return parsed;
}

function canonicalValidatorCode(validation: OfferValidation): OfferValidationCode {
  switch (validation.code) {
    case "BAD_ENCODING":
    case "TOO_LARGE":
    case "BAD_DESERIALIZE":
    case "WRONG_TX_VARIANT":
    case "NO_SPENDABLE_INPUT":
    case "NOT_A_SWAP":
    case "UNKNOWN_TOKEN":
    case "ROOT_UNREADABLE":
    case "NULLIFIER_SPENT":
    case "UTXO_NOT_LIVE":
    case "ROOT_UNKNOWN":
    case "PROOF_INVALID":
    case "SIGNATURE_INVALID":
      return validation.code;
    default:
      throw new OfferValidationUnavailableError(
        `validator returned an unsupported boundary code: ${String(validation.code)}`,
      );
  }
}

export function validationStateAnchorFromRow(row: {
  block_height: unknown;
  ms_timestamp: unknown;
} | null | undefined): ValidationStateAnchor {
  if (!row) throw new OfferValidationUnavailableError("backend has no committed state anchor");

  const version = canonicalStateVersion(row.block_height);
  if (version === null) {
    throw new OfferValidationUnavailableError("backend state version is not canonical u64");
  }
  if (row.ms_timestamp === null || row.ms_timestamp === undefined) {
    throw new OfferValidationUnavailableError("backend state timestamp is unavailable");
  }
  const atMs = Number(row.ms_timestamp);
  const date = new Date(atMs);
  if (!Number.isSafeInteger(atMs) || atMs < 0 || !Number.isFinite(date.getTime())) {
    throw new OfferValidationUnavailableError("backend state timestamp is unavailable");
  }
  return { version, atMs, atIso: date.toISOString() };
}

async function readStateAnchor(
  dbConn: any,
  signal?: AbortSignal,
): Promise<ValidationStateAnchor> {
  checkSignal(signal);
  const row = (await getLatestEffectstreamBlock.run(undefined, dbConn))[0];
  checkSignal(signal);
  return validationStateAnchorFromRow(row);
}

function canonicalStateVersion(value: unknown): string | null {
  const version = String(value);
  if (!/^[1-9][0-9]{0,19}$/.test(version) || BigInt(version) > MAX_U64) {
    return null;
  }
  return version;
}

async function requireCurrentBackend(
  dbConn: any,
  signal?: AbortSignal,
  freshFirst = false,
): Promise<ValidationStateAnchor> {
  for (let attempt = 0; attempt < 2; attempt++) {
    checkSignal(signal);
    let sync: Awaited<ReturnType<typeof getSyncStatus>>;
    try {
      sync = freshFirst || attempt > 0
        ? await getFreshSyncStatus(dbConn)
        : await getSyncStatus(dbConn);
    } catch (error) {
      throw new OfferValidationUnavailableError(
        `backend currentness check failed: ${boundedReason(error)}`,
      );
    }
    checkSignal(signal);
    if (sync.status !== "ok" || sync.blockL2 === null) {
      throw new OfferValidationUnavailableError("backend is not synchronized");
    }
    const anchor = await readStateAnchor(dbConn, signal);
    const healthVersion = canonicalStateVersion(sync.blockL2.height);
    if (healthVersion === anchor.version) return anchor;
  }
  throw new OfferValidationUnavailableError(
    "backend currentness response is not bound to the committed state anchor",
  );
}

function normalizeStoredStatus(value: unknown): OfferValidationStatus {
  switch (value) {
    case "live":
    case "consumed":
    case "cancelled":
    case "expired":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function parseExpiry(value: unknown): { atMs: number; iso: string } | null {
  if (value === null || value === undefined) return null;
  const atMs = new Date(value as any).getTime();
  if (!Number.isSafeInteger(atMs) || atMs < 0) return null;
  return { atMs, iso: new Date(atMs).toISOString() };
}

/** Read one exact indexed identity and all of its current liveness predicates
 * between two equal committed Effectstream anchors. This avoids holding a DB
 * transaction snapshot across proof verification while ensuring the version
 * named by the verdict brackets every final state probe. */
async function readBoundOfferState(
  offerId: string,
  validation: OfferValidation,
  dbConn: any,
  signal?: AbortSignal,
): Promise<BoundOfferState> {
  for (let attempt = 0; attempt < CONSISTENT_READ_ATTEMPTS; attempt++) {
    const before = await readStateAnchor(dbConn, signal);
    const rows = await getOfferByHash.run({ offer_hash: offerId }, dbConn);
    checkSignal(signal);

    let state: Omit<BoundOfferState, "anchor">;
    const row = rows[0];
    if (!row) {
      state = {
        status: "not_indexed",
        live: false,
        expiresAt: null,
        failure: {
          code: "NOT_INDEXED",
          reason: "the exact candidate is not indexed by this backend",
        },
      };
    } else {
      let storedOfferId: string;
      try {
        storedOfferId = offerHashFromBlob(row.transaction_hex);
      } catch (error) {
        throw new OfferValidationUnavailableError(
          `indexed offer bytes are undecodable: ${boundedReason(error)}`,
        );
      }
      if (row.offer_hash !== offerId || storedOfferId !== offerId) {
        throw new OfferValidationUnavailableError(
          "indexed offer identity is not bound to its stored bytes",
        );
      }

      const status = normalizeStoredStatus(row.status);
      if (status !== "live") {
        state = {
          status,
          live: false,
          expiresAt: parseExpiry(row.metadata_expires_at)?.iso ?? null,
          failure: {
            code: "NOT_LIVE",
            reason: `indexed offer lifecycle status is '${status}'`,
          },
        };
      } else {
        const expiry = parseExpiry(row.metadata_expires_at);
        if (expiry === null) {
          throw new OfferValidationUnavailableError(
            "live indexed offer has no canonical expiry",
          );
        }
        if (expiry.atMs <= before.atMs) {
          // The scheduled cleanup transition may lag the clock. Preserve the
          // stored lifecycle status while reporting current usability false.
          state = {
            status: "live",
            live: false,
            expiresAt: expiry.iso,
            failure: {
              code: "EXPIRED",
              reason: "the indexed offer expired before its cleanup transition archived the row",
            },
          };
        } else {
          const liveness = await evaluateOfferLivenessFromDatabase(
            validation,
            dbConn,
            { getRootCutoffMs: async () => before.atMs - ROOT_WINDOW_SECONDS * 1000 },
          );
          checkSignal(signal);
          state = liveness.ok
            ? {
                status: "live",
                live: true,
                expiresAt: expiry.iso,
                failure: null,
              }
            : {
                status: "live",
                live: false,
                expiresAt: expiry.iso,
                failure: { code: liveness.code as OfferValidationCode, reason: liveness.reason },
              };
        }
      }
    }

    const after = await readStateAnchor(dbConn, signal);
    if (before.version === after.version && before.atIso === after.atIso) {
      return { anchor: after, ...state };
    }
  }
  throw new OfferValidationUnavailableError(
    "backend state advanced during every validation snapshot attempt",
  );
}

function stateVerdict(
  request: OfferValidationRequest,
  computedOfferId: string,
  state: BoundOfferState,
): OfferValidationVerdict {
  if (state.failure === null) {
    throw new OfferValidationUnavailableError("live state has no negative verdict");
  }
  return checkedVerdict(request, state.anchor, {
    valid: false,
    live: state.live,
    computedOfferId,
    status: state.status,
    code: state.failure.code,
    reason: state.failure.reason,
  });
}

/** Validate one already-indexed offer for solver use. Every database operation
 * is a read. In particular, indexed presence is evidence, not a duplicate
 * error, and the expensive proof sits between two independent committed-state
 * reads so a lifecycle race cannot produce a stale valid verdict. */
export async function validateOfferForUse(
  request: OfferValidationRequest,
  dbConn: any,
  options: ValidateOfferForUseOptions = {},
): Promise<OfferValidationVerdict> {
  const { signal } = options;
  const initialAnchor = await requireCurrentBackend(dbConn, signal);

  if (request.profile !== OFFER_VALIDATION_PROFILE) {
    return checkedVerdict(request, initialAnchor, {
      valid: false,
      live: false,
      computedOfferId: null,
      status: "unknown",
      code: "UNSUPPORTED_PROFILE",
      reason: "unsupported validation profile",
    });
  }

  checkSignal(signal);
  const structural = validateZswapOffer(request.offer, {
    refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
    tblock: new Date(initialAnchor.atMs),
    maxBytes: OFFER_MAX_BYTES,
    crypto: "defer",
  });
  checkSignal(signal);

  let computedOfferId: string | null = null;
  if (structural.code !== "BAD_ENCODING" && structural.code !== "TOO_LARGE") {
    try {
      computedOfferId = offerHashFromBlob(request.offer);
    } catch {
      // The canonical structural verdict below owns decode failures.
    }
  }
  if (computedOfferId !== null && computedOfferId !== request.offerId) {
    return checkedVerdict(request, initialAnchor, {
      valid: false,
      live: false,
      computedOfferId,
      status: "unknown",
      code: "HASH_MISMATCH",
      reason: "claimed offerId does not match the decoded offer bytes",
    });
  }
  if (!structural.ok) {
    return checkedVerdict(request, initialAnchor, {
      valid: false,
      live: false,
      computedOfferId,
      status: "unknown",
      code: canonicalValidatorCode(structural),
      reason: structural.reason ?? "offer failed canonical structural validation",
    });
  }
  if (computedOfferId === null || structural.tx === undefined) {
    throw new OfferValidationUnavailableError(
      "canonical validator accepted an offer without identity/transaction",
    );
  }

  const initialState = await readBoundOfferState(
    computedOfferId,
    structural,
    dbConn,
    signal,
  );
  if (initialState.anchor.version !== initialAnchor.version ||
    initialState.anchor.atIso !== initialAnchor.atIso) {
    throw new OfferValidationUnavailableError(
      "initial offer state advanced beyond the synchronized backend anchor",
    );
  }
  if (initialState.failure !== null) {
    return stateVerdict(request, computedOfferId, initialState);
  }
  if (initialState.expiresAt === null) {
    throw new OfferValidationUnavailableError("initial live state lost its expiry");
  }
  const initialSemantics: ValidatedOfferSemantics = {
    gives: structural.gives ?? [],
    wants: structural.wants ?? [],
    inputNullifiers: structural.nullifiers ?? [],
    expiresAt: initialState.expiresAt,
  };
  // Supported economics are completely determined by the structurally
  // decoded transaction. Reject unsupported shapes before native proof work;
  // this verdict does not claim that the proof was valid.
  if (!isSupportedOfferValidationSemantics(initialSemantics)) {
    return checkedVerdict(request, initialState.anchor, {
      valid: false,
      live: true,
      computedOfferId,
      status: "live",
      code: "UNSUPPORTED_SHAPE",
      reason: "offer is live but is not one shielded -A +B pair for the v1 profile",
    });
  }

  checkSignal(signal);
  const crypto = verifyOfferCrypto(structural.tx, {
    refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
    tblock: new Date(initialState.anchor.atMs),
  });
  checkSignal(signal);

  // Fresh committed reads only: no transaction/snapshot survives the proof.
  // Re-run aggregate currentness with uncached external tips after proof work,
  // then bind every final status/liveness read to that exact L2 version.
  let finalState: BoundOfferState | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const finalCurrentAnchor = await requireCurrentBackend(dbConn, signal, true);
    const candidate = await readBoundOfferState(
      computedOfferId,
      structural,
      dbConn,
      signal,
    );
    if (candidate.anchor.version === finalCurrentAnchor.version &&
      candidate.anchor.atIso === finalCurrentAnchor.atIso) {
      finalState = candidate;
      break;
    }
  }
  if (finalState === null) {
    throw new OfferValidationUnavailableError(
      "final offer state could not be bound to a current backend anchor",
    );
  }
  if (finalState.failure !== null) {
    return stateVerdict(request, computedOfferId, finalState);
  }
  if (!crypto.ok) {
    return checkedVerdict(request, finalState.anchor, {
      valid: false,
      live: true,
      computedOfferId,
      status: "live",
      code: crypto.code as OfferValidationCode,
      reason: crypto.reason,
    });
  }

  if (finalState.expiresAt === null) {
    throw new OfferValidationUnavailableError("final live state lost its expiry");
  }
  const computed: ValidatedOfferSemantics = {
    gives: structural.gives ?? [],
    wants: structural.wants ?? [],
    inputNullifiers: structural.nullifiers ?? [],
    expiresAt: finalState.expiresAt,
  };
  // Expiry is re-read after proof and belongs to the final state anchor. The
  // transaction economics were already classified before proof, but keep this
  // fail-closed assertion so a future semantics predicate cannot drift.
  if (!isSupportedOfferValidationSemantics(computed)) {
    throw new OfferValidationUnavailableError(
      "supported offer semantics changed across validation state reads",
    );
  }

  return checkedVerdict(request, finalState.anchor, {
    valid: true,
    live: true,
    computedOfferId,
    status: "live",
    code: "VALID",
    computed,
  });
}

/** Register the authenticated validation-only boundary. Authentication uses
 * the existing solver credential registry but does not consult the optional
 * solver-level publication/quote feature switches. */
export function registerOfferValidationRoute(server: any, dbConn: any): void {
  // One physical validation operation per configured solver identity. A
  // request deadline only ends the HTTP decision; a database driver may not
  // observe AbortSignal until its in-flight query settles. Keep the identity's
  // slot occupied until that underlying read-only operation really settles so
  // an allowlisted/co-located solver cannot accumulate abandoned work.
  const activeBySolver = new Map<string, Promise<OfferValidationVerdict>>();

  server.post(
    "/v1/offers/validate",
    {
      bodyLimit: offerValidationBodyLimit(),
      // Authentication must run before Fastify parses/buffers the JSON body:
      // an unauthenticated oversized request may spend one rate-limit token,
      // but it cannot allocate an offer body or reach any validation work.
      onRequest: (request: any, reply: any, done: () => void) => {
        let credentials: ReturnType<typeof solverLevelsCredentials>;
        try {
          credentials = solverLevelsCredentials();
        } catch (error) {
          console.error("[OFFER_VALIDATION] Invalid authentication configuration", error);
          reply.code(503).send({
            error: "VALIDATION_DISABLED",
            reason: "offer validation is unavailable",
          });
          return;
        }
        if (credentials.length === 0) {
          reply.code(503).send({
            error: "VALIDATION_DISABLED",
            reason: "offer validation is disabled until solver credentials are configured",
          });
          return;
        }
        const authorization = String(request.headers?.authorization ?? "");
        const match = /^Bearer ([^\s]+)$/.exec(authorization);
        const solverId = match
          ? authenticateSolverLevelsToken(match[1], credentials)
          : null;
        if (solverId === null) {
          reply.header("WWW-Authenticate", "Bearer");
          reply.code(401).send({
            error: "UNAUTHORIZED",
            reason: "valid solver bearer token required",
          });
          return;
        }
        request.offerValidationSolverId = solverId;
        done();
      },
    },
    async (request: any, reply: any) => {
      const parsed = parseOfferValidationRequest(request.body);
      if (parsed === null) {
        return reply.code(400).send({
          error: "VALIDATION",
          reason:
            "expected exactly {schemaVersion:1, profile, offerId:<64 lowercase hex>, offer}",
        });
      }

      const solverId = request.offerValidationSolverId;
      if (typeof solverId !== "string" || solverId.length === 0) {
        return reply.code(503).send({
          error: "VALIDATION_UNAVAILABLE",
          reason: "offer validation could not bind the authenticated solver identity",
        });
      }
      if (activeBySolver.has(solverId)) {
        return reply.code(503).send({
          error: "VALIDATION_UNAVAILABLE",
          reason: "an offer validation operation is already active for this solver credential",
        });
      }

      const controller = new AbortController();
      const timeoutMs = offerValidationTimeoutMs();
      let rejectCancellation!: (error: Error) => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const abort = (reason: Error) => {
        if (controller.signal.aborted) return;
        controller.abort(reason);
        rejectCancellation(reason);
      };
      const onRequestAborted = () => abort(new Error("validation request body disconnected"));
      const onResponseClosed = () => {
        // ServerResponse emits close after both a normal end and a premature
        // socket loss. Only the latter cancels still-running validation work.
        if (reply.raw?.writableEnded) return;
        abort(new Error("validation response socket disconnected"));
      };
      const responseSocket = reply.raw?.socket ?? request.raw?.socket;
      request.raw?.once?.("aborted", onRequestAborted);
      reply.raw?.once?.("close", onResponseClosed);
      responseSocket?.once?.("end", onResponseClosed);
      responseSocket?.once?.("close", onResponseClosed);
      const timer = setTimeout(
        () => abort(new Error(`validation deadline exceeded after ${timeoutMs}ms`)),
        timeoutMs,
      );

      const operation = validateOfferForUse(parsed, dbConn, {
        signal: controller.signal,
      });
      activeBySolver.set(solverId, operation);
      void operation.finally(() => {
        if (activeBySolver.get(solverId) === operation) {
          activeBySolver.delete(solverId);
        }
      }).catch(() => undefined);
      // A timeout can win while a read-only driver query is completing. Keep
      // its eventual rejection observed; signal checks stop later stages and
      // the per-solver slot above remains held until physical settlement.
      void operation.catch(() => undefined);
      try {
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        if (!(error instanceof OfferValidationUnavailableError) &&
          !controller.signal.aborted) {
          console.error("[OFFER_VALIDATION] Unexpected failure", error);
        }
        if (reply.raw?.destroyed || reply.raw?.writableEnded) {
          return reply;
        }
        return reply.code(503).send({
          error: "VALIDATION_UNAVAILABLE",
          reason: controller.signal.aborted
            ? "offer validation timed out or was cancelled"
            : "offer validation could not establish current backend state",
        });
      } finally {
        clearTimeout(timer);
        request.raw?.off?.("aborted", onRequestAborted);
        reply.raw?.off?.("close", onResponseClosed);
        responseSocket?.off?.("end", onResponseClosed);
        responseSocket?.off?.("close", onResponseClosed);
      }
    },
  );
}
