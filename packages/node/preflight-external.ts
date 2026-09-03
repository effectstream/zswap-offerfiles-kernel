// Pre-flight for EXTERNAL-STACK mode (start.external.ts): verify every
// out-of-process dependency is reachable before launching any kernel process.
//
// Why this file exists: the dev orchestrator's `launchMidnight` cannot be
// pointed at an external stack — its process list is static AND it declares
// `stopProcessAtPort: [9944, 8088, 6300]`, so against a running external stack
// it would first KILL the listeners on those ports and then start its own
// devnet. External mode therefore uses a separate entrypoint that launches no
// Midnight/Celestia infrastructure at all, and this probe is its fail-fast.
//
// Endpoints come from the same env the SDK reads (midnight-env /
// batcher config), so a probe success here means the kernel processes will
// dial the same addresses that just answered:
//   MIDNIGHT_NODE_HTTP / MIDNIGHT_INDEXER_HTTP / MIDNIGHT_PROOF_SERVER_URL
//   CELESTIA_RPC_URL + CELESTIA_AUTH_TOKEN

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";

const TIMEOUT_MS = 5_000;

async function probe(
  name: string,
  fn: () => Promise<string>,
): Promise<boolean> {
  try {
    const detail = await fn();
    console.log(`[preflight] OK   ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (e) {
    console.error(`[preflight] FAIL ${name} — ${(e as Error).message}`);
    return false;
  }
}

const withTimeout = (init?: RequestInit): RequestInit => ({
  ...init,
  signal: AbortSignal.timeout(TIMEOUT_MS),
});

const net = midnightNetworkConfig;
console.log(
  `[preflight] external stack: node=${net.node} indexer=${net.indexer} proofServer=${net.proofServer}`,
);

const results = await Promise.all([
  probe("midnight node RPC", async () => {
    const res = await fetch(net.node, withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getHeader", params: [] }),
    }));
    const json = (await res.json()) as any;
    if (!json?.result?.number) throw new Error(`unexpected RPC answer: ${JSON.stringify(json).slice(0, 120)}`);
    return `head #${parseInt(json.result.number, 16)}`;
  }),

  probe("midnight indexer GraphQL", async () => {
    const res = await fetch(net.indexer, withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    }));
    const json = (await res.json()) as any;
    if (!json?.data?.__typename) throw new Error(`unexpected GraphQL answer: ${JSON.stringify(json).slice(0, 120)}`);
    return json.data.__typename;
  }),

  probe("midnight proof server", async () => {
    // No health endpoint on the proof server — any HTTP answer proves the
    // listener is there (the root path 404s, which is fine).
    const res = await fetch(net.proofServer, withTimeout());
    return `HTTP ${res.status}`;
  }),

  probe("celestia RPC (authed)", async () => {
    const rpcUrl = process.env["CELESTIA_RPC_URL"] ?? "http://127.0.0.1:26658";
    const token = process.env["CELESTIA_AUTH_TOKEN"];
    if (!token) {
      throw new Error(
        "CELESTIA_AUTH_TOKEN is not set. In the demo-infra compose it is " +
          "written by the celestia service to the shared `celestia-auth` volume.",
      );
    }
    const res = await fetch(rpcUrl, withTimeout({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "header.NetworkHead", params: [] }),
    }));
    const json = (await res.json()) as any;
    if (json.error) throw new Error(`header.NetworkHead: ${JSON.stringify(json.error)}`);
    return `head height ${json.result?.header?.height ?? "?"}`;
  }),
]);

if (results.some((ok) => !ok)) {
  console.error(
    "[preflight] external stack is not ready — fix the failing endpoint(s) above and retry.",
  );
  process.exit(1);
}
console.log("[preflight] all external dependencies reachable");
