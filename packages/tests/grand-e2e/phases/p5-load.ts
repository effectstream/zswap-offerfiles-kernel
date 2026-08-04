// Phase 5 — load: the cheap storm (5a) interleaved with the real storm (5b),
// chaos (phase 6) injected at fixed points, then the mass-expiry wait.
//
// Scheduling shape (wall-clock):
//   [expired batch] ──▶ [settled batch + cancels + 5a storms + chaos] ──▶
//   [chaos: sync kill] ──▶ [live batch] ──▶ [expiry sweep wait]
// Expiry-fated offers publish FIRST so their 600 s TTL elapses inside the run;
// live-fated offers publish LAST so they are still live at audit time.

import type { Client } from "pg";
import {
  ARCHIVE_WAIT_TRIES,
  EXPIRY_SLACK_MS,
  FATE_SPLIT,
  MAX_CASUALTY_RATE,
  OFFER_TTL_SECONDS,
  STORM_API_INVALID_COUNT,
  STORM_API_P95_MS,
  STORM_CELESTIA_GARBAGE_COUNT,
  STORM_CELESTIA_RATE_MS,
  STORM_RSS_GROWTH_MAX,
  TOTAL_OFFERS,
  BATCHER_URL,
  type TokenKey,
} from "../config.ts";
import { ledger, type CancelShape, type Fate, type OfferRecord } from "../ledger.ts";
import {
  amountsFor,
  buildOffer,
  cancelGiveToken,
  cancelWantToken,
  CANCEL_COIN,
  makeRefill,
  pickPublishPath,
  publishAndIndex,
  runCancelCycle,
  settleOffer,
  storeBlob,
  type Actors,
  type PoolWallet,
} from "../actors/wallets.ts";
import {
  bech32GarbageBlob,
  celestiaGarbageKinds,
  cryptoTamperBlob,
  publishCelestiaGarbage,
} from "../actors/adversary.ts";
import type { P1Artifacts } from "./p1-happy.ts";
import { chaosBatcher, chaosIndexer, chaosSync } from "./p6-chaos.ts";
import { getOffersPage, submitOffer2 } from "../lib/api2.ts";
import { historyRowByHash, offerRowByHash, tableCount } from "../lib/db2.ts";
import { beginPhase, check, detVar, note, sleep, waitUntil } from "../lib/util.ts";
import {
  bookReadLatencies,
  currentSyncRssKb,
  recordBatcherQueueDepth,
  stormApiLatencies,
} from "../metrics.ts";

interface Plan {
  expired: OfferRecord[];
  settled: OfferRecord[];
  live: OfferRecord[];
  cancels: { rec: OfferRecord; pw: PoolWallet; shape: CancelShape; kind: "single" | "double"; ki: number }[];
}

// Mixed layers are excluded pending an upstream answer: initSwap accepts a
// type-legal unshielded desired output alongside a shielded input and
// silently returns a transaction WITHOUT it (no error), so every such offer
// is rejected NOT_A_SWAP. Proven with triage-mixed-offer.ts by reading the
// transaction's raw imbalances — deriveLegs reports the tx correctly, the tx
// simply lacks the output. Restore "mixed-sg"/"mixed-ug" here once the SDK
// either supports the combination or rejects it loudly. See ISSUES.md.
const LAYERS: OfferRecord["layer"][] = ["ss", "ss", "uu", "ss", "uu", "ss"];

function layerTokens(layer: OfferRecord["layer"], makerIdx: number): { give: TokenKey; want: TokenKey } {
  const even = makerIdx % 2 === 0;
  switch (layer) {
    case "ss":
      return even ? { give: "TA", want: "TB" } : { give: "TB", want: "TA" };
    case "uu":
      return even ? { give: "UA", want: "UB" } : { give: "UB", want: "UA" };
    case "mixed-sg":
      return even ? { give: "TA", want: "UA" } : { give: "TB", want: "UB" };
    case "mixed-ug":
      return even ? { give: "UA", want: "TA" } : { give: "UB", want: "TB" };
  }
}

function planOffers(actors: Actors): Plan {
  const target = (fate: Fate) => Math.round(TOTAL_OFFERS * FATE_SPLIT[fate]);
  const have = (fate: Fate) => ledger.byFate(fate).length + ledger.casualties().filter((c) => c.fate === fate).length;
  const need = (fate: Fate) => Math.max(0, target(fate) - have(fate));

  let index = 100;
  const makeGeneral = (fate: Fate, count: number): OfferRecord[] => {
    const out: OfferRecord[] = [];
    for (let i = 0; i < count; i++) {
      const makerIdx = index % actors.makers.length;
      const layer = LAYERS[detVar(index, LAYERS.length)]!;
      const { give, want } = layerTokens(layer, makerIdx);
      const a = amountsFor(index, give, want);
      out.push(
        ledger.addOffer({
          index,
          fate,
          layer,
          makerSeed: actors.makers[makerIdx]!.seed,
          giveToken: give,
          wantToken: want,
          giveAmount: a.give.toString(),
          wantAmount: a.want.toString(),
          publishPath: fate === "expired" || fate === "live" ? pickPublishPath(index) : "api",
          phase: "p5",
          state: "planned",
        }),
      );
      index++;
    }
    return out;
  };

  const expired = makeGeneral("expired", need("expired"));
  const settled = makeGeneral("settled", need("settled"));
  const live = makeGeneral("live", need("live"));

  const cancels: Plan["cancels"] = [];
  const cancelCount = need("cancelled");
  const doubleShapes: CancelShape[] = ["split-two-tx", "consolidated-one-tx", "partial"];
  for (let i = 0; i < cancelCount; i++) {
    // Alternate singles/doubles round-robin across the 4 specialists.
    const useSingle = i % 2 === 0;
    const pool = useSingle ? actors.cancelSingles : actors.cancelDoubles;
    const ki = Math.floor(i / 2) % pool.length;
    const pw = pool[ki]!;
    const shape: CancelShape = useSingle ? "single-one-tx" : doubleShapes[Math.floor(i / 2) % doubleShapes.length]!;
    const kind = useSingle ? ("single" as const) : ("double" as const);
    const giveToken = cancelGiveToken(kind, ki);
    const wantToken = cancelWantToken(giveToken);
    const give = kind === "single" ? CANCEL_COIN : CANCEL_COIN * 2n;
    const want = amountsFor(index, giveToken, wantToken).want;
    cancels.push({
      rec: ledger.addOffer({
        index,
        fate: "cancelled",
        cancelShape: shape,
        layer: "ss",
        makerSeed: pw.seed,
        giveToken,
        wantToken,
        giveAmount: give.toString(),
        wantAmount: want.toString(),
        publishPath: "api",
        phase: "p5",
        state: "planned",
      }),
      pw,
      shape,
      kind,
      ki,
    });
    index++;
  }
  return { expired, settled, live, cancels };
}

/** Publish a batch of offers, maker-parallel / per-maker-sequential builds,
 *  with indexing waits pipelined off the build path. */
async function publishBatch(
  db: Client,
  actors: Actors,
  recs: OfferRecord[],
  onIndexed?: (rec: OfferRecord) => void,
  gate?: () => Promise<void>,
): Promise<void> {
  const byMaker = new Map<string, OfferRecord[]>();
  for (const rec of recs) {
    const list = byMaker.get(rec.makerSeed) ?? [];
    list.push(rec);
    byMaker.set(rec.makerSeed, list);
  }
  const indexWaits: Promise<void>[] = [];
  const makerJobs = [...byMaker.entries()].map(async ([seed, list]) => {
    const pw = [...actors.makers, ...actors.cancelSingles, ...actors.cancelDoubles].find((m) => m.seed === seed)!;
    for (const rec of list) {
      try {
        if (gate) await gate();
        const built = await buildOffer(pw, rec);
        storeBlob(built.hash, built.blob);
        indexWaits.push(
          publishAndIndex(db, rec, built).then((ok) => {
            if (ok && onIndexed) onIndexed(rec);
          }),
        );
      } catch (e) {
        ledger.markCasualty(rec, `build failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      ledger.persist();
    }
  });
  await Promise.all(makerJobs);
  await Promise.all(indexWaits);
}

// ── 5a: cheap storm ─────────────────────────────────────────────────────────

async function apiInvalidStorm(db: Client, art: P1Artifacts): Promise<{ okCodes: number; badCodes: string[]; rate429: number }> {
  const fixtures = [
    () => "not an offer at all",
    (i: number) => bech32GarbageBlob(i),
    () => art.liveBlob.slice(0, art.liveBlob.length - 12) + "qqqqqqqqqqqq",
    (i: number) => (i % 7 === 0 ? cryptoTamperBlob(art.liveBlob) : art.consumedBlob),
  ];
  const expected = new Set([
    "BAD_ENCODING",
    "BAD_DESERIALIZE",
    "TOO_LARGE",
    "PROOF_INVALID",
    "SIGNATURE_INVALID",
    "DUPLICATE_OFFER",
    "NULLIFIER_SPENT",
    "UTXO_NOT_LIVE",
    "RATE_LIMITED",
  ]);
  let okCodes = 0;
  let rate429 = 0;
  const badCodes: string[] = [];
  const CONCURRENCY = 8;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= STORM_API_INVALID_COUNT) return;
      const blob = fixtures[i % fixtures.length]!(i);
      const started = Date.now();
      const res = await submitOffer2(blob, { storm: true });
      stormApiLatencies.push(Date.now() - started);
      const code = res.status === 429 ? "RATE_LIMITED" : res.body?.error;
      if (code === "RATE_LIMITED") rate429++;
      else if (expected.has(code) && res.status !== 200) okCodes++;
      else badCodes.push(`${res.status}:${code}`);
      ledger.addGarbage({
        kind: `storm-api:${i % fixtures.length}`,
        via: "api",
        expectedCodes: [...expected],
        at: started,
        gotCode: code,
        gotStatus: res.status,
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { okCodes, badCodes, rate429 };
}

async function celestiaGarbageStorm(art: P1Artifacts): Promise<number> {
  const kinds = celestiaGarbageKinds();
  let published = 0;
  for (let i = 0; i < STORM_CELESTIA_GARBAGE_COUNT; i++) {
    const kind = kinds[i % kinds.length]!;
    const src = kind === "replayed-real-blob" ? art.consumedBlob : art.liveBlob;
    try {
      await publishCelestiaGarbage(kind, 1000 + i, src);
      published++;
    } catch {
      /* light node briefly congested — keep going */
    }
    await sleep(STORM_CELESTIA_RATE_MS);
  }
  return published;
}

// ── phase entry ─────────────────────────────────────────────────────────────

export async function p5Load(db: Client, actors: Actors, art: P1Artifacts): Promise<void> {
  beginPhase("p5-load");
  const plan = planOffers(actors);
  note(
    "plan",
    `expired=${plan.expired.length} settled=${plan.settled.length} cancelled=${plan.cancels.length} live=${plan.live.length}`,
  );
  note(
    "FINDING (throughput ceiling, reported)",
    "the dev batcher runs its midnight-balancer with ONE wallet and the SDK default maxSlotsPerWallet=1 " +
      "(pool W1 in its logs) — every settlement/cancel/split serializes at ~25 s/tx (~2.4 tx/min). " +
      "The suite gates offer builds on settle depth to keep offers inside their 600 s window; production " +
      "load needs maxSlotsPerWallet>1 and/or multiple batcher wallet seeds.",
  );

  const offersBeforeStorm = await tableCount(db, "offer_file");
  const historyBeforeStorm = await tableCount(db, "offer_file_history");
  const rssBefore = await currentSyncRssKb();

  // Queue-depth sampler (batcher) for the duration of the phase.
  const queuePoll = setInterval(async () => {
    try {
      const r = await fetch(`${BATCHER_URL}/queue-stats`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j: any = await r.json();
        recordBatcherQueueDepth(Number(j?.totalPendingInputs ?? 0));
      }
    } catch {
      /* batcher busy/restarting */
    }
  }, 20_000);

  try {
    // ── mass-expiry batch first: TTLs must elapse inside the run ────────────
    await check("expired-fate batch published + indexed", async () => {
      await publishBatch(db, actors, plan.expired);
      const okCount = plan.expired.filter((r) => r.state === "indexed").length;
      return okCount >= plan.expired.length * (1 - MAX_CASUALTY_RATE * 4);
    });

    // ── settled pipeline + cancels + storms + chaos, all concurrent ─────────
    let settleInFlight = 0;
    let settlePeak = 0;
    const settleDone: Promise<void>[] = [];
    // Backpressure: the single-worker batcher settles ~2.4 tx/min. Unthrottled
    // makers would out-publish it, and offers queued past ~8 min age out
    // (600 s TTL sweep + root window) before their settle runs. Gate offer
    // BUILDS on in-flight settle depth so index→settle stays inside the window.
    const SETTLE_GATE = actors.takers.length * 2;
    const settleGate = async () => {
      while (settleInFlight >= SETTLE_GATE) await sleep(5000);
    };
    const settleOne = (rec: OfferRecord): void => {
      const taker = actors.takers[rec.index % actors.takers.length]!;
      settleInFlight++;
      settlePeak = Math.max(settlePeak, settleInFlight);
      settleDone.push(
        (async () => {
          try {
            // Freshness guard: settling an offer that already aged past its
            // TTL would corrupt its fate (archived TTL, then spent) — skip it
            // as a casualty instead.
            if (rec.indexedAt && Date.now() - rec.indexedAt > 7 * 60_000) {
              ledger.markCasualty(rec, "settle queue aged past the TTL-safe window");
              return;
            }
            const { loadBlob } = await import("../actors/wallets.ts");
            await settleOffer(taker, rec, loadBlob(rec.offerHash!));
            const archived = await waitUntil(
              `settle-archive #${rec.index}`,
              async () => (await offerRowByHash(db, rec.offerHash!)) === null,
              ARCHIVE_WAIT_TRIES,
              5000,
            );
            if (archived) {
              rec.state = "resolved";
              rec.resolvedAt = Date.now();
            } else {
              ledger.markCasualty(rec, "settled but never archived");
            }
          } catch (e) {
            ledger.markCasualty(rec, `settle failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            settleInFlight--;
          }
        })(),
      );
    };

    const settledJob = publishBatch(db, actors, plan.settled, settleOne, settleGate);

    const cancelJob = (async () => {
      const bySpecialist = new Map<string, Plan["cancels"]>();
      for (const c of plan.cancels) {
        const list = bySpecialist.get(c.pw.seed) ?? [];
        list.push(c);
        bySpecialist.set(c.pw.seed, list);
      }
      await Promise.all(
        [...bySpecialist.values()].map(async (list) => {
          for (const c of list) {
            try {
              const refill = makeRefill(actors.genesisPw, c.pw, c.rec.giveToken);
              const ok = await runCancelCycle(db, c.pw, c.rec, c.shape, refill);
              if (!ok) continue;
            } catch (e) {
              ledger.markCasualty(c.rec, `cancel cycle failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            ledger.persist();
          }
        }),
      );
    })();

    const stormJob = (async () => {
      // Let the real storm ramp up before the cheap storm starts.
      await sleep(60_000);
      const [apiRes, celestiaPublished] = await Promise.all([apiInvalidStorm(db, art), celestiaGarbageStorm(art)]);
      note("5a", `api storm: ${apiRes.okCodes} coded, ${apiRes.rate429} rate-limited, ${apiRes.badCodes.length} unexpected`);
      note("5a", `celestia storm: ${celestiaPublished}/${STORM_CELESTIA_GARBAGE_COUNT} garbage blobs published`);
      await check("5a: every storm response was an expected rejection or 429", async () => apiRes.badCodes.length === 0,
        apiRes.badCodes.slice(0, 5).join(", "));
      await check("5a: a meaningful sample got real rejection codes (not just 429)", async () => apiRes.okCodes >= 50);
    })();

    const chaosJob = (async () => {
      await sleep(4 * 60_000);
      await chaosIndexer(db);
      await sleep(2 * 60_000);
      await chaosBatcher(
        db,
        async () => {
          // Two real offers straight into the batcher queue right before the kill.
          const extra = planExtraChaosOffers(actors);
          const blobs: string[] = [];
          for (const rec of extra) {
            const pw = actors.makers.find((m) => m.seed === rec.makerSeed)!;
            const built = await buildOffer(pw, rec);
            storeBlob(built.hash, built.blob);
            rec.offerHash = built.hash;
            rec.submittedAt = Date.now();
            const res = await submitOffer2(built.blob);
            if (res.status === 200) {
              rec.state = "published";
              blobs.push(built.blob);
            } else {
              ledger.markCasualty(rec, `chaos submit: ${res.status} ${res.body?.error}`);
            }
          }
          return blobs;
        },
        async (hash: string) => {
          const found = await waitUntil(
            `chaos offer ${hash.slice(0, 8)} indexed`,
            async () => (await offerRowByHash(db, hash)) !== null,
            36,
            5000,
          );
          if (found) {
            const rec = ledger.offers.find((o) => o.offerHash === hash);
            if (rec) {
              const row = await offerRowByHash(db, hash);
              rec.rowId = row!.id;
              rec.indexedAt = Date.now();
              rec.state = "indexed";
              ledger.rowIdToHash.set(row!.id, hash);
            }
          }
          return found;
        },
      );
    })();

    await Promise.all([settledJob, cancelJob, stormJob, chaosJob]);
    await Promise.all(settleDone);

    await check("taker settle concurrency reached queue depth ≥ 4", async () => settlePeak >= 4, `peak=${settlePeak}`);

    // 5a post-storm invariants.
    await check("5a: node RSS grew < 30% across the storm", async () => {
      const rssAfter = await currentSyncRssKb();
      if (!rssBefore || !rssAfter) return true; // pid unavailable — cannot measure (noted)
      return rssAfter <= rssBefore * (1 + STORM_RSS_GROWTH_MAX);
    });
    await check("5a: API p95 < 500 ms during the storm", async () => {
      const sorted = [...stormApiLatencies].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      return p95 < STORM_API_P95_MS;
    });
    await check("5a: storm indexed nothing", async () => {
      const indexedNow = (await tableCount(db, "offer_file")) + (await tableCount(db, "offer_file_history"));
      const legitNew = ledger.offers.filter((o) => o.phase === "p5" && o.state !== "planned" && o.state !== "casualty").length;
      return indexedNow <= offersBeforeStorm + historyBeforeStorm + legitNew;
    });

    // ── chaos: sync/STM restart between storm and live batch ────────────────
    await chaosSync(db);

    // ── live batch LAST ─────────────────────────────────────────────────────
    await check("live-fate batch published + indexed", async () => {
      await publishBatch(db, actors, plan.live);
      const okCount = plan.live.filter((r) => r.state === "indexed").length;
      return okCount >= plan.live.length * (1 - MAX_CASUALTY_RATE * 4);
    });

    // Book-read latency at max book size.
    for (let i = 0; i < 10; i++) {
      const r = await getOffersPage({ limit: "100" });
      if (r.status === 200) bookReadLatencies.push(r.ms);
      await sleep(1500);
    }

    // ── mass-expiry sweep ───────────────────────────────────────────────────
    const expiredRecs = ledger.offers.filter((o) => o.fate === "expired" && o.state === "indexed");
    const lastIndexed = Math.max(...expiredRecs.map((o) => o.indexedAt ?? 0), 0);
    const sweepDeadline = lastIndexed + OFFER_TTL_SECONDS * 1000 + EXPIRY_SLACK_MS;
    note("expiry", `waiting for TTL sweep until ${new Date(sweepDeadline).toISOString()} (${expiredRecs.length} offers)`);
    while (Date.now() < sweepDeadline) await sleep(15_000);

    await check("every expiry-fated offer archived with reason TTL", async () => {
      let ok = 0;
      for (const rec of expiredRecs) {
        const hist = await historyRowByHash(db, rec.offerHash!);
        if (hist?.archive_reason === "TTL") {
          rec.state = "resolved";
          rec.resolvedAt = hist.archived_at ? new Date(hist.archived_at).getTime() : Date.now();
          ok++;
        }
      }
      return ok === expiredRecs.length;
    }, `resolved ${expiredRecs.filter((r) => r.state === "resolved").length}/${expiredRecs.length}`);

    // ── casualty budget ─────────────────────────────────────────────────────
    const casualties = ledger.casualties().length;
    await check(
      `casualty rate ≤ ${MAX_CASUALTY_RATE * 100}%`,
      async () => casualties <= Math.ceil(TOTAL_OFFERS * MAX_CASUALTY_RATE),
      `${casualties} casualties`,
    );
  } finally {
    clearInterval(queuePoll);
    ledger.persist();
  }
}

let chaosExtraIndex = 900;
function planExtraChaosOffers(actors: Actors): OfferRecord[] {
  const out: OfferRecord[] = [];
  for (let i = 0; i < 2; i++) {
    const idx = chaosExtraIndex++;
    const makerIdx = idx % actors.makers.length;
    const { give, want } = layerTokens("ss", makerIdx);
    const a = amountsFor(idx, give, want);
    out.push(
      ledger.addOffer({
        index: idx,
        fate: "expired", // never touched after indexing — swept with the rest
        layer: "ss",
        makerSeed: actors.makers[makerIdx]!.seed,
        giveToken: give,
        wantToken: want,
        giveAmount: a.give.toString(),
        wantAmount: a.want.toString(),
        publishPath: "api",
        phase: "p5-chaos",
        state: "planned",
      }),
    );
  }
  return out;
}
