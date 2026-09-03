// The poster's health surface: `/health`, `/metrics`, `/journal` (FR-013, US3).
//
// The shape of the answer and the decision "200 or 503" are PURE functions of a
// snapshot, so both are unit-tested without a socket; `startHealthServer` is a
// thin `Bun.serve` around them. That split matters because the interesting part
// is the policy, not the transport: a poster that reports 200 while it has
// failed nine ticks in a row is worse than one with no health endpoint at all.
//
// WHAT COUNTS AS UNHEALTHY. `HEALTH_STALE_TICKS` CONSECUTIVE FAILED ticks turn
// `/health` into a 503. A `degraded` tick is NOT a failure: a poster whose
// wallet has run out of DUST is behaving exactly as designed (US1 scenario 6),
// and flipping to 503 there would make compose restart a container that is
// waiting for the operator to send it NIGHT. `state` still says `degraded`, and
// `lastFailure` still says `insufficient_dust`, so the condition is visible
// without being fatal.

import type { JournalSummary } from "./poster-journal.ts";
import type { SchedulerStats } from "./poster-scheduler.ts";

export type PosterState = "starting" | "ok" | "degraded" | "unhealthy" | "stopping";

export interface HealthInputs {
  stats: SchedulerStats;
  /** `HEALTH_STALE_TICKS`. */
  staleTicks: number;
  /** Spendable DUST at the last reading, or `null` when never read. */
  dustBalance: bigint | null;
  /** Offers the journal believes are live. */
  liveOffers: number;
  /** Coins of the give colour the wallet could spend right now. */
  freeCoins: number;
  /** Re-offer candidates at the last reconcile. */
  candidates: number;
  journalSummary: JournalSummary | null;
  /** Process start, epoch ms. */
  startedAt: number;
  now: number;
  shuttingDown: boolean;
  /** `true` once startup finished; a poster still syncing its wallet reports
   *  `starting` rather than pretending to be healthy. */
  ready: boolean;
}

export interface HealthAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** The US3-3 payload plus the few fields that make an incident diagnosable
 *  without shelling into the container. Never contains a secret. */
export function healthSnapshot(input: HealthInputs): HealthAnswer {
  const { stats } = input;
  const unhealthy = stats.consecutiveFailures >= input.staleTicks;

  let state: PosterState;
  if (input.shuttingDown) state = "stopping";
  else if (unhealthy) state = "unhealthy";
  else if (!input.ready || stats.ticks === 0) state = "starting";
  else if (stats.lastMode === "degraded") state = "degraded";
  else state = "ok";

  const body: Record<string, unknown> = {
    state,
    ready: input.ready,
    uptimeMs: Math.max(0, input.now - input.startedAt),
    ticks: stats.ticks,
    mints: stats.mints,
    reoffers: stats.reoffers,
    degradedTicks: stats.degraded,
    success: stats.success,
    failure: stats.failure,
    overruns: stats.overruns,
    consecutiveFailures: stats.consecutiveFailures,
    lastTickAt: stats.lastTickAt === null ? null : new Date(stats.lastTickAt).toISOString(),
    lastTickMs: stats.lastTickMs,
    lastMode: stats.lastMode,
    lastOfferId: stats.lastOfferId,
    lastError: stats.lastError,
    lastFailure: stats.lastFailure,
    // A bigint would break `JSON.stringify`; decimal strings are what the whole
    // journal uses for amounts anyway.
    dustBalance: input.dustBalance === null ? null : input.dustBalance.toString(),
    liveOffers: input.liveOffers,
    freeCoins: input.freeCoins,
    candidates: input.candidates,
    p50TickMs: stats.p50TickMs,
    p95TickMs: stats.p95TickMs,
    journal: input.journalSummary,
  };
  return { status: unhealthy ? 503 : 200, body };
}

/** Prometheus-ish text. Deliberately not a real client library: the poster has
 *  one process, a dozen counters and no scrape contract to honour. */
export function renderMetrics(input: HealthInputs): string {
  const { stats } = input;
  const lines: string[] = [];
  const metric = (name: string, value: number | null, help: string, type = "counter"): void => {
    lines.push(`# HELP offer_poster_${name} ${help}`);
    lines.push(`# TYPE offer_poster_${name} ${type}`);
    lines.push(`offer_poster_${name} ${value === null ? "NaN" : value}`);
  };
  metric("ticks_total", stats.ticks, "Ticks started.");
  metric("mints_total", stats.mints, "Mint transactions that landed on chain.");
  metric("reoffers_total", stats.reoffers, "Ticks that re-offered a released coin.");
  metric("degraded_total", stats.degraded, "Ticks that could neither mint nor re-offer.");
  metric("success_total", stats.success, "Ticks that finished without a failure.");
  metric("failure_total", stats.failure, "Ticks that failed.");
  metric("overruns_total", stats.overruns, "Ticks that overran POST_INTERVAL_MS.");
  metric("consecutive_failures", stats.consecutiveFailures, "Consecutive failing ticks.", "gauge");
  metric("tick_ms_p50", stats.p50TickMs, "Median tick duration, ms.", "gauge");
  metric("tick_ms_p95", stats.p95TickMs, "95th percentile tick duration, ms.", "gauge");
  metric("last_tick_ms", stats.lastTickMs, "Duration of the last tick, ms.", "gauge");
  metric("live_offers", input.liveOffers, "Offers the journal believes are live.", "gauge");
  metric("free_coins", input.freeCoins, "Spendable give-colour coins in the wallet.", "gauge");
  metric("candidates", input.candidates, "Journaled coins eligible for re-offer.", "gauge");
  metric("ready", input.ready ? 1 : 0, "1 once startup completed.", "gauge");
  metric(
    "up",
    healthSnapshot(input).status === 200 ? 1 : 0,
    "1 while /health answers 200.",
    "gauge",
  );
  if (input.dustBalance !== null) {
    lines.push("# HELP offer_poster_dust_balance Spendable DUST at the last reading.");
    lines.push("# TYPE offer_poster_dust_balance gauge");
    // Deliberately printed unrounded: DUST values exceed 2^53 and a Number cast
    // would silently lose precision in exactly the digits that matter.
    lines.push(`offer_poster_dust_balance ${input.dustBalance.toString()}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface HealthServerOptions {
  port: number;
  /** Read the current inputs. Called per request, so it always reflects now. */
  snapshot(): HealthInputs;
  /** The journal, as JSON. `GET /journal` is read-only (US2 scenario 6). */
  journal(): unknown;
  hostname?: string;
  log?(msg: string): void;
}

export interface HealthServer {
  port: number;
  stop(): Promise<void>;
}

/** Serialiser that survives the bigints the journal keeps as strings and the
 *  ones a caller may leak in by accident. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/** `Bun.serve` on `POSTER_HEALTH_PORT`. Three read-only routes; anything else
 *  is a 404. No route ever exposes configuration, so a seed cannot leak here. */
export function startHealthServer(opts: HealthServerOptions): HealthServer {
  const log = opts.log ?? ((msg: string) => console.log(`[offer-poster] ${msg}`));
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (path === "/health" || path === "/") {
        const answer = healthSnapshot(opts.snapshot());
        return new Response(toJson(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (path === "/metrics") {
        return new Response(renderMetrics(opts.snapshot()), {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (path === "/journal") {
        return new Response(toJson(opts.journal()), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(toJson({ error: "NOT_FOUND", routes: ["/health", "/metrics", "/journal"] }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });
  log(`health server listening on ${server.hostname}:${server.port} (/health /metrics /journal)`);
  return {
    // `Bun.serve` types `port` as optional; it is always set for a TCP listener.
    port: server.port ?? opts.port,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
