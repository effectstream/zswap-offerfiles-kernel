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

  lines.push(`## 🔴 CRITICAL — unauthenticated remote node crash (found by this suite, NOT patched)`);
  lines.push(``);
  lines.push(
    `**One 0x00 byte in any namespace blob kills every ZSwap-DA indexer.** Nothing ever *writes* a NUL ` +
      `into a text column — JSON escaping makes the write legal. It bites where the blob body is used as ` +
      `a **lookup key**: the STM's scrub (\`deleteRejectedAccountingRow\`) asks Postgres to extract the ` +
      `stored body back to text with \`->>\` and compare it to the raw latin1 string as a parameter. Both ` +
      `halves are illegal — the extraction raises \`unsupported Unicode escape sequence\` and the ` +
      `parameter raises \`invalid byte sequence for encoding "UTF8": 0x00\`. STF errors go to telemetry ` +
      `only (HANDOFF gotcha #2), so nothing is logged; the next statement in the same block transaction ` +
      `dies \`25P02 current transaction is aborted\`, exiting the sync process (code 1) and taking the ` +
      `orchestrator with it.`,
  );
  lines.push(``);
  lines.push(
    `Blast radius exceeds the poison blob: the failing half is the extraction of the **stored** row, so ` +
      `the scrub dies for every blob sharing that Celestia height, legitimate offers included. And since ` +
      `the namespace is permissionless **by design**, this is an unauthenticated remote crash of the ` +
      `whole network's indexers for one blob fee — binary junk contains 0x00 by default, so it is the ` +
      `ordinary outcome of spam, not a sophisticated attack, on the exact path built to survive hostile ` +
      `input.`,
  );
  lines.push(``);
  lines.push(
    `**No migration required.** Never extract the body to text: matching the whole document ` +
      `(\`payload::text = :param\`) or the existing generated column (\`payload_hash = md5(:param)\`) both ` +
      `delete the row correctly, because the JSON text carries the escape as literal characters, leaving ` +
      `the parameter clean ASCII. The \`payload_hash\` form is additionally an index probe on ` +
      `(primitive_name, effectstream_block_height, payload_hash) rather than today's body comparison. ` +
      `Reproduced standalone in seconds via \`bun run packages/tests/grand-e2e/nul-crash-repro.ts\` ` +
      `(PGlite, no stack). Per the handoff this is reported, not worked around: the suite's garbage ` +
      `fixtures are NUL-free so the remaining checks can run, and \`GRAND_NUL_CRASH_REPRO=1\` publishes ` +
      `one NUL-bearing blob to reproduce the crash on demand.`,
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
