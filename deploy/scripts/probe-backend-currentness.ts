// probe-backend-currentness.ts — why is POST /v1/offers/files answering 503?
//
// That route is the read the solver makes at job time to rebuild a maker's
// exact bytes, and a refusal there kills every dispatched swap with
// `exact_files_unavailable`. But the route funnels every
// `OfferValidationUnavailableError` into one opaque public reason ("the
// exact-files read could not establish current backend state"), which is right
// for a public API and useless for a diagnosis.
//
// This runs the kernel's OWN currentness code against the kernel's OWN database
// and prints each input, so the answer is a measurement rather than a guess.
// The thing to watch is `cel(lag=…)` against `MAX_CELESTIA_LAG_BLOCKS = 4`:
// `/v1/health/sync` serves a CACHED status whose external tips are up to 60 s
// old and can read "ok" while the fresh recompute the read actually uses reads
// "syncing".
//
//   docker compose exec -T kernel bun run deploy/scripts/probe-backend-currentness.ts
//
// Env: SAMPLES (default 12), INTERVAL_MS (default 2500).

import { createRequire } from "node:module";

// `pg` is a dependency of packages/database, not of the workspace root, and
// `deploy/` is not a workspace member — so a bare specifier does not resolve
// from this file. Resolve it from the package that declares it, the same shape
// of fix the pglite entrypoint needed at D1.
const require = createRequire("/app/packages/database/package.json");
const { Client } = require("pg") as { Client: new (config: unknown) => any };

const { getLatestEffectstreamBlock } = await import("../../packages/database/mod.ts");
const { getFreshSyncStatus, getSyncStatus } = await import("../../packages/node/sync-health.ts");
const { requireCurrentBackend, validationStateAnchorFromRow } = await import(
  "../../packages/node/offer-validation.ts"
);

const SAMPLES = Number(process.env["SAMPLES"] ?? "12");
const INTERVAL_MS = Number(process.env["INTERVAL_MS"] ?? "2500");

const client = new Client({
  host: process.env["DB_HOST"] ?? "127.0.0.1",
  port: Number(process.env["DB_PORT"] ?? "5432"),
  database: process.env["DB_NAME"] ?? "postgres",
  user: process.env["DB_USER"] ?? "postgres",
  password: process.env["DB_PW"] ?? "postgres",
});
await client.connect();

const show = (label: string, value: unknown) =>
  console.log(
    `${label}: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`,
  );

try {
  const row = (await getLatestEffectstreamBlock.run(undefined, client as never))[0];
  show("latest effectstream block row", row);
  try {
    show("state anchor", validationStateAnchorFromRow(row as never));
  } catch (err) {
    show("state anchor THREW", String(err));
  }

  let ok = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const cached: any = await getSyncStatus(client as never);
    const fresh: any = await getFreshSyncStatus(client as never);
    const anchor: any = (await getLatestEffectstreamBlock.run(undefined, client as never))[0];
    let currentness = "ok";
    try {
      await requireCurrentBackend(client as never);
      ok++;
    } catch (err) {
      currentness = String((err as Error)?.message ?? err);
    }
    console.log(
      `i=${i} cachedStatus=${cached.status} freshStatus=${fresh.status} ` +
        `cachedH=${cached.blockL2?.height} anchorH=${anchor?.block_height} ` +
        `ntp(lag_s=${fresh.ntp?.lag_seconds}) ` +
        `mid(lag=${(fresh.midnight?.tip ?? 0) - (fresh.midnight?.current ?? 0)}) ` +
        `cel(cur=${fresh.celestia?.current} tip=${fresh.celestia?.tip} ` +
        `lag=${(fresh.celestia?.tip ?? 0) - (fresh.celestia?.current ?? 0)}) ` +
        `requireCurrentBackend=${currentness}`,
    );
    if (i + 1 < SAMPLES) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log(`requireCurrentBackend succeeded on ${ok}/${SAMPLES} samples`);
} finally {
  await client.end();
}
