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
// Phase (b) persists exact (owner, intent_hash, output_no) markers. This file's
// classifier remains on the interim (owner, token_type, value) comparison until
// Phase (d); the identity columns below ensure the transition loses no data.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

import { afterAll, beforeAll, expect, test } from "bun:test";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const {
  migrationTable,
  getOfferStatusByHash,
  getTradeHistory,
  getPairStats24h,
  insertOfferFileUnshieldedOutput,
  archiveOfferByIdTtlWithHash,
  adjudicateOfferFill,
  findUnadjudicatedFills,
} =
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

// ── Phase (d) fixtures use their own colour pair ────────────────────────────
// The 24 h pair-stats and trade-history assertions below count rows for
// (GIVE, WANT). Seeding new consumed offers on that pair would move those
// numbers and make the older cases fail for a reason that has nothing to do
// with what they test, so every t1-t4 fixture trades a separate pair.
const GIVE2 = "3".repeat(64);
const WANT2 = "4".repeat(64);

/** An archived unshielded offer: gives 10 GIVE, wants 20 WANT. */
async function seedOffer(
  id: number,
  spends: { outputNo: number }[],
  opts: {
    markers?: boolean;
    /** Exact declared payout identities; defaults to one (payout-intent-N, 0). */
    payouts?: { intentHash: string; outputNo: number; value?: string }[];
    /** Share a spend-set with another offer by reusing its intent tag. */
    spendTag?: string;
    give?: string;
    want?: string;
  } = {},
) {
  const give = opts.give ?? GIVE;
  const want = opts.want ?? WANT;
  const spendTag = opts.spendTag ?? `intent-${id}`;
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, ttl_seconds, archive_reason, archived_at, first_seen_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes', NOW())`,
    [id, 200 + id, `blob-${id}`, hashOf(id)],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '10', 'GIVING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes'),
            ($1, $3, '20', 'WANTING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes')`,
    [id, give, want],
  );
  for (const s of spends) {
    await client.query(
      `INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 minutes')`,
      [id, MAKER, spendTag, s.outputNo],
    );
  }
  if (opts.markers !== false) {
    // What the offer says the maker is owed: 20 WANT to the maker's address.
    const payouts = opts.payouts ?? [{ intentHash: `payout-intent-${id}`, outputNo: 0 }];
    for (const p of payouts) {
      await client.query(
        `INSERT INTO offer_file_unshielded_outputs_history
           (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
         VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [id, MAKER, p.intentHash, p.outputNo, want, p.value ?? "20"],
      );
    }
  }
}

/** Chain: this UTXO was spent, by this transaction. */
const spent = (id: number | string, outputNo: number, txHash: string | null) =>
  client.query(
    `INSERT INTO unshielded_spends (owner, intent_hash, output_no, tx_hash, height)
     VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING`,
    [MAKER, typeof id === "string" ? id : `intent-${id}`, outputNo, txHash],
  );

/**
 * Chain: this transaction created the UTXO with this EXACT identity.
 *
 * `created` below keys the create on an arbitrary tag, which was enough while
 * branch 3 grouped on (owner, token_type, value). Under exact identities the
 * tag IS the assertion: a create only satisfies a declared marker when its
 * (owner, intent_hash, output_no) is the one the offer declared.
 */
const createdExact = (
  intentHash: string,
  outputNo: number,
  txHash: string,
  value = "20",
  owner = MAKER,
  type = WANT,
) =>
  client.query(
    `INSERT INTO unshielded_creates (owner, intent_hash, output_no, tx_hash, token_type, value, height)
     VALUES ($1, $2, $3, $4, $5, $6, 1) ON CONFLICT DO NOTHING`,
    [owner, intentHash, outputNo, txHash, type, value],
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

/** The product's own repair sweep, run verbatim — fixtures never hand-write
 *  verdict columns, so a test cannot agree with a broken adjudicator. */
async function adjudicateAll() {
  const owed = await findUnadjudicatedFills.run({ limit: 10_000 }, client);
  for (const row of owed) await adjudicateOfferFill.run({ offer_id: row.id }, client);
}

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  // @effectstream/db 0.200.1: startPglite's close() DESTROYS live sockets
  // (0.103.1 closed politely). afterAll deliberately never sends a client
  // Terminate (PGlite WASM throws on it), so the destroy surfaces here as a
  // 'error' event — expected at teardown, not a test failure. Swallow it.
  client.on("error", () => {});
  for (const m of migrationTable) await client.query(m.sql);

  // 1: single input, one tx, and that tx PAID the maker → verified fill.
  // The create carries the offer's DECLARED identity, which is what makes this
  // a fill under exact-identity classification rather than a coincidence of
  // (owner, token, value).
  await seedOffer(1, [{ outputNo: 0 }]);
  await spent(1, 0, TX(1));
  await createdExact("payout-intent-1", 0, TX(1));

  // 2: single input, one tx, maker never paid → the walk-away. THE case that
  // used to read `consumed` and put a trade that never happened on the chart.
  await seedOffer(2, [{ outputNo: 0 }]);
  await spent(2, 0, TX(2));

  // 3: two inputs spent in TWO txs → cancelled by atomicity, markers or not.
  // The declared payout IS on chain here, so this case proves atomicity still
  // dominates a satisfied marker rather than passing because the marker missed.
  await seedOffer(3, [{ outputNo: 0 }, { outputNo: 1 }]);
  await spent(3, 0, TX(3, "a"));
  await spent(3, 1, TX(3, "b"));
  await createdExact("payout-intent-3", 0, TX(3, "a"));

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

  // ── Phase (d) — the cross-offer cases the shape grouping cannot answer ────
  //
  // t1: X and Y are DISJOINT offers — different makers' inputs, no relation to
  // each other — both wanting 20 WANT2 to the same address, "settled" by ONE
  // transaction that pays 20 ONCE. This is the cross-offer marker bypass: on
  // (owner, token_type, value) that single payout satisfies BOTH offers'
  // marker checks, so both read `consumed` and both hit the chart.
  //
  // The payout here carries NEITHER offer's declared identity, which is the
  // honest model of the only way the shortfall can arise: a merge preserves
  // declared outputs verbatim, so a transaction spending both offers carries
  // both payouts. One payout for two offers means the maker re-signed raw
  // spends OUTSIDE the offer intents — and a raw output is stamped with the
  // hash of whatever intent did create it, never with theirs.
  await seedOffer(10, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await seedOffer(11, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await spent(10, 0, TX(10));
  await spent(11, 0, TX(10));
  await createdExact("fabricated-intent", 0, TX(10), "20", MAKER, WANT2);

  // t1b: the same shape, except the single payout IS offer 12's declared
  // identity. The guard on t1: the fix must DISCRIMINATE, not blanket-cancel
  // every offer that shares a settling transaction.
  await seedOffer(12, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await seedOffer(13, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await spent(12, 0, TX(12));
  await spent(13, 0, TX(12));
  await createdExact("payout-intent-12", 0, TX(12), "20", MAKER, WANT2);

  // t2: X and Y share ONE input — two offers over the same UTXO, and they
  // remain legal after the 2026-08-18 marker-dedup ruling. That rule keys on
  // declared OUTPUTS, and these two declare DIFFERENT payouts
  // (payout-intent-14 vs -15): the maker offering one coin for either of two
  // things, which the schema has always allowed. Only one can settle, and one
  // payout is the CORRECT supply rather than a shortfall, so exactly one must
  // read `consumed` — and the classifier alone decides that, with no help from
  // the deleted projection collapse.
  await seedOffer(14, [{ outputNo: 0 }], { give: GIVE2, want: WANT2, spendTag: "shared-input-a" });
  await seedOffer(15, [{ outputNo: 0 }], { give: GIVE2, want: WANT2, spendTag: "shared-input-a" });
  await spent("shared-input-a", 0, TX(14));
  await createdExact("payout-intent-14", 0, TX(14), "20", MAKER, WANT2);

  // t3: X and Y disjoint, one transaction paying 20 TWICE — the honest
  // two-offer settlement. Both are genuine fills and must stay `consumed`.
  await seedOffer(16, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await seedOffer(17, [{ outputNo: 0 }], { give: GIVE2, want: WANT2 });
  await spent(16, 0, TX(16));
  await spent(17, 0, TX(16));
  await createdExact("payout-intent-16", 0, TX(16), "20", MAKER, WANT2);
  await createdExact("payout-intent-17", 0, TX(16), "20", MAKER, WANT2);

  // t4: same spend-set; the earlier alternative declares TWO identical 20-WANT2
  // markers, the later declares ONE, and the settlement supplies ONE. Under
  // exact identities this needs no multiplicity arithmetic at all: the earlier
  // offer declared an identity that was never created.
  await seedOffer(18, [{ outputNo: 0 }], {
    give: GIVE2, want: WANT2, spendTag: "shared-input-b",
    payouts: [{ intentHash: "payout-intent-18", outputNo: 0 },
              { intentHash: "payout-intent-18", outputNo: 1 }],
  });
  await seedOffer(19, [{ outputNo: 0 }], {
    give: GIVE2, want: WANT2, spendTag: "shared-input-b",
    payouts: [{ intentHash: "payout-intent-19", outputNo: 0 }],
  });
  await spent("shared-input-b", 0, TX(18));
  await createdExact("payout-intent-19", 0, TX(18), "20", MAKER, WANT2);

  await adjudicateAll();
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

test("a PRE-014 offer (no marker rows) is NOT reclassified", async () => {
  // unshielded_spends starts empty on upgrade while
  // offer_file_unshielded_spends_history is already populated, so branch 1
  // would flip every historical offer to `cancelled` — erasing genuine past
  // fills from chart history and volume while pair_stats, a persisted
  // write-side projection, keeps counting them. The marker gate makes the whole
  // predicate inert for rows that predate the migration, exactly as 013 did.
  await seedOffer(80, [{ outputNo: 0 }], { markers: false });
  // No unshielded_spends row for it either — the post-upgrade state exactly.
  expect(await statusOf(80)).toBe("consumed");
});

test("N identical wanted outputs require N payouts, not one", async () => {
  // Existence-only matching let a maker declare N identical outputs (legs NET,
  // so wants = N x value) and satisfy the check with a SINGLE self-paid output —
  // a fabricated fill at N times its real size, for 1/N the cost.
  const id = 81;
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds, archive_reason, archived_at)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
             3600, 'CONSUMED', NOW() - INTERVAL '30 minutes')`,
    [id, 500, `blob-${id}`, hashOf(id)],
  );
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES ($1, $2, '10', 'GIVING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes'),
            ($1, $3, '60', 'WANTING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes')`,
    [id, GIVE, WANT],
  );
  await client.query(
    `INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
     VALUES ($1, $2, $3, 0, NOW() - INTERVAL '30 minutes')`,
    [id, MAKER, `intent-${id}`],
  );
  // The offer declares THREE exact output identities of 20. Under phase (d)
  // they are three distinct (intent_hash, output_no) rows, so no multiplicity
  // arithmetic is needed — an uncreated one fails on its own.
  await client.query(
    `INSERT INTO offer_file_unshielded_outputs_history
       (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
     VALUES ($1, $2, $3, 0, $4, '20', 1),
            ($1, $2, $3, 1, $4, '20', 1),
            ($1, $2, $3, 2, $4, '20', 1)`,
    [id, MAKER, `payout-intent-${id}`, WANT],
  );
  await spent(id, 0, TX(id));
  // The spending tx creates only ONE of the three declared identities — the
  // underpayment. The other two were declared and never created.
  await createdExact(`payout-intent-${id}`, 0, TX(id));
  expect(await statusOf(id)).toBe("cancelled");

  // Paying all three settles it.
  for (const n of [1, 2]) {
    await createdExact(`payout-intent-${id}`, n, TX(id));
  }
  expect(await statusOf(id)).toBe("consumed");
});

test("the shielded path is unaffected — each predicate is inert on the other layer", async () => {
  // A shielded-only offer has no unshielded spend rows, so every unshielded
  // branch must evaluate false rather than accidentally proving a cancel.
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, ttl_seconds, archive_reason, archived_at, first_seen_at)
     VALUES (90, 290, 'blob-90', $1, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes', NOW())`,
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

test("declared outputs persist their exact identity plus audit fields", async () => {
  const columns = (await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'offer_file_unshielded_outputs'`,
  )).rows.map((row: any) => row.column_name);
  expect(columns).toEqual(expect.arrayContaining(["intent_hash", "output_no"]));

  const id = 95;
  const intentA = "a".repeat(64);
  const intentB = "b".repeat(64);
  await client.query(
    `INSERT INTO offer_file
       (id, celestia_height, transaction_hex, offer_hash, first_seen_at)
     VALUES ($1, 1, 'identity-blob', $2, NOW())`,
    [id, hashOf(id)],
  );
  await insertOfferFileUnshieldedOutput.run({
    offer_file_id: id,
    owner: MAKER,
    intent_hash: intentA,
    output_no: 7,
    token_type: WANT,
    value: "20",
  }, client);
  await insertOfferFileUnshieldedOutput.run({
    offer_file_id: id,
    owner: MAKER,
    intent_hash: intentB,
    output_no: 0,
    token_type: WANT,
    value: "20",
  }, client);

  const stored = (await client.query(
    `SELECT owner, intent_hash, output_no, token_type, value
     FROM offer_file_unshielded_outputs WHERE offer_file_id = $1
     ORDER BY intent_hash`,
    [id],
  )).rows;
  expect(stored).toEqual([
    {
      owner: MAKER,
      intent_hash: intentA,
      output_no: 7,
      token_type: WANT,
      value: "20",
    },
    {
      owner: MAKER,
      intent_hash: intentB,
      output_no: 0,
      token_type: WANT,
      value: "20",
    },
  ]);

  await archiveOfferByIdTtlWithHash.run({
    offer_file_id: id,
    archived_at: new Date().toISOString(),
  }, client);
  const archived = (await client.query(
    `SELECT owner, intent_hash, output_no, token_type, value
     FROM offer_file_unshielded_outputs_history WHERE offer_file_id = $1
     ORDER BY intent_hash`,
    [id],
  )).rows;
  expect(archived).toEqual(stored);
});

// ── Phase (d): classification on exact identities ──────────────────────────
//
// Identity is `(owner, intentHash(segment), outputNo)`, precomputed at
// ingestion from the offer's own intent (phase (b)) and stamped on chain by
// `UtxoState::apply_offer`. It is globally unique, so the settling transaction
// stops being the key and becomes corroboration. These four cases are the ones
// the (owner, token_type, value) grouping could not answer.

test("t1: one payout cannot settle two disjoint offers", async () => {
  expect(await statusOf(10)).toBe("cancelled");
  expect(await statusOf(11)).toBe("cancelled");
});

test("t1b: ...but the offer that WAS paid still reads consumed", async () => {
  expect(await statusOf(12)).toBe("consumed");
  expect(await statusOf(13)).toBe("cancelled");
});

test("t2: same-input alternatives — exactly one is consumed", async () => {
  const statuses = [await statusOf(14), await statusOf(15)];
  expect(statuses.filter((s) => s === "consumed").length).toBe(1);
  expect(statuses.filter((s) => s === "cancelled").length).toBe(1);
});

test("t3: one transaction paying both offers settles both", async () => {
  expect(await statusOf(16)).toBe("consumed");
  expect(await statusOf(17)).toBe("consumed");
});

test("t4: an alternative declaring an uncreated identity is cancelled", async () => {
  expect(await statusOf(18)).toBe("cancelled");
  expect(await statusOf(19)).toBe("consumed");
});

// ── t5a, MIGRATED 2026-08-18: the duplicate never reaches the projection ────
//
// The original case: on a live chain (2026-08-17) five settlement transactions
// left pair_stats.trade_count = SEVEN. The surplus was two `same-intent
// wrapper` pairs — two byte-different offers wrapping ONE intent, legal under
// the 2026-08-12 byte-identical-only ruling. They shared an input AND a
// declared payout identity, so one on-chain create archived both and every
// fill-counting surface counted the settlement twice. It was answered in the
// PROJECTION, by supersededByDuplicatePredicate.
//
// The marker-dedup ruling (2026-08-18) removes the defect instead of collapsing
// its consequence: the second wrapper is REJECTED at both doors, because its
// declared markers overlap an active offer's. So the coexisting pair is no
// longer a state this system can reach, the projection has nothing left to
// collapse, and the predicate is deleted.
//
// Both halves are asserted below, because only asserting the first would leave
// the counting rule untested and only asserting the second would leave the
// reader thinking the projection still defends itself.

test("t5a: ingestion refuses the second wrapper, so one settlement is one trade", async () => {
  const { getPairStats24h, findActiveOfferByUnshieldedOutput } = await import("@zswap-da/database");
  const GIVE3 = "5".repeat(64);
  const WANT3 = "6".repeat(64);

  // The first wrapper is LIVE and has declared its payout identity.
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds)
     VALUES (20, 720, 'blob-20', $1, NOW(), NOW(), 3600)`,
    [hashOf(20)],
  );
  await client.query(
    `INSERT INTO offer_file_unshielded_outputs
       (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
     VALUES (20, $1, 'wrapper-intent', 0, $2, '20', 1)`,
    [MAKER, WANT3],
  );

  // The second wrapper arrives. Byte-different, so rule (i) — the offer_hash PK
  // — sees nothing. Rule (ii) asks the live book about its declared marker and
  // finds offer 20, which is the rejection: it never gets indexed, never gets
  // archived, and never reaches adjudication.
  const claimed = await findActiveOfferByUnshieldedOutput.run(
    { owner: MAKER, intent_hash: "wrapper-intent", output_no: 0 },
    client,
  );
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.offer_hash).toBe(hashOf(20));

  // So exactly ONE offer exists to settle. Archive and adjudicate it as the
  // product does.
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds, archive_reason, archived_at)
     VALUES (20, 720, 'blob-20', $1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour',
             3600, 'CONSUMED', NOW() - INTERVAL '30 minutes')`,
    [hashOf(20)],
  );
  await client.query(`DELETE FROM offer_file WHERE id = 20`);
  await client.query(
    `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
     VALUES (20, $1, '10', 'GIVING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes'),
            (20, $2, '20', 'WANTING', 'UNSHIELDED', NOW() - INTERVAL '30 minutes')`,
    [GIVE3, WANT3],
  );
  await client.query(
    `INSERT INTO offer_file_unshielded_spends_history (offer_file_id, owner, intent_hash, output_no, archived_at)
     VALUES (20, $1, 'wrapper-input', 0, NOW() - INTERVAL '30 minutes')`,
    [MAKER],
  );
  await client.query(
    `INSERT INTO offer_file_unshielded_outputs_history
       (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
     VALUES (20, $1, 'wrapper-intent', 0, $2, '20', 1)`,
    [MAKER, WANT3],
  );
  await spent("wrapper-input", 0, TX(20));
  await createdExact("wrapper-intent", 0, TX(20), "20", MAKER, WANT3);

  expect(await statusOf(20)).toBe("consumed");
  await adjudicateAll();

  const s = (await getPairStats24h.run({ base: GIVE3, quote: WANT3, cutoff: DAY_AGO }, client))[0];
  const counted = (await client.query(
    `SELECT COUNT(*)::int AS trade_count FROM offer_file_history
      WHERE settled AND base_color = $1 AND quote_color = $2`,
    [GIVE3 < WANT3 ? GIVE3 : WANT3, GIVE3 < WANT3 ? WANT3 : GIVE3],
  )).rows[0]!.trade_count;
  expect(counted).toBe(1);
  expect(s?.fills_24h ?? 0).toBe(1);
});

test("t5a-b: MEASURED — the projection alone no longer collapses duplicates", async () => {
  // What the deletion of supersededByDuplicatePredicate costs, asserted rather
  // than assumed. Two duplicate wrappers forced STRAIGHT INTO history — a state
  // ingestion now refuses, so this can only be produced by writing to the DB
  // behind both doors — are counted TWICE.
  //
  // That is the correct reading of the new design and the reason it is recorded
  // here: correctness now rests entirely on ingestion. If a future change lets
  // duplicates coexist through any other path, market counts inflate again and
  // nothing downstream will notice. This is the same tripwire shape as t6, and
  // it fails the day someone re-adds a collapse (making the number 1) or the
  // day a new path lets duplicates in (making the e2e's totals wrong).
  const GIVE5 = "9".repeat(64);
  const WANT5 = "a".repeat(64);
  const shared = [{ intentHash: "forced-wrapper-intent", outputNo: 0 }];
  await seedOffer(24, [{ outputNo: 0 }], {
    give: GIVE5, want: WANT5, spendTag: "forced-wrapper-input", payouts: shared,
  });
  await seedOffer(25, [{ outputNo: 0 }], {
    give: GIVE5, want: WANT5, spendTag: "forced-wrapper-input", payouts: shared,
  });
  await spent("forced-wrapper-input", 0, TX(24));
  await createdExact("forced-wrapper-intent", 0, TX(24), "20", MAKER, WANT5);

  // Both read consumed, and that is right: the intent settled and each declared
  // it. The classifier was never the wrong place to look.
  expect(await statusOf(24)).toBe("consumed");
  expect(await statusOf(25)).toBe("consumed");

  await adjudicateAll();
  const counted = (await client.query(
    `SELECT COUNT(*)::int AS trade_count FROM offer_file_history
      WHERE settled AND base_color = $1 AND quote_color = $2`,
    [GIVE5 < WANT5 ? GIVE5 : WANT5, GIVE5 < WANT5 ? WANT5 : GIVE5],
  )).rows[0]!.trade_count;
  expect(counted).toBe(2);
});

// ── t6: the shielded twin — a MEASUREMENT, recorded either way ──────────────
//
// The plan asks whether the duplicate over-count has a shielded half. Shielded
// duplicates over one input share a nullifier AND a declared output commitment,
// exactly as unshielded duplicates share an input and a payout identity. If one
// settlement marks both consumed AND both are counted, the shielded side needs
// the same collapse; if not, the shape is immune and the reason is worth
// recording.
//
// This case asserts what was measured, so it will fail if the answer changes.

test("t6: shielded same-input duplicates — measured behaviour", async () => {
  const GIVE4 = "7".repeat(64);
  const WANT4 = "8".repeat(64);
  const seedShielded = async (id: number) => {
    await client.query(
      `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
         created_at, ttl_seconds, archive_reason, archived_at, first_seen_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 hour', 3600, 'CONSUMED', NOW() - INTERVAL '30 minutes', NOW())`,
      [id, 600 + id, `blob-${id}`, hashOf(id)],
    );
    await client.query(
      `INSERT INTO offer_file_tokens_history (offer_file_id, token_color, amount, direction, kind, archived_at)
       VALUES ($1, $2, '10', 'GIVING', 'SHIELDED', NOW() - INTERVAL '30 minutes'),
              ($1, $3, '20', 'WANTING', 'SHIELDED', NOW() - INTERVAL '30 minutes')`,
      [id, GIVE4, WANT4],
    );
    // Shared nullifier: the same shielded input, declared by both offers.
    await client.query(
      `INSERT INTO offer_file_nullifiers_history (offer_file_id, nullifier, archived_at)
       VALUES ($1, 'twin-nullifier', NOW() - INTERVAL '30 minutes')`,
      [id],
    );
    // Shared commitment: the same declared payout coin.
    await client.query(
      `INSERT INTO offer_file_commitments_history (offer_file_id, commitment)
       VALUES ($1, 'twin-commitment')`,
      [id],
    );
  };
  await seedShielded(30);
  await seedShielded(31);
  await client.query(
    `INSERT INTO nullifiers (nullifier, height, tx_hash, offer_matched)
     VALUES ('twin-nullifier', 1, 'tx-30', TRUE) ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO commitments (commitment, tx_hash, mt_index, height)
     VALUES ('twin-commitment', 'tx-30', '1', 1) ON CONFLICT DO NOTHING`,
  );

  // MEASURED: one settlement marks BOTH consumed, exactly as on the unshielded
  // side — the shielded classifier has no notion of which offer the coin was
  // created for either.
  expect(await statusOf(30)).toBe("consumed");
  expect(await statusOf(31)).toBe("consumed");

  await adjudicateAll();
  const counted = (await client.query(
    `SELECT COUNT(*)::int AS trade_count FROM offer_file_history
      WHERE settled AND base_color = $1 AND quote_color = $2`,
    [GIVE4, WANT4],
  )).rows[0]?.trade_count;

  // MEASURED: the shielded side counts this settlement twice.
  //
  // It always did — the projection-side collapse keyed on
  // offer_file_unshielded_outputs_history, which a pure shielded offer has no
  // rows in, so it was inert here. That collapse is now DELETED, so nothing
  // downstream defends either layer; the defence moved to ingestion, where the
  // commitment probe refuses the second offer declaring 'twin-commitment'
  // (packages/database/marker-dedup.test.ts pins that directly).
  //
  // This fixture writes both offers straight into HISTORY, behind both doors,
  // so it still produces the pair and still measures 2 — which is exactly its
  // job. Ruled 2026-08-18: executed shielded offers are known by commitment, so
  // under marker dedup they are unique and this state is unreachable through
  // ingestion. If this number ever changes, that fact changed and the tripwire
  // has done its work.
  expect(counted).toBe(2);
});
