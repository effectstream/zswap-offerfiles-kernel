// The solver's read-only status snapshot, as a VERSIONED contract (00007 FR-003).
//
// This file is types and constants only: no IO, no clock, no solver import. It
// lives in `solver-core` rather than in `packages/solver` for one reason — the
// monitor site (`packages/solver-frontend`, 00007 PR-B) consumes the snapshot
// and must be able to name its shape without importing the trading process's
// source. Both sides compile against this file and nothing else.
//
// THE RULES THE SHAPE ENCODES:
//
//   1. **JSON-safe by construction.** No `bigint` and no `Date` appears
//      anywhere below. Every amount is a `DecimalString` (canonical base-10, no
//      separators, no sign for the amounts the solver publishes) and every
//      instant is epoch milliseconds as a `number`. `JSON.stringify` of a
//      `StatusSnapshot` therefore cannot throw, and a browser can render it
//      without a bigint polyfill. Amounts stay BASE UNITS everywhere — the
//      solver, the relay wire and the journal are base-unit only, and the page
//      is what applies `decimals` from the kernel's token registry.
//   2. **Sectioned degradation (FR-005).** Every top-level section is
//      `Section<T>`: either the section, or `{ error }`. Collecting a section
//      that throws must not cost the operator the other nine, so the collector
//      catches per section and the reader narrows with `isStatusSectionError`.
//   3. **Bounded (FR-005).** The caps are part of the contract, not an
//      implementation detail, because the page has to say "500 of 12 480
//      offers" rather than silently showing a prefix. They are exported below
//      and echoed in the sections that apply them.
//   4. **Secret-free (FR-006).** There is no field for the seed, for any bearer
//      value, for wallet keys, or for journal wallet artifact bytes. The relay
//      bearer appears only as `relayAuthTokenLength`, exactly as the startup
//      banner prints it, and a journal row carries
//      `walletArtifactByteLength` instead of the artifact. A field that cannot
//      be named cannot be leaked by a future collector edit.
//   5. **Not-started is a state, not an error.** A dry-run solver runs no relay
//      client and no executor; those sections report `"not-started"` rather
//      than degrading, so the page can say "not started (dry-run)" instead of
//      painting a red alarm over a deliberately reduced process.
//
// VERSIONING. `statusContractVersion` is a single integer carried in every
// snapshot as `contractVersion`. A consumer that sees a version it does not
// know must say so rather than guess; additive optional fields do not bump it,
// a removal or a meaning change does.

/** Bumped only by a removal or a semantic change, never by an additive field. */
export const statusContractVersion = 1;

/** Canonical base-10 integer string. Amounts are BASE UNITS, never coins. */
export type DecimalString = string;

/** Epoch milliseconds. The snapshot carries the solver's own `now` so a page
 *  can compute "N s ago" without trusting the browser clock (FR-013). */
export type EpochMs = number;

// ── sectioned degradation (FR-005) ──────────────────────────────────────────

export interface StatusSectionError {
  /** One line naming what failed. Never a stack: the page renders it inline. */
  error: string;
}

/** A section is its value, or the record of why that value is missing. */
export type Section<T> = T | StatusSectionError;

/** Narrowing guard. Deliberately structural (`error` is a string) so a section
 *  whose own shape happens to be an object is never mistaken for a failure. */
export function isStatusSectionError(value: unknown): value is StatusSectionError {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

// ── contract-level caps (FR-005) ────────────────────────────────────────────

/** Book offers carried per snapshot; the remainder is reported as `truncated`. */
export const STATUS_BOOK_OFFER_CAP = 500;
/** Newest journal rows carried per snapshot (Q-S-4 option B). */
export const STATUS_JOURNAL_ROW_CAP = 100;
/** Relay diagnostic events retained in the ring buffer. */
export const STATUS_EVENT_RING_CAP = 200;
/** Concurrent `/status/stream` clients the listener accepts. */
export const STATUS_STREAM_CLIENT_CAP = 32;
/** State changes are coalesced to at most one frame per this interval. */
export const STATUS_STREAM_COALESCE_MS = 250;
/** A frame is sent at least this often, so a dead connection is detectable. */
export const STATUS_STREAM_HEARTBEAT_MS = 5_000;
/**
 * How long one `/status/stream` connection is served before the listener closes
 * it and the client is expected to reconnect.
 *
 * This exists because Bun 1.3.11 does not report an SSE client's disconnect to
 * the server AT ALL — `request.signal` never aborts, the stream's `cancel()`
 * never runs, and `enqueue` keeps succeeding into a closed socket (measured
 * 2026-09-03). Without a lifetime, a browser that simply navigated away would
 * hold its slot against `STATUS_STREAM_CLIENT_CAP` forever, and after 32 page
 * loads the listener would refuse every real client. A bounded lifetime makes
 * the cap self-healing without depending on the runtime noticing anything.
 *
 * Consumers MUST therefore treat an ended stream as normal and reconnect (the
 * monitor site does this already — 00007 FR-015).
 */
export const STATUS_STREAM_MAX_LIFETIME_MS = 300_000;
/** `SOLVER_STATUS_AUTH_TOKEN` minimum length — the relay's own bearer rule. */
export const SOLVER_STATUS_MIN_TOKEN_LENGTH = 32;

// ── process ─────────────────────────────────────────────────────────────────

/** `live` executes relay jobs; `dry-run` starts neither relay client nor
 *  executor and is a rehearsal of the same configuration. */
export type SolverRunMode = "live" | "dry-run";

export interface StatusProcess {
  startedAt: EpochMs;
  uptimeMs: number;
  /** `MIDNIGHT_NETWORK_ID` as the SDK resolved it. */
  network: string;
  /** Kernel Offer Files REST/SSE base, normalized. */
  api: string;
  /** Relay solver socket. The launch resolver refuses embedded credentials, so
   *  this is safe to render whole. `null` in dry-run when none was supplied. */
  relayWsUrl: string | null;
  /** Relay public HTTP base for durable `GET /jobs/:jobId`. */
  relayHttpUrl: string | null;
  /** FR-006: the LENGTH of the relay bearer, never the bearer. */
  relayAuthTokenLength: number;
  mode: SolverRunMode;
  solverEnabled: boolean;
  /** Build provenance when the deployment supplied it (`GIT_COMMIT`). */
  gitCommit: string | null;
  /** Bun's own version, so a snapshot names the runtime it came from. */
  runtime: string | null;
}

// ── backend currentness ─────────────────────────────────────────────────────

/**
 * `BackendCurrentnessState` from `packages/solver/src/book-sync.ts`, VERBATIM
 * (FR-003) but declared structurally so this pure module keeps no dependency on
 * the solver package. `reason` is the blocked-reason string the solver itself
 * reports (`snapshot-failed`, `stream-disconnected`, `health-stale`, …) and the
 * page shows it as-is rather than re-wording it.
 */
export type StatusBackendCurrentness =
  | { kind: "blocked"; reason: string; streamGeneration: number }
  | { kind: "current"; streamGeneration: number; backendBlockL2: string; healthTs: number };

export interface StatusBackend {
  currentness: StatusBackendCurrentness;
  /** The solver's own usable-currentness boolean, which also goes false on stop. */
  isCurrent: boolean;
}

// ── book cache ──────────────────────────────────────────────────────────────

export type StatusLegKind = "SHIELDED" | "UNSHIELDED";

export interface StatusBookLeg {
  token: string;
  amount: DecimalString;
  kind: StatusLegKind;
}

export interface StatusBookOffer {
  offerHash: string;
  gives: StatusBookLeg[];
  wants: StatusBookLeg[];
  expiresAt: EpochMs | null;
  firstSeenAt: EpochMs | null;
  /** The count only: the nullifiers themselves are coin identities and add
   *  nothing an operator can act on. */
  inputNullifierCount: number;
}

export interface StatusBookPair {
  giveToken: string;
  wantToken: string;
  offers: number;
}

export interface StatusBook {
  /** Offers in the solver's cache, before the cap. */
  size: number;
  pairs: StatusBookPair[];
  /** Newest-expiry-last, capped at `cap`; sorted by offer hash for stability. */
  offers: StatusBookOffer[];
  cap: number;
  /** `size - offers.length`. Non-zero means the page is showing a prefix. */
  truncated: number;
}

// ── inventory ───────────────────────────────────────────────────────────────

export interface StatusInventoryToken {
  token: string;
  balance: DecimalString;
  reserved: DecimalString;
  available: DecimalString;
}

export interface StatusInventory {
  /** False whenever balance authority is withdrawn — including the deliberate
   *  emptying while a refresh is in flight or the backend is blocked. */
  ready: boolean;
  refreshing: boolean;
  /** Balance reads that ignored cancellation and are still observed. */
  retainedOperations: number;
  tokens: StatusInventoryToken[];
}

// ── relay client ────────────────────────────────────────────────────────────

export type StatusEventSeverity = "info" | "warn" | "error";

export interface StatusRelayEvent {
  /** Monotonic within one process run, so a page can detect a missed frame. */
  seq: number;
  at: EpochMs;
  kind: string;
  severity: StatusEventSeverity;
  message: string;
  /** The event's own `detail`, flattened to JSON-safe scalars. */
  detail?: Record<string, string | number | boolean | null>;
  /**
   * Consecutive repeats folded into this entry (same kind, severity and
   * message), `at` being the FIRST occurrence and `lastAt` the latest. The
   * push loop emits one `push` per second, so without folding the ring held
   * ~3 minutes of identical rows and evicted every meaningful event within
   * 200 s. Absent means the entry occurred once. `eventsObserved` still counts
   * every occurrence.
   */
  count?: number;
  lastAt?: EpochMs;
}

export interface StatusRelayStats {
  connected: boolean;
  connections: number;
  pushes: number;
  coalesced: number;
  pushFailures: number;
  withdrawn: boolean;
  stopped: boolean;
}

export interface StatusRelay {
  /** `not-started` is the dry-run state, not a fault. */
  state: "not-started" | "running";
  stats: StatusRelayStats | null;
  /** The most recent event of each kind, so a page can show "last disconnect"
   *  without scanning the ring. Keyed by `RelayClientEventKind`. */
  lastEventByKind: Record<string, StatusRelayEvent>;
  /** Oldest first, capped at `eventCap`. */
  events: StatusRelayEvent[];
  eventCap: number;
  /** Every event observed since start, including those the ring dropped. */
  eventsObserved: number;
}

// ── the last derived ladder push ────────────────────────────────────────────

export interface StatusLadderRung {
  input: DecimalString;
  output: DecimalString;
  /** The maker offer whose WHOLE consumption closes this rung. */
  offerHash: string;
}

export interface StatusLadderPairProvenance {
  tokenIn: string;
  tokenOut: string;
  /** Rung order = consumption order = best marginal rate first. */
  rungs: StatusLadderRung[];
  /** Most tokenOut any interpolated size between rungs can require. */
  residualBound: DecimalString;
}

export interface StatusLadderLevel {
  input: DecimalString;
  output: DecimalString;
}

export interface StatusLadderPair {
  tokenIn: string;
  tokenOut: string;
  levels: StatusLadderLevel[];
}

export interface StatusLadderExclusion {
  offerHash: string;
  /** `LadderExclusionReason` verbatim: `multi-leg`, `non-shielded-leg`,
   *  `unavailable`, `rung-cap`, `residual-budget`, `invalid-pair`, … */
  reason: string;
  /** Present for `invalid-pair`: the schema's verdict. */
  detail?: string;
}

export interface StatusLadderPush {
  derivedAt: EpochMs;
  /** Why this push ran: `tick`, `connect`, `manual`, `coalesced`. */
  cause: string;
  /** Non-null means this push is the fail-closed EMPTY withdrawal and the
   *  string is why (`cache-not-current`). The page must say so explicitly
   *  rather than showing an empty ladder as "no liquidity". */
  withheld: string | null;
  tokenIds: string[];
  maxParallelSwaps: number | null;
  levels: StatusLadderPair[];
  provenance: StatusLadderPairProvenance[];
  excluded: StatusLadderExclusion[];
  pairs: number;
  rungs: number;
}

export interface StatusLadder {
  /** `not-started` in dry-run; `never-derived` before the first push. */
  state: "not-started" | "never-derived" | "derived";
  last: StatusLadderPush | null;
}

// ── swap job executor ───────────────────────────────────────────────────────

export interface StatusExecutorStats {
  building: number;
  quarantined: number;
  awaitingRelay: number;
  awaitingConsumption: number;
  completed: number;
  refused: number;
  reverted: number;
  revertFailures: number;
  timedOutBuilds: number;
  stopped: boolean;
}

export interface StatusExecutor {
  state: "not-started" | "running";
  stats: StatusExecutorStats | null;
  /** Offers claimed by an in-flight fill: the real source of the ladder's
   *  `unavailable` exclusions. */
  unavailableOfferHashes: string[];
  /** False while the rolling DUST window refuses new jobs — which withdraws
   *  every ladder, so it explains an empty push that is not `cache-not-current`. */
  dustAvailable: boolean | null;
}

// ── durable operation journal ───────────────────────────────────────────────

export interface StatusJournalReceipt {
  relayJobId?: string;
  relayState?: string;
  relayExtrinsicHash?: string;
  ledgerTxHash?: string;
  ledgerHeight?: number;
}

/**
 * One journal row as the operator needs it (Q-S-4 option B).
 *
 * STRIPPED, deliberately: `walletArtifactBytes` (serialised transactions —
 * FR-006) becomes a byte length, and the claim's `inputs` (coin nullifiers)
 * become a count. Payouts stay: they are what the row's economics are.
 */
export interface StatusJournalRow {
  id: number;
  operationKey: string;
  jobId: string;
  generation: number;
  operationKind: string;
  lifecycleState: string;
  offerHashes: string[];
  claimInputCount: number;
  payouts: Record<string, DecimalString>;
  walletArtifactKind: string | null;
  /** Byte length of the retained artifact, or null when the row has none. */
  walletArtifactByteLength: number | null;
  receipt: StatusJournalReceipt;
  errorCode: string | null;
  errorDetail: string | null;
  retryCount: number;
  nextRetryAtMs: EpochMs | null;
  ttlExpiresAtMs: EpochMs;
  deadlineAtMs: EpochMs;
  createdAtMs: EpochMs;
  updatedAtMs: EpochMs;
}

export interface StatusJournalDustUsage {
  /** False when the DUST admission group is intentionally OPEN (Q-RF-2). */
  configured: boolean;
  maxPerJob: DecimalString | null;
  maxPerWindow: DecimalString | null;
  windowMs: number | null;
  /** Spend counted against the current rolling window. */
  usage: DecimalString | null;
  reservations: {
    reserved: number;
    spent: number;
    released: number;
  };
}

export interface StatusJournal {
  /** `not-opened` in dry-run — a dry-run solver owns no journal. */
  state: "not-opened" | "open";
  path: string | null;
  /** NEWEST FIRST, capped at `rowCap`. */
  rows: StatusJournalRow[];
  rowCap: number;
  /** Rows retained in the journal, before the cap. */
  total: number;
  /** `JournalLifecycleState` → count, over the whole journal, not the tail. */
  countsByState: Record<string, number>;
  dust: StatusJournalDustUsage | null;
}

// ── admission policy, as configured ─────────────────────────────────────────

export interface StatusAdmission {
  /** `null` means the group is intentionally OPEN (Q-RF-2), which the page
   *  must show as a warning rather than as "no restrictions". */
  supportedPairs: string[] | null;
  minJobOutput: Record<string, DecimalString> | null;
  dust: {
    maxPerJob: DecimalString;
    maxPerWindow: DecimalString;
    windowMs: number;
  } | null;
  /** The names of the groups that are OPEN, as the startup warning prints them. */
  openGroups: string[];
  /** 00006 FR-001 — how many taker zswap inputs fee sizing models. */
  feeSizingTakerInputs: number;
  expiryMarginSeconds: number;
  pushIntervalMs: number;
  maxParallelSwaps: number;
  maxRungsPerPair: number | null;
  maxPairs: number | null;
  settleTtlMinutes: number | null;
}

// ── the listener's own counters ─────────────────────────────────────────────

export interface StatusListener {
  host: string;
  port: number;
  startedAt: EpochMs;
  healthRequests: number;
  snapshotRequests: number;
  streamRequests: number;
  /** FR-002: 401s on `/status/*`, counted so a page can show credential drift. */
  unauthorizedRequests: number;
  /** Every refused route: 404 for an unknown path, 405 for a write method on a
   *  known one. The listener has no mutating route, so a rising count here on a
   *  deployed solver means something is probing it. */
  notFoundRequests: number;
  streamClients: number;
  streamClientCap: number;
  /** Frames dropped because a client's buffer was full (FR-005). */
  streamFramesDropped: number;
  /** Connections refused because `streamClientCap` was already reached. */
  streamClientsRejected: number;
}

// ── the snapshot ────────────────────────────────────────────────────────────

export interface StatusSnapshot {
  contractVersion: typeof statusContractVersion;
  /** The SOLVER's clock. Every "ago" on the page is computed from this. */
  now: EpochMs;
  process: Section<StatusProcess>;
  backend: Section<StatusBackend>;
  book: Section<StatusBook>;
  inventory: Section<StatusInventory>;
  relay: Section<StatusRelay>;
  ladder: Section<StatusLadder>;
  executor: Section<StatusExecutor>;
  journal: Section<StatusJournal>;
  admission: Section<StatusAdmission>;
  listener: Section<StatusListener>;
}

/**
 * `GET /health`'s body (FR-002).
 *
 * Deliberately tiny and UNAUTHENTICATED: a container healthcheck must not need
 * the bearer, so this route carries nothing internal — no hosts, no counts, no
 * token length. `ready` is the solver's combined readiness, not liveness.
 */
export interface StatusHealth {
  status: "ok";
  ready: boolean;
  mode: SolverRunMode;
  contractVersion: typeof statusContractVersion;
}
