// The unshielded half of the classification matrix — the layer that, until
// migration 014, could not classify at all.
//
// Every case below has an exact counterpart in fill-vs-cancel.test.ts. That is
// the point: the two layers now answer the same questions with the same
// certainty, from evidence the primitives were always delivering and the state
// machine was throwing away.
//
//   1 tx + markers created      → consumed  (verified fill)
//   1 tx + markers NOT created  → cancelled (the walk-away: a self-transfer is
//                                 not a sale — this is what used to read
//                                 `consumed` and inflate every market number)
//   spends across two txs       → cancelled (settlement is atomic)
//   only some spends landed     → cancelled (same argument)
//
// Markers are matched on (owner, token_type, value), never on intent hash or
// output index: those belong to the SETTLING intent, which the maker cannot
// know when publishing.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

import { afterAll, beforeAll, expect, test } from "bun:test";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, getOfferStatusByHash, getTradeHistory, getPairStats24h } =
  await import("@zswap-da/database");

const PORT = 54345;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const GIVE = "1".repeat(64);   // colour the maker gives
const WANT = "2".repeat(64);   // colour the maker wants
const MAKER = "m".repeat(64);  // the maker's unshielded address
// A DISTINCT spending tx per offer. Sharing one hash across fixtures lets one
// offer's payout satisfy another's marker check — which is correct behaviour
// (a tx that really did pay both makers settled both offers) but makes the
// fixture prove less than it claims.
const TX = (n: number, suffix = "") => `tx-${n}${suffix}`;
// These fixtures seed rows relative to NOW(), so their window starts 24 h
// before wall clock. Production derives it from the chain tip instead.
const DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);
const hashOf = (n: number) => n.toString(16).padStart(64, "0");

/** An archived unshielded offer: gives 10 GIVE, wants 20 WANT. */
async function seedOffer(
  id: number,
  spends: { outputNo: number }[],
  opts: { markers?: boolean } = {},
) {
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, ttl_seconds, archive_reason, archived_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes')`,
    [id, 200 + id, `blob-${id}`, hashOf(id)],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '10', 'GIVING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes'),
            ($1, $3, '20', 'WANTING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes')`,
    [id, GIVE, WANT],
  );
  for (const s of spends) {
    await client.query(
      `INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 minutes')`,
      [id, MAKER, `intent-${id}`, s.outputNo],
    );
  }
  if (opts.markers !== false) {
    // What the offer says the maker is owed: 20 WANT to the maker's address.
    await client.query(
      `INSERT INTO offer_file_unshielded_outputs_history (offer_file_id, owner, token_type, value)
       VALUES ($1, $2, $3, '20')`,
      [id, MAKER, WANT],
    );
  }
}

/** Chain: this UTXO was spent, by this transaction. */
const spent = (id: number, outputNo: number, txHash: string | null) =>
  client.query(
    `INSERT INTO unshielded_spends (owner, intent_hash, output_no, tx_hash, height)
     VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
    [MAKER, `intent-${id}`, outputNo, txHash],
  );

/** Chain: this transaction created a UTXO paying <owner, type, value>. */
const created = (tag: string, txHash: string, value: string, owner = MAKER, type = WANT) =>
  client.query(
    `INSERT INTO unshielded_creates (owner, intent_hash, output_no, tx_hash, token_type, value, height)
     VALUES ($1, $2, 0, $3, $4, $5, 1) ON CONFLICT DO NOTHING`,
    [owner, tag, txHash, type, value],
  );

const statusOf = async (id: number) =>
  (await getOfferStatusByHash.run({ offer_hash: hashOf(id) }, client))[0]!.status;

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const m of migrationTable) await client.query(m.sql);

  // 1: single input, one tx, and that tx PAID the maker → verified fill.
  await seedOffer(1, [{ outputNo: 0 }]);
  await spent(1, 0, TX(1));
  await created("settle-1", TX(1), "20");

  // 2: single input, one tx, maker never paid → the walk-away. THE case that
  // used to read `consumed` and put a trade that never happened on the chart.
  await seedOffer(2, [{ outputNo: 0 }]);
  await spent(2, 0, TX(2));

  // 3: two inputs spent in TWO txs → cancelled by atomicity, markers or not.
  await seedOffer(3, [{ outputNo: 0 }, { outputNo: 1 }]);
  await spent(3, 0, TX(3, "a"));
  await spent(3, 1, TX(3, "b"));
  await created("settle-3", TX(3, "a"), "20");

  // 4: two inputs, only ONE ever spent → partial, definitively a cancel.
  await seedOffer(4, [{ outputNo: 0 }, { outputNo: 1 }]);
  await spent(4, 0, TX(4));

  // 5: paid, but the WRONG AMOUNT. A settling tx pays exactly what the offer
  // asked; anything else is the maker moving coins, not a fill.
  await seedOffer(5, [{ outputNo: 0 }]);
  await spent(5, 0, TX(5));
  await created("settle-5", TX(5), "19");

  // 6: paid the right amount to the WRONG ADDRESS — not this maker's payout.
  await seedOffer(6, [{ outputNo: 0 }]);
  await spent(6, 0, TX(6));
  await created("settle-6", TX(6), "20", "z".repeat(64));
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("unshielded matrix: markers make classification exact", async () => {
  expect(await statusOf(1)).toBe("consumed");  // verified fill
  expect(await statusOf(2)).toBe("cancelled"); // walk-away — was `consumed`
  expect(await statusOf(3)).toBe("cancelled"); // split spend
  expect(await statusOf(4)).toBe("cancelled"); // partial spend
  expect(await statusOf(5)).toBe("cancelled"); // wrong amount
  expect(await statusOf(6)).toBe("cancelled"); // wrong recipient
});

test("only the genuine fill reaches trade history", async () => {
  const rows = await getTradeHistory.run({ base: GIVE, quote: WANT }, client);
  expect(rows.length).toBe(1);
});

test("cancels contribute no volume and do not move last_price", async () => {
  const s = (await getPairStats24h.run({ base: GIVE, quote: WANT, cutoff: DAY_AGO }, client))[0]!;
  expect(s.fills_24h).toBe(1);
  expect(Number(s.volume_base_24h)).toBe(10);  // one fill, not six
  expect(Number(s.volume_quote_24h)).toBe(20);
  expect(Number(s.last_price)).toBe(2);
});

test("the shielded path is unaffected — each predicate is inert on the other layer", async () => {
  // A shielded-only offer has no unshielded spend rows, so every unshielded
  // branch must evaluate false rather than accidentally proving a cancel.
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, ttl_seconds, archive_reason, archived_at)
     VALUES (90, 290, 'blob-90', $1, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes')`,
    [hashOf(90)],
  );
  await client.query(
    `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
     VALUES (90, 'n90', NOW() - INTERVAL '30 minutes')`,
  );
  await client.query(
    `INSERT INTO nullifiers (nullifier, height, tx_hash) VALUES ('n90', 1, $1)`, [TX(90)],
  );
  // No stored commitments → branch 3 vacuous, branches 1/2 false → consumed.
  expect(await statusOf(90)).toBe("consumed");
});
