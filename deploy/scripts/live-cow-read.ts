import { readFileSync, writeFileSync } from "node:fs";

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { buildWallet, shieldedBalances, waitForSync } from "../../packages/solver-core/wallet.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

type AmountMap = Record<string, string>;
type Scenario = {
  version: 1;
  id: string;
  solverSeed: string;
  actors: Array<{ name: string; kind: "maker" | "taker"; seed: string }>;
  expectedSolverInitial?: AmountMap;
};
type Assets = { status: string; tokenIds: Record<string, string> };
type Result = {
  status: string;
  scenarioId: string;
  refusalOnly?: boolean;
  expectedActorsAfter?: Record<string, AmountMap>;
  expectedSolverAfter?: AmountMap;
};

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const scenarioFile = required("COW_LIVE_SCENARIO_FILE");
const assetsFile = required("COW_LIVE_ASSETS_FILE");
const evidenceDir = required("COW_LIVE_EVIDENCE_DIR");
const outFile = process.env.COW_LIVE_FRESH_READ_OUT ?? `${evidenceDir}/actors-after-fresh.json`;
const scenario = JSON.parse(readFileSync(scenarioFile, "utf8")) as Scenario;
const assets = JSON.parse(readFileSync(assetsFile, "utf8")) as Assets;
const result = JSON.parse(readFileSync(`${evidenceDir}/99-live-result.json`, "utf8")) as Result;
if (scenario.version !== 1 || result.status !== "PASS" || result.scenarioId !== scenario.id || assets.status !== "PASS") {
  throw new Error("scenario/assets/result identity or status mismatch");
}

let expectedActors = result.expectedActorsAfter;
if (result.refusalOnly) {
  const before = JSON.parse(readFileSync(`${evidenceDir}/01b-chain-balances-before-offers.json`, "utf8")) as {
    actors: Record<string, AmountMap>;
  };
  expectedActors = before.actors;
}
if (!expectedActors) throw new Error("result has no expected actor balances");
const expectedSolver = result.expectedSolverAfter ?? scenario.expectedSolverInitial ?? {};

const actorRows: Record<string, unknown> = {};
const checks: Array<{ actor: string; symbol: string; expected: string; actual: string; ok: boolean }> = [];

async function readActor(name: string, seed: string, expected: AmountMap, requireNoUnlisted: boolean): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error(`${name} seed is invalid`);
  const wallet = await buildWallet(seed);
  try {
    await waitForSync(wallet, { timeoutMs: 300_000 });
    const held = await shieldedBalances(wallet);
    const selected = Object.fromEntries(Object.entries(assets.tokenIds).map(([symbol, color]) => [symbol, String(held[color] ?? 0n)]));
    for (const symbol of Object.keys(assets.tokenIds)) {
      const want = String(expected[symbol] ?? "0");
      const actual = selected[symbol]!;
      checks.push({ actor: name, symbol, expected: want, actual, ok: actual === want });
    }
    const knownColors = new Set(Object.values(assets.tokenIds));
    const unlisted = Object.entries(held)
      .filter(([color, amount]) => !knownColors.has(color) && amount !== 0n)
      .map(([color, amount]) => ({ color, amount: amount.toString() }));
    if (requireNoUnlisted) checks.push({
      actor: name,
      symbol: "(no-unlisted-shielded-assets)",
      expected: "none",
      actual: unlisted.length === 0 ? "none" : JSON.stringify(unlisted),
      ok: unlisted.length === 0,
    });
    actorRows[name] = {
      seedSuffix: seed.slice(-4),
      selectedAssets: selected,
      allShielded: Object.fromEntries(Object.entries(held).map(([color, amount]) => [color, amount.toString()])),
      unlistedNonZero: unlisted,
    };
  } finally {
    await wallet.wallet.stop?.().catch(() => {});
  }
}

for (const actor of scenario.actors) {
  const expected = expectedActors[actor.name];
  if (!expected) throw new Error(`no expected post-case balance for ${actor.name}`);
  await readActor(actor.name, actor.seed, expected, true);
}
await readActor("solver", scenario.solverSeed, expectedSolver, true);

const report = {
  status: checks.every((check) => check.ok) ? "PASS" : "FAIL",
  measuredAt: new Date().toISOString(),
  measurement: "fresh synchronized wallet facades after offer-building facades and solver service stopped",
  network: net.id,
  scenarioId: scenario.id,
  assets: assets.tokenIds,
  actors: actorRows,
  checks,
};
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exit(1);
