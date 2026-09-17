import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { run } from "effection";
import { World } from "@effectstream/coroutine";
import { newScheduledTimestampData } from "@effectstream/db";
import { getMigrations } from "@effectstream/db/version";
import type { StartConfig, StartConfigGameStateTransitions } from "@effectstream/runtime";
import { AddressType } from "@effectstream/utils";

import { migrationTable, recordOfferRejection } from "@zswap-da/database";
import { closeTestPglite } from "../database/test-pglite.ts";
import { failStopAppInput } from "./app-input-savepoint.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;

// processFinalizedBlock is intentionally not part of runtime's public API. A
// file-URL import lets this regression exercise the exact pinned executor
// without copying its logic or widening a production dependency surface.
const runtimeEntry = import.meta.resolve("@effectstream/runtime");
const { processFinalizedBlock } = await import(
  new URL("./process-blocks.ts", runtimeEntry).href
) as typeof import("@effectstream/runtime") & {
  processFinalizedBlock: (...args: any[]) => Generator<any, any, any>;
};

let handle: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client>;

async function randomFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate a TCP test port"));
        return;
      }
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await randomFreePort();
  if (port < 10_000) throw new Error(`test port must be >= 10000, got ${port}`);
  handle = await startPglite(port);
  client = new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();

  for (const migration of await getMigrations()) {
    await client.query(migration.sql);
  }
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }

  // deleteScheduled removes the input and cascades away rollup_input_result.
  // Keep a test-only audit of the result INSERT so the assertion can prove the
  // runtime still records failed/successful inputs before removing them.
  await client.query(`
    CREATE TABLE app_input_result_audit (
      id INTEGER PRIMARY KEY,
      success BOOLEAN NOT NULL
    );
    CREATE FUNCTION audit_app_input_result() RETURNS trigger AS $$
    BEGIN
      INSERT INTO app_input_result_audit(id, success)
      VALUES (NEW.id, NEW.success);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER audit_app_input_result_trigger
      AFTER INSERT ON effectstream.rollup_input_result
      FOR EACH ROW EXECUTE FUNCTION audit_app_input_result();
  `);
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

test("the app savepoint isolates JavaScript faults while DB faults force full-block rollback", async () => {
  const blockTimestamp = Date.parse("2026-08-13T12:00:00.000Z");
  const scheduledIds: number[] = [];
  for (const [inputData, offset] of [["fail-after-write", -1], ["succeed", 0]] as const) {
    await newScheduledTimestampData.run({
      from_address: "0x0",
      from_address_type: AddressType.NONE,
      future_ms_timestamp: new Date(blockTimestamp + offset),
      input_data: inputData,
    }, client);
    const row = await client.query(
      "SELECT id FROM effectstream.rollup_inputs WHERE input_data = $1",
      [inputData],
    );
    scheduledIds.push(Number(row.rows[0].id));
  }

  const probeEvent = { name: "savepoint-probe" } as any;
  const gameStateTransitions: StartConfigGameStateTransitions = function* (_height, input) {
    yield* failStopAppInput(function* () {
      const fails = input.conciseInput === "fail-after-write";
      yield* World.resolve(recordOfferRejection, {
        celestia_height: 777,
        code: fails ? "ROLLED_BACK_JS_FAULT" : "COMMITTED_AFTER_FAULT",
      });
      input.emit(probeEvent, { input: input.conciseInput });
      if (fails) throw new Error("synthetic JavaScript failure after SQL write");
    });
  };
  const config: StartConfig = {
    appName: "savepoint-regression",
    appVersion: "1.0.0",
    syncInfo: [],
    gameStateTransitions,
  };

  const block = {
    blockNumber: 1,
    timestamp: blockTimestamp,
    blockInfo: [],
    resumePages: [],
    primitives: [],
  } as any;
  let appFailure: unknown;
  try {
    await run(function* () {
      return yield* processFinalizedBlock(block, config, client as any, null);
    });
  } catch (error) {
    appFailure = error;
  }
  // The compatibility guard deliberately poisons the transaction after it
  // restores the per-input savepoint. Runtime bookkeeping then reaches 25P02,
  // its outer handler rolls the entire block back, and no input is discarded.
  expect((appFailure as { code?: string })?.code).toBe("25P02");

  const rejectionRows = await client.query(
    "SELECT code, count FROM offer_rejections WHERE celestia_height = 777 ORDER BY code",
  );
  expect(rejectionRows.rows).toEqual([]);

  const auditRows = await client.query(
    "SELECT id, success FROM app_input_result_audit ORDER BY id",
  );
  expect(auditRows.rows).toEqual([]);
  const scheduled = await client.query(
    "SELECT id FROM effectstream.rollup_inputs WHERE id = ANY($1::int[])",
    [scheduledIds],
  );
  expect(scheduled.rows.map((row) => Number(row.id)).sort()).toEqual(scheduledIds.toSorted());
  expect((await client.query(
    "SELECT block_height FROM effectstream.effectstream_blocks WHERE block_height = 1",
  )).rows).toEqual([]);

  // Simulate operator recovery/removal of the poison input. The following
  // scheduled input was retained by the rollback and can now commit normally.
  await client.query("DELETE FROM effectstream.rollup_inputs WHERE id = $1", [scheduledIds[0]]);
  const result = await run(function* () {
    return yield* processFinalizedBlock(block, config, client as any, null);
  });
  expect((await client.query(
    "SELECT code, count FROM offer_rejections WHERE celestia_height = 777 ORDER BY code",
  )).rows).toEqual([{ code: "COMMITTED_AFTER_FAULT", count: 1 }]);
  expect((await client.query(
    "SELECT id, success FROM app_input_result_audit ORDER BY id",
  )).rows).toEqual([{ id: scheduledIds[1], success: true }]);
  expect((await client.query(
    "SELECT id FROM effectstream.rollup_inputs WHERE id = $1",
    [scheduledIds[1]],
  )).rows).toEqual([]);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].event).toBe(probeEvent);
  expect(result.events[0].payload).toEqual({ input: "succeed", blockHeight: 1 });
  const committedBlock = await client.query(
    "SELECT block_height FROM effectstream.effectstream_blocks WHERE block_height = 1",
  );
  expect(committedBlock.rows).toHaveLength(1);

  // Pin the remaining upstream limitation too. query.run failures occur in
  // Effectstream's executor, outside generator.next(), so they are never
  // injected into withAppInputSavepoint's catch. PostgreSQL still preserves
  // atomicity: the failed statement aborts the transaction, the runtime's next
  // bookkeeping statement returns 25P02, and the outer block handler rolls
  // back the entire block. The scheduled input remains for operator/runtime
  // recovery, but later inputs cannot be isolated until Effectstream invokes
  // its own per-input SAVEPOINT helper.
  const dbFaultTimestamp = blockTimestamp + 1_000;
  await newScheduledTimestampData.run({
    from_address: "0x0",
    from_address_type: AddressType.NONE,
    future_ms_timestamp: new Date(dbFaultTimestamp),
    input_data: "database-fault",
  }, client);
  const dbFaultInput = await client.query(
    "SELECT id FROM effectstream.rollup_inputs WHERE input_data = 'database-fault'",
  );
  const dbFaultId = Number(dbFaultInput.rows[0].id);
  const dbFaultTransitions: StartConfigGameStateTransitions = function* () {
    yield* failStopAppInput(function* () {
      yield* World.resolve(recordOfferRejection, {
        celestia_height: 778,
        code: "WRITE_BEFORE_DATABASE_FAULT",
      });
      // Required parameter reaches PostgreSQL as NULL and violates NOT NULL.
      // The executor does not call generator.throw(error), so our catch cannot
      // downgrade this to an isolated failed input.
      yield* World.resolve(recordOfferRejection, {
        celestia_height: 778,
        code: null as any,
      });
    });
  };
  let dbFailure: unknown;
  try {
    await run(function* () {
      return yield* processFinalizedBlock(
        {
          blockNumber: 2,
          timestamp: dbFaultTimestamp,
          blockInfo: [],
          resumePages: [],
          primitives: [],
        } as any,
        { ...config, gameStateTransitions: dbFaultTransitions },
        client as any,
        result.blockHash,
      );
    });
  } catch (error) {
    dbFailure = error;
  }
  expect((dbFailure as { code?: string })?.code).toBe("25P02");
  expect((await client.query(
    "SELECT code FROM offer_rejections WHERE celestia_height = 778",
  )).rows).toEqual([]);
  expect((await client.query(
    "SELECT block_height FROM effectstream.effectstream_blocks WHERE block_height = 2",
  )).rows).toEqual([]);
  expect((await client.query(
    "SELECT id FROM effectstream.rollup_inputs WHERE id = $1",
    [dbFaultId],
  )).rows).toEqual([{ id: dbFaultId }]);
  expect((await client.query(
    "SELECT id FROM app_input_result_audit WHERE id = $1",
    [dbFaultId],
  )).rows).toEqual([]);
});
