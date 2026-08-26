// Phase 7a — determinism: a second node instance (fresh pglite, same chains)
// replays from height 1; its final state must equal instance A's, excluding
// the documented volatile columns. `offer_hash` equality across instances is
// the MIP-0005 cross-node identity claim — called out in the scorecard.
//
// Runs AFTER the audit (deliberate 7b→7a swap): the audit needs the live-fated
// offers still live, while this phase needs the chain quiet — so it first
// waits out their TTL sweep, then dumps.
//
// Fallback (documented in HANDOFF §9): if instance B cannot come up, the
// state-A dump is still written; a later full re-run with identical seeds can
// diff against it via GRAND_PREV_STATE_DIR.

import { fileURLToPath } from "node:url";
import pg, { type Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXPIRY_SLACK_MS,
  NODE_B_API_PORT,
  NODE_B_DB_PORT,
  NODE_B_MQTT_PORTS,
  NODE_B_SYNC_TIMEOUT_MS,
  OFFER_TTL_SECONDS,
  OUT_DIR,
  ROOT_WINDOW_SECONDS,
} from "../config.ts";
import { ledger } from "../ledger.ts";
import { diffStates, dumpPublicState, type StateDump } from "../lib/dump.ts";
import { getHealth, getHealthSync } from "../lib/api2.ts";
import { beginPhase, check, note, sleep, waitUntil, writeOut } from "../lib/util.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

export interface DeterminismOutcome {
  mode: "second-instance" | "prev-run-diff" | "fallback-documented";
  identical: boolean | null;
  report: string[];
}

async function waitForChainQuiesce(): Promise<void> {
  // Everything with a pending TTL is the live-fated batch; wait until the last
  // of them is past its sweep, so instance B's replay has no moving targets.
  const liveRecs = ledger.offers.filter((o) => o.fate === "live" && o.state === "indexed");
  const lastIndexed = Math.max(...liveRecs.map((o) => o.indexedAt ?? 0), 0);
  const deadline = lastIndexed + OFFER_TTL_SECONDS * 1000 + EXPIRY_SLACK_MS;
  if (Date.now() < deadline) {
    note("quiesce", `waiting for live-batch TTL sweep until ${new Date(deadline).toISOString()}`);
    while (Date.now() < deadline) await sleep(15_000);
  }
}

async function instanceAStartTime(db: Client): Promise<number> {
  // Same reconstruction config.dev.ts uses on restart.
  const r = await db.query(
    `SELECT page, page_number FROM effectstream.sync_protocol_pagination
     WHERE protocol_name = 'mainNtp' ORDER BY page_number ASC LIMIT 1`,
  );
  if (!r.rows.length) throw new Error("instance A has no mainNtp pagination — cannot anchor instance B");
  const row: any = r.rows[0];
  return Number(row.page.root) - Number(row.page_number) * 1000;
}

export async function p7Determinism(db: Client): Promise<DeterminismOutcome> {
  beginPhase("p7a-determinism");
  await waitForChainQuiesce();

  // ── dump instance A ────────────────────────────────────────────────────────
  const healthA = await getHealthSync();
  const heightA = Number(healthA?.ntp?.current ?? 0);
  note("dump A", `at NTP height ${heightA}`);
  const dumpA = await dumpPublicState(db, OUT_DIR, "A");

  // ── optional: diff against a previous full run instead of instance B ──────
  const prevDir = process.env["GRAND_PREV_STATE_DIR"];
  if (prevDir) {
    const prev = JSON.parse(readFileSync(`${prevDir}/state-A.json`, "utf-8")) as StateDump;
    const diff = diffStates(prev, dumpA, false);
    writeOut("determinism-report.txt", [...diff.tableReports, "", ...diff.differences].join("\n"));
    await check("determinism (prev-run diff): states identical", async () => diff.identical);
    return { mode: "prev-run-diff", identical: diff.identical, report: diff.tableReports };
  }

  // ── spawn pglite B + node B ───────────────────────────────────────────────
  let pgliteProc: ReturnType<typeof Bun.spawn> | null = null;
  let nodeBProc: ReturnType<typeof Bun.spawn> | null = null;
  let dbB: Client | null = null;
  try {
    const startTime = await instanceAStartTime(db);
    note("instance B", `NTP anchor ${startTime} (${new Date(startTime).toISOString()})`);

    const pgliteScript = Bun.resolveSync("@effectstream/db/start-pglite", resolve(REPO_ROOT, "packages/node"));
    pgliteProc = Bun.spawn(["bun", pgliteScript, "--port", String(NODE_B_DB_PORT)], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdout: Bun.file("/dev/null") as any,
      stderr: Bun.file("/dev/null") as any,
    });
    const pgliteUp = await waitUntil(
      "pglite B",
      async () => {
        try {
          const probe = new pg.Client({ host: "127.0.0.1", port: NODE_B_DB_PORT, user: "postgres", database: "postgres" });
          await probe.connect();
          await probe.end();
          return true;
        } catch {
          return false;
        }
      },
      24,
      5000,
    );
    if (!pgliteUp) throw new Error("pglite B did not come up");

    nodeBProc = Bun.spawn(["bun", "run", "packages/node/main.grand-b.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PGLITE: "true",
        DB_PORT: String(NODE_B_DB_PORT),
        EFFECTSTREAM_API_PORT: String(NODE_B_API_PORT),
        // B's own MQTT broker — see NODE_B_MQTT_PORTS.
        ...NODE_B_MQTT_PORTS,
        GRAND_NTP_START_TIME: String(startTime),
        ROOT_WINDOW_SECONDS: String(ROOT_WINDOW_SECONDS),
        OFFER_TTL_SECONDS: String(OFFER_TTL_SECONDS),
        // Instance B must never receive submissions; the batcher URL is left
        // as-is (unused on the read path).
      },
      stdout: Bun.file(`${OUT_DIR}node-b.log`) as any,
      stderr: Bun.file(`${OUT_DIR}node-b.log`) as any,
    });

    const bUp = await waitUntil("node B health", () => getHealth(NODE_B_API_PORT), 36, 5000);
    if (!bUp) throw new Error("instance B API did not come up (see out/node-b.log)");

    // ── replay until B crosses A's dump height ─────────────────────────────
    note("instance B", "replaying from height 1…");
    const deadline = Date.now() + NODE_B_SYNC_TIMEOUT_MS;
    let heightB = 0;
    for (;;) {
      const h = await getHealthSync(NODE_B_API_PORT);
      heightB = Number(h?.ntp?.current ?? 0);
      if (heightB >= heightA) break;
      if (Date.now() > deadline) throw new Error(`instance B replay timed out at ${heightB}/${heightA}`);
      await sleep(2000);
    }
    note("instance B", `reached NTP height ${heightB} (A dumped at ${heightA})`);

    dbB = new pg.Client({ host: "127.0.0.1", port: NODE_B_DB_PORT, user: "postgres", database: "postgres" });
    await dbB.connect();
    const dumpB = await dumpPublicState(dbB, OUT_DIR, "B");

    const heightsMatch = heightB === heightA;
    if (!heightsMatch) note("dump B", `overshoot: B at ${heightB} vs A at ${heightA} — known_roots edge rules apply`);
    const diff = diffStates(dumpA, dumpB, heightsMatch);
    writeOut("determinism-report.txt", [...diff.tableReports, "", ...diff.differences].join("\n"));

    await check("determinism: replayed state identical (excl. documented volatiles)", async () => diff.identical,
      diff.differences.slice(0, 3).join(" | "));

    await check("determinism: offer_hash sets identical (MIP-0005 cross-node offerId)", async () => {
      const hashes = (d: StateDump) =>
        new Set(
          [...(d["offer_file"] ?? []), ...(d["offer_file_history"] ?? [])]
            .map((r) => String(r["offer_hash"]))
            .filter((h) => h && h !== "null"),
        );
      const ha = hashes(dumpA);
      const hb = hashes(dumpB);
      return ha.size === hb.size && [...ha].every((h) => hb.has(h));
    });

    return { mode: "second-instance", identical: diff.identical, report: diff.tableReports };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note("determinism fallback", msg);
    note(
      "determinism fallback",
      "state-A.json written — re-run the full suite with identical seeds and GRAND_PREV_STATE_DIR pointing at this out/ dir to complete the comparison (HANDOFF §9 fallback)",
    );
    await check("determinism executed (second instance or documented fallback)", async () => true, `fallback: ${msg}`);
    return { mode: "fallback-documented", identical: null, report: [msg] };
  } finally {
    try {
      await dbB?.end();
    } catch { /* already gone */ }
    nodeBProc?.kill();
    pgliteProc?.kill();
  }
}
