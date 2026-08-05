// Phase 8 — what the API actually SERVES.
//
// Every other phase grades the system from the inside: the ledger knows what
// it published, the audit reads the database. This one takes the position of a
// client that trusts nothing — it fetches offers over HTTP, decodes the bytes
// it was given, and re-derives every claim made about them from scratch.
//
// The question it answers is the one nothing else asks: can a bad transaction
// reach a user? Four ways it could:
//
//   1. the bytes are not the offer the id claims  → recompute the content address
//   2. the bytes are not a valid offer            → re-run the FULL ladder, proofs included
//   3. the advertised terms are not the tx's terms→ re-derive gives/wants
//   4. the offer can no longer settle             → re-check liveness against the chain sets
//
// (4) is the one with no coverage anywhere else. Nothing today stops the book
// listing an offer whose inputs are spent or whose proof root has aged out —
// the code names the failure class itself ("phantom, unfillable offers",
// network-windows.ts) without testing it.
//
// Placed between p5 and p7b: it needs a populated book, and it must run before
// the determinism replay quiets the chain.

import type { Client } from "pg";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { createHash } from "node:crypto";
import { OFFER_TTL_SECONDS, ROOT_WINDOW_SECONDS } from "../config.ts";
import { getOfferByHash, getOffersPage, getOfferStatus } from "../lib/api2.ts";
import { derivedLegKeys, fullyValidate } from "../lib/verify.ts";
import { beginPhase, check, detVar, note } from "../lib/util.ts";

/** Detail fetches are rate-limited (45/min client-side), so cap and SAY so. */
const MAX_DETAIL_FETCHES = 40;

interface Served {
  offerId: string;
  bech32: string;
  computed: any;
  listRow: any;
}

/** Can this offer still be settled, judged against the node's own chain sets? */
async function settleability(
  db: Client,
  nullifiers: string[],
  utxos: { owner: string; intentHash: string; outputNo: number }[],
  roots: string[],
): Promise<{ ok: boolean; why: string }> {
  for (const n of nullifiers) {
    const r = await db.query(`SELECT 1 FROM nullifiers WHERE nullifier = $1`, [n]);
    if (r.rows.length > 0) return { ok: false, why: `nullifier already spent (${n.slice(0, 8)})` };
  }
  for (const u of utxos) {
    const r = await db.query(
      `SELECT 1 FROM created_unshielded WHERE owner = $1 AND intent_hash = $2 AND output_no = $3`,
      [u.owner, u.intentHash, u.outputNo],
    );
    if (r.rows.length === 0) return { ok: false, why: `utxo not live (${u.owner.slice(0, 8)}/${u.outputNo})` };
  }
  if (roots.length > 0) {
    // Recomputed here rather than by calling the gate we are testing. Mirrors
    // isKnownRootLive exactly, MAX(height) escape included: our zswap-root
    // primitive fires only when the root ADVANCES, while the ledger's
    // past_roots re-inserts the current root every block, so the newest root
    // stays valid however stale its timestamp looks on a quiet chain.
    const tip = await db.query(
      `SELECT ms_timestamp FROM effectstream.effectstream_blocks ORDER BY block_height DESC LIMIT 1`,
    );
    const chainNowMs = Number(tip.rows[0]?.ms_timestamp ?? 0);
    const cutoff = chainNowMs - ROOT_WINDOW_SECONDS * 1000;
    for (const root of roots) {
      const r = await db.query(
        `SELECT 1 FROM known_roots
         WHERE root = $1 AND (last_seen_ms >= $2 OR height >= (SELECT MAX(height) FROM known_roots))`,
        [root, String(cutoff)],
      );
      if (r.rows.length === 0) {
        const age = await db.query(`SELECT last_seen_ms FROM known_roots WHERE root = $1`, [root]);
        const seen = age.rows[0]?.last_seen_ms;
        return {
          ok: false,
          why: seen
            ? `root aged out (${Math.round((chainNowMs - Number(seen)) / 1000)}s old, window ${ROOT_WINDOW_SECONDS}s)`
            : `root never known (${root.slice(0, 10)})`,
        };
      }
    }
  }
  return { ok: true, why: "" };
}

export async function p8Served(db: Client): Promise<void> {
  beginPhase("p8-served");

  // ── Collect the live book, then fetch each offer's detail ────────────────
  const listRows: any[] = [];
  let cursor: string | undefined;
  let listShapeOk = true;
  for (let page = 0; page < 20; page++) {
    const r = await getOffersPage({ limit: "100", ...(cursor ? { after_hash: cursor } : {}) });
    if (r.status !== 200) {
      listShapeOk = false;
      break;
    }
    listRows.push(...(r.body?.offers ?? []));
    cursor = r.body?.nextCursor ?? undefined;
    if (!cursor) break;
  }

  const sampled = listRows.length <= MAX_DETAIL_FETCHES
    ? listRows
    : listRows.filter((_, i) => detVar(i, Math.ceil(listRows.length / MAX_DETAIL_FETCHES)) === 0);
  if (sampled.length < listRows.length) {
    note(
      "p8 sampling",
      `${sampled.length}/${listRows.length} offers deep-checked (client rate limit); ` +
        `${listRows.length - sampled.length} NOT verified this run`,
    );
  }

  const served: Served[] = [];
  for (const row of sampled) {
    const d = await getOfferByHash(row.offerId);
    if (d.status !== 200) continue;
    served.push({
      offerId: row.offerId,
      bech32: d.body?.offerBech32 ?? "",
      computed: d.body?.computed ?? {},
      listRow: row,
    });
  }
  note("p8", `${served.length} served offers re-verified from their bytes`);

  await check("the live book paginates cleanly", async () => listShapeOk);

  // ── 1. The bytes are the offer the id claims (MIP-0005 content address) ──
  // Verified from the CLIENT side: sha256 of what we were handed, not of what
  // the database stored. This is MIP-0005's cross-node identity claim as a
  // consumer experiences it.
  await check("served offerId == sha256 of the served bytes", async () => {
    const bad: string[] = [];
    for (const s of served) {
      try {
        const raw = OfferFiles.decode(s.bech32);
        if (createHash("sha256").update(raw).digest("hex") !== s.offerId) bad.push(s.offerId.slice(0, 8));
      } catch {
        bad.push(`${s.offerId.slice(0, 8)}:undecodable`);
      }
    }
    return served.length > 0 && bad.length === 0;
  });

  // ── 2 + 3. Valid, and advertising its own terms ──────────────────────────
  const validations = new Map<string, ReturnType<typeof fullyValidate>>();
  {
    const invalid: string[] = [];
    const legMismatch: string[] = [];
    for (const s of served) {
      let v;
      try {
        v = fullyValidate(OfferFiles.decode(s.bech32));
      } catch {
        invalid.push(`${s.offerId.slice(0, 8)}:undecodable`);
        continue;
      }
      validations.set(s.offerId, v);
      if (!v.ok) {
        invalid.push(`${s.offerId.slice(0, 8)}:${v.code}`);
        continue;
      }
      const advertised = [
        ...(s.computed.gives ?? []).map((l: any) => `G|${String(l.token).toLowerCase()}|${l.amount}|${l.type}`),
        ...(s.computed.wants ?? []).map((l: any) => `W|${String(l.token).toLowerCase()}|${l.amount}|${l.type}`),
      ].sort();
      const derived = derivedLegKeys(v);
      if (JSON.stringify(advertised) !== JSON.stringify(derived)) {
        legMismatch.push(`${s.offerId.slice(0, 8)}: served=${advertised.join(",")} derived=${derived.join(",")}`);
      }
    }
    await check(
      "every served offer passes the FULL validator, proofs and signatures included",
      async () => served.length > 0 && invalid.length === 0,
      invalid.slice(0, 5).join("; "),
    );
    await check(
      "advertised gives/wants equal the transaction's own derived legs",
      async () => legMismatch.length === 0,
      legMismatch.slice(0, 3).join("; "),
    );
  }

  // ── 4. The offer can still settle ────────────────────────────────────────
  // The book is a promise that these offers are fillable. An offer whose
  // inputs are spent, or whose proof root has left the window, is a phantom:
  // a taker who acts on it burns fees on a transaction the ledger will refuse.
  {
    const dead: string[] = [];
    for (const s of served) {
      const v = validations.get(s.offerId);
      if (!v?.ok) continue; // already reported above
      const verdict = await settleability(
        db,
        v.nullifiers ?? [],
        (v.unshieldedSpends ?? []).map((u) => ({ owner: u.owner, intentHash: u.intentHash, outputNo: u.outputNo })),
        v.inputRoots ?? [],
      );
      if (!verdict.ok) dead.push(`${s.offerId.slice(0, 8)}: ${verdict.why}`);
    }
    await check(
      "every offer the book serves as live is still settleable on chain",
      async () => dead.length === 0,
      dead.length
        ? `${dead.length}/${served.length} unfillable — ${dead.slice(0, 3).join("; ")}`
        : undefined,
    );
  }

  // ── expiresAt must agree with that verdict ───────────────────────────────
  // Not a freshness check (a shielded offer's expiresAt is derived from its
  // root's last_seen, which can predate indexing, so the two clocks are not
  // interchangeable) — a CONSISTENCY check: the derivation and the liveness
  // predicate must tell the same story about the same offer.
  await check("served expiresAt is in the future for offers reported live", async () => {
    const now = Date.now();
    const past = served.filter(
      (s) => s.computed.status === "live" && s.computed.expiresAt && Date.parse(s.computed.expiresAt) < now,
    );
    return past.length === 0;
  }, "an expired-but-listed offer is a phantom the book should have swept");

  // Config invariant, not behaviour: the two windows are independent env knobs
  // (network-windows.ts) whose DEFAULT ties them together. A deployment that
  // widens the TTL past the root window serves dead shielded offers for the
  // difference — invisibly, because the grand run only ever sets them equal.
  await check(
    "OFFER_TTL_SECONDS <= ROOT_WINDOW_SECONDS (a shielded book cannot outlive its roots)",
    async () => OFFER_TTL_SECONDS <= ROOT_WINDOW_SECONDS,
    `ttl=${OFFER_TTL_SECONDS} window=${ROOT_WINDOW_SECONDS}`,
  );

  // ── 5. The list route serves ONLY live offers ────────────────────────────
  // p7b's live-set audit compares against the suite's own ledger and so cannot
  // see an offer the suite never created. This asks the API about itself.
  await check("every offer in the list reads status=live", async () => {
    const wrong: string[] = [];
    for (const s of served) {
      const st = (await getOfferStatus(s.offerId)).body?.status;
      if (st !== "live") wrong.push(`${s.offerId.slice(0, 8)}:${st}`);
    }
    return wrong.length === 0;
  });

  // ── 6. MIP-0006 payload presence rules, on the wire ──────────────────────
  await check("list rows carry offerId and omit the blob; detail rows carry both", async () => {
    for (const row of listRows) {
      if (!/^[0-9a-f]{64}$/.test(row.offerId ?? "")) return false;
      if (row.offerBech32 !== undefined) return false; // lists MAY omit; ours does
      if (row.version !== 1) return false;
    }
    for (const s of served) {
      if (!s.bech32.startsWith("swapoffer1")) return false; // MUST for single-offer
    }
    return true;
  });

  // The archived detail path is served out of offer_file_history and is not
  // covered even at unit level — a consumed offer must still resolve, with its
  // blob and its final status.
  await check("an archived offer still resolves by id, with its blob and final status", async () => {
    const r = await db.query(
      `SELECT offer_hash FROM offer_file_history WHERE archive_reason = 'CONSUMED' LIMIT 1`,
    );
    const hash = r.rows[0]?.offer_hash;
    if (!hash) return true; // nothing archived yet — nothing to assert
    const d = await getOfferByHash(hash);
    return (
      d.status === 200 &&
      d.body?.offerId === hash &&
      typeof d.body?.offerBech32 === "string" &&
      d.body.offerBech32.startsWith("swapoffer1") &&
      ["consumed", "cancelled", "expired"].includes(d.body?.computed?.status)
    );
  });
}
