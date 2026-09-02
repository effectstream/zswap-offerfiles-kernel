/**
 * N6/EN2 external solver process.
 *
 * This process deliberately receives only the backend read API and the pinned
 * relay websocket. It runs the production pull-only book mirror and relay
 * client unchanged, then seals evidence after the directly published offer is
 * observed in the mirror and a subsequent complete ladder push succeeds.
 */

import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { startBookSync, type BackendCurrentnessState } from "../../../solver/src/book-sync.ts";
import { deriveLadderPush } from "../../../solver/src/ladder-source.ts";
import { startRelayClient, type RelayClientEvent } from "../../../solver/src/relay-client.ts";

function required(name: string): string {
  const value = process.env[name];
  assert(value && !/[\r\n]/.test(value), `${name} is required and must be one line`);
  return value;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function sealJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const runId = required("EN2_RUN_ID");
  const api = required("EN2_API");
  const relayWsUrl = required("EN2_RELAY_WS_URL");
  const authToken = required("EN2_RELAY_AUTH_TOKEN");
  const targetOfferHash = required("EN2_TARGET_OFFER_HASH");
  const resultPath = required("EN2_RESULT_PATH");
  assert(/^https?:\/\//.test(api), "EN2_API must be HTTP(S)");
  assert(/^wss?:\/\//.test(relayWsUrl), "EN2_RELAY_WS_URL must be WS(S)");
  assert(authToken.length >= 32, "EN2_RELAY_AUTH_TOKEN must be at least 32 characters");
  assert(/^[0-9a-f]{64}$/.test(targetOfferHash), "EN2_TARGET_OFFER_HASH must be canonical");
  assert(resultPath.startsWith("/"), "EN2_RESULT_PATH must be absolute");

  const forbiddenEnvironmentKeys = Object.keys(process.env).filter((key) =>
    /^(?:CELESTIA|BATCHER)(?:_|$)/.test(key),
  );
  assert.deepEqual(forbiddenEnvironmentKeys, [], "solver received a Celestia/batcher environment variable");

  const expiryMarginSeconds = positive("SOLVER_EXPIRY_MARGIN_SECONDS", 30);
  const events: RelayClientEvent[] = [];
  const currentness: BackendCurrentnessState[] = [];
  let targetChangeCount = 0;
  let targetSeenAtMs: number | null = null;
  let initialReadyAtMs: number | null = null;

  const sync = startBookSync({
    api,
    expiryMarginSeconds,
    resyncIntervalMs: positive("SOLVER_RESYNC_INTERVAL_MS", 2_000),
    readinessTimeoutMs: 300_000,
    backendHealthCheckIntervalMs: positive("SOLVER_BACKEND_HEALTH_CHECK_INTERVAL_MS", 500),
    backendHealthMaxAgeMs: positive("SOLVER_BACKEND_HEALTH_MAX_AGE_MS", 5_000),
    backendHealthRequestTimeoutMs: 2_000,
    onChange(change) {
      if (change.kind === "added" && change.offer.offerHash === targetOfferHash) {
        targetChangeCount += 1;
        targetSeenAtMs ??= Date.now();
      }
    },
    onCurrentnessChange(state) {
      currentness.push(state);
    },
    log(message) {
      console.log(`[en2:mirror] ${message}`);
    },
  });
  const relay = startRelayClient({
    url: relayWsUrl,
    authToken,
    cache: sync,
    ladder: { expiryMarginSeconds, maxParallelSwaps: 8 },
    pushIntervalMs: positive("SOLVER_RELAY_PUSH_INTERVAL_MS", 500),
    reconnectDelayMs: 500,
    connectTimeoutMs: 10_000,
    onEvent(event) {
      events.push(event);
      console.log(`[en2:relay] ${event.kind}: ${event.message}`);
    },
  });

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await sync.ready;
    initialReadyAtMs = Date.now();
    const initialBookSize = sync.book.size;
    const initialPushes = relay.stats().pushes;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const target = sync.book.get(targetOfferHash);
      const push = deriveLadderPush(sync, {
        nowMs: Date.now(),
        expiryMarginSeconds,
        maxParallelSwaps: 8,
      });
      if (
        target &&
        sync.isCurrent() &&
        push.withheld === null &&
        push.derived.provenance.some((entry) =>
          entry.rungs.some((rung) => rung.offerHash === targetOfferHash)
        ) &&
        relay.stats().pushes > initialPushes
      ) {
        await relay.push();
        const finalStats = relay.stats();
        assert(finalStats.connected, "relay disconnected before EN2 evidence seal");
        await sealJson(resultPath, {
          schema: "zswap-en2-result-v1",
          runId,
          api,
          relayHost: new URL(relayWsUrl).hostname,
          targetOfferHash,
          forbiddenEnvironmentKeys,
          initialReadyAtMs,
          initialBookSize,
          targetSeenAtMs,
          targetChangeCount,
          currentness,
          relayEvents: events,
          relayStats: finalStats,
          derived: push.derived,
          capabilities: push.capabilities,
          priceLevels: push.priceLevels,
          sealedAtMs: Date.now(),
        });
        console.log(`[en2] sealed ${resultPath}`);
        while (!stopping) await sleep(250);
        return;
      }
      await sleep(100);
    }
    throw new Error("timed out waiting for the direct Celestia publication to reach the relay ladder");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await relay.stop();
    await sync.stop();
  }
}

await main();
