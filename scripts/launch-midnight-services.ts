import type { ProcessConfig } from "@effectstream/orchestrator/config";

export const MidnightServiceNames = {
  NODE: "midnight-node",
  NODE_WAIT: "midnight-node-wait",
  INDEXER: "midnight-indexer",
  INDEXER_WAIT: "midnight-indexer-wait",
  PROOF_SERVER: "midnight-proof-server",
  PROOF_SERVER_WAIT: "midnight-proof-server-wait",
} as const;

/** Launch the local Midnight chain services without compiling or deploying an
 * application contract. Offer Files consumes native zswap ledger events only. */
export function launchMidnightServices(cwd: string): ProcessConfig[] {
  return [
    {
      name: MidnightServiceNames.NODE,
      description: "Start Midnight node",
      cwd,
      stopProcessAtPort: [9944, 30333],
      args: ["run", "midnight-node:start"],
      waitToExit: false,
      critical: true,
    },
    {
      name: MidnightServiceNames.INDEXER,
      description: "Start Midnight indexer",
      cwd,
      stopProcessAtPort: [8088],
      args: ["run", "midnight-indexer:start"],
      waitToExit: false,
      critical: true,
      dependsOn: [MidnightServiceNames.NODE],
    },
    {
      name: MidnightServiceNames.PROOF_SERVER,
      description: "Start Midnight proof server",
      cwd,
      stopProcessAtPort: [6300],
      args: ["run", "midnight-proof-server:start"],
      waitToExit: false,
      critical: true,
      dependsOn: [MidnightServiceNames.NODE],
    },
    {
      name: MidnightServiceNames.NODE_WAIT,
      description: "Wait for Midnight node",
      cwd,
      args: ["run", "midnight-node:wait"],
      waitToExit: true,
      dependsOn: [MidnightServiceNames.NODE],
    },
    {
      name: MidnightServiceNames.INDEXER_WAIT,
      description: "Wait for Midnight indexer",
      cwd,
      args: ["run", "midnight-indexer:wait"],
      waitToExit: true,
      dependsOn: [MidnightServiceNames.INDEXER],
    },
    {
      name: MidnightServiceNames.PROOF_SERVER_WAIT,
      description: "Wait for Midnight proof server",
      cwd,
      args: ["run", "midnight-proof-server:wait"],
      waitToExit: true,
      dependsOn: [MidnightServiceNames.PROOF_SERVER],
    },
  ];
}
