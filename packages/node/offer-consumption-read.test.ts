import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";

import { closeTestPglite } from "../database/test-pglite.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const fastify = (await import("fastify")).default;
const { migrationTable } = await import("@zswap-da/database");
const { registerOfferConsumptionRoute } = await import("./offer-consumption-read.ts");

const LEDGER_A = "aa".repeat(32);
const LEDGER_B = "bb".repeat(32);
const hashOf = (id: number): string => id.toString(16).padStart(64, "0");

async function randomFreePortAtLeast10000(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") {
          probe.close();
          reject(new Error("failed to allocate a TCP test port"));
          return;
        }
        probe.close((error) => error ? reject(error) : resolve(address.port));
      });
    });
    if (port >= 10_000) return port;
  }
  throw new Error("could not allocate a free test port >= 10000");
}

let handle: Awaited<ReturnType<typeof startPglite>> | undefined;
let client: InstanceType<typeof pg.Client> | undefined;
let server: any;

async function seedArchived(
  id: number,
  options: {
    reason?: "CONSUMED" | "TTL";
    inputTxs?: Array<string | null>;
    outputTxs?: Array<string | null>;
    kind?: "SHIELDED" | "UNSHIELDED";
    height?: number;
  },
): Promise<void> {
  const reason = options.reason ?? "CONSUMED";
  const height = options.height ?? 77;
  await client!.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, first_seen_at,
        archive_reason, archived_at)
     VALUES ($1, $2, $3, $4, NOW(), $5, NOW())`,
    [id, id, `blob-${id}`, hashOf(id), reason],
  );
  await client!.query(
    `INSERT INTO offer_file_tokens_history
       (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '1', 'GIVING', $3, NOW())`,
    [id, "11".repeat(32), options.kind ?? "SHIELDED"],
  );
  for (const [index, txHash] of (options.inputTxs ?? []).entries()) {
    const marker = `nullifier-${id}-${index}`;
    await client!.query(
      `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
       VALUES ($1, $2, NOW())`,
      [id, marker],
    );
    await client!.query(
      `INSERT INTO nullifiers (nullifier, height, tx_hash) VALUES ($1, $2, $3)`,
      [marker, height, txHash],
    );
  }
  for (const [index, txHash] of (options.outputTxs ?? []).entries()) {
    const marker = `commitment-${id}-${index}`;
    await client!.query(
      `INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
       VALUES ($1, $2)`,
      [id, marker],
    );
    await client!.query(
      `INSERT INTO commitments (commitment, tx_hash, height) VALUES ($1, $2, $3)`,
      [marker, txHash, height],
    );
  }
}

beforeAll(async () => {
  const port = await randomFreePortAtLeast10000();
  handle = await startPglite(port);
  client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);

  await client.query(
    `INSERT INTO offer_file
       (id, celestia_height, transaction_hex, offer_hash, first_seen_at)
     VALUES (100, 100, 'live', $1, NOW())`,
    [hashOf(100)],
  );
  await seedArchived(1, { inputTxs: [LEDGER_A, LEDGER_A], outputTxs: [LEDGER_A, LEDGER_A] });
  await seedArchived(2, { inputTxs: [LEDGER_A, LEDGER_B], outputTxs: [LEDGER_A] });
  await seedArchived(3, { inputTxs: [LEDGER_A], outputTxs: [null] });
  await seedArchived(4, { inputTxs: [LEDGER_A], outputTxs: [] });
  await seedArchived(5, { reason: "TTL", inputTxs: [LEDGER_A], outputTxs: [LEDGER_A] });
  await seedArchived(6, {
    inputTxs: [LEDGER_A],
    outputTxs: [LEDGER_A],
    kind: "UNSHIELDED",
  });

  server = fastify();
  registerOfferConsumptionRoute(server, client);
  await server.ready();
});

afterAll(async () => {
  try { await server?.close(); }
  finally { await closeTestPglite(handle, client); }
});

const read = async (offerId: string) => {
  const response = await server.inject({ method: "GET", url: `/v1/offers/${offerId}/consumption` });
  return { status: response.statusCode, body: response.json() };
};

describe("GET /v1/offers/:hash/consumption", () => {
  test("emits versioned positive evidence only for one complete uniform ledger tx", async () => {
    expect(await read(hashOf(1))).toEqual({
      status: 200,
      body: {
        version: 1,
        offerId: hashOf(1),
        status: "consumed",
        evidence: { ledgerTxHash: LEDGER_A, height: 77 },
      },
    });
  });

  test("split, NULL, missing, cancellation, and unshielded markers are never positive", async () => {
    for (const id of [2, 3, 4, 5, 6]) {
      const result = await read(hashOf(id));
      expect(result.status).toBe(200);
      expect(result.body.version).toBe(1);
      expect(result.body.offerId).toBe(hashOf(id));
      expect(result.body.evidence).toBeUndefined();
    }
  });

  test("live, missing, and invalid identities have exact non-authoritative answers", async () => {
    expect(await read(hashOf(100))).toEqual({
      status: 200,
      body: { version: 1, offerId: hashOf(100), status: "live" },
    });
    expect(await read(hashOf(999))).toEqual({
      status: 200,
      body: { version: 1, offerId: hashOf(999), status: "not_found" },
    });
    expect(await read("not-a-hash")).toEqual({
      status: 400,
      body: {
        error: "INVALID_HASH",
        reason: "expected 64 hex chars (sha256 of the raw offer bytes)",
      },
    });
  });

  test("the evidence route performs no writes", async () => {
    const before = await client!.query(
      `SELECT (SELECT COUNT(*) FROM offer_file_history)::int AS history,
              (SELECT COUNT(*) FROM nullifiers)::int AS nullifiers,
              (SELECT COUNT(*) FROM commitments)::int AS commitments`,
    );
    for (const id of [1, 2, 3, 4, 5, 6, 100, 999]) await read(hashOf(id));
    const after = await client!.query(
      `SELECT (SELECT COUNT(*) FROM offer_file_history)::int AS history,
              (SELECT COUNT(*) FROM nullifiers)::int AS nullifiers,
              (SELECT COUNT(*) FROM commitments)::int AS commitments`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});
