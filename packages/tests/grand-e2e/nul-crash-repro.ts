// Reproduction: a Celestia blob containing a 0x00 byte kills the node.
// The framework stores every fetched blob body in
// effectstream.primitive_accounting.payload (JSON), and the STM's
// rejected-blob scrub matches that body back as a text parameter. Postgres
// cannot represent NUL in text/json — so a single 0x00 in an attacker's blob
// aborts the block transaction.
import { PGlite } from "@electric-sql/pglite";

const NUL = String.fromCharCode(0);
const db = new PGlite();
await db.exec(`CREATE TABLE acc (id serial, payload JSON NOT NULL);`);

const body = (s: string) => JSON.stringify({ payload: { suppliedValue: s } });

for (const [label, value] of [
  ["clean blob", "abcdef"],
  ["blob with 0x00", `abc${NUL}def`],
] as const) {
  try {
    await db.query(`INSERT INTO acc (payload) VALUES ($1)`, [body(value)]);
    console.log(`INSERT ${label}: OK`);
  } catch (e) {
    console.log(`INSERT ${label}: FAILED -> ${(e as Error).message}`);
  }
}

// The STM's scrub (deleteRejectedAccountingRow) binds the raw body as text:
try {
  await db.query(`DELETE FROM acc WHERE payload->'payload'->>'suppliedValue' = $1`, [
    `abc${NUL}def`,
  ]);
  console.log("DELETE matching a 0x00 body: OK");
} catch (e) {
  console.log(`DELETE matching a 0x00 body: FAILED -> ${(e as Error).message}`);
}

try {
  await db.query(`SELECT 1`);
  console.log("connection still usable afterwards: yes");
} catch (e) {
  console.log(`connection still usable afterwards: NO -> ${(e as Error).message}`);
}
