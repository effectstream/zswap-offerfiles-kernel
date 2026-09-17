// EXTERNAL-STACK entrypoint: run only the kernel processes against Midnight
// and Celestia infrastructure operated elsewhere.
//
//   bunx orchestrator start start.external.ts
//
// Required env (the SDK and batcher read these names directly):
//   MIDNIGHT_NETWORK_ID
//   MIDNIGHT_NODE_HTTP
//   MIDNIGHT_INDEXER_HTTP
//   MIDNIGHT_INDEXER_WS
//   MIDNIGHT_PROOF_SERVER_URL
//   BATCHER_WALLET_SEED        prefunded fee wallet
//   CELESTIA_RPC_URL
//   CELESTIA_AUTH_TOKEN
//   CELESTIA_NAMESPACE
//
// This launcher never deploys a contract or mints/funds inventory. Wallets
// that submit transactions must already hold same-chain assets and fee funds.

import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { DbNames, launchPglite } from "@effectstream/orchestrator/launch-pglite";

const PREFLIGHT = "preflight-external";
const SYNC_API_HEALTH = "sync-api-health";
const LOCAL_ZSWAP_API = "http://127.0.0.1:9999";
const ZSWAP_API = process.env["ZSWAP_API"]?.trim() || LOCAL_ZSWAP_API;
const ZSWAP_HEALTH_WAIT = `${ZSWAP_API.replace(/\/+$/, "")}/v1/health`.replace(
  /^(https?):\/\//,
  "$1-get://",
);

export default {
  processes: [
    {
      name: PREFLIGHT,
      description: "Probe the external Midnight stack + Celestia node (fail fast)",
      args: ["run", "packages/node/preflight-external.ts"],
      waitToExit: true,
      critical: true,
    },

    ...launchPglite(),

    {
      name: "sync",
      description: "ZSwap-DA sync node (external Celestia + Midnight)",
      args: ["run", "packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: { PGLITE: "true", ENABLE_TOKEN_REGISTRY: "true" },
      dependsOn: [PREFLIGHT, DbNames.PGLITE_WAIT],
    },

    {
      name: SYNC_API_HEALTH,
      description: `Wait for the ZSwap-DA kernel API at ${ZSWAP_API}`,
      args: ["x", "wait-on", "--timeout", "600000", ZSWAP_HEALTH_WAIT],
      waitToExit: true,
      critical: true,
      dependsOn: ["sync"],
    },

    {
      name: "batcher",
      description: "ZSwap-DA balancing batcher (external Celestia + Midnight, port 3334)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      dependsOn: [PREFLIGHT, SYNC_API_HEALTH],
    },
  ],
} satisfies OrchestratorConfig;
