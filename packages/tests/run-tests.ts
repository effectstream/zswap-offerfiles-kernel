import path from "node:path";
import type { Client } from "pg";

import {
  anyError,
  getDBConnection,
  printSummary,
  startInfrastructure,
  stopInfrastructure,
  waitForHealth,
  waitForMigrations,
  waitForOrchestrator,
  waitForProcess,
} from "./helpers.ts";

const LAUNCHER_PATH = path.resolve(import.meta.dirname!, "./start.test.ts");

// Midnight parallel sync has 18s delay — increase assertion timeout
if (!process.env["E2E_MAX_TIMEOUT"]) {
  process.env["E2E_MAX_TIMEOUT"] = "180000";
}

async function main(): Promise<void> {
  let db: Client | null = null;
  try {
    await startInfrastructure(LAUNCHER_PATH);
    await waitForOrchestrator();

    // ── Phase A: Infrastructure ────────────────────────────────────────────
    console.log("\n--- Phase A: Infrastructure ---\n");
    await waitForProcess("celestia-bridge-wait", {
      waitForExit: true,
      timeoutMs: 180_000,
    });
    await waitForProcess("celestia-fund-bridge", {
      waitForExit: true,
      timeoutMs: 60_000,
    });
    console.log("Celestia infrastructure ready.");

    await waitForProcess("midnight-proof-server-wait", {
      waitForExit: true,
      timeoutMs: 180_000,
    });
    console.log("Midnight infrastructure ready.");

    const { celestiaReadyTest } = await import("./infra/celestia-ready.test.ts");
    await celestiaReadyTest();

    const { midnightReadyTest } = await import("./infra/midnight-ready.test.ts");
    await midnightReadyTest();

    await waitForProcess("midnight-contract", {
      waitForExit: true,
      timeoutMs: 300_000,
    });
    console.log("Offer-files contract deployed.");

    // Startup mint runs in parallel with sync; wait so Phase B doesn't race it.
    try {
      await waitForProcess("midnight-mint-test-tokens", {
        waitForExit: true,
        timeoutMs: 300_000,
      });
      console.log("Startup test-token mint finished.");
    } catch (e) {
      console.warn(
        `Startup mint did not finish cleanly: ${e instanceof Error ? e.message : String(e)} (continuing)`,
      );
    }

    await waitForProcess("sync");
    await waitForHealth();
    console.log("Sync node is healthy.\n");

    db = await getDBConnection();
    await waitForMigrations(db);

    // ── Phase B: State Machine / DB / offer build + settle ──────────────────
    console.log("\n--- Phase B: STM / DB / API ---\n");

    const { zswapFlowTest } = await import("./stm/zswap-flow.test.ts");
    await zswapFlowTest(db);

    const { apiTest } = await import("./stm/api.test.ts");
    await apiTest(db);

    const { multiTokenTest } = await import("./stm/multi-token.test.ts");
    await multiTokenTest(db);

    const { unshieldedOnlyTest } = await import("./stm/unshielded-only.test.ts");
    await unshieldedOnlyTest(db);

    const { rootUnknownTest } = await import("./stm/root-unknown.test.ts");
    await rootUnknownTest(db);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    printSummary();
    if (db) await db.end().catch(() => {});
    await stopInfrastructure();
    if (anyError() || process.exitCode) process.exit(1);
    process.exit(0);
  }
}

main();
