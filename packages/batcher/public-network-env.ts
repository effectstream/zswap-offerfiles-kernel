// Side-effect module: checks the raw environment against the public-network
// batcher contract and exits 78 (EX_CONFIG) listing every problem, each naming
// its variable. batcher.public.ts imports it FIRST, so it runs before
// config.ts loads midnight-env (which throws at import without a Blockfrost
// token) — see public-network.ts.
import { EX_CONFIG, resolvePublicBatcherProblems } from "./public-network.ts";

const problems = resolvePublicBatcherProblems(process.env);
if (problems.length > 0) {
  console.error(
    `[zswap-da-batcher] configuration for MIDNIGHT_NETWORK_ID="${process.env["MIDNIGHT_NETWORK_ID"] || "(unset)"}" ` +
      `is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(EX_CONFIG);
}
