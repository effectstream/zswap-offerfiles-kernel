// The post-commit publication contract, pinned against a REAL held-open
// database transaction rather than against markBlockCommitted() alone.
//
// event-gate.test.ts asserts the gate's buffering logic directly and says, in
// so many words, that the integration test holding a block transaction open is
// still owed. This is that test.
//
// What it proves. Every emit site lives inside an STM transition, i.e. inside
// the runtime's block transaction. The pair_stats projection runs in an api.ts
// listener on a SEPARATE pool. If an event were published before COMMIT, that
// listener would read through its own connection, see no archive, write
// nothing, and never retry — while SSE had already announced a lifecycle
// transition a ROLLBACK could erase. So the property under test is not "the
// buffer counts correctly", it is: WHILE the archiving transaction is open, a
// second connection can neither see the archive nor be told about it.
//
// What it does NOT prove, stated rather than implied: the gate is an
// IN-PROCESS buffer. It orders publication correctly but does not make it
// durable — a crash between COMMIT and flush drops the projection update with
// nothing recording that it was owed. That is the outbox work, still open.
//
// HOW TO RUN IT: `bun run test:held-open`. The file is deliberately named
// `.pgtest.ts`, not `.test.ts`, so `bun test packages` does NOT pick it up.
// That is not squeamishness — it was measured. bun runs test files
// concurrently in one process, and this file's container startup and readiness
// polling destabilised its neighbours: first a synchronous spawn starved a
// neighbouring test into its 5 s timeout, then, once that was fixed, the two
// still interfered. A test that needs a Docker daemon and ~4 s of container
// lifecycle does not belong in a fast in-memory unit suite, and making the
// unit suite flaky to house it would trade a real guarantee for a nominal one.
//
// WHY REAL POSTGRESQL, AND NOT PGLITE LIKE EVERY OTHER TEST HERE. PGlite was
// tried first and CANNOT express this test: its socket server multiplexes every
// client onto one WASM backend, so a second "connection" reads straight through
// an open transaction. The reader saw the uncommitted archive — measured, not
// assumed — which would have made the test pass for the wrong reason and then
// pass forever even if the gate were deleted. So this one case provisions a
// real PostgreSQL in Docker on a random high port (workspace rule) and tears it
// down. It SKIPS cleanly where Docker is unavailable rather than failing the
// suite, because the rest of the suite must stay runnable without a daemon.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";

const pg = (await import("pg")).default;

/** A free TCP port above 10000 — this is a shared machine. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      srv.close(() => resolve(port >= 10000 ? port : port + 10000));
    });
  });
}

/**
 * Docker, asynchronously.
 *
 * NOT spawnSync: bun runs test files concurrently in one process, so a
 * synchronous spawn blocks every other file's event loop. Doing it
 * synchronously here starved a neighbouring test into its 5 s timeout —
 * measured, and the reason this looks more careful than it needs to.
 */
async function docker(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { ok: code === 0, out: out.trim() };
}

let dockerAvailable = false;
let container = "";
const { migrationTable, upsertPairStatsByOfferId } = await import("@zswap-da/database");
const {
  eventBus,
  emitAppEvent,
  markBlockCommitted,
  pendingEventCount,
  __resetEventGateForTests,
} = await import("../node/event-bus.ts");

let PORT = 0;
/** The "block transaction" connection — the runtime's. */
let writer: InstanceType<typeof pg.Client>;
/** The projection/API connection — a different pool, as in production. */
let reader: InstanceType<typeof pg.Client>;

const GIVE = "a".repeat(64);
const WANT = "b".repeat(64);
const MAKER = "m".repeat(64);
const OFFER_ID = 700;
const OFFER_HASH = "7".repeat(64);
const BLOCK = 4242;

function recorder() {
  const seen: any[] = [];
  const fn = (e: any) => seen.push(e);
  eventBus.on("app_event", fn);
  return { seen, stop: () => eventBus.off("app_event", fn) };
}

beforeAll(async () => {
  dockerAvailable = (await docker("info")).ok;
  if (!dockerAvailable) return;
  PORT = await freePort();
  const run = await docker(
    "run", "-d", "--rm",
    "-e", "POSTGRES_PASSWORD=postgres",
    "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_DB=postgres",
    "-p", `127.0.0.1:${PORT}:5432`,
    "postgres:17-alpine",
  );
  if (!run.ok) throw new Error(`docker run failed`);
  container = run.out;

  const connect = async () => {
    const c = new pg.Client({
      host: "127.0.0.1", port: PORT, user: "postgres",
      password: "postgres", database: "postgres",
    });
    await c.connect();
    return c;
  };
  // Wait on pg_isready INSIDE the container, not on a TCP connect from here.
  // The alpine entrypoint runs initdb against a temporary server and then
  // restarts, so the first successful connect can be to a server that is about
  // to go away — which showed up as "Connection terminated unexpectedly" once
  // the suite ran this file alongside the others.
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if ((await docker("exec", container, "pg_isready", "-U", "postgres", "-q")).ok) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("postgres container never became ready");
  writer = await connect();
  reader = await connect();
  for (const m of migrationTable) await writer.query(m.sql);

  // A live offer, and the chain evidence that settles it. Nothing is archived
  // yet — the archive is what the held-open transaction will do.
  await writer.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, first_seen_at)
     VALUES ($1, 900, 'blob', $2, NOW() - INTERVAL '1 hour', 3600, NOW())`,
    [OFFER_ID, OFFER_HASH],
  );
  await writer.query(
    `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
     VALUES ($1, $2, '10', 'GIVING', 'UNSHIELDED'), ($1, $3, '20', 'WANTING', 'UNSHIELDED')`,
    [OFFER_ID, GIVE, WANT],
  );
  await writer.query(
    `INSERT INTO offer_file_unshielded_spends (offer_file_id, owner, intent_hash, output_no)
     VALUES ($1, $2, 'spend-intent', 0)`,
    [OFFER_ID, MAKER],
  );
  await writer.query(
    `INSERT INTO offer_file_unshielded_outputs (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
     VALUES ($1, $2, 'payout-intent', 0, $3, '20', 1)`,
    [OFFER_ID, MAKER, WANT],
  );
  await writer.query(
    `INSERT INTO unshielded_spends (owner, intent_hash, output_no, tx_hash, height)
     VALUES ($1, 'spend-intent', 0, 'tx-settle', 1)`,
    [MAKER],
  );
  await writer.query(
    `INSERT INTO unshielded_creates (owner, intent_hash, output_no, tx_hash, token_type, value, height)
     VALUES ($1, 'payout-intent', 0, 'tx-settle', $2, '20', 1)`,
    [MAKER, WANT],
  );
  __resetEventGateForTests();
});

afterAll(async () => {
  try { await writer?.end(); } catch { /* noop */ }
  try { await reader?.end(); } catch { /* noop */ }
  if (container) await docker("rm", "-f", container);
});

test("nothing is published, and nothing is projected, while the block transaction is open", async () => {
  if (!dockerAvailable) {
    console.log("[held-open] SKIPPED — no Docker daemon; needs real PostgreSQL");
    return;
  }
  const r = recorder();

  // ── Inside the runtime's block transaction ──────────────────────────────
  await writer.query("BEGIN");
  await writer.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, ttl_seconds, archive_reason, archived_at, first_seen_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds,
            'CONSUMED', NOW() - INTERVAL '1 minute', first_seen_at
       FROM offer_file WHERE id = $1`,
    [OFFER_ID],
  );
  await writer.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     SELECT offer_file_id, token_color, amount, direction, kind, NOW() - INTERVAL '1 minute'
       FROM offer_file_tokens WHERE offer_file_id = $1`,
    [OFFER_ID],
  );
  await writer.query(
    `INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
     SELECT offer_file_id, owner, intent_hash, output_no, NOW() - INTERVAL '1 minute'
       FROM offer_file_unshielded_spends WHERE offer_file_id = $1`,
    [OFFER_ID],
  );
  await writer.query(
    `INSERT INTO offer_file_unshielded_outputs_history (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
     SELECT offer_file_id, owner, intent_hash, output_no, token_type, value, count
       FROM offer_file_unshielded_outputs WHERE offer_file_id = $1`,
    [OFFER_ID],
  );
  await writer.query(`DELETE FROM offer_file WHERE id = $1`, [OFFER_ID]);

  // The transition emits here — inside the transaction, exactly as production
  // does, with the producing block height.
  emitAppEvent(
    { type: "offer_consumed", offerId: OFFER_ID, offerHash: OFFER_HASH },
    BLOCK,
  );

  // THE ASSERTION. The event is held, not published: a listener acting on it
  // now would be acting on state that does not exist for anyone else.
  expect(r.seen.length).toBe(0);
  expect(pendingEventCount()).toBe(1);

  // And the reader's connection genuinely cannot see the archive — this is
  // what makes the test an integration test rather than a restatement of the
  // buffer's own bookkeeping.
  const archivedDuring = await reader.query(
    `SELECT 1 FROM offer_file_history WHERE offer_hash = $1`, [OFFER_HASH],
  );
  expect(archivedDuring.rowCount).toBe(0);

  // Had the event escaped, this is the projection the listener would have run.
  // It reads nothing and writes nothing — the silent, unretried loss.
  await upsertPairStatsByOfferId.run({ offer_id: OFFER_ID }, reader);
  const statsDuring = await reader.query(`SELECT COUNT(*)::int AS n FROM pair_stats`);
  expect(statsDuring.rows[0].n).toBe(0);

  // ── COMMIT, then the gate observes the height and releases ───────────────
  await writer.query("COMMIT");

  const archivedAfter = await reader.query(
    `SELECT 1 FROM offer_file_history WHERE offer_hash = $1`, [OFFER_HASH],
  );
  expect(archivedAfter.rowCount).toBe(1);

  markBlockCommitted(BLOCK);
  expect(r.seen.length).toBe(1);
  expect(r.seen[0].offerHash).toBe(OFFER_HASH);
  expect(pendingEventCount()).toBe(0);

  // Now the same projection, run at the moment the event actually arrives,
  // sees the committed archive and records the trade.
  await upsertPairStatsByOfferId.run({ offer_id: OFFER_ID }, reader);
  const statsAfter = await reader.query(`SELECT trade_count FROM pair_stats`);
  expect(statsAfter.rows[0].trade_count).toBe(1);

  r.stop();
});
