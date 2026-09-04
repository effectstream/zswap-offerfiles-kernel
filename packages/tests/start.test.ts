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

const root = path.resolve(import.meta.dirname!, "../..");

const midnightDeps = [MidnightNames.CONTRACT_DEPLOY];
const midnightMintTestTokens = "midnight-mint-test-tokens";
const syncApiHealth = "sync-api-health";

export default {
  processes: [
    ...launchPglite(),

    {
      name: "compact-build",
      description: "Compile Compact contract (offer-files)",
      cwd: path.join(root, "packages/contracts-midnight/contract-offer-files"),
      args: ["run", "compact"],
      waitToExit: true,
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
      description: "Mint test tokens (2 shielded + 1 unshielded) via the offer-files contract",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "mint-test-tokens.ts"],
      env: { ZSWAP_API: "http://127.0.0.1:9999" },
      waitToExit: true,
      // NOT critical: a mint hiccup must not tear the test stack down.
      dependsOn: [MidnightNames.CONTRACT_DEPLOY, syncApiHealth],
    },

    ...launchCelestia(
      "@zswap-da/contracts-celestia",
      { cwd: path.join(root, "packages/contracts-celestia") },
      { home: "/tmp/celestia-test-zswap-home" },
    ),

    {
      name: "sync",
      description: "ZSwap-DA sync node (test)",
      args: ["run", "packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: {
        PGLITE: "true",
        ENABLE_DEV_AND_DEBUG_ENDPOINTS: "true",
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
      description: "Wait for the ZSwap-DA kernel API health endpoint (test)",
      args: ["x", "wait-on", "--timeout", "600000", "http-get://127.0.0.1:9999/v1/health"],
      waitToExit: true,
      critical: true,
      dependsOn: ["sync"],
    },

    {
      name: "batcher",
      description: "ZSwap-DA balancing batcher (port 3334)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      stopProcessAtPort: [3334],
      waitToExit: false,
      type: "system-dependency",
      // Match the dev stack: the batcher's temporary full-wallet bootstrap
      // starts only after the mint wallet has released its indexer sessions.
      dependsOn: [...midnightDeps, midnightMintTestTokens],
    },
  ],
} satisfies OrchestratorConfig;
