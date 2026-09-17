// GET /v1/offers/:hash/consumption -- versioned, side-effect-free settlement
// evidence for the solver.
//
// This route never manufactures evidence from lifecycle status. A positive
// answer exists only when the database query binds the complete archived
// shielded input and output marker sets to one inner Midnight ledger
// transaction and one height. The relay's Substrate extrinsic hash belongs to
// a different namespace and is intentionally absent from this response.

import { getOfferConsumptionEvidence } from "@zswap-da/database";
import {
  parseOfferConsumptionResponse,
  type OfferConsumptionResponse,
} from "@zswap-da/solver-core/receipt-client";

const OFFER_HASH = /^[0-9a-f]{64}$/;

function responseForRow(
  offerId: string,
  row: { status?: unknown; ledger_tx_hash?: unknown; ledger_height?: unknown } | undefined,
): OfferConsumptionResponse {
  const status = row === undefined
    ? "not_found"
    : row.status === "live" || row.status === "consumed" || row.status === "cancelled" || row.status === "expired"
      ? row.status
      : "not_found";
  const base: OfferConsumptionResponse = { version: 1, offerId, status };
  if (status !== "consumed" || typeof row?.ledger_tx_hash !== "string" ||
      !OFFER_HASH.test(row.ledger_tx_hash)) {
    return base;
  }
  const rawHeight = row.ledger_height;
  const height = typeof rawHeight === "number"
    ? rawHeight
    : typeof rawHeight === "string" && /^(0|[1-9][0-9]*)$/.test(rawHeight)
      ? Number(rawHeight)
      : Number.NaN;
  if (!Number.isSafeInteger(height) || height < 0) return base;
  return {
    ...base,
    evidence: { ledgerTxHash: row.ledger_tx_hash, height },
  };
}

export function registerOfferConsumptionRoute(server: any, dbConn: any): void {
  server.get("/v1/offers/:hash/consumption", async (request: any, reply: any) => {
    const offerId = String(request.params?.hash ?? "").toLowerCase();
    if (!OFFER_HASH.test(offerId)) {
      return reply.code(400).send({
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      });
    }
    const rows = await getOfferConsumptionEvidence.run({ offer_hash: offerId }, dbConn);
    const response = responseForRow(offerId, rows[0]);
    // Keep the server and solver on one grammar. If a future query change
    // makes this response noncanonical, fail locally instead of publishing an
    // unbound authority object.
    if (parseOfferConsumptionResponse(response, offerId) === null) {
      throw new Error("refusing to emit a noncanonical offer-consumption response");
    }
    return response;
  });
}
