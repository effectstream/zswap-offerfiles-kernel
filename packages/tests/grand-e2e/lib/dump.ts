// Ordered per-table state dumps + the determinism diff.
//
// Rows are dumped ORDER BY primary key, serialized with sorted keys, with the
// wall-clock columns from DIFF_EXCLUDED_COLUMNS dropped. Everything left must
// be byte-identical between instance A and instance B (HANDOFF §9), modulo the
// documented special cases handled in diffStates().

import { mkdirSync, writeFileSync } from "node:fs";
import type { Client } from "pg";
import { DIFF_EXCLUDED_COLUMNS, DIFF_EXCLUDED_TABLES } from "../config.ts";
import { ledger } from "../ledger.ts";

export type StateDump = Record<string, Record<string, unknown>[]>;

async function publicTables(db: Client): Promise<string[]> {
  const r = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return r.rows.map((row: any) => row.table_name as string);
}

async function pkColumns(db: Client, table: string): Promise<string[]> {
  const r = await db.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    [table],
  );
  return r.rows.map((row: any) => row.column_name as string);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (DIFF_EXCLUDED_COLUMNS.has(key)) continue;
    let v = row[key];
    if (v instanceof Date) v = v.toISOString();
    if (typeof v === "bigint") v = v.toString();
    out[key] = v;
  }
  return out;
}

export async function dumpPublicState(db: Client, dir: string, label: string): Promise<StateDump> {
  mkdirSync(dir, { recursive: true });
  const dump: StateDump = {};
  for (const table of await publicTables(db)) {
    const pk = await pkColumns(db, table);
    const orderBy = pk.length > 0 ? pk.map((c) => `"${c}"`).join(", ") : "1";
    const r = await db.query(`SELECT * FROM public."${table}" ORDER BY ${orderBy}`);
    dump[table] = (r.rows as Record<string, unknown>[]).map(normalizeRow);
  }
  writeFileSync(
    `${dir}/state-${label}.json`,
    JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  return dump;
}

export interface DiffResult {
  identical: boolean;
  tableReports: string[];
  differences: string[];
}

/**
 * Diff two dumps under the §9 rules. `heightsMatch` is whether the two
 * instances were dumped at exactly the same NTP height — when they were not,
 * the current-root last_seen_ms edge on known_roots is excluded (documented).
 */
export function diffStates(a: StateDump, b: StateDump, heightsMatch: boolean): DiffResult {
  const tableReports: string[] = [];
  const differences: string[] = [];
  const tables = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

  for (const table of tables) {
    if (table in DIFF_EXCLUDED_TABLES) {
      tableReports.push(`~ ${table}: EXCLUDED — ${DIFF_EXCLUDED_TABLES[table]}`);
      continue;
    }
    let rowsA = a[table] ?? [];
    let rowsB = b[table] ?? [];

    if (table === "known_tokens" && ledger.apiOnlyTokenColors.length > 0) {
      const skip = new Set(ledger.apiOnlyTokenColors);
      const before = rowsA.length;
      rowsA = rowsA.filter((r) => !skip.has(String(r["token_color"])));
      rowsB = rowsB.filter((r) => !skip.has(String(r["token_color"])));
      if (before !== rowsA.length) {
        tableReports.push(`~ known_tokens: ${before - rowsA.length} API-registered row(s) excluded (request-driven)`);
      }
    }
    if (table === "known_roots" && !heightsMatch) {
      // Dumped at slightly different heights: the still-current root keeps
      // re-upserting last_seen_ms, and the prune cutoff slides with it. Drop
      // last_seen_ms and diff on (root, height, first_seen_ms) for roots both
      // sides hold; report set-membership drift near the cutoff separately.
      const strip = (rows: Record<string, unknown>[]) =>
        rows.map(({ last_seen_ms: _l, ...rest }) => rest);
      const setA = new Set(rowsA.map((r) => String(r["root"])));
      const setB = new Set(rowsB.map((r) => String(r["root"])));
      const onlyA = [...setA].filter((x) => !setB.has(x));
      const onlyB = [...setB].filter((x) => !setA.has(x));
      if (onlyA.length + onlyB.length > 0) {
        tableReports.push(
          `~ known_roots: ${onlyA.length}+${onlyB.length} cutoff-edge membership drift tolerated (dump heights differ)`,
        );
      }
      rowsA = strip(rowsA.filter((r) => setB.has(String(r["root"]))));
      rowsB = strip(rowsB.filter((r) => setA.has(String(r["root"]))));
    }

    if (rowsA.length !== rowsB.length) {
      differences.push(`${table}: row count A=${rowsA.length} B=${rowsB.length}`);
      continue;
    }
    let mismatches = 0;
    for (let i = 0; i < rowsA.length; i++) {
      const ja = JSON.stringify(rowsA[i]);
      const jb = JSON.stringify(rowsB[i]);
      if (ja !== jb) {
        mismatches++;
        if (mismatches <= 3) differences.push(`${table}[${i}]: A=${ja.slice(0, 200)} B=${jb.slice(0, 200)}`);
      }
    }
    if (mismatches > 3) differences.push(`${table}: …and ${mismatches - 3} more row mismatches`);
    tableReports.push(
      mismatches === 0 ? `✓ ${table}: ${rowsA.length} rows identical` : `✗ ${table}: ${mismatches} row mismatches`,
    );
  }
  return { identical: differences.length === 0, tableReports, differences };
}
