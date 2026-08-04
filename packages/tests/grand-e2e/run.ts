// Grand e2e runner — `bun run test:grand`
//
// Prereq (HANDOFF §2/§3): the dev stack must already be running, launched as
//   NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev
// This runner does NOT start the stack (a stack restart wipes pglite).
//
// Phase order: p0 smoke → actor setup → p1 happy → p2 api → p4 adversarial →
// p3 lifecycle → p5 load (with p6 chaos inside) → p7b audit → p7a determinism.
// 7b runs before 7a on purpose: live-fated offers are only live for ~10 min,
// while the determinism replay needs the chain quiet — see p7-determinism.ts.
//
// Not wired into CI. Manual invocation only.

import { getDBConnection } from "../helpers.ts";
import { FATE_SPLIT, TOTAL_OFFERS } from "./config.ts";
import { ledger } from "./ledger.ts";
import { setupActors, stopActors, type Actors } from "./actors/wallets.ts";
import { SseRecorder } from "./lib/sse.ts";
import {
  allResults,
  beginPhase,
  endPhases,
  ensureOutDir,
  failures,
  note,
  phaseTimings,
  writeOut,
} from "./lib/util.ts";
import { initMetrics } from "./metrics.ts";
import { p0Smoke } from "./phases/p0-smoke.ts";
import { p1Happy } from "./phases/p1-happy.ts";
import { p2Api } from "./phases/p2-api.ts";
import { p3Lifecycle } from "./phases/p3-lifecycle.ts";
import { p3bCompeting } from "./phases/p3b-competing.ts";
import { p4Adversarial } from "./phases/p4-adversarial.ts";
import { p5Load } from "./phases/p5-load.ts";
import { spawnedProcesses } from "./phases/p6-chaos.ts";
import { p7Determinism, type DeterminismOutcome } from "./phases/p7-determinism.ts";
import { p7bAudit } from "./phases/p7b-audit.ts";

function writeScorecard(determinism: DeterminismOutcome | null): void {
  const results = allResults();
  const fails = failures();
  const lines: string[] = [];
  lines.push(`# Grand E2E Scorecard`);
  lines.push(``);
  lines.push(`Run finished ${new Date().toISOString()} — ${results.length} checks, ${fails.length} failures.`);
  lines.push(``);

  lines.push(`## Phases`);
  lines.push(``);
  lines.push(`| Phase | Checks | Failures | Duration |`);
  lines.push(`|---|---|---|---|`);
  const phases = [...new Set(results.map((r) => r.phase))];
  const timings = phaseTimings();
  for (const phase of phases) {
    const rs = results.filter((r) => r.phase === phase);
    const f = rs.filter((r) => !r.ok).length;
    const mins = ((timings[phase] ?? 0) / 60_000).toFixed(1);
    lines.push(`| ${phase} | ${rs.length} | ${f === 0 ? "0 ✅" : `${f} ❌`} | ${mins} min |`);
  }
  lines.push(``);

  lines.push(`## Offer fates (ledger vs plan)`);
  lines.push(``);
  lines.push(`| Fate | Target | Resolved | Casualties |`);
  lines.push(`|---|---|---|---|`);
  for (const fate of ["settled", "cancelled", "expired", "live"] as const) {
    const target = Math.round(TOTAL_OFFERS * FATE_SPLIT[fate]);
    const resolved = ledger.offers.filter(
      (o) => o.fate === fate && (o.state === "resolved" || (fate === "live" && o.state === "indexed")),
    ).length;
    const cas = ledger.casualties().filter((o) => o.fate === fate).length;
    lines.push(`| ${fate} | ${target} | ${resolved} | ${cas} |`);
  }
  lines.push(``);
  const casualties = ledger.casualties();
  if (casualties.length > 0) {
    lines.push(`### Casualties (environmental, budgeted)`);
    lines.push(``);
    for (const c of casualties) lines.push(`- offer#${c.index} (${c.fate}): ${c.casualtyReason}`);
    lines.push(``);
  }

  lines.push(`## Determinism (MIP-0005 cross-node identity)`);
  lines.push(``);
  if (determinism) {
    lines.push(`Mode: **${determinism.mode}** — identical: **${determinism.identical ?? "n/a (fallback)"}**`);
    lines.push(``);
    lines.push(
      `\`offerId\` (sha256 of raw offer bytes) matching across independently-synced instances is ` +
        `the cross-node identity claim of MIP-0005 — asserted in p7a.`,
    );
    lines.push(``);
    for (const line of determinism.report) lines.push(`- ${line}`);
  } else {
    lines.push(`Not reached.`);
  }
  lines.push(``);

  lines.push(`## Product bugs found by this suite — fixed`);
  lines.push(``);
  lines.push(
    `- **Archive timestamps were wall-clock, not chain time.** Every archive INSERT omitted ` +
      `\`archived_at\` (falling to \`DEFAULT NOW()\`) and the pair_stats upsert wrote \`NOW()\` ` +
      `directly, so trade timestamps recorded when THIS NODE indexed a fill — divergent across ` +
      `replicas (measured: instance B replaying A's chain matched on last_price and offer_hash ` +
      `sets but stamped trades ~22 min later) and wrong after any resync. Fixed: every ` +
      `\`*_history\` INSERT carries the L2 block timestamp, the columns are NOT NULL with no ` +
      `default, pair_stats copies the archived row's time, and the determinism diff now ENFORCES ` +
      `both columns instead of excluding them.`,
  );
  lines.push(
    `- **The root window was not enforced on read.** Pruning is write-triggered ` +
      `(midnight-zswap-root transition) and stops when the chain goes quiet; \`isKnownRoot\` had ` +
      `no age predicate, so offers proving against expired roots stayed acceptable (measured: the ` +
      `foreign Lace fixture accepted on a 20-min-old root under the 3600s default). Fixed: both ` +
      `gates use \`isKnownRootLive\` — chain-derived cutoff on the last_seen_ms clock, with a ` +
      `MAX(height) escape mirroring the ledger's past_roots re-insertion so the current root ` +
      `stays valid on a quiet chain.`,
  );

  lines.push(``);
  lines.push(
    `- **\`0x00\` in any blob body crashed the node** (PR #22). The rejection path used the blob body ` +
      `as a lookup key; Postgres cannot represent NUL in text, so the block transaction aborted and the ` +
      `sync process exited — taking the orchestrator with it. Not adversarial-only: the live crash came ` +
      `from an ordinary \`NOT_A_SWAP\` rejection of a well-formed transaction, and every real Midnight ` +
      `transaction contains 0x00. On a permissionless namespace it doubled as an unauthenticated remote ` +
      `crash for one blob fee. Fixed by matching the body's JSON encoding instead.`,
  );
  lines.push(
    `- **Batcher settled one transaction at a time** (PR #23). The balancer ran a single worker (~2.4 ` +
      `tx/min) — the whole system's settlement ceiling — because the SDK's per-wallet slot cap was left ` +
      `at 1 while the wallet already held 5 dust UTXOs. Now configurable; 5x on dev.`,
  );
  lines.push(
    `- **Rate limiting answered \`500 INTERNAL\` instead of \`429\`** (PR #24). The limiter worked and set ` +
      `correct headers, but \`errorResponseBuilder\` omitted \`statusCode\`, so the error handler's 4xx ` +
      `branch missed and clients were told "server fault" rather than "back off".`,
  );
  lines.push(
    `- **\`TOO_LARGE\` was unreachable over HTTP** (PR #24). Fastify's 1 MiB body limit fired before the ` +
      `validator, since \`OFFER_MAX_BYTES\` is 1 MiB *decoded* and bech32m inflates ~1.6x.`,
  );
  lines.push(
    `- **\`celestiaHeight\` was never a Celestia height** (PR #25) — it is the indexer's own L2 block ` +
      `height, so the documented \`blob.GetAll\` verification workflow could not work. Renamed to ` +
      `\`blockHeight\`; the real height is dropped at the DA primitive boundary, and carrying it through ` +
      `was judged disproportionate for a display field.`,
  );
  lines.push(
    `- **State-transition errors were invisible** (PR #25), reported to telemetry only — which is why ` +
      `the NUL crash took hours to localise rather than minutes. Transitions now log and rethrow.`,
  );
  lines.push(``);
  lines.push(`## Documented gaps asserted as current behavior`);
  lines.push(``);
  lines.push(
    `- **Unshielded-only cancel classification**: unshielded spends are not tx-grouped yet, so a ` +
      `maker walking away from an unshielded-only offer reads \`consumed\`. Asserted (not fixed) in p3.`,
  );
  lines.push(
    `- **Batcher DedupStore restart window**: in-memory published-hash set empties on restart; a ` +
      `replay across a restart can cost one duplicate blob fee (never a duplicate index). Exercised in p6.`,
  );
  lines.push(``);

  if (fails.length > 0) {
    lines.push(`## Failures`);
    lines.push(``);
    for (const f of fails) lines.push(`- **${f.phase}** ▸ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    lines.push(``);
  }

  lines.push(`## Artifacts`);
  lines.push(``);
  lines.push(`- \`out/metrics.json\` — collected metrics (calibration values when no baseline is committed)`);
  lines.push(`- \`out/ledger.json\` — every action the suite performed with its expected fate`);
  lines.push(`- \`out/state-A.json\`${determinism?.mode === "second-instance" ? " / `out/state-B.json`" : ""} — determinism dumps`);
  lines.push(`- \`out/determinism-report.txt\` — per-table diff report`);
  lines.push(``);
  lines.push(`> Note: chaos phases replace the orchestrator-launched indexer/batcher with runner-spawned`);
  lines.push(`> equivalents; those are terminated when this runner exits, so restart the stack before another run.`);

  writeOut("../SCORECARD.md", lines.join("\n"));
  console.log(`\nSCORECARD written to packages/tests/grand-e2e/SCORECARD.md`);
}

async function main(): Promise<void> {
  ensureOutDir();
  const startedAt = Date.now();
  ledger.suiteStartedAt = startedAt;
  const db = await getDBConnection();
  const sse = new SseRecorder();
  let actors: Actors | null = null;
  let determinism: DeterminismOutcome | null = null;

  try {
    await p0Smoke(db);
    if (failures().length > 0) {
      throw new Error("smoke failed — is the stack running with ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600?");
    }

    await initMetrics();
    sse.start();

    beginPhase("setup");
    note(
      "BUG FOUND & FIXED (packages/batcher/celestia.ts)",
      "batcher-sdk 0.103.0 moved buildBatchData's rawData under .data; the raw-bytes override read the " +
        "0.101.x location, threw on undefined, and a silent catch published the UTF-8 bech32m string — " +
        "every API-submitted offer was rejected BAD_DESERIALIZE at STM ingestion (end-to-end DA breakage " +
        "on the PR #19 stack). Fixed + regression test in celestia.test.ts; the catch now throws loudly.",
    );
    actors = await setupActors(TOTAL_OFFERS);
    note("setup", "actors funded and split into per-offer coins");

    const art = await p1Happy(db, actors, sse);
    if (!art) throw new Error("p1 happy path failed — aborting (nothing downstream can pass)");

    await p2Api(db, art);
    await p4Adversarial(db, art);
    await p3Lifecycle(db, actors);
    await p3bCompeting(db, actors);
    await p5Load(db, actors, art);
    await p7bAudit(db, sse);
    determinism = await p7Determinism(db);
  } catch (e) {
    console.error("\n[grand-e2e] fatal:", e);
    process.exitCode = 1;
  } finally {
    endPhases();
    ledger.persist();
    sse.stop();
    if (actors) await stopActors(actors).catch(() => {});
    for (const proc of spawnedProcesses) {
      try {
        proc.kill();
      } catch { /* already gone */ }
    }
    writeScorecard(determinism);

    const fails = failures();
    const mins = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`\n[grand-e2e] ${allResults().length} checks, ${fails.length} failures, ${mins} min.`);
    if (fails.length > 0) {
      for (const f of fails) console.log(`  FAIL ${f.phase} ▸ ${f.name}`);
      process.exitCode = 1;
    }
    await db.end().catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((e) => {
  // e.g. DB connection refused — the stack is not running at all.
  console.error("[grand-e2e] could not start:", e instanceof Error ? e.message : e);
  console.error("Launch the stack first: NODE_ENV=development ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev");
  process.exit(1);
});
