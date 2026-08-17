import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "./test-pglite.ts";

// Item #8: SHIELDED/UNSHIELDED tags on offer legs (MIP-0006 TokenLeg.type).
// Two properties matter: the widened uniqueness lets the same color appear on
// both layers of the same side (pre-fix this collapsed — worse, the validator
// NETTED across layers, misstating terms), and the market queries aggregate
// by color so a dual-kind leg is counted once, not join-duplicated.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  insertOfferFileWithHash,
  insertOfferFileTokenWithKind,
  getOfferTokensAny,
  getPairStats24h,
} = await import("@zswap-da/database");

// Fixtures seed rows relative to NOW(), so their window starts 24 h before
// wall clock. Production derives it from the chain tip instead (trade-data.ts).
const DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PORT = 54345;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const BASE = "b".repeat(64);
const QUOTE = "q".repeat(64);

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

test("same color on both layers of the same side coexists (widened unique tuple)", async () => {
  const rows = await insertOfferFileWithHash.run(
    {
      celestia_height: 1,
      transaction_hex: "blob-dual",
      offer_hash: "d".repeat(64),
      metadata_created_at: null,
      first_seen_at: new Date().toISOString(),
      metadata_expires_at: null,
      ttl_seconds: 3600,
    },
    client,
  );
  const id = rows[0].id;
  await insertOfferFileTokenWithKind.run(
    { offer_file_id: id, token_color: BASE, amount: "10", direction: "GIVING", kind: "SHIELDED" },
    client,
  );
  // Pre-fix: unique (offer_file_id, token_color, direction) rejected this row.
  await insertOfferFileTokenWithKind.run(
    { offer_file_id: id, token_color: BASE, amount: "5", direction: "GIVING", kind: "UNSHIELDED" },
    client,
  );
  const legs = await getOfferTokensAny.run({ offer_file_id: id, live: true }, client);
  expect(legs.length).toBe(2);
  expect(new Set(legs.map((l) => l.kind))).toEqual(new Set(["SHIELDED", "UNSHIELDED"]));

  // Same (color, direction, kind) twice is still rejected.
  await expect(
    insertOfferFileTokenWithKind.run(
      { offer_file_id: id, token_color: BASE, amount: "7", direction: "GIVING", kind: "SHIELDED" },
      client,
    ),
  ).rejects.toThrow();
});

test("invalid kind is rejected by the CHECK constraint", async () => {
  await expect(
    client.query(
      `INSERT INTO offer_file_tokens (offer_file_id, token_color, amount, direction, kind)
       VALUES (999, '${BASE}', '1', 'GIVING', 'shielded')`, // wrong case
    ),
  ).rejects.toThrow();
});

test("market queries count a dual-kind leg ONCE, summed by color (join-duplication guard)", async () => {
  // Archived fill: gives BASE as 10 SHIELDED + 5 UNSHIELDED, wants 30 QUOTE.
  // A naive GIVING×WANTING join would produce two fill rows (volume 30,
  // fills 2); the aggregated queries must report one fill of 15 @ price 2.
  await client.query(
    `INSERT INTO offer_file_history
       (id, celestia_height, transaction_hex, offer_hash, created_at, ttl_seconds, archive_reason, archived_at, first_seen_at)
     VALUES (500, 1, 'blob-500', '${"e".repeat(64)}', NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '10 minutes', NOW())`,
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at) VALUES
       (500, '${BASE}', '10', 'GIVING', 'SHIELDED', NOW() - INTERVAL '10 minutes'),
       (500, '${BASE}', '5',  'GIVING', 'UNSHIELDED', NOW() - INTERVAL '10 minutes'),
       (500, '${QUOTE}', '30', 'WANTING', 'SHIELDED', NOW() - INTERVAL '10 minutes')`,
  );
  // Market queries count only cryptographically classified fills. Bind one
  // input and one output marker to the same transaction so this fixture tests
  // aggregation, not the markerless `unknown` safety branch.
  await client.query(
    `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
     VALUES (500, 'dual-kind-nullifier', NOW() - INTERVAL '10 minutes');
     INSERT INTO nullifiers (nullifier, height, tx_hash)
     VALUES ('dual-kind-nullifier', 1, 'dual-kind-tx');
     INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
     VALUES (500, 'dual-kind-commitment');
     INSERT INTO commitments (commitment, tx_hash, mt_index, height)
     VALUES ('dual-kind-commitment', 'dual-kind-tx', '500', 1)`,
  );
  const s = (await getPairStats24h.run({ base: BASE, quote: QUOTE, cutoff: DAY_AGO }, client))[0];
  expect(s.fills_24h).toBe(1);
  expect(Number(s.volume_base_24h)).toBe(15);
  expect(Number(s.volume_quote_24h)).toBe(30);
  expect(Number(s.last_price)).toBe(2); // 30 / 15, layers summed by color
});
