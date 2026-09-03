// The page's judgements, as a table (00007 SC-002, FR-012 … FR-015b).
//
// `public/derive.js` is loaded here EXACTLY as the browser loads it — a plain
// ES module, no build step, no DOM. Everything the console decides (is this
// solver quoting, is that stage red or merely unknown, which reason does this
// offer carry, what does an amount look like) is a function of a
// `MonitorSnapshot`, so all of it is testable without a browser.

import { describe, expect, test } from "bun:test";

import {
  admissionRows,
  agoLabel,
  alarms,
  bookRows,
  coinValue,
  configRows,
  countWholeRungs,
  durationLabel,
  dustPercent,
  dustView,
  eventRows,
  exclusionDetail,
  exponential,
  groupDigits,
  identity,
  impliedRate,
  inventoryRows,
  jobRows,
  ladderPairs,
  openJournalRows,
  pillState,
  relayView,
  shortColour,
  shortHex,
  stageStates,
  tileValues,
  tokenLabel,
  tokenRegistry,
} from "./public/derive.js";
import { HELP } from "./public/help.js";
import {
  buildMonitorSnapshot,
  buildStatusSnapshot,
  NIGHT,
  TKA,
  TKB,
} from "./test-helpers/fixtures.ts";

const registryOf = (snapshot: any) => tokenRegistry(snapshot);

describe("formatters", () => {
  test("groupDigits groups with a narrow no-break space and leaves non-numbers alone", () => {
    expect(groupDigits("1234567")).toBe("1 234 567");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("-1234")).toBe("-1 234");
    expect(groupDigits("not a number")).toBe("not a number");
  });

  test("coinValue is exact string arithmetic, never a double", () => {
    // 32-byte amounts do not survive Number; a rounded balance beside an exact
    // one is the bug this guards.
    expect(coinValue("123456789", 6)).toBe("123.456789");
    expect(coinValue("1000000", 6)).toBe("1");
    expect(coinValue("1", 6)).toBe("0.000001");
    expect(coinValue("123456789012345678901234567890", 18)).toBe(
      "123 456 789 012.34567890123456789",
    );
    expect(coinValue("100", 0)).toBeNull();
  });

  test("shortHex keeps head and tail, shortColour keeps the head only", () => {
    const hash = "b74a4cec" + "0".repeat(48) + "3e19abcd";
    expect(shortHex(hash)).toBe("b74a4cec…abcd");
    expect(shortHex("short")).toBe("short");
    expect(shortColour(TKA)).toBe("e7580bfc…");
  });

  test("impliedRate is 6 dp BigInt division", () => {
    expect(impliedRate("750000", "500000")).toBe("0.666666");
    expect(impliedRate("400000", "560000")).toBe("1.400000");
    expect(impliedRate("1", "1")).toBe("1.000000");
    expect(impliedRate("0", "1")).toBeNull();
    expect(impliedRate("x", "1")).toBeNull();
  });

  test("durationLabel and agoLabel read as an operator expects", () => {
    expect(durationLabel(4_000)).toBe("4 s");
    expect(durationLabel(134_000)).toBe("2 m 14 s");
    expect(durationLabel(11_100_000)).toBe("3 h 05 m");
    expect(agoLabel(1000, 0)).toBe("1 s ago");
    // An upstream clock a little ahead of ours must not print a negative age.
    expect(agoLabel(0, 1000)).toBe("just now");
    expect(agoLabel(0, 60_000)).toBe("1 m 00 s ahead");
  });

  test("exponential compresses a SPECK figure to fit a tile", () => {
    expect(exponential("2780000000000000")).toBe("2.78e15");
    expect(exponential("1000")).toBe("1 000");
  });
});

describe("token registry (FR-013b)", () => {
  test("labels a known colour by name and an unknown one by short hex", () => {
    const snapshot = buildMonitorSnapshot();
    const registry = registryOf(snapshot);
    expect(tokenLabel(TKA, registry)).toBe("TKA");
    expect(tokenLabel(NIGHT, registry)).toBe("NIGHT");
    // Never hidden, never invented (spec Edge Cases).
    expect(tokenLabel("f".repeat(64), registry)).toBe("ffffffff…");
  });

  test("adds a coin value beside the base units only when decimals > 0", () => {
    const withoutDecimals = registryOf(buildMonitorSnapshot({ decimals: 0 }));
    const withDecimals = registryOf(buildMonitorSnapshot({ decimals: 6 }));
    const rows = inventoryRows(buildMonitorSnapshot({ decimals: 6 }), withDecimals);
    expect(rows[0].balance.base).toBe("100 000");
    expect(rows[0].balance.coins).toBe("0.1");
    expect(inventoryRows(buildMonitorSnapshot(), withoutDecimals)[0].balance.coins).toBeNull();
  });
});

describe("the status pill (FR-012)", () => {
  const cases: Array<[string, any, string, string]> = [
    [
      "solver unreachable",
      buildMonitorSnapshot({ solverState: "unreachable" }),
      "SOLVER UNREACHABLE",
      "bad",
    ],
    [
      "status listener never answered",
      buildMonitorSnapshot({ status: null, solverState: "never-reached" }),
      "SOLVER UNREACHABLE",
      "bad",
    ],
    [
      "dry-run",
      buildMonitorSnapshot({ status: buildStatusSnapshot({ mode: "dry-run" }) }),
      "DRY-RUN",
      "muted",
    ],
    ["quoting", buildMonitorSnapshot(), "QUOTING", "ok"],
    [
      "withdrawn — fail-closed",
      buildMonitorSnapshot({ status: buildStatusSnapshot({ withheld: "cache-not-current" }) }),
      "WITHDRAWN",
      "warn",
    ],
    [
      "withdrawn — deliberate",
      buildMonitorSnapshot({ status: buildStatusSnapshot({ withheld: "withdrawn" }) }),
      "WITHDRAWN",
      "warn",
    ],
    [
      "relay socket down",
      buildMonitorSnapshot({ status: buildStatusSnapshot({ connected: false }) }),
      "DISCONNECTED",
      "bad",
    ],
  ];

  for (const [name, snapshot, text, tone] of cases) {
    test(`${name} → ${text}`, () => {
      expect(pillState(snapshot)).toEqual({ text, tone });
    });
  }

  test("a socket that was NEVER open is STARTING, not DISCONNECTED", () => {
    const status = buildStatusSnapshot({ connected: false });
    (status.relay as any).stats.connections = 0;
    expect(pillState(buildMonitorSnapshot({ status }))).toEqual({ text: "STARTING", tone: "warn" });
  });

  test("a solver that has not derived a push yet is STARTING", () => {
    const status = buildStatusSnapshot();
    (status as any).ladder = { state: "never-derived", last: null };
    expect(pillState(buildMonitorSnapshot({ status }))).toEqual({ text: "STARTING", tone: "warn" });
  });

  test("an empty push with NO withheld reason is quoting, in a warning colour", () => {
    const status = buildStatusSnapshot();
    (status.ladder as any).last.pairs = 0;
    (status.ladder as any).last.levels = [];
    expect(pillState(buildMonitorSnapshot({ status }))).toEqual({ text: "QUOTING", tone: "warn" });
  });
});

describe("the six-stage health strip (FR-012)", () => {
  const idsOf = (snapshot: any) => stageStates(snapshot).map((stage: any) => stage.id);

  test("is always the same six stages, in pipeline order", () => {
    expect(idsOf(buildMonitorSnapshot())).toEqual([
      "stage-kernel",
      "stage-cache",
      "stage-inventory",
      "stage-journal",
      "stage-relay",
      "stage-ladder",
    ]);
  });

  test("healthy: each stage carries its own one-line reason", () => {
    const stages = stageStates(buildMonitorSnapshot());
    // The journal stage is amber, not green: the fixture has one operation
    // still in flight, and "reconciled · 0 open" would be a lie.
    expect(stages.map((stage: any) => stage.tone)).toEqual(["ok", "ok", "ok", "warn", "ok", "ok"]);
    expect(stages[0].summary).toBe("ok · L2 1 204");
    expect(stages[1].summary).toBe("current · gen 3");
    expect(stages[3].summary).toBe("reconciled · 1 open");
    expect(stages[3].since).toBe("window 27% used");
    expect(stages[4].summary).toBe("connected");
    expect(stages[5].summary).toBe("2 pair(s) · 3 rung(s)");
  });

  test("a journal with nothing in flight is green", () => {
    const status = buildStatusSnapshot();
    (status.journal as any).countsByState = { COMPLETED: 3 };
    expect(stageStates(buildMonitorSnapshot({ status }))[3]).toMatchObject({
      tone: "ok",
      summary: "reconciled · 0 open",
    });
  });

  test("a blocked cache names the solver's OWN reason string", () => {
    const stages = stageStates(
      buildMonitorSnapshot({
        status: buildStatusSnapshot({ blockedReason: "backend-syncing", withheld: "cache-not-current" }),
      }),
    );
    expect(stages[1]).toMatchObject({ tone: "bad", summary: "blocked · backend-syncing" });
    expect(stages[2]).toMatchObject({ tone: "warn", summary: "withdrawn (not authoritative)" });
    expect(stages[5].summary).toBe("EMPTY — withheld (cache-not-current)");
  });

  test("a DELIBERATE withdrawal reads differently from a fail-closed one", () => {
    // P-A widened `withheld` precisely so these two are distinguishable; the
    // page must not blur them (plan finding 2026-09-03).
    const stages = stageStates(
      buildMonitorSnapshot({ status: buildStatusSnapshot({ withheld: "withdrawn" }) }),
    );
    expect(stages[5].summary).toBe("EMPTY — deliberate withdrawal");
  });

  test("an unreachable solver greys its five stages and leaves the kernel live", () => {
    const stages = stageStates(buildMonitorSnapshot({ solverState: "unreachable" }));
    expect(stages[0].tone).toBe("ok");
    expect(stages.slice(1).map((stage: any) => stage.tone)).toEqual(["muted", "muted", "muted", "muted", "muted"]);
    for (const stage of stages.slice(1)) {
      expect(stage.summary).toBe("unknown");
      expect(stage.since).toContain("last seen");
    }
  });

  test("dry-run is a state, not an alarm", () => {
    const stages = stageStates(
      buildMonitorSnapshot({ status: buildStatusSnapshot({ mode: "dry-run" }) }),
    );
    expect(stages[3]).toMatchObject({ tone: "muted", summary: "not opened (dry-run)" });
    expect(stages[4]).toMatchObject({ tone: "muted", summary: "not started (dry-run)" });
    expect(stages[5]).toMatchObject({ tone: "muted", summary: "not started (dry-run)" });
    expect(stages.some((stage: any) => stage.tone === "bad")).toBe(false);
  });

  test("a kernel that does not answer is red on stage one alone", () => {
    const stages = stageStates(buildMonitorSnapshot({ kernelError: "TypeError: fetch failed" }));
    expect(stages[0]).toMatchObject({ tone: "bad", summary: "unreachable" });
    expect(stages[1].tone).toBe("ok");
  });

  test("a blocked DUST window turns the journal stage red", () => {
    const status = buildStatusSnapshot();
    (status.executor as any).dustAvailable = false;
    expect(stageStates(buildMonitorSnapshot({ status }))[3]).toMatchObject({
      tone: "bad",
      summary: "DUST window blocked",
    });
  });
});

describe("alarms (FR-012)", () => {
  test("a healthy stack raises none", () => {
    expect(alarms(buildMonitorSnapshot())).toEqual([]);
  });

  test("an unreachable solver names when it was last seen", () => {
    const list = alarms(buildMonitorSnapshot({ solverState: "unreachable" }));
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe("solver");
    expect(list[0].tone).toBe("bad");
    expect(list[0].message).toContain("solver:9100");
    expect(list[0].message).toContain("has not answered since");
  });

  test("a listener that never answered asks the configuration question instead", () => {
    const list = alarms(buildMonitorSnapshot({ status: null, solverState: "never-reached" }));
    expect(list[0].message).toContain("has never answered");
    expect(list[0].message).toContain("SOLVER_STATUS_PORT");
  });

  test("quarantined jobs and failed reverts are separate alarms", () => {
    const status = buildStatusSnapshot({ quarantined: 2 });
    (status.executor as any).stats.revertFailures = 1;
    const keys = alarms(buildMonitorSnapshot({ status })).map((alarm: any) => alarm.key);
    expect(keys).toContain("quarantine");
    expect(keys).toContain("revert");
  });

  test("an empty relay token list is called out while the solver says it is connected", () => {
    const list = alarms(buildMonitorSnapshot({ relayTokens: [] }));
    expect(list.map((alarm: any) => alarm.message).join(" ")).toContain("Relay /tokens is empty");
  });

  test("a status contract mismatch is a warning, not a blank page", () => {
    const snapshot = buildMonitorSnapshot();
    (snapshot as any).solver.contractVersion = 99;
    const list = alarms(snapshot);
    expect(list[0].key).toBe("contract");
    expect(list[0].message).toContain("v99");
  });

  test("a degraded solver section is reported rather than silently missing", () => {
    const status = buildStatusSnapshot();
    (status as any).inventory = { error: "balance read threw" };
    const list = alarms(buildMonitorSnapshot({ status }));
    expect(list.map((alarm: any) => alarm.key)).toContain("status");
    expect(list.find((alarm: any) => alarm.key === "status").message).toContain("inventory");
  });
});

describe("tiles", () => {
  test("counts whole and interior rungs from the derivation's provenance", () => {
    const snapshot = buildMonitorSnapshot();
    expect(countWholeRungs((snapshot as any).solver.snapshot.ladder.last)).toBe(3);
    const tiles = tileValues(snapshot);
    expect(tiles["tile-pairs"].value).toBe("2");
    expect(tiles["tile-rungs"]).toEqual({ value: "3", detail: "3 whole · 0 interior" });
    expect(tiles["tile-tokens"].detail).toBe("relay /tokens agrees");
    expect(tiles["tile-pushes"].value).toBe("1 482");
    // The per-job DUST cap is what a job reserves — the tooltip's "fee
    // reserved for the latest job".
    expect(tiles["tile-dust"]).toEqual({ value: "5.00e15", detail: "SPECKs · per job" });
  });

  test("says what is unknown rather than showing a zero", () => {
    const tiles = tileValues(buildMonitorSnapshot({ status: null, solverState: "never-reached" }));
    expect(tiles["tile-pairs"].value).toBe("—");
    expect(tiles["tile-quarantined"].value).toBe("—");
    expect(tiles["tile-pushes"].detail).toBe("relay client not started");
  });

  test("an unreachable solver keeps its LAST values, which the page greys", () => {
    // The alternative — blanking every tile the moment the listener goes quiet
    // — throws away the only evidence of what the solver was doing when it
    // went (spec Edge Cases).
    const tiles = tileValues(buildMonitorSnapshot({ solverState: "unreachable" }));
    expect(tiles["tile-pairs"].value).toBe("2");
    expect(tiles["tile-completed"].value).toBe("3");
  });

  test("flags a relay whose token list differs from the ladder's", () => {
    expect(tileValues(buildMonitorSnapshot({ relayTokens: [TKA] }))["tile-tokens"].detail)
      .toBe("relay lists 1");
  });
});

describe("ladders and admission (User Story 2)", () => {
  test("each rung carries its rate, its kind and the maker offer it closes", () => {
    const snapshot = buildMonitorSnapshot();
    const pairs = ladderPairs(snapshot, registryOf(snapshot));
    expect(pairs).toHaveLength(2);
    expect(pairs[0].labelIn).toBe("TKA");
    expect(pairs[0].labelOut).toBe("TKB");
    expect(pairs[0].residualBound).toBe("100000");
    expect(pairs[0].rungs[0]).toMatchObject({
      index: 1,
      rate: "0.666666",
      kind: "whole",
    });
    expect(pairs[0].rungs[0].offerHash).toStartWith("b74a4cec");
    expect(pairs[0].rungs[0].inputView.base).toBe("750 000");
  });

  test("a level with no matching provenance rung is interior liquidity", () => {
    const status = buildStatusSnapshot();
    // An interpolated size between two whole rungs: it is served from solver
    // inventory and names no maker offer.
    (status.ladder as any).last.levels[0].levels.splice(1, 0, {
      input: "900000",
      output: "600000",
    });
    const snapshot = buildMonitorSnapshot({ status });
    const rungs = ladderPairs(snapshot, registryOf(snapshot))[0].rungs;
    expect(rungs[1]).toMatchObject({ kind: "interior", offerHash: null });
  });

  test("exclusions carry the solver's OWN reason, joined to the book row", () => {
    const snapshot = buildMonitorSnapshot();
    const rows = admissionRows(snapshot, registryOf(snapshot));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ reason: "multi-leg", tone: "warn" });
    expect(rows[0].pair).toBe("TKA + TKB → NIGHT");
    expect(rows[0].detail).toContain("more than one token on a side");
    expect(rows[1]).toMatchObject({ reason: "unavailable", tone: "acc" });
    expect(rows[1].detail).toContain("in-flight job");
    // `invalid-pair` carries the solver's own detail string verbatim.
    expect(rows[2]).toMatchObject({ reason: "invalid-pair", detail: "wants an UNSHIELDED leg" });
  });

  test("every LadderExclusionReason the solver can emit has a sentence", () => {
    for (const reason of [
      "multi-leg",
      "non-shielded-leg",
      "unavailable",
      "rung-cap",
      "residual-budget",
      "invalid-pair",
      "no-expiry",
      "expired",
      "unsupported-pair",
    ]) {
      expect(exclusionDetail(reason, false).length).toBeGreaterThan(10);
    }
    expect(exclusionDetail("something-new", false)).toContain("exclusion reason");
  });

  test("the withdrawal push publishes nothing and excludes nothing to show", () => {
    const snapshot = buildMonitorSnapshot({ status: buildStatusSnapshot({ withheld: "withdrawn" }) });
    expect(ladderPairs(snapshot, registryOf(snapshot))).toEqual([]);
  });
});

describe("book, jobs, inventory, DUST, relay, config, events", () => {
  test("the book marks each offer's cache membership and wire position", () => {
    const snapshot = buildMonitorSnapshot();
    const rows = bookRows(snapshot, registryOf(snapshot));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ inCache: true, rung: 1, excludedReason: null });
    expect(rows[1]).toMatchObject({ inCache: true, rung: null, excludedReason: "multi-leg" });
    expect(rows[0].gives[0].label).toBe("TKB");
  });

  test("cache membership is UNKNOWN, not `out`, while the solver is unreachable", () => {
    const snapshot = buildMonitorSnapshot({ solverState: "unreachable", status: null });
    expect(bookRows(snapshot, registryOf(snapshot))[0].inCache).toBeNull();
  });

  test("journal rows carry state, payout and receipt — never transaction bytes", () => {
    const snapshot = buildMonitorSnapshot();
    const rows = jobRows(snapshot, registryOf(snapshot));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "AWAITING_CONSUMPTION", tone: "acc" });
    expect(rows[0].receipt).toContain("relay");
    expect(rows[1]).toMatchObject({ state: "COMPLETED", tone: "ok" });
    expect(rows[1].receipt).toContain("ledger");
    expect(rows[1].receipt).toContain("@ 1 176");
    expect(JSON.stringify(rows)).not.toContain("walletArtifact");
  });

  test("open journal rows are the non-terminal ones", () => {
    expect(openJournalRows({ countsByState: { COMPLETED: 2, REFUSED: 1, AWAITING_CONSUMPTION: 1 } })).toBe(1);
    expect(openJournalRows({ countsByState: {} })).toBe(0);
  });

  test("DUST usage is a percentage of the rolling window", () => {
    const snapshot = buildMonitorSnapshot();
    expect(dustPercent((snapshot as any).solver.snapshot.journal.dust)).toBe(27);
    expect(dustView(snapshot)).toMatchObject({ configured: true, percent: 27, blocked: false });
    expect(dustPercent({ configured: false })).toBe(0);
  });

  test("the relay panel says whether its token list agrees with the ladder", () => {
    const snapshot = buildMonitorSnapshot();
    expect(relayView(snapshot, registryOf(snapshot))).toMatchObject({ configured: true, agrees: true });
    const different = buildMonitorSnapshot({ relayTokens: [TKB] });
    expect(relayView(different, registryOf(different))?.agrees).toBe(false);
  });

  test("the configuration panel prints the bearer LENGTH and no secret", () => {
    const rows = configRows(buildMonitorSnapshot());
    const flat = rows.map((row: any) => row.join(": ")).join("\n");
    expect(flat).toContain("relay token: 48 chars (never shown)");
    expect(flat).toContain("supported pairs: OPEN");
    expect(flat).toContain("fee sizing: models 1 taker input(s) (funds up to 3)");
    expect(flat).not.toContain("seed");
  });

  test("events merge the solver's diagnostics with the console's transitions, newest first", () => {
    const now = 1_770_000_001_000;
    const snapshot = buildMonitorSnapshot({
      now,
      history: [
        { at: now - 10, kind: "solver", from: "never-reached", to: "reachable", detail: "answering" },
      ],
    });
    const rows = eventRows(snapshot);
    expect(rows[0].source).toBe("console");
    expect(rows[0].tone).toBe("ok");
    expect(rows.some((row: any) => row.source === "solver" && row.kind === "push")).toBe(true);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index - 1].at).toBeGreaterThanOrEqual(rows[index].at);
    }
  });

  test("a folded solver event renders once, at its latest time, with its repeat count", () => {
    const now = 1_770_000_001_000;
    const snapshot = buildMonitorSnapshot({ now });
    const relay = (snapshot as any).solver.snapshot.relay;
    relay.events = [
      { seq: 1, at: now - 300_000, lastAt: now - 1_000, count: 300, kind: "push", severity: "info", message: "pushed 1 pair(s)" },
      { seq: 2, at: now - 500, kind: "disconnected", severity: "warn", message: "relay socket closed" },
    ];
    const rows = eventRows(snapshot).filter((row: any) => row.source === "solver");
    expect(rows.map((row: any) => row.kind)).toEqual(["disconnected", "push"]);
    expect(rows[1].at).toBe(now - 1_000);
    expect(rows[1].count).toBe(300);
    expect(rows[1].message).toMatch(/^pushed 1 pair\(s\) — ×300 since /);
    expect(rows[0].count).toBe(1);
    expect(rows[0].message).toBe("relay socket closed");
  });

  test("the identity line falls back to `unreachable` rather than inventing a mode", () => {
    expect(identity(buildMonitorSnapshot())).toMatchObject({ network: "undeployed", mode: "live" });
    expect(identity(buildMonitorSnapshot({ status: null, solverState: "never-reached" })).mode).toBe(
      "unreachable",
    );
  });
});

// Read once at module scope: the help test is a static analysis of the page.
const indexHtml = await Bun.file(new URL("./public/index.html", import.meta.url)).text();
const rendered = [...indexHtml.matchAll(/data-help="([^"]+)"/g)].map((match) => match[1]!);

describe("help coverage (FR-015b)", () => {
  test("every block the page renders has a help entry, and no entry is orphaned", () => {
    const inPage = [...new Set(rendered)].sort();
    const inMap = Object.keys(HELP).sort();
    expect(inPage).toEqual(inMap);
  });

  test("there are 27 help affordances, each used exactly once", () => {
    expect(rendered).toHaveLength(27);
    expect(new Set(rendered).size).toBe(27);
  });

  test("every entry is ONE short sentence and names its source (user feedback)", () => {
    for (const [id, entry] of Object.entries(HELP)) {
      expect(`${id}: ${typeof entry.text}`).toBe(`${id}: string`);
      expect(entry.text.length).toBeGreaterThan(20);
      expect(entry.text.length).toBeLessThanOrEqual(120);
      expect(entry.text.endsWith(".")).toBe(true);
      expect(entry.source.length).toBeGreaterThan(3);
      expect(entry.source.endsWith(".")).toBe(false);
    }
  });

  test("the ids the derivations produce match the ids the page marks up", () => {
    const snapshot = buildMonitorSnapshot();
    for (const stage of stageStates(snapshot)) expect(HELP[stage.id]).toBeDefined();
    for (const id of Object.keys(tileValues(snapshot))) expect(HELP[id]).toBeDefined();
  });
});

describe("the page loads nothing from another origin (FR-014)", () => {
  test("no http(s) URL appears in the markup, styles or scripts", async () => {
    for (const name of ["index.html", "styles.css", "app.js", "derive.js", "help.js"]) {
      const source = await Bun.file(new URL(`./public/${name}`, import.meta.url)).text();
      // Comments may name a route; an ATTRIBUTE or an import that reaches out
      // is what must not exist.
      const offenders = [...source.matchAll(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g)];
      expect(`${name}: ${offenders.map((match) => match[0]).join(", ")}`).toBe(`${name}: `);
      expect(source).not.toContain("fonts.googleapis.com");
      expect(source).not.toContain("cdn.");
    }
  });
});
