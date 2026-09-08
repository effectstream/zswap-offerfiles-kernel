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
} from "../../scripts/launch-midnight-services.ts";

const root = path.resolve(import.meta.dirname!, "../..");

const midnightDeps = [
  MidnightServiceNames.NODE_WAIT,
  MidnightServiceNames.INDEXER_WAIT,
  MidnightServiceNames.PROOF_SERVER_WAIT,
];
const syncApiHealth = "sync-api-health";

export default {
  processes: [
    ...launchPglite(),

    ...launchMidnightServices(path.join(root, "packages/midnight-infra")),

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
      dependsOn: [...midnightDeps, syncApiHealth],
    },
  ],
} satisfies OrchestratorConfig;
