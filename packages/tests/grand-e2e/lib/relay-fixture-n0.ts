/**
 * Generated Docker artifacts for the N0 relay fixture.
 *
 * The Midnight Intents relay is consumed EXACTLY as pinned — the standing user
 * rule for this project is that `midnight-intents-swaps` is never modified,
 * committed to, or pushed. Everything here therefore lives on our side of the
 * boundary: the harness makes a throwaway clone of the pinned revision, builds
 * it with the Dockerfile below, and boots it with the entrypoint below. Nothing
 * is ever written into the source repository.
 *
 * The Dockerfile is a faithful adaptation of the pinned rev's own
 * `phase1-native-swaps/infra/Dockerfile.relay`: the same builder stages, the
 * same `npm ci` / per-workspace `tsc --build` / `npm prune --omit=dev`
 * sequence, and the same copy order. Two deliberate differences:
 *
 *   1. the `node:24-alpine` base is digest-pinned (upstream floats the tag), so
 *      a fixture run is reproducible; and
 *   2. supervisord is dropped, because the fixture is booted directly rather
 *      than as a restarting production service.
 *
 * These are Docker TEST artifacts: they are generated into a temp directory at
 * run time and are never committed, per the project testing rules.
 */

/** The revision of `midnight-intents-swaps` this fixture pins. */
export const RELAY_FIXTURE_REVISION = "d444c8379415093460d83a6ba27536af396f759d";

export const RELAY_FIXTURE_PINS = Object.freeze({
  revision: RELAY_FIXTURE_REVISION,
  /** Same base image upstream's Dockerfile.relay uses, digest-pinned. */
  nodeImage:
    "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43",
  nodeVersion: "v24.19.0",
  npmVersion: "11.17.0",
  /** Workspace root inside the build context, relative to the clone root. */
  workspaceSubdirectory: "phase1-native-swaps",
  /** Container-internal ports; the host side is always a reserved free port. */
  containerHttpPort: 3000,
  containerWsPort: 9001,
} as const);

/** Printed by the entrypoint once both listeners are up. */
export const RELAY_FIXTURE_READY_MARKER = "RELAY_FIXTURE_READY";

/**
 * Boot mode this fixture proves.
 *
 * The stock `relay-main.ts` additionally opens a `PolkadotNodeClient` against a
 * Midnight node and exits when it cannot, because it needs the chain to submit
 * the merged transaction. That chain dependency is out of N0's scope: N0 pins
 * the WIRE CONTRACT, so the fixture composes the pinned relay's own
 * `loadConfig`, `createRelayWsServer`, `buildServer` and `registerAppRoutes`
 * with a submit function that refuses.
 *
 * What that proves, exactly: the WS server on `RELAY_WS_PORT`, bearer
 * authentication at the upgrade against `SOLVER_AUTH_TOKEN`, capability and
 * price-ladder ingestion, `GET /tokens`, and `POST /quote` interpolation — all
 * running the pinned relay's compiled code. What it does NOT prove: `POST
 * /intent`, `userTx.merge(solverTx)`, and on-chain submission, which need a
 * real node and belong to the N4/N6 gates.
 */
export const RELAY_FIXTURE_BOOT_MODE = "chainless" as const;

/**
 * The fixture entrypoint. Written into the image at build time.
 *
 * `NODE_ENV=production` is required, not cosmetic: the shared logger selects a
 * `pino-pretty` transport otherwise, and `pino-pretty` is a devDependency that
 * upstream's own `npm prune --omit=dev` removes from the runtime image. The
 * production deployment sets it for the same reason.
 */
export function relayFixtureEntrypoint(): string {
  return `import { pathToFileURL } from "node:url";

// Import the PINNED relay's own compiled modules. Resolving through file URLs
// keeps their own dependency resolution anchored at /app/node_modules.
const relayModule = (specifier) =>
  import(pathToFileURL("/app/packages/relay/dist/" + specifier).href);

const { loadConfig } = await relayModule("config.js");
const { createLogger } = await relayModule("logger.js");
const { buildServer } = await relayModule("server.js");
const { createRelayWsServer } = await relayModule("relay-ws.js");
const { registerAppRoutes } = await relayModule("router/index.js");

// loadConfig() is the relay's own loader: it REQUIRES RELAY_PORT,
// RELAY_WS_PORT, and a SOLVER_AUTH_TOKEN of at least 32 characters, and throws
// otherwise. The fixture deliberately does not pre-validate any of that, so a
// misconfigured fixture fails exactly the way the real relay would.
const config = loadConfig();
const log = createLogger().child({ component: "relay-fixture" });

const wsServer = createRelayWsServer({
  port: config.relayWsPort,
  host: config.bindHost,
  authToken: config.solverAuthToken,
  logger: log,
});

// Chainless fixture: there is no Midnight node, so submission must refuse
// loudly rather than pretend to succeed. Reaching this is a harness bug.
const submitFn = async () => {
  throw new Error("relay_fixture_chainless: on-chain submission is not available");
};

const server = await buildServer(config, { logger: log });
await registerAppRoutes(server, config, { wsServer, submitFn });
await server.listen({ port: config.port, host: config.bindHost });

const shutdown = async () => {
  try {
    await server.close();
  } finally {
    await wsServer.close();
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("${RELAY_FIXTURE_READY_MARKER}");
`;
}

/**
 * Build context is the throwaway clone's `phase1-native-swaps` directory, so
 * every `COPY` path below is byte-identical to upstream's Dockerfile.relay.
 * `entrypoint.mjs` is the one addition and is written into the context by the
 * harness, next to the generated Dockerfile.
 */
export function relayFixtureDockerfile(): string {
  return `# Generated N0 relay fixture image — adapted from the pinned revision's own
# infra/Dockerfile.relay. Never committed; rebuilt per run.
FROM ${RELAY_FIXTURE_PINS.nodeImage} AS builder

WORKDIR /app

COPY package*.json .npmrc ./
COPY scripts/ ./scripts/
COPY packages/common/package.json ./packages/common/
COPY packages/relay/package.json ./packages/relay/

RUN set -eux; \\
    test "$(node -v)" = '${RELAY_FIXTURE_PINS.nodeVersion}'; \\
    test "$(npm -v)" = '${RELAY_FIXTURE_PINS.npmVersion}'; \\
    npm ci

COPY packages/common/tsconfig.json ./packages/common/
COPY packages/common/src ./packages/common/src
COPY packages/relay/tsconfig.json ./packages/relay/
COPY packages/relay/src ./packages/relay/src

RUN npm run build --workspace=@phase1-native-swaps/common
RUN npm run build --workspace=@phase1-native-swaps/relay
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM ${RELAY_FIXTURE_PINS.nodeImage} AS runtime

WORKDIR /app

RUN addgroup -S relay && adduser -S relay -G relay

COPY --from=builder --chown=relay:relay /app ./
COPY --chown=relay:relay relay-fixture-entrypoint.mjs /app/relay-fixture-entrypoint.mjs

USER relay

# Fail the BUILD, not the first request, if the relay's compiled entrypoints are
# missing — a silent tsc regression would otherwise surface as a boot timeout.
RUN set -eux; \\
    test -f /app/packages/relay/dist/relay-ws.js; \\
    test -f /app/packages/relay/dist/router/index.js; \\
    test -f /app/packages/relay/dist/config.js

CMD ["node", "/app/relay-fixture-entrypoint.mjs"]
`;
}

export interface RelayFixtureComposeOptions {
  image: string;
  httpHostPort: number;
  wsHostPort: number;
}

/**
 * One service, one project-scoped network, no volumes. Ports are published on
 * loopback only and always come from the harness's verified-free reservation
 * above 10000 — this is a shared host.
 */
export function relayFixtureComposeSource({
  image,
  httpHostPort,
  wsHostPort,
}: RelayFixtureComposeOptions): string {
  const readiness = JSON.stringify(
    `fetch('http://127.0.0.1:${RELAY_FIXTURE_PINS.containerHttpPort}/tokens')` +
      `.then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`,
  );
  return `services:
  relay-fixture:
    image: ${image}
    pull_policy: never
    restart: "no"
    init: true
    environment:
      NODE_ENV: production
      LOG_LEVEL: info
      BIND_HOST: 0.0.0.0
      RELAY_PORT: "${RELAY_FIXTURE_PINS.containerHttpPort}"
      RELAY_WS_PORT: "${RELAY_FIXTURE_PINS.containerWsPort}"
      SOLVER_AUTH_TOKEN: \${SOLVER_AUTH_TOKEN:?SOLVER_AUTH_TOKEN must be set}
      RATE_LIMIT_MAX: "0"
      RELAY_PUBLIC_DOCS_ENABLED: "false"
    ports:
      - "127.0.0.1:${httpHostPort}:${RELAY_FIXTURE_PINS.containerHttpPort}"
      - "127.0.0.1:${wsHostPort}:${RELAY_FIXTURE_PINS.containerWsPort}"
    healthcheck:
      test: ["CMD", "node", "-e", ${readiness}]
      interval: 1s
      timeout: 2s
      retries: 60
      start_period: 2s
    networks: [relay_fixture]

networks:
  relay_fixture: {}
`;
}
