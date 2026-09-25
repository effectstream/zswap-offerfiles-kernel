import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  waitForSync,
} from "../../packages/solver-core/wallet.ts";
import {
  canonicalRelayExtrinsicHash,
  getOfferConsumptionEvidence,
} from "../../packages/solver-core/receipt-client.ts";
import { KernelApi } from "./lib/kernel-api.ts";
import { postMakerOffer, type PostedOffer } from "./lib/maker-offer.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

type AmountMap = Record<string, string>;
type OfferSpec = {
  name: string;
  maker: string;
  giveAsset: string;
  giveAmount: string;
  wantAsset: string;
  wantAmount: string;
  phase?: "initial" | "after-refusal";
};
type QuoteSpec = {
  label: string;
  tokenInAsset: string;
  tokenOutAsset: string;
  amountIn: string;
  expectedOut: string;
};
type RefusalSpec =
  | {
      kind: "quote-unavailable";
      label: string;
      tokenInAsset: string;
      tokenOutAsset: string;
      amountIn: string;
      samples?: number;
      intervalMs?: number;
      liveControl: QuoteSpec;
    }
  | {
      kind: "demand-above-quote";
      label: string;
      taker: string;
      tokenInAsset: string;
      tokenOutAsset: string;
      amountIn: string;
      demandOut: string;
      expectedQuoteOut: string;
      probes?: number;
    };
type SettlementSpec = {
  taker: string;
  tokenInAsset: string;
  tokenOutAsset: string;
  amountIn: string;
  demandOut: string;
  expectedQuoteOut: string;
  selectedOffers: string[];
  expectedSolverReceipts: AmountMap;
};
type ContentionLeg = {
  label: string;
  taker: string;
  tokenInAsset: string;
  tokenOutAsset: string;
  amountIn: string;
  demandOut: string;
  expectedQuoteOut: string;
  selectedOffers: string[];
  expectedSolverReceipts: AmountMap;
};
type ContentionSpec = {
  requiredCapacity: number;
  sharedOffer: string;
  legs: [ContentionLeg, ContentionLeg];
};
type Scenario = {
  version: 1;
  id: string;
  solverSeed: string;
  actors: Array<{ name: string; kind: "maker" | "taker"; seed: string }>;
  offers: OfferSpec[];
  preflightQuotes?: QuoteSpec[];
  refusal?: RefusalSpec;
  settlement?: SettlementSpec;
  contention?: ContentionSpec;
  openingBook?: "empty" | "allow-existing";
  expectedSolverInitial?: AmountMap;
};
type Assets = { status: string; tokenIds: Record<string, string> };
type RelayQuote = { type: string; tokenOut: string; amountOut: string; quoteId: string };

const API = new KernelApi(process.env.ZSWAP_API ?? "http://kernel:9999");
const RELAY = (process.env.RELAY_HTTP_URL ?? "http://relay:3000").replace(/\/$/, "");
const SOLVER_STATUS = (process.env.SOLVER_STATUS_URL ?? "http://solver:9100").replace(/\/$/, "");
const SOLVER_STATUS_AUTH = process.env.SOLVER_STATUS_AUTH_TOKEN ?? "";
const SCENARIO_FILE = requiredPath("COW_LIVE_SCENARIO_FILE");
const ASSETS_FILE = requiredPath("COW_LIVE_ASSETS_FILE");
const OUT = requiredPath("COW_LIVE_EVIDENCE_DIR");
const PROVISION_RECEIPT = requiredPath("SOLVER_PROVISION_RECEIPT");
const JOURNAL = process.env.SOLVER_JOURNAL_PATH ?? "/var/lib/cow-solver/operations.sqlite";
const SOURCE_COMMIT = requiredValue("COW_SOURCE_COMMIT");
const SOURCE_TREE = requiredValue("COW_SOURCE_TREE");
const SOURCE_IMAGE = requiredValue("COW_SOURCE_IMAGE");
const RELAY_COMMIT = requiredValue("COW_RELAY_COMMIT");
const RELAY_IMAGE = requiredValue("COW_RELAY_IMAGE");
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requiredValue(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPath(name: string): string {
  return requiredValue(name);
}

function parseAmount(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical nonnegative integer string`);
  return BigInt(value);
}

function validateSeed(seed: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error(`${label} must be 64 lowercase hex characters`);
  return seed;
}

function validateScenario(value: Scenario): Scenario {
  if (value.version !== 1 || !/^[a-z0-9][a-z0-9-]+$/.test(value.id)) throw new Error("scenario version/id is invalid");
  validateSeed(value.solverSeed, "solverSeed");
  const names = value.actors.map((actor) => actor.name);
  if (new Set(names).size !== names.length) throw new Error("actor names must be unique");
  value.actors.forEach((actor) => validateSeed(actor.seed, `actor ${actor.name} seed`));
  if (value.offers.length === 0 || new Set(value.offers.map((offer) => offer.name)).size !== value.offers.length) {
    throw new Error("offers must be nonempty and have unique names");
  }
  for (const offer of value.offers) {
    if (!names.includes(offer.maker)) throw new Error(`offer ${offer.name} references unknown maker ${offer.maker}`);
    if (offer.giveAsset === offer.wantAsset) throw new Error(`offer ${offer.name} has identical assets`);
    if (parseAmount(offer.giveAmount, `${offer.name}.giveAmount`) <= 0n || parseAmount(offer.wantAmount, `${offer.name}.wantAmount`) <= 0n) {
      throw new Error(`offer ${offer.name} amounts must be positive`);
    }
  }
  if (value.settlement) {
    if (!names.includes(value.settlement.taker)) throw new Error(`settlement references unknown taker ${value.settlement.taker}`);
    if (new Set(value.settlement.selectedOffers).size !== value.settlement.selectedOffers.length) throw new Error("selectedOffers contains duplicates");
    for (const name of value.settlement.selectedOffers) {
      if (!value.offers.some((offer) => offer.name === name)) throw new Error(`settlement selects unknown offer ${name}`);
    }
  }
  if (value.settlement && value.contention) throw new Error("scenario cannot define both settlement and contention");
  if (value.contention) {
    if (!Number.isInteger(value.contention.requiredCapacity) || value.contention.requiredCapacity < 2) {
      throw new Error("contention.requiredCapacity must be an integer >=2");
    }
    if (!value.offers.some((offer) => offer.name === value.contention!.sharedOffer)) {
      throw new Error(`contention sharedOffer ${value.contention.sharedOffer} does not exist`);
    }
    for (const leg of value.contention.legs) {
      if (!names.includes(leg.taker)) throw new Error(`contention leg ${leg.label} references unknown taker ${leg.taker}`);
      if (!leg.selectedOffers.includes(value.contention.sharedOffer)) throw new Error(`contention leg ${leg.label} does not require the shared offer`);
      for (const name of leg.selectedOffers) {
        if (!value.offers.some((offer) => offer.name === name)) throw new Error(`contention leg ${leg.label} selects unknown offer ${name}`);
      }
    }
  }
  return value;
}

const scenario = validateScenario(JSON.parse(readFileSync(SCENARIO_FILE, "utf8")) as Scenario);
const assets = JSON.parse(readFileSync(ASSETS_FILE, "utf8")) as Assets;
if (assets.status !== "PASS") throw new Error(`asset receipt is not PASS: ${ASSETS_FILE}`);
for (const [symbol, color] of Object.entries(assets.tokenIds)) {
  if (!/^[0-9a-f]{64}$/.test(color)) throw new Error(`asset ${symbol} has invalid color ${color}`);
}
if (new Set(Object.values(assets.tokenIds)).size !== Object.keys(assets.tokenIds).length) throw new Error("asset colors must be distinct");

function token(symbol: string): string {
  const color = assets.tokenIds[symbol];
  if (!color) throw new Error(`scenario references unknown asset ${symbol}`);
  return color;
}

mkdirSync(OUT, { recursive: true });
const transcript: string[] = [];
function log(message: string): void {
  const line = `[live-cow-case] ${new Date().toISOString()} ${message}`;
  transcript.push(line);
  console.log(line);
  writeFileSync(`${OUT}/driver-transcript.log`, `${transcript.join("\n")}\n`);
}
function record(name: string, value: unknown): void {
  writeFileSync(`${OUT}/${name}.json`, `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`);
}
function must(ok: unknown, message: string, detail?: unknown): asserts ok {
  if (!ok) {
    const suffix = detail === undefined ? "" : `: ${JSON.stringify(detail, (_key, item) => typeof item === "bigint" ? item.toString() : item)}`;
    log(`FAIL ${message}${suffix}`);
    throw new Error(`${message}${suffix}`);
  }
  log(`PASS ${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

type Balances = Record<string, bigint>;
function selectBalances(held: Record<string, bigint>): Balances {
  return Object.fromEntries(Object.entries(assets.tokenIds).map(([symbol, color]) => [symbol, held[color] ?? 0n]));
}
function balanceStrings(value: Balances): AmountMap {
  return Object.fromEntries(Object.entries(value).map(([symbol, amount]) => [symbol, amount.toString()]));
}
function addDelta(target: Balances, symbol: string, delta: bigint): void {
  target[symbol] = (target[symbol] ?? 0n) + delta;
}
function expectedAfter(before: Balances, deltas: Balances): Balances {
  const result = { ...before };
  for (const [symbol, delta] of Object.entries(deltas)) addDelta(result, symbol, delta);
  return result;
}

const quoteSamples: Array<{ measuredAt: string; label: string; status: number; body: unknown }> = [];
async function quoteOnce(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ status: number; body: any }> {
  const response = await fetch(`${RELAY}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn, tokenOut, amountIn: amountIn.toString() }),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body };
}
async function quoteExpected(spec: QuoteSpec, timeoutMs = 600_000): Promise<RelayQuote> {
  const tokenIn = token(spec.tokenInAsset);
  const tokenOut = token(spec.tokenOutAsset);
  const amountIn = parseAmount(spec.amountIn, `${spec.label}.amountIn`);
  const expectedOut = parseAmount(spec.expectedOut, `${spec.label}.expectedOut`);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last: unknown;
  while (Date.now() < deadline) {
    attempts++;
    const result = await quoteOnce(tokenIn, tokenOut, amountIn);
    last = result;
    quoteSamples.push({ measuredAt: new Date().toISOString(), label: spec.label, status: result.status, body: result.body });
    record("quote-publication-samples", quoteSamples);
    if (result.status === 200 && BigInt(result.body.amountOut) === expectedOut) {
      log(`${spec.label}: live quote ${amountIn} -> ${expectedOut} after ${attempts} sample(s)`);
      return result.body as RelayQuote;
    }
    if (attempts % 6 === 1 || result.status === 200) log(`${spec.label}: observed ${result.status} ${JSON.stringify(result.body)}`);
    await sleep(5_000);
  }
  throw new Error(`${spec.label}: expected quote timed out: ${JSON.stringify(last)}`);
}

async function buildHalf(taker: any, tokenIn: string, tokenOut: string, amountIn: bigint, demandOut: bigint) {
  const receiverAddress = await taker.wallet.shielded.getAddress();
  const recipe = await taker.wallet.initSwap(
    { shielded: { [tokenIn]: amountIn } },
    [{ type: "shielded", outputs: [{ type: tokenOut, amount: demandOut, receiverAddress }] } as never],
    shieldedKeys(taker),
    { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
  );
  const finalized = await taker.wallet.finalizeTransaction(recipe.transaction);
  return { recipe, bytes: finalized.serialize() as Uint8Array };
}
async function postIntent(bytes: Uint8Array, quoteId: string): Promise<{ status: number; body: any; jobId?: string }> {
  const url = new URL(`${RELAY}/intent`);
  url.searchParams.set("quoteId", quoteId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes as BodyInit,
  });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, ...(body?.jobId ? { jobId: String(body.jobId) } : {}) };
}
async function pollJob(jobId: string): Promise<{ status: string; txId?: string; reason?: string; trail: string[] }> {
  const deadline = Date.now() + 600_000;
  const trail: string[] = [];
  let previous = "";
  while (Date.now() < deadline) {
    await sleep(2_000);
    const response = await fetch(`${RELAY}/jobs/${jobId}`).catch(() => null);
    if (!response || response.status !== 200) continue;
    const body = await response.json() as { status: string; txId?: string; reason?: string };
    if (body.status !== previous) {
      previous = body.status;
      trail.push(body.status);
      log(`job ${jobId} -> ${body.status}${body.txId ? ` txId=${body.txId}` : ""}`);
    }
    if (body.status === "done" || body.status === "error") return { ...body, trail };
  }
  return { status: "timeout", trail };
}

async function statusSnapshot(): Promise<any> {
  const response = await fetch(`${SOLVER_STATUS}/status/snapshot`, {
    headers: SOLVER_STATUS_AUTH ? { authorization: `Bearer ${SOLVER_STATUS_AUTH}` } : {},
  });
  if (!response.ok) throw new Error(`solver status snapshot failed: ${response.status} ${await response.text()}`);
  return await response.json();
}

function readJournal(jobId: string): { rows: any[]; dust: any[] } {
  must(existsSync(JOURNAL), "solver journal exists", JOURNAL);
  const db = new Database(JOURNAL, { readonly: true });
  try {
    // A read transaction is one coherent WAL snapshot. Copying the database,
    // WAL and SHM files independently while the solver writes can mix states.
    db.exec("BEGIN");
    const rows = db.query(`
      SELECT o.operation_kind,o.lifecycle_state,o.job_id,o.offer_hashes_json,
             o.claim_inputs_json,o.claim_payouts_json,o.error_code,o.error_detail,
             r.relay_job_id,r.relay_state,r.relay_extrinsic_hash,
             r.ledger_tx_hash,r.ledger_height
        FROM journal_operations o
        LEFT JOIN journal_receipts r ON r.operation_id=o.id
       WHERE o.job_id=? ORDER BY o.id
    `).all(jobId) as any[];
    const dust = db.query(`SELECT job_id,amount_text,state,spent_at_ms FROM journal_dust_reservations WHERE job_id=? ORDER BY rowid`).all(jobId) as any[];
    return { rows, dust };
  } finally {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
  }
}
async function waitForTerminalJournal(jobId: string): Promise<{ rows: any[]; dust: any[] }> {
  const terminal = new Set(["SETTLED", "REVERTED", "FAILED"]);
  const deadline = Date.now() + 300_000;
  let result = readJournal(jobId);
  while (Date.now() < deadline && (result.rows.length === 0 || result.rows.some((row) => !terminal.has(row.lifecycle_state)))) {
    await sleep(5_000);
    result = readJournal(jobId);
  }
  return result;
}

const TERMINAL_JOURNAL_STATES = new Set(["SETTLED", "REVERTED", "FAILED"]);

function parseObjectJson(value: unknown, label: string): Record<string, unknown> {
  must(typeof value === "string", `${label} is serialized JSON`, value);
  const parsed = JSON.parse(value);
  must(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), `${label} is a JSON object`, parsed);
  return parsed as Record<string, unknown>;
}

async function waitForNoActiveClaims(jobId: string): Promise<any> {
  const deadline = Date.now() + 300_000;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await statusSnapshot();
    const stats = last?.executor?.stats;
    const unavailable = Array.isArray(last?.executor?.unavailableOfferHashes)
      ? last.executor.unavailableOfferHashes
      : null;
    const counts = last?.journal?.countsByState;
    const activeJournalRows = counts && typeof counts === "object"
      ? Object.entries(counts).reduce((total, [state, count]) =>
        total + (TERMINAL_JOURNAL_STATES.has(state) ? 0 : Number(count ?? 0)), 0)
      : Number.NaN;
    const activeExecutor = stats == null
      ? Number.NaN
      : Number(stats.building ?? 0) + Number(stats.quarantined ?? 0) +
        Number(stats.awaitingRelay ?? 0) + Number(stats.awaitingConsumption ?? 0);
    const reservedDust = Number(last?.journal?.dust?.reservations?.reserved ?? Number.NaN);
    if (activeExecutor === 0 && activeJournalRows === 0 && reservedDust === 0 && unavailable?.length === 0) {
      record("terminal-status", last);
      log(`terminal state released every claim and DUST hold for ${jobId}`);
      return last;
    }
    await sleep(2_000);
  }
  record("terminal-status-timeout", last);
  must(false, `terminal state retains no active claim, journal operation or DUST hold for ${jobId}`, last);
}

async function assertSettlementAuthorities(
  jobId: string,
  relayTxId: string,
  expectedOfferIds: string[],
  journal: { rows: any[]; dust: any[] },
): Promise<Record<string, unknown>> {
  const settlementRows = journal.rows.filter((row) => row.operation_kind === "JOB_SETTLEMENT");
  must(settlementRows.length === 1 && settlementRows[0]!.lifecycle_state === "SETTLED", "one terminal SETTLED job row exists", settlementRows);
  must(journal.rows.every((row) => Object.keys(parseObjectJson(row.claim_payouts_json, "claim_payouts_json")).length === 0),
    "all new whole-offer journal claim_payouts are empty", journal.rows.map((row) => row.claim_payouts_json));

  const row = settlementRows[0]!;
  const canonicalRelayTx = canonicalRelayExtrinsicHash(relayTxId);
  must(canonicalRelayTx !== null, "relay terminal txId is canonical", relayTxId);
  must(row.relay_job_id === jobId && row.relay_state === "done" && row.relay_extrinsic_hash === canonicalRelayTx,
    "journal receipt is bound to the relay job and extrinsic", {
      jobId,
      relayTxId: canonicalRelayTx,
      journal: { relayJobId: row.relay_job_id, relayState: row.relay_state, relayExtrinsicHash: row.relay_extrinsic_hash },
    });
  must(typeof row.ledger_tx_hash === "string" && /^[0-9a-f]{64}$/.test(row.ledger_tx_hash), "journal has a canonical ledger transaction hash", row.ledger_tx_hash);
  must(Number.isSafeInteger(row.ledger_height) && row.ledger_height >= 0, "journal has a canonical ledger height", row.ledger_height);

  const sortedExpected = [...expectedOfferIds].sort();
  const journalOfferIds = [...new Set(settlementRows.flatMap((entry) => {
    try { return JSON.parse(entry.offer_hashes_json) as string[]; } catch { return []; }
  }))].sort();
  must(JSON.stringify(journalOfferIds) === JSON.stringify(sortedExpected), "journal records exactly the selected physical offer IDs", {
    expectedOfferIds: sortedExpected,
    journalOfferIds,
  });

  const backend = [];
  for (const offerId of sortedExpected) {
    const evidence = await getOfferConsumptionEvidence(offerId, { baseUrl: API.base, timeoutMs: 15_000 });
    must(evidence.status === "consumed" && evidence.evidence !== undefined, `backend has ledger-bound consumption evidence for ${offerId}`, evidence);
    backend.push(evidence);
  }
  must(backend.every((entry) => entry.evidence!.ledgerTxHash === row.ledger_tx_hash && entry.evidence!.height === row.ledger_height),
    "all consumed files share the journal's backend ledger transaction and height", backend);

  must(journal.dust.length === 1, "one DUST fee record belongs to the settled job", journal.dust);
  const dust = journal.dust[0]!;
  must(dust.state === "SPENT" && BigInt(dust.amount_text) > 0n && Number.isSafeInteger(dust.spent_at_ms) && dust.spent_at_ms > 0,
    "terminal DUST fee is SPENT with a positive actual transaction contribution", dust);

  const terminalStatus = await waitForNoActiveClaims(jobId);
  return {
    relay: { jobId, extrinsicHash: canonicalRelayTx },
    backend: { ledgerTxHash: row.ledger_tx_hash, height: row.ledger_height, offers: backend },
    journalOperation: row,
    dustFee: {
      amount: dust.amount_text,
      state: dust.state,
      spentAtMs: dust.spent_at_ms,
      measurement: "DUST imbalance of the actual dust-balanced transaction persisted by the solver",
    },
    terminal: {
      executor: terminalStatus.executor,
      journal: terminalStatus.journal,
    },
  };
}

function expectedReceiptCheck(settlement: SettlementSpec): AmountMap {
  const net: Balances = Object.fromEntries(Object.keys(assets.tokenIds).map((symbol) => [symbol, 0n]));
  const selected = new Set(settlement.selectedOffers);
  for (const offer of scenario.offers.filter((candidate) => selected.has(candidate.name))) {
    addDelta(net, offer.giveAsset, parseAmount(offer.giveAmount, `${offer.name}.giveAmount`));
    addDelta(net, offer.wantAsset, -parseAmount(offer.wantAmount, `${offer.name}.wantAmount`));
  }
  addDelta(net, settlement.tokenInAsset, parseAmount(settlement.amountIn, "settlement.amountIn"));
  addDelta(net, settlement.tokenOutAsset, -parseAmount(settlement.demandOut, "settlement.demandOut"));
  must(Object.values(net).every((amount) => amount >= 0n), "scenario settlement has no token deficit", balanceStrings(net));
  const expected = Object.fromEntries(Object.entries(settlement.expectedSolverReceipts).map(([symbol, amount]) => [symbol, parseAmount(amount, `expectedSolverReceipts.${symbol}`)]));
  for (const symbol of Object.keys(assets.tokenIds)) {
    must((net[symbol] ?? 0n) === (expected[symbol] ?? 0n), `scenario receipt matches conservation for ${symbol}`, {
      calculated: (net[symbol] ?? 0n).toString(),
      expected: (expected[symbol] ?? 0n).toString(),
    });
  }
  return balanceStrings(net);
}

const provision = JSON.parse(readFileSync(PROVISION_RECEIPT, "utf8")) as any;
const expectedInitialBySymbol = Object.fromEntries(
  Object.keys(assets.tokenIds).map((symbol) => [
    symbol,
    parseAmount(scenario.expectedSolverInitial?.[symbol] ?? "0", `expectedSolverInitial.${symbol}`),
  ]),
);
const expectedInitial = Object.fromEntries(Object.entries(expectedInitialBySymbol).map(([symbol, amount]) => [token(symbol), amount]));
const provisionShielded = Object.fromEntries(Object.entries(provision.solverShielded ?? {}).map(([color, amount]) => [color, BigInt(String(amount))]));
for (const color of Object.values(assets.tokenIds)) {
  must((provisionShielded[color] ?? 0n) === (expectedInitial[color] ?? 0n), `solver initial ${color.slice(0, 12)} matches scenario`, {
    actual: (provisionShielded[color] ?? 0n).toString(),
    expected: (expectedInitial[color] ?? 0n).toString(),
  });
}
const unexpectedSolverAssets = Object.entries(provisionShielded).filter(([color, amount]) => !(color in expectedInitial) && amount !== 0n);
must(unexpectedSolverAssets.length === 0, "solver has no unlisted shielded assets", unexpectedSolverAssets);
must(provision.dustReady === true, "solver provisioning receipt confirms usable DUST");

record("00-config", {
  scenario,
  assetTokenIds: assets.tokenIds,
  source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, image: SOURCE_IMAGE },
  relay: { commit: RELAY_COMMIT, image: RELAY_IMAGE },
  network: net.id,
  solverSeedSuffix: scenario.solverSeed.slice(-4),
  solverProvisionReceipt: provision,
});

const openingBook = await API.liveOffers();
record("01-opening-book", openingBook);
if ((scenario.openingBook ?? "empty") === "empty") must(openingBook.length === 0, "case starts from an empty backend book", openingBook.map((offer) => offer.offerId));

const wallets = new Map<string, any>();
try {
  for (const actor of scenario.actors) {
    const wallet = await buildWallet(actor.seed);
    await waitForSync(wallet, { timeoutMs: 300_000 });
    wallets.set(actor.name, wallet);
  }
  const before = Object.fromEntries(await Promise.all([...wallets.entries()].map(async ([name, wallet]) => [
    name,
    selectBalances(await shieldedBalances(wallet)),
  ])));
  record("01b-chain-balances-before-offers", {
    measuredAt: new Date().toISOString(),
    measurement: "synchronized wallet state before any offer initSwap",
    actors: Object.fromEntries(Object.entries(before).map(([name, value]) => [name, balanceStrings(value)])),
  });

  const posted = new Map<string, PostedOffer>();
  async function postPhase(phase: "initial" | "after-refusal"): Promise<void> {
    for (const offer of scenario.offers.filter((candidate) => (candidate.phase ?? "initial") === phase)) {
      const maker = wallets.get(offer.maker);
      must(maker, `offer ${offer.name} maker wallet exists`);
      const result = await postMakerOffer({
        maker,
        api: API,
        giveToken: token(offer.giveAsset),
        wantToken: token(offer.wantAsset),
        giveAmount: parseAmount(offer.giveAmount, `${offer.name}.giveAmount`),
        wantAmount: parseAmount(offer.wantAmount, `${offer.name}.wantAmount`),
        log: (message) => log(`${offer.name}: ${message}`),
      });
      posted.set(offer.name, result);
    }
  }
  await postPhase("initial");
  const initialStatuses = Object.fromEntries(await Promise.all([...posted.entries()].map(async ([name, offer]) => [name, {
    offerId: offer.offerId,
    status: (await API.offerStatusByHash(offer.offerId)).status,
  }])));
  must(Object.values(initialStatuses).every((value) => value.status === "live"), "every initial offer is live", initialStatuses);
  record("02-opening-offers", {
    offers: scenario.offers.filter((offer) => (offer.phase ?? "initial") === "initial").map((spec) => ({ spec, posted: posted.get(spec.name) })),
    statuses: initialStatuses,
    balancesBeforeOffers: Object.fromEntries(Object.entries(before).map(([name, value]) => [name, balanceStrings(value)])),
  });

  for (const quote of scenario.preflightQuotes ?? []) await quoteExpected(quote);

  if (scenario.refusal?.kind === "quote-unavailable") {
    const refusal = scenario.refusal;
    const control = await quoteExpected(refusal.liveControl);
    const samples = [];
    for (let index = 0; index < (refusal.samples ?? 3); index++) {
      const observed = await quoteOnce(
        token(refusal.tokenInAsset),
        token(refusal.tokenOutAsset),
        parseAmount(refusal.amountIn, `${refusal.label}.amountIn`),
      );
      samples.push({ measuredAt: new Date().toISOString(), ...observed });
      await sleep(refusal.intervalMs ?? 3_000);
    }
    must(samples.every((sample) => sample.status !== 200), `${refusal.label} remains unquoted while control pair is live`, { control, samples });
    record("03-refusal", { kind: refusal.kind, control, samples });
  } else if (scenario.refusal?.kind === "demand-above-quote") {
    const refusal = scenario.refusal;
    const quote = await quoteExpected({
      label: `${refusal.label}-live-quote`,
      tokenInAsset: refusal.tokenInAsset,
      tokenOutAsset: refusal.tokenOutAsset,
      amountIn: refusal.amountIn,
      expectedOut: refusal.expectedQuoteOut,
    });
    const taker = wallets.get(refusal.taker);
    must(taker, `refusal taker ${refusal.taker} exists`);
    const half = await buildHalf(
      taker,
      token(refusal.tokenInAsset),
      token(refusal.tokenOutAsset),
      parseAmount(refusal.amountIn, `${refusal.label}.amountIn`),
      parseAmount(refusal.demandOut, `${refusal.label}.demandOut`),
    );
    const probes = [];
    for (let index = 0; index < (refusal.probes ?? 3); index++) {
      const intent = await postIntent(half.bytes, quote.quoteId);
      const liveAfter = await quoteOnce(token(refusal.tokenInAsset), token(refusal.tokenOutAsset), parseAmount(refusal.amountIn, `${refusal.label}.amountIn`));
      probes.push({ intent, liveAfter });
      if (intent.status === 202) break;
    }
    await taker.wallet.revertTransaction(half.recipe.transaction);
    must(probes.every((probe) => probe.intent.status !== 202), `${refusal.label} is refused on every intent probe`, probes);
    must(probes.some((probe) => probe.liveAfter.status === 200), `${refusal.label} refusal occurs while quote remains live`, probes);
    record("03-refusal", { kind: refusal.kind, quote, probes });
  }

  await postPhase("after-refusal");

  if (scenario.contention) {
    const contention = scenario.contention;
    must(SOLVER_STATUS_AUTH.length > 0, "contention case has solver status authentication configured");
    const capacitySnapshot = await statusSnapshot();
    const admissionCapacity = Number(capacitySnapshot?.admission?.maxParallelSwaps ?? 0);
    const advertisedCapacity = Number(capacitySnapshot?.ladder?.last?.maxParallelSwaps ?? 0);
    must(admissionCapacity >= contention.requiredCapacity, "solver admission capacity permits simultaneous jobs", {
      required: contention.requiredCapacity,
      actual: admissionCapacity,
    });
    must(advertisedCapacity >= contention.requiredCapacity, "solver ladder advertises simultaneous capacity to relay", {
      required: contention.requiredCapacity,
      actual: advertisedCapacity,
    });

    const quotes = await Promise.all(contention.legs.map((leg) => quoteExpected({
      label: `${leg.label}-predispatch`,
      tokenInAsset: leg.tokenInAsset,
      tokenOutAsset: leg.tokenOutAsset,
      amountIn: leg.amountIn,
      expectedOut: leg.expectedQuoteOut,
    })));
    const halves = await Promise.all(contention.legs.map(async (leg) => {
      const taker = wallets.get(leg.taker);
      must(taker, `contention taker ${leg.taker} exists`);
      return await buildHalf(
        taker,
        token(leg.tokenInAsset),
        token(leg.tokenOutAsset),
        parseAmount(leg.amountIn, `${leg.label}.amountIn`),
        parseAmount(leg.demandOut, `${leg.label}.demandOut`),
      );
    }));
    const preDispatchStatuses = Object.fromEntries(await Promise.all([...posted.entries()].map(async ([name, offer]) => [
      name,
      { offerId: offer.offerId, status: (await API.offerStatusByHash(offer.offerId)).status },
    ])));
    must(Object.values(preDispatchStatuses).every((value) => value.status === "live"), "all contention offers remain live before dispatch", preDispatchStatuses);
    record("04-contention-before-dispatch", {
      measuredAt: new Date().toISOString(),
      requiredCapacity: contention.requiredCapacity,
      capacity: { admission: admissionCapacity, advertisedToRelay: advertisedCapacity },
      sharedOffer: { name: contention.sharedOffer, offerId: posted.get(contention.sharedOffer)?.offerId },
      quotes: contention.legs.map((leg, index) => ({ leg, quote: quotes[index], takerHalfBytes: halves[index]!.bytes.length })),
      offerStatuses: preDispatchStatuses,
    });

    let sampleStatus = true;
    const inFlightSamples: Array<Record<string, unknown>> = [];
    const sampler = (async () => {
      while (sampleStatus && inFlightSamples.length < 120) {
        try {
          const snapshot = await statusSnapshot();
          inFlightSamples.push({
            measuredAt: new Date().toISOString(),
            inventory: snapshot.inventory,
            executor: snapshot.executor,
            journal: snapshot.journal,
            admission: snapshot.admission,
            ladderState: snapshot.ladder?.state,
            ladderCapacity: snapshot.ladder?.last?.maxParallelSwaps ?? null,
          });
        } catch (error) {
          inFlightSamples.push({ measuredAt: new Date().toISOString(), error: String(error) });
        }
        await sleep(200);
      }
    })();
    const dispatchReleasedAt = new Date().toISOString();
    const intents = await Promise.all(halves.map((half, index) => postIntent(half.bytes, quotes[index]!.quoteId)));
    must(intents.every((intent) => intent.status === 202 && intent.jobId), "relay admits both prequoted intents with capacity >=2", intents);
    const jobs = await Promise.all(intents.map((intent) => pollJob(intent.jobId!)));
    sampleStatus = false;
    await sampler;

    const winners = jobs.map((job, index) => ({ job, index })).filter(({ job }) => job.status === "done" && job.txId);
    must(winners.length === 1, "exactly one shared-M3 intent settles", jobs);
    const losers = jobs.map((job, index) => ({ job, index })).filter(({ job }) => job.status !== "done");
    must(losers.length === 1 && losers[0]!.job.status === "error", "the competing shared-M3 intent terminates with an explicit error", losers);
    const losingReason = String(losers[0]!.job.reason ?? "");
    must(losingReason.length > 0, "the losing contention job records a reason", losers[0]!.job);
    must(!/capacity|saturat|max.?parallel|no solver|quote/i.test(losingReason), "the losing job is not a global-capacity or missing-quote refusal", losingReason);
    must(/route.*(unavailable|current)|claim|offer|file/i.test(losingReason), "the losing reason identifies route/resource contention", losingReason);

    const winningIndex = winners[0]!.index;
    const winningLeg = contention.legs[winningIndex]!;
    const winningSelected = new Set(winningLeg.selectedOffers);
    const sharedOfferId = posted.get(contention.sharedOffer)!.offerId;
    const finalStatuses: Record<string, { offerId: string; status: string }> = {};
    const statusDeadline = Date.now() + 300_000;
    while (Date.now() < statusDeadline) {
      for (const [name, offer] of posted) finalStatuses[name] = { offerId: offer.offerId, status: (await API.offerStatusByHash(offer.offerId)).status };
      if ([...posted.keys()].every((name) => finalStatuses[name]!.status === (winningSelected.has(name) ? "consumed" : "live"))) break;
      await sleep(3_000);
    }
    must(finalStatuses[contention.sharedOffer]?.status === "consumed", "shared M3 is consumed exactly by the winning route", finalStatuses);
    must([...posted.keys()].every((name) => finalStatuses[name]!.status === (winningSelected.has(name) ? "consumed" : "live")), "only the winning route's physical files are consumed", finalStatuses);

    const expectedReceipts = expectedReceiptCheck(winningLeg);
    const expectedSolverAfter = Object.fromEntries(
      Object.keys(assets.tokenIds).map((symbol) => [
        symbol,
        ((expectedInitialBySymbol[symbol] ?? 0n) + BigInt(expectedReceipts[symbol] ?? "0")).toString(),
      ]),
    );
    const deltasByActor: Record<string, Balances> = Object.fromEntries([...wallets.keys()].map((name) => [name, {}]));
    for (const offer of scenario.offers.filter((candidate) => winningSelected.has(candidate.name))) {
      addDelta(deltasByActor[offer.maker]!, offer.giveAsset, -parseAmount(offer.giveAmount, `${offer.name}.giveAmount`));
      addDelta(deltasByActor[offer.maker]!, offer.wantAsset, parseAmount(offer.wantAmount, `${offer.name}.wantAmount`));
    }
    addDelta(deltasByActor[winningLeg.taker]!, winningLeg.tokenInAsset, -parseAmount(winningLeg.amountIn, `${winningLeg.label}.amountIn`));
    addDelta(deltasByActor[winningLeg.taker]!, winningLeg.tokenOutAsset, parseAmount(winningLeg.demandOut, `${winningLeg.label}.demandOut`));
    const expectedActors = Object.fromEntries(Object.entries(before).map(([name, balance]) => [name, balanceStrings(expectedAfter(balance, deltasByActor[name] ?? {}))]));

    const winnerJournal = await waitForTerminalJournal(intents[winningIndex]!.jobId!);
    const loserIndex = losers[0]!.index;
    const loserJournal = readJournal(intents[loserIndex]!.jobId!);
    const winnerRows = winnerJournal.rows.filter((row) => row.operation_kind === "JOB_SETTLEMENT");
    must(winnerRows.length > 0 && winnerRows.every((row) => row.lifecycle_state === "SETTLED"), "winning contention journal is SETTLED", winnerRows);
    const sharedJournalUses = [...winnerRows, ...loserJournal.rows].filter((row) => {
      try { return (JSON.parse(row.offer_hashes_json) as string[]).includes(sharedOfferId); } catch { return false; }
    });
    must(sharedJournalUses.length === 1, "only one terminal journal operation owns shared M3", sharedJournalUses);
    must(loserJournal.dust.length === 0, "losing shared-file job has no DUST reservation", loserJournal.dust);
    const winnerOfferIds = winningLeg.selectedOffers.map((name) => posted.get(name)!.offerId);
    const settlementAuthorities = await assertSettlementAuthorities(
      intents[winningIndex]!.jobId!,
      jobs[winningIndex]!.txId!,
      winnerOfferIds,
      winnerJournal,
    );

    record("contention-status-samples", inFlightSamples);
    record("99-live-result", {
      status: "PASS",
      measuredAt: new Date().toISOString(),
      scenarioId: scenario.id,
      contention: true,
      source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, image: SOURCE_IMAGE },
      relay: { commit: RELAY_COMMIT, image: RELAY_IMAGE },
      assets: assets.tokenIds,
      capacity: { required: contention.requiredCapacity, admission: admissionCapacity, advertisedToRelay: advertisedCapacity },
      dispatchReleasedAt,
      quotes: contention.legs.map((leg, index) => ({ leg, quote: quotes[index] })),
      intents,
      jobs,
      winner: { index: winningIndex, leg: winningLeg, job: jobs[winningIndex] },
      loser: { index: loserIndex, leg: contention.legs[loserIndex], job: jobs[loserIndex] },
      sharedOffer: { name: contention.sharedOffer, offerId: sharedOfferId, finalStatus: finalStatuses[contention.sharedOffer] },
      offers: scenario.offers.map((spec) => ({ spec, posted: posted.get(spec.name), selected: winningSelected.has(spec.name), finalStatus: finalStatuses[spec.name] })),
      expectedActorsAfter: expectedActors,
      expectedSolverReceipts: expectedReceipts,
      expectedSolverAfter,
      freshPostCaseReadRequired: true,
      journalByLeg: {
        [contention.legs[winningIndex]!.label]: winnerJournal,
        [contention.legs[loserIndex]!.label]: loserJournal,
      },
      settlementAuthorities,
      statusSamplesFile: "contention-status-samples.json",
    });
    log(`CASE PASS ${scenario.id}: winner=${winningLeg.label}; loser=${losingReason}; shared=${sharedOfferId}`);
  } else if (scenario.settlement) {
    const settlement = scenario.settlement;
    const expectedReceipts = expectedReceiptCheck(settlement);
    const expectedSolverAfter = Object.fromEntries(
      Object.keys(assets.tokenIds).map((symbol) => [
        symbol,
        ((expectedInitialBySymbol[symbol] ?? 0n) + BigInt(expectedReceipts[symbol] ?? "0")).toString(),
      ]),
    );
    const quote = await quoteExpected({
      label: "settlement-current-book",
      tokenInAsset: settlement.tokenInAsset,
      tokenOutAsset: settlement.tokenOutAsset,
      amountIn: settlement.amountIn,
      expectedOut: settlement.expectedQuoteOut,
    });
    must(parseAmount(settlement.demandOut, "settlement.demandOut") <= BigInt(quote.amountOut), "taker demand is within the live maximum quote");
    const taker = wallets.get(settlement.taker);
    must(taker, `settlement taker ${settlement.taker} exists`);
    const half = await buildHalf(
      taker,
      token(settlement.tokenInAsset),
      token(settlement.tokenOutAsset),
      parseAmount(settlement.amountIn, "settlement.amountIn"),
      parseAmount(settlement.demandOut, "settlement.demandOut"),
    );
    const intent = await postIntent(half.bytes, quote.quoteId);
    must(intent.status === 202 && intent.jobId, "relay accepts the real taker intent", intent);
    const job = await pollJob(intent.jobId!);
    must(job.status === "done" && job.txId, "relay job settles on the local Midnight chain", job);

    const selected = new Set(settlement.selectedOffers);
    const finalStatuses: Record<string, { offerId: string; status: string }> = {};
    const statusDeadline = Date.now() + 300_000;
    while (Date.now() < statusDeadline) {
      for (const [name, offer] of posted) finalStatuses[name] = { offerId: offer.offerId, status: (await API.offerStatusByHash(offer.offerId)).status };
      if ([...posted.keys()].every((name) => finalStatuses[name]!.status === (selected.has(name) ? "consumed" : "live"))) break;
      await sleep(3_000);
    }
    must([...posted.keys()].every((name) => finalStatuses[name]!.status === (selected.has(name) ? "consumed" : "live")), "exact selected files are consumed and unselected files remain live", finalStatuses);

    const deltasByActor: Record<string, Balances> = Object.fromEntries([...wallets.keys()].map((name) => [name, {}]));
    for (const offer of scenario.offers.filter((candidate) => selected.has(candidate.name))) {
      addDelta(deltasByActor[offer.maker]!, offer.giveAsset, -parseAmount(offer.giveAmount, `${offer.name}.giveAmount`));
      addDelta(deltasByActor[offer.maker]!, offer.wantAsset, parseAmount(offer.wantAmount, `${offer.name}.wantAmount`));
    }
    addDelta(deltasByActor[settlement.taker]!, settlement.tokenInAsset, -parseAmount(settlement.amountIn, "settlement.amountIn"));
    addDelta(deltasByActor[settlement.taker]!, settlement.tokenOutAsset, parseAmount(settlement.demandOut, "settlement.demandOut"));
    const expectedActors = Object.fromEntries(Object.entries(before).map(([name, balance]) => [name, balanceStrings(expectedAfter(balance, deltasByActor[name] ?? {}))]));

    const journal = await waitForTerminalJournal(intent.jobId!);
    const expectedOfferIds = settlement.selectedOffers.map((name) => posted.get(name)!.offerId).sort();
    const settlementAuthorities = await assertSettlementAuthorities(intent.jobId!, job.txId!, expectedOfferIds, journal);

    record("99-live-result", {
      status: "PASS",
      measuredAt: new Date().toISOString(),
      scenarioId: scenario.id,
      source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, image: SOURCE_IMAGE },
      relay: { commit: RELAY_COMMIT, image: RELAY_IMAGE },
      assets: assets.tokenIds,
      quote,
      intent,
      job,
      takerHalfBytes: half.bytes.length,
      offers: scenario.offers.map((spec) => ({ spec, posted: posted.get(spec.name), selected: selected.has(spec.name), finalStatus: finalStatuses[spec.name] })),
      expectedActorsAfter: expectedActors,
      expectedSolverReceipts: expectedReceipts,
      expectedSolverAfter,
      freshPostCaseReadRequired: true,
      journal,
      settlementAuthorities,
    });
    log(`CASE PASS ${scenario.id}: tx=${job.txId}; selected=${expectedOfferIds.join(",")}`);
  } else {
    record("99-live-result", {
      status: "PASS",
      measuredAt: new Date().toISOString(),
      scenarioId: scenario.id,
      refusalOnly: true,
      source: { commit: SOURCE_COMMIT, tree: SOURCE_TREE, image: SOURCE_IMAGE },
      relay: { commit: RELAY_COMMIT, image: RELAY_IMAGE },
      assets: assets.tokenIds,
      offers: [...posted.entries()].map(([name, offer]) => ({ name, offer })),
      freshPostCaseReadRequired: true,
    });
    log(`CASE PASS ${scenario.id}: refusal-only evidence captured`);
  }
} finally {
  await Promise.allSettled([...wallets.values()].map((wallet) => wallet.wallet.stop?.()));
}
