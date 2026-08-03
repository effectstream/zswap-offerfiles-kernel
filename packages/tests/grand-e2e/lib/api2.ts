// Extended node-API client for the grand suite.
//
// The node rate-limits 60 req/min/IP across every /v1 route except the two
// health endpoints. This client keeps the suite's background traffic under a
// soft budget (API_SOFT_LIMIT_PER_MIN) so precision phases never eat 429s by
// accident; storm code passes { storm: true } to bypass the throttle on
// purpose. All timings are recorded so metrics can compute p50/p95.

import { API, API_SOFT_LIMIT_PER_MIN } from "../config.ts";
import { sleep } from "./util.ts";

export interface TimedResponse {
  status: number;
  body: any;
  ms: number;
}

const stamps: number[] = []; // completed-request timestamps for the soft budget

async function throttle(): Promise<void> {
  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (stamps.length && stamps[0]! < cutoff) stamps.shift();
    if (stamps.length < API_SOFT_LIMIT_PER_MIN) return;
    await sleep(1500);
  }
}

export const apiTimings: { route: string; ms: number; status: number; at: number }[] = [];

export async function apiCall(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { storm?: boolean; retry429?: number; timeoutMs?: number } = {},
): Promise<TimedResponse> {
  const { storm = false, retry429 = storm ? 0 : 5, timeoutMs = 60_000 } = opts;
  for (let attempt = 0; ; attempt++) {
    if (!storm) await throttle();
    const started = Date.now();
    let status = 0;
    let parsed: any;
    try {
      const r = await fetch(`${API}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = r.status;
      const text = await r.text();
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } catch (e) {
      status = 0;
      parsed = { error: "FETCH_FAILED", reason: e instanceof Error ? e.message : String(e) };
    }
    const ms = Date.now() - started;
    stamps.push(Date.now());
    apiTimings.push({ route: `${method} ${path.split("?")[0]}`, ms, status, at: started });
    if (status === 429 && attempt < retry429) {
      await sleep(10_000);
      continue;
    }
    return { status, body: parsed, ms };
  }
}

// ── Typed conveniences ───────────────────────────────────────────────────────

export const submitOffer2 = (blob: string, opts?: { storm?: boolean }) =>
  apiCall("POST", "/v1/offers", { offer: blob }, opts);

export const getOffersPage = (params: Record<string, string> = {}) =>
  apiCall("GET", `/v1/offers${Object.keys(params).length ? "?" + new URLSearchParams(params) : ""}`);

export const getOfferByHash = (hash: string) => apiCall("GET", `/v1/offers/${hash}`);

export const getOfferStatus = (hash: string) => apiCall("GET", `/v1/offers/${hash}/status`);

export const postStatusByBlob = (payload: { offer?: string; offers?: string[] }) =>
  apiCall("POST", "/v1/offers/status", payload);

export const getPairs = () => apiCall("GET", "/v1/pairs");
export const getKnownTokens = () => apiCall("GET", "/v1/known-tokens");
export const postKnownToken = (body: unknown) => apiCall("POST", "/v1/known-tokens", body);
export const getQuote = (q: Record<string, string>) =>
  apiCall("GET", `/v1/quote?${new URLSearchParams(q)}`);
export const getChartStats = (base: string, quote: string) =>
  apiCall("GET", `/v1/chart/stats?base=${base}&quote=${quote}`);
export const getChartHistory = (base: string, quote: string) =>
  apiCall("GET", `/v1/chart/history?base=${base}&quote=${quote}`);
export const getMidnightConfig = () => apiCall("GET", "/v1/midnight/config");

// Health endpoints are not rate-limited — safe to poll directly.
export async function getHealthSync(port?: number): Promise<any | null> {
  try {
    const base = port ? `http://127.0.0.1:${port}` : API;
    const r = await fetch(`${base}/v1/health/sync`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function getHealth(port?: number): Promise<boolean> {
  try {
    const base = port ? `http://127.0.0.1:${port}` : API;
    const r = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}
