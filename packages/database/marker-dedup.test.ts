// Marker dedup — dedup rule (ii), ruled 2026-08-18.
//
// The rule: after crypto verification, reject an offer whose DECLARED markers
// OVERLAP an ACTIVE offer's markers. This file owns the database half — the two
// probes both doors ask, on both value layers — and pins the four properties
// that make the rule correct rather than merely present:
//
//   overlap, not equality      · one shared marker is enough
//   both layers                · commitments AND unshielded identities
//   ACTIVE only                · an archived original claims nothing
//   deterministic incumbent    · the winner is content-addressed, never a
//                                SERIAL id
//
// Why the rule exists, measured rather than argued: markers are ROOT-INDEPENDENT
// (`coin-structure/src/coin.rs:626` hashes domain separator + coin info +
// recipient, with no Merkle root), so re-proving one intent against a fresh root
// inside the root window produces a byte-different blob with a new offer_hash
// and IDENTICAL markers. Byte-identical dedup — rule (i), unchanged and still
// first — cannot see that at all.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

import { afterAll, beforeAll, expect, test } from "bun:test";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable, findActiveOfferByCommitment, findActiveOfferByUnshieldedOutput } =
  await import("@zswap-da/database");

const PORT = 54351;
let handle: { close: () => Promise<void> };
let client: InstanceType<typeof pg.Client>;

const MAKER = "m".repeat(64);
const VICTIM = "v".repeat(64);
const hashOf = (n: number) => n.toString(16).padStart(64, "0");

/** A LIVE offer — the live book is what this rule reads. */
async function seedLive(id: number, opts: {
  commitments?: string[];
  outputs?: { owner?: string; intentHash: string; outputNo: number }[];
} = {}) {
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), 3600)`,
    [id, 700 + id, `blob-${id}`, hashOf(id)],
  );
  for (const c of opts.commitments ?? []) {
    await client.query(
      `INSERT INTO offer_file_commitments (offer_file_id, commitment) VALUES ($1, $2)`,
      [id, c],
    );
  }
  for (const o of opts.outputs ?? []) {
    await client.query(
      `INSERT INTO offer_file_unshielded_outputs
         (offer_file_id, owner, intent_hash, output_no, token_type, value, count)
       VALUES ($1, $2, $3, $4, 'tok', '20', 1)`,
      [id, o.owner ?? MAKER, o.intentHash, o.outputNo],
    );
  }
}

/** Archive it exactly as the product does: the live row is DELETEd, markers cascade. */
async function archive(id: number) {
  await client.query(
    `INSERT INTO offer_file_history (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds, archive_reason, archived_at)
     SELECT id, celestia_height, transaction_hex, offer_hash, created_at, first_seen_at,
            ttl_seconds, 'CONSUMED', NOW()
       FROM offer_file WHERE id = $1`,
    [id],
  );
  await client.query(`DELETE FROM offer_file WHERE id = $1`, [id]);
}

const claimedCommitment = async (commitment: string) =>
  await findActiveOfferByCommitment.run({ commitment }, client);
const claimedOutput = async (intentHash: string, outputNo: number, owner = MAKER) =>
  await findActiveOfferByUnshieldedOutput.run(
    { owner, intent_hash: intentHash, output_no: outputNo },
    client,
  );

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const m of migrationTable) await client.query(m.sql);
});

afterAll(async () => {
  try {
    await handle?.close();
  } catch { /* noop */ }
});

test("an unclaimed marker is free — the rule rejects nothing by default", async () => {
  expect(await claimedCommitment("never-declared")).toEqual([]);
  expect(await claimedOutput("never-declared", 0)).toEqual([]);
});

test("the unshielded wrapper pair: the second declares the first's identity", async () => {
  // The shape measured on a live chain by the phase (c) probe: one intent,
  // wrapped by Transaction.fromParts and Transaction.fromPartsRandomized. The
  // physical segment differs, the bytes differ, the offer_hash differs — and
  // `intentHash(0)` is identical, so both declare the SAME payout identity.
  // Rule (i) relates them not at all; this is what does.
  await seedLive(1, { outputs: [{ intentHash: "wrapper-intent", outputNo: 0 }] });
  const claimed = await claimedOutput("wrapper-intent", 0);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.offer_file_id).toBe(1);
  expect(claimed[0]!.offer_hash).toBe(hashOf(1));
});

test("the shielded twin: a re-proved offer keeps its output commitments", async () => {
  // Commitments are root-independent, so re-proving against a fresh root
  // changes the blob and not the commitment. This is the shielded half the
  // projection-side collapse never covered (t6) — closed here at ingestion.
  await seedLive(2, { commitments: ["twin-commitment"] });
  const claimed = await claimedCommitment("twin-commitment");
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.offer_hash).toBe(hashOf(2));
});

test("OVERLAP, not set equality: one shared marker out of three is enough", async () => {
  // Equality would be evaded by appending a single extra output — precisely the
  // manoeuvre the rule exists to stop. Overlap is safe for the reason equality
  // was thought to be needed: sharing ANY declared marker already implies the
  // same signer, because an identity can only be produced by the intent that
  // declares it.
  await seedLive(3, {
    outputs: [
      { intentHash: "three-way", outputNo: 0 },
      { intentHash: "three-way", outputNo: 1 },
    ],
  });
  // The attacker's second blob declares one of those plus two of its own.
  const attacker = [
    { intentHash: "attacker-only", outputNo: 0 },
    { intentHash: "three-way", outputNo: 1 }, // the overlap
    { intentHash: "attacker-only", outputNo: 1 },
  ];
  const hits = [];
  for (const m of attacker) hits.push(...(await claimedOutput(m.intentHash, m.outputNo)));
  expect(hits).toHaveLength(1);
  expect(hits[0]!.offer_file_id).toBe(3);
});

test("disjoint offers never collide — the rule discriminates", async () => {
  // The guard on every test above: a rule that rejects too much is worse than
  // no rule. Same maker, same token, same output_no, DIFFERENT intent — two
  // honest offers, and identities are per-intent.
  await seedLive(4, { outputs: [{ intentHash: "honest-intent-a", outputNo: 0 }] });
  expect(await claimedOutput("honest-intent-b", 0)).toEqual([]);
  // And the same identity under a different owner is a different marker.
  expect(await claimedOutput("honest-intent-a", 0, VICTIM)).toEqual([]);
});

test("ACTIVE only: an archived original claims nothing", async () => {
  // This is why spent originals need no marker check of their own. Archival is
  // destructive — the live row is DELETEd and the marker rows cascade — so the
  // live tables ARE the live book, which is also what keeps the probe
  // O(live book) instead of O(history). A re-proven duplicate of a cancelled or
  // fulfilled offer dies one rung earlier anyway, at NULLIFIER_SPENT /
  // UTXO_NOT_LIVE, because its inputs are spent.
  await seedLive(5, {
    commitments: ["archived-commitment"],
    outputs: [{ intentHash: "archived-intent", outputNo: 0 }],
  });
  expect(await claimedCommitment("archived-commitment")).toHaveLength(1);

  await archive(5);
  expect(await claimedCommitment("archived-commitment")).toEqual([]);
  expect(await claimedOutput("archived-intent", 0)).toEqual([]);
  // The cascade is the mechanism, not a side effect worth assuming.
  const left = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM offer_file_commitments WHERE offer_file_id = 5) AS c,
            (SELECT COUNT(*)::int FROM offer_file_unshielded_outputs WHERE offer_file_id = 5) AS u`,
  );
  expect(left.rows[0]).toEqual({ c: 0, u: 0 });
});

test("the incumbent is content-addressed, so replicas agree", async () => {
  // Two live offers claiming one marker cannot arise through the doors any
  // more — that is the whole rule — but the probe must still answer
  // deterministically if it ever sees them, because p7a replays the chain into
  // a second instance and compares state. SERIAL ids are deployment-local: they
  // are assigned in arrival order, which a replay need not reproduce. So the
  // rows are seeded with ids ASCENDING and hashes DESCENDING, and the answer
  // must follow the hash.
  await client.query(
    `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash,
       created_at, first_seen_at, ttl_seconds)
     VALUES (6, 706, 'blob-6', $1, NOW(), NOW(), 3600),
            (7, 707, 'blob-7', $2, NOW(), NOW(), 3600)`,
    ["ffff" + "0".repeat(60), "0000" + "0".repeat(60)],
  );
  await client.query(
    `INSERT INTO offer_file_commitments (offer_file_id, commitment)
     VALUES (6, 'contested'), (7, 'contested')`,
  );
  const claimed = await claimedCommitment("contested");
  expect(claimed).toHaveLength(1);
  expect(claimed[0]!.offer_hash).toBe("0000" + "0".repeat(60)); // the lower hash
  expect(claimed[0]!.offer_file_id).toBe(7); // the HIGHER id — not arrival order
});

test("the probes are index-served, not scans", async () => {
  // Both indexes were added with this rule and are load-bearing rather than an
  // optimisation: the primary keys on both marker tables lead with
  // offer_file_id, and this rule looks the book up BY MARKER with no offer
  // known in advance. Without them every accepted offer costs a sequential scan
  // of the live book per declared marker, at both doors.
  //
  // Asserted on the PLAN, not on a duration: a timing threshold on PGlite in CI
  // measures the box.
  const plans = [
    (await client.query(
      `EXPLAIN SELECT 1 FROM offer_file_commitments WHERE commitment = 'contested'`,
    )).rows.map((r: any) => r["QUERY PLAN"]).join(" "),
    (await client.query(
      `EXPLAIN SELECT 1 FROM offer_file_unshielded_outputs
        WHERE owner = $1 AND intent_hash = 'wrapper-intent' AND output_no = 0`,
      [MAKER],
    )).rows.map((r: any) => r["QUERY PLAN"]).join(" "),
  ];
  for (const plan of plans) expect(plan).toContain("Index");
});
