// Phase 0 — stack smoke: everything the suite is about to lean on is up, and
// the run was launched with the 10-minute windows the plan requires.

import type { Client } from "pg";
import { BATCHER_URL, ORCHESTRATOR_URL } from "../config.ts";
import { getHealth, getHealthSync, realNtpLagSeconds } from "../lib/api2.ts";
import { networkHeadHeight } from "../lib/celestia.ts";
import { beginPhase, check, note, pgrepF, waitUntil } from "../lib/util.ts";

const REQUIRED_TABLES = [
  "offer_file",
  "offer_file_history",
  "offer_file_tokens",
  "offer_file_nullifiers",
  "offer_file_unshielded_spends",
  "offer_file_commitments",
  "nullifiers",
  "commitments",
  "known_roots",
  "created_unshielded",
  "known_tokens",
  "offer_rejections",
  "token_prices",
  "asset_prices",
  "price_feed_status",
];

export async function p0Smoke(db: Client): Promise<void> {
  beginPhase("p0-smoke");

  const healthy = await check("node /v1/health answers ok", () => getHealth());

  // NOT `status === "ok"`: sync-health computes its NTP tip from the
  // preview/mainnet env defaults, so on dev it reports "syncing" forever
  // (bug reported separately — see realNtpLagSeconds). Readiness here is the
  // real thing: the merged block is at the chain's edge and both parallel
  // protocols have fetched to their tips. Fail fast when no stack is up.
  await check("node synced to tip (blockL2 fresh + midnight/celestia caught up)", () =>
    waitUntil(
      "synced to tip",
      async () => {
        const h = await getHealthSync();
        if (!h) return false;
        // Steady-state gaps are structural: midnight delayMs=18 s (~6 s
        // blocks ⇒ ≲4 behind), celestia delayMs=12 s (~1 s blocks ⇒ ≲15
        // behind). Thresholds sit above those, well below "still syncing".
        const parallelCaughtUp =
          Number(h.midnight?.current ?? 0) >= Number(h.midnight?.tip ?? Infinity) - 8 &&
          Number(h.celestia?.current ?? 0) >= Number(h.celestia?.tip ?? Infinity) - 40;
        return realNtpLagSeconds(h) <= 15 && parallelCaughtUp;
      },
      healthy ? 120 : 2,
      5000,
    ),
  );

  await check("all app migrations applied", async () => {
    for (const t of REQUIRED_TABLES) {
      const r = await db.query(`SELECT to_regclass($1) AS x`, [`public.${t}`]);
      if (!r.rows[0]?.x) {
        note("missing table", t);
        return false;
      }
    }
    return true;
  });

  await check("celestia light node RPC reachable", async () => {
    const head = await networkHeadHeight();
    if (head > 0) {
      const { ledger } = await import("../ledger.ts");
      ledger.startCelestiaHeight = head;
      note("celestia baseline", `suite starts at height ${head}; earlier rejections are pre-run artifacts`);
    }
    return head > 0;
  });

  await check("batcher /health ok", async () => {
    try {
      const r = await fetch(`${BATCHER_URL}/health`, { signal: AbortSignal.timeout(10_000) });
      return r.ok;
    } catch {
      return false;
    }
  });

  await check("midnight indexer process alive", async () => (await pgrepF("midnight-indexer")) !== null);
  await check("sync (STM) process alive", async () => (await pgrepF("packages/node/main.dev.ts")) !== null);

  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/processes`, { signal: AbortSignal.timeout(5000) });
    note("orchestrator", r.ok ? "reachable on :4747" : `HTTP ${r.status}`);
  } catch {
    note("orchestrator", "not reachable — chaos phases will manage processes via pgrep/pkill only");
  }

  note(
    "BUG FOUND (reported, not patched)",
    "/v1/health/sync computes its NTP tip from env-default NTP_START_TIME+BLOCK_TIME_MS (10-min preview/mainnet blocks) " +
      "while config.dev.ts runs 1 s blocks anchored at launch — dev reports a bogus tip and permanent 'syncing'. " +
      "Suite measures lag from blockL2.timestamp instead (realNtpLagSeconds).",
  );

  // ROOT_WINDOW_SECONDS=600 cannot be read from the node directly; it is
  // verified by effect twice: ttl_seconds=600 on the first indexed offer (p1)
  // and the known_roots window span (p7 audit).
  note("window check", "deferred to p1 (ttl_seconds) and p7 audit (known_roots span)");
}
