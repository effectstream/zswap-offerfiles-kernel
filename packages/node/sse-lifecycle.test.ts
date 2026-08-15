import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "../database/test-pglite.ts";

process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
process.env["POST_COMMIT_EVENT_BRIDGE_ENABLED"] = "false";
process.env["API_SSE_MAX_CONNECTIONS"] = "1";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter, writeSseChunk } = await import("./api.ts");
const { eventBus } = await import("./event-bus.ts");

const PGLITE_PORT = 54357;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;
let server: any;
let apiPort: number | null = null;

beforeAll(async () => {
  handle = await startPglite(PGLITE_PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PGLITE_PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);
  server = fastify();
  await apiRouter(server, client);
  await server.ready();
});

afterAll(async () => {
  try {
    await server?.close();
  } finally {
    await closeTestPglite(handle, client);
  }
});

async function listenOnRandomHighPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = 10_000 + Math.floor(Math.random() * 40_000);
    try {
      await server.listen({ host: "127.0.0.1", port: candidate });
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("could not allocate a random test port >= 10000");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("SSE disconnect and server pre-close release every route/listener lifecycle", async () => {
  apiPort = await listenOnRandomHighPort();
  const baselineListeners = eventBus.listenerCount("app_event");
  const abort = new AbortController();
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/offers/stream`, {
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"type":"connected"');
  await waitFor(() => eventBus.listenerCount("app_event") === baselineListeners + 1);

  const excess = await fetch(`http://127.0.0.1:${apiPort}/v1/offers/stream`);
  expect(excess.status).toBe(503);
  expect(excess.headers.get("retry-after")).toBe("5");
  expect((await excess.json()).error).toBe("SSE_CAPACITY");

  abort.abort();
  await waitFor(() => eventBus.listenerCount("app_event") === baselineListeners);

  // Leave a second stream active. Fastify preClose must destroy it before
  // waiting for route completion, otherwise server.close() and bridge cleanup
  // deadlock behind the persistent handler.
  const activeAtShutdown = await fetch(`http://127.0.0.1:${apiPort}/v1/offers/stream`);
  expect(activeAtShutdown.status).toBe(200);
  const shutdownReader = activeAtShutdown.body!.getReader();
  expect(new TextDecoder().decode((await shutdownReader.read()).value)).toContain(
    '"type":"connected"',
  );
  await waitFor(() => eventBus.listenerCount("app_event") === baselineListeners + 1);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    server.close().then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  expect(closed).toBe(true);
  // onClose restores router-owned listeners and the process-global warning
  // threshold; the test's baseline includes that internal onAppEvent listener.
  await waitFor(() => eventBus.listenerCount("app_event") === baselineListeners - 1);
  expect(eventBus.getMaxListeners()).toBe(50);
  server = null;
});

test("SSE writer destroys a slow client as soon as write applies backpressure", () => {
  let cleanups = 0;
  let destroys = 0;
  const raw = {
    destroyed: false,
    writableEnded: false,
    write: () => false,
    destroy: () => { destroys += 1; },
  };
  expect(writeSseChunk(raw, "data: {}\n\n", () => { cleanups += 1; })).toBe(false);
  expect(destroys).toBe(1);
  expect(cleanups).toBe(1);
});
