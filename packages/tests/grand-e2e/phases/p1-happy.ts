// Phase 1 — happy paths, both publication routes:
//   1.x  maker → POST /v1/offers → batcher → Celestia → indexed → read back →
//        reconstruct → settle → archived CONSUMED
//   1.4  maker → direct blob.Submit (raw bytes) → indexed identically
//
// Leaves one live offer standing (the direct-Celestia one) for p2/p4 to use;
// it is fated `expired` and will be swept by the TTL later in the run.

import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { OFFER_TTL_SECONDS, ARCHIVE_WAIT_TRIES } from "../config.ts";
import { ledger, type OfferRecord } from "../ledger.ts";
import type { Actors } from "../actors/wallets.ts";
import {
  amountsFor,
  buildOffer,
  publishAndIndex,
  settleOffer,
  storeBlob,
} from "../actors/wallets.ts";
import { getOfferByHash, getOffersPage, getOfferStatus } from "../lib/api2.ts";
import { historyRowByHash, offerRowByHash } from "../lib/db2.ts";
import type { SseRecorder } from "../lib/sse.ts";
import { beginPhase, check, note, waitUntil } from "../lib/util.ts";

export interface P1Artifacts {
  liveBlob: string; // direct-Celestia offer, still live at p2/p4
  liveHash: string;
  consumedBlob: string; // API-path offer, settled
  consumedHash: string;
}

export async function p1Happy(db: Client, actors: Actors, sse: SseRecorder): Promise<P1Artifacts | null> {
  beginPhase("p1-happy");
  const m0 = actors.makers[0]!;
  const m1 = actors.makers[1]!;
  const taker = actors.takers[0]!;

  // ── API-path offer (settled fate) ─────────────────────────────────────────
  const a = amountsFor(1, "TA", "TB");
  const recA: OfferRecord = ledger.addOffer({
    index: 1,
    fate: "settled",
    layer: "ss",
    makerSeed: m0.seed,
    giveToken: "TA",
    wantToken: "TB",
    giveAmount: a.give.toString(),
    wantAmount: a.want.toString(),
    publishPath: "api",
    phase: "p1",
    state: "planned",
  });
  const builtA = await buildOffer(m0, recA);
  storeBlob(builtA.hash, builtA.blob);
  await check("API-path offer accepted + indexed", () => publishAndIndex(db, recA, builtA));
  if (recA.state !== "indexed") return null;

  await check("indexed offer has ttl_seconds=600 (proves OFFER_TTL_SECONDS)", async () => {
    const r = await db.query(`SELECT ttl_seconds FROM offer_file WHERE offer_hash = $1`, [builtA.hash]);
    return Number(r.rows[0]?.ttl_seconds) === OFFER_TTL_SECONDS;
  });

  await check("offer_indexed SSE event carries the content hash", async () =>
    sse.ofType("offer_indexed").some((e) => e.event.offerHash === builtA.hash),
  );

  await check("GET /v1/offers lists the offer (blob-free, with blobChars)", async () => {
    const page = await getOffersPage({ limit: "100" });
    const row = (page.body?.offers ?? []).find((o: any) => o.offerId === builtA.hash);
    return !!row && row.offerBech32 === undefined && Number(row.blobChars) === builtA.blob.length;
  });

  let detailBlob = "";
  await check("GET /v1/offers/:hash returns the exact round-tripped blob", async () => {
    const d = await getOfferByHash(builtA.hash);
    detailBlob = d.body?.offerBech32 ?? "";
    return detailBlob === builtA.blob;
  });

  await check("blob round-trip decodes to identical raw bytes", async () => {
    if (!detailBlob) return false;
    const orig = OfferFiles.decode(builtA.blob);
    const rt = OfferFiles.decode(detailBlob);
    return orig.length === rt.length && orig.every((b, i) => b === rt[i]);
  });

  // ── Direct-Celestia offer (1.4 path-B positive; left live) ────────────────
  const b = amountsFor(2, "TB", "TA");
  const recB: OfferRecord = ledger.addOffer({
    index: 2,
    fate: "expired", // never touched again → TTL sweeps it later in the run
    layer: "ss",
    makerSeed: m1.seed,
    giveToken: "TB",
    wantToken: "TA",
    giveAmount: b.give.toString(),
    wantAmount: b.want.toString(),
    publishPath: "celestia",
    phase: "p1",
    state: "planned",
  });
  const builtB = await buildOffer(m1, recB);
  storeBlob(builtB.hash, builtB.blob);
  await check("direct blob.Submit (raw bytes) offer indexed identically", () =>
    publishAndIndex(db, recB, builtB),
  );

  // ── Settle the API-path offer via the taker flow ──────────────────────────
  await check("taker balanced + batcher settled the offer", async () => {
    await settleOffer(taker, recA, detailBlob || builtA.blob);
    return true;
  });

  await check("offer archived CONSUMED after settlement", async () => {
    const gone = await waitUntil(
      "offer archived",
      async () => (await offerRowByHash(db, builtA.hash)) === null,
      ARCHIVE_WAIT_TRIES,
      5000,
    );
    if (!gone) return false;
    const hist = await historyRowByHash(db, builtA.hash);
    if (hist?.archive_reason !== "CONSUMED") return false;
    recA.state = "resolved";
    recA.resolvedAt = Date.now();
    return true;
  });

  await check("status endpoint reads consumed (exact fill classification)", async () => {
    const s = await getOfferStatus(builtA.hash);
    return s.body?.status === "consumed";
  });

  // waitUntil, not a bare read. App events are published only AFTER their
  // block commits (the post-commit gate, invariant I1), released by a ~1 s
  // poll — so the event is not there the instant the archive is. This check
  // used to read the recorder synchronously and passed only because events
  // were once emitted inside the STM transition; it FAILED on the first full
  // run against main for exactly that reason. Do not "fix" it by removing the
  // gate: delivering an event before its block commits is the defect the gate
  // exists to prevent.
  await check("offer_consumed SSE event fired for the settled offer", async () => {
    const rowId = recA.rowId;
    return waitUntil(
      "offer_consumed delivered",
      async () => sse.ofType("offer_consumed").some((e) => e.event.offerId === rowId),
      20,
      1000,
    );
  });

  note("p1 artifacts", `live=${builtB.hash.slice(0, 12)}… consumed=${builtA.hash.slice(0, 12)}…`);
  return {
    liveBlob: builtB.blob,
    liveHash: builtB.hash,
    consumedBlob: builtA.blob,
    consumedHash: builtA.hash,
  };
}
