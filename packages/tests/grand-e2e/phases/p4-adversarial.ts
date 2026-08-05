// Phase 4 — the rejection ladder, from both doors:
//   4.1–4.5 structural + liveness fixtures against POST /v1/offers
//   4.6     crypto tamper — must reject with a NON-structural code (proves
//           proof verification runs last and still gates everything)
//   4.7     direct-Celestia garbage — offer_rejections rows, zero indexed
// Every piece of garbage is recorded in the ledger so the final audit can
// prove offer_rejections contains nothing we did not do.

import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { ledger } from "../ledger.ts";
import type { P1Artifacts } from "./p1-happy.ts";
import {
  apiFixtures,
  celestiaFixtures,
  cryptoTamperBlob,
  publishCelestiaGarbage,
  STRUCTURAL_CODES,
} from "../actors/adversary.ts";
import { buildOneSidedOffer, makerShieldedKey, type Actors } from "../actors/wallets.ts";
import { getHealth, submitOffer2 } from "../lib/api2.ts";
import { submitBlobRaw } from "../lib/celestia.ts";
import { offerRowByHash, rejectionRows, rejectionTotalsByCode, tableCount } from "../lib/db2.ts";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
import { beginPhase, check, note, sleep, waitUntil } from "../lib/util.ts";

export async function p4Adversarial(db: Client, art: P1Artifacts, actors: Actors): Promise<void> {
  beginPhase("p4-adversarial");

  const offersBefore = await tableCount(db, "offer_file");
  const historyBefore = await tableCount(db, "offer_file_history");

  // ── The MIP-0006 two-sided rule, at both doors ───────────────────────────
  // The most important semantic rule in the spec, and until now it had only
  // ever fired by accident — as a symptom of the SDK dropping a leg, reported
  // as an indexer error (ISSUES.md §3). This builds a give-only transaction on
  // purpose and requires both gates to name it.
  {
    // Colors are NOT free to choose: each maker holds one shielded color by
    // index parity, so the give must come from makerShieldedKey or the wallet
    // is asked to spend something it never held.
    const makerIdx = 7;
    const built = await buildOneSidedOffer(actors.makers[makerIdx]!, makerShieldedKey(makerIdx));
    if ("skipped" in built) {
      note(
        "NOT_A_SWAP fixture",
        `not built (${built.skipped}) — the MIP-0006 two-sided rule is UNTESTED this run. ` +
          "If the reason is that the SDK produced a valid two-sided offer, ISSUES.md §3 is " +
          "stale and this fixture needs a different construction.",
      );
    } else {
      const oneSided = built.blob;
      const res = await submitOffer2(oneSided);
      ledger.addGarbage({
        kind: "api:NOT_A_SWAP-one-sided",
        via: "api",
        expectedCodes: ["NOT_A_SWAP"],
        offerHash: offerHashFromBlob(oneSided),
        at: Date.now(),
        gotCode: res.body?.error,
        gotStatus: res.status,
      });
      await check(
        "submit rejects a give-only transaction as NOT_A_SWAP (MIP-0006 two-sided rule)",
        async () => res.status === 400 && res.body?.error === "NOT_A_SWAP",
        `got ${res.status} ${res.body?.error}`,
      );

      const before = await rejectionTotalsByCode(db);
      const height = await submitBlobRaw(OfferFiles.decode(oneSided));
      ledger.addGarbage({
        kind: "celestia:NOT_A_SWAP-one-sided",
        via: "celestia",
        expectedCodes: ["NOT_A_SWAP"],
        offerHash: offerHashFromBlob(oneSided),
        celestiaHeight: height,
        at: Date.now(),
      });
      await check("celestia door records NOT_A_SWAP for the same transaction", async () =>
        waitUntil(
          "NOT_A_SWAP recorded",
          async () => {
            const now = await rejectionTotalsByCode(db);
            return (now.NOT_A_SWAP ?? 0) > (before.NOT_A_SWAP ?? 0);
          },
          24,
          5000,
        ),
      );
    }
  }

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

  // ── 4.7 direct-Celestia garbage, asserted BY CODE ────────────────────────
  // The permissionless door. Each family must earn a specific rejection code,
  // not merely bump a counter: "the ladder rejected it" and "the ladder
  // rejected it for the reason we are testing" are different claims, and only
  // the second one detects a gate that has stopped working because an earlier
  // one now fires first.
  //
  // Codes are diffable even though heights are not: `offer_rejections` is keyed
  // (celestia_height, code), but that height is an EffectstreamBlockNumber, not
  // the height blob.Submit reported — measured 42–67 blocks apart, and the gap
  // grows. See ISSUES.md. Per-code totals have no such problem.
  const rejectionsBefore = await rejectionRows(db);
  const rejectionsBeforeCount = rejectionsBefore.reduce((n, r) => n + Number(r.count), 0);
  const fixtures = celestiaFixtures();
  const codesBefore = await rejectionTotalsByCode(db);

  const heights: number[] = [];
  for (const [i, fix] of fixtures.entries()) {
    const src = fix.kind === "replayed-real-blob" ? art.consumedBlob : art.liveBlob;
    const { height } = await publishCelestiaGarbage(fix.kind, 100 + i, src);
    heights.push(height);
  }
  note("celestia garbage", `published at heights ${heights.join(", ")}`);

  const totalRejections = async (): Promise<number> =>
    (await rejectionRows(db)).reduce((n, r) => n + Number(r.count), 0);
  await check("garbage blobs produce offer_rejections rows (bodies deleted)", async () => {
    return waitUntil(
      "rejection rows appear",
      async () => (await totalRejections()) >= rejectionsBeforeCount + fixtures.length,
      24,
      5000,
    );
  });

  // Now the codes. Grouped so families sharing a code are asserted together —
  // three BAD_DESERIALIZE families must produce three BAD_DESERIALIZE records,
  // not one plus two of something else.
  {
    const codesAfter = await rejectionTotalsByCode(db);
    const delta = (code: string) => (codesAfter[code] ?? 0) - (codesBefore[code] ?? 0);
    const allDeltas = [...new Set([...Object.keys(codesBefore), ...Object.keys(codesAfter)])]
      .map((c) => `${c}=${delta(c)}`)
      .filter((s) => !s.endsWith("=0"))
      .join(" ");

    // One group per distinct code signature: three BAD_DESERIALIZE families
    // must yield three BAD_DESERIALIZE records, not one plus two of something
    // that happens to also be a rejection.
    const groups = new Map<string, { codes: string[]; kinds: string[] }>();
    for (const f of fixtures) {
      const key = f.expectedCodes.join("/");
      const g = groups.get(key) ?? { codes: f.expectedCodes, kinds: [] };
      g.kinds.push(f.kind);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const got = g.codes.reduce((n, c) => n + delta(c), 0);
      await check(
        `celestia door records ${key} for ${g.kinds.join(", ")}`,
        async () => got >= g.kinds.length,
        `expected ≥${g.kinds.length}, got ${got}; deltas: ${allDeltas}`,
      );
    }
  }

  // ── 4.8 byte-identical duplicates inside ONE L2 block ────────────────────
  // Both blobs are processed inside a single block transaction, so the second
  // one's dedup probe (getOfferStatusByHash) must observe the first one's
  // UNCOMMITTED insert. If it does not, the unique index catches it instead —
  // as an STF error that aborts the whole block, taking every legitimate offer
  // at that height down with it. That is the NUL crash's blast-radius shape,
  // and it has never been tested.
  {
    const dupBytes = OfferFiles.decode(art.liveBlob);
    const dupHash = offerHashFromBlob(art.liveBlob);
    const before = await rejectionTotalsByCode(db);
    // No await between them: they land in the same Celestia delayMs window and
    // therefore the same L2 block.
    const [h1, h2] = await Promise.all([submitBlobRaw(dupBytes), submitBlobRaw(dupBytes)]);
    for (const h of [h1, h2]) {
      ledger.addGarbage({
        kind: "celestia:same-block-duplicate",
        via: "celestia",
        expectedCodes: ["DUPLICATE_OFFER"],
        // offerHash deliberately OMITTED: it belongs to a legitimately indexed
        // offer, so its presence is not evidence that garbage got in. The
        // "zero offer_file rows" sweep below would otherwise read this row as
        // a breach. The real invariant is asserted directly instead.
        celestiaHeight: h,
        at: Date.now(),
      });
    }
    note("same-block duplicate", `two identical blobs at heights ${h1}, ${h2}`);

    await check("same-block duplicate: both refused DUPLICATE_OFFER", async () =>
      waitUntil(
        "two dup rejections",
        async () => {
          const now = await rejectionTotalsByCode(db);
          return (now.DUPLICATE_OFFER ?? 0) >= (before.DUPLICATE_OFFER ?? 0) + 2;
        },
        24,
        5000,
      ),
    );
    await check("same-block duplicate: the node survived and the offer exists exactly once", async () => {
      // Exactly one row across BOTH tables — not zero (the block aborted and
      // took the legitimate offer with it) and not two (dedup missed). Counted
      // across live+history because the source offer may have been swept by
      // its TTL by now; where it lives is not what this asserts.
      const r = await db.query(
        `SELECT (SELECT count(*) FROM offer_file WHERE offer_hash = $1)
              + (SELECT count(*) FROM offer_file_history WHERE offer_hash = $1) AS n`,
        [dupHash],
      );
      return Number(r.rows[0].n) === 1 && (await getHealth());
    });
  }

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
