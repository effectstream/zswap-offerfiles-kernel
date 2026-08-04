// Phase 4 — the rejection ladder, from both doors:
//   4.1–4.5 structural + liveness fixtures against POST /v1/offers
//   4.6     crypto tamper — must reject with a NON-structural code (proves
//           proof verification runs last and still gates everything)
//   4.7     direct-Celestia garbage — offer_rejections rows, zero indexed
// Every piece of garbage is recorded in the ledger so the final audit can
// prove offer_rejections contains nothing we did not do.

import type { Client } from "pg";
import { ledger } from "../ledger.ts";
import type { P1Artifacts } from "./p1-happy.ts";
import {
  apiFixtures,
  celestiaGarbageKinds,
  cryptoTamperBlob,
  publishCelestiaGarbage,
  STRUCTURAL_CODES,
} from "../actors/adversary.ts";
import { submitOffer2 } from "../lib/api2.ts";
import { offerRowByHash, rejectionRows, tableCount } from "../lib/db2.ts";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
import { beginPhase, check, note, sleep, waitUntil } from "../lib/util.ts";

export async function p4Adversarial(db: Client, art: P1Artifacts): Promise<void> {
  beginPhase("p4-adversarial");

  const offersBefore = await tableCount(db, "offer_file");
  const historyBefore = await tableCount(db, "offer_file_history");

  // ── API fixtures ──────────────────────────────────────────────────────────
  for (const fix of apiFixtures(art.liveBlob, art.consumedBlob)) {
    const res = await submitOffer2(fix.blob);
    ledger.addGarbage({
      kind: `api:${fix.kind}`,
      via: "api",
      expectedCodes: fix.expectedCodes,
      at: Date.now(),
      gotCode: res.body?.error,
      gotStatus: res.status,
    });
    await check(`submit rejects ${fix.kind}`, async () => {
      if (res.status !== 400 && res.status !== 409) return false;
      return fix.expectedCodes.includes(res.body?.error);
    }, `got ${res.status} ${res.body?.error}`);
  }

  await check("ROOT_UNKNOWN rejection carries hint + diagnostics", async () => {
    const res = await submitOffer2(
      apiFixtures(art.liveBlob, null).find((f) => f.kind.startsWith("ROOT_UNKNOWN"))!.blob,
    );
    return (
      res.status === 400 &&
      res.body?.error === "ROOT_UNKNOWN" &&
      typeof res.body?.hint === "string" &&
      res.body?.diagnostics &&
      "offerRoot" in res.body.diagnostics
    );
  });

  // ── 4.6 crypto tamper — rejected by the crypto step, not a structural one ─
  {
    const tampered = cryptoTamperBlob(art.liveBlob);
    const res = await submitOffer2(tampered);
    ledger.addGarbage({
      kind: "api:crypto-tamper",
      via: "api",
      expectedCodes: ["PROOF_INVALID", "SIGNATURE_INVALID"],
      offerHash: offerHashFromBlob(tampered),
      at: Date.now(),
      gotCode: res.body?.error,
      gotStatus: res.status,
    });
    await check(
      "crypto tamper rejects with a NON-structural code (crypto runs last)",
      async () =>
        res.status === 400 &&
        typeof res.body?.error === "string" &&
        !STRUCTURAL_CODES.has(res.body.error) &&
        res.body.error !== "RATE_LIMITED",
      `got ${res.status} ${res.body?.error}`,
    );
  }

  await check("no adversarial submission was ever indexed", async () => {
    await sleep(10_000);
    return (
      (await tableCount(db, "offer_file")) === offersBefore &&
      (await tableCount(db, "offer_file_history")) === historyBefore
    );
  });

  // ── 4.7 direct-Celestia garbage ──────────────────────────────────────────
  const rejectionsBefore = await rejectionRows(db);
  const before = new Map(rejectionsBefore.map((r) => [`${r.celestia_height}|${r.code}`, r.count]));
  const kinds = celestiaGarbageKinds();
  const heights: number[] = [];
  for (const [i, kind] of kinds.entries()) {
    const src = kind === "replayed-real-blob" ? art.consumedBlob : art.liveBlob;
    const { height } = await publishCelestiaGarbage(kind, 100 + i, src);
    heights.push(height);
  }
  note("celestia garbage", `published at heights ${heights.join(", ")}`);

  // Counted, NOT matched by height: `offer_rejections.celestia_height` does
  // not hold a Celestia height. The STM writes `data.blockHeight`, which is
  // an EffectstreamBlockNumber — measured 42–67 blocks away from the height
  // `blob.Submit` reported, and the gap grows. See ISSUES.md.
  const totalRejections = async (): Promise<number> =>
    (await rejectionRows(db)).reduce((n, r) => n + Number(r.count), 0);
  const rejectionsBeforeCount = before.size === 0
    ? 0
    : rejectionsBefore.reduce((n, r) => n + Number(r.count), 0);
  await check("garbage blobs produce offer_rejections rows (bodies deleted)", async () => {
    return waitUntil(
      "rejection rows appear",
      async () => (await totalRejections()) >= rejectionsBeforeCount + kinds.length,
      24,
      5000,
    );
  });

  await check("zero offer_file rows for the garbage blobs", async () => {
    for (const g of ledger.garbage.filter((g) => g.via === "celestia" && g.offerHash)) {
      const row = await offerRowByHash(db, g.offerHash!);
      // The replayed blob's hash equals the consumed offer's hash — it must
      // exist only as the ORIGINAL history row, never as a live row again.
      if (row) return false;
    }
    return (await tableCount(db, "offer_file")) === offersBefore;
  });
}
