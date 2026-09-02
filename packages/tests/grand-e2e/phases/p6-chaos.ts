// Phase 6 — chaos, run DURING the phase-5 storm:
//   • Midnight indexer kill + relaunch (re-indexes from genesis; dedup holds)
//   • Batcher restart with queued submissions (no double blob)
//   • sync/STM process kill (orchestrator restart, else our own respawn)

import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { resolve } from "node:path";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { offerHashFromBytes } from "@zswap-da/offer-guard";
import { BATCHER_URL, ORCHESTRATOR_URL } from "../config.ts";
import { getHealth, getHealthSync } from "../lib/api2.ts";
import { getBlobsAt, networkHeadHeight } from "../lib/celestia.ts";
import { tableCount } from "../lib/db2.ts";
import { check, note, pgrepF, sleep, waitUntil } from "../lib/util.ts";
import { beginChaosWindow, endChaosWindow, refreshPids } from "../metrics.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export const spawnedProcesses: ReturnType<typeof Bun.spawn>[] = [];

/**
 * Restart a stack process through the ORCHESTRATOR, never with pkill.
 *
 * The orchestrator owns these processes and treats an unexpected exit as
 * fatal: killing the indexer directly logs "Shutting down: Background process
 * ... exited unexpectedly" and tears down the entire stack, which is how an
 * earlier version of this phase destroyed its own run mid-flight. POST
 * /restart is the supported path and leaves the rest of the stack alone.
 */
async function orchestratorRestart(name: string): Promise<boolean> {
  try {
    const r = await fetch(`${ORCHESTRATOR_URL}/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(30_000),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || body?.success !== true) {
      note("chaos", `restart(${name}) -> ${r.status} ${JSON.stringify(body).slice(0, 120)}`);
      return false;
    }
    return true;
  } catch (e) {
    note("chaos", `restart(${name}) failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

async function offerSetSnapshot(db: Client): Promise<{ total: number; hashes: Set<string> }> {
  const clientQuery = await (db as any).query(
    `SELECT offer_hash FROM offer_file WHERE offer_hash IS NOT NULL
     UNION ALL
     SELECT offer_hash FROM offer_file_history WHERE offer_hash IS NOT NULL`,
  );
  const hashes = new Set<string>(clientQuery.rows.map((r: any) => r.offer_hash));
  return { total: clientQuery.rows.length, hashes };
}

/**
 * Bracket a deliberate outage so the lag gate can tell it apart from a slow STM.
 *
 * `finally`, not a trailing call: a chaos routine that returns early (restart
 * refused) or throws must still close its window, because an OPEN window is
 * closed at snapshot time and would swallow the rest of the run's samples.
 *
 * What this costs is real and is reported, not hidden: samples inside a window
 * stop feeding `maxLagBlocks`, and the indexer window in particular spans a
 * full re-index while the storm is running. `baselineViolations` therefore
 * notes how many samples were excluded, and every window is gated on its own
 * recovery — see summarizeStmLag.
 */
async function withChaosWindow(name: string, body: () => Promise<void>): Promise<void> {
  beginChaosWindow(name);
  try {
    await body();
  } finally {
    endChaosWindow(name);
  }
}

/** Kill + relaunch the Midnight indexer; assert full deterministic re-index
 *  loses/duplicates nothing. */
export async function chaosIndexer(db: Client): Promise<void> {
  await withChaosWindow("indexer", () => chaosIndexerBody(db));
}

async function chaosIndexerBody(db: Client): Promise<void> {
  note("chaos", "killing the Midnight indexer…");
  const before = await offerSetSnapshot(db);

  const restarted = await orchestratorRestart("midnight-indexer");
  await check("chaos: indexer restarted via orchestrator", async () => restarted);
  if (!restarted) {
    note("chaos", "indexer restart unavailable — skipping the re-index assertions");
    return;
  }
  await sleep(5000);

  await check("chaos: indexer relaunched and midnight sync advances again", async () => {
    let last = -1;
    return waitUntil(
      "midnight resync",
      async () => {
        const h = await getHealthSync();
        const cur = Number(h?.midnight?.current ?? -1);
        const advanced = last >= 0 && cur > last;
        last = cur;
        return advanced;
      },
      60,
      10_000,
    );
  });

  // The relaunch re-indexes from genesis (--clean); event-id regeneration is
  // deterministic and our tables dedup on conflict — nothing may be lost or
  // duplicated.
  await sleep(30_000);
  const after = await offerSetSnapshot(db);
  await check(
    "chaos: zero lost/duplicated offers across indexer re-index",
    async () =>
      after.total >= before.total &&
      [...before.hashes].every((h) => after.hashes.has(h)) &&
      after.total === after.hashes.size, // any duplicate row would break this
  );
  await check("chaos: offer_hash still unique across live+history", async () => {
    const r = await db.query(
      `SELECT offer_hash FROM (
         SELECT offer_hash FROM offer_file WHERE offer_hash IS NOT NULL
         UNION ALL SELECT offer_hash FROM offer_file_history WHERE offer_hash IS NOT NULL
       ) t GROUP BY offer_hash HAVING count(*) > 1`,
    );
    return r.rows.length === 0;
  });
  await refreshPids();
}

/** Restart the batcher with submissions in flight; a queued blob must not be
 *  published twice. `submitJustBefore` posts blobs to the API and returns
 *  their bech32 strings. */
export async function chaosBatcher(
  db: Client,
  submitJustBefore: () => Promise<string[]>,
  waitIndexed: (hash: string) => Promise<boolean>,
): Promise<void> {
  await withChaosWindow("batcher", () => chaosBatcherBody(db, submitJustBefore, waitIndexed));
}

async function chaosBatcherBody(
  db: Client,
  submitJustBefore: () => Promise<string[]>,
  waitIndexed: (hash: string) => Promise<boolean>,
): Promise<void> {
  note("chaos", "restarting the batcher with queued submissions…");
  const h1 = await networkHeadHeight();
  const blobs = await submitJustBefore();
  const hashes = blobs.map((b) => offerHashFromBytes(OfferFiles.decode(b)));

  const ok = await orchestratorRestart("batcher");
  await check("chaos: batcher restarted via orchestrator", async () => ok);
  await sleep(5000);

  await check("chaos: batcher back to healthy after restart", async () =>
    waitUntil(
      "batcher health",
      async () => {
        try {
          const r = await fetch(`${BATCHER_URL}/health`, { signal: AbortSignal.timeout(5000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      30,
      5000,
    ),
  );

  // Queued-at-kill blobs either published before death or were lost with the
  // in-memory queue (documented DedupStore/queue limitation). Either way the
  // network-level invariant is: each offer indexed at most once, and at most
  // one on-chain blob unless WE resubmitted.
  const resubmitted: string[] = [];
  for (const [i, hash] of hashes.entries()) {
    const indexed = await waitIndexed(hash);
    if (!indexed) {
      note("chaos", `blob ${hash.slice(0, 10)}… lost with the queue — resubmitting (documented restart limitation)`);
      resubmitted.push(hash);
      const { submitOffer2 } = await import("../lib/api2.ts");
      await submitOffer2(blobs[i]!);
      await waitIndexed(hash);
    }
  }

  const h2 = (await networkHeadHeight()) + 2;
  const counts = new Map<string, number>(hashes.map((h) => [h, 0]));
  for (let h = h1; h <= h2; h++) {
    try {
      for (const bytes of await getBlobsAt(h)) {
        const bh = offerHashFromBytes(bytes);
        if (counts.has(bh)) counts.set(bh, counts.get(bh)! + 1);
      }
    } catch {
      /* ignore unreadable heights */
    }
  }
  await check("chaos: no double blob on Celestia across batcher restart", async () => {
    for (const [hash, n] of counts) {
      const allowed = resubmitted.includes(hash) ? 2 : 1;
      if (n > allowed) return false;
    }
    return true;
  }, JSON.stringify([...counts.entries()].map(([h, n]) => `${h.slice(0, 8)}=${n}`)));

  await check("chaos: each chaos offer indexed exactly once", async () => {
    for (const hash of hashes) {
      const r = await db.query(
        `SELECT (SELECT count(*) FROM offer_file WHERE offer_hash=$1)
              + (SELECT count(*) FROM offer_file_history WHERE offer_hash=$1) AS n`,
        [hash],
      );
      if (Number(r.rows[0]?.n) !== 1) return false;
    }
    return true;
  });
}

/** Restart the STM/sync process; verify recovery without state loss. */
export async function chaosSync(db: Client): Promise<void> {
  await withChaosWindow("sync", () => chaosSyncBody(db));
}

async function chaosSyncBody(db: Client): Promise<void> {
  note("chaos", "restarting the sync/STM process via the orchestrator…");
  const beforeOffers = (await tableCount(db, "offer_file")) + (await tableCount(db, "offer_file_history"));
  const beforeNullifiers = await tableCount(db, "nullifiers");

  const ok = await orchestratorRestart("sync");
  await check("chaos: sync restarted via orchestrator", async () => ok);
  if (!ok) return;

  await check("chaos: sync process recovered (health returns)", async () =>
    waitUntil("sync recovered", async () => await getHealth(), 36, 5000),
  );

  await check("chaos: no state lost across the sync restart", async () => {
    const offers = (await tableCount(db, "offer_file")) + (await tableCount(db, "offer_file_history"));
    const nullifiers = await tableCount(db, "nullifiers");
    return offers >= beforeOffers && nullifiers >= beforeNullifiers;
  });
  await refreshPids();
}
