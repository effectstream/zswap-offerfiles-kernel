// Standalone wrapper — expects a live `bun run dev` stack.
// Suite version: packages/tests/stm/multi-token.test.ts (via `bun run test`).
//
//   bun packages/tests/multi-token-swap-e2e.ts

import pg from "pg";
import { anyError, printSummary } from "./helpers.ts";
import { multiTokenTest } from "./stm/multi-token.test.ts";

const db = new pg.Client({
  host: "127.0.0.1",
  port: 5432,
  user: "postgres",
  database: "postgres",
});
await db.connect();
try {
  await multiTokenTest(db);
  printSummary();
} finally {
  await db.end().catch(() => {});
}
process.exit(anyError() ? 1 : 0);
