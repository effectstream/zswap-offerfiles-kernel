/**
 * Dev-stack price feed. Writes to the dev PGlite (DB_HOST/DB_PORT).
 *
 * `bun run --filter @zswap-da/price-feed once` runs one cycle and exits;
 * plain `start` loops once a day. Neither is needed for the stack to quote:
 * the schema ships seeded reference prices.
 */
import { startPriceFeed } from "./src/entrypoint.ts";

await startPriceFeed("dev");
