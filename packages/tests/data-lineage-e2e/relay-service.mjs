/**
 * L5-only relay process harness.
 *
 * It composes the built production pull adapter, registry, Fastify server,
 * public router, and real solver WebSocket server. Test-only audit endpoints
 * expose counters around executable interfaces; the Offer Files data routes
 * themselves are the unmodified production handlers.
 */

import {
  OfferFilesLiquidityPullAdapter,
  buildServer,
  createRelayWsServer,
  loadConfig,
  registerAppRoutes,
} from "@phase1-native-swaps/relay";

const config = loadConfig();
if (!config.offerFilesLiquidity) {
  throw new Error("Offer Files liquidity must be enabled for the L5 harness");
}

const baseWs = createRelayWsServer({
  port: config.relayWsPort,
  host: config.bindHost,
  authToken: config.solverAuthToken,
});

const executableMethodCalls = Object.fromEntries([
  "quoteFromLevels",
  "startJob",
  "finishJob",
  "sendSwap",
  "sendSubmitFailed",
  "sendTxSubmitted",
  "getSupportedTokens",
  "getPriceLevels",
].map((name) => [name, 0]));

const observedWs = new Proxy(baseWs, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof property !== "string" || typeof value !== "function") return value;
    if (!Object.hasOwn(executableMethodCalls, property)) return value;
    return (...args) => {
      executableMethodCalls[property] += 1;
      return value(...args);
    };
  },
});

let submissionCalls = 0;
const submitFn = async () => {
  submissionCalls += 1;
  throw new Error("L5 data-only traffic reached the executable submission boundary");
};

const adapter = new OfferFilesLiquidityPullAdapter(config.offerFilesLiquidity);
const server = await buildServer(config);
await registerAppRoutes(server, config, {
  wsServer: observedWs,
  submitFn,
  offerFilesLiquidity: adapter.registry,
});

server.get("/__lineage/ready", async () => ({ ready: true }));
server.post("/__lineage/poll", async () => adapter.pollOnce());
server.get("/__lineage/audit", async () => ({
  executableMethodCalls: { ...executableMethodCalls },
  quoteIdsMinted: executableMethodCalls.quoteFromLevels,
  jobsStarted: executableMethodCalls.startJob,
  intentDispatches: executableMethodCalls.sendSwap,
  walletProcessStarted: false,
  submissionCalls,
  connectedSolvers: baseWs.connectedCount(),
  registeredSolvers: baseWs.registeredCount(),
  withdrawalReason: adapter.registry.withdrawalReason(Date.now()),
}));

await server.listen({ host: config.bindHost, port: config.port });
adapter.start();

let shuttingDown = false;
async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  const results = await Promise.allSettled([
    adapter.stop(),
    server.close(),
    baseWs.close(),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    console.error("relay L5 harness teardown failures", failures);
    process.exitCode = 1;
  } else {
    process.exitCode = exitCode;
  }
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

console.log(JSON.stringify({
  event: "lineage-relay-ready",
  httpPort: config.port,
  wsPort: config.relayWsPort,
  solverId: config.offerFilesLiquidity.solverId,
}));
