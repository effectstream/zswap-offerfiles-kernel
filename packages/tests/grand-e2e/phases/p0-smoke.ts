// Phase 0 — stack smoke: everything the suite is about to lean on is up, and
// the run was launched with the 10-minute windows the plan requires.

import type { Client } from "pg";
import { BATCHER_URL, ORCHESTRATOR_URL } from "../config.ts";
import { getHealth, getHealthSync } from "../lib/api2.ts";
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
  "pair_stats",
  "token_prices",
];

export async function p0Smoke(db: Client): Promise<void> {
  beginPhase("p0-smoke");

  const healthy = await check("node /v1/health answers ok", () => getHealth());

  // With no stack up, fail fast instead of polling for 10 minutes.
  await check("node sync reaches status=ok", () =>
    waitUntil("sync ok", async () => (await getHealthSync())?.status === "ok", healthy ? 120 : 2, 5000),
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

  await check("celestia light node RPC reachable", async () => (await networkHeadHeight()) > 0);

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

  // ROOT_WINDOW_SECONDS=600 cannot be read from the node directly; it is
  // verified by effect twice: ttl_seconds=600 on the first indexed offer (p1)
  // and the known_roots window span (p7 audit).
  note("window check", "deferred to p1 (ttl_seconds) and p7 audit (known_roots span)");
}
