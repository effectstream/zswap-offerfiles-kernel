// A column excluded from the determinism diff must never drive behaviour.
//
// This is the guard the last three defects were all missing. DIFF_EXCLUDED_COLUMNS
// exists for columns recording a genuinely LOCAL fact — "when did this node first
// see it" — which two correct replicas legitimately disagree on. That is a fine
// reason to exclude them from the replay comparison.
//
// It stops being fine the moment a query READS one. Then node-local state is
// deciding behaviour, replicas diverge in a way users can observe, and the
// determinism replay — our strongest check — cannot see it BY CONSTRUCTION,
// because the column it would need to compare is the one we told it to skip.
//
// That is exactly what happened to keyset pagination: it ordered on
// `offer_file.created_at`, `DEFAULT NOW()`, so two replicas served the same book
// in different orders and no test could catch it. Fixed in migration 015 by
// moving the cursor to the chain-derived `first_seen_at`.
//
// So: assert the property directly. Every excluded column must be write-only —
// present in INSERTs and RETURNINGs, absent from SELECT lists, WHERE, ORDER BY
// and JOIN conditions.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const EXCLUDED = ["created_at", "recorded_at"];

/** Strip SQL and JS comments so prose about a column is not read as usage. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");
}

/**
 * The SQL statements in a file, isolated.
 *
 * Scoping matters: a clause regex run over a whole .ts file bleeds past the end
 * of one template literal into the TypeScript that follows, and reports an
 * interface field as if it were a WHERE clause. So pull the statements out
 * first — backtick literals for .ts, semicolon-delimited for .sql — and only
 * then look for reading clauses inside each.
 */
function statements(raw: string, isTs: boolean): string[] {
  if (!isTs) return raw.split(";");
  return [...raw.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
}

/** The clauses where reading a column means it is driving behaviour. */
function readingClauses(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(ORDER\s+BY|GROUP\s+BY|WHERE|HAVING|\bON\b)\b([\s\S]*?)(?=\bORDER\s+BY\b|\bGROUP\s+BY\b|\bWHERE\b|\bHAVING\b|\bLIMIT\b|\bRETURNING\b|\bUNION\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(m[0]);
  return out;
}

test("no determinism-excluded column is read by any query", () => {
  const sources = [
    "packages/database/sql/queries.app.ts",
    "packages/database/sql/queries.sql",
  ];
  const offenders: string[] = [];

  for (const file of sources) {
    let raw: string;
    try {
      raw = readFileSync(new URL(`../../${file}`, import.meta.url).pathname, "utf-8");
    } catch {
      raw = readFileSync(file, "utf-8");
    }
    for (const stmt of statements(stripComments(raw), file.endsWith(".ts"))) {
      for (const clause of readingClauses(stmt)) {
        for (const col of EXCLUDED) {
          // `AS created_at` is an alias for output, not a read of the column.
          const asAlias = new RegExp(`AS\\s+${col}\\b`, "i");
          const bare = new RegExp(`\\b${col}\\b`);
          if (bare.test(clause) && !asAlias.test(clause)) {
            offenders.push(`${file}: ${col} in "${clause.replace(/\s+/g, " ").slice(0, 110)}"`);
          }
        }
      }
    }
  }

  expect(
    offenders,
    "A column excluded from the determinism diff is being read for logic. Either it " +
      "is not really node-local (remove it from DIFF_EXCLUDED_COLUMNS and let the " +
      "replay hold replicas to it), or the query should read a chain-derived column " +
      "instead — first_seen_at, metadata_created_at, archived_at, celestia_height.",
  ).toEqual([]);
});

test("the excluded list matches the suite's DIFF_EXCLUDED_COLUMNS", async () => {
  // The guard is only meaningful if it guards the SAME set the diff skips.
  const { DIFF_EXCLUDED_COLUMNS } = await import("../tests/grand-e2e/config.ts");
  expect([...DIFF_EXCLUDED_COLUMNS].sort()).toEqual([...EXCLUDED].sort());
});
