// e2e.ts — the cross-stack proof (spec 00005 FR-009 / SC-005).
//
// Runs as the `scripts` Compose service, INSIDE the stack's network, against
// the same service names every other component uses. Exit 0 means every
// assertion below held; any other exit is a failure.
//
// What it proves, on the running stack and with nothing about the reference
// relay modified:
//
//   maker zswap posted in the KERNEL  →  solver mirrors it and publishes a
//   ladder at the UNMODIFIED reference relay  →  a taker asks the relay for a
//   quote (POST /quote) and consumes it (POST /intent with its own proven
//   partial transaction)  →  the relay brokers the balancing half from our
//   solver and submits the merged transaction  →  the maker offer is consumed
//   on chain and the taker is credited EXACTLY what it demanded.
//
// Three cases, each with a fresh maker offer because a settled case consumes
// the one it used:
//
//   A  exact-advertised  — demand == the relay's own quote.
//   B  lower-demand      — demand STRICTLY BELOW the quote. This is the
//                          real-boundary proof for FR-001/P4-F01, and the only
//                          place the wallet facade is asked for a settlement
//                          leg with an EMPTY input map (the solver keeps the
//                          surplus, and "keeping" is expressed as an output
//                          with no inputs).
//   C  above-advertised  — demand ABOVE the quote: no settlement anywhere.
//
// ── Why the demand, not the quote, is what the wire carries ──────────────────
// The relay does not take the taker's demand from the quote it issued. It reads
// it out of the taker's own transaction: `TxProcessor.extractQuote` maps the
// guaranteed offer's deltas to `{dx, requiredOutput}` (positive delta = the
// token being sold, negative = the token owed), and `POST /intent` forwards
// exactly that pair to the solver. A solver qualifies when
// `interpolateQuote(levels, dx) >= requiredOutput` (`solverAcceptsPrice`), so a
// LOWER demand is accepted and dispatched verbatim while a HIGHER one leaves no
// qualifying solver and the intent is refused 503. Case B's shape is therefore
// producible by the real wire with no reference change at all — a taker simply
// asks for less than it was quoted.
//
// ── Why everything polls ─────────────────────────────────────────────────────
// The published ladder is withdrawn FAIL-CLOSED for ~10–20 s at a time while
// the kernel's backend projection re-syncs: `deriveLadderPush` publishes the
// empty capabilities+levels pair rather than a ladder it might not honour. A
// single `503 no_solver` therefore means nothing. Every ladder observation here
// retries across multiple push cycles before concluding absence.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import { registerNightForDust } from "@effectstream/midnight-contracts";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

// RELATIVE first-party imports: `deploy/` is not a bun workspace member, so
// `@zswap-da/*` does not resolve from here (bun links workspace packages into
// their dependents' node_modules, never into the workspace root). The npm
// dependencies above DO resolve from /app/node_modules.
import {
  buildWallet,
  shieldedBalances,
  shieldedKeys,
  unshieldedAddressObj,
  unshieldedBalances,
  waitForShielded,
  waitForSync,
} from "../../packages/solver-core/wallet.ts";
import {
  buildTakerHalfStandIn,
  takerHalfStandInSpec,
} from "../../packages/solver-core/fee-sizing.ts";
import { KernelApi, type LiveOffer } from "./lib/kernel-api.ts";
import { postMakerOffer, resolveMintedTokens, type PostedOffer } from "./lib/maker-offer.ts";

globalThis.WebSocket = WebSocket;
setNetworkId(net.id as never);

// ── configuration ────────────────────────────────────────────────────────────

const KERNEL = new KernelApi(process.env["ZSWAP_API"] ?? "http://kernel:9999");
const RELAY = (process.env["RELAY_HTTP_URL"] ?? "http://relay:3000").replace(/\/$/, "");
const GENESIS_SEED =
  process.env["MAKER_SEED"] ??
  process.env["MIDNIGHT_WALLET_SEED"] ??
  "0000000000000000000000000000000000000000000000000000000000000001";
const TAKER_SEED =
  process.env["TAKER_SEED"] ?? "0000000000000000000000000000000000000000000000000000000000000032";
const EVIDENCE_DIR = process.env["E2E_EVIDENCE_DIR"] ?? "/var/lib/e2e";
const JOURNAL_PATH = process.env["SOLVER_JOURNAL_PATH"] ?? "/var/lib/cow-solver/operations.sqlite";
const MINTED_FILE =
  process.env["MINTED_TOKENS_FILE"] ?? "/srv/offerfiles-deploy/minted-tokens.json";
const CASES = (process.env["E2E_CASES"] ?? "A,B,C,D")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_PROVISION = process.env["E2E_SKIP_PROVISION"] === "true";

// ── 00006 SC-004: the capital-free solver ────────────────────────────────────
// When set, this run is the unfunded-solver proof and the driver refuses to
// treat a funded stack as one. See `assertUnfundedSolver` below.
const REQUIRE_UNFUNDED_SOLVER = process.env["E2E_REQUIRE_UNFUNDED_SOLVER"] === "true";
const PROVISION_RECEIPT =
  process.env["SOLVER_PROVISION_RECEIPT"] ?? "/srv/solver-config/provision-receipt.json";
/** The fee-sizing model the solver is running with. Unset means the solver's
 *  own default of 1 (`entrypoint-common.sh` unsets an empty value before
 *  `start.solver.ts` sees it, so "" here really is "default"). Recorded, not
 *  used: it is one of the four numbers design-note §6 asks this run to pin. */
const FEE_SIZING_TAKER_INPUTS = process.env["SOLVER_FEE_SIZING_TAKER_INPUTS"] || "1 (default)";

/** The maker offer every case posts: GIVES this much A, WANTS this much B. The
 *  defaults match the deployment's own seeding offer so a case can also consume
 *  the one `docker compose up` already posted. */
const OFFER_GIVE = BigInt(process.env["E2E_OFFER_GIVE_AMOUNT"] ?? "500000");
const OFFER_WANT = BigInt(process.env["E2E_OFFER_WANT_AMOUNT"] ?? "750000");

/** Case B / C demands, as a fraction of the relay's OWN quote. */
const CASE_B = {
  num: BigInt(process.env["E2E_CASE_B_DEMAND_NUM"] ?? "4"),
  den: BigInt(process.env["E2E_CASE_B_DEMAND_DEN"] ?? "5"),
};
const CASE_C = {
  num: BigInt(process.env["E2E_CASE_C_DEMAND_NUM"] ?? "6"),
  den: BigInt(process.env["E2E_CASE_C_DEMAND_DEN"] ?? "5"),
};

/** Taker inventory: three cases at OFFER_WANT each, with room to spare. */
const TAKER_TOKEN_IN_FUNDING = BigInt(process.env["E2E_TAKER_FUNDING"] ?? "10000000");
const NIGHT = "0".repeat(64);
/** A dust coin's capacity is tied to the size of the NIGHT UTXO backing it, so
 *  a few large UTXOs are usable immediately where many tiny ones are worthless
 *  for days (see packages/solver/scripts/bootstrap-dev.ts). */
const NIGHT_PER_UTXO = 5_000_000_000_000n;
const NIGHT_UTXO_COUNT = 2;
/** Settle window between two submits from the SAME wallet — one undeployed
 *  block, as the reference relay uses. */
const SUBMIT_SETTLE_MS = 8_000;

const LADDER_POLL_TIMEOUT_MS = Number(process.env["E2E_LADDER_TIMEOUT_MS"] ?? "600000");
const JOB_POLL_TIMEOUT_MS = Number(process.env["E2E_JOB_TIMEOUT_MS"] ?? "600000");
const BALANCE_POLL_TIMEOUT_MS = Number(process.env["E2E_BALANCE_TIMEOUT_MS"] ?? "300000");
const OFFER_STATUS_TIMEOUT_MS = Number(process.env["E2E_OFFER_STATUS_TIMEOUT_MS"] ?? "300000");
const INTENT_RETRY_TIMEOUT_MS = Number(process.env["E2E_INTENT_RETRY_TIMEOUT_MS"] ?? "300000");
/** How long a settled job's journal rows may take to reach a terminal state
 *  after the relay says `done`. The gap is the kernel's Celestia-lagged
 *  consumption evidence, not the settlement — see step 8 in `runCase`. */
const JOURNAL_TERMINAL_TIMEOUT_MS = Number(process.env["E2E_JOURNAL_TERMINAL_TIMEOUT_MS"] ?? "300000");
/** After the book changes, give the solver's mirror a full projection cycle
 *  before quoting against it. Without this a case can be dispatched against a
 *  rung the solver derived from the offer the PREVIOUS case just consumed; the
 *  executor's exact-file check would refuse it safely, but the refusal would be
 *  an artifact of test sequencing rather than a property of the stack. */
const MIRROR_SETTLE_MS = Number(process.env["E2E_MIRROR_SETTLE_MS"] ?? "25000");

// ── transcript ───────────────────────────────────────────────────────────────

mkdirSync(EVIDENCE_DIR, { recursive: true });
const transcript: string[] = [];
const log = (msg: string): void => {
  const line = `[e2e] ${new Date().toISOString()} ${msg}`;
  transcript.push(line);
  console.log(line);
  try {
    writeFileSync(`${EVIDENCE_DIR}/driver-transcript.log`, `${transcript.join("\n")}\n`);
  } catch {
    /* the transcript is diagnostics; it must never own the verdict */
  }
};
const record = (name: string, value: unknown): void => {
  writeFileSync(
    `${EVIDENCE_DIR}/${name}.json`,
    `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
};

const failures: string[] = [];
const assert = (ok: boolean, what: string, detail?: unknown): boolean => {
  const suffix = detail === undefined ? "" : ` — ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
  if (ok) {
    log(`  PASS  ${what}${suffix}`);
  } else {
    log(`  FAIL  ${what}${suffix}`);
    failures.push(`${what}${suffix}`);
  }
  return ok;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── relay client (the public taker API only) ─────────────────────────────────

interface RelayQuote {
  type: string;
  tokenOut: string;
  amountOut: string;
  quoteId: string;
}

async function relayTokens(): Promise<string[]> {
  const res = await fetch(`${RELAY}/tokens`);
  if (!res.ok) return [];
  const body = (await res.json()) as { tokens?: string[] };
  return body.tokens ?? [];
}

async function relayQuoteOnce(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${RELAY}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn, tokenOut, amountIn: amountIn.toString() }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the raw text for the transcript */
  }
  return { status: res.status, body };
}

/**
 * Poll `POST /quote` until the relay answers 200 from a real, non-empty ladder.
 *
 * `503 no_solver` is the solver's designed fail-closed withdrawal while the
 * kernel's backend projection re-syncs, not an absence of liquidity: it lasts
 * ~10–20 s and self-heals. Concluding "no ladder" from one sample is the single
 * most reproducible way to mis-read this stack.
 */
async function quoteWithRetry(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  timeoutMs = LADDER_POLL_TIMEOUT_MS,
): Promise<RelayQuote> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let last = "";
  while (Date.now() < deadline) {
    attempts++;
    const { status, body } = await relayQuoteOnce(tokenIn, tokenOut, amountIn);
    if (status === 200) {
      const quote = body as RelayQuote;
      log(
        `  /quote 200 after ${attempts} attempt(s): amountIn=${amountIn} → amountOut=${quote.amountOut} (quoteId=${quote.quoteId})`,
      );
      return quote;
    }
    last = `${status} ${JSON.stringify(body)}`;
    if (attempts % 6 === 1) log(`  /quote ${last} — retrying (withdrawal window or not mirrored yet)`);
    await sleep(5_000);
  }
  throw new Error(`/quote never returned 200 within ${timeoutMs}ms; last: ${last}`);
}

interface IntentResult {
  status: number;
  jobId?: string;
  body: any;
}

async function postIntent(txBytes: Uint8Array, quoteId?: string): Promise<IntentResult> {
  const url = new URL(`${RELAY}/intent`);
  if (quoteId) url.searchParams.set("quoteId", quoteId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: txBytes as BodyInit,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  const jobId = (body as { jobId?: string } | null)?.jobId;
  return { status: res.status, jobId, body };
}

/**
 * `POST /intent` for a case that is supposed to be accepted.
 *
 * `503 no_solver` here is ambiguous by construction: it is both the answer to
 * an unfillable demand AND the answer while the ladder is withdrawn during a
 * backend re-sync. For a case that must be accepted, the withdrawal reading is
 * the only sound one until it stops being transient — so wait for the ladder to
 * be observable again and re-post the SAME bytes (the relay deletes the job it
 * created before answering 503, so nothing leaks and the half stays valid).
 */
async function postIntentExpectingAcceptance(
  txBytes: Uint8Array,
  quote: RelayQuote,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<{ result: IntentResult; attempts: number; transient503: number }> {
  const deadline = Date.now() + INTENT_RETRY_TIMEOUT_MS;
  let attempts = 0;
  let transient503 = 0;
  let last: IntentResult = { status: 0, body: null };
  while (Date.now() < deadline) {
    attempts++;
    last = await postIntent(txBytes, quote.quoteId);
    if (last.status !== 503) return { result: last, attempts, transient503 };
    transient503++;
    log(`  POST /intent 503 ${JSON.stringify(last.body)} — ladder withdrawal window; waiting for it back`);
    await quoteWithRetry(tokenIn, tokenOut, amountIn, Math.max(0, deadline - Date.now()));
  }
  return { result: last, attempts, transient503 };
}

interface JobState {
  status: string;
  txId?: string;
  reason?: string;
  /** Every distinct status the relay reported, in order. Design-note §6 asks
   *  whether the settlement was accepted FIRST TRY; a `submit-failed` from a
   *  DUST shortfall would appear here (and only here) before any terminal. */
  trail?: string[];
}

async function pollJob(jobId: string, timeoutMs = JOB_POLL_TIMEOUT_MS): Promise<JobState> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  const trail: string[] = [];
  while (Date.now() < deadline) {
    await sleep(2_000);
    const res = await fetch(`${RELAY}/jobs/${jobId}`).catch(() => null);
    if (!res) continue;
    if (res.status === 404) {
      // The relay drops a terminal job after TERMINAL_JOB_TTL_MS; inside this
      // loop a 404 can only mean the job was never created.
      return { status: "not_found", trail };
    }
    const job = (await res.json()) as JobState;
    if (job.status !== seen) {
      seen = job.status;
      trail.push(job.status);
      log(`  job ${jobId} → ${job.status}${job.txId ? ` txId=${job.txId}` : ""}${job.reason ? ` reason=${job.reason}` : ""}`);
    }
    if (job.status === "done" || job.status === "error") return { ...job, trail };
  }
  return { status: "timeout", trail };
}

// ── kernel book helpers ──────────────────────────────────────────────────────

const legAmount = (legs: { token: string; amount: string }[], token: string): bigint => {
  const leg = legs.find((l) => l.token.toLowerCase() === token.toLowerCase());
  return leg ? BigInt(leg.amount) : 0n;
};

function describeOffer(o: LiveOffer): string {
  const gives = o.computed.gives.map((l) => `${l.amount} ${l.token.slice(0, 8)}`).join("+");
  const wants = o.computed.wants.map((l) => `${l.amount} ${l.token.slice(0, 8)}`).join("+");
  return `${o.offerId.slice(0, 12)} gives[${gives}] wants[${wants}]`;
}

/** A live offer matching the pair and depth this proof needs, if the book has one. */
function findUsableOffer(
  offers: LiveOffer[],
  tokenA: string,
  tokenB: string,
): LiveOffer | undefined {
  return offers.find(
    (o) =>
      legAmount(o.computed.gives, tokenA) === OFFER_GIVE &&
      legAmount(o.computed.wants, tokenB) === OFFER_WANT,
  );
}

async function waitForOfferStatus(
  hash: string,
  wanted: string[],
  timeoutMs = OFFER_STATUS_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    status = (await KERNEL.offerStatusByHash(hash)).status;
    if (wanted.includes(status)) return status;
    await sleep(3_000);
  }
  return status;
}

// ── solver journal (read-only, on a copy) ────────────────────────────────────

const TERMINAL_LIFECYCLE = new Set(["SETTLED", "REVERTED", "FAILED"]);

interface JournalRow {
  operation_key: string;
  job_id: string;
  generation: number;
  operation_kind: string;
  lifecycle_state: string;
  claim_payouts_json: string;
  offer_hashes_json: string;
  error_code: string | null;
  error_detail: string | null;
}

/**
 * Snapshot the solver's operation journal.
 *
 * Copied before it is opened: the journal is a live WAL database owned by
 * another process, and this driver must not be able to write to it even by
 * accident (a reader that took the write lock would be a fault injected into
 * the very component under test).
 */
function snapshotJournal(): string {
  if (!existsSync(JOURNAL_PATH)) throw new Error(`solver journal not found at ${JOURNAL_PATH}`);
  const dir = `/tmp/journal-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  const copy = `${dir}/operations.sqlite`;
  copyFileSync(JOURNAL_PATH, copy);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${JOURNAL_PATH}${suffix}`)) {
      copyFileSync(`${JOURNAL_PATH}${suffix}`, `${copy}${suffix}`);
    }
  }
  return copy;
}

function readJournal(): JournalRow[] {
  const db = new Database(snapshotJournal());
  try {
    return db
      .query(
        `SELECT operation_key, job_id, generation, operation_kind, lifecycle_state,
                claim_payouts_json, offer_hashes_json, error_code, error_detail
           FROM journal_operations ORDER BY id`,
      )
      .all() as JournalRow[];
  } finally {
    db.close();
  }
}

/** One row of `journal_dust_reservations` — the durable record of what
 *  `estimateDustAmount` computed for a job and `reserveDust` admitted.
 *
 *  This is design-note §6 number 1, and the ONLY place the live-chain DUST
 *  figure is observable from outside the solver process: the amount is read off
 *  the transaction `wallet.dust.balanceTransactions` returned, priced by the
 *  ledger with the LIVE `ledgerParameters` that only exist on a running chain.
 *  Rows appear only when SOLVER_DUST_MAX_PER_* are configured. */
interface DustReservationRow {
  operation_key: string;
  job_id: string;
  generation: number;
  amount_text: string;
  state: string;
  reserved_at_ms: number;
  spent_at_ms: number | null;
}

function readDustReservations(): DustReservationRow[] {
  const db = new Database(snapshotJournal());
  try {
    const present = db
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='journal_dust_reservations'`)
      .get();
    if (!present) return [];
    return db
      .query(
        `SELECT operation_key, job_id, generation, amount_text, state,
                reserved_at_ms, spent_at_ms
           FROM journal_dust_reservations ORDER BY rowid`,
      )
      .all() as DustReservationRow[];
  } finally {
    db.close();
  }
}

/**
 * Price the SAME stand-in shape the solver used, but with the ledger's
 * `initialParameters()` instead of the chain's live ones.
 *
 * This is R1's offline prediction recomputed HERE, in the deployed image,
 * against the same ledger WASM the solver is running — so design-note §6's
 * offline-vs-live comparison is two numbers from one process rather than one
 * number and a quotation from a document. It touches no wallet and no chain:
 * `buildTakerHalfStandIn` fabricates its coins from a throwaway keypair, which
 * is the whole point of the capital-free design.
 *
 * `+ DUST_FEE_OVERHEAD` reproduces `calculateFee`'s flat term
 * (`@effectstream/midnight-contracts` `constants.ts` `DUST_FEE_OVERHEAD`,
 * 3e14 SPECKs) and `DUST_FEE_BLOCKS_MARGIN` its 5-block price margin, so the
 * result is comparable with what `reserveDust` journalled.
 */
const DUST_FEE_OVERHEAD = 300_000_000_000_000n;
const DUST_FEE_BLOCKS_MARGIN = 5;

async function offlineStandInFee(
  tokenIn: string,
  tokenOut: string,
  modelledTakerInputs: number,
): Promise<{ standInFeeWithMargin: string; plusFlatOverhead: string } | { error: string }> {
  try {
    const { LedgerParameters } = (await import("@midnightntwrk/ledger-v9")) as {
      LedgerParameters: { initialParameters: () => unknown };
    };
    const standIn = buildTakerHalfStandIn(
      takerHalfStandInSpec({ networkId: net.id, tokenIn, tokenOut, modelledTakerInputs }),
    ) as unknown as { feesWithMargin: (p: unknown, m: number) => bigint };
    const fee = standIn.feesWithMargin(
      LedgerParameters.initialParameters(),
      DUST_FEE_BLOCKS_MARGIN,
    );
    return {
      standInFeeWithMargin: fee.toString(),
      plusFlatOverhead: (fee + DUST_FEE_OVERHEAD).toString(),
    };
  } catch (err) {
    return { error: String(err).slice(0, 300) };
  }
}

// ── 00006 SC-004: prove the solver was given NO token provisioning ───────────

interface ProvisionReceipt {
  mode?: string;
  script?: string;
  measuredAt?: string;
  mintedTokens?: string[];
  tokensTransferredToSolver?: string[];
  dustRegistered?: boolean;
  nightBeforeDustRegistrationSpecks?: string;
  nightAfterDustRegistrationSpecks?: string;
  solverShielded?: Record<string, string>;
  solverUnshielded?: Record<string, string>;
  solverShieldedNonZeroCount?: number;
}

/**
 * Assert, from a MEASUREMENT rather than from configuration, that the solver
 * wallet held zero of every swap token when it started.
 *
 * This driver cannot look for itself: the solver service holds a live facade on
 * SOLVER_SEED throughout, and two facades on one seed against one Midnight node
 * force each other's connection down (the same reason the solver-surplus gate
 * is a separate script run after the solver is stopped). The measurement is
 * therefore taken by `deploy/scripts/provision-solver-fees.ts` — the process
 * that legitimately owns that facade, at the moment provisioning ends and
 * before the solver boots — and published as a receipt on the shared
 * `solver-config` volume, which this service mounts read-only.
 *
 * The receipt is not the only evidence and is not meant to be: the run's other
 * half is `deploy/scripts/read-wallet.ts` afterwards, which reads the solver's
 * REAL post-run balance off the chain and must find the case-B surplus and
 * nothing else. A solver that had been minted the usual 1e9 of each token would
 * fail that gate by nine orders of magnitude.
 */
function assertUnfundedSolver(tokenIn: string, tokenOut: string): ProvisionReceipt | null {
  if (!REQUIRE_UNFUNDED_SOLVER) {
    log("E2E_REQUIRE_UNFUNDED_SOLVER is not set — not asserting the capital-free premise");
    return null;
  }
  log("");
  log("══ SC-004 PREMISE — the solver received NO token provisioning ══════════");
  let receipt: ProvisionReceipt;
  try {
    receipt = JSON.parse(readFileSync(PROVISION_RECEIPT, "utf-8")) as ProvisionReceipt;
  } catch (err) {
    assert(false, `solver-provision receipt is readable at ${PROVISION_RECEIPT}`, String(err));
    return null;
  }
  log(`receipt: ${JSON.stringify(receipt)}`);
  record("05-solver-provision-receipt", receipt);

  assert(
    receipt.mode === "fee-currency-only",
    "solver provisioning ran in the FEE-CURRENCY-ONLY mode",
    { mode: receipt.mode, script: receipt.script },
  );
  assert(
    (receipt.mintedTokens?.length ?? -1) === 0 &&
      (receipt.tokensTransferredToSolver?.length ?? -1) === 0,
    "provisioning minted NO token and transferred NO token to the solver",
    { minted: receipt.mintedTokens, transferred: receipt.tokensTransferredToSolver },
  );
  const shielded = receipt.solverShielded ?? {};
  const nonZero = Object.entries(shielded).filter(([, v]) => BigInt(v) !== 0n);
  assert(
    nonZero.length === 0 && (receipt.solverShieldedNonZeroCount ?? -1) === 0,
    "the solver wallet held ZERO of EVERY shielded token when provisioning finished",
    { nonZero, count: receipt.solverShieldedNonZeroCount },
  );
  assert(
    BigInt(shielded[tokenIn] ?? "0") === 0n,
    "…including zero tokenIn (the token fee sizing used to have to spend)",
    { tokenIn, held: shielded[tokenIn] ?? "0" },
  );
  assert(
    BigInt(shielded[tokenOut] ?? "0") === 0n,
    "…including zero tokenOut (so no interior rung is fundable either)",
    { tokenOut, held: shielded[tokenOut] ?? "0" },
  );
  // The funding fact is the CONFIRMED balance measured before dust
  // registration, not the reading after it. Registration spends the
  // unregistered NIGHT UTXOs and re-creates them registered, so the
  // post-registration unshielded view legitimately reads 0 for a few seconds
  // (measured: 2e13 on one run of the provisioner and 0 on the next, with the
  // dust wallet above 1.7e18 on both). Falls back to the post reading for
  // receipts written before that field existed.
  const nightFunding = BigInt(
    receipt.nightBeforeDustRegistrationSpecks ?? receipt.solverUnshielded?.[NIGHT] ?? "0",
  );
  assert(
    receipt.dustRegistered === true && nightFunding > 0n,
    "the solver DOES hold fee currency (NIGHT, registered for dust) — the one thing it needs",
    {
      nightBeforeDustRegistration: nightFunding.toString(),
      nightAfterDustRegistration: receipt.nightAfterDustRegistrationSpecks ?? "n/a",
      dustRegistered: receipt.dustRegistered,
    },
  );
  return receipt;
}

// ── wallets ──────────────────────────────────────────────────────────────────

let genesis: any;
let taker: any;

async function fundTakerNight(): Promise<void> {
  const held = (await unshieldedBalances(taker))[NIGHT] ?? 0n;
  if (held >= NIGHT_PER_UTXO) {
    log(`taker already holds ${held} NIGHT`);
    return;
  }
  log(`taker holds ${held} NIGHT — funding ${NIGHT_UTXO_COUNT} x ${NIGHT_PER_UTXO} from genesis`);
  const receiver = unshieldedAddressObj(taker);
  const outputs = Array.from({ length: NIGHT_UTXO_COUNT }, () => ({
    type: NIGHT,
    amount: NIGHT_PER_UTXO,
    receiverAddress: receiver as any,
  }));
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const recipe = await genesis.wallet.transferTransaction(
        [{ type: "unshielded", outputs } as any],
        shieldedKeys(genesis),
        { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
      );
      const signed = await genesis.wallet.signRecipe(recipe, (p: Uint8Array) =>
        genesis.unshieldedKeystore.signDataAsync(p),
      );
      await genesis.wallet.submitTransaction(await genesis.wallet.finalizeRecipe(signed));
      lastErr = undefined;
      break;
    } catch (err) {
      // A transfer spends the previous one's change, which only exists once
      // that transaction confirms; retrying self-synchronises on it.
      lastErr = err;
      log(`  NIGHT transfer attempt ${attempt + 1} failed: ${String(err).slice(0, 160)}`);
      await sleep(15_000);
    }
  }
  if (lastErr) throw lastErr;
  for (let i = 0; i < 40; i++) {
    if (((await unshieldedBalances(taker))[NIGHT] ?? 0n) >= NIGHT_PER_UTXO) break;
    await sleep(5_000);
  }
  log(`taker NIGHT: ${(await unshieldedBalances(taker))[NIGHT] ?? 0n}`);
  // Let the genesis wallet's own dust-spend accounting observe the chain
  // notification for the submit above before it is asked to submit again. The
  // reference relay serialises its submits with the same fixed settle for the
  // same reason (`registerJobRoutes`, SUBMIT_SETTLE_MS).
  await sleep(SUBMIT_SETTLE_MS);
}

async function fundTakerTokenIn(tokenIn: string): Promise<void> {
  const held = (await shieldedBalances(taker))[tokenIn] ?? 0n;
  const needed = OFFER_WANT * BigInt(Math.max(CASES.length, 1)) + OFFER_WANT;
  if (held >= needed) {
    log(`taker already holds ${held} of tokenIn (needs ${needed})`);
    return;
  }
  log(`taker holds ${held} of tokenIn — transferring ${TAKER_TOKEN_IN_FUNDING} from genesis`);
  const takerShielded = await taker.wallet.shielded.getAddress();
  // Retried for the same reason `fundTakerNight` is, and one more: this is the
  // genesis wallet's SECOND submit in a row. The SDK's dust-spend accounting
  // has not yet seen the chain notification that finalised the previous one, so
  // a transaction built against that state can be rejected outright (observed:
  // `1010: Invalid Transaction: Custom error: 170`). Retrying self-synchronises
  // on the confirmation — the same hazard the reference relay handles with a
  // fixed post-submit settle delay.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const recipe = await genesis.wallet.transferTransaction(
        [
          {
            type: "shielded",
            outputs: [
              { type: tokenIn, amount: TAKER_TOKEN_IN_FUNDING, receiverAddress: takerShielded },
            ],
          } as any,
        ],
        shieldedKeys(genesis),
        { ttl: new Date(Date.now() + 30 * 60_000), payFees: true },
      );
      const finalized = await genesis.wallet.finalizeRecipe(recipe);
      await genesis.wallet.submitTransaction(finalized);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      log(`  tokenIn transfer attempt ${attempt + 1} failed: ${String(err).slice(0, 200)}`);
      await sleep(15_000);
    }
  }
  if (lastErr) throw lastErr;
  const got = await waitForShielded(taker, tokenIn, TAKER_TOKEN_IN_FUNDING, 60, 5_000);
  log(`taker tokenIn balance: ${got}`);
  if (got < needed) throw new Error(`taker tokenIn funding failed: ${got} < ${needed}`);
}

// ── one case ─────────────────────────────────────────────────────────────────

interface CaseSpec {
  label: string;
  title: string;
  demand: { num: bigint; den: bigint };
  expect: "settle" | "refuse";
}

interface CaseResult {
  label: string;
  title: string;
  expect: string;
  offerId: string;
  amountIn: string;
  quotedOut: string;
  demandedOut: string;
  jobId?: string;
  jobStatus: string;
  txId?: string;
  reason?: string;
  intentStatus: number;
  intentAttempts: number;
  transient503: number;
  refusalProbes: Array<{ status: number; body: unknown; ladderLiveAfter: boolean }>;
  takerBefore: Record<string, string>;
  takerAfter: Record<string, string>;
  takerDeltaTokenIn: string;
  takerDeltaTokenOut: string;
  offerStatusAfter: string;
  bookLiveBefore: string[];
  bookLiveAfter: string[];
  journalRows: JournalRow[];
  expectedSolverSurplusTokenOut: string;
  passed: boolean;
  /** ── design-note §6: the four numbers only a live chain can supply ────────
   *  1. `reservedDustSpecks` — what `estimateDustAmount` read off the
   *     transaction `dust.balanceTransactions` returned, i.e. the fee priced
   *     with the LIVE `ledgerParameters`, as journalled by `reserveDust`.
   *  2. `modelledTakerInputs` — the stand-in shape in force while it was priced.
   *  3. `takerHalfBytes` — the REAL taker half's serialized length, so the
   *     modelled shape can be compared with the one the relay actually merged.
   *  4. `acceptedFirstTry` — no `submit-failed` from a fee shortfall. */
  feeSizing: {
    reservedDustSpecks: string | null;
    dustReservationState: string | null;
    modelledTakerInputs: string;
    takerHalfBytes: number;
    acceptedFirstTry: boolean;
    jobStatusTrail: string[];
    journalErrorCodes: Array<string | null>;
    /** The subset of `journalErrorCodes` that actually denotes a failed
     *  submission. `BACKEND_EVIDENCE_UNKNOWN` is deliberately NOT in it. */
    submitFailureCodes: Array<string | null>;
  };
}

async function runCase(
  spec: CaseSpec,
  tokens: { tokenIn: string; tokenOut: string },
  preExistingOffer: PostedOffer | LiveOffer | undefined,
): Promise<CaseResult> {
  const { tokenIn, tokenOut } = tokens;
  const failuresBefore = failures.length;
  log("");
  log(`══ CASE ${spec.label} — ${spec.title} (expect: ${spec.expect}) ═══════════════`);

  // 1. A live maker offer for this case. Fresh unless the book already carries
  //    a usable one (the deployment's own seeding offer, for the first case).
  let offerBlob: string | undefined;
  let offerId: string;
  const bookBefore = await KERNEL.liveOffers();
  log(`kernel book before: ${bookBefore.length} live offer(s)`);
  for (const o of bookBefore) log(`  ${describeOffer(o)}`);

  const reusable =
    preExistingOffer && "blob" in preExistingOffer
      ? bookBefore.find((o) => o.offerId === preExistingOffer.offerId)
      : findUsableOffer(bookBefore, tokenOut, tokenIn);
  if (reusable) {
    offerId = reusable.offerId;
    offerBlob = preExistingOffer && "blob" in preExistingOffer ? preExistingOffer.blob : undefined;
    log(`reusing live maker offer ${offerId.slice(0, 12)}…`);
  } else {
    log("posting a fresh maker offer for this case");
    const posted = await postMakerOffer({
      maker: genesis,
      api: KERNEL,
      giveToken: tokenOut,
      wantToken: tokenIn,
      giveAmount: OFFER_GIVE,
      wantAmount: OFFER_WANT,
      log: (m) => log(`  [maker] ${m}`),
    });
    offerId = posted.offerId;
    offerBlob = posted.blob;
  }

  if (MIRROR_SETTLE_MS > 0) {
    log(`waiting ${MIRROR_SETTLE_MS}ms for the solver's book mirror to converge on this book`);
    await sleep(MIRROR_SETTLE_MS);
  }

  // 2. The relay's own quote, from the solver's published levels. Polled,
  //    because the ladder is withdrawn fail-closed in short windows.
  const amountIn = OFFER_WANT;
  const quote = await quoteWithRetry(tokenIn, tokenOut, amountIn);
  const quotedOut = BigInt(quote.amountOut);
  assert(
    quotedOut === OFFER_GIVE,
    `case ${spec.label}: relay quote traces to the maker offer's terms`,
    { amountIn: amountIn.toString(), quotedOut: quotedOut.toString(), offerGives: OFFER_GIVE.toString() },
  );

  const demanded = (quotedOut * spec.demand.num) / spec.demand.den;
  log(
    `demand = quote * ${spec.demand.num}/${spec.demand.den} = ${demanded} ` +
      `(${demanded === quotedOut ? "exact-advertised" : demanded < quotedOut ? "BELOW the quote" : "ABOVE the quote"})`,
  );
  if (spec.demand.num === spec.demand.den) {
    assert(demanded === quotedOut, `case ${spec.label}: the demand IS the advertised output`, {
      demanded: demanded.toString(),
      quotedOut: quotedOut.toString(),
    });
  } else if (spec.demand.num < spec.demand.den) {
    assert(demanded < quotedOut, `case ${spec.label}: the demand is strictly below the quote`, {
      demanded: demanded.toString(),
      quotedOut: quotedOut.toString(),
    });
  }
  if (spec.expect === "refuse") {
    assert(demanded > quotedOut, `case ${spec.label}: the demand is strictly above the quote`, {
      demanded: demanded.toString(),
      quotedOut: quotedOut.toString(),
    });
  }

  // 3. Balances before.
  await waitForSync(taker);
  const takerBefore = await shieldedBalances(taker);
  const beforeIn = takerBefore[tokenIn] ?? 0n;
  const beforeOut = takerBefore[tokenOut] ?? 0n;
  log(`taker before: tokenIn=${beforeIn} tokenOut=${beforeOut}`);
  const journalBefore = readJournal();

  // 4. The taker's half. `payFees:false` — the solver funds all DUST, which is
  //    the production trader path (RELAY_API_CONTRACT §2).
  log("building the taker half via initSwap (ZK proof)…");
  const takerShielded = await taker.wallet.shielded.getAddress();
  const recipe = await taker.wallet.initSwap(
    { shielded: { [tokenIn]: amountIn } },
    [
      {
        type: "shielded",
        outputs: [{ type: tokenOut, amount: demanded, receiverAddress: takerShielded }],
      } as never,
    ],
    shieldedKeys(taker),
    { ttl: new Date(Date.now() + 30 * 60_000), payFees: false },
  );
  const finalized = await taker.wallet.finalizeTransaction(recipe.transaction);
  const txBytes: Uint8Array = finalized.serialize();
  // Design-note §6 number 3. The solver never sees this transaction — the relay
  // merges it — so its length is the only handle anyone has on the REAL taker
  // half's element count, and therefore on whether `modelledTakerInputs` was a
  // sound model. 00005-E1's baseline for 1 input + change + receive is 15 480.
  const takerHalfBytes = txBytes.length;
  log(`taker half proven — ${takerHalfBytes} bytes`);

  // 5. POST /intent.
  let intent: IntentResult;
  let job: JobState = { status: "not_submitted" };
  const refusalProbes: Array<{ status: number; body: unknown; ladderLiveAfter: boolean }> = [];
  let intentAttempts = 1;
  let transient503 = 0;

  if (spec.expect === "refuse") {
    // A bare 503 proves nothing on this stack: it is also what a ladder
    // withdrawal window answers. Each probe therefore re-confirms, immediately
    // afterwards, that the relay is STILL quoting this pair — a refusal with a
    // live ladder on both sides of it can only be about the demand. Repeated,
    // because the two calls are milliseconds apart but the windows are seconds
    // long, and because a single coincidence is not a proof.
    for (let probe = 1; probe <= 3; probe++) {
      const attempt = await postIntent(txBytes, quote.quoteId);
      const after = await relayQuoteOnce(tokenIn, tokenOut, amountIn);
      const ladderLiveAfter = after.status === 200;
      log(
        `probe ${probe}: POST /intent → ${attempt.status} ${JSON.stringify(attempt.body)}; ` +
          `ladder immediately after: ${after.status}`,
      );
      refusalProbes.push({ status: attempt.status, body: attempt.body, ladderLiveAfter });
      if (probe === 1) intent = attempt;
      if (attempt.status === 202) {
        intent = attempt;
        break;
      }
    }
    intent = intent!;
    const refusedEvery = refusalProbes.every((p) => p.status !== 202);
    assert(
      refusedEvery,
      `case ${spec.label}: the relay REFUSED the above-advertised intent on every probe`,
      refusalProbes.map((p) => p.status),
    );
    assert(
      refusalProbes.some((p) => p.ladderLiveAfter),
      `case ${spec.label}: the ladder was demonstrably LIVE while the intent was refused ` +
        `(so the refusal is about the demand, not a withdrawal window)`,
      refusalProbes.map((p) => `${p.status}/ladder=${p.ladderLiveAfter ? "200" : "503"}`),
    );
    if (intent.status === 202 && intent.jobId) {
      // The relay accepted it after all: the solver must then refuse, and the
      // job must reach `error` with no settlement.
      job = await pollJob(intent.jobId);
      assert(
        job.status === "error",
        `case ${spec.label}: the solver refused the dispatched job`,
        job,
      );
    }
    // The proven-but-unsubmitted half still holds a coin reservation in the
    // taker's local wallet view. Release it, or the next case cannot select
    // coins it demonstrably still owns.
    await taker.wallet.revertTransaction(recipe.transaction).catch((err: unknown) => {
      log(`  revertTransaction after refusal failed: ${String(err).slice(0, 200)}`);
    });
  } else {
    const posted = await postIntentExpectingAcceptance(txBytes, quote, tokenIn, tokenOut, amountIn);
    intent = posted.result;
    intentAttempts = posted.attempts;
    transient503 = posted.transient503;
    log(
      `POST /intent → ${intent.status} ${JSON.stringify(intent.body)} ` +
        `(attempts=${intentAttempts}, transient 503s=${transient503})`,
    );
    assert(intent.status === 202 && !!intent.jobId, `case ${spec.label}: intent accepted (202)`, {
      status: intent.status,
      body: intent.body,
      attempts: intentAttempts,
    });
    if (intent.jobId) {
      job = await pollJob(intent.jobId);
      assert(
        job.status === "done" && !!job.txId,
        `case ${spec.label}: job reached the SUCCESS terminal on chain`,
        job,
      );
    }
    if (job.status !== "done") {
      // Nothing settled, so the proven half's coin reservation is still held in
      // the taker's local wallet view — and it covers the taker's whole tokenIn
      // balance. Releasing it is what keeps a failure diagnosable instead of
      // cascading into "the taker has no funds" on every case after it.
      await taker.wallet.revertTransaction(recipe.transaction).catch((err: unknown) => {
        log(`  revertTransaction after a non-settling case failed: ${String(err).slice(0, 200)}`);
      });
    }
  }

  // 6. Balances after — polled to the expected value, then asserted EXACTLY.
  const expectedIn = spec.expect === "settle" ? beforeIn - amountIn : beforeIn;
  const expectedOut = spec.expect === "settle" ? beforeOut + demanded : beforeOut;
  const deadline = Date.now() + BALANCE_POLL_TIMEOUT_MS;
  let afterBalances = takerBefore;
  while (Date.now() < deadline) {
    await sleep(5_000);
    afterBalances = await shieldedBalances(taker);
    if (
      (afterBalances[tokenIn] ?? 0n) === expectedIn &&
      (afterBalances[tokenOut] ?? 0n) === expectedOut
    ) {
      break;
    }
  }
  const afterIn = afterBalances[tokenIn] ?? 0n;
  const afterOut = afterBalances[tokenOut] ?? 0n;
  log(`taker after: tokenIn=${afterIn} tokenOut=${afterOut}`);
  if (spec.expect === "settle") {
    assert(
      afterOut - beforeOut === demanded,
      `case ${spec.label}: taker credited EXACTLY the demanded output`,
      { delta: (afterOut - beforeOut).toString(), demanded: demanded.toString() },
    );
    assert(
      beforeIn - afterIn === amountIn,
      `case ${spec.label}: taker debited EXACTLY amountIn`,
      { delta: (beforeIn - afterIn).toString(), amountIn: amountIn.toString() },
    );
  } else {
    assert(
      afterOut === beforeOut && afterIn === beforeIn,
      `case ${spec.label}: taker balances UNCHANGED (no settlement)`,
      { beforeIn: beforeIn.toString(), afterIn: afterIn.toString(), beforeOut: beforeOut.toString(), afterOut: afterOut.toString() },
    );
  }

  // 7. The maker offer on chain.
  const wantedStatus = spec.expect === "settle" ? ["consumed"] : ["live"];
  const offerStatusAfter = await waitForOfferStatus(offerId, wantedStatus);
  assert(
    wantedStatus.includes(offerStatusAfter),
    `case ${spec.label}: maker offer is ${wantedStatus.join("|")} in the kernel`,
    { offerId, status: offerStatusAfter },
  );
  const bookAfter = await KERNEL.liveOffers();
  const stillLive = bookAfter.some((o) => o.offerId === offerId);
  assert(
    spec.expect === "settle" ? !stillLive : stillLive,
    `case ${spec.label}: kernel book ${spec.expect === "settle" ? "no longer lists" : "still lists"} the offer`,
    { offerId, liveCount: bookAfter.length },
  );
  if (offerBlob) {
    const byBlob = await KERNEL.offerStatusByBlob(offerBlob);
    assert(
      byBlob.status === offerStatusAfter,
      `case ${spec.label}: status by blob agrees with status by hash`,
      byBlob,
    );
  }

  // 8. The solver's own durable record.
  //
  // POLLED, not sampled once. The relay answers `done` as soon as the node
  // accepts the merged transaction, but the solver will not call the job
  // settled until the KERNEL's Celestia-lagged projection proves the maker
  // consumption (`reconcileRelayDone` → `readUniformEvidence`). Between those
  // two moments the group sits QUARANTINED with `BACKEND_EVIDENCE_UNKNOWN` and
  // the next sweep resolves it. A single sample therefore races the sweep and
  // wins or loses by luck — measured: it won 3/3 in V1 run 1 and lost on case B
  // in run 2, on the same code and the same stack.
  //
  // This is not softening the assertion. The terminal state still has to
  // arrive, within a bounded wait, and the end-of-run global assertions still
  // require that NOTHING anywhere is left non-terminal or quarantined.
  let journalAfter = readJournal();
  let jobRows = intent.jobId ? journalAfter.filter((r) => r.job_id === intent.jobId) : [];
  if (spec.expect === "settle" && intent.jobId) {
    const terminalDeadline = Date.now() + JOURNAL_TERMINAL_TIMEOUT_MS;
    while (
      Date.now() < terminalDeadline &&
      (jobRows.length === 0 || jobRows.some((r) => !TERMINAL_LIFECYCLE.has(r.lifecycle_state)))
    ) {
      await sleep(5_000);
      journalAfter = readJournal();
      jobRows = journalAfter.filter((r) => r.job_id === intent.jobId);
    }
    log(
      `journal for ${intent.jobId}: ${jobRows.map((r) => `${r.operation_kind}=${r.lifecycle_state}`).join(", ")}`,
    );
  }
  if (spec.expect === "settle") {
    const settlement = jobRows.filter((r) => r.operation_kind === "JOB_SETTLEMENT");
    assert(
      settlement.length > 0 && settlement.every((r) => r.lifecycle_state === "SETTLED"),
      `case ${spec.label}: solver journal JOB_SETTLEMENT is SETTLED`,
      settlement.map((r) => `${r.operation_key}=${r.lifecycle_state}`),
    );
    assert(
      jobRows.every((r) => TERMINAL_LIFECYCLE.has(r.lifecycle_state)),
      `case ${spec.label}: every journal row for the job is terminal`,
      jobRows.map((r) => `${r.operation_kind}=${r.lifecycle_state}`),
    );
  } else {
    assert(
      jobRows.length === 0,
      `case ${spec.label}: solver wrote NO journal row (it never saw the job)`,
      jobRows.map((r) => `${r.operation_kind}=${r.lifecycle_state}`),
    );
    assert(
      journalAfter.length === journalBefore.length,
      `case ${spec.label}: journal row count unchanged`,
      { before: journalBefore.length, after: journalAfter.length },
    );
  }

  // ── design-note §6, per job ────────────────────────────────────────────────
  const dustRows = intent.jobId
    ? readDustReservations().filter((r) => r.job_id === intent.jobId)
    : [];
  const jobStatusTrail = job.trail ?? [];
  const journalErrorCodes = jobRows.map((r) => r.error_code);
  // "Accepted first try" = the chain took the merged transaction on the first
  // submission. A DUST shortfall shows up as the relay reporting `submit-failed`
  // (`relay-client.ts:772` → `onSubmitFailed`), which drives
  // `reconcileRelayFailure` and leaves a `RELAY_FAILURE_*` code with a
  // non-SETTLED settlement row.
  //
  // NOT a failure signal, and measured to occur on a healthy settlement:
  // `BACKEND_EVIDENCE_UNKNOWN`. The relay answers `done` as soon as the node
  // accepts the transaction, while the solver will only call a job settled once
  // the KERNEL's Celestia-lagged projection proves the maker consumption
  // (`reconcileRelayDone` → `readUniformEvidence`). In the gap the row is
  // quarantined with that code, and the next sweep binds the evidence and marks
  // it SETTLED — the code stays on the row as history. Treating it as a
  // settlement failure would report every normal settlement on this devnet as a
  // fee shortfall (observed in V1 run 1, and the reason this predicate is
  // narrowed to the RELAY_FAILURE_* family).
  const submitFailureCodes = journalErrorCodes.filter(
    (c) => c !== null && /^RELAY_FAILURE|SUBMIT/i.test(c),
  );
  const acceptedFirstTry =
    spec.expect !== "settle"
      ? true
      : job.status === "done" &&
        !jobStatusTrail.some((s) => /fail|reject|error/i.test(s)) &&
        submitFailureCodes.length === 0;
  if (spec.expect === "settle") {
    assert(
      dustRows.length === 1 && BigInt(dustRows[0]!.amount_text) > 0n,
      `case ${spec.label}: exactly one DUST reservation was journalled, with a positive live-chain amount`,
      dustRows.map((r) => `${r.amount_text}/${r.state}`),
    );
    assert(
      acceptedFirstTry,
      `case ${spec.label}: the merged transaction was accepted FIRST TRY — no submit-failed from a fee shortfall`,
      { trail: jobStatusTrail, submitFailureCodes, allErrorCodes: journalErrorCodes },
    );
    log(
      `  §6  reservedDust=${dustRows[0]?.amount_text ?? "n/a"} SPECKs  ` +
        `modelledTakerInputs=${FEE_SIZING_TAKER_INPUTS}  takerHalf=${takerHalfBytes} bytes  ` +
        `acceptedFirstTry=${acceptedFirstTry}`,
    );
  }

  const surplus = spec.expect === "settle" ? quotedOut - demanded : 0n;
  const result: CaseResult = {
    label: spec.label,
    title: spec.title,
    expect: spec.expect,
    offerId,
    amountIn: amountIn.toString(),
    quotedOut: quotedOut.toString(),
    demandedOut: demanded.toString(),
    ...(intent.jobId ? { jobId: intent.jobId } : {}),
    jobStatus: job.status,
    ...(job.txId ? { txId: job.txId } : {}),
    ...(job.reason ? { reason: job.reason } : {}),
    intentStatus: intent.status,
    intentAttempts,
    transient503,
    refusalProbes,
    takerBefore: Object.fromEntries(Object.entries(takerBefore).map(([k, v]) => [k, String(v)])),
    takerAfter: Object.fromEntries(Object.entries(afterBalances).map(([k, v]) => [k, String(v)])),
    takerDeltaTokenIn: (afterIn - beforeIn).toString(),
    takerDeltaTokenOut: (afterOut - beforeOut).toString(),
    offerStatusAfter,
    bookLiveBefore: bookBefore.map(describeOffer),
    bookLiveAfter: bookAfter.map(describeOffer),
    journalRows: jobRows,
    expectedSolverSurplusTokenOut: surplus.toString(),
    passed: failures.length === failuresBefore,
    feeSizing: {
      reservedDustSpecks: dustRows[0]?.amount_text ?? null,
      dustReservationState: dustRows[0]?.state ?? null,
      modelledTakerInputs: FEE_SIZING_TAKER_INPUTS,
      takerHalfBytes,
      acceptedFirstTry,
      jobStatusTrail,
      journalErrorCodes,
      submitFailureCodes,
    },
  };
  record(`case-${spec.label}`, result);
  log(`case ${spec.label}: ${result.passed ? "PASS" : "FAIL"}`);
  return result;
}

// ── main ─────────────────────────────────────────────────────────────────────

const started = Date.now();
let exitCode = 1;
try {
  const minted = resolveMintedTokens({ file: MINTED_FILE });
  // The deployment's maker offer GIVES A and WANTS B, so for the solver — and
  // therefore for the taker — the directed pair is tokenIn=B, tokenOut=A.
  const tokenOut = minted.give;
  const tokenIn = minted.want;
  log(`kernel   : ${KERNEL.base}`);
  log(`relay    : ${RELAY}`);
  log(`network  : ${net.id}`);
  log(`tokenIn  : ${tokenIn}  (taker pays; maker wants)`);
  log(`tokenOut : ${tokenOut}  (taker receives; maker gives)`);
  log(`cases    : ${CASES.join(",")}`);
  record("00-config", {
    kernel: KERNEL.base,
    relay: RELAY,
    network: net.id,
    tokenIn,
    tokenOut,
    offerGive: OFFER_GIVE.toString(),
    offerWant: OFFER_WANT.toString(),
    cases: CASES,
    mintedTokensFile: MINTED_FILE,
    minted: minted.raw,
    journalPath: JOURNAL_PATH,
  });

  // SC-004's premise, asserted before anything else spends time: if the solver
  // was funded after all, this run cannot prove what it claims to prove.
  const provisionReceipt = assertUnfundedSolver(tokenIn, tokenOut);

  genesis = await buildWallet(GENESIS_SEED);
  await waitForSync(genesis, { requireUnshieldedFunds: true });
  log(`genesis/maker wallet synced (seed …${GENESIS_SEED.slice(-4)})`);
  taker = await buildWallet(TAKER_SEED);
  await waitForSync(taker);
  log(`taker wallet synced (seed …${TAKER_SEED.slice(-4)})`);

  if (!SKIP_PROVISION) {
    await fundTakerNight();
    // Registered even though every swap half is built `payFees:false`: the
    // reference funds its taker the same way, and a taker that can pay its own
    // way is the honest starting point for a "no settlement" negative control.
    await registerNightForDust(taker as any);
    log("taker registered NIGHT for dust");
    await fundTakerTokenIn(tokenIn);
  } else {
    log("E2E_SKIP_PROVISION=true — assuming the taker is already funded");
  }

  record("01-provisioned", {
    takerShielded: Object.fromEntries(
      Object.entries(await shieldedBalances(taker)).map(([k, v]) => [k, String(v)]),
    ),
    takerUnshielded: Object.fromEntries(
      Object.entries(await unshieldedBalances(taker)).map(([k, v]) => [k, String(v)]),
    ),
    genesisShielded: Object.fromEntries(
      Object.entries(await shieldedBalances(genesis)).map(([k, v]) => [k, String(v)]),
    ),
  });

  const tokensAtRelay = await relayTokens();
  log(`relay GET /tokens: ${JSON.stringify(tokensAtRelay)}`);
  record("02-relay-tokens-before", tokensAtRelay);
  record("03-kernel-book-before", (await KERNEL.liveOffers()).map(describeOffer));
  const journalAtStart = readJournal();
  record("04-journal-before", journalAtStart);

  // ── SC-004: a token-less solver publishes a real, non-empty ladder ─────────
  // At the UNMODIFIED reference relay, from the deployment's own seeding offer,
  // while the solver holds zero of both sides of the pair. Retried, because the
  // ladder is withdrawn fail-closed in ~10-20 s windows and one sample proves
  // nothing either way.
  if (REQUIRE_UNFUNDED_SOLVER) {
    log("");
    log("══ SC-004 — the token-less solver's published ladder ═══════════════════");
    const openingQuote = await quoteWithRetry(tokenIn, tokenOut, OFFER_WANT);
    const openingTokens = await relayTokens();
    const lower = openingTokens.map((t) => t.toLowerCase());
    assert(
      openingTokens.length > 0 &&
        lower.includes(tokenIn.toLowerCase()) &&
        lower.includes(tokenOut.toLowerCase()),
      "the relay lists BOTH sides of the pair as tradable, published by a solver holding neither",
      openingTokens,
    );
    assert(
      BigInt(openingQuote.amountOut) === OFFER_GIVE,
      "the relay's quote traces to the maker offer's whole-rung terms (non-empty price levels)",
      { amountIn: OFFER_WANT.toString(), amountOut: openingQuote.amountOut, rung: OFFER_GIVE.toString() },
    );
    record("06-unfunded-ladder", {
      relayTokens: openingTokens,
      quote: openingQuote,
      amountIn: OFFER_WANT.toString(),
      expectedRungOutput: OFFER_GIVE.toString(),
      solverShieldedAtProvisioning: provisionReceipt?.solverShielded ?? null,
    });
  }

  const specs: CaseSpec[] = [
    { label: "A", title: "exact-advertised", demand: { num: 1n, den: 1n }, expect: "settle" },
    { label: "B", title: "lower exact-output (P4-F01 at the real boundary)", demand: CASE_B, expect: "settle" },
    { label: "C", title: "above-advertised refusal", demand: CASE_C, expect: "refuse" },
    // D is C's control, and it is what makes C a proof rather than a
    // coincidence: it settles the very offer C was refused against, at the
    // advertised output, from the same taker against the same ladder. Without
    // it, "the relay refused" and "the relay was not accepting anything right
    // then" are the same observation.
    { label: "D", title: "exact-advertised control on the offer case C was refused against", demand: { num: 1n, den: 1n }, expect: "settle" },
  ].filter((s) => CASES.includes(s.label));

  const results: CaseResult[] = [];
  let expectedSurplus = 0n;
  for (const spec of specs) {
    const result = await runCase(spec, { tokenIn, tokenOut }, undefined);
    results.push(result);
    expectedSurplus += BigInt(result.expectedSolverSurplusTokenOut);
  }

  // ── global: no leaked claim anywhere ───────────────────────────────────────
  log("");
  log("══ GLOBAL — no leaked claim, bounded terminals ═════════════════════════");
  const journal = readJournal();
  record("90-journal-after", journal);
  const nonTerminal = journal.filter((r) => !TERMINAL_LIFECYCLE.has(r.lifecycle_state));
  assert(
    nonTerminal.length === 0,
    "no journal operation is left in a non-terminal state (a leaked Stock claim's durable shadow)",
    nonTerminal.map((r) => `${r.job_id.slice(0, 8)}/${r.operation_kind}=${r.lifecycle_state}`),
  );
  const quarantined = journal.filter((r) => r.lifecycle_state === "QUARANTINED");
  assert(quarantined.length === 0, "no journal operation is QUARANTINED", quarantined.length);
  // The journal is a persistent, chain-keyed volume: it may already hold rows
  // from an earlier driver run against this same chain. Only the rows THIS run
  // added are attributable to this run's cases — "no more" has to be measured
  // against the snapshot taken before the first case, not against zero.
  const priorJobs = new Set(journalAtStart.map((r) => r.job_id));
  const perJob = new Map<string, number>();
  for (const row of journal) {
    if (priorJobs.has(row.job_id)) continue;
    perJob.set(row.job_id, (perJob.get(row.job_id) ?? 0) + 1);
  }
  const dispatched = results
    .filter((r) => r.jobId !== undefined)
    .map((r) => r.jobId as string)
    .sort();
  assert(
    [...perJob.keys()].sort().join(",") === dispatched.join(","),
    "the journal gained rows for exactly this run's dispatched jobs, and no others",
    { newJobs: [...perJob.keys()].sort(), dispatched, priorJobs: [...priorJobs] },
  );
  assert(
    [...perJob.values()].every((n) => n > 0 && n <= 16),
    "journal rows per job are bounded",
    [...perJob.values()],
  );
  // A refused case must leave no durable trace at all.
  for (const refused of results.filter((r) => r.expect === "refuse")) {
    assert(
      refused.journalRows.length === 0,
      `the refused case ${refused.label} left no journal row`,
      refused.journalRows.length,
    );
  }
  // Claim payouts are the durable shadow of a Stock reservation. Every row must
  // have released, whatever it reserved.
  const holdingPayouts = journal.filter(
    (r) => !TERMINAL_LIFECYCLE.has(r.lifecycle_state) && r.claim_payouts_json !== "{}",
  );
  assert(
    holdingPayouts.length === 0,
    "no non-terminal journal row still carries a claim payout",
    holdingPayouts.map((r) => `${r.operation_kind}=${r.lifecycle_state}:${r.claim_payouts_json}`),
  );

  const finalBook = await KERNEL.liveOffers();
  record("91-kernel-book-after", finalBook.map(describeOffer));
  record("92-relay-tokens-after", await relayTokens());

  // ── design-note §6 — the live-chain half of the fee model ──────────────────
  // Everything else about capital-free fee sizing was measured offline against
  // the ledger WASM. These are the numbers that need a running chain, because
  // `dust.balanceTransactions` prices with `syncService.blockData()`'s LIVE
  // `ledgerParameters`, which do not exist off-chain.
  const allDust = readDustReservations();
  record("93-dust-reservations", allDust);
  const settled = results.filter((r) => r.expect === "settle");
  const offlineHere = await offlineStandInFee(tokenIn, tokenOut, 1);
  const feeFacts = {
    modelledTakerInputs: FEE_SIZING_TAKER_INPUTS,
    /** R1's offline prediction for n = 1 over the merged transaction, taken
     *  with `LedgerParameters.initialParameters()`. The live chain's parameters
     *  may differ; the delta is the point of recording both. */
    offlinePredictionSpecksAtN1: "2779466641196585",
    /** The same shape priced right here, in this image, with
     *  `initialParameters()` — see `offlineStandInFee`. The stand-in ALONE, not
     *  merged with the maker offers, so it is smaller than the reservation by
     *  the rest of the merged transaction; its value is that it isolates the
     *  parameter difference from the shape difference. */
    offlineStandInHereAtN1: offlineHere,
    ledgerCostParams: {
      dustFeeOverheadSpecks: DUST_FEE_OVERHEAD.toString(),
      dustFeeBlocksMargin: DUST_FEE_BLOCKS_MARGIN,
    },
    dustAdmissionConfigured: allDust.length > 0,
    perJob: settled.map((r) => ({
      case: r.label,
      jobId: r.jobId,
      txId: r.txId,
      reservedDustSpecks: r.feeSizing.reservedDustSpecks,
      dustReservationState: r.feeSizing.dustReservationState,
      modelledTakerInputs: r.feeSizing.modelledTakerInputs,
      takerHalfBytes: r.feeSizing.takerHalfBytes,
      acceptedFirstTry: r.feeSizing.acceptedFirstTry,
      jobStatusTrail: r.feeSizing.jobStatusTrail,
      journalErrorCodes: r.feeSizing.journalErrorCodes,
      submitFailureCodes: r.feeSizing.submitFailureCodes,
    })),
    distinctReservedAmounts: [
      ...new Set(settled.map((r) => r.feeSizing.reservedDustSpecks).filter(Boolean)),
    ],
    distinctTakerHalfBytes: [...new Set(settled.map((r) => r.feeSizing.takerHalfBytes))],
    everySettlementAcceptedFirstTry: settled.every((r) => r.feeSizing.acceptedFirstTry),
  };
  record("94-fee-sizing-chain-facts", feeFacts);
  log("");
  log("══ DESIGN-NOTE §6 — live-chain fee-sizing facts ════════════════════════");
  log(`modelledTakerInputs in force : ${feeFacts.modelledTakerInputs}`);
  for (const j of feeFacts.perJob) {
    log(
      `case ${j.case}: reservedDust=${j.reservedDustSpecks ?? "n/a"} SPECKs (${j.dustReservationState ?? "-"}) ` +
        `takerHalf=${j.takerHalfBytes} bytes acceptedFirstTry=${j.acceptedFirstTry}`,
    );
  }
  log(`offline prediction at n=1 (initialParameters): ${feeFacts.offlinePredictionSpecksAtN1} SPECKs`);
  log(`offline stand-in priced HERE at n=1: ${JSON.stringify(offlineHere)}`);
  for (const amount of feeFacts.distinctReservedAmounts) {
    const live = BigInt(amount as string);
    const delta = live - BigInt(feeFacts.offlinePredictionSpecksAtN1);
    log(
      `  live ${amount} → delta vs offline = ${delta >= 0n ? "+" : ""}${delta} SPECKs ` +
        `(structural part after the ${DUST_FEE_OVERHEAD} flat overhead: ${live - DUST_FEE_OVERHEAD})`,
    );
  }
  assert(
    settled.length === 0 || feeFacts.everySettlementAcceptedFirstTry,
    "every settlement was accepted FIRST TRY — the offline-sized DUST estimate never underfunded the chain",
    feeFacts.perJob.map((j) => `${j.case}:${j.acceptedFirstTry}`),
  );
  if (REQUIRE_UNFUNDED_SOLVER) {
    assert(
      settled.length > 0 && settled.every((r) => r.feeSizing.reservedDustSpecks !== null),
      "every settled job journalled a live-chain DUST reservation (design-note §6 number 1)",
      feeFacts.perJob.map((j) => `${j.case}:${j.reservedDustSpecks ?? "MISSING"}`),
    );
  }

  const summary = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    tokenIn,
    tokenOut,
    cases: results.map((r) => ({
      label: r.label,
      title: r.title,
      expect: r.expect,
      passed: r.passed,
      amountIn: r.amountIn,
      quotedOut: r.quotedOut,
      demandedOut: r.demandedOut,
      takerDeltaTokenIn: r.takerDeltaTokenIn,
      takerDeltaTokenOut: r.takerDeltaTokenOut,
      offerId: r.offerId,
      offerStatusAfter: r.offerStatusAfter,
      jobId: r.jobId,
      jobStatus: r.jobStatus,
      txId: r.txId,
      reason: r.reason,
      intentStatus: r.intentStatus,
      feeSizing: r.feeSizing,
    })),
    unfundedSolver: REQUIRE_UNFUNDED_SOLVER
      ? {
          required: true,
          receipt: provisionReceipt,
          feeSizingChainFacts: feeFacts,
        }
      : { required: false },
    // The solver holds SOLVER_SEED and this driver must not open a second
    // facade on it (two facades on one seed against one node force each
    // other's connection down). The expected delta is recorded here and
    // asserted by deploy/scripts/read-wallet.ts once the solver is stopped.
    expectedSolverSurplusTokenOut: expectedSurplus.toString(),
    failures,
  };
  record("99-summary", summary);
  log("");
  log(`══ SUMMARY ════════════════════════════════════════════════════════════`);
  for (const c of summary.cases) {
    log(
      `case ${c.label} ${c.passed ? "PASS" : "FAIL"} — ${c.title}: amountIn=${c.amountIn} quote=${c.quotedOut} demand=${c.demandedOut} ` +
        `takerΔout=${c.takerDeltaTokenOut} takerΔin=${c.takerDeltaTokenIn} offer=${c.offerStatusAfter} job=${c.jobStatus}`,
    );
  }
  log(`expected solver surplus (tokenOut): ${expectedSurplus}`);
  if (failures.length > 0) {
    log(`FAILED — ${failures.length} assertion(s):`);
    for (const f of failures) log(`  - ${f}`);
    exitCode = 1;
  } else {
    log("ALL ASSERTIONS PASSED");
    exitCode = 0;
  }
} catch (err) {
  log(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  record("98-fatal", { error: String(err) });
  exitCode = 1;
} finally {
  for (const w of [taker, genesis]) {
    await (w?.wallet as { stop?: () => Promise<void> } | undefined)?.stop?.().catch(() => {});
  }
}
process.exit(exitCode);
