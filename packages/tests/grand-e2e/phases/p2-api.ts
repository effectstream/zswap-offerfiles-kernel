// Phase 2 — the full read/misc API surface: pagination + cursors, filters,
// status probes, token registry, quote, charts, midnight config, rate limit.

import type { Client } from "pg";
import { ledger } from "../ledger.ts";
import type { P1Artifacts } from "./p1-happy.ts";
import {
  apiCall,
  getChartHistory,
  getChartStats,
  getKnownTokens,
  getMidnightConfig,
  getOffersPage,
  getPairs,
  getQuote,
  postKnownToken,
  postStatusByBlob,
} from "../lib/api2.ts";
import { beginPhase, check, note, sleep } from "../lib/util.ts";

const NIGHT = "0".repeat(64);

/** No snake_case keys anywhere in an API payload (MIP-0006 camelCase rule). */
export function noSnakeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(noSnakeKeys);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([k, v]) => !k.includes("_") && noSnakeKeys(v),
    );
  }
  return true;
}

export async function p2Api(db: Client, art: P1Artifacts): Promise<void> {
  beginPhase("p2-api");

  // ── Pagination + cursors ──────────────────────────────────────────────────
  await check("limit=1 pages with a working nextCursor", async () => {
    const p1 = await getOffersPage({ limit: "1" });
    if (p1.status !== 200 || (p1.body?.offers ?? []).length !== 1) return false;
    const cursor = p1.body.nextCursor;
    if (cursor === null) return true; // book of exactly 1 — exhausted is valid
    const p2 = await getOffersPage({ limit: "1", after_hash: cursor });
    if (p2.status !== 200) return false;
    const first = p1.body.offers[0]?.offerId;
    return (p2.body.offers ?? []).every((o: any) => o.offerId !== first);
  });

  await check("malformed cursor → 400 INVALID_CURSOR", async () => {
    const r = await getOffersPage({ after_hash: "zz-not-hex" });
    return r.status === 400 && r.body?.error === "INVALID_CURSOR";
  });

  await check("unknown (fabricated) cursor → 400 INVALID_CURSOR", async () => {
    const r = await getOffersPage({ after_hash: "ab".repeat(32) });
    return r.status === 400 && r.body?.error === "INVALID_CURSOR";
  });

  // ── Filters (the live p1 offer gives TB, wants TA) ───────────────────────
  const tb = ledger.colors.TB!;
  const ta = ledger.colors.TA!;
  await check("token+direction filters match the live offer", async () => {
    const giving = await getOffersPage({ token: tb, direction: "GIVING" });
    const wanting = await getOffersPage({ token: ta, direction: "WANTING" });
    const inGiving = (giving.body?.offers ?? []).some((o: any) => o.offerId === art.liveHash);
    const inWanting = (wanting.body?.offers ?? []).some((o: any) => o.offerId === art.liveHash);
    const wrongSide = await getOffersPage({ token: tb, direction: "WANTING" });
    const notWrong = !(wrongSide.body?.offers ?? []).some((o: any) => o.offerId === art.liveHash);
    return inGiving && inWanting && notWrong;
  });

  // ── Hash-addressed endpoints, error shapes ────────────────────────────────
  await check("malformed hash → 400 INVALID_HASH", async () => {
    const r = await apiCall("GET", "/v1/offers/nothex");
    return r.status === 400 && r.body?.error === "INVALID_HASH";
  });
  await check("unknown hash → 404 NOT_FOUND", async () => {
    const r = await apiCall("GET", `/v1/offers/${"cd".repeat(32)}`);
    return r.status === 404 && r.body?.error === "NOT_FOUND";
  });
  await check("archived offer still resolves by hash with final status", async () => {
    const r = await apiCall("GET", `/v1/offers/${art.consumedHash}`);
    return r.status === 200 && r.body?.computed?.status === "consumed" && !!r.body?.offerBech32;
  });

  // ── POST /v1/offers/status ────────────────────────────────────────────────
  await check("status by blob: single, batch, junk", async () => {
    const single = await postStatusByBlob({ offer: art.liveBlob });
    if (single.body?.status !== "live") return false;
    const batch = await postStatusByBlob({ offers: [art.liveBlob, art.consumedBlob, "junkblob"] });
    const st = batch.body?.statuses;
    return (
      Array.isArray(st) &&
      st[0]?.status === "live" &&
      st[1]?.status === "consumed" &&
      st[2]?.status === "not_found" &&
      st[2]?.offerId === undefined
    );
  });
  await check("status with neither offer nor offers[] → 400 VALIDATION", async () => {
    const r = await postStatusByBlob({});
    return r.status === 400 && r.body?.error === "VALIDATION";
  });

  // ── Token registry ────────────────────────────────────────────────────────
  // Colors are deliberately NOT auto-registered at indexing: a color in an
  // offer says nothing about its name, and unshielded legs would be typed
  // wrong by construction, so registering on sight would publish guessed
  // names in a table clients use to label trades. Assert the ABSENCE — the
  // suite previously asserted the opposite because API.md promised it.
  await check("known-tokens lists NIGHT and does NOT auto-register offer colors", async () => {
    const r = await getKnownTokens();
    if (r.status !== 200 || !Array.isArray(r.body)) return false;
    const colors = new Set(r.body.map((t: any) => t.token_color ?? t.tokenColor));
    return colors.has(NIGHT) && !colors.has(ta) && !colors.has(tb);
  });

  const throwaway = "ee".repeat(32);
  const reg = await postKnownToken({ color: throwaway, name: "GRANDE2E", kind: "shielded" });
  if (reg.status === 404) {
    note("token registry", "POST disabled (NOT_ENABLED) — default config; skipping write tests");
  } else {
    ledger.apiOnlyTokenColors.push(throwaway);
    await check("register throwaway token succeeds", async () => reg.status === 200 && reg.body?.success === true);
    await check("duplicate token name → 409", async () => {
      const dup = await postKnownToken({ color: "ef".repeat(32), name: "GRANDE2E", kind: "shielded" });
      return dup.status === 409;
    });
  }

  // ── Quote ─────────────────────────────────────────────────────────────────
  await check("quote for two known colors has a coherent shape", async () => {
    const r = await getQuote({ from_token: ta, to_token: tb, from_amount: "1000000" });
    if (r.status !== 200) return false;
    const b = r.body;
    return (
      typeof b.market_rate === "number" &&
      typeof b.suggested_to_amount === "string" &&
      typeof b.implied_rate === "number" &&
      typeof b.sponsored === "boolean"
    );
  });
  // Unknown colors quote at a neutral $1 demo fallback (two unknowns ⇒ 1:1)
  // instead of 404 UNKNOWN_TOKEN, which used to wall off the demo whenever a
  // wallet held a color nobody had hand-registered. The fallback must NOT be
  // persisted: a squatted $1 row would poison the real price once the token
  // is registered later.
  await check("quote with unknown tokens → neutral $1 fallback, not 404", async () => {
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    const r = await getQuote({ from_token: a, to_token: b, from_amount: "1000000" });
    if (r.status !== 200 || r.body?.market_rate !== 1) return false;
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM token_prices WHERE token_color = $1 OR token_color = $2`,
      [a, b],
    );
    return Number(rows.rows[0]?.n) === 0; // fallback price never written
  });
  await check("quote with malformed color → 400", async () => {
    const r = await getQuote({ from_token: "nothex", to_token: tb, from_amount: "1" });
    return r.status === 400;
  });

  // ── Pairs + charts (one fill exists from p1) ─────────────────────────────
  await check("pairs endpoint reflects the p1 fill", async () => {
    const r = await getPairs();
    if (r.status !== 200 || !Array.isArray(r.body)) return false;
    return r.body.some((p: any) => Number(p.trade_count) >= 1);
  });
  await check("chart stats + history answer for the p1 pair", async () => {
    const s = await getChartStats(ta, tb);
    const h = await getChartHistory(ta, tb);
    return s.status === 200 && h.status === 200 && Array.isArray(h.body);
  });

  // ── Price orientation ────────────────────────────────────────────────────
  // Exactly one fill exists at this point (p1's settled TA→TB offer), so the
  // expected number is not a self-consistency argument — it is the maker's own
  // terms, straight out of the ledger.
  //
  // This matters because the stored pair key is LEAST||GREATEST of the hex
  // COLOR, so which side is "base" depends on the lexical ordering of a hash,
  // not on anything the maker chose. It is the likeliest place in the system
  // for a silent 1/x to reach a user's screen — and one of the two price paths
  // does exactly that (§2.2, proven in fill-vs-cancel.test.ts).
  {
    const p1 = ledger.offers.find((o) => o.index === 1);
    const expected = p1 ? Number(p1.wantAmount) / Number(p1.giveAmount) : NaN;
    const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

    await check("chart price is quote-per-base, matching the maker's own terms", async () => {
      const s = await getChartStats(ta, tb); // ta = give, tb = want
      return Number.isFinite(expected) && close(Number(s.body?.last), expected);
    }, `expected ${expected}`);

    await check("chart price inverts exactly when base and quote swap", async () => {
      const fwd = Number((await getChartStats(ta, tb)).body?.last);
      const rev = Number((await getChartStats(tb, ta)).body?.last);
      return fwd > 0 && rev > 0 && close(fwd * rev, 1);
    });

    await check("chart volumes swap with base and quote", async () => {
      const fwd = (await getChartStats(ta, tb)).body ?? {};
      const rev = (await getChartStats(tb, ta)).body ?? {};
      return (
        Number(fwd.volume_base) === Number(rev.volume_quote) &&
        Number(fwd.volume_quote) === Number(rev.volume_base)
      );
    });
  }

  // ── Midnight config ───────────────────────────────────────────────────────
  await check("midnight config exposes contract + endpoints, no secrets", async () => {
    const r = await getMidnightConfig();
    const b = r.body ?? {};
    const keys = JSON.stringify(b).toLowerCase();
    return (
      r.status === 200 &&
      !!b.contractAddress &&
      !!b.indexerUri &&
      !!b.proofServerUri &&
      !keys.includes("seed") &&
      !keys.includes("secret")
    );
  });

  // ── MIP-0006 camelCase shape guard on live responses ─────────────────────
  await check("no snake_case keys in offer list/detail payloads", async () => {
    const page = await getOffersPage({ limit: "10" });
    const detail = await apiCall("GET", `/v1/offers/${art.liveHash}`);
    return noSnakeKeys(page.body?.offers) && noSnakeKeys(detail.body);
  });

  // ── Rate limit (last — deliberately burns the budget, then cools off) ────
  await check("60 req/min rate limit answers 429 RATE_LIMITED", async () => {
    let got429 = false;
    for (let i = 0; i < 70 && !got429; i++) {
      const r = await apiCall("GET", "/v1/offers?limit=1", undefined, { storm: true });
      if (r.status === 429 && r.body?.error === "RATE_LIMITED") got429 = true;
    }
    return got429;
  });
  note("cooldown", "sleeping 65 s to refill the rate-limit window");
  await sleep(65_000);
}
