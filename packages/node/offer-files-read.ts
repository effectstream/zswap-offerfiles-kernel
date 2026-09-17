// POST /v1/offers/files — the dedicated, side-effect-free EXACT-FILES READ.
//
// Callers name content identities; the backend answers with the exact indexed
// bytes for the ones that are live and valid at a committed state anchor, and
// with a stable machine-readable verdict for every other one. It is the read a
// solver uses at job time, when it must build a settlement half out of the
// maker's real bytes rather than anything it cached.
//
// Three properties are load-bearing and are what the tests pin:
//
//   * It REUSES the canonical pipeline. Everything below defers to
//     `validateOfferForUse` in offer-validation.ts, which is the same
//     composition of shared structural validation, ordered liveness
//     descriptors and native proof verification that HTTP submission and STM
//     ingestion use. There is deliberately no second validation ladder here.
//   * It is READ-ONLY. Every database operation on this path is a SELECT: no
//     batcher call, no Celestia publication (and so no fee), no lifecycle
//     transition, no scheduled input, no event.
//   * Bytes are BOUND to the identity that was asked for. The stored row's
//     bytes are re-hashed and the whole response is re-parsed through the
//     shared contract before it is sent, so a corrupted index can only produce
//     a refusal, never bytes served under someone else's identity.
//
// The route is unauthenticated on purpose: this backend serves every client
// alike and keeps no per-solver state. Exposure is bounded by the router-wide
// request budget, the per-request identity cap, one absolute deadline, and a
// small concurrency window — proof verification is synchronous, so allowing
// more parallel readers would buy no throughput and only multiply retained
// work.

import { getOfferByHash } from "@zswap-da/database";
import {
  EXACT_FILES_PROFILE,
  EXACT_FILES_SCHEMA_VERSION,
  MAX_EXACT_FILES_PER_READ,
  parseExactFilesRequest,
  parseExactFilesResponse,
  type ExactFilesEntry,
  type ExactFilesResponse,
} from "@zswap-da/solver-core/exact-files-contract";
import { offerHashFromBlob } from "@zswap-da/offer-guard";

import { exactFilesReadTimeoutMs } from "./env.ts";
import {
  OfferValidationUnavailableError,
  checkedVerdict,
  requireCurrentBackend,
  validateOfferForUse,
} from "./offer-validation.ts";

/** Concurrent exact-files reads this node will start. Native proof
 * verification blocks the event loop, so a larger window would not shorten any
 * single read; it would only let more callers hold retained read work at once.
 * Requests past the window are refused immediately rather than queued, so no
 * caller can grow an unbounded backlog of pending offer bodies. */
export const MAX_CONCURRENT_EXACT_FILES_READS = 4;

/** JSON body bound. A request carries only identities, so the ceiling is
 * generous relative to the largest well-formed request and still refuses
 * anything that would make the parser do real work. */
export const EXACT_FILES_BODY_LIMIT_BYTES = 8 * 1024;

export interface ReadExactOfferFileOptions {
  signal?: AbortSignal;
}

/** Resolve one identity: exact bytes when the canonical pipeline says the
 * offer is live and valid, otherwise the verdict that explains the refusal. */
export async function readExactOfferFile(
  offerId: string,
  profile: string,
  dbConn: any,
  options: ReadExactOfferFileOptions = {},
): Promise<ExactFilesEntry> {
  const { signal } = options;
  // Bind even a "there is nothing here" answer to a synchronized backend. An
  // unsynchronized node must not be able to report an offer as absent — that
  // is exactly the false negative a solver would treat as a dead offer.
  const anchor = await requireCurrentBackend(dbConn, signal);

  if (profile !== EXACT_FILES_PROFILE) {
    return {
      offerId,
      verdict: checkedVerdict(profile, offerId, anchor, {
        valid: false,
        live: false,
        computedOfferId: null,
        status: "unknown",
        code: "UNSUPPORTED_PROFILE",
        reason: "unsupported validation profile",
      }),
    };
  }

  const rows = await getOfferByHash.run({ offer_hash: offerId }, dbConn);
  const row = rows[0];
  if (!row) {
    return {
      offerId,
      verdict: checkedVerdict(profile, offerId, anchor, {
        valid: false,
        live: false,
        computedOfferId: null,
        status: "not_indexed",
        code: "NOT_INDEXED",
        reason: "the requested offer identity is not indexed by this backend",
      }),
    };
  }

  // The bytes handed to the canonical pipeline are the STORED bytes, never
  // anything the caller supplied — that is the whole difference between this
  // read and a caller-asserted validation. If the stored bytes do not hash to
  // the requested identity the pipeline itself answers HASH_MISMATCH, so index
  // corruption becomes a per-identity refusal instead of an outage.
  const offer = String(row.transaction_hex ?? "");
  const verdict = await validateOfferForUse(
    {
      schemaVersion: EXACT_FILES_SCHEMA_VERSION,
      profile,
      offerId,
      offer,
    },
    dbConn,
    signal === undefined ? {} : { signal },
  );
  if (!verdict.valid) return { offerId, verdict };

  // Belt and braces before bytes leave the node: re-derive the identity of
  // exactly the string being returned.
  let served: string;
  try {
    served = offerHashFromBlob(offer);
  } catch (error) {
    throw new OfferValidationUnavailableError(
      `indexed offer bytes became undecodable while serving: ${String(error)}`,
    );
  }
  if (served !== offerId) {
    throw new OfferValidationUnavailableError(
      "indexed offer bytes are not bound to the identity they are served under",
    );
  }
  return { offerId, verdict, offer };
}

/** Register the exact-files read. */
export function registerExactFilesRoute(server: any, dbConn: any): void {
  // Retained until the underlying read really settles. A deadline only ends
  // the HTTP decision; a database driver may not observe AbortSignal until its
  // in-flight query returns, and that physical work is what the window bounds.
  const active = new Set<Promise<unknown>>();

  server.post(
    "/v1/offers/files",
    { bodyLimit: EXACT_FILES_BODY_LIMIT_BYTES },
    async (request: any, reply: any) => {
      const parsed = parseExactFilesRequest(request.body);
      if (parsed === null) {
        return reply.code(400).send({
          error: "VALIDATION",
          reason:
            "expected exactly {schemaVersion:1, profile, offerIds:[<64 lowercase hex>…]} " +
            `with 1 to ${MAX_EXACT_FILES_PER_READ} distinct identities`,
        });
      }
      if (active.size >= MAX_CONCURRENT_EXACT_FILES_READS) {
        return reply.code(503).send({
          error: "FILES_UNAVAILABLE",
          reason: "too many exact-files reads are already active",
        });
      }

      const controller = new AbortController();
      const timeoutMs = exactFilesReadTimeoutMs();
      let rejectCancellation!: (error: Error) => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const abort = (reason: Error) => {
        if (controller.signal.aborted) return;
        controller.abort(reason);
        rejectCancellation(reason);
      };
      const onRequestAborted = () => abort(new Error("exact-files request body disconnected"));
      const onResponseClosed = () => {
        // ServerResponse emits close after both a normal end and a premature
        // socket loss. Only the latter cancels still-running read work.
        if (reply.raw?.writableEnded) return;
        abort(new Error("exact-files response socket disconnected"));
      };
      const responseSocket = reply.raw?.socket ?? request.raw?.socket;
      request.raw?.once?.("aborted", onRequestAborted);
      reply.raw?.once?.("close", onResponseClosed);
      responseSocket?.once?.("end", onResponseClosed);
      responseSocket?.once?.("close", onResponseClosed);
      const timer = setTimeout(
        () => abort(new Error(`exact-files deadline exceeded after ${timeoutMs}ms`)),
        timeoutMs,
      );

      // Identities are resolved one at a time. Proof verification is
      // synchronous native work, so nothing is gained by interleaving, and a
      // serial walk keeps at most one offer body in flight per read.
      const operation = (async (): Promise<ExactFilesResponse> => {
        const files: ExactFilesEntry[] = [];
        for (const offerId of parsed.offerIds) {
          files.push(
            await readExactOfferFile(offerId, parsed.profile, dbConn, {
              signal: controller.signal,
            }),
          );
        }
        const response: ExactFilesResponse = {
          schemaVersion: EXACT_FILES_SCHEMA_VERSION,
          profile: parsed.profile,
          files,
        };
        // Never emit something the shared contract would not accept, including
        // the byte-to-identity binding. A response that cannot be bound is an
        // internal fault, not a domain answer.
        if (parseExactFilesResponse(response, { hashOffer: offerHashFromBlob }) === null) {
          throw new OfferValidationUnavailableError(
            "refusing to emit a noncanonical exact-files response",
          );
        }
        return response;
      })();
      active.add(operation);
      void operation.finally(() => { active.delete(operation); }).catch(() => undefined);
      // A deadline can win while a read-only driver query is completing. Keep
      // the eventual rejection observed; the slot above stays held until that
      // physical work settles.
      void operation.catch(() => undefined);

      try {
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        if (!(error instanceof OfferValidationUnavailableError) && !controller.signal.aborted) {
          console.error("[OFFER_FILES] Unexpected failure", error);
        }
        if (reply.raw?.destroyed || reply.raw?.writableEnded) return reply;
        return reply.code(503).send({
          error: "FILES_UNAVAILABLE",
          reason: controller.signal.aborted
            ? "the exact-files read timed out or was cancelled"
            : "the exact-files read could not establish current backend state",
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
