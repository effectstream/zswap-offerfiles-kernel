import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { DbNames, launchPglite } from "@effectstream/orchestrator/launch-pglite";
import {
  launchCelestia,
  CelestiaNames,
} from "@effectstream/orchestrator/launch-celestia";
import {
  launchMidnightServices,
  MidnightServiceNames,
} from "./scripts/launch-midnight-services.ts";

const root = import.meta.dirname!;

const midnightDeps = [
  MidnightServiceNames.NODE_WAIT,
  MidnightServiceNames.INDEXER_WAIT,
  MidnightServiceNames.PROOF_SERVER_WAIT,
];
const syncApiHealth = "sync-api-health";
const tokenRegistryImport = "canonical-token-registry";

export default {
  processes: [
    ...launchPglite(),

    ...launchMidnightServices(path.join(root, "packages/midnight-infra")),

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
      env: {
        PGLITE: "true",
        API_RATE_LIMIT_ALLOWLIST: "127.0.0.1,::1",
        ENABLE_TOKEN_REGISTRY: "true",
      },
      dependsOn: [
        DbNames.PGLITE_WAIT,
        CelestiaNames.FUND,
        ...midnightDeps,
      ],
    },

    {
      name: syncApiHealth,
      description: "Wait for the ZSwap-DA kernel API health endpoint",
      args: ["x", "wait-on", "--timeout", "600000", "http-get://127.0.0.1:9999/v1/health"],
      waitToExit: true,
      critical: true,
      dependsOn: ["sync"],
    },

    {
      name: tokenRegistryImport,
      description: "Optionally import the selected mint-test-tokens registry",
      args: ["run", "packages/database/import-token-registry.ts"],
      waitToExit: true,
      // The external faucet is optional. The script bounds fetch/DB waits,
      // reports a skip and exits successfully on every unavailable path.
      critical: false,
      dependsOn: [syncApiHealth],
    },

    {
      name: "batcher",
      description: "ZSwap-DA balancing batcher (Celestia + Midnight, port 3334)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
      dependsOn: [...midnightDeps, syncApiHealth],
    },

    {
      name: "solver",
      description: "ZSwap-DA posted-price solver (matches crossings, fills from inventory)",
      args: ["run", "packages/solver/solver.dev.ts"],
      waitToExit: false,
      // Deliberately not a system-dependency: the stack is fully usable without
      // a solver, and a solver fault must never tear the stack down.
      //
      dependsOn: [...midnightDeps, syncApiHealth, "sync"],
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
    // against this stack (Vite on :10600, API + network config from :9999).
  ],
} satisfies OrchestratorConfig;
