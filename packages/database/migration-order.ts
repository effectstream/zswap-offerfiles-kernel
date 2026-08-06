import type { DBMigrations } from "@effectstream/runtime";
import databaseSql from "./migrations/000-init.sql" with { type: "text" };
import spentSetsSql from "./migrations/001-spent-sets.sql" with { type: "text" };
import livenessSetsSql from "./migrations/002-liveness-sets.sql" with { type: "text" };
import tokenPricesSql from "./migrations/003-token-prices.sql" with { type: "text" };
import pairStatsSql from "./migrations/004-pair-stats.sql" with { type: "text" };
import offerHashSql from "./migrations/005-offer-hash.sql" with { type: "text" };
import offerRejectionsSql from "./migrations/006-offer-rejections.sql" with { type: "text" };
import cursorPaginationSql from "./migrations/007-cursor-pagination.sql" with { type: "text" };
import nullifierTxHashSql from "./migrations/008-nullifier-tx-hash.sql" with { type: "text" };
import legKindSql from "./migrations/009-leg-kind.sql" with { type: "text" };
import dropAuthNoteSql from "./migrations/010-drop-auth-and-note.sql" with { type: "text" };
import rootFirstSeenSql from "./migrations/011-root-first-seen.sql" with { type: "text" };
import firstSeenAtSql from "./migrations/012-first-seen-at.sql" with { type: "text" };
import commitmentsSql from "./migrations/013-commitments.sql" with { type: "text" };
import unshieldedClassificationSql from "./migrations/014-unshielded-classification.sql" with { type: "text" };
import localMigrationSql from "./migrations/local-migration.sql" with { type: "text" };
export const migrationTable: DBMigrations[] = [
  {
    name: "000-init.sql",
    sql: databaseSql,
  },
  {
    name: "001-spent-sets.sql",
    sql: spentSetsSql,
  },
  {
    name: "002-liveness-sets.sql",
    sql: livenessSetsSql,
  },
  {
    name: "003-token-prices.sql",
    sql: tokenPricesSql,
  },
  {
    name: "004-pair-stats.sql",
    sql: pairStatsSql,
  },
  {
    name: "005-offer-hash.sql",
    sql: offerHashSql,
  },
  {
    name: "006-offer-rejections.sql",
    sql: offerRejectionsSql,
  },
  {
    name: "007-cursor-pagination.sql",
    sql: cursorPaginationSql,
  },
  {
    name: "008-nullifier-tx-hash.sql",
    sql: nullifierTxHashSql,
  },
  {
    name: "009-leg-kind.sql",
    sql: legKindSql,
  },
  {
    name: "010-drop-auth-and-note.sql",
    sql: dropAuthNoteSql,
  },
  {
    name: "011-root-first-seen.sql",
    sql: rootFirstSeenSql,
  },
  {
    name: "012-first-seen-at.sql",
    sql: firstSeenAtSql,
  },
  {
    name: "013-commitments.sql",
    sql: commitmentsSql,
  },
  {
    name: "014-unshielded-classification.sql",
    sql: unshieldedClassificationSql,
  },
  {
    name: "local-migration.sql",
    sql: localMigrationSql,
  },
];
