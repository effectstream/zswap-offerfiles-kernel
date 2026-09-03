import fs from "node:fs";
import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { DbNames, launchPglite } from "@effectstream/orchestrator/launch-pglite";
import {
  launchMidnight,
  MidnightNames,
} from "@effectstream/orchestrator/launch-midnight";
import {
  launchCelestia,
  CelestiaNames,
} from "@effectstream/orchestrator/launch-celestia";

const root = import.meta.dirname!;

// The compactc pin lives in infra/compact-version.txt and is run through
// infra/compact.sh: a host `$COMPACTC` of that version if set, otherwise the
// `compact-toolchain` container it builds on first use. The `compact` version
// manager plays no part — it does not publish the 0.33 line (see
// infra/compact-toolchain.Dockerfile) — so the check below verifies the route
// the build will actually take, not a manager install.
const COMPACT_VERSION = fs
  .readFileSync(path.join(root, "infra/compact-version.txt"), "utf8")
  .trim();

const compactCheckScript = `
const { execSync } = require("child_process");
const compactc = process.env.COMPACTC;
if (compactc) {
  let out = "";
  try {
    out = execSync(JSON.stringify(compactc) + " --version", { encoding: "utf8", stdio: "pipe" });
  } catch {
    console.error("ERROR: COMPACTC=" + compactc + " does not run (infra/compact.sh would exec it).");
    process.exit(1);
  }
  if (!out.includes("${COMPACT_VERSION}")) {
    console.error("ERROR: COMPACTC reports '" + out.trim() + "', expected compactc ${COMPACT_VERSION} (infra/compact-version.txt).");
    process.exit(1);
  }
  console.log("compactc ${COMPACT_VERSION} available via COMPACTC=" + compactc);
  process.exit(0);
}
try {
  execSync("docker info", { stdio: "pipe", timeout: 30000 });
} catch {
  console.error([
    "",
    "ERROR: neither COMPACTC nor a running Docker daemon is available.",
    "",
    "infra/compact.sh compiles offer-files.compact with compactc ${COMPACT_VERSION} either",
    "through a host binary (export COMPACTC=/path/to/compactc) or inside the",
    "compact-toolchain container it builds from infra/compact-toolchain.Dockerfile.",
    "",
  ].join("\\n"));
  process.exit(1);
}
console.log("compactc ${COMPACT_VERSION} will run in the compact-toolchain container (Docker daemon reachable)");
`.trim();

const midnightDeps = [MidnightNames.CONTRACT_DEPLOY];
const midnightMintTestTokens = "midnight-mint-test-tokens";

export default {
  processes: [
    {
      name: "compact-check",
      description: `Check that compactc ${COMPACT_VERSION} is reachable (COMPACTC or Docker, via infra/compact.sh)`,
      args: ["-e", compactCheckScript],
      waitToExit: true,
      critical: true,
    },

    ...launchPglite(),

    {
      name: "compact-build",
      description: "Compile Compact contract (offer-files)",
      cwd: path.join(root, "packages/contracts-midnight/contract-offer-files"),
      args: ["run", "compact"],
      waitToExit: true,
      dependsOn: ["compact-check"],
    },

    ...launchMidnight(
      "@zswap-da/contracts-midnight",
      { cwd: path.join(root, "packages/contracts-midnight") },
      {
        env: { MIDNIGHT_STORAGE_PASSWORD: "YourPasswordMy1!" },
        dependsOn: ["compact-build"],
      },
    ),

    {
      name: midnightMintTestTokens,
      description: "Mint dev test tokens (2 shielded + 1 unshielded) via the offer-files contract",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "mint-test-tokens.ts"],
      waitToExit: true,
      // NOT critical: a mint hiccup must not tear the dev stack down.
      dependsOn: [MidnightNames.CONTRACT_DEPLOY],
    },

    ...launchCelestia(
      "@zswap-da/contracts-celestia",
      { cwd: path.join(root, "packages/contracts-celestia") },
      { home: "/tmp/celestia-zswap-da-home" },
    ),

    {
      name: "sync",
      description: "ZSwap-DA sync node (Celestia + Midnight)",
      args: ["run", "packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      // Local clients (the solver's book mirror, e2e scripts) burst past the
      // shared per-IP budget during a page-through plus settlement polls.
      env: { PGLITE: "true", API_RATE_LIMIT_ALLOWLIST: "127.0.0.1,::1" },
      dependsOn: [
        DbNames.PGLITE_WAIT,
        CelestiaNames.FUND,
        ...midnightDeps,
      ],
    },


    {
      name: "batcher",
      description: "ZSwap-DA balancing batcher (Celestia + Midnight, port 3334)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
      // The dev bootstrap temporarily keeps the batcher's unshielded wallet
      // online while it verifies/splits NIGHT. Do not overlap those extra
      // indexer subscriptions with the mint wallet: the packaged indexer's
      // wallet DB pool can exhaust and kill the indexer mid-bootstrap.
      dependsOn: [...midnightDeps, midnightMintTestTokens],
    },

    {
      name: "solver",
      description: "ZSwap-DA posted-price solver (matches crossings, fills from inventory)",
      args: ["run", "packages/solver/solver.dev.ts"],
      waitToExit: false,
      // Deliberately not a system-dependency: the stack is fully usable without
      // a solver, and a solver fault must never tear the stack down.
      //
      // Waits on the mint bootstrap for the same reason the batcher does
      // (52f104b): buildWallet() opens a wallet facade against the indexer and
      // waitForSync() subscribes to its state stream, so an unsequenced solver
      // adds a third wallet's subscriptions on top of the mint wallet's and can
      // exhaust the packaged indexer's wallet DB pool mid-bootstrap. Upstream
      // gated only the batcher because upstream has no solver.
      dependsOn: [...midnightDeps, midnightMintTestTokens, "sync"],
    },

    // The price feed is deliberately NOT registered here (Q-11).
    //
    // Development runs on the reference prices seeded in 000-init.sql, which
    // is the whole reason the seeds exist: a dev stack quotes real BTC/ETH
    // ratios with no key, no network and no extra process. Running the feed
    // here would spend a shared, metered CoinGecko budget every time somebody
    // starts a stack, to replace correct numbers with slightly newer ones.
    //
    // To refresh prices deliberately: `bun run --filter @zswap-da/price-feed
    // once` with COINGECKO_API_KEY set, or the opt-in compose service
    // (`--profile prices` in deploy/).

    // The frontend lives in paima-engine/templates/zswap-da — run it separately
    // against this stack (vite on :10600, fetches API + ZK keys from :9999).
  ],
} satisfies OrchestratorConfig;
