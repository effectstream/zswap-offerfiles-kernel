// EXTERNAL-STACK entrypoint: run ONLY the kernel's own processes (pglite,
// contract deploy, sync node, batcher) against Midnight + Celestia
// infrastructure that something else operates — e.g. the demo-infra compose
// stack (acedward/midnight-2-offers) or any node/indexer/proof-server triple
// plus a Celestia node.
//
//   bunx orchestrator start start.external.ts
//
// Required env (same names the SDK/batcher already read — nothing bespoke):
//   MIDNIGHT_NETWORK_ID        e.g. undeployed
//   MIDNIGHT_NODE_HTTP         e.g. http://node:9944
//   MIDNIGHT_INDEXER_HTTP      e.g. http://indexer:8088/api/v4/graphql
//   MIDNIGHT_INDEXER_WS        e.g. ws://indexer:8088/api/v4/graphql/ws
//   MIDNIGHT_PROOF_SERVER_URL  e.g. http://proof-server:6300
//   MIDNIGHT_WALLET_SEED       deploy/mint wallet (prefunded)
//   BATCHER_WALLET_SEED        batcher fee wallet (prefunded, distinct seed)
//   CELESTIA_RPC_URL           e.g. http://celestia:26658
//   CELESTIA_AUTH_TOKEN        admin token of that Celestia node
//   CELESTIA_NAMESPACE         defaults to the MIP-0006 shared namespace
//
// Why not start.dev.ts with env pointing at the stack: launchMidnight /
// launchCelestia launch their OWN devnet unconditionally, and launchMidnight
// declares `stopProcessAtPort: [9944, 8088, 6300]` — against a live external
// stack it kills the very listeners it was meant to use. Measured 2026-08-25;
// see packages/node/preflight-external.ts and the demo-infra master plan
// (T4.3).
//
// The Compact contract is NOT compiled here: external mode assumes
// src/managed/ exists (the container image bakes it at build time; a source
// checkout gets it from `bun run build:midnight` / infra/compact.sh).

import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { DbNames, launchPglite } from "@effectstream/orchestrator/launch-pglite";

const root = import.meta.dirname!;

const PREFLIGHT = "preflight-external";
const CONTRACT_DEPLOY = "midnight-contract";
const MINT = "midnight-mint-test-tokens";

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
      name: CONTRACT_DEPLOY,
      description: "Deploy the offer-files contract to the external chain",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "midnight-contract:deploy"],
      env: { MIDNIGHT_STORAGE_PASSWORD: "YourPasswordMy1!" },
      waitToExit: true,
      critical: true,
      dependsOn: [PREFLIGHT, DbNames.PGLITE_WAIT],
    },

    {
      name: MINT,
      description: "Mint dev test tokens (2 shielded + 1 unshielded) via the offer-files contract",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "mint-test-tokens.ts"],
      waitToExit: true,
      // NOT critical: a mint hiccup must not tear the stack down (same rule
      // as start.dev.ts).
      dependsOn: [CONTRACT_DEPLOY],
    },

    {
      name: "sync",
      description: "ZSwap-DA sync node (external Celestia + Midnight)",
      args: ["run", "packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: { PGLITE: "true" },
      dependsOn: [DbNames.PGLITE_WAIT, CONTRACT_DEPLOY],
    },

    {
      name: "batcher",
      description: "ZSwap-DA balancing batcher (external Celestia + Midnight, port 3334)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      // Same serialization rule as start.dev.ts: the batcher's unshielded
      // wallet bootstrap must not overlap the mint wallet's indexer
      // subscriptions.
      dependsOn: [CONTRACT_DEPLOY, MINT],
    },
  ],
} satisfies OrchestratorConfig;
