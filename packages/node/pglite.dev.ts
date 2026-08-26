// The embedded PGLite database, as a STANDALONE process.
//
// Why this exists: `start.dev.ts` / `start.external.ts` get PGLite from the
// orchestrator's `launchPglite()` helper, which declares it as one of several
// orchestrator-managed processes. A container should not run the orchestrator
// (demo-infra Phase 11: one container, one concern), but the sync node still
// needs its store — PGLite is a real Postgres-wire server the node dials over
// TCP, not an in-process library, so it cannot simply be imported by
// `main.dev.ts`.
//
// So the kernel container runs exactly two processes: this one and
// `main.dev.ts`. This file is what makes that possible without dragging the
// orchestrator in.
//
// It is deliberately a DIRECT call to `startPglite()`, not a spawn: importing
// the same entrypoint the orchestrator uses (`@effectstream/db/start-pglite`
// guards its CLI behind `import.meta.main`, and exports the function) keeps
// this one OS process rather than a wrapper babysitting a child.
//
//   bun run packages/node/pglite.dev.ts [--port 5432]
//
// Port precedence: `--port`, then DB_PORT, then 5432 — matching
// `launchPglite()`, which reads DB_PORT when PGLITE=false points it at an
// external Postgres. Running an external Postgres INSTEAD of this process is
// the documented alternative (set PGLITE=false and point DB_PORT at it); see
// the demo-infra plan's Q-P11.

import { startPglite } from "@effectstream/db/start-pglite";

const argv = process.argv.slice(2);
const portFlagIndex = argv.indexOf("--port");
const rawPort = portFlagIndex !== -1 ? argv[portFlagIndex + 1] : process.env["DB_PORT"] ?? "5432";

const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[pglite] invalid port ${JSON.stringify(rawPort)}`);
  process.exit(1);
}

const handle = await startPglite(port);

// Close the store on a normal container stop so the next start does not have
// to recover a half-written page. `docker stop` sends SIGTERM, waits, then
// SIGKILL — this makes the graceful path the usual one.
let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  console.info(`[pglite] ${signal} — closing the store`);
  void handle
    .close()
    .catch((error: unknown) => {
      console.error("[pglite] close failed", error);
    })
    .finally(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
