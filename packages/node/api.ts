import type { StartConfigApiRouter } from "@effectstream/runtime";
import rateLimit from "@fastify/rate-limit";

import {
  getKnownTokens,
  insertKnownToken,
  isNullifierSpent,
  isUnshieldedCreated,
  isKnownRootLive,
  getLatestEffectstreamBlock,
  getTokenPrice,
  upsertTokenPrice,
  checkTokenNameExists,
  getTokenByColor,
  getPairs,
  upsertPairStatsByOfferId,
  getOpenOffersPage,
  getOfferTokensForOffers,
  getOfferNullifiersForOffers,
  getOfferByHash,
  getOfferStatusByHash,
  getOfferTokensAny,
  resolveOfferCursor,
} from "@zswap-da/database";

import { isTokenRegistryEnabled, MIDNIGHT_NETWORK_ID, OFFER_MAX_BYTES, ROOT_WINDOW_SECONDS, midnightContract } from "./env.ts";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { submitBlobViaBatcher } from "./batcher-client.ts";
import { getBlankRefState, validateZswapOffer, verifyOfferCrypto } from "@zswap-da/validator";
import { eventBus, emitAppEvent, markBlockCommitted, type AppEvent } from "./event-bus.ts";
import { quoteWithPrices, priceOf } from "./market-mock.ts";
import { realStats, realHistory } from "./trade-data.ts";
import { getSyncStatus } from "./sync-health.ts";
import { registerZkAssetRoutes } from "./zk-assets.ts";
import { registerDocsRoutes } from "./docs.ts";
import { offerHashFromBlob } from "./offer-hash.ts";

// ─── API Router ───────────────────────────────────────────────────────────────

// MIP-0006 TokenLeg: { token, amount, type } — camelCase, `type` is the
// value layer. Our DB column is `kind`; the wire name is the MIP's.
type TokenLegDto = { token: string; amount: string; type: string };

export const apiRouter: StartConfigApiRouter = async function (
  server: any,
  dbConn: any,
): Promise<void> {
  // 60 requests/min per IP — applied to every route in this router.
  //
  // `statusCode` is load-bearing, not decoration: @fastify/rate-limit THROWS
  // whatever this builder returns (`throw params.errorResponseBuilder(...)`),
  // and our setErrorHandler below routes on `error.statusCode`. Omitting it
  // made every throttled request answer `500 INTERNAL` instead of 429 — the
  // limiter counted correctly and set the x-ratelimit-* headers, but told
  // clients "server fault" instead of "back off", so no caller could throttle
  // itself. Verified: 90 requests gave {200:56, 500:34}.
  await server.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
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

  // Drive the event gate from THIS pool — the whole point is that it is not
  // the connection running the block transaction. The runtime writes the block
  // record inside that transaction, so a height visible here proves its COMMIT
  // returned, which is what releases the events buffered for it (event-bus.ts).
  // Without this poll nothing is ever published; with it, nothing is published
  // early. 1 s against a ~1 s block time — a tick of latency, never a lost
  // event, since the buffer holds until the height is seen.
  const gatePoll = setInterval(() => {
    void getLatestEffectstreamBlock
      .run(undefined, dbConn)
      .then((rows) => {
        const h = rows[0]?.block_height;
        if (h != null) markBlockCommitted(h as any);
      })
      .catch(() => { /* transient; the next tick retries and the buffer waits */ });
  }, 1000);
  (gatePoll as any).unref?.();
  server.addHook("onClose", async () => clearInterval(gatePoll));

  // Update pair_stats after each CONSUMED archive. The event is released only
  // after its block commits (see the gate above), so this listener's SEPARATE
  // pool is guaranteed to see the archive and the same-block create rows.
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

  // GET /v1/offers — list open offers, newest first, with optional filtering
  // & keyset pagination. Deliberately does NOT include the offer blob: a
  // single blob is ~16–25 KB of bech32m, so a 100-row page would be
  // megabytes. Each row carries `offer_hash` — fetch the blob via
  // GET /v1/offers/:hash.
  //
  // Pagination is cursor-based (`after_hash` = the previous page's
  // `next_cursor`); OFFSET is gone. Offsets cost O(offset) per page and shift
  // whenever an offer is indexed or archived mid-pagination, silently
  // skipping or repeating rows; the cursor seeks in the (created_at, id)
  // index and is immune to both. Response: { offers, next_cursor } —
  // next_cursor is null once exhausted.
  server.get("/v1/offers", async (request: any, reply: any) => {
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
    let afterHeight: string | null = null;
    let afterAnchorHash: string | null = null;
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
      afterHeight = String(anchor[0].celestia_height);
      afterAnchorHash = anchor[0].offer_hash;
    }

    const offers = await getOpenOffersPage.run(
      {
        token: token ?? "",
        direction: direction ?? "ANY",
        limit,
        after_height: afterHeight,
        after_hash: afterAnchorHash,
      },
      dbConn,
    );
    if (offers.length === 0) return { offers: [], nextCursor: null };

    // One batched legs query for the whole page instead of one per offer.
    const legs = await getOfferTokensForOffers.run(
      { offer_file_ids: offers.map((o) => o.id) },
      dbConn,
    );
    const byOffer = new Map<number, { gives: TokenLegDto[]; wants: TokenLegDto[] }>();
    for (const leg of legs) {
      let entry = byOffer.get(leg.offer_file_id);
      if (!entry) {
        entry = { gives: [], wants: [] };
        byOffer.set(leg.offer_file_id, entry);
      }
      const dto = { token: leg.token_color, amount: leg.amount, type: leg.kind };
      if (leg.direction === "GIVING") entry.gives.push(dto);
      else entry.wants.push(dto);
    }

    // MIP-0006 OffchainOfferPayload per row, with `offerBech32` OMITTED:
    // the spec's presence rule is "at least one of offerId/offerBech32", and
    // lists SHOULD serve the id — a real offer's string is 16–25 KB, so a
    // 100-row page carrying strings is megabytes of redundant payload when
    // each offer is individually retrievable by id. Fetch the string via
    // GET /v1/offers/:offerId.
    const nullifiers = await getOfferNullifiersForOffers.run(
      { offer_file_ids: offers.map((o) => o.id), live: true },
      dbConn,
    );
    const nullifiersByOffer = new Map<number, string[]>();
    for (const row of nullifiers) {
      const list = nullifiersByOffer.get(row.offer_file_id) ?? [];
      list.push(row.nullifier);
      nullifiersByOffer.set(row.offer_file_id, list);
    }

    return {
      offers: offers.map((offer) => ({
        version: 1 as const,
        offerId: offer.offer_hash,
        // offerBech32 omitted — see above; blobChars sizes the fetch.
        blobChars: offer.blob_chars,
        // The effectstream (L2) block that indexed this offer — NOT a Celestia
        // height. The Celestia inclusion height is dropped one layer above us,
        // at the primitive boundary; see ISSUES.md.
        blockHeight: offer.celestia_height,
        computed: {
          gives: byOffer.get(offer.id)?.gives ?? [],
          wants: byOffer.get(offer.id)?.wants ?? [],
          expiresAt: offer.metadata_expires_at,
          inputNullifiers: nullifiersByOffer.get(offer.id) ?? [],
          firstSeenAt: offer.first_seen_at,
          status: "live" as const,
        },
      })),
      // A full page may be the last one; the follow-up fetch then returns
      // { offers: [], nextCursor: null } and the caller stops.
      nextCursor:
        offers.length === limit ? offers[offers.length - 1].offer_hash : null,
    };
  });

  // GET /v1/offers/:hash — one offer, including its blob, by content hash
  // (hex sha256 of the raw MIP-0005 transaction bytes; the MIP-0006 offerId).
  // The hash — not the SERIAL id — is the lookup key because ids are local
  // bookkeeping: two nodes indexing the same namespace assign different ids
  // depending on ingestion order, filters, and restarts, while the content
  // hash is identical everywhere. Looks through open offers first, then
  // history, so a consumed/expired offer still resolves with its status.
  server.get("/v1/offers/:hash", async (request: any, reply: any) => {
    const hash = String(request.params?.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply.code(400).send({
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      });
    }
    const rows = await getOfferByHash.run({ offer_hash: hash }, dbConn);
    if (rows.length === 0) {
      return reply.code(404).send({ error: "NOT_FOUND", offerId: hash });
    }
    const offer = rows[0];
    const live = offer.status === "live";
    const legs = await getOfferTokensAny.run(
      { offer_file_id: offer.id, live },
      dbConn,
    );
    const gives: TokenLegDto[] = [];
    const wants: TokenLegDto[] = [];
    for (const leg of legs) {
      const dto = { token: leg.token_color, amount: leg.amount, type: leg.kind };
      if (leg.direction === "GIVING") gives.push(dto);
      else wants.push(dto);
    }
    // Single-offer response: the MIP requires offerBech32 here.
    const offerNullifiers = await getOfferNullifiersForOffers.run(
      { offer_file_ids: [offer.id], live },
      dbConn,
    );
    return {
      version: 1 as const,
      offerId: offer.offer_hash,
      offerBech32: offer.transaction_hex,
      // effectstream (L2) block height — see the note on the list route.
      blockHeight: offer.celestia_height,
      ttlSeconds: offer.ttl_seconds,
      computed: {
        gives,
        wants,
        expiresAt: offer.metadata_expires_at,
        inputNullifiers: offerNullifiers.map((n) => n.nullifier),
        firstSeenAt: offer.first_seen_at,
        status: offer.status,
      },
    };
  });

  // GET /v1/offers/:hash/status — lightweight status probe by content hash.
  server.get("/v1/offers/:hash/status", async (request: any, reply: any) => {
    const hash = String(request.params?.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply.code(400).send({
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      });
    }
    const rows = await getOfferStatusByHash.run({ offer_hash: hash }, dbConn);
    return { offerId: hash, status: rows[0]?.status ?? "not_found" };
  });

  server.get("/v1/known-tokens", async () => {
    const result = await getKnownTokens.run(undefined, dbConn);
    return result;
  });

  // GET /v1/quote — price quote for from→to backed by the token_prices DB table.
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

  server.get("/v1/quote", async (request: any, reply: any) => {
    const q = request?.query ?? {};
    const fromToken = String((q as any).from_token ?? "").toLowerCase();
    const toToken = String((q as any).to_token ?? "").toLowerCase();
    if (!TOKEN_COLOR_RE.test(fromToken) || !TOKEN_COLOR_RE.test(toToken)) {
      return reply.code(400).send({
        error: "VALIDATION",
        reason: "from_token and to_token must be 64-hex token colors",
      });
    }
    // DEMO FALLBACK — unknown tokens quote at $1 (so two unknowns are 1:1).
    // This endpoint used to 404 UNKNOWN_TOKEN for unregistered colors, on the
    // principle that quoting arbitrary colors fabricates a market rate. That
    // principle stands, but there is no token-tracking story yet and the 404
    // walls off the demo, so unknowns get a neutral price INSTEAD of an
    // error: loudly logged, never persisted to token_prices (a later
    // registration starts from the real fallback, not a squatted $1 row).
    // TODO(token-registry): remove once tokens are chain-derived — the
    // Midnight:TokenMint primitive can maintain a verified color→contract
    // registry; see PLAN "TokenMint" note.
    const unknownTokens: string[] = [];
    for (const color of [fromToken, toToken]) {
      const known = await getTokenByColor.run({ token_color: color }, dbConn);
      if (known.length === 0) unknownTokens.push(color);
    }
    if (unknownTokens.length > 0) {
      console.error(
        `[QUOTE] ⚠️  UNKNOWN_TOKEN — serving 1:1 demo fallback (price=$1, not persisted). ` +
          `No token-tracking solution yet; fix before any real pricing. Tokens: ${unknownTokens.join(", ")}`,
      );
    }
    const digits = (v: unknown) => String(v ?? "").replace(/[^0-9]/g, "");
    const fromAmount = BigInt(digits((q as any).from_amount) || "0");
    const toRaw = digits((q as any).to_amount);
    const toAmount = toRaw.length ? BigInt(toRaw) : undefined;
    const priceFor = (color: string) =>
      unknownTokens.includes(color) ? Promise.resolve(1) : resolvePrice(color);
    const [pf, pt] = await Promise.all([priceFor(fromToken), priceFor(toToken)]);
    return quoteWithPrices(fromToken, toToken, fromAmount, pf, pt, toAmount);
  });

  // GET /v1/chart/{stats,history} — REAL per-pair market data derived from the
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
  server.get("/v1/chart/stats", async (request: any, reply: any) => {
    const pair = readPair(request);
    if (!pair) return reply.code(400).send(PAIR_REQUIRED);
    return realStats(dbConn, pair.base, pair.quote);
  });
  server.get("/v1/chart/history", async (request: any, reply: any) => {
    const pair = readPair(request);
    if (!pair) return reply.code(400).send(PAIR_REQUIRED);
    return realHistory(dbConn, pair.base, pair.quote);
  });

  // POST /v1/known-tokens — register a token name/color pair. The browser-wallet
  // mint path submits the contract call client-side and still needs the backend
  // DB to know the token name for indexing/display.
  server.post(
    "/v1/known-tokens",
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

  // GET /v1/midnight/config — expose the public Midnight config the browser
  // contract client needs (contract address, indexer, proof server). Never
  // include secrets.
  server.get("/v1/midnight/config", async () => {
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

  // GET /v1/health/sync — per-protocol sync state (current block, tip, lag).
  // Uses effectstream.effectstream_blocks for NTP and
  // effectstream.sync_protocol_pagination for parallel chains.
  // Chain tips are fetched from the Midnight indexer / Celestia RPC and cached 60 s.
  // Exempt from the 60/min API budget — UIs poll this as a liveness probe.
  server.get("/v1/health/sync", { config: { rateLimit: false } }, async () => {
    return getSyncStatus(dbConn);
  });

  // GET /v1/health — MIP-0006 indexer liveness. Lightweight {status,synced}
  // derived from the sync state; /v1/health/sync is the detailed extension.
  server.get("/v1/health", { config: { rateLimit: false } }, async () => {
    const sync = await getSyncStatus(dbConn).catch(() => null as any);
    return { status: sync?.status ?? "error", synced: sync?.status === "ok" };
  });

  // GET /v1/pairs — all known trading pairs from pair_stats (historical) merged
  // with live open-offer counts. Fast: pair_stats is a write-side projection
  // updated on each CONSUMED archive; the live subquery hits a small indexed table.
  server.get("/v1/pairs", async () => {
    return getPairs.run(undefined, dbConn);
  });

  // Status lookup for My Trades startup reconciliation. Returns
  // { offer, status } with status 'live' | 'consumed' | 'cancelled' | 'expired' | 'not_found'.
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
      return { status: "not_found" };
    }
    const rows = await getOfferStatusByHash.run({ offer_hash: hash }, dbConn);
    if (rows.length === 0) return { offerId: hash, status: "not_found" };
    return { offerId: hash, status: rows[0].status };
  };

  // POST /v1/offers/status — status by bech32m string: body { offer } or
  // { offers: [...] }. POST because a real offer is 16–25 KB, far beyond what
  // proxies accept in a query string. Prefer GET /v1/offers/:hash/status when
  // the content hash is known.
  server.post(
    "/v1/offers/status",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            offer: { type: "string" },
            offers: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
        },
      },
    },
    async (request: any, reply: any) => {
      const { offer, offers } = request.body ?? {};
      if (typeof offer === "string" && offer.trim()) {
        return statusForBlob(offer.trim());
      }
      if (Array.isArray(offers) && offers.length > 0) {
        const statuses = [];
        for (const b of offers) statuses.push(await statusForBlob(String(b).trim()));
        return { statuses };
      }
      return reply
        .code(400)
        .send({ error: "VALIDATION", reason: "provide offer or offers[]" });
    },
  );

  // POST /v1/offers — fully validate a `swapoffer1…` blob, then forward
  // it to Celestia DA via the batcher. We validate here so the frontend gets
  // fast, specific feedback; the batcher's validateInput hook re-validates as
  // the authoritative pre-fee gate. The frontend produces the blob via
  // OfferFiles.encode().
  server.post(
    "/v1/offers",
    {
      // Fastify's default bodyLimit is 1 MiB, but OFFER_MAX_BYTES is 1 MiB
      // DECODED and bech32m inflates the wire form ~1.6x — so every blob big
      // enough to earn `TOO_LARGE` was answered `413 BAD_REQUEST` by the HTTP
      // layer before the validator ever saw it, making the documented code
      // unreachable over HTTP (it could still fire on the Celestia path).
      // Sized so the validator owns the verdict: bech32m overhead (~1.6x) plus
      // JSON envelope, with a hard ceiling still well below anything that
      // could exhaust memory. Blobs past THIS are still 413 — that is the
      // transport refusing to buffer, which is the right layer for it.
      bodyLimit: Math.ceil(OFFER_MAX_BYTES * 2),
      schema: {
        body: {
          type: "object",
          required: ["offer"],
          properties: {
            offer: { type: "string" }, // MIP-0005 bech32m swapoffer1… string
          },
        },
      },
    },
    async (request: any, reply: any) => {
      const { offer: blob } = request.body;

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
      //
      // DEDUP IS BYTE-IDENTICAL, DELIBERATELY. Ruled 2026-08-12.
      //
      // The same intent can be wrapped in two transactions at different segment
      // keys (Transaction.fromParts pins segment 1, fromPartsRandomized picks
      // another). Same spends, same payouts, different bytes, therefore a
      // different offer_hash — so this check does not relate them, and no
      // intent-level dedup is planned. Fixtures exist that demonstrate the pair
      // (same-intent-wrapper-a/b in @zswap-da/validator's shapes testkit).
      //
      // The reason not to chase it is economic, not technical: publishing costs
      // a real Celestia fee, paid per blob. Flooding the namespace with
      // re-wrapped copies of one intent is an attack the attacker funds, and
      // each copy still has to survive the full ladder and settle against the
      // same inputs — the first settlement spends them and the rest become
      // unfillable. Content addressing on raw bytes stays simple, cheap and
      // deterministic across replicas; an intent-level rule would need a
      // canonical form for "the same intent" that the wire does not define.
      //
      // Revisit only if publication ever becomes free or subsidised.
      const offerHash = offerHashFromBlob(blob);
      const existing = await getOfferStatusByHash.run(
        { offer_hash: offerHash },
        dbConn,
      );
      if (existing.length > 0) {
        return reply.code(409).send({
          error: "DUPLICATE_OFFER",
          reason: `offer already indexed with status '${existing[0].status}'`,
          offerId: offerHash,
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
      // Root-known: each shielded input must prove against a known recent
      // root, with the window enforced at read time. The cutoff is derived
      // from the latest PROCESSED block's timestamp — the same L2 clock that
      // stamps known_roots.last_seen_ms — never from the wall clock, and never
      // from MAX(last_seen_ms) (which stops advancing exactly when the window
      // needs to close). isKnownRootLive keeps the newest root valid
      // regardless of age, mirroring the ledger's past_roots re-insertion.
      const latestBlock = (await getLatestEffectstreamBlock.run(undefined, dbConn))[0];
      const chainNowMs = latestBlock ? Number(latestBlock.ms_timestamp) : 0;
      for (const root of validation.inputRoots ?? []) {
        const known = await isKnownRootLive.run(
          { root, cutoff_ms: chainNowMs - ROOT_WINDOW_SECONDS * 1000 },
          dbConn,
        );
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
      // GET /v1/offers/:hash once indexed.
      return { success: true, offerId: offerHash, result };
    },
  );

  // GET /v1/offers/stream — Server-Sent Events stream for real-time offer lifecycle updates
  server.get("/v1/offers/stream", async (request: any, reply: any) => {
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
