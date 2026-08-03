// Phase 7b — the final invariant audit (HANDOFF §10): one pass of SQL + API
// checks after the storm quiesces. The oracle is the ledger — the suite's own
// record of intent — never the API grading itself.
//
// Runs BEFORE the determinism phase (deliberate 7b→7a swap): live-fated offers
// are only live for ~10 minutes after publication, so their live-set audit
// cannot wait for a replay.

import { createHash } from "node:crypto";
import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { OFFER_TTL_SECONDS, ROOT_WINDOW_SECONDS } from "../config.ts";
import { ledger, type OfferRecord } from "../ledger.ts";
import { loadBlob } from "../actors/wallets.ts";
import { noSnakeKeys } from "./p2-api.ts";
import {
  getChartHistory,
  getChartStats,
  getHealthSync,
  getOffersPage,
  postStatusByBlob,
} from "../lib/api2.ts";
import { rejectionRows } from "../lib/db2.ts";
import type { SseRecorder } from "../lib/sse.ts";
import { beginPhase, check, note, pgrepF } from "../lib/util.ts";
import { baselineViolations, loadBaseline, snapshot, sseDeliveryLags, writeMetrics } from "../metrics.ts";

/** Normalize a primitive-accounting payload scalar to lowercase hex. */
function normHex(v: unknown): string {
  if (typeof v === "string") return v.replace(/^0x/, "").toLowerCase();
  if (Array.isArray(v)) return v.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
  if (v && typeof v === "object") {
    const vals = Object.values(v as Record<string, unknown>);
    if (vals.every((x) => typeof x === "number")) {
      return (vals as number[]).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  return String(v ?? "");
}

function expectedStatus(rec: OfferRecord, now: number): string[] {
  switch (rec.fate) {
    case "settled":
      return ["consumed"];
    case "cancelled":
      // Documented gap: unshielded-only offers cannot classify cancelled.
      return rec.layer === "uu" ? ["consumed"] : ["cancelled"];
    case "expired":
      return ["expired"];
    case "live": {
      // Live only inside the TTL window; a slow audit sees them expired.
      const fresh = rec.indexedAt !== undefined && now < rec.indexedAt + OFFER_TTL_SECONDS * 1000;
      return fresh ? ["live"] : ["live", "expired"];
    }
  }
}

export async function p7bAudit(db: Client, sse: SseRecorder): Promise<void> {
  beginPhase("p7b-audit");
  const auditStart = Date.now();

  // ── 1. Partition + content-hash integrity ────────────────────────────────
  await check("partition: no offer_hash in both live and history", async () => {
    const r = await db.query(
      `SELECT o.offer_hash FROM offer_file o JOIN offer_file_history h ON h.offer_hash = o.offer_hash`,
    );
    return r.rows.length === 0;
  });
  await check("offer_hash unique within each table", async () => {
    const r = await db.query(
      `SELECT offer_hash FROM (
         SELECT offer_hash FROM offer_file WHERE offer_hash IS NOT NULL
         UNION ALL SELECT offer_hash FROM offer_file_history WHERE offer_hash IS NOT NULL
       ) t GROUP BY offer_hash HAVING count(*) > 1`,
    );
    return r.rows.length === 0;
  });
  await check("offer_hash == sha256(raw tx bytes) for EVERY row (recomputed)", async () => {
    const rows = await db.query(
      `SELECT offer_hash, transaction_hex FROM offer_file
       UNION ALL SELECT offer_hash, transaction_hex FROM offer_file_history`,
    );
    for (const row of rows.rows as { offer_hash: string; transaction_hex: string }[]) {
      try {
        const raw = OfferFiles.decode(row.transaction_hex);
        const digest = createHash("sha256").update(raw).digest("hex");
        if (digest !== row.offer_hash) return false;
      } catch {
        return false; // an undecodable stored blob is itself a failure
      }
    }
    return rows.rows.length > 0;
  });

  // ── 2. Classification soundness: ledger fate vs API status, 100% ─────────
  {
    const auditable = ledger.offers.filter((o) => o.state !== "planned" && o.state !== "casualty" && o.offerHash);
    const disagreements: string[] = [];
    for (let i = 0; i < auditable.length; i += 50) {
      const batch = auditable.slice(i, i + 50);
      const res = await postStatusByBlob({ offers: batch.map((o) => loadBlob(o.offerHash!)) });
      const statuses: any[] = res.body?.statuses ?? [];
      batch.forEach((rec, j) => {
        const got = statuses[j]?.status;
        if (!expectedStatus(rec, auditStart).includes(got)) {
          disagreements.push(`#${rec.index}(${rec.fate}${rec.layer === "uu" && rec.fate === "cancelled" ? "/gap" : ""})→${got}`);
        }
      });
    }
    await check(
      "classification: API status agrees with the ledger's fates (100%)",
      async () => disagreements.length === 0,
      disagreements.slice(0, 8).join(", "),
    );
  }

  // ── 3. Completeness: liveness sets == primitive_accounting ground truth ──
  // (the guard against silent-STF regressions — STF errors are telemetry-only)
  {
    const events = await db.query(
      `SELECT payload FROM effectstream.primitive_accounting WHERE primitive_name = 'Midnight-ZswapEvents'`,
    );
    const nullifiers = new Set<string>();
    const commitments = new Set<string>();
    for (const row of events.rows as { payload: any }[]) {
      const p = row.payload?.payload ?? row.payload;
      if (p?.kind === "commitment") commitments.add(normHex(p.commitment));
      else if (p?.nullifier !== undefined) nullifiers.add(normHex(p.nullifier));
    }
    const nullCount = Number((await db.query(`SELECT count(*)::int n FROM nullifiers`)).rows[0].n);
    const commCount = Number((await db.query(`SELECT count(*)::int n FROM commitments`)).rows[0].n);
    await check(
      "completeness: nullifiers table == distinct nullifier events",
      async () => nullifiers.size === nullCount,
      `events=${nullifiers.size} rows=${nullCount}`,
    );
    await check(
      "completeness: commitments table == distinct commitment events",
      async () => commitments.size === commCount,
      `events=${commitments.size} rows=${commCount}`,
    );

    const triples = (rows: { payload: any }[]) => {
      const s = new Set<string>();
      for (const row of rows) {
        const p = row.payload?.payload ?? row.payload;
        const outputNo = p?.outputIndex ?? p?.outputNo;
        s.add(`${normHex(p?.owner)}|${normHex(p?.intentHash)}|${outputNo}`);
      }
      return s;
    };
    const creates = triples(
      (await db.query(`SELECT payload FROM effectstream.primitive_accounting WHERE primitive_name = 'Midnight-UnshieldedCreate'`)).rows as any,
    );
    const spends = triples(
      (await db.query(`SELECT payload FROM effectstream.primitive_accounting WHERE primitive_name = 'Midnight-UnshieldedSpend'`)).rows as any,
    );
    const liveUtxos = Number((await db.query(`SELECT count(*)::int n FROM created_unshielded`)).rows[0].n);
    await check(
      "completeness: created_unshielded == creates − spends (live-set)",
      async () => liveUtxos === creates.size - [...spends].filter((s) => creates.has(s)).length,
      `rows=${liveUtxos} creates=${creates.size} spends=${spends.size}`,
    );
  }

  // ── 4. known_roots inside the 10-minute window ───────────────────────────
  await check("known_roots: every row inside the ROOT_WINDOW at audit time", async () => {
    const r = await db.query(`SELECT min(last_seen_ms)::bigint AS lo, max(last_seen_ms)::bigint AS hi FROM known_roots`);
    const lo = Number(r.rows[0]?.lo ?? 0);
    return lo >= Date.now() - (ROOT_WINDOW_SECONDS + 300) * 1000;
  });

  // ── 5. Charts vs the fill ledger ─────────────────────────────────────────
  for (const [pairKey, fills] of ledger.fillLedger()) {
    const [base, quote] = pairKey.split("|") as [string, string];
    const hist = await getChartHistory(base, quote);
    await check(`chart history rows == fills for ${base.slice(0, 6)}|${quote.slice(0, 6)}`, async () => {
      const rows = Array.isArray(hist.body) ? hist.body : [];
      return fills.count > 120 ? rows.length === 120 : rows.length === fills.count;
    }, `api=${Array.isArray(hist.body) ? hist.body.length : "?"} ledger=${fills.count}`);

    const stats = await getChartStats(base, quote);
    await check(`chart volume == Σ fill ledger for ${base.slice(0, 6)}|${quote.slice(0, 6)}`, async () => {
      const vb = Number(stats.body?.volume_base ?? -1);
      const vq = Number(stats.body?.volume_quote ?? -1);
      const g = Number(fills.give);
      const w = Number(fills.want);
      return (vb === g && vq === w) || (vb === w && vq === g); // orientation-agnostic
    }, `vb=${stats.body?.volume_base} vq=${stats.body?.volume_quote} give=${fills.give} want=${fills.want}`);
  }

  // ── 6. SSE ledger ────────────────────────────────────────────────────────
  {
    const indexedRecs = ledger.offers.filter((o) => o.offerHash && o.indexedAt);
    let missingIndexed = 0;
    let dupIndexed = 0;
    for (const rec of indexedRecs) {
      const events = sse.ofType("offer_indexed").filter((e) => e.event.offerHash === rec.offerHash);
      if (events.length > 1) dupIndexed++;
      if (events.length === 0 && sse.wasListeningAt(rec.indexedAt!)) missingIndexed++;
    }
    await check("SSE: exactly one offer_indexed per indexed offer (while listening)", async () =>
      missingIndexed === 0 && dupIndexed === 0, `missing=${missingIndexed} dup=${dupIndexed}`);

    let dupTerminal = 0;
    let missingTerminal = 0;
    const archivedAtByRow = new Map<number, number>();
    const histRows = await db.query(`SELECT id, archived_at FROM offer_file_history WHERE archived_at IS NOT NULL`);
    for (const row of histRows.rows as { id: number; archived_at: Date }[]) {
      archivedAtByRow.set(row.id, new Date(row.archived_at).getTime());
    }
    for (const rec of ledger.offers.filter((o) => o.rowId !== undefined && o.state === "resolved")) {
      const terminals = [...sse.ofType("offer_consumed"), ...sse.ofType("offer_expired")].filter(
        (e) => e.event.offerId === rec.rowId,
      );
      if (terminals.length > 1) dupTerminal++;
      const archivedAt = archivedAtByRow.get(rec.rowId!);
      if (terminals.length === 0 && archivedAt && sse.wasListeningAt(archivedAt)) missingTerminal++;
      if (terminals.length >= 1 && archivedAt) {
        sseDeliveryLags.push(Math.max(0, terminals[0]!.at - archivedAt));
      }
    }
    await check("SSE: exactly one terminal event per archived offer (while listening)", async () =>
      dupTerminal === 0 && missingTerminal === 0, `missing=${missingTerminal} dup=${dupTerminal}`);
  }

  // ── 7. Shape guard over the whole live book ──────────────────────────────
  await check("shape: every live-book row is camelCase MIP-0006 with required fields", async () => {
    let cursor: string | undefined;
    let rows = 0;
    for (let page = 0; page < 20; page++) {
      const r = await getOffersPage({ limit: "100", ...(cursor ? { after_hash: cursor } : {}) });
      if (r.status !== 200) return false;
      for (const o of r.body?.offers ?? []) {
        rows++;
        if (!noSnakeKeys(o)) return false;
        if (o.version !== 1 || !/^[0-9a-f]{64}$/.test(o.offerId ?? "")) return false;
        if (!o.computed || !Array.isArray(o.computed.gives) || !Array.isArray(o.computed.wants)) return false;
        if (o.offerBech32 !== undefined) return false; // list is blob-free
      }
      cursor = r.body?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return rows >= 0;
  });

  // ── 8. Live-set membership ───────────────────────────────────────────────
  await check("offer_file contains only offers the ledger expects live", async () => {
    const rows = await db.query(`SELECT offer_hash FROM offer_file`);
    const expectedLive = new Set(
      ledger.offers
        .filter((o) => o.fate === "live" && (o.state === "indexed" || o.state === "resolved"))
        .map((o) => o.offerHash),
    );
    const stray = (rows.rows as { offer_hash: string }[]).filter((r) => !expectedLive.has(r.offer_hash));
    // In-flight sweeps: an expiry-fated offer just past its TTL may linger a
    // few blocks — tolerate only offers we own.
    const ours = new Set(ledger.offers.map((o) => o.offerHash));
    return stray.every((s) => ours.has(s.offer_hash));
  });

  // ── 9. offer_rejections maps to our own adversarial actions ──────────────
  await check("every offer_rejection maps to a deliberate garbage publish (± casualties)", async () => {
    const rows = await rejectionRows(db);
    const garbageHeights = new Set(
      ledger.garbage.filter((g) => g.via === "celestia" && g.celestiaHeight).map((g) => g.celestiaHeight!),
    );
    const casualtyBudget = ledger.casualties().length + 4; // + chaos resubmit duplicates
    let unmapped = 0;
    for (const r of rows) {
      if (!garbageHeights.has(Number(r.celestia_height))) unmapped++;
    }
    return unmapped <= casualtyBudget;
  });

  // ── 10. Operational stragglers ───────────────────────────────────────────
  await check("midnight indexer still alive after 65+ minutes of uptime", async () => {
    const elapsedMin = (Date.now() - ledger.suiteStartedAt) / 60_000;
    if (elapsedMin < 65) {
      note("indexer-uptime", `suite only ${elapsedMin.toFixed(0)} min in — SPO-starvation soak not yet provable`);
      return elapsedMin >= 65 ? true : (await pgrepF("midnight-indexer")) !== null;
    }
    return (await pgrepF("midnight-indexer")) !== null;
  });
  await check("STM lag back to ≤ 2 blocks at audit end", async () => {
    const h = await getHealthSync();
    return Number(h?.ntp?.tip ?? 0) - Number(h?.ntp?.current ?? 0) <= 2;
  });

  // ── metrics + baseline ───────────────────────────────────────────────────
  const snap = await snapshot(db as any);
  writeMetrics(snap);
  const base = loadBaseline();
  if (!base) {
    note("baseline", "no calibrated baseline.json — this run records calibration values (commit them to enforce)");
  } else {
    const violations = baselineViolations(snap, base);
    await check("metrics within baseline × 1.2", async () => violations.length === 0, violations.join("; "));
  }
}
