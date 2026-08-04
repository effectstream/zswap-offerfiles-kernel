// Live verification of the rejected-blob scrub against a running stack.
//
// Publishes a blob whose body contains 0x00 (exactly what every real Midnight
// transaction contains) and asserts three things the old body-matching
// predicate could not deliver:
//   1. the node SURVIVES the rejection (it used to exit on 25P02);
//   2. the accounting row is actually GONE — proving the md5 match found it,
//      i.e. that JSON.stringify(parsedInput) reproduces the stored document;
//   3. the rejection is still counted in offer_rejections.
//
// Run against an up stack:  bun run packages/tests/grand-e2e/verify-nul-fix.ts

import pg from "pg";
import { submitBlobRaw } from "./lib/celestia.ts";
import { getHealth } from "./lib/api2.ts";
import { sleep } from "./lib/util.ts";

const db = new pg.Client({ host: "127.0.0.1", port: 5432, user: "postgres", password: "postgres", database: "postgres" });
await db.connect();

const accountingRows = async (): Promise<number> =>
  Number(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM effectstream.primitive_accounting WHERE primitive_name = 'ZswapBlob'`,
      )
    ).rows[0].n,
  );
const rejections = async (): Promise<number> =>
  Number((await db.query(`SELECT coalesce(sum(count),0)::int AS n FROM offer_rejections`)).rows[0].n);

const before = { rows: await accountingRows(), rejections: await rejections() };
console.log(`before: accounting=${before.rows} rejections=${before.rejections}`);

// A body shaped like a real transaction: header tag, NULs, high bytes.
const body = new TextEncoder().encode("midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1]):");
const blob = new Uint8Array(body.length + 64);
blob.set(body, 0);
for (let i = 0; i < 64; i++) blob[body.length + i] = i % 4 === 0 ? 0x00 : 0x80 + (i % 100); // NULs interleaved
console.log(`publishing ${blob.length}-byte blob containing ${blob.filter((b) => b === 0).length} NUL bytes…`);
const height = await submitBlobRaw(blob);
console.log(`published at Celestia height ${height}`);

let alive = true;
let scrubbed = false;
let counted = false;
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  alive = await getHealth();
  if (!alive) break;
  const nowRejections = await rejections();
  counted = nowRejections > before.rejections;
  if (counted) {
    scrubbed = (await accountingRows()) <= before.rows;
    break;
  }
}

console.log(`\n1. node survived the rejection:      ${alive ? "YES ✅" : "NO ❌ (crashed)"}`);
console.log(`2. rejection counted:                ${counted ? "YES ✅" : "NO ❌ (never ingested?)"}`);
console.log(`3. accounting row scrubbed (md5 hit): ${scrubbed ? "YES ✅" : "NO ❌ (serialization mismatch)"}`);
if (!scrubbed && counted) {
  const r = await db.query(
    `SELECT effectstream_block_height AS h, length(payload::text) AS len FROM effectstream.primitive_accounting
     WHERE primitive_name = 'ZswapBlob' ORDER BY h DESC LIMIT 3`,
  );
  console.log("   leftover rows:", JSON.stringify(r.rows));
}
await db.end();
process.exit(alive && counted && scrubbed ? 0 : 1);
