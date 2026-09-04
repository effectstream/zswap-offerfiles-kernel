// Orchestrator config for a containerised stack: everything start.dev.ts runs
// EXCEPT the chain layer, which compose provides as its own services.
//
// start.dev.ts launches Midnight and Celestia from npm-shipped binaries and
// PGlite in-process, all on fixed ports. That is convenient on a laptop and
// impossible to run twice, so the compose stack supplies those as containers
// and this config attaches to them over the network.
//
// Every endpoint comes from env (see infra/docker-compose.yml); nothing here
// assumes localhost.

import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { DbNames, launchPglite } from "@effectstream/orchestrator/launch-pglite";

const root = import.meta.dirname!;

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`start.attach.ts requires ${name}`);
  return value;
};

// Host:port pairs to wait on before anything touches the chain. Derived from
// the same URLs the app itself uses, so a mismatch is impossible.
const hostPort = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
};

const CHAIN_WAIT_TARGETS = [
  hostPort(env("MIDNIGHT_NODE_HTTP")),
  hostPort(env("MIDNIGHT_INDEXER_HTTP")),
  hostPort(env("MIDNIGHT_PROOF_SERVER_URL")),
  hostPort(env("CELESTIA_RPC_URL")),
].map((target) => `tcp:${target}`);

const CONTRACT_DEPLOY = "midnight-contract";
const CHAIN_WAIT = "chain-wait";
const SYNC_API_HEALTH = "sync-api-health";
const LOCAL_ZSWAP_API = "http://127.0.0.1:9999";
const ZSWAP_API = process.env["ZSWAP_API"]?.trim() || LOCAL_ZSWAP_API;
const ZSWAP_HEALTH_WAIT = `${ZSWAP_API.replace(/\/+$/, "")}/v1/health`.replace(
  /^(https?):\/\//,
  "$1-get://",
);

export default {
  processes: [
    // PGLITE=false makes this a single wait on the external Postgres compose
    // provides, instead of spawning an embedded one.
    ...launchPglite(),

    {
      name: CHAIN_WAIT,
      description: `Wait for the chain services (${CHAIN_WAIT_TARGETS.join(" ")})`,
      args: ["x", "wait-on", "--timeout", "600000", ...CHAIN_WAIT_TARGETS],
      waitToExit: true,
      critical: true,
    },

    {
      name: CONTRACT_DEPLOY,
      description: "Deploy the offer-files contract to the containerised node",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "midnight-contract:deploy"],
      env: { MIDNIGHT_STORAGE_PASSWORD: "YourPasswordMy1!" },
      waitToExit: true,
      critical: true,
      dependsOn: [DbNames.PGLITE_WAIT, CHAIN_WAIT],
    },

    {
      name: "midnight-mint-test-tokens",
      description: "Mint dev test tokens (2 shielded + 1 unshielded)",
      cwd: path.join(root, "packages/contracts-midnight"),
      args: ["run", "mint-test-tokens.ts"],
      env: { ZSWAP_API },
      waitToExit: true,
      // NOT critical: a mint hiccup must not tear the stack down.
      dependsOn: [CONTRACT_DEPLOY, SYNC_API_HEALTH],
    },

    {
      name: "sync",
      description: "ZSwap-DA sync node (Celestia + Midnight)",
      args: ["run", "packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: { ENABLE_TOKEN_REGISTRY: "true" },
      dependsOn: [DbNames.PGLITE_WAIT, CHAIN_WAIT, CONTRACT_DEPLOY],
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
      description: "ZSwap-DA balancing batcher (Celestia + Midnight)",
      args: ["run", "packages/batcher/batcher.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      dependsOn: [CHAIN_WAIT, CONTRACT_DEPLOY, "midnight-mint-test-tokens"],
    },

    {
      name: "solver",
      description: "ZSwap-DA posted-price solver",
      args: ["run", "packages/solver/solver.dev.ts"],
      waitToExit: false,
      // Not a system-dependency: the stack is usable without a solver, and a
      // solver fault must never tear it down.
      dependsOn: [CONTRACT_DEPLOY, "midnight-mint-test-tokens", SYNC_API_HEALTH, "sync"],
    },
  ],
} satisfies OrchestratorConfig;
