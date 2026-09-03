/** Preview/preprod price feed. Same process; the DB_* variables decide where it writes. */
import { startPriceFeed } from "./src/entrypoint.ts";

await startPriceFeed("preview");
