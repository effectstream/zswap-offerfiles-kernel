/**
 * Fixture sources for the monitor's tests AND for the manual visual check.
 *
 * The three upstreams are REAL loopback listeners rather than a stubbed
 * `fetch`, because the interesting failures of this service are transport
 * failures: a connection refused at boot, a stream that ends mid-flight, a
 * bearer that does not match, a route that 404s. A fetch double proves none of
 * those; a socket that is actually closed proves all of them.
 *
 * `bun run packages/solver-frontend/test-helpers/serve-fixture.ts` starts the
 * same three sources for a browser session.
 */
import {
  statusContractVersion,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

/** A 64-hex colour that still reads as itself in an 8-character prefix. */
export const colour = (head: string): string =>
  (head + "9d3c8a1f7b25e04c6a83fd19b40e7c52a6f381d0").slice(0, 64);

export const TKA = colour("e7580bfc");
export const TKB = colour("fda14e2e");
export const NIGHT = "0".repeat(64);

const OFFER_A = colour("b74a4cec");
const OFFER_B = colour("e7cf2b2c");
const OFFER_C = colour("51aa07d0");
const OFFER_BASKET = colour("9a1c55e0");

export interface FixtureSnapshotOptions {
  now?: number;
  mode?: "live" | "dry-run";
  connected?: boolean;
  /** `null` = real ladders; a string = the withdrawal reason to render. */
  withheld?: string | null;
  blockedReason?: string | null;
  quarantined?: number;
}

/**
 * A realistic `StatusSnapshot` — every section populated, so the page's
 * derivations are exercised against the shape the solver actually serves.
 */
export function buildStatusSnapshot(options: FixtureSnapshotOptions = {}): StatusSnapshot {
  const now = options.now ?? 1_770_000_000_000;
  const mode = options.mode ?? "live";
  const connected = options.connected ?? true;
  const withheld = options.withheld ?? null;
  const blockedReason = options.blockedReason ?? null;
  const dryRun = mode === "dry-run";

  return {
    contractVersion: statusContractVersion,
    now,
    process: {
      startedAt: now - 8_040_000,
      uptimeMs: 8_040_000,
      network: "undeployed",
      api: "http://kernel:9999",
      relayWsUrl: dryRun ? null : "ws://relay:9001/solver",
      relayHttpUrl: dryRun ? null : "http://relay:3000",
      relayAuthTokenLength: 48,
      mode,
      solverEnabled: true,
      gitCommit: "0c3afdb",
      runtime: "1.3.11",
    },
    backend:
      blockedReason === null
        ? {
            currentness: {
              kind: "current",
              streamGeneration: 3,
              backendBlockL2: "1204",
              healthTs: now - 900,
            },
            isCurrent: true,
          }
        : {
            currentness: { kind: "blocked", reason: blockedReason, streamGeneration: 3 },
            isCurrent: false,
          },
    book: {
      size: 4,
      pairs: [
        { giveToken: TKB, wantToken: TKA, offers: 2 },
        { giveToken: TKA, wantToken: TKB, offers: 1 },
      ],
      offers: [
        {
          offerHash: OFFER_A,
          gives: [{ token: TKB, amount: "500000", kind: "SHIELDED" }],
          wants: [{ token: TKA, amount: "750000", kind: "SHIELDED" }],
          expiresAt: now + 3_600_000,
          firstSeenAt: now - 600_000,
          inputNullifierCount: 1,
        },
        {
          offerHash: OFFER_B,
          gives: [{ token: TKB, amount: "400000", kind: "SHIELDED" }],
          wants: [{ token: TKA, amount: "600000", kind: "SHIELDED" }],
          expiresAt: now + 3_800_000,
          firstSeenAt: now - 500_000,
          inputNullifierCount: 1,
        },
        {
          offerHash: OFFER_C,
          gives: [{ token: TKA, amount: "560000", kind: "SHIELDED" }],
          wants: [{ token: TKB, amount: "400000", kind: "SHIELDED" }],
          expiresAt: now + 3_900_000,
          firstSeenAt: now - 400_000,
          inputNullifierCount: 1,
        },
        {
          offerHash: OFFER_BASKET,
          gives: [
            { token: TKA, amount: "1000", kind: "SHIELDED" },
            { token: TKB, amount: "1000", kind: "SHIELDED" },
          ],
          wants: [{ token: NIGHT, amount: "5000", kind: "UNSHIELDED" }],
          expiresAt: now + 4_200_000,
          firstSeenAt: now - 200_000,
          inputNullifierCount: 2,
        },
      ],
      cap: 500,
      truncated: 0,
    },
    inventory: {
      ready: blockedReason === null,
      refreshing: false,
      retainedOperations: 0,
      tokens: [
        { token: TKB, balance: "100000", reserved: "0", available: "100000" },
        { token: TKA, balance: "0", reserved: "0", available: "0" },
        { token: NIGHT, balance: "9940000000", reserved: "0", available: "9940000000" },
      ],
    },
    relay: dryRun
      ? { state: "not-started", stats: null, lastEventByKind: {}, events: [], eventCap: 200, eventsObserved: 0 }
      : {
          state: "running",
          stats: {
            connected,
            connections: connected ? 2 : 6,
            pushes: 1482,
            coalesced: 3,
            pushFailures: 0,
            withdrawn: withheld !== null,
            stopped: false,
          },
          lastEventByKind: {
            connected: {
              seq: 41,
              at: now - 264_000,
              kind: "connected",
              severity: "info",
              message: "relay socket open; re-pushing capabilities and ladders",
            },
            ...(connected
              ? {}
              : {
                  disconnected: {
                    seq: 58,
                    at: now - 42_000,
                    kind: "disconnected",
                    severity: "error",
                    message: "relay socket closed (1006) — reconnecting in 2 000 ms",
                  },
                }),
          },
          events: [
            {
              seq: 40,
              at: now - 266_000,
              kind: "connect",
              severity: "info",
              message: "dialling the relay",
            },
            {
              seq: 41,
              at: now - 264_000,
              kind: "connected",
              severity: "info",
              message: "relay socket open; re-pushing capabilities and ladders",
            },
            {
              seq: 59,
              at: now - 800,
              kind: "push",
              severity: "info",
              message: "pushed 2 pair(s), 3 rungs, 2 tokens",
            },
          ],
          eventCap: 200,
          eventsObserved: 59,
        },
    ladder: dryRun
      ? { state: "not-started", last: null }
      : {
          state: "derived",
          last: {
            derivedAt: now - 800,
            cause: "tick",
            withheld,
            tokenIds: withheld === null ? [TKA, TKB] : [],
            maxParallelSwaps: 8,
            levels:
              withheld === null
                ? [
                    {
                      tokenIn: TKA,
                      tokenOut: TKB,
                      levels: [
                        { input: "750000", output: "500000" },
                        { input: "1350000", output: "900000" },
                      ],
                    },
                    {
                      tokenIn: TKB,
                      tokenOut: TKA,
                      levels: [{ input: "400000", output: "560000" }],
                    },
                  ]
                : [],
            provenance:
              withheld === null
                ? [
                    {
                      tokenIn: TKA,
                      tokenOut: TKB,
                      rungs: [
                        { input: "750000", output: "500000", offerHash: OFFER_A },
                        { input: "1350000", output: "900000", offerHash: OFFER_B },
                      ],
                      residualBound: "100000",
                    },
                    {
                      tokenIn: TKB,
                      tokenOut: TKA,
                      rungs: [{ input: "400000", output: "560000", offerHash: OFFER_C }],
                      residualBound: "0",
                    },
                  ]
                : [],
            excluded: [
              { offerHash: OFFER_BASKET, reason: "multi-leg" },
              { offerHash: colour("4e2f9b31"), reason: "unavailable" },
              {
                offerHash: colour("c0de11aa"),
                reason: "invalid-pair",
                detail: "wants an UNSHIELDED leg",
              },
            ],
            pairs: withheld === null ? 2 : 0,
            rungs: withheld === null ? 3 : 0,
          },
        },
    executor: dryRun
      ? { state: "not-started", stats: null, unavailableOfferHashes: [], dustAvailable: null }
      : {
          state: "running",
          stats: {
            building: 0,
            quarantined: options.quarantined ?? 0,
            awaitingRelay: 0,
            awaitingConsumption: 1,
            completed: 3,
            refused: 1,
            reverted: 0,
            revertFailures: 0,
            timedOutBuilds: 0,
            stopped: false,
          },
          unavailableOfferHashes: [colour("4e2f9b31")],
          dustAvailable: true,
        },
    journal: dryRun
      ? { state: "not-opened", path: null, rows: [], rowCap: 100, total: 0, countsByState: {}, dust: null }
      : {
          state: "open",
          path: "/var/lib/cow-solver/operations.sqlite",
          rows: [
            {
              id: 4,
              operationKey: "job:7f3a",
              jobId: "j-7f3ae0",
              generation: 1,
              operationKind: "JOB_SETTLEMENT",
              lifecycleState: "RELAY_SUBMITTED",
              offerHashes: [colour("4e2f9b31")],
              claimInputCount: 2,
              payouts: { [TKB]: "0" },
              walletArtifactKind: "settlement",
              walletArtifactByteLength: 41_233,
              receipt: { relayJobId: "j-7f3ae0", relayState: "submitted", relayExtrinsicHash: colour("7d0c41aa") },
              errorCode: null,
              errorDetail: null,
              retryCount: 0,
              nextRetryAtMs: null,
              ttlExpiresAtMs: now + 600_000,
              deadlineAtMs: now + 300_000,
              createdAtMs: now - 38_000,
              updatedAtMs: now - 12_000,
            },
            {
              id: 3,
              operationKey: "job:51c0",
              jobId: "j-51c09b",
              generation: 1,
              operationKind: "JOB_SETTLEMENT",
              lifecycleState: "SETTLED",
              offerHashes: [colour("2b7e1c9d")],
              claimInputCount: 1,
              payouts: { [TKB]: "100000" },
              walletArtifactKind: "settlement",
              walletArtifactByteLength: 40_112,
              receipt: { ledgerTxHash: colour("9fe2c311"), ledgerHeight: 1176 },
              errorCode: null,
              errorDetail: null,
              retryCount: 0,
              nextRetryAtMs: null,
              ttlExpiresAtMs: now + 600_000,
              deadlineAtMs: now - 100_000,
              createdAtMs: now - 720_000,
              updatedAtMs: now - 700_000,
            },
          ],
          rowCap: 100,
          total: 4,
          // The journal's REAL lifecycle names (operation-journal.ts): two terminal, one in flight.
          countsByState: { SETTLED: 2, REVERTED: 1, AWAITING_RELAY: 1 },
          dust: {
            configured: true,
            maxPerJob: "5000000000000000",
            maxPerWindow: "10000000000000000",
            windowMs: 3_600_000,
            usage: "2780000000000000",
            reservations: { reserved: 1, spent: 3, released: 0 },
          },
        },
    admission: {
      supportedPairs: null,
      minJobOutput: null,
      dust: { maxPerJob: "5000000000000000", maxPerWindow: "10000000000000000", windowMs: 3_600_000 },
      openGroups: ["SOLVER_SUPPORTED_PAIRS", "SOLVER_MIN_JOB_OUTPUT"],
      feeSizingTakerInputs: 1,
      expiryMarginSeconds: 30,
      pushIntervalMs: 1000,
      maxParallelSwaps: 8,
      maxRungsPerPair: null,
      maxPairs: null,
      settleTtlMinutes: 10,
    },
    listener: {
      host: "0.0.0.0",
      port: 9100,
      startedAt: now - 8_040_000,
      healthRequests: 402,
      snapshotRequests: 3,
      streamRequests: 12,
      unauthorizedRequests: 0,
      notFoundRequests: 0,
      streamClients: 1,
      streamClientCap: 32,
      streamFramesDropped: 0,
      streamClientsRejected: 0,
    },
  };
}

/**
 * A `MonitorSnapshot` around a fixture `StatusSnapshot`, for the pure
 * derivation tests. Deliberately built by hand rather than by running the
 * aggregator: `derive.test.ts` is a table of judgements, and a table that had
 * to start three servers to state a case would be a different kind of test.
 */
export function buildMonitorSnapshot(options: {
  status?: StatusSnapshot | null;
  solverState?: "never-reached" | "reachable" | "unreachable";
  now?: number;
  lastSeenAt?: number | null;
  kernelSyncStatus?: string | null;
  kernelError?: string | null;
  relayTokens?: string[] | null;
  decimals?: number;
  withdrawals?: number;
  history?: Array<{ at: number; kind: string; from: string; to: string; detail: string }>;
} = {}): Record<string, unknown> {
  const now = options.now ?? 1_770_000_001_000;
  const status = options.status === undefined ? buildStatusSnapshot({ now: now - 1000 }) : options.status;
  const solverState = options.solverState ?? (status === null ? "never-reached" : "reachable");
  const decimals = options.decimals ?? 0;
  return {
    now,
    monitor: {
      startedAt: now - 60_000,
      uptimeMs: 60_000,
      pollMs: 4000,
      historyLimit: 500,
      contractVersion: 1,
      withdrawals: options.withdrawals ?? 0,
      lastWithdrawalAt: null,
      lastWithdrawalMs: null,
      relayOutages: 0,
      feedClients: 1,
      feedClientCap: 32,
    },
    solver: {
      state: solverState,
      reachable: solverState === "reachable",
      since: now - 30_000,
      lastSeenAt:
        options.lastSeenAt === undefined ? (status === null ? null : now - 1000) : options.lastSeenAt,
      transport: solverState === "reachable" ? "stream" : null,
      streamConnects: 1,
      outages: solverState === "unreachable" ? 1 : 0,
      attempts: solverState === "reachable" ? 0 : 3,
      lastError: solverState === "reachable" ? null : "ConnectionRefused",
      host: "solver:9100",
      contractVersion: status === null ? null : statusContractVersion,
      expectedContractVersion: statusContractVersion,
      snapshot: status,
    },
    kernel: {
      api: "http://kernel:9999",
      fetchedAt: now - 3000,
      latencyMs: 4,
      sync:
        options.kernelError != null
          ? { error: options.kernelError }
          : {
              status: options.kernelSyncStatus ?? "ok",
              ts: now,
              ntp: { current: 1204, tip: 1204 },
              midnight: { current: 127000, tip: 127000 },
              celestia: { current: 12231713, tip: 12231717 },
            },
      book: {
        offers: [
          {
            offerId: OFFER_A,
            blockHeight: "1188",
            status: "live",
            gives: [{ token: TKB, amount: "500000", type: "SHIELDED" }],
            wants: [{ token: TKA, amount: "750000", type: "SHIELDED" }],
            expiresAt: "2026-09-03T15:02:10.000Z",
            firstSeenAt: "2026-09-03T14:02:10.000Z",
            inputNullifierCount: 1,
          },
          {
            offerId: OFFER_BASKET,
            blockHeight: "1201",
            status: "live",
            gives: [
              { token: TKA, amount: "1000", type: "SHIELDED" },
              { token: TKB, amount: "1000", type: "SHIELDED" },
            ],
            wants: [{ token: NIGHT, amount: "5000", type: "UNSHIELDED" }],
            expiresAt: null,
            firstSeenAt: null,
            inputNullifierCount: 2,
          },
        ],
        count: 2,
        limit: 100,
        nextCursor: null,
      },
      knownTokens: [
        { color: NIGHT, name: "NIGHT", kind: "unshielded", decimals: 0 },
        { color: TKA, name: "TKA", kind: "shielded", decimals },
        { color: TKB, name: "TKB", kind: "shielded", decimals },
      ],
      pairs: [],
      prices: null,
    },
    relay: {
      configured: true,
      url: "http://relay:3000",
      fetchedAt: now - 3000,
      latencyMs: 4,
      tokens: options.relayTokens === undefined ? [TKA, TKB] : options.relayTokens,
    },
    history: options.history ?? [],
  };
}

// ── the three fixture listeners ─────────────────────────────────────────────

interface ServerLike {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
}

export interface FakeSolver {
  url: string;
  /** Replace the snapshot every route serves and push it to open streams. */
  publish: (snapshot: StatusSnapshot) => void;
  /** End every open stream WITHOUT an error — the solver's 5-minute lifetime. */
  endStreams: () => void;
  /** Requests seen, so a test can prove the fallback poll actually happened. */
  counts: { snapshot: number; stream: number; unauthorized: number };
  stop: () => void;
}

export function startFakeSolver(options: {
  token: string;
  snapshot?: StatusSnapshot;
  /** Refuse `/status/stream` so the snapshot fallback is the only way in. */
  noStream?: boolean;
  /** A fixed port, so a test can stop the solver and bring it back at the same
   *  address — the "went away and came back" case. */
  port?: number;
}): FakeSolver {
  const encoder = new TextEncoder();
  let current = options.snapshot ?? buildStatusSnapshot();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const counts = { snapshot: 0, stream: 0, unauthorized: 0 };

  const server = (Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", ready: true, mode: "live", contractVersion: 1 });
      }
      if (url.pathname.startsWith("/status/")) {
        if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
          counts.unauthorized += 1;
          return new Response(null, { status: 401 });
        }
        if (url.pathname === "/status/snapshot") {
          counts.snapshot += 1;
          return Response.json(current);
        }
        if (url.pathname === "/status/stream") {
          counts.stream += 1;
          if (options.noStream === true) return new Response(null, { status: 503 });
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streams.add(controller);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(current)}\n\n`));
            },
            cancel() {
              // Bun does not report browser disconnects; `endStreams` is what
              // this fixture uses to model the solver closing a stream.
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
      }
      return new Response(null, { status: 404 });
    },
  }) as unknown) as ServerLike;

  return {
    url: `http://127.0.0.1:${server.port}`,
    counts,
    publish: (snapshot) => {
      current = snapshot;
      const frame = encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
      for (const controller of [...streams]) {
        try {
          controller.enqueue(frame);
        } catch {
          streams.delete(controller);
        }
      }
    },
    endStreams: () => {
      for (const controller of [...streams]) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        streams.delete(controller);
      }
    },
    stop: () => {
      for (const controller of [...streams]) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      streams.clear();
      server.stop(true);
    },
  };
}

export interface FakeKernel {
  url: string;
  /** How many times each route was asked for. */
  counts: Record<string, number>;
  stop: () => void;
}

export function startFakeKernel(
  options: { prices?: boolean; decimals?: number; port?: number } = {},
): FakeKernel {
  const counts: Record<string, number> = {};
  const bump = (name: string): void => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const decimals = options.decimals ?? 0;

  const offerRow = (hash: string, gives: unknown, wants: unknown, height: string) => ({
    version: 1,
    offerId: hash,
    blobChars: 24781,
    blockHeight: height,
    computed: {
      gives,
      wants,
      expiresAt: "2026-09-03T15:02:10.000Z",
      inputNullifiers: [colour("7c1d9b00")],
      firstSeenAt: "2026-09-03T14:02:10.000Z",
      status: "live",
    },
  });

  const server = (Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      bump(url.pathname);
      if (url.pathname === "/v1/health/sync") {
        return Response.json({
          ts: Date.now(),
          status: "ok",
          ntp: { current: 1204, tip: 1204, pct: 100, lag_blocks: 0, lag_seconds: 0 },
          midnight: { current: 127000, fetched: 127000, tip: 127000, pct: 100 },
          celestia: { current: 12231713, fetched: 12231715, tip: 12231717, pct: 99.9 },
        });
      }
      if (url.pathname === "/v1/offers") {
        return Response.json({
          offers: [
            offerRow(
              colour("b74a4cec"),
              [{ token: TKB, amount: "500000", type: "SHIELDED" }],
              [{ token: TKA, amount: "750000", type: "SHIELDED" }],
              "1188",
            ),
            offerRow(
              colour("9a1c55e0"),
              [
                { token: TKA, amount: "1000", type: "SHIELDED" },
                { token: TKB, amount: "1000", type: "SHIELDED" },
              ],
              [{ token: NIGHT, amount: "5000", type: "UNSHIELDED" }],
              "1201",
            ),
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === "/v1/known-tokens") {
        return Response.json([
          { id: 1, token_color: NIGHT, name: "NIGHT", kind: "unshielded", decimals: 0 },
          { id: 2, token_color: TKA, name: "TKA", kind: "shielded", decimals },
          { id: 3, token_color: TKB, name: "TKB", kind: "shielded", decimals },
        ]);
      }
      if (url.pathname === "/v1/pairs") {
        return Response.json([
          {
            pair_key: `${TKA}|${TKB}`,
            base_color: TKA,
            quote_color: TKB,
            trade_count: 12,
            last_price: 0.6667,
            last_traded_at: "2026-09-03T12:00:00.000Z",
            open_count: 2,
          },
        ]);
      }
      if (url.pathname === "/v1/prices") {
        // A node without the price service answers 404 and the monitor must
        // degrade to names only, silently (FR-013b).
        if (options.prices !== true) return new Response(null, { status: 404 });
        return Response.json({
          sponsor_discount: 0.025,
          feed: { provider: "coingecko", last_run_at: null, last_ok_at: null, last_error: null },
          assets: [],
          tokens: [
            {
              token_color: TKA,
              name: "TKA",
              kind: "shielded",
              decimals,
              asset_id: null,
              price_usd: "13.0238",
              source: "fallback",
              updated_at: "2026-09-03T12:00:00.000Z",
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    },
  }) as unknown) as ServerLike;

  return { url: `http://127.0.0.1:${server.port}`, counts, stop: () => server.stop(true) };
}

export interface FakeRelay {
  url: string;
  setTokens: (tokens: string[]) => void;
  stop: () => void;
}

export function startFakeRelay(initial: string[] = [TKA, TKB], port = 0): FakeRelay {
  let tokens = [...initial];
  const server = (Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname === "/tokens") return Response.json({ tokens });
      return new Response(null, { status: 404 });
    },
  }) as unknown) as ServerLike;
  return {
    url: `http://127.0.0.1:${server.port}`,
    setTokens: (next) => {
      tokens = [...next];
    },
    stop: () => server.stop(true),
  };
}

/** A port nothing is listening on right now, so a fixture can be stopped and
 *  restarted at the same address. */
export function freePort(): number {
  const probe = (Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) }) as unknown) as ServerLike;
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Poll a condition instead of sleeping a guessed interval. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs} ms`);
}
