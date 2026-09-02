import type { StartConfigApiRouter } from "@effectstream/runtime";
import rateLimit from "@fastify/rate-limit";

import {
  getKnownTokens,
  insertKnownToken,
  getLatestEffectstreamBlock,
  getTokenPrice,
  upsertTokenPrice,
  checkTokenNameExists,
  getTokenByColor,
  getPairs,
  adjudicateOfferFill,
  findUnadjudicatedFills,
  getOpenOffersPage,
  getOfferTokensForOffers,
  getOfferNullifiersForOffers,
  getOfferByHash,
  getOfferStatusByHash,
  getOfferTokensAny,
  resolveOfferCursor,
  findActiveOfferByCommitment,
  findActiveOfferByUnshieldedOutput,
} from "@zswap-da/database";

import {
  apiRateLimitAllowList,
  apiRateLimitMax,
  apiSseMaxConnections,
  apiUpdatesMaxConnections,
  isEventGatePollEnabled,
  isTokenRegistryEnabled,
  MIDNIGHT_NETWORK_ID,
  OFFER_MAX_BYTES,
  ROOT_WINDOW_SECONDS,
  midnightContract,
} from "./env.ts";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { submitBlobViaBatcher } from "./batcher-client.ts";
import { getBlankRefState, validateZswapOffer, verifyOfferCrypto } from "@zswap-da/validator";
import {
  eventBus,
  emitAppEvent,
  markBlockCommitted,
  type AppEvent,
} from "./event-bus.ts";
import { quoteWithPrices, priceOf } from "./market-mock.ts";
import { realStats, realHistory } from "./trade-data.ts";
import { getSyncStatus } from "./sync-health.ts";
import { evaluateOfferLivenessFromDatabase } from "./offer-liveness.ts";
import { registerExactFilesRoute } from "./offer-files-read.ts";
import { registerOfferConsumptionRoute } from "./offer-consumption-read.ts";
import { registerOfferUpdatesStream } from "./offer-updates-stream.ts";
import { registerZkAssetRoutes } from "./zk-assets.ts";
import { registerDocsRoutes } from "./docs.ts";
import { offerHashFromBlob } from "./offer-hash.ts";
import { declaredMarkers, duplicateMarkerReason, DUPLICATE_MARKERS } from "./marker-dedup.ts";

// ─── API Router ───────────────────────────────────────────────────────────────

// MIP-0006 TokenLeg: { token, amount, type } — camelCase, `type` is the
// value layer. Our DB column is `kind`; the wire name is the MIP's.
type TokenLegDto = { token: string; amount: string; type: string };

/** Write one SSE frame without retaining an unbounded slow-client buffer. */
export function writeSseChunk(
  raw: any,
  chunk: string,
  cleanup: () => void,
): boolean {
  if (raw.destroyed || raw.writableEnded) {
    cleanup();
    return false;
  }
  try {
    if (raw.write(chunk) === true) return true;
  } catch {
    // Treat write failures exactly like response close.
  }
  // ServerResponse.write() returning false means the per-client buffer crossed
  // its high-water mark. SSE has no replay cursor here, so retaining arbitrary
  // event data is both misleading and a public memory-DoS primitive. Clients
  // reconnect after the socket closes and refresh state from GET /v1/offers.
  try { raw.destroy(); } catch { /* already closed */ }
  cleanup();
  return false;
}

export const apiRouter: StartConfigApiRouter = async function (
  server: any,
  dbConn: any,
): Promise<void> {
  // Per-IP request budget (default 60/min) — applied to every route in this
  // router.
  //
  // `statusCode` is load-bearing, not decoration: @fastify/rate-limit THROWS
  // whatever this builder returns (`throw params.errorResponseBuilder(...)`),
  // and our setErrorHandler below routes on `error.statusCode`. Omitting it
  // made every throttled request answer `500 INTERNAL` instead of 429 — the
  // limiter counted correctly and set the x-ratelimit-* headers, but told
  // clients "server fault" instead of "back off", so no caller could throttle
  // itself. Verified: 90 requests gave {200:56, 500:34}.
  await server.register(rateLimit, {
    max: apiRateLimitMax(),
    allowList: apiRateLimitAllowList(),
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
      const isExactFilesRead = String(request?.url ?? "").split("?", 1)[0] ===
        "/v1/offers/files";
      if (status === 413 && isExactFilesRead) {
        return reply.code(413).send({
          error: "TOO_LARGE",
          reason: "request body exceeds the configured transport limit",
        });
      }
      if (status === 415 && isExactFilesRead) {
        return reply.code(400).send({
          error: "VALIDATION",
          reason: "exact-files reads require application/json",
        });
      }
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

  // Side-effect-free exact-files read. Registration happens after the
  // router-wide limiter and before the submission route; it shares the
  // canonical validation/liveness primitives but never calls the batcher.
  registerExactFilesRoute(server, dbConn);

  // Strict RF2 settlement authority. This is a SELECT-only read and returns
  // inner-ledger evidence only when every shielded marker agrees.
  registerOfferConsumptionRoute(server, dbConn);

  // GET /v1/offers/updates — the client-initiated websocket update stream.
  // Same lifecycle events as the SSE route below, plus a per-subscription
  // sequence number so a consumer mirroring the book can prove it missed
  // nothing. It lives on the HTTP server's `upgrade` event, not on a route.
  registerOfferUpdatesStream(server, dbConn);

  // Drive the event gate from THIS pool — the whole point is that it is not
  // the connection running the block transaction. The runtime writes the block
  // record inside that transaction, so a height visible here proves its COMMIT
  // returned, which is what releases the events buffered for it (event-bus.ts).
  // Without this poll nothing is ever published; with it, nothing is published
  // early. 1 s against a ~1 s block time — a tick of latency, never a lost
  // event, since the buffer holds until the height is seen.
  const gatePoll = isEventGatePollEnabled()
    ? setInterval(() => {
      void getLatestEffectstreamBlock
        .run(undefined, dbConn)
        .then((rows) => {
          const h = rows[0]?.block_height;
          if (h != null) markBlockCommitted(h as any);
        })
        .catch(() => { /* transient; the next tick retries and the buffer waits */ });
    }, 1000)
    : null;
  if (gatePoll !== null) (gatePoll as any).unref?.();
  server.addHook("onClose", async () => {
    if (gatePoll !== null) clearInterval(gatePoll);
  });

  // Adjudicate the fill verdict after each CONSUMED archive. The event is
  // released only after its block commits (see the gate above), so this
  // listener's SEPARATE pool is guaranteed to see the archive and the
  // same-block create rows — which is exactly what the verdict depends on.
  //
  // This used to increment pair_stats. The difference that matters is not the
  // shape of the write but its recoverability: an increment lost to the catch
  // below was permanent drift with nothing recording that it was owed, whereas
  // a missing verdict leaves `settled IS NULL` and the sweep below finds it.
  const onAppEvent = async (event: AppEvent) => {
    if (event.type === "offer_consumed") {
      try {
        await adjudicateOfferFill.run({ offer_id: event.offerId }, dbConn);
      } catch (e) {
        // Deliberately not fatal, and deliberately not the only line of
        // defence: the sweep repairs whatever this drops.
        console.error("[FILL] Failed to adjudicate offer", event.offerId, e);
      }
    }
  };
  eventBus.on("app_event", onAppEvent);
  const sseMaxConnections = apiSseMaxConnections();
  // The emitter warning threshold should reflect the explicit connection caps
  // of BOTH event transports (SSE responses and websocket subscriptions), plus
  // non-stream projection listeners. The caps, not EventEmitter warnings, are
  // the resource boundary. One owner raises and restores this so the two
  // transports cannot fight over the threshold at shutdown.
  const priorEventBusMaxListeners = eventBus.getMaxListeners();
  eventBus.setMaxListeners(
    Math.max(priorEventBusMaxListeners, sseMaxConnections + apiUpdatesMaxConnections() + 10),
  );
  let activeSseConnections = 0;
  const activeSseResponses = new Set<any>();
  // Fastify's preClose hook runs before it waits for active requests. Without
  // this, persistent streams can prevent server.close() from settling.
  server.addHook("preClose", async () => {
    for (const raw of activeSseResponses) {
      try { raw.destroy(); } catch { /* already closed */ }
    }
  });
  server.addHook("onClose", async () => {
    eventBus.off("app_event", onAppEvent);
    eventBus.setMaxListeners(priorEventBusMaxListeners);
  });

  // The repair sweep. Every archived CONSUMED offer owes exactly one verdict;
  // this finds the ones that never got it — a crash between COMMIT and the
  // listener, a transient error above, or a block processed before this
  // process started — and adjudicates them.
  //
  // It is cheap because of the partial index on (archive_reason = 'CONSUMED'
  // AND settled IS NULL): it costs O(missing), not O(history), so it can run
  // on a short interval without being a load source. An unadjudicated offer is
  // ABSENT from market data until repaired, never counted as a cancel.
  const fillSweep = setInterval(() => {
    void (async () => {
      try {
        const owed = await findUnadjudicatedFills.run({ limit: 200 }, dbConn);
        for (const row of owed) {
          await adjudicateOfferFill.run({ offer_id: row.id }, dbConn);
        }
        if (owed.length > 0) {
          console.log(`[FILL] Repaired ${owed.length} unadjudicated fill(s)`);
        }
      } catch {
        /* transient; the next tick retries — the rows stay marked as owed */
      }
    })();
  }, 15_000);
  (fillSweep as any).unref?.();
  server.addHook("onClose", async () => clearInterval(fillSweep));

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
  const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,77})$/; // bounded above by u256
  const MAX_AMOUNT = (1n << 256n) - 1n;

  const parseQuoteAmount = (value: unknown): bigint | null => {
    if (typeof value !== "string" || !AMOUNT_RE.test(value)) return null;
    const amount = BigInt(value);
    return amount <= MAX_AMOUNT ? amount : null;
  };

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
    if (fromToken === toToken) {
      return reply.code(400).send({
        error: "VALIDATION",
        reason: "from_token and to_token must be distinct",
      });
    }
    const fromAmount = parseQuoteAmount((q as any).from_amount);
    if (fromAmount === null || fromAmount <= 0n) {
      return reply.code(400).send({
        error: "VALIDATION",
        reason: "from_amount must be a positive canonical decimal integer no larger than u256",
      });
    }
    const hasToAmount = (q as any).to_amount !== undefined;
    const parsedToAmount = hasToAmount ? parseQuoteAmount((q as any).to_amount) : undefined;
    if (hasToAmount && parsedToAmount === null) {
      return reply.code(400).send({
        error: "VALIDATION",
        reason: "to_amount must be a canonical decimal integer no larger than u256",
      });
    }
    const toAmount: bigint | undefined = parsedToAmount ?? undefined;

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
    const priceFor = (color: string) =>
      unknownTokens.includes(color) ? Promise.resolve(1) : resolvePrice(color);
    const [pf, pt] = await Promise.all([priceFor(fromToken), priceFor(toToken)]);

    // Quotes come from the token-price table (or the demo fallback) only. The
    // backend deliberately holds NO solver state: solver-posted ladders used to
    // take precedence here through a registry this node maintained, which made
    // the indexer a quote venue for one class of client. Under the confirmed
    // architecture the COW solver pushes its ladders to the Midnight Intents
    // relay and the relay does the interpolation, so this backend keeps a
    // single, client-agnostic price source.
    return {
      ...quoteWithPrices(fromToken, toToken, fromAmount, pf, pt, toAmount),
      source: unknownTokens.length > 0 ? "demo-fallback" : "token-prices",
    };
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
  // { offer, status } with status live/consumed/cancelled/expired/unknown/not_found.
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

      // Dedup rule (i) — BYTE-IDENTICAL, before paying a Celestia fee
      // (MIP-0006: duplicates SHOULD be rejected). The STM would drop the
      // replayed blob at index time anyway; rejecting here saves the maker the
      // publication cost.
      //
      // Ruled 2026-08-12 as the ONLY dedup rule, on the reasoning that
      // re-wrapping one intent costs a Celestia fee per copy and copies compete
      // for the same inputs. SUPERSEDED 2026-08-18 by measurement: markers are
      // root-independent (`coin.rs:626`), so re-proving one offer against a
      // fresh root in the root window yields a byte-different blob with a new
      // offer_hash and IDENTICAL markers — evasion at the price of one proof,
      // and the copies then coexist in the book rather than competing.
      //
      // So this rule stays exactly as it is, and stays FIRST — one indexed
      // probe on a hash already computed, against the cheapest attack there is
      // — and rule (ii), marker dedup, runs after crypto below.
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

      // Indexed liveness uses the same ordered descriptors and normalized
      // reasons as STM ingestion and the future validate-for-use route. The
      // root clock remains API-specific: latest PROCESSED Effectstream block,
      // never wall time or MAX(last_seen_ms). It is resolved lazily only after
      // nullifier and UTXO probes pass.
      const liveness = await evaluateOfferLivenessFromDatabase(
        validation,
        dbConn,
        {
          getRootCutoffMs: async () => {
            const latestBlock = (await getLatestEffectstreamBlock.run(
              undefined,
              dbConn,
            ))[0];
            const chainNowMs = latestBlock ? Number(latestBlock.ms_timestamp) : 0;
            return chainNowMs - ROOT_WINDOW_SECONDS * 1000;
          },
        },
      );
      if (!liveness.ok) {
        if (liveness.descriptor.kind === "root") {
          const root = liveness.descriptor.root;
          const tip = await getSyncStatus(dbConn).catch(() => null as any);
          const rootsMeta = tip?.sets?.known_roots;
          return reply.code(400).send({
            error: liveness.code,
            reason: liveness.reason,
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
        return reply.code(400).send({
          error: liveness.code,
          reason: liveness.reason,
        });
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

      // Dedup rule (ii) — MARKER OVERLAP, and it must run HERE: after crypto,
      // before the side effect. The full rule, the after-crypto security
      // argument and the first-wins ordering are in marker-dedup.ts; this is
      // the API half of the one predicate, and the STM half in
      // state-machine.ts asks the same two queries in the same order.
      //
      // Same door behaviour as DUPLICATE_OFFER (409) under its own code, so a
      // client can tell a replay from an evasion without parsing prose.
      for (const marker of declaredMarkers(validation.tx!)) {
        const claimed = marker.kind === "commitment"
          ? await findActiveOfferByCommitment.run({ commitment: marker.commitment }, dbConn)
          : await findActiveOfferByUnshieldedOutput.run(
              { owner: marker.owner, intent_hash: marker.intentHash, output_no: marker.outputNo },
              dbConn,
            );
        if (claimed.length > 0) {
          return reply.code(409).send({
            error: DUPLICATE_MARKERS,
            reason: duplicateMarkerReason(marker, claimed[0]!.offer_hash),
            offerId: offerHash,
            activeOfferId: claimed[0]!.offer_hash,
          });
        }
      }

      const result = await submitBlobViaBatcher(blob);
      // offer_hash is how the maker tracks this offer from now on:
      // GET /v1/offers/:hash once indexed.
      return { success: true, offerId: offerHash, result };
    },
  );

  // GET /v1/offers/stream — Server-Sent Events stream for real-time offer lifecycle updates
  server.get("/v1/offers/stream", async (request: any, reply: any) => {
    if (activeSseConnections >= sseMaxConnections) {
      return reply
        .header("Retry-After", "5")
        .code(503)
        .send({
          error: "SSE_CAPACITY",
          reason: "Too many active event streams; retry with backoff.",
        });
    }

    const raw = reply.raw;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let listenerRegistered = false;
    let cleaned = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const listener = (event: object) => {
      writeSseChunk(raw, `data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`, cleanup);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      raw.off("close", cleanup);
      request.raw.off("aborted", cleanup);
      if (listenerRegistered) eventBus.off("app_event", listener);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      activeSseResponses.delete(raw);
      activeSseConnections -= 1;
      resolveClosed();
    };

    activeSseConnections += 1;
    activeSseResponses.add(raw);
    // A long response ends on ServerResponse.close. IncomingMessage.close can
    // describe completion of the request side and is therefore not the stream
    // lifecycle signal; request.aborted remains a useful secondary signal.
    raw.once("close", cleanup);
    request.raw.once("aborted", cleanup);

    try {
      reply.hijack();
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      if (!writeSseChunk(
        raw,
        `data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`,
        cleanup,
      )) return;

      eventBus.on("app_event", listener);
      listenerRegistered = true;
      heartbeat = setInterval(() => {
        writeSseChunk(raw, ": heartbeat\n\n", cleanup);
      }, 30_000);

      if (raw.destroyed || raw.writableEnded || request.raw.aborted) cleanup();
      await closed;
    } finally {
      cleanup();
    }
  });
};
