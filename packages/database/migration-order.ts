import type { DBMigrations } from "@effectstream/runtime";
import databaseSql from "./migrations/000-init.sql" with { type: "text" };
import unshieldedClassificationSql from "./migrations/014-unshielded-classification.sql" with { type: "text" };
import localMigrationSql from "./migrations/local-migration.sql" with { type: "text" };

// One schema file, applied from zero — see the header of 000-init.sql for why
// the former 001..013 chain is gone. Edit 000-init.sql in place; do not add
// numbered migrations. local-migration.sql still runs last, for local-only
// additions that must not enter the shared schema.
export const migrationTable: DBMigrations[] = [
  {
    name: "000-init.sql",
    sql: databaseSql,
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
