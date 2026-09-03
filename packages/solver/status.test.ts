/**
 * 00007 FR-003 / FR-005 / FR-006 — the read-only status collector.
 *
 * The three properties these tests exist to hold down, in order of how badly a
 * regression would hurt:
 *
 *   FR-006 — the snapshot carries no secret. Asserted by building a snapshot
 *   from seams seeded with KNOWN secret strings (a seed, both bearers, a wallet
 *   key, and a journal artifact whose bytes spell a secret) and grepping the
 *   serialised JSON for each one. A shape-by-shape review would not survive a
 *   future field being added; a grep does.
 *
 *   FR-005 — a section that throws costs that section and nothing else. The
 *   page exists to work when things are broken, so a snapshot that 500s
 *   because one seam is mid-teardown would fail exactly when it is needed.
 *
 *   FR-003 — the snapshot is JSON-safe and BOUNDED. No `bigint` may reach
 *   `JSON.stringify`, and a huge book, a long journal and a chatty relay must
 *   all be capped with the drop reported rather than hidden.
 *
 * Everything below drives the collector through its declared seams: a real
 * in-memory journal (so `listRecent`'s redaction is proven end to end) and
 * plain object doubles for the rest.
 */
import { describe, expect, test } from "bun:test";

import type { ApiZswap } from "@zswap-da/solver-core/api-client";
import {
  isStatusSectionError,
  STATUS_BOOK_OFFER_CAP,
  STATUS_EVENT_RING_CAP,
  STATUS_JOURNAL_ROW_CAP,
  statusContractVersion,
  type Section,
  type StatusSnapshot,
} from "@zswap-da/solver-core/status-contract";

import { Book, bookOfferFromApi } from "./src/book.ts";
import { deriveLadderPush } from "./src/ladder-source.ts";
import { SolverOperationJournal } from "./src/operation-journal.ts";
import type { RelayLadderPushRecord } from "./src/relay-client.ts";
import { Stock } from "./src/stock.ts";
import {
  createStatusCollector,
  type StatusCollector,
  type StatusCollectorDependencies,
  type StatusExecutorLike,
  type StatusInventoryLike,
  type StatusJournalLike,
  type StatusRelayLike,
  type StatusSyncLike,
  type StatusTimers,
} from "./src/status.ts";

// ── known secrets. Nothing below may ever reach a serialised snapshot ────────

const SEED = "deadbeef".repeat(8);
const RELAY_BEARER = `relay-bearer-${"r".repeat(24)}`;
const STATUS_BEARER = `status-bearer-${"s".repeat(24)}`;
const WALLET_KEY = `wallet-secret-key-${"k".repeat(24)}`;
const ARTIFACT_SECRET = "PROVED-TRANSACTION-SECRET-BYTES";
const SECRETS = [SEED, RELAY_BEARER, STATUS_BEARER, WALLET_KEY, ARTIFACT_SECRET];

const A = `01${"00".repeat(31)}`;
const B = `02${"00".repeat(31)}`;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const EXPIRES = "2026-06-01T13:00:00.000Z";
const N1 = "31".repeat(32);
const N2 = "32".repeat(32);
const H1 = "11".repeat(32);
const H2 = "22".repeat(32);
const TOKEN_A = "aa".repeat(32);

const hash = (byte: string): string => byte.repeat(32);

const row = (
  offerId: string,
  gives: { token: string; amount: string },
  wants: { token: string; amount: string },
  firstSeenAt = "2026-06-01T11:00:00.000Z",
): ApiZswap =>
  ({
    version: 1,
    offerId,
    computed: {
      gives: [{ token: gives.token, amount: gives.amount, type: "SHIELDED" }],
      wants: [{ token: wants.token, amount: wants.amount, type: "SHIELDED" }],
      expiresAt: EXPIRES,
      firstSeenAt,
      inputNullifiers: [offerId],
      status: "live",
    },
  }) as ApiZswap;

/** `count` single-leg A→B offers, all at marginal rate 1.0 so the ladder's tie
 *  rule (ascending content address) fixes the rung order, and with strictly
 *  descending `firstSeenAt` so "newest first" is observable. */
const offerIdAt = (index: number): string => index.toString(16).padStart(64, "0");

const seededBook = (count = 3): Book => {
  const book = new Book();
  for (let index = 0; index < count; index += 1) {
    book.upsert(bookOfferFromApi(row(
      offerIdAt(index),
      { token: A, amount: String(10 + index) },
      { token: B, amount: String(10 + index) },
      new Date(NOW - index * 1_000).toISOString(),
    ))!);
  }
  return book;
};

// ── a manual clock, so coalescing is asserted rather than slept through ──────

class ManualTimers {
  #entries: Array<{ id: number; at: number; fn: () => void }> = [];
  #nextId = 1;
  now = 1_000;

  readonly timers: StatusTimers = {
    setTimeout: (fn, ms) => {
      const id = this.#nextId++;
      this.#entries.push({ id, at: this.now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      this.#entries = this.#entries.filter((entry) => entry.id !== handle);
    },
  };

  get pending(): number {
    return this.#entries.length;
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.#entries
        .filter((entry) => entry.at <= this.now)
        .sort((left, right) => left.at - right.at || left.id - right.id);
      if (due.length === 0) return;
      const fired = new Set(due.map((entry) => entry.id));
      this.#entries = this.#entries.filter((entry) => !fired.has(entry.id));
      for (const entry of due) entry.fn();
    }
  }
}

// ── doubles ─────────────────────────────────────────────────────────────────

const syncOf = (book: Book, current = true): StatusSyncLike => ({
  book,
  isCurrent: () => current,
  currentness: () => current
    ? { kind: "current", streamGeneration: 4, backendBlockL2: "0x2a", healthTs: NOW - 500 }
    : { kind: "blocked", reason: "stream-disconnected", streamGeneration: 4 },
});

const inventoryOf = (ready = true): StatusInventoryLike => ({
  isReady: () => ready,
  isRefreshing: () => false,
  retainedOperations: () => 0,
});

const relayOf = (record: RelayLadderPushRecord | null): StatusRelayLike => ({
  stats: () => ({
    connected: true,
    connections: 2,
    pushes: 17,
    coalesced: 3,
    pushFailures: 1,
    withdrawn: false,
    stopped: false,
  }),
  lastPush: () => record,
});

const executorOf = (): StatusExecutorLike => ({
  stats: () => ({
    building: 1,
    quarantined: 0,
    awaitingRelay: 2,
    awaitingConsumption: 0,
    completed: 5,
    refused: 1,
    reverted: 0,
    revertFailures: 0,
    timedOutBuilds: 0,
    stopped: false,
  }),
  unavailableOfferHashes: () => [H1],
  dustAvailable: () => true,
});

const pushRecordFor = (book: Book): RelayLadderPushRecord => ({
  push: deriveLadderPush(
    { book, isCurrent: () => true },
    { nowMs: NOW, expiryMarginSeconds: 60, maxParallelSwaps: 8 },
  ),
  derivedAt: NOW,
  cause: "tick",
});

interface Fixture {
  collector: StatusCollector;
  clock: ManualTimers;
  book: Book;
  stock: Stock;
}

const baseDeps = (
  overrides: Partial<StatusCollectorDependencies> = {},
): StatusCollectorDependencies => ({
  process: {
    startedAt: NOW - 60_000,
    network: "undeployed",
    api: "http://kernel:9999",
    relayWsUrl: "ws://relay:8080/solver",
    relayHttpUrl: "http://relay:8080/api/v1",
    // FR-006: the LENGTH, never the value. The value is in scope in this file
    // precisely so the grep below can prove it did not leak.
    relayAuthTokenLength: RELAY_BEARER.length,
    mode: "live",
    solverEnabled: true,
    gitCommit: "abc1234",
    runtime: "bun 1.3.11",
  },
  admission: {
    supportedPairs: new Set([`${A}->${B}`]),
    minJobOutput: new Map([[TOKEN_A, 100n]]),
    dust: { maxPerJob: 5_000n, maxPerWindow: 50_000n, windowMs: 3_600_000 },
    openGroups: [],
    feeSizingTakerInputs: 1,
    expiryMarginSeconds: 120,
    pushIntervalMs: 1_000,
    maxParallelSwaps: 8,
    maxRungsPerPair: 20,
    maxPairs: null,
    settleTtlMinutes: 30,
  },
  sync: () => null,
  stock: () => null,
  inventory: () => null,
  relay: () => null,
  executor: () => null,
  journal: () => null,
  ready: () => true,
  nowMs: () => NOW,
  ...overrides,
});

function fixture(overrides: Partial<StatusCollectorDependencies> = {}): Fixture {
  const clock = new ManualTimers();
  const book = seededBook();
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000n, [B]: 2_000n });
  const collector = createStatusCollector(baseDeps({
    sync: () => syncOf(book),
    stock: () => stock,
    inventory: () => inventoryOf(),
    relay: () => relayOf(pushRecordFor(book)),
    executor: () => executorOf(),
    nowMs: () => clock.now,
    timers: clock.timers,
    ...overrides,
  }));
  return { collector, clock, book, stock };
}

/** Narrow a section or fail loudly with the recorded error. */
function ok<T>(value: Section<T>): T {
  if (isStatusSectionError(value)) throw new Error(`section degraded: ${value.error}`);
  return value;
}

const memoryJournal = (): SolverOperationJournal =>
  SolverOperationJournal.open({ path: ":memory:", allowMemory: true, nowMs: () => NOW });

// ── FR-003: shape, JSON-safety, and the not-started states ──────────────────

describe("status collector — the snapshot's shape (FR-003)", () => {
  test("a live solver reports every section, JSON-safe and versioned", () => {
    const { collector } = fixture();
    const snapshot = collector.snapshot();

    expect(snapshot.contractVersion).toBe(statusContractVersion);
    expect(snapshot.now).toBe(1_000);

    const process = ok(snapshot.process);
    expect(process.mode).toBe("live");
    expect(process.network).toBe("undeployed");
    expect(process.relayAuthTokenLength).toBe(RELAY_BEARER.length);
    expect(process.gitCommit).toBe("abc1234");

    // Backend currentness is carried VERBATIM, blocked reason string included.
    expect(ok(snapshot.backend).currentness).toEqual({
      kind: "current", streamGeneration: 4, backendBlockL2: "0x2a", healthTs: NOW - 500,
    });
    expect(ok(snapshot.backend).isCurrent).toBe(true);

    const book = ok(snapshot.book);
    expect(book.size).toBe(3);
    expect(book.truncated).toBe(0);
    expect(book.pairs).toEqual([{ giveToken: A, wantToken: B, offers: 3 }]);
    // Amounts are BASE UNITS as decimal strings, never JSON numbers.
    expect(book.offers[0]!.gives[0]!.amount).toBe("10");
    expect(typeof book.offers[0]!.gives[0]!.amount).toBe("string");
    // The nullifier COUNT, not the nullifiers.
    expect(book.offers[0]!.inputNullifierCount).toBe(1);

    const inventory = ok(snapshot.inventory);
    expect(inventory.ready).toBe(true);
    expect(inventory.tokens).toEqual([
      { token: A, balance: "1000", reserved: "0", available: "1000" },
      { token: B, balance: "2000", reserved: "0", available: "2000" },
    ]);

    const relay = ok(snapshot.relay);
    expect(relay.state).toBe("running");
    expect(relay.stats!.pushes).toBe(17);
    expect(relay.eventCap).toBe(STATUS_EVENT_RING_CAP);

    const ladder = ok(snapshot.ladder);
    expect(ladder.state).toBe("derived");
    expect(ladder.last!.cause).toBe("tick");
    expect(ladder.last!.withheld).toBeNull();
    expect(ladder.last!.pairs).toBe(1);
    expect(ladder.last!.rungs).toBe(3);
    // The provenance names the maker offer that CLOSES each rung — the single
    // most useful thing the page shows, and the reason FR-004 exists.
    expect(ladder.last!.provenance[0]!.rungs[0]!.offerHash).toBe(offerIdAt(0));
    expect(ladder.last!.provenance[0]!.residualBound).toBe("12");

    const executor = ok(snapshot.executor);
    expect(executor.state).toBe("running");
    expect(executor.stats!.completed).toBe(5);
    expect(executor.unavailableOfferHashes).toEqual([H1]);
    expect(executor.dustAvailable).toBe(true);

    const admission = ok(snapshot.admission);
    expect(admission.supportedPairs).toEqual([`${A}->${B}`]);
    expect(admission.minJobOutput).toEqual({ [TOKEN_A]: "100" });
    expect(admission.dust).toEqual({
      maxPerJob: "5000", maxPerWindow: "50000", windowMs: 3_600_000,
    });
    expect(admission.openGroups).toEqual([]);

    // The whole thing must serialise. A single bigint anywhere would throw.
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(JSON.stringify(snapshot)).not.toContain("n,");
  });

  test("a dry-run solver reports not-started, which is a state and not an alarm", () => {
    const collector = createStatusCollector(baseDeps({
      process: { ...baseDeps().process, mode: "dry-run" },
      sync: () => syncOf(seededBook()),
      stock: () => new Stock(),
      inventory: () => inventoryOf(false),
    }));
    const snapshot = collector.snapshot();

    expect(ok(snapshot.process).mode).toBe("dry-run");
    expect(ok(snapshot.relay).state).toBe("not-started");
    expect(ok(snapshot.relay).stats).toBeNull();
    expect(ok(snapshot.ladder)).toEqual({ state: "not-started", last: null });
    expect(ok(snapshot.executor).state).toBe("not-started");
    expect(ok(snapshot.executor).dustAvailable).toBeNull();
    expect(ok(snapshot.journal).state).toBe("not-opened");
    expect(ok(snapshot.journal).dust).toBeNull();
    // Nothing above is an `{ error }`: a deliberately reduced process must not
    // paint the page red. `listener` is excluded because nothing has bound in
    // this unit — its own degradation is asserted separately.
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "listener") continue;
      expect(isStatusSectionError(value)).toBe(false);
    }
  });

  test("a snapshot taken during startup reports the truth, not an error", () => {
    // Everything is null: this is what `/status/snapshot` answers between the
    // bind (FR-007, before the wallet) and the mirror starting.
    const collector = createStatusCollector(baseDeps({ ready: () => false }));
    const snapshot = collector.snapshot();
    expect(ok(snapshot.backend).currentness).toEqual({
      kind: "blocked", reason: "not-started", streamGeneration: 0,
    });
    expect(ok(snapshot.book).size).toBe(0);
    expect(ok(snapshot.inventory).ready).toBe(false);
    expect(ok(snapshot.ladder).state).toBe("not-started");
    expect(collector.health()).toEqual({
      status: "ok", ready: false, mode: "live", contractVersion: statusContractVersion,
    });
  });

  test("a withheld push is reported as the withdrawal it is", () => {
    const book = seededBook();
    const record: RelayLadderPushRecord = {
      push: deriveLadderPush({ book, isCurrent: () => false }, {
        nowMs: NOW, expiryMarginSeconds: 60, maxParallelSwaps: 8,
      }),
      derivedAt: NOW,
      cause: "tick",
    };
    const collector = createStatusCollector(baseDeps({ relay: () => relayOf(record) }));
    const ladder = ok(collector.snapshot().ladder);
    // The page must be able to say "this empty ladder IS the fail-closed
    // withdrawal", not "no liquidity".
    expect(ladder.last!.withheld).toBe("cache-not-current");
    expect(ladder.last!.levels).toEqual([]);
    expect(ladder.last!.tokenIds).toEqual([]);
  });

  test("health() reports readiness and survives a throwing readiness probe", () => {
    const { collector } = fixture();
    expect(collector.health().ready).toBe(true);
    const throwing = createStatusCollector(baseDeps({
      ready: () => { throw new Error("readiness exploded"); },
    }));
    // `/health` is what a container healthcheck hits; it may not 500.
    expect(throwing.health()).toEqual({
      status: "ok", ready: false, mode: "live", contractVersion: statusContractVersion,
    });
  });
});

// ── FR-005: caps ────────────────────────────────────────────────────────────

describe("status collector — bounded collection (FR-005)", () => {
  test("the book is capped and reports how much it dropped", () => {
    const book = seededBook(STATUS_BOOK_OFFER_CAP + 25);
    const collector = createStatusCollector(baseDeps({ sync: () => syncOf(book) }));
    const section = ok(collector.snapshot().book);

    expect(section.size).toBe(STATUS_BOOK_OFFER_CAP + 25);
    expect(section.offers.length).toBe(STATUS_BOOK_OFFER_CAP);
    expect(section.cap).toBe(STATUS_BOOK_OFFER_CAP);
    // Non-zero `truncated` is what lets the page say "500 of 525" rather than
    // silently rendering a prefix.
    expect(section.truncated).toBe(25);
    // Newest first: the offer an operator is diagnosing is the one that just
    // arrived, not the one that has been sitting there.
    expect(section.offers[0]!.firstSeenAt).toBeGreaterThan(section.offers[1]!.firstSeenAt!);
  });

  test("consecutive identical events fold into one ring entry with a count", () => {
    const { collector } = fixture();
    // 500 once-a-second pushes: the shape a live solver actually produces.
    for (let index = 0; index < 500; index += 1) {
      collector.recordRelayEvent({
        kind: "push",
        severity: "info",
        message: "pushed 1 pair(s)",
        detail: { pairs: 1, rungs: 1, tick: index },
      });
    }
    collector.recordRelayEvent({ kind: "disconnected", severity: "warn", message: "relay socket closed" });
    collector.recordRelayEvent({ kind: "push", severity: "info", message: "pushed 1 pair(s)" });
    const relay = ok(collector.snapshot().relay);
    // Three rows, not 502: the meaningful event is not evicted by the chatter.
    expect(relay.events.map((event) => event.kind)).toEqual(["push", "disconnected", "push"]);
    expect(relay.events[0]!.count).toBe(500);
    expect(relay.events[0]!.lastAt).toBeGreaterThanOrEqual(relay.events[0]!.at);
    // The folded row carries the LATEST detail, and every occurrence is counted.
    expect(relay.events[0]!.detail?.["tick"]).toBe(499);
    expect(relay.eventsObserved).toBe(502);
    // A single occurrence carries no count at all.
    expect(relay.events[2]!.count).toBeUndefined();
    // Only CONSECUTIVE repeats fold: the same message after another kind is a new row.
    expect(relay.events[2]!.seq).toBe(3);
    expect(relay.lastEventByKind["push"]!.seq).toBe(3);
  });

  test("the relay event ring is capped, and the total observed is still reported", () => {
    const { collector } = fixture();
    for (let index = 0; index < STATUS_EVENT_RING_CAP + 40; index += 1) {
      collector.recordRelayEvent({
        kind: index % 2 === 0 ? "push" : "disconnected",
        severity: "info",
        message: `event ${index}`,
      });
    }
    const relay = ok(collector.snapshot().relay);
    expect(relay.events.length).toBe(STATUS_EVENT_RING_CAP);
    // The COUNT survives the ring, so "the ring has dropped events" is visible.
    expect(relay.eventsObserved).toBe(STATUS_EVENT_RING_CAP + 40);
    // Oldest first, and the oldest surviving entry is the one after the drop.
    expect(relay.events[0]!.message).toBe("event 40");
    expect(relay.events.at(-1)!.message).toBe(`event ${STATUS_EVENT_RING_CAP + 39}`);
    // Monotonic sequence numbers let a page detect a frame it never saw.
    expect(relay.events[0]!.seq).toBe(41);

    // The last event of EACH kind survives the ring's own eviction policy, so
    // "when did it last disconnect" is answerable without scanning.
    expect(Object.keys(relay.lastEventByKind).sort()).toEqual(["disconnected", "push"]);
    expect(relay.lastEventByKind["disconnected"]!.message)
      .toBe(`event ${STATUS_EVENT_RING_CAP + 39}`);
  });

  test("an event detail is flattened to JSON scalars, bigints included", () => {
    const { collector } = fixture();
    collector.recordRelayEvent({
      kind: "push",
      severity: "info",
      message: "pushed 1 pair(s)",
      detail: {
        cause: "tick",
        pairs: 1,
        withheld: null,
        // A `detail` is typed `Record<string, unknown>`: one odd value must not
        // make the WHOLE snapshot unserialisable.
        amount: 42n,
        nested: { a: 1 },
        skipped: undefined,
      },
    });
    const relay = ok(collector.snapshot().relay);
    expect(relay.events[0]!.detail).toEqual({
      cause: "tick",
      pairs: 1,
      withheld: null,
      amount: "42",
      nested: "[object Object]",
    });
    expect(() => JSON.stringify(collector.snapshot())).not.toThrow();
  });

  test("the journal tail is capped at 100 rows while the counts cover everything", () => {
    const journal = memoryJournal();
    try {
      for (let index = 0; index < STATUS_JOURNAL_ROW_CAP + 5; index += 1) {
        journal.createPrepared({
          operationKey: `op-${String(index).padStart(4, "0")}`,
          jobId: `job-${index}`,
          generation: 1,
          offerHashes: [H1, H2],
          claim: { inputs: [N1, N2], payouts: { [TOKEN_A]: "10" } },
          operationKind: "JOB_SETTLEMENT",
          ttlExpiresAtMs: NOW + 60_000,
          deadlineAtMs: NOW + 30_000,
          receipt: {},
        });
      }
      const collector = createStatusCollector(baseDeps({ journal: () => journal }));
      const section = ok(collector.snapshot().journal);

      expect(section.state).toBe("open");
      expect(section.rows.length).toBe(STATUS_JOURNAL_ROW_CAP);
      expect(section.rowCap).toBe(STATUS_JOURNAL_ROW_CAP);
      // `total` and `countsByState` are over the WHOLE journal, not the tail.
      expect(section.total).toBe(STATUS_JOURNAL_ROW_CAP + 5);
      expect(section.countsByState["PREPARED"]).toBe(STATUS_JOURNAL_ROW_CAP + 5);
      expect(section.countsByState["SETTLED"]).toBe(0);
      // Newest first.
      expect(section.rows[0]!.operationKey)
        .toBe(`op-${String(STATUS_JOURNAL_ROW_CAP + 4).padStart(4, "0")}`);
    } finally {
      journal.close();
    }
  });

  test("DUST usage is reported against the configured window, and absent when OPEN", () => {
    const journal = memoryJournal();
    try {
      const collector = createStatusCollector(baseDeps({ journal: () => journal }));
      const dust = ok(collector.snapshot().journal).dust!;
      expect(dust.configured).toBe(true);
      expect(dust.maxPerWindow).toBe("50000");
      expect(dust.usage).toBe("0");
      expect(dust.reservations).toEqual({ reserved: 0, spent: 0, released: 0 });

      // Q-RF-2: an UNSET DUST group is intentionally OPEN. Usage is then absent
      // rather than 0 — there is no window to measure against, and showing "0"
      // would read as "configured and unused".
      const open = createStatusCollector(baseDeps({
        journal: () => journal,
        admission: { ...baseDeps().admission, dust: null, openGroups: ["SOLVER_DUST_*"] },
      }));
      const openDust = ok(open.snapshot().journal).dust!;
      expect(openDust.configured).toBe(false);
      expect(openDust.usage).toBeNull();
      expect(openDust.maxPerWindow).toBeNull();
      expect(ok(open.snapshot().admission).openGroups).toEqual(["SOLVER_DUST_*"]);
    } finally {
      journal.close();
    }
  });
});

// ── FR-005: sectioned degradation ───────────────────────────────────────────

describe("status collector — sectioned degradation (FR-005)", () => {
  test("one throwing seam costs one section and nothing else", () => {
    const book = seededBook();
    const collector = createStatusCollector(baseDeps({
      sync: () => syncOf(book),
      stock: () => new Stock(),
      inventory: () => inventoryOf(),
      journal: () => ({
        path: "/var/lib/cow-solver/operations.sqlite",
        listRecent: () => { throw new Error("database is closed"); },
        countsByState: () => ({}) as never,
        dustUsage: () => 0n,
        listDustReservations: () => [],
      } satisfies StatusJournalLike),
    }));
    const snapshot = collector.snapshot();

    expect(isStatusSectionError(snapshot.journal)).toBe(true);
    expect((snapshot.journal as { error: string }).error).toBe("database is closed");
    // Every other section is intact: the page still shows the ladder, the book
    // and the relay while the journal is unreadable.
    expect(isStatusSectionError(snapshot.book)).toBe(false);
    expect(isStatusSectionError(snapshot.backend)).toBe(false);
    expect(isStatusSectionError(snapshot.inventory)).toBe(false);
    expect(ok(snapshot.book).size).toBe(3);
  });

  test("a closed real journal degrades rather than taking the snapshot down", () => {
    const journal = memoryJournal();
    journal.close();
    const collector = createStatusCollector(baseDeps({ journal: () => journal }));
    const snapshot = collector.snapshot();
    expect(isStatusSectionError(snapshot.journal)).toBe(true);
    expect(isStatusSectionError(snapshot.process)).toBe(false);
  });

  test("every section can fail at once and the snapshot still serialises", () => {
    const boom = (): never => { throw new Error("seam exploded"); };
    const collector = createStatusCollector(baseDeps({
      sync: boom,
      stock: boom,
      inventory: boom,
      relay: boom,
      executor: boom,
      journal: boom,
    }));
    const snapshot = collector.snapshot();
    for (const key of
      ["backend", "book", "inventory", "relay", "ladder", "executor", "journal"] as const) {
      expect(isStatusSectionError(snapshot[key])).toBe(true);
    }
    // The version, the clock, the process and the policy are still served: an
    // operator gets SOMETHING even when every live seam is gone.
    expect(isStatusSectionError(snapshot.process)).toBe(false);
    expect(isStatusSectionError(snapshot.admission)).toBe(false);
    expect(snapshot.now).toBe(NOW);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  test("the listener section degrades until the listener binds", () => {
    const { collector } = fixture();
    // Nothing has bound yet, so there is no host/port to report and the
    // contract's required fields cannot be invented.
    expect(isStatusSectionError(collector.snapshot().listener)).toBe(true);

    Object.assign(collector.listenerCounters, {
      bound: true, host: "127.0.0.1", port: 9100, startedAt: NOW, streamClientCap: 32,
    });
    const listener = ok(collector.snapshot().listener);
    expect(listener.port).toBe(9100);
    expect(listener.unauthorizedRequests).toBe(0);
    // `bound` is bookkeeping, not contract.
    expect(Object.keys(listener)).not.toContain("bound");
  });
});

// ── FR-006: no secret may reach the wire ────────────────────────────────────

describe("status collector — the snapshot carries no secret (FR-006)", () => {
  test("a serialised snapshot contains none of the process's secrets", () => {
    const journal = memoryJournal();
    try {
      // A journal row seeded with everything FR-006 names: artifact bytes that
      // literally spell a secret, and claim inputs that are coin nullifiers.
      journal.createPrepared({
        operationKey: "op-secret",
        jobId: "job-secret",
        generation: 1,
        offerHashes: [H1, H2],
        claim: { inputs: [N1, N2], payouts: { [TOKEN_A]: "10" } },
        operationKind: "JOB_SETTLEMENT",
        ttlExpiresAtMs: NOW + 60_000,
        deadlineAtMs: NOW + 30_000,
        walletArtifactKind: "FINALIZED_TRANSACTION",
        walletArtifactBytes: new TextEncoder().encode(ARTIFACT_SECRET),
        receipt: { ledgerTxHash: "0xdeadbeef" },
      });

      const book = seededBook();
      const collector = createStatusCollector(baseDeps({
        sync: () => syncOf(book),
        stock: () => new Stock(),
        inventory: () => inventoryOf(),
        relay: () => relayOf(pushRecordFor(book)),
        executor: () => executorOf(),
        journal: () => journal,
      }));
      // A relay diagnostic is untrusted text; it must not become a smuggling
      // route either, so the grep covers the ring too.
      collector.recordRelayEvent({
        kind: "connected", severity: "info", message: "relay socket open",
      });

      const serialised = JSON.stringify(collector.snapshot());
      for (const secret of SECRETS) {
        expect(serialised).not.toContain(secret);
      }
      // The nullifiers the claim reserved are coin identities: stripped too.
      expect(serialised).not.toContain(N1);
      expect(serialised).not.toContain(N2);

      // And the useful, non-secret facts ARE there — a redaction that removed
      // everything would pass the grep and fail the operator.
      const journalSection = ok(collector.snapshot().journal);
      expect(journalSection.rows[0]!.walletArtifactByteLength).toBe(ARTIFACT_SECRET.length);
      expect(journalSection.rows[0]!.walletArtifactKind).toBe("FINALIZED_TRANSACTION");
      expect(journalSection.rows[0]!.claimInputCount).toBe(2);
      expect(journalSection.rows[0]!.receipt.ledgerTxHash).toBe("0xdeadbeef");
      expect(journalSection.rows[0]!.offerHashes).toEqual([H1, H2]);
      expect(ok(collector.snapshot().process).relayAuthTokenLength).toBe(RELAY_BEARER.length);
    } finally {
      journal.close();
    }
  });

  test("the contract has no field a future collector could put a secret in", () => {
    const { collector } = fixture();
    const keys = Object.keys(collector.snapshot());
    // The status bearer is never handed to the collector at all, so there is no
    // in-scope value for it to serialise even by accident.
    expect(keys).not.toContain("seed");
    expect(keys).not.toContain("authToken");
    expect(JSON.stringify(collector.snapshot())).not.toContain("authToken");
    expect(JSON.stringify(collector.snapshot())).not.toContain("walletArtifactBytes");
  });
});

// ── the change feed ─────────────────────────────────────────────────────────

describe("status collector — coalesced change notification", () => {
  test("a burst of notifications produces exactly one frame", () => {
    const { collector, clock } = fixture();
    const frames: StatusSnapshot[] = [];
    collector.subscribe((snapshot) => frames.push(snapshot));

    for (let index = 0; index < 50; index += 1) collector.notify();
    // Nothing is emitted synchronously: the whole burst is still one pending
    // timer, which is what stops a 1 Hz push loop next to a busy book from
    // fanning out hundreds of snapshots a second.
    expect(frames.length).toBe(0);
    expect(clock.pending).toBe(1);

    clock.advance(1);
    expect(frames.length).toBe(1);
    expect(frames[0]!.contractVersion).toBe(statusContractVersion);
  });

  test("frames are spaced by at least the coalescing interval", () => {
    const { collector, clock } = fixture();
    const frames: StatusSnapshot[] = [];
    collector.subscribe((snapshot) => frames.push(snapshot));

    collector.notify();
    clock.advance(1);
    expect(frames.length).toBe(1);

    // A change 10 ms later must NOT emit at once: the floor is measured from
    // the last emit, not from the notification.
    clock.advance(10);
    collector.notify();
    expect(frames.length).toBe(1);
    clock.advance(200);
    expect(frames.length).toBe(1);
    clock.advance(50);
    expect(frames.length).toBe(2);
    expect(frames[1]!.now).toBeGreaterThanOrEqual(frames[0]!.now + 250);
  });

  test("notifying with no subscriber schedules nothing", () => {
    const { collector, clock } = fixture();
    for (let index = 0; index < 100; index += 1) collector.notify();
    // A solver with no browser attached must not run a timer per book change.
    expect(clock.pending).toBe(0);
  });

  test("recording a relay event wakes the feed", () => {
    const { collector, clock } = fixture();
    const frames: StatusSnapshot[] = [];
    collector.subscribe((snapshot) => frames.push(snapshot));
    collector.recordRelayEvent({ kind: "disconnected", severity: "warn", message: "gone" });
    clock.advance(1);
    expect(frames.length).toBe(1);
    expect(ok(frames[0]!.relay).lastEventByKind["disconnected"]!.message).toBe("gone");
  });

  test("a throwing subscriber cannot break the loop or the other subscribers", () => {
    const { collector, clock } = fixture();
    const seen: string[] = [];
    collector.subscribe(() => { throw new Error("browser writer exploded"); });
    collector.subscribe(() => seen.push("second"));

    collector.notify();
    clock.advance(1);
    expect(seen).toEqual(["second"]);

    clock.advance(1_000);
    collector.notify();
    clock.advance(1);
    expect(seen).toEqual(["second", "second"]);
  });

  test("unsubscribing stops frames, and stop() clears the timer and the subscribers", () => {
    const { collector, clock } = fixture();
    const frames: StatusSnapshot[] = [];
    const unsubscribe = collector.subscribe((snapshot) => frames.push(snapshot));
    collector.notify();
    clock.advance(1);
    expect(frames.length).toBe(1);

    unsubscribe();
    clock.advance(1_000);
    collector.notify();
    clock.advance(1_000);
    expect(frames.length).toBe(1);

    collector.subscribe((snapshot) => frames.push(snapshot));
    collector.notify();
    collector.stop();
    // FR-007: nothing the status surface owns may outlive the solver.
    expect(clock.pending).toBe(0);
    clock.advance(10_000);
    expect(frames.length).toBe(1);
    // A stopped collector still answers a direct read, so an in-flight request
    // during shutdown gets a snapshot rather than a crash.
    expect(collector.snapshot().contractVersion).toBe(statusContractVersion);
    collector.recordRelayEvent({ kind: "stopped", severity: "info", message: "late" });
    expect(ok(collector.snapshot().relay).eventsObserved).toBe(0);
  });

  test("a non-integer coalescing interval is refused at construction", () => {
    expect(() => createStatusCollector(baseDeps({ coalesceMs: -1 }))).toThrow(RangeError);
    expect(() => createStatusCollector(baseDeps({ coalesceMs: 12.5 }))).toThrow(RangeError);
  });
});
