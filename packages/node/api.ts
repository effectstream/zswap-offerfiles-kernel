import type { StartConfigApiRouter } from "@effectstream/runtime";
import rateLimit from "@fastify/rate-limit";

import {
  getKnownTokens,
  insertKnownToken,
  isNullifierSpent,
  isUnshieldedCreated,
  isKnownRoot,
  getTokenPrice,
  upsertTokenPrice,
  checkTokenNameExists,
  getTokenByColor,
  getPairs,
  upsertPairStatsByOfferId,
  getOpenOffersPage,
  getOfferTokensForOffers,
  getOfferByHash,
  getOfferStatusByHash,
  getOfferTokensAny,
  resolveOfferCursor,
} from "@zswap-da/database";

import { isTokenRegistryEnabled, MIDNIGHT_NETWORK_ID, OFFER_MAX_BYTES, midnightContract } from "./env.ts";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { submitBlobViaBatcher } from "./batcher-client.ts";
import { getBlankRefState, validateZswapOffer, verifyOfferCrypto } from "@zswap-da/validator";
import { eventBus, emitAppEvent, type AppEvent } from "./event-bus.ts";
import { quoteWithPrices, priceOf } from "./market-mock.ts";
import { realStats, realHistory } from "./trade-data.ts";
import { getSyncStatus } from "./sync-health.ts";
import { registerZkAssetRoutes } from "./zk-assets.ts";
import { registerDocsRoutes } from "./docs.ts";
import { offerHashFromBlob } from "./offer-hash.ts";

// ─── API Router ───────────────────────────────────────────────────────────────

type OfferLegDto = { token: string; amount: string };

export const apiRouter: StartConfigApiRouter = async function (
  server: any,
  dbConn: any,
): Promise<void> {
  // 60 requests/min per IP — applied to every route in this router.
  await server.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      error: "RATE_LIMITED",
      reason: "Too many requests — please wait before retrying.",
    }),
  });

  // The runtime installs a blanket 500 error handler; override it here so
  // request errors keep their real status. Fastify schema-validation failures
  // (error.validation) and anything carrying a 4xx statusCode (rate limit,
  // bad-request throws) must not surface as server faults.
  server.setErrorHandler((error: any, request: any, reply: any) => {
    if (error?.validation) {
      return reply
        .code(400)
        .send({ error: "VALIDATION", reason: error.message });
    }
    const status = Number(error?.statusCode);
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: error?.error ?? "BAD_REQUEST", reason: error?.message });
    }
    console.error("[API] Unhandled error:", request?.url, error);
    return reply
      .code(500)
      .send({ error: "INTERNAL", reason: error?.message ?? "Unknown error" });
  });

  // GET /keys/*, /zkir/* — ZK assets for the browser prover (the frontend now
  // lives in its own repo and fetches these from this API instead of staging
  // copies into its public/ dir).
  registerZkAssetRoutes(server);

  // GET /docs — interactive API playground (upload + accept/settle debugger).
  registerDocsRoutes(server);

  // Update pair_stats after each CONSUMED archive. The state machine fires
  // offer_consumed after the archive transaction commits; this listener keeps
  // pair_stats in sync without needing access to dbConn inside the generator.
  const onAppEvent = async (event: AppEvent) => {
    if (event.type === "offer_consumed") {
      try {
        await upsertPairStatsByOfferId.run({ offer_id: event.offerId }, dbConn);
      } catch (e) {
        console.error("[PAIR_STATS] Failed to update pair stats for offer", event.offerId, e);
      }
    }
  };
  eventBus.on("app_event", onAppEvent);

  // GET /api/zswaps — list open offers, newest first, with optional filtering
  // & keyset pagination. Deliberately does NOT include the offer blob: a
  // single blob is ~16–25 KB of bech32m, so a 100-row page would be
  // megabytes. Each row carries `offer_hash` — fetch the blob via
  // GET /api/zswaps/:hash.
  //
  // Pagination is cursor-based (`after_hash` = the previous page's
  // `next_cursor`); OFFSET is gone. Offsets cost O(offset) per page and shift
  // whenever an offer is indexed or archived mid-pagination, silently
  // skipping or repeating rows; the cursor seeks in the (created_at, id)
  // index and is immune to both. Response: { offers, next_cursor } —
  // next_cursor is null once exhausted.
  server.get("/api/zswaps", async (request: any, reply: any) => {
    const query = request?.query ?? {};

    const rawLimit = Number.parseInt((query as any).limit ?? "", 10);
    let limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    if (limit <= 0) limit = 100;
    if (limit > 100) limit = 100;

    const token = (query as any).token as string | undefined;
    const directionRaw = ((query as any).direction as string | undefined)
      ?.toUpperCase();
    const direction =
      directionRaw === "GIVING" || directionRaw === "WANTING"
        ? directionRaw
        : undefined;

    // Resolve the opaque cursor to its keyset anchor. Anything that does not
    // resolve is a caller error — a fabricated cursor would otherwise
    // silently return page one and the caller would loop forever.
    let afterCreatedAt: unknown = null;
    let afterId: number | null = null;
    const afterHash = String((query as any).after_hash ?? "").toLowerCase();
    if (afterHash) {
      if (!/^[0-9a-f]{64}$/.test(afterHash)) {
        return reply.code(400).send({
          error: "INVALID_CURSOR",
          reason: "after_hash must be 64 hex chars (a next_cursor value)",
        });
      }
      const anchor = await resolveOfferCursor.run(
        { offer_hash: afterHash },
        dbConn,
      );
      if (anchor.length === 0) {
        return reply.code(400).send({
          error: "INVALID_CURSOR",
          reason: "unknown cursor — restart pagination from the first page",
        });
      }
      afterCreatedAt = anchor[0].created_at;
      afterId = anchor[0].id;
    }

    const offers = await getOpenOffersPage.run(
      {
        token: token ?? "",
        direction: direction ?? "ANY",
        limit,
        after_created_at: afterCreatedAt as any,
        after_id: afterId,
      },
      dbConn,
    );
    if (offers.length === 0) return { offers: [], next_cursor: null };

    // One batched legs query for the whole page instead of one per offer.
    const legs = await getOfferTokensForOffers.run(
      { offer_file_ids: offers.map((o) => o.id) },
      dbConn,
    );
    const byOffer = new Map<number, { gives: OfferLegDto[]; wants: OfferLegDto[] }>();
    for (const leg of legs) {
      let entry = byOffer.get(leg.offer_file_id);
      if (!entry) {
        entry = { gives: [], wants: [] };
        byOffer.set(leg.offer_file_id, entry);
      }
      const dto = { token: leg.token_color, amount: leg.amount };
      if (leg.direction === "GIVING") entry.gives.push(dto);
      else entry.wants.push(dto);
    }

    return {
      offers: offers.map((offer) => ({
        ...offer,
        gives: byOffer.get(offer.id)?.gives ?? [],
        wants: byOffer.get(offer.id)?.wants ?? [],
      })),
      // A full page may be the last one; the follow-up fetch then returns
      // { offers: [], next_cursor: null } and the caller stops.
      next_cursor:
        offers.length === limit ? offers[offers.length - 1].offer_hash : null,
    };
  });

  // GET /api/zswaps/:hash — one offer, including its blob, by content hash
  // (hex sha256 of the raw MIP-0005 transaction bytes; the MIP-0006 offerId).
  // The hash — not the SERIAL id — is the lookup key because ids are local
  // bookkeeping: two nodes indexing the same namespace assign different ids
  // depending on ingestion order, filters, and restarts, while the content
  // hash is identical everywhere. Looks through open offers first, then
  // history, so a consumed/expired offer still resolves with its status.
  server.get("/api/zswaps/:hash", async (request: any, reply: any) => {
    const hash = String(request.params?.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply.code(400).send({
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      });
    }
    const rows = await getOfferByHash.run({ offer_hash: hash }, dbConn);
    if (rows.length === 0) {
      return reply.code(404).send({ error: "NOT_FOUND", offer_hash: hash });
    }
    const offer = rows[0];
    const live = offer.status === "open";
    const legs = await getOfferTokensAny.run(
      { offer_file_id: offer.id, live },
      dbConn,
    );
    const gives: OfferLegDto[] = [];
    const wants: OfferLegDto[] = [];
    for (const leg of legs) {
      const dto = { token: leg.token_color, amount: leg.amount };
      if (leg.direction === "GIVING") gives.push(dto);
      else wants.push(dto);
    }
    return {
      offer_hash: offer.offer_hash,
      status: offer.status,
      blob: offer.transaction_hex,
      celestia_height: offer.celestia_height,
      created_at: offer.created_at,
      metadata_created_at: offer.metadata_created_at,
      metadata_expires_at: offer.metadata_expires_at,
      metadata_maker_note: offer.metadata_maker_note,
      ttl_seconds: offer.ttl_seconds,
      gives,
      wants,
    };
  });

  // GET /api/zswaps/:hash/status — lightweight status probe by content hash.
  server.get("/api/zswaps/:hash/status", async (request: any, reply: any) => {
    const hash = String(request.params?.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply.code(400).send({
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      });
    }
    const rows = await getOfferStatusByHash.run({ offer_hash: hash }, dbConn);
    return { offer_hash: hash, status: rows[0]?.status ?? "not_found" };
  });

  server.get("/api/known-tokens", async () => {
    const result = await getKnownTokens.run(undefined, dbConn);
    return result;
  });

  // GET /api/quote — price quote for from→to backed by the token_prices DB table.
  // On first request for a token the deterministic fallback price is inserted so
  // subsequent calls are consistent and operators can override rows manually.
  // Params: from_token, to_token (hex colors), from_amount (base units),
  // optional to_amount (a user-set receive amount → discount/sponsored vs it).
  async function resolvePrice(token: string): Promise<number> {
    const rows = await getTokenPrice.run({ token_color: token }, dbConn);
    if (rows.length > 0) return Number(rows[0].price_usd);
    const fallback = priceOf(token);
    await upsertTokenPrice.run({ token_color: token, price_usd: fallback }, dbConn);
    return fallback;
  }

  const TOKEN_COLOR_RE = /^[0-9a-f]{64}$/;

  server.get("/api/quote", async (request: any, reply: any) => {
    const q = request?.query ?? {};
    const fromToken = String((q as any).from_token ?? "").toLowerCase();
    const toToken = String((q as any).to_token ?? "").toLowerCase();
    if (!TOKEN_COLOR_RE.test(fromToken) || !TOKEN_COLOR_RE.test(toToken)) {
      return reply.code(400).send({
        error: "VALIDATION",
        reason: "from_token and to_token must be 64-hex token colors",
      });
    }
    // Only quote registered tokens: quoting arbitrary colors would fabricate a
    // market rate — and persist a fallback price row — for tokens that don't exist.
    for (const color of [fromToken, toToken]) {
      const known = await getTokenByColor.run({ token_color: color }, dbConn);
      if (known.length === 0) {
        return reply
          .code(404)
          .send({ error: "UNKNOWN_TOKEN", token: color });
      }
    }
    const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
    const fromAmount = BigInt(digits((q as any).from_amount) || "0");
    const toRaw = digits((q as any).to_amount);
    const toAmount = toRaw.length ? BigInt(toRaw) : undefined;
    const [pf, pt] = await Promise.all([resolvePrice(fromToken), resolvePrice(toToken)]);
    return quoteWithPrices(fromToken, toToken, fromAmount, pf, pt, toAmount);
  });

  // GET /api/chart/{stats,history} — REAL per-pair market data derived from the
  // indexer DB: history = consumed offers (offer_file_history), stats = last/24h/
  // high/low/volume from those fills (mid of open offers as fallback).
  // Params: base, quote (hex colors).
  const readPair = (request: any): { base: string; quote: string } | null => {
    const q = request?.query ?? {};
    const base = String((q as any).base ?? "").toLowerCase();
    const quoteToken = String((q as any).quote ?? "").toLowerCase();
    if (!base || !quoteToken) return null;
    return { base, quote: quoteToken };
  };
  const PAIR_REQUIRED = {
    error: "VALIDATION",
    reason: "base and quote are required",
  };
  server.get("/api/chart/stats", async (request: any, reply: any) => {
    const pair = readPair(request);
    if (!pair) return reply.code(400).send(PAIR_REQUIRED);
    return realStats(dbConn, pair.base, pair.quote);
  });
  server.get("/api/chart/history", async (request: any, reply: any) => {
    const pair = readPair(request);
    if (!pair) return reply.code(400).send(PAIR_REQUIRED);
    return realHistory(dbConn, pair.base, pair.quote);
  });

  // POST /api/known-tokens — register a token name/color pair. The browser-wallet
  // mint path submits the contract call client-side and still needs the backend
  // DB to know the token name for indexing/display.
  server.post(
    "/api/known-tokens",
    {
      schema: {
        body: {
          type: "object",
          required: ["color", "name", "kind"],
          properties: {
            color: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: ["shielded", "unshielded"] },
          },
        },
      },
    },
    async (request: any, reply: any) => {
      if (!isTokenRegistryEnabled()) {
        return reply.code(404).send({
          error: "NOT_ENABLED",
          reason:
            "Token registry is disabled. Names here are unverified — set " +
            "ENABLE_TOKEN_REGISTRY=true for local dev / e2e only.",
        });
      }
      const color = String(request.body.color).toLowerCase().replace(/^0x/, "");
      const name = String(request.body.name).trim().toUpperCase().slice(0, 16);
      const kind = String(request.body.kind);
      if (!/^[0-9a-f]{64}$/.test(color)) {
        return reply.code(400).send({ error: "Invalid token color (expected 64 hex chars)" });
      }
      if (!name) {
        return reply.code(400).send({ error: "Invalid token name" });
      }
      if (kind !== "shielded" && kind !== "unshielded") {
        return reply.code(400).send({ error: 'Invalid kind (expected "shielded" or "unshielded")' });
      }

      const nameCheck = await checkTokenNameExists.run({ name }, dbConn);
      if (nameCheck.length > 0) {
        return reply.code(409).send({ error: `Token name "${name}" is already taken` });
      }
      const colorCheck = await getTokenByColor.run({ token_color: color }, dbConn);
      if (colorCheck.length > 0) {
        return reply.code(409).send({ error: `Token color already registered as "${colorCheck[0].name}"` });
      }

      await insertKnownToken.run({ token_color: color, name, kind }, dbConn);
      emitAppEvent({ type: "token_minted", name, color, kind });
      return { success: true, color, name, kind };
    },
  );

  // GET /api/midnight/config — expose the public Midnight config the browser
  // contract client needs (contract address, indexer, proof server). Never
  // include secrets.
  server.get("/api/midnight/config", async () => {
    const contractAddress =
      midnightContract?.contractAddress ?? process.env.MIDNIGHT_CONTRACT_ADDRESS;
    if (!contractAddress) {
      throw new Error("Midnight contract metadata is not available");
    }
    return {
      contractAddress,
      indexerUri: midnightNetworkConfig.indexer,
      indexerWsUri: midnightNetworkConfig.indexerWS,
      proofServerUri: midnightNetworkConfig.proofServer,
      networkId: midnightNetworkConfig.id,
    };
  });

  // GET /api/health/sync — per-protocol sync state (current block, tip, lag).
  // Uses effectstream.effectstream_blocks for NTP and
  // effectstream.sync_protocol_pagination for parallel chains.
  // Chain tips are fetched from the Midnight indexer / Celestia RPC and cached 60 s.
  // Exempt from the 60/min API budget — UIs poll this as a liveness probe.
  server.get("/api/health/sync", { config: { rateLimit: false } }, async () => {
    return getSyncStatus(dbConn);
  });

  // GET /api/pairs — all known trading pairs from pair_stats (historical) merged
  // with live open-offer counts. Fast: pair_stats is a write-side projection
  // updated on each CONSUMED archive; the live subquery hits a small indexed table.
  server.get("/api/pairs", async () => {
    return getPairs.run(undefined, dbConn);
  });

  // Status lookup for My Trades startup reconciliation. Returns
  // { blob, status } with status 'open' | 'completed' | 'expired' | 'not_found'.
  //
  // Always via the content hash — an indexed probe. Undecodable blobs are
  // answered WITHOUT touching the DB: they can never have been indexed
  // (ingestion requires a decodable blob), and any literal-match fallback
  // would be an unindexable ~24 KB TEXT comparison — a free table-scan DoS
  // for anyone POSTing junk.
  const statusForBlob = async (blob: string) => {
    let hash: string;
    try {
      hash = offerHashFromBlob(blob);
    } catch {
      return { blob, status: "not_found" };
    }
    const rows = await getOfferStatusByHash.run({ offer_hash: hash }, dbConn);
    if (rows.length === 0) return { blob, offer_hash: hash, status: "not_found" };
    return { blob, offer_hash: hash, status: rows[0].status };
  };

  // POST /api/zswap/status — body { blob } or { blobs: [...] }. POST because a
  // real offer blob is 16–25 KB: far beyond what proxies accept in a query
  // string (the GET variant 414s at nginx for any real offer).
  server.post(
    "/api/zswap/status",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            blob: { type: "string" },
            blobs: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
        },
      },
    },
    async (request: any, reply: any) => {
      const { blob, blobs } = request.body ?? {};
      if (typeof blob === "string" && blob.trim()) {
        return statusForBlob(blob.trim());
      }
      if (Array.isArray(blobs) && blobs.length > 0) {
        const statuses = [];
        for (const b of blobs) statuses.push(await statusForBlob(String(b).trim()));
        return { statuses };
      }
      return reply
        .code(400)
        .send({ error: "VALIDATION", reason: "provide blob or blobs[]" });
    },
  );

  // GET /api/zswap/status?blob=<bech32m> — kept for short-blob callers and
  // backward compatibility. Real offers must use the POST variant or
  // GET /api/zswaps/:hash/status.
  server.get("/api/zswap/status", async (request: any, reply: any) => {
    const blob = String((request.query as any)?.blob ?? "").trim();
    if (!blob) return reply.code(400).send({ error: "blob query param required" });
    return statusForBlob(blob);
  });

  // POST /api/zswap/submit — fully validate a `swapoffer1…` blob, then forward
  // it to Celestia DA via the batcher. We validate here so the frontend gets
  // fast, specific feedback; the batcher's validateInput hook re-validates as
  // the authoritative pre-fee gate. The frontend produces the blob via
  // OfferFiles.encode().
  server.post(
    "/api/zswap/submit",
    {
      schema: {
        body: {
          type: "object",
          required: ["blob"],
          properties: {
            blob: { type: "string" },
          },
        },
      },
    },
    async (request: any, reply: any) => {
      const { blob } = request.body;

      // Structure only — proof verification is deferred to the end of this
      // handler, after the indexed dedup/liveness probes, so a replayed or
      // stale blob never costs a `wellFormed` (the pipeline's dominant cost).
      // Same ordering as the STM; see the celestia-zswap transition.
      const validation = validateZswapOffer(blob, {
        refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
        tblock: new Date(),
        maxBytes: OFFER_MAX_BYTES,
        crypto: "defer",
      });
      if (!validation.ok) {
        return reply
          .code(400)
          .send({ error: validation.code, reason: validation.reason });
      }

      // Dedup before paying a Celestia fee (MIP-0006: duplicates SHOULD be
      // rejected). The STM would drop the replayed blob at index time anyway;
      // rejecting here saves the maker the publication cost.
      const offerHash = offerHashFromBlob(blob);
      const existing = await getOfferStatusByHash.run(
        { offer_hash: offerHash },
        dbConn,
      );
      if (existing.length > 0) {
        return reply.code(409).send({
          error: "DUPLICATE_OFFER",
          reason: `offer already indexed with status '${existing[0].status}'`,
          offer_hash: offerHash,
          status: existing[0].status,
        });
      }

      // Liveness: never pay a Celestia fee for an offer whose coins are already
      // spent on chain (it can never settle). The spent_* sets are populated by
      // the node's midnight-* sync handlers.
      for (const nullifier of validation.nullifiers ?? []) {
        const spent = await isNullifierSpent.run({ nullifier }, dbConn);
        if (spent.length > 0) {
          return reply.code(400).send({
            error: "NULLIFIER_SPENT",
            reason: `nullifier already spent: ${nullifier}`,
          });
        }
      }
      // Liveness: unshielded UTXO must exist in created_unshielded (absent = spent or never created).
      for (const s of validation.unshieldedSpends ?? []) {
        const live = await isUnshieldedCreated.run(
          { owner: s.owner, intent_hash: s.intentHash, output_no: s.outputNo },
          dbConn,
        );
        if (live.length === 0) {
          return reply.code(400).send({
            error: "UTXO_NOT_LIVE",
            reason:
              `unshielded UTXO not live (spent or never created): ${s.owner}/${s.intentHash}/${s.outputNo}`,
          });
        }
      }
      // Root-known: each shielded input must prove against a known recent root.
      for (const root of validation.inputRoots ?? []) {
        const known = await isKnownRoot.run({ root }, dbConn);
        if (known.length === 0) {
          const tip = await getSyncStatus(dbConn).catch(() => null as any);
          const rootsMeta = tip?.sets?.known_roots;
          return reply.code(400).send({
            error: "ROOT_UNKNOWN",
            reason: `input merkle root not a known recent chain root: ${root}`,
            hint:
              "Lace proved against a Merkle root this node has never synced. " +
              "Usually Lace's indexer URI differs from this node even when networkId matches " +
              `(node networkId=${MIDNIGHT_NETWORK_ID}, indexer=${midnightNetworkConfig.indexer}). ` +
              "In Lace → undeployed, set indexer to this node's indexer, mint there, rebuild the offer. " +
              "Retrying the same blob will not help if the root is foreign.",
            diagnostics: {
              offerRoot: root,
              nodeNetworkId: MIDNIGHT_NETWORK_ID,
              nodeIndexerUri: midnightNetworkConfig.indexer,
              knownRootsTotal: rootsMeta?.total ?? null,
              knownRootsLatestHeight: rootsMeta?.latest_height ?? null,
              midnightTip: tip?.midnight?.tip ?? null,
              midnightSynced: tip?.midnight?.current ?? null,
            },
          });
        }
      }

      // Cryptographic verification — last and mandatory. Everything above read
      // claimed data out of an unverified transaction; nothing is forwarded to
      // the batcher (and so to a paid Celestia post) without this.
      const crypto = verifyOfferCrypto(validation.tx!, {
        refState: getBlankRefState(MIDNIGHT_NETWORK_ID),
        tblock: new Date(),
      });
      if (!crypto.ok) {
        return reply.code(400).send({ error: crypto.code, reason: crypto.reason });
      }

      const result = await submitBlobViaBatcher(blob);
      // offer_hash is how the maker tracks this offer from now on:
      // GET /api/zswaps/:hash once indexed.
      return { success: true, offer_hash: offerHash, blob, result };
    },
  );

  // GET /api/events — Server-Sent Events stream for real-time offer lifecycle updates
  server.get("/api/events", async (request: any, reply: any) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const send = (data: object) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };

    send({ type: "connected", timestamp: Date.now() });

    const listener = (event: object) => send({ ...event, timestamp: Date.now() });
    eventBus.on("app_event", listener);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(": heartbeat\n\n"); } catch { /* noop */ }
    }, 30_000);

    request.raw.on("close", () => {
      eventBus.off("app_event", listener);
      clearInterval(heartbeat);
    });

    // Keep connection open — never resolve
    await new Promise(() => {});
  });
};
