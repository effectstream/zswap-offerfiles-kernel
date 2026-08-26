// Import the exact lockfile closures, not whichever package happens to be
// hoisted into a workspace-level node_modules directory.  These are the real
// packages used by the E1 app image after its frozen Bun install.
import { init, start } from "../../../../node_modules/.bun/@effectstream+runtime@0.103.1+a0563dae982d6bb0/node_modules/@effectstream/runtime/src/mod.ts";
import { EvmFetcher } from "../../../../node_modules/.bun/@effectstream+sync@0.103.1+5d8c9785591cc28f/node_modules/@effectstream/sync/src/mod.ts";

if (typeof init !== "function" || typeof start !== "function") {
  throw new Error("@effectstream/runtime did not expose its real init/start boundary");
}

const config = {
  syncProtocol: {
    name: "e1-runtime-decorator-smoke",
    stepSize: 4,
  },
  primitives: [],
} as unknown as ConstructorParameters<typeof EvmFetcher>[0];
const client = Object.freeze({}) as unknown as ConstructorParameters<typeof EvmFetcher>[1];
const fetcher = new EvmFetcher(config, client);
const detachedIntervalFromStart = fetcher.intervalFromStart;
const interval = detachedIntervalFromStart(17);

if (interval.from !== 17 || interval.to !== 21) {
  throw new Error(`detached EvmFetcher decorator smoke returned ${JSON.stringify(interval)}`);
}

console.log("app-runtime-import=ok");
console.log("app-runtime-detached-decorator=ok");
