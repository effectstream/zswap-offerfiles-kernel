// Publishing authenticated, capacity-aware INDICATIVE ladders to the node.
// They are not reservations: concurrent fills and later balance changes can
// make a previously advertised rung unavailable before a maker submits.
//
// Rungs are clipped to what the solver can currently pay. Publishing a rung it
// cannot honour is worse than publishing nothing: the node quotes it, a maker
// builds an offer against that quote, and the solver then refuses for want of
// stock — a wasted proof and a wasted round trip for the maker.

import type { LadderBook, PriceLevels } from "./ladder.ts";
import type { Stock } from "./stock.ts";

export interface LevelsPushOptions {
  api: string;
  /** Secret used by the node to derive the solver identity. Never send a
   * caller-selected solver ID on the wire. */
  authToken: string;
  ladders: LadderBook;
  stock: Stock;
  intervalMs: number;
  log?: (msg: string) => void;
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  /** Absolute deadline covering both response headers and response-body drain. */
  requestTimeoutMs?: number;
}

export interface LevelsPushHandle {
  push: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Drop the rungs the solver cannot currently pay out.
 *
 *  Rungs ascend in both input and output, so affordability is a prefix: once
 *  one rung's output exceeds available stock, every later rung does too. A pair
 *  with no affordable rung is omitted entirely rather than published empty. */
export function clipToStock(ladders: LadderBook, stock: Stock): PriceLevels[] {
  const out: PriceLevels[] = [];
  const remaining = new Map<string, bigint>();
  for (const pair of ladders.pairs()) {
    const budget = remaining.get(pair.tokenOut) ?? stock.available(pair.tokenOut);
    const affordable = [];
    for (const rung of pair.levels) {
      if (BigInt(rung.output) > budget) break;
      affordable.push(rung);
    }
    if (affordable.length > 0) {
      out.push({ tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, levels: affordable });
      // Each published pair must be independently honourable at its largest
      // quoted size, even when several pairs spend the same output inventory.
      remaining.set(pair.tokenOut, budget - BigInt(affordable[affordable.length - 1].output));
    }
  }
  return out;
}

export const MAX_U64 = (1n << 64n) - 1n;

/** Allocate a strictly increasing positive u64 publication version. Wall time
 * makes restarts advance in normal operation; the previous value protects
 * against same-millisecond pushes and clock rollback within this process. */
export function nextPublicationVersion(previous: bigint, nowMs: number): bigint {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error(`publication clock must be a positive safe integer, got ${nowMs}`);
  }
  // Reserve six decimal digits for in-process increments. A normal restart in
  // a later millisecond therefore advances beyond every prior same-ms push.
  const wall = BigInt(nowMs) * 1_000_000n;
  const next = wall > previous ? wall : previous + 1n;
  if (next > MAX_U64) throw new Error("solver levels publication version exhausted u64");
  return next;
}

export function validateLevelsAuthToken(token: string): void {
  if (token.length < 16 || /\s/.test(token)) {
    throw new Error(
      "SOLVER_LEVELS_AUTH_TOKEN must contain at least 16 non-whitespace characters",
    );
  }
}

export const shouldPublishLevels = (dryRun: boolean, explicitlyEnabled: boolean): boolean =>
  !dryRun && explicitlyEnabled;

const observe = (promise: Promise<unknown>): void => {
  // A fetch implementation is allowed to ignore AbortSignal. Keep its losing
  // promise observed after our deadline/stop race has already settled.
  void promise.catch(() => {});
};

const asAbortError = (reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new Error(reason === undefined ? "levels push aborted" : String(reason));

interface ResponseBodyDrain {
  done: Promise<string>;
  cancel: (reason: unknown) => void;
}

const MAX_LEVELS_RESPONSE_BYTES = 16 * 1024;

/** Drain successful and rejected responses alike so the transport can reuse
 * its connection. Retaining the reader also lets timeout/stop cancel a body
 * whose next chunk never arrives. */
function drainResponseBody(response: Response): ResponseBodyDrain {
  if (!response.body) return { done: Promise.resolve(""), cancel: () => {} };

  const reader = response.body.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return body + decoder.decode();
        bytes += next.value.byteLength;
        if (bytes > MAX_LEVELS_RESPONSE_BYTES) {
          throw new Error(
            `levels push response exceeded ${MAX_LEVELS_RESPONSE_BYTES} bytes`,
          );
        }
        body += decoder.decode(next.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  })();
  observe(done);

  return {
    done,
    cancel: (reason) => {
      try {
        observe(reader.cancel(reason));
      } catch {
        // Cancellation is best effort; the owned deadline still bounds us.
      }
    },
  };
}

function staleVersionWatermark(raw: string): bigint | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.error !== "STALE_VERSION" ||
    typeof record.lastVersion !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(record.lastVersion)
  ) return null;
  const parsed = BigInt(record.lastVersion);
  return parsed <= MAX_U64 ? parsed : null;
}

function cancelUnclaimedResponse(response: Response, reason: unknown): void {
  if (!response.body) return;
  try {
    observe(response.body.cancel(reason));
  } catch {
    // A non-conforming fetch mock must not defeat lifecycle shutdown.
  }
}

export function startLevelsPush(opts: LevelsPushOptions): LevelsPushHandle {
  const log = (message: string): void => {
    try {
      opts.log?.(message);
    } catch {
      // Logging is diagnostic only and cannot own request or stop lifecycle.
    }
  };
  validateLevelsAuthToken(opts.authToken);
  const nowMs = opts.nowMs ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(
      `levels push request timeout must be a positive safe integer, got ${requestTimeoutMs}`,
    );
  }
  const owner = new AbortController();
  let stopped = false;
  let requested = false;
  let running: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let version = 0n;
  let mayHavePublished = false;

  const sendOnce = async (
    pairs: PriceLevels[],
    abortOwner: AbortSignal | null,
  ): Promise<"accepted" | "retry" | "failed"> => {
    try {
      version = nextPublicationVersion(version, nowMs());
    } catch (err) {
      log(
        `[solver] levels publication unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return "failed";
    }
    if (pairs.length > 0) mayHavePublished = true;
    const request = new AbortController();
    const abortForOwner = () => request.abort(abortOwner?.reason);
    if (abortOwner?.aborted) abortForOwner();
    else abortOwner?.addEventListener("abort", abortForOwner, { once: true });

    const deadline = setTimeout(() => {
      request.abort(
        new Error(`levels push exceeded ${requestTimeoutMs}ms response-and-body deadline`),
      );
    }, requestTimeoutMs);
    deadline.unref?.();

    let removeAbortWait = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(asAbortError(request.signal.reason));
      removeAbortWait = () => request.signal.removeEventListener("abort", rejectAbort);
      if (request.signal.aborted) rejectAbort();
      else request.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    observe(aborted);

    let response: Response | undefined;
    let bodyDrain: ResponseBodyDrain | undefined;
    try {
      let fetchPromise: Promise<Response>;
      try {
        fetchPromise = Promise.resolve(
          fetchImpl(`${opts.api}/v1/solver/levels`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.authToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ version: version.toString(), pairs }),
            signal: request.signal,
          }),
        );
      } catch (err) {
        fetchPromise = Promise.reject(err);
      }
      observe(fetchPromise);
      void fetchPromise.then(
        (lateResponse) => {
          if (request.signal.aborted && response === undefined) {
            cancelUnclaimedResponse(lateResponse, request.signal.reason);
          }
        },
        () => {},
      );

      response = await Promise.race([fetchPromise, aborted]);
      bodyDrain = drainResponseBody(response);
      const raw = await Promise.race([bodyDrain.done, aborted]);
      if (!response.ok) {
        const watermark = response.status === 409 ? staleVersionWatermark(raw) : null;
        if (watermark !== null && watermark >= version && watermark < MAX_U64) {
          // The authenticated node is the authority for this solver identity's
          // replay watermark. A process restart can otherwise begin below its
          // still-live tombstone after clock rollback/same-ms restart. Adopt
          // the watermark and coalesce one immediate full-snapshot retry.
          version = watermark;
          log(`[solver] levels version reconciled at ${watermark}; retrying publication`);
          return "retry";
        }
        log(`[solver] levels push rejected: ${response.status}`);
        return "failed";
      }
      return "accepted";
    } catch (err) {
      if (bodyDrain) bodyDrain.cancel(err);
      else if (response) cancelUnclaimedResponse(response, err);
      if (abortOwner?.aborted) return "failed";
      // Prices are re-pushed on the next tick, so a failed push is a gap in
      // quoting, never a lost update worth retrying here.
      log(`[solver] levels push failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    } finally {
      clearTimeout(deadline);
      removeAbortWait();
      abortOwner?.removeEventListener("abort", abortForOwner);
    }
  };

  const pushOnce = async (): Promise<void> => {
    const result = await sendOnce(clipToStock(opts.ladders, opts.stock), owner.signal);
    if (result === "retry") requested = true;
  };

  /** At most one request is in flight. Calls during it collapse into exactly
   * one refresh using the newest stock snapshot. */
  const push = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    requested = true;
    if (!running) {
      running = (async () => {
        while (requested && !stopped) {
          requested = false;
          await pushOnce();
        }
      })().finally(() => {
        running = null;
      });
    }
    return running;
  };

  void push();
  const timer = setInterval(() => {
    if (!stopped) void push();
  }, opts.intervalMs);
  timer.unref?.();

  return {
    push,
    stop: () => {
      if (!stopping) {
        stopped = true;
        requested = false;
        owner.abort(new Error("solver levels publisher stopped"));
        clearInterval(timer);
        const active = running;
        stopping = (async () => {
          await (active ?? Promise.resolve());
          if (!mayHavePublished) return;

          // A graceful stop withdraws the authenticated complete declaration
          // immediately. If the node is unavailable, this remains bounded and
          // its TTL is the documented fallback. One stale-watermark retry is
          // enough because the node response is identity-bound by the bearer.
          let result = await sendOnce([], null);
          if (result === "retry") result = await sendOnce([], null);
          if (result === "accepted") mayHavePublished = false;
          else log("[solver] final levels withdrawal failed; node TTL remains the fallback");
        })();
      }
      return stopping;
    },
  };
}
