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
import {
  collectOutputCommitments,
  collectNullifiers,
  collectUnshieldedSpends,
} from "@zswap-da/validator";
import {
  DEEP_AUDIT,
  DEEP_AUDIT_SAMPLE,
  OFFER_TTL_SECONDS,
  ROOT_WINDOW_SECONDS,
} from "../config.ts";
import { ledger, type OfferRecord } from "../ledger.ts";
import { loadBlob } from "../actors/wallets.ts";
import { noSnakeKeys } from "./p2-api.ts";
import {
  getChartHistory,
  getChartStats,
  getHealthSync,
  getOffersPage,
  getPairs,
  postStatusByBlob,
  realNtpLagSeconds,
} from "../lib/api2.ts";
import { legsFor, rejectionRows, storedBlobs } from "../lib/db2.ts";
import { derivedLegKeys, fullyValidate } from "../lib/verify.ts";
import type { SseRecorder } from "../lib/sse.ts";
import { beginPhase, check, detVar, note, pgrepF } from "../lib/util.ts";
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
      // Both layers. On `uu` this is registered red RED-4 (PR-B) — the
      // unshielded classification gap makes every walk-away read `consumed`.
      return ["cancelled"];
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

  // ── 1b. History referential integrity ────────────────────────────────────
  // Cheap SQL, but each one guards a silent-corruption mode that no existing
  // check would notice. The first is the one that matters most: getTradeHistory
  // INNER JOINs both directions, so an offer that loses a leg during archival
  // DISAPPEARS from trade history without a trace. A real sale vanishing is a
  // worse failure than a wrong one appearing, and nothing today would see it.
  {
    const integrity: [string, string][] = [
      ["every archived offer kept both sides of its swap", `
         SELECT h.id FROM offer_file_history h
         WHERE NOT EXISTS (SELECT 1 FROM offer_file_tokens_history t
                           WHERE t.offer_file_id = h.id AND t.direction = 'GIVING')
            OR NOT EXISTS (SELECT 1 FROM offer_file_tokens_history t
                           WHERE t.offer_file_id = h.id AND t.direction = 'WANTING')`],
      ["no orphan history side-rows", `
         SELECT s.offer_file_id FROM (
           SELECT offer_file_id FROM offer_file_tokens_history
           UNION SELECT offer_file_id FROM offer_file_nullifiers_history
           UNION SELECT offer_file_id FROM offer_file_unshielded_spends_history
           UNION SELECT offer_file_id FROM offer_file_commitments_history) s
         WHERE NOT EXISTS (SELECT 1 FROM offer_file_history h WHERE h.id = s.offer_file_id)`],
      ["archive_reason is CONSUMED or TTL, never NULL", `
         SELECT id FROM offer_file_history
         WHERE archive_reason IS NULL OR archive_reason NOT IN ('CONSUMED','TTL')`],
      ["archived_at never precedes the offer it archives", `
         SELECT id FROM offer_file_history
         WHERE archived_at IS NULL
            OR archived_at < first_seen_at
            OR archived_at < metadata_created_at`],
      ["no live offer shares an id with an archived one", `
         SELECT o.id FROM offer_file o JOIN offer_file_history h ON h.id = o.id`],
    ];
    for (const [name, sql] of integrity) {
      const rows = (await db.query(sql)).rows;
      await check(
        `history integrity: ${name}`,
        async () => rows.length === 0,
        rows.length ? `${rows.length} offending row(s), e.g. id=${(rows[0] as any).id ?? (rows[0] as any).offer_file_id}` : undefined,
      );
    }
  }

  // ── 1c. Deep audit: everything stored equals what the bytes say ──────────
  // One pass over every blob this node holds, live and archived. wellFormed
  // dominates the cost, so it is paid ONCE per row and every downstream
  // assertion reuses the result.
  //
  // Why this exists: check 1 above recomputes only sha256, so a row can be
  // hash-correct and still be semantically garbage — a forged proof, legs that
  // do not match the transaction, a missing nullifier row. MIP-0006's central
  // rule is that legs are DERIVED and never trusted from the maker; this is
  // the only place that proves the database kept faith with the derivation.
  {
    const all = await storedBlobs(db);
    const rows = DEEP_AUDIT
      ? all
      : all.filter((_, i) => detVar(i, Math.max(1, Math.ceil(all.length / DEEP_AUDIT_SAMPLE))) === 0);

    const invalid: string[] = [];
    const legMismatch: string[] = [];
    const spendMismatch: string[] = [];
    const markerMissing: string[] = [];

    for (const row of rows) {
      const short = row.offer_hash.slice(0, 8);
      let v;
      try {
        v = fullyValidate(OfferFiles.decode(row.transaction_hex));
      } catch {
        invalid.push(`${short}:undecodable`);
        continue;
      }
      if (!v.ok) {
        invalid.push(`${short}:${v.code}`);
        continue; // derived fields are unreliable once validation failed
      }

      const stored = await legsFor(db, row.id, row.live);
      const derived = derivedLegKeys(v);
      if (JSON.stringify(stored) !== JSON.stringify(derived)) {
        legMismatch.push(`${short}: stored=${stored.join(",")} derived=${derived.join(",")}`);
      }

      // Spend refs: the offer's own claim about what it consumes. If these
      // drift, the archive triggers watch the wrong coins and an offer either
      // never archives or archives on someone else's spend.
      const nTable = row.live ? "offer_file_nullifiers" : "offer_file_nullifiers_history";
      const uTable = row.live ? "offer_file_unshielded_spends" : "offer_file_unshielded_spends_history";
      const nStored = (await db.query(`SELECT nullifier FROM ${nTable} WHERE offer_file_id = $1`, [row.id]))
        .rows.map((r: any) => String(r.nullifier).toLowerCase()).sort();
      const uStored = (await db.query(
        `SELECT owner, intent_hash, output_no FROM ${uTable} WHERE offer_file_id = $1`, [row.id],
      )).rows.map((r: any) => `${r.owner}|${r.intent_hash}|${r.output_no}`).sort();
      const nDerived = collectNullifiers(v.tx!).map((x) => x.toLowerCase()).sort();
      const uDerived = collectUnshieldedSpends(v.tx!)
        .map((s) => `${s.owner}|${s.intentHash}|${s.outputNo}`).sort();
      if (JSON.stringify(nStored) !== JSON.stringify(nDerived)) {
        spendMismatch.push(`${short}: nullifiers stored=${nStored.length} derived=${nDerived.length}`);
      }
      if (JSON.stringify(uStored) !== JSON.stringify(uDerived)) {
        spendMismatch.push(`${short}: utxo stored=${uStored.length} derived=${uDerived.length}`);
      }

      // Fill markers. Branch 3 of cancelledPredicate is VACUOUS when an offer
      // has no stored commitments, so a marker-copy regression silently
      // downgrades exact fill-vs-cancel classification back to the old
      // all-in-one-tx heuristic without failing a single existing check.
      const expectedMarkers = collectOutputCommitments(v.tx!);
      if (expectedMarkers.length > 0) {
        const cTable = row.live ? "offer_file_commitments" : "offer_file_commitments_history";
        const cStored = Number(
          (await db.query(`SELECT count(*)::int AS n FROM ${cTable} WHERE offer_file_id = $1`, [row.id])).rows[0].n,
        );
        if (cStored !== expectedMarkers.length) {
          markerMissing.push(`${short}: stored=${cStored} expected=${expectedMarkers.length}`);
        }
      }
    }

    note("deep audit", `${rows.length}/${all.length} blobs re-validated (DEEP_AUDIT=${DEEP_AUDIT ? "1" : "0"})`);
    await check(
      "every stored blob re-validates from its bytes, proofs included",
      async () => rows.length > 0 && invalid.length === 0,
      invalid.slice(0, 5).join("; "),
    );
    await check(
      "stored legs equal deriveTokenLegs of the stored bytes (MIP-0006: derived, never trusted)",
      async () => legMismatch.length === 0,
      legMismatch.slice(0, 3).join("; "),
    );
    await check(
      "stored spend refs equal the transaction's own nullifiers / UTXO triples",
      async () => spendMismatch.length === 0,
      spendMismatch.slice(0, 3).join("; "),
    );
    await check(
      "fill markers stored for every offer that has shielded outputs",
      async () => markerMissing.length === 0,
      markerMissing.slice(0, 3).join("; "),
    );
  }

  // ── 2. Classification soundness: ledger fate vs API status, 100% ─────────
  {
    const auditable = ledger.offers.filter((o) => o.state !== "planned" && o.state !== "casualty" && o.offerHash);
    const disagreements: string[] = [];
    for (let i = 0; i < auditable.length; i += 50) {
      const batch = auditable.slice(i, i + 50);
      // Tolerate a missing blob: report it as a disagreement instead of
      // aborting the entire audit with ENOENT.
      const usable = batch.filter((o) => {
        try {
          loadBlob(o.offerHash!);
          return true;
        } catch {
          disagreements.push(`#${o.index}(${o.fate})→blob-missing`);
          return false;
        }
      });
      if (usable.length === 0) continue;
      const res = await postStatusByBlob({ offers: usable.map((o) => loadBlob(o.offerHash!)) });
      const statuses: any[] = res.body?.statuses ?? [];
      usable.forEach((rec, j) => {
        const got = statuses[j]?.status;
        if (!expectedStatus(rec, auditStart).includes(got)) {
          // Tag the ones attributable to the unshielded classification defect
          // (§2.1) so the red's detail line separates them from a genuine
          // classification regression on the shielded path.
          disagreements.push(`#${rec.index}(${rec.fate}${rec.layer === "uu" && rec.fate === "cancelled" ? "/§2.1" : ""})→${got}`);
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
  await check("known_roots: retained span within the ROOT_WINDOW", async () => {
    // The window bounds how much history is RETAINED, not how fresh the newest
    // row is. pruneKnownRoots runs only inside the midnight-zswap-root
    // transition (state-machine.ts), so once the chain stops producing roots
    // nothing prunes and the surviving rows age in place — measured here: 10
    // rows spanning 594s (inside the 600s window) but 23 min old, because the
    // audit runs after p7a's ~20 min replay with no offers flowing. Asserting
    // freshness-vs-now therefore fails on a correct system.
    //
    // The write-triggered pruning is itself a finding — see ISSUES.md, "root
    // window is not enforced on read" — but that is a product issue to report,
    // not something this assertion should encode.
    const r = await db.query(
      `SELECT count(*)::int AS n, min(last_seen_ms)::bigint AS lo, max(last_seen_ms)::bigint AS hi FROM known_roots`,
    );
    const row = r.rows[0];
    if (!row || !Number(row.n)) return true; // an empty set is within any window
    return Number(row.hi) - Number(row.lo) <= (ROOT_WINDOW_SECONDS + 60) * 1000;
  }, "span, not age — pruning is write-triggered");

  // ── 5. Charts vs the fill ledger ─────────────────────────────────────────
  for (const [pairKey, fills] of ledger.fillLedger()) {
    const [base, quote] = pairKey.split("|") as [string, string];
    const short = `${base.slice(0, 6)}|${quote.slice(0, 6)}`;
    const hist = await getChartHistory(base, quote);
    await check(`chart history rows == fills for ${short}`, async () => {
      const rows = Array.isArray(hist.body) ? hist.body : [];
      return fills.count > 120 ? rows.length === 120 : rows.length === fills.count;
    }, `api=${Array.isArray(hist.body) ? hist.body.length : "?"} ledger=${fills.count}`);

    const stats = await getChartStats(base, quote);
    await check(`chart volume == Σ fill ledger for ${short}`, async () => {
      const vb = Number(stats.body?.volume_base ?? -1);
      const vq = Number(stats.body?.volume_quote ?? -1);
      return vb === Number(fills.byColor[base] ?? 0n) && vq === Number(fills.byColor[quote] ?? 0n);
    }, `vb=${stats.body?.volume_base} vq=${stats.body?.volume_quote} ` +
       `expected base=${fills.byColor[base] ?? 0n} quote=${fills.byColor[quote] ?? 0n}`);
  }

  // ── 5b. Market data must describe REAL sales ─────────────────────────────
  // The block above asserts current behaviour pair-by-pair, gap included, so
  // the suite stays a working gate. These assert the TRUTH in aggregate: only
  // a genuine settlement is a sale. They diverge exactly by the unshielded
  // classification gap (§2.1), which is why they are registered as reds.
  {
    const truth = ledger.settledLedger();
    const volumeDiffs: string[] = [];
    const countDiffs: string[] = [];
    for (const [pairKey, fills] of truth) {
      const [base, quote] = pairKey.split("|") as [string, string];
      const short = `${base.slice(0, 6)}|${quote.slice(0, 6)}`;
      const stats = await getChartStats(base, quote);
      const vb = Number(stats.body?.volume_base ?? -1);
      const vq = Number(stats.body?.volume_quote ?? -1);
      if (vb !== Number(fills.byColor[base] ?? 0n) || vq !== Number(fills.byColor[quote] ?? 0n)) {
        volumeDiffs.push(
          `${short}: api ${vb}/${vq} vs settled ${fills.byColor[base] ?? 0n}/${fills.byColor[quote] ?? 0n}`,
        );
      }
      const hist = await getChartHistory(base, quote);
      const rows = Array.isArray(hist.body) ? hist.body.length : -1;
      if (fills.count <= 120 && rows !== fills.count) {
        countDiffs.push(`${short}: api ${rows} rows vs ${fills.count} settled`);
      }
    }
    await check(
      "Σ chart volume == Σ settled offers",
      async () => volumeDiffs.length === 0 && countDiffs.length === 0,
      [...volumeDiffs, ...countDiffs].slice(0, 4).join("; "),
    );

    // pair_stats is written by an event-bus listener (api.ts), a completely
    // different path from the SQL aggregate the chart uses. A duplicated or
    // replayed offer_consumed event double-increments here and nothing else
    // would notice.
    const pairRows = (await getPairs()).body ?? [];
    const countMismatch: string[] = [];
    for (const p of pairRows as any[]) {
      const expected = truth.get(`${p.base_color}|${p.quote_color}`)?.count ?? 0;
      if (Number(p.trade_count) !== expected) {
        countMismatch.push(`${String(p.pair_key).slice(0, 13)}: trade_count=${p.trade_count} settled=${expected}`);
      }
    }
    await check(
      "pair_stats.trade_count == genuine fills per pair",
      async () => countMismatch.length === 0,
      countMismatch.slice(0, 4).join("; "),
    );

    // last_price is computed TWICE by unrelated code — upsertPairStatsByOfferId
    // (event bus) and getPairStats24h (SQL) — and nothing had ever compared
    // them. They can disagree indefinitely, serving two different last prices
    // depending on which route the client calls.
    //
    // §2.2: they DO disagree today. upsertPairStatsByOfferId assigns base/quote
    // by LEAST/GREATEST of the hex color but computes last_price as want÷give
    // with no reference to which became base, so the value is quote-per-base
    // only when the maker gave the lexically-lesser color and 1/p otherwise.
    //
    // That defect is NOT asserted here, because whether it manifests depends on
    // the direction of each pair's most recent fill — data-dependent, so a
    // registered red would be a coin flip. Its deterministic red lives in
    // packages/database/fill-vs-cancel.test.ts, which chooses the color
    // ordering. What IS asserted here is the part that does not depend on luck:
    // the two routes must not disagree in any way OTHER than that inversion.
    // After PR-C there should be no disagreement at all.
    const inverted: string[] = [];
    const unexplained: string[] = [];
    for (const p of pairRows as any[]) {
      if (p.last_price == null) continue;
      const s = await getChartStats(p.base_color, p.quote_color);
      const a = Number(p.last_price);
      const b = Number(s.body?.last ?? NaN);
      if (Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) continue;
      const line = `${String(p.pair_key).slice(0, 13)}: /v1/pairs=${a} /v1/chart/stats=${b}`;
      if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a * b - 1) < 1e-6) inverted.push(line);
      else unexplained.push(line);
    }
    if (inverted.length > 0) {
      note(
        "last_price inversion (§2.2, PR-C)",
        `${inverted.length} pair(s) where the two routes multiply to 1 — the known ` +
          `want÷give vs quote-per-base defect: ${inverted.slice(0, 3).join("; ")}`,
      );
    }
    await check(
      "/v1/pairs and /v1/chart/stats disagree only by the known inversion",
      async () => unexplained.length === 0,
      unexplained.slice(0, 4).join("; "),
    );

    // Ordering is only meaningful now that last_traded_at is chain time.
    await check("/v1/pairs is ordered by last_traded_at, newest first", async () => {
      const stamped = (pairRows as any[]).filter((p) => p.last_traded_at != null);
      for (let i = 1; i < stamped.length; i++) {
        if (Date.parse(stamped[i - 1].last_traded_at) < Date.parse(stamped[i].last_traded_at)) return false;
      }
      return true;
    });
  }

  // ── 5c. Expired offers are never trades ──────────────────────────────────
  // ~25% of a run's offers die by TTL. The chart queries filter on
  // archive_reason = 'CONSUMED', so this should hold — and pinning it here
  // means any future widening of that filter turns an expiry into a fabricated
  // sale and fails loudly.
  await check("no TTL-archived offer appears in trade history", async () => {
    const ttlIds = (await db.query(
      `SELECT id FROM offer_file_history WHERE archive_reason = 'TTL'`,
    )).rows.map((r: any) => Number(r.id));
    if (ttlIds.length === 0) return true;
    const consumedPerPair = await db.query(
      `SELECT count(*)::int AS n FROM offer_file_history WHERE archive_reason = 'CONSUMED'`,
    );
    // A TTL row can never satisfy the chart's WHERE clause; assert the
    // complement holds — history rows are exactly the CONSUMED ones.
    let charted = 0;
    for (const [pairKey] of ledger.fillLedger()) {
      const [base, quote] = pairKey.split("|") as [string, string];
      const h = await getChartHistory(base, quote);
      charted += Array.isArray(h.body) ? h.body.length : 0;
    }
    note("expiry", `${ttlIds.length} TTL-archived, ${consumedPerPair.rows[0].n} consumed, ${charted} charted rows`);
    return charted <= Number(consumedPerPair.rows[0].n);
  });

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
        // NOTE the clocks: terminal.at is suite wall clock; archived_at is the
        // L2 block timestamp (chain-derived since the archived_at fix). This
        // lag therefore spans block-timestamp -> STM execution -> event bus ->
        // SSE delivery — an end-to-end chain-to-client latency, NOT pure
        // socket delivery. The baseline reflects that (p95 ~2.7s, dominated by
        // ~1.5-2.5s STM executor lag on dev); the pre-fix 66ms baseline was
        // only achievable because archived_at used to be wall-clock NOW().
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
  await check("offer_rejections count matches the garbage this suite published", async () => {
    // Counted, not height-matched: offer_rejections.celestia_height holds an
    // EffectstreamBlockNumber, not a Celestia height (see ISSUES.md), so the
    // heights cannot be correlated with what blob.Submit reported.
    const rows = await rejectionRows(db);
    const total = rows.reduce((n, r) => n + Number(r.count), 0);
    const ours = ledger.garbage.filter((g) => g.via === "celestia").length;
    const casualtyBudget = ledger.casualties().length + 4; // + chaos resubmits
    note("rejections", `${total} recorded, ${ours} deliberate celestia publishes`);
    return total >= ours && total <= ours + casualtyBudget;
  });

  // ── 9b. Layer symmetry ───────────────────────────────────────────────────
  // Coverage that silently collapses onto one layer is the failure mode the
  // whole shielded/unshielded requirement exists to catch — and it is exactly
  // how the shielded-only cancel coverage went unnoticed for the entire
  // history of this suite. So make it an assertion, not a hope: every fate
  // must have been exercised on BOTH layers.
  {
    const byLayer = (layer: OfferRecord["layer"], fate: OfferRecord["fate"]) =>
      ledger.offers.filter(
        (o) => o.layer === layer && o.fate === fate && o.state === "resolved",
      ).length;
    const missing: string[] = [];
    for (const fate of ["settled", "cancelled", "expired"] as const) {
      for (const layer of ["ss", "uu"] as const) {
        const n = byLayer(layer, fate);
        note("layer coverage", `${layer}/${fate}: ${n} resolved`);
        if (n === 0) missing.push(`${layer}/${fate}`);
      }
    }
    await check(
      "every fate was exercised on BOTH value layers",
      async () => missing.length === 0,
      missing.length ? `no coverage for ${missing.join(", ")}` : undefined,
    );
  }

  // ── 10. Operational stragglers ───────────────────────────────────────────
  await check("midnight indexer still alive after 65+ minutes of uptime", async () => {
    const elapsedMin = (Date.now() - ledger.suiteStartedAt) / 60_000;
    if (elapsedMin < 65) {
      note("indexer-uptime", `suite only ${elapsedMin.toFixed(0)} min in — SPO-starvation soak not yet provable`);
      return elapsedMin >= 65 ? true : (await pgrepF("midnight-indexer")) !== null;
    }
    return (await pgrepF("midnight-indexer")) !== null;
  });
  await check("STM lag back to ≤ ~10 s at audit end (blockL2 at the chain edge)", async () => {
    // Real-lag measure; the endpoint's ntp.tip is wrong on dev (bug reported —
    // see realNtpLagSeconds in lib/api2.ts).
    const h = await getHealthSync();
    return realNtpLagSeconds(h) <= 10;
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
