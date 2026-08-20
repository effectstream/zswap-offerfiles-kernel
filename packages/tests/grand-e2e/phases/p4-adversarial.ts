// Phase 4 — the rejection ladder, from both doors:
//   4.1–4.5 structural + liveness fixtures against POST /v1/offers
//   4.6     crypto tamper — must reject with a NON-structural code (proves
//           proof verification runs last and still gates everything)
//   4.7     direct-Celestia garbage — offer_rejections rows, zero indexed
// Every piece of garbage is recorded in the ledger so the final audit can
// prove offer_rejections contains nothing we did not do.

import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { INDEX_WAIT_TRIES } from "../config.ts";
import { ledger } from "../ledger.ts";
import type { P1Artifacts } from "./p1-happy.ts";
import {
  apiFixtures,
  celestiaFixtures,
  cryptoTamperBlob,
  publishCelestiaGarbage,
  STRUCTURAL_CODES,
} from "../actors/adversary.ts";
import {
  buildCrossLayerOffer,
  buildOneSidedOffer,
  buildSameIntentWrapperPair,
  makerShieldedKey,
  makerUnshieldedKey,
  oppositeKey,
  storeBlob,
  WRAPPER_GIVE_UNSHIELDED,
  type Actors,
} from "../actors/wallets.ts";
import { getHealth, getOfferStatus, submitOffer2 } from "../lib/api2.ts";
import { submitBlobRaw } from "../lib/celestia.ts";
import { offerRowByHash, rejectionRows, rejectionTotalsByCode, tableCount } from "../lib/db2.ts";
import { offerHashFromBlob } from "@zswap-da/offer-guard";
import { beginPhase, check, note, sleep, waitUntil } from "../lib/util.ts";

export async function p4Adversarial(db: Client, art: P1Artifacts, actors: Actors): Promise<void> {
  beginPhase("p4-adversarial");

  const offersBefore = await tableCount(db, "offer_file");
  const historyBefore = await tableCount(db, "offer_file_history");
  /** Legitimate offers this phase adds to the live book — see 4.9. */
  let liveAdded = 0;

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

  // ── The same-layer rule, at both doors (§2.4) ────────────────────────────
  // A cross-layer offer is unfillable by construction: nothing in this system
  // moves value between shielded and unshielded, so no taker could ever settle
  // it. Until PR-#6 the ladder ACCEPTED one — it passed everything including
  // `wellFormed`. Built here by merging a real shielded offer with a real
  // unshielded one, the route probe-cross-layer.ts proved reachable.
  {
    // A maker funded on BOTH layers (every maker is, by index parity). Not
    // makerIdx 7 — that one just built the NOT_A_SWAP fixture above and its
    // shielded coin is still settling back.
    const xlMakerIdx = 6;
    const built = await buildCrossLayerOffer(actors.makers[xlMakerIdx]!, xlMakerIdx);
    if ("skipped" in built) {
      note(
        "CROSS_LAYER fixture",
        `not built (${built.skipped}) — the same-layer rule is UNTESTED this run. ` +
          "If the reason is that the merge yielded a valid same-layer offer, or that the " +
          "ledger refused the merge outright, §2.4's reachability claim needs re-checking.",
      );
    } else {
      const xl = built.blob;
      const res = await submitOffer2(xl);
      ledger.addGarbage({
        kind: "api:CROSS_LAYER-merged",
        via: "api",
        expectedCodes: ["CROSS_LAYER"],
        offerHash: offerHashFromBlob(xl),
        at: Date.now(),
        gotCode: res.body?.error,
        gotStatus: res.status,
      });
      await check(
        "submit rejects a cross-layer offer as CROSS_LAYER (same-layer rule)",
        async () => res.status === 400 && res.body?.error === "CROSS_LAYER",
        `got ${res.status} ${res.body?.error}`,
      );
      // Specifically NOT NOT_A_SWAP. The offer IS two-sided — that is what
      // makes it dangerous — so answering NOT_A_SWAP would be naming the wrong
      // defect and would let a reordering of the ladder pass unnoticed.
      await check(
        "the cross-layer rejection is not mislabelled NOT_A_SWAP",
        async () => res.body?.error !== "NOT_A_SWAP",
        `got ${res.body?.error}`,
      );

      const before = await rejectionTotalsByCode(db);
      const height = await submitBlobRaw(OfferFiles.decode(xl));
      ledger.addGarbage({
        kind: "celestia:CROSS_LAYER-merged",
        via: "celestia",
        expectedCodes: ["CROSS_LAYER"],
        offerHash: offerHashFromBlob(xl),
        celestiaHeight: height,
        at: Date.now(),
      });
      await check("celestia door records CROSS_LAYER for the same transaction", async () =>
        waitUntil(
          "CROSS_LAYER recorded",
          async () => {
            const now = await rejectionTotalsByCode(db);
            return (now.CROSS_LAYER ?? 0) > (before.CROSS_LAYER ?? 0);
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
  // Both blobs are processed inside one block transaction against the already
  // indexed canonical offer. Prove the burst yields two coded refusals without
  // aborting the block, deleting the canonical row or duplicating it. This
  // does not claim visibility between two new, uncommitted inserts.
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
        // This is the same Celestia -> STM -> DB path as normal indexing.
        // Keep its budget aligned with the suite-wide index wait instead of
        // failing at 120 s while an otherwise-valid (<150-block lag) run is
        // still catching up. Run 2 observed both rows 14 s after that old
        // deadline; the exactly-once safety assertion below already passed.
        INDEX_WAIT_TRIES,
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

  // ── 4.9 marker dedup: ONE intent, TWO wrappers, both doors ───────────────
  //
  // The evasion byte-identical dedup cannot see. Markers are root-independent,
  // so re-proving or re-wrapping one intent yields a different blob with a
  // different offer_hash and the SAME declared outputs — measured live on
  // 2026-08-17, where two such pairs turned five settlements into seven trades.
  // Ruled 2026-08-18: after crypto verification, an offer whose declared
  // markers overlap an ACTIVE offer's is rejected.
  //
  // Four things are asserted, and the last is the one that keeps the rule from
  // being a denial-of-service: the ORIGINAL must be untouched. A dedup rule
  // that lets a newcomer disturb the incumbent would be worse than none.
  {
    // MAKER_SEEDS is eight wallets, indices 0-7, so this must be one of them —
    // `makers[9]!` would be a non-null assertion over undefined and would take
    // the run down. 5, not 6 or 7: those two just built the CROSS_LAYER and
    // NOT_A_SWAP fixtures and their coins are still settling back, and unlike
    // those this offer is PUBLISHED, so its coin stays reserved for the rest of
    // the run rather than being reverted.
    const makerIdx = 5;
    const maker = actors.makers[makerIdx]!;
    const built = await buildSameIntentWrapperPair(maker, makerIdx);
    if ("skipped" in built) {
      note(
        "marker dedup fixture",
        `not built (${built.skipped}) — dedup rule (ii) is UNTESTED against a running ` +
          "stack this run. The unit coverage still holds (packages/database/marker-dedup.test.ts, " +
          "packages/node/marker-dedup.test.ts), but nothing here proves the two DOORS agree.",
      );
    } else {
      const firstHash = offerHashFromBlob(built.first);
      const secondHash = offerHashFromBlob(built.second);
      storeBlob(firstHash, built.first);

      // Registered BEFORE publishing: p7b's live-set audit treats an
      // unrecognised offer_file row as a stray, and its classification audit
      // compares fate against the served status. Fate `expired`, because that
      // is what actually becomes of it — nothing settles this offer, and its
      // TTL falls long before the audit runs.
      const rec = ledger.addOffer({
        index: -1,
        fate: "expired",
        layer: "uu",
        makerSeed: maker.seed,
        giveToken: makerUnshieldedKey(makerIdx),
        wantToken: oppositeKey(makerUnshieldedKey(makerIdx)),
        giveAmount: String(WRAPPER_GIVE_UNSHIELDED),
        wantAmount: "293",
        publishPath: "api",
        phase: "p4-marker-dedup",
        state: "planned",
        offerHash: firstHash,
        hasFillMarkers: false, // unshielded want: markers are identities, not commitments
      });

      await check("marker dedup: the FIRST wrapper is accepted", async () => {
        const res = await submitOffer2(built.first);
        return res.status === 200;
      });
      const indexed = await waitUntil(
        "first wrapper indexed",
        async () => (await offerRowByHash(db, firstHash)) !== null,
        INDEX_WAIT_TRIES,
        5000,
      );
      if (!indexed) {
        ledger.markCasualty(rec, "first wrapper never indexed");
        note("marker dedup fixture", "first wrapper never indexed — rule (ii) UNTESTED this run");
      } else {
        const firstRow = await offerRowByHash(db, firstHash);
        rec.state = "indexed";
        rec.indexedAt = Date.now();
        rec.rowId = firstRow?.id;
        liveAdded += 1;

        // ── DOOR 1: the API submit gate ──
        // 409 and its own code. Reusing DUPLICATE_OFFER would have been
        // cheaper and would have hidden the evasion inside the replay counter.
        const api = await submitOffer2(built.second);
        await check(
          "marker dedup: the API refuses the second wrapper 409 DUPLICATE_MARKERS",
          async () =>
            api.status === 409 &&
            (api.body as any)?.error === "DUPLICATE_MARKERS" &&
            (api.body as any)?.activeOfferId === firstHash,
          `status=${api.status} body=${JSON.stringify(api.body).slice(0, 200)}`,
        );

        // ── DOOR 2: straight to Celestia, bypassing the API entirely ──
        // The namespace is permissionless, so this is the door that decides.
        // A rule that lives only at the HTTP gate is a rule with a bypass.
        const before = await rejectionTotalsByCode(db);
        const height = await submitBlobRaw(OfferFiles.decode(built.second));
        ledger.addGarbage({
          kind: "celestia:marker-duplicate",
          via: "celestia",
          expectedCodes: ["DUPLICATE_MARKERS"],
          offerHash: secondHash,
          celestiaHeight: height,
          at: Date.now(),
        });
        await check("marker dedup: the DA door refuses it too", async () =>
          waitUntil(
            "marker-duplicate rejection",
            async () => {
              const now = await rejectionTotalsByCode(db);
              return (now.DUPLICATE_MARKERS ?? 0) >= (before.DUPLICATE_MARKERS ?? 0) + 1;
            },
            INDEX_WAIT_TRIES,
            5000,
          ),
        );
        await check("marker dedup: the second wrapper is nowhere in the book", async () => {
          const r = await db.query(
            `SELECT (SELECT count(*) FROM offer_file WHERE offer_hash = $1)
                  + (SELECT count(*) FROM offer_file_history WHERE offer_hash = $1) AS n`,
            [secondHash],
          );
          return Number(r.rows[0].n) === 0;
        });

        // ── The incumbent is untouched ──
        await check(
          "marker dedup: the ORIGINAL offer is untouched and still served",
          async () => {
            const row = await offerRowByHash(db, firstHash);
            if (!row || row.id !== firstRow?.id) return false;
            const served = await getOfferStatus(firstHash);
            return served.status === 200 && (served.body as any)?.status === "live";
          },
        );
      }
    }
  }

  await check("zero offer_file rows for the garbage blobs", async () => {
    for (const g of ledger.garbage.filter((g) => g.via === "celestia" && g.offerHash)) {
      const row = await offerRowByHash(db, g.offerHash!);
      // The replayed blob's hash equals the consumed offer's hash — it must
      // exist only as the ORIGINAL history row, never as a live row again.
      if (row) return false;
    }
    // `+ liveAdded`, not a bare equality: 4.9 deliberately indexes ONE
    // legitimate offer — the incumbent its duplicate has to lose to — and a
    // fixture that skipped adds nothing. Keeping the bare equality would have
    // made this check fail for the one reason it is not about.
    return (await tableCount(db, "offer_file")) === offersBefore + liveAdded;
  });
}
