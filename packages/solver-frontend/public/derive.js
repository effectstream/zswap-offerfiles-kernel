// Every derivation the page performs, as pure functions (00007 FR-012).
//
// WHY THIS FILE EXISTS SEPARATELY. `app.js` touches the DOM and cannot be unit
// tested without a browser; the interesting part of the page is not the DOM
// writing, it is the JUDGEMENT — is this solver quoting or withdrawn, is that
// stage red or merely unknown, which reason does this excluded offer carry.
// All of that lives here as functions of a `MonitorSnapshot` and nothing else,
// so `derive.test.ts` can assert the whole state table with plain objects.
//
// It is a plain ES module with no imports, loaded by the browser directly (no
// build step — FR-008) and imported by `bun test` unchanged.
//
// TWO RULES:
//
//   * **Amounts stay integer base units** (FR-013b). The solver, the relay wire
//     and the journal are base-unit only. A coin-denominated value is ADDED
//     beside the base units when the kernel registry gives the colour
//     `decimals > 0`, and it is always marked as the derived value it is.
//   * **"Ago" is measured from the snapshot's `now`** (FR-013), which is the
//     SERVER's clock. Two containers with skewed clocks would otherwise make
//     "3 s ago" read as "-47 s ago".

// ── small formatters ─────────────────────────────────────────────────────────

/** A section that failed to collect, on either side of the hop. */
export function isError(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.error === "string"
  );
}

/** Narrow no-break space: groups digits without letting a number wrap. */
const GROUP = " ";

/** `1234567` → `1 234 567`. Leaves a non-numeric string alone. */
export function groupDigits(value) {
  const text = String(value ?? "");
  if (!/^-?[0-9]+$/.test(text)) return text;
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
  return negative ? `-${grouped}` : grouped;
}

/**
 * Base units → the coin-denominated value, as an exact decimal string.
 *
 * String arithmetic on purpose: a 32-byte amount does not survive `Number`, and
 * the page must never show a rounded balance next to an exact one.
 */
export function coinValue(amount, decimals) {
  const text = String(amount ?? "");
  if (!/^[0-9]+$/.test(text) || !Number.isInteger(decimals) || decimals <= 0) return null;
  const padded = text.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
}

/** `0xb74a4cec…3e19`-style shortening; the caller keeps the full value for the
 *  title attribute and for click-to-copy. */
export function shortHex(value, head = 8, tail = 4) {
  const text = String(value ?? "");
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** A colour is 64 hex chars and is shown head-only — the tail carries no
 *  meaning an operator can use. */
export function shortColour(value) {
  const text = String(value ?? "");
  return text.length <= 10 ? text : `${text.slice(0, 8)}…`;
}

/**
 * Implied rate = output / input, to 6 dp, computed in BigInt so a 30-digit
 * amount does not lose its low digits to a double.
 */
export function impliedRate(input, output) {
  const a = String(input ?? "");
  const b = String(output ?? "");
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return null;
  const inputUnits = BigInt(a);
  if (inputUnits === 0n) return null;
  const scaled = (BigInt(b) * 1000000n) / inputUnits;
  const whole = scaled / 1000000n;
  const fraction = (scaled % 1000000n).toString().padStart(6, "0");
  return `${groupDigits(whole.toString())}.${fraction}`;
}

/** A duration an operator reads at a glance: `4 s`, `2 m 14 s`, `3 h 05 m`. */
export function durationLabel(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, "0")} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} m`;
  return `${Math.floor(hours / 24)} d ${String(hours % 24).padStart(2, "0")} h`;
}

/** FR-013: "N s ago", measured from the snapshot's SERVER clock. */
export function agoLabel(now, at) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "—";
  const delta = now - at;
  // A slightly-ahead upstream clock reads as "just now" rather than as a
  // negative age; anything larger is a real skew and is shown as such.
  if (delta < 0) return delta > -2000 ? "just now" : `${durationLabel(-delta)} ahead`;
  return `${durationLabel(delta)} ago`;
}

/** Absolute wall-clock time in the VIEWER's locale (FR-013). */
export function clockLabel(at) {
  if (typeof at !== "number" || !Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString();
}

/** A stable swatch colour per token colour, so the same token is the same hue
 *  in every table without a palette to maintain. */
export function swatch(colour) {
  const text = String(colour ?? "");
  const seed = /^[0-9a-f]{4}/i.test(text) ? Number.parseInt(text.slice(0, 4), 16) : 0;
  return `hsl(${seed % 360} 52% 45%)`;
}

// ── token registry (FR-013b) ─────────────────────────────────────────────────

/**
 * colour → `{ name, kind, decimals, priceUsd, priceSource }`, built from the
 * kernel's `/v1/known-tokens` and, where the node serves it, `/v1/prices`.
 * A colour with no row is NOT hidden: `tokenLabel` falls back to short hex.
 */
export function tokenRegistry(snapshot) {
  const registry = new Map();
  const tokens = snapshot?.kernel?.knownTokens;
  if (Array.isArray(tokens)) {
    for (const row of tokens) {
      registry.set(row.color, {
        name: row.name || null,
        kind: row.kind ?? null,
        decimals: row.decimals ?? 0,
        priceUsd: null,
        priceSource: null,
      });
    }
  }
  const prices = snapshot?.kernel?.prices;
  if (prices && !isError(prices) && prices.supported && Array.isArray(prices.tokens)) {
    for (const row of prices.tokens) {
      const existing = registry.get(row.color) ?? {
        name: row.name || null,
        kind: null,
        decimals: row.decimals ?? 0,
        priceUsd: null,
        priceSource: null,
      };
      existing.priceUsd = row.priceUsd;
      existing.priceSource = row.source;
      if (existing.decimals === 0 && row.decimals) existing.decimals = row.decimals;
      registry.set(row.color, existing);
    }
  }
  return registry;
}

/** The label for a colour: its registered name, else short hex — never hidden
 *  and never invented (spec Edge Cases). */
export function tokenLabel(colour, registry) {
  const entry = registry?.get?.(String(colour ?? "").toLowerCase());
  if (entry && entry.name) return entry.name;
  return shortColour(colour);
}

/** `{ base, coins, decimals }` — base units always, coins only when the
 *  registry says the colour has them (FR-013b). */
export function amountView(amount, colour, registry) {
  const entry = registry?.get?.(String(colour ?? "").toLowerCase());
  const decimals = entry?.decimals ?? 0;
  return {
    base: groupDigits(amount),
    coins: decimals > 0 ? coinValue(amount, decimals) : null,
    decimals,
  };
}

// ── snapshot accessors ───────────────────────────────────────────────────────

const section = (snapshot, name) => {
  const status = snapshot?.solver?.snapshot;
  if (!status) return null;
  const value = status[name];
  return value === undefined ? null : value;
};

const ok = (value) => (value !== null && !isError(value) ? value : null);

/** The solver's own view, or null when we have never had one / it errored. */
export const solverSection = (snapshot, name) => ok(section(snapshot, name));

// ── the status pill (FR-012) ─────────────────────────────────────────────────

/**
 * ONE verdict, from the six the spec names. The order below is the order an
 * operator triages in: can I see the solver at all → is it even trading → is
 * its socket up → is it publishing.
 */
export function pillState(snapshot) {
  const solver = snapshot?.solver;
  if (!solver || solver.state !== "reachable") {
    return { text: "SOLVER UNREACHABLE", tone: "bad" };
  }
  const process = solverSection(snapshot, "process");
  if (process && process.mode === "dry-run") return { text: "DRY-RUN", tone: "muted" };

  const relay = solverSection(snapshot, "relay");
  if (relay && relay.state === "not-started") return { text: "STARTING", tone: "warn" };
  if (relay && relay.stats && !relay.stats.connected) {
    // A socket that has never once been open is a process still coming up, not
    // an outage — the difference between "starting" and "the relay went away".
    return relay.stats.connections === 0
      ? { text: "STARTING", tone: "warn" }
      : { text: "DISCONNECTED", tone: "bad" };
  }

  const ladder = solverSection(snapshot, "ladder");
  if (!ladder || ladder.state === "never-derived" || ladder.last === null) {
    return { text: "STARTING", tone: "warn" };
  }
  if (ladder.last.withheld !== null) return { text: "WITHDRAWN", tone: "warn" };
  // An empty push with no `withheld` reason is a solver that is quoting and has
  // nothing to quote — a warning colour, not a withdrawal.
  return { text: "QUOTING", tone: ladder.last.pairs > 0 ? "ok" : "warn" };
}

// ── the six-stage health strip (FR-012) ──────────────────────────────────────

const UNKNOWN_SINCE = (snapshot) =>
  snapshot?.solver?.lastSeenAt === null
    ? "never seen"
    : `last seen ${clockLabel(snapshot.solver.lastSeenAt)}`;

function kernelStage(snapshot) {
  const sync = snapshot?.kernel?.sync;
  if (sync === null || sync === undefined) {
    return { tone: "muted", summary: "not read yet", since: "" };
  }
  if (isError(sync)) return { tone: "bad", summary: "unreachable", since: sync.error };
  const lag = (part) =>
    part && typeof part.tip === "number" && typeof part.current === "number"
      ? part.tip - part.current
      : null;
  const midnightLag = lag(sync.midnight);
  const celestiaLag = lag(sync.celestia);
  // Short enough that both chains still fit the stage's one line.
  const parts = [];
  if (midnightLag !== null) parts.push(`midnight ${groupDigits(String(midnightLag))}`);
  if (celestiaLag !== null) parts.push(`celestia ${groupDigits(String(celestiaLag))}`);
  if (parts.length > 0) parts[parts.length - 1] += " behind";
  const l2 = sync.ntp && typeof sync.ntp.current === "number" ? sync.ntp.current : null;
  const tone = sync.status === "ok" ? "ok" : sync.status === "syncing" ? "warn" : "bad";
  return {
    tone,
    summary: l2 === null ? sync.status : `${sync.status} · L2 ${groupDigits(String(l2))}`,
    since: parts.join(" · "),
  };
}

function cacheStage(snapshot) {
  const backend = solverSection(snapshot, "backend");
  if (!backend) return { tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) };
  const currentness = backend.currentness;
  if (currentness.kind === "current") {
    return {
      tone: "ok",
      summary: `current · gen ${currentness.streamGeneration}`,
      since: `L2 ${groupDigits(currentness.backendBlockL2)}`,
    };
  }
  return {
    tone: "bad",
    summary: `blocked · ${currentness.reason}`,
    since: `gen ${currentness.streamGeneration}`,
  };
}

function inventoryStage(snapshot) {
  const inventory = solverSection(snapshot, "inventory");
  if (!inventory) return { tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) };
  if (inventory.refreshing && !inventory.ready) {
    return { tone: "warn", summary: "refreshing", since: `${inventory.tokens.length} token(s)` };
  }
  if (!inventory.ready) {
    return { tone: "warn", summary: "withdrawn (not authoritative)", since: "emptied with the cache" };
  }
  return {
    tone: "ok",
    summary: "authoritative",
    since: `${inventory.tokens.length} token(s)${inventory.refreshing ? " · refreshing" : ""}`,
  };
}

/** Journal rows that have not reached a terminal state. */
const TERMINAL_JOURNAL_STATES = new Set([
  // The operation journal's own terminal lifecycle states
  // (packages/solver/src/operation-journal.ts): everything else — PREPARED,
  // APPLIED, AWAITING_RELAY, RELAY_SUBMITTED, CONFIRMING, REVERTING and
  // QUARANTINED — is still open and needs the executor or an operator.
  "SETTLED",
  "REVERTED",
  "FAILED",
]);

/** Whether the solver reports itself in dry-run (no relay client, no
 *  executor, no journal) — the only case in which "not started" is permanent. */
export function isDryRun(snapshot) {
  return solverSection(snapshot, "process")?.mode === "dry-run";
}

export function openJournalRows(journal) {
  if (!journal || !journal.countsByState) return 0;
  let open = 0;
  for (const [state, count] of Object.entries(journal.countsByState)) {
    if (!TERMINAL_JOURNAL_STATES.has(state.toUpperCase())) open += count;
  }
  return open;
}

function journalStage(snapshot) {
  const journal = solverSection(snapshot, "journal");
  const executor = solverSection(snapshot, "executor");
  if (!journal) return { tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) };
  if (journal.state === "not-opened") {
    return isDryRun(snapshot)
      ? { tone: "muted", summary: "not opened (dry-run)", since: "no journal in dry-run" }
      : { tone: "muted", summary: "not opened yet", since: "the solver is still coming up" };
  }
  const open = openJournalRows(journal);
  const dust = journal.dust;
  const blocked = executor && executor.dustAvailable === false;
  const usage =
    dust && dust.configured && dust.maxPerWindow && dust.usage
      ? `window ${dustPercent(dust)}% used`
      : "DUST window OPEN";
  if (blocked) {
    return { tone: "bad", summary: "DUST window blocked", since: usage };
  }
  return {
    tone: open > 0 ? "warn" : "ok",
    summary: `reconciled · ${open} open`,
    since: usage,
  };
}

/** Percentage of the rolling DUST window already spent, 0 when unconfigured. */
export function dustPercent(dust) {
  if (!dust || !dust.configured || !dust.maxPerWindow || !dust.usage) return 0;
  try {
    const limit = BigInt(dust.maxPerWindow);
    if (limit === 0n) return 0;
    return Number((BigInt(dust.usage) * 100n) / limit);
  } catch {
    return 0;
  }
}

function relayStage(snapshot) {
  const relay = solverSection(snapshot, "relay");
  if (!relay) return { tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) };
  if (relay.state === "not-started") {
    return isDryRun(snapshot)
      ? { tone: "muted", summary: "not started (dry-run)", since: "no relay client in dry-run" }
      : { tone: "muted", summary: "not started yet", since: "the solver is still coming up" };
  }
  const stats = relay.stats;
  if (!stats) return { tone: "muted", summary: "unknown", since: "" };
  const last = relay.lastEventByKind ?? {};
  if (stats.connected) {
    const connected = last["connected"];
    return {
      tone: "ok",
      summary: "connected",
      since:
        (connected ? `since ${clockLabel(connected.at)}` : "connected") +
        ` · ${stats.connections} connection(s)`,
    };
  }
  const disconnected = last["disconnected"] ?? last["connect-failed"] ?? last["connect-timeout"];
  return {
    tone: stats.connections === 0 ? "warn" : "bad",
    summary: stats.connections === 0 ? "never connected" : "reconnecting",
    since: disconnected ? `${disconnected.kind} ${clockLabel(disconnected.at)}` : "no socket",
  };
}

function ladderStage(snapshot) {
  const ladder = solverSection(snapshot, "ladder");
  if (!ladder) return { tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) };
  if (ladder.state === "not-started") {
    return isDryRun(snapshot)
      ? { tone: "muted", summary: "not started (dry-run)", since: "nothing is published" }
      : { tone: "muted", summary: "not started yet", since: "nothing is published yet" };
  }
  if (ladder.state === "never-derived" || ladder.last === null) {
    return { tone: "warn", summary: "nothing published yet", since: "no push derived" };
  }
  const push = ladder.last;
  const now = snapshot.now;
  if (push.withheld !== null) {
    return {
      tone: "warn",
      // P-A widened `withheld`: the two values mean genuinely different things
      // and the page must not blur them (plan finding 2026-09-03).
      summary:
        push.withheld === "withdrawn"
          ? "EMPTY — deliberate withdrawal"
          : `EMPTY — withheld (${push.withheld})`,
      since: `pushed ${agoLabel(now, push.derivedAt)}`,
    };
  }
  return {
    tone: push.pairs > 0 ? "ok" : "warn",
    summary: `${push.pairs} pair(s) · ${push.rungs} rung(s)`,
    since: `pushed ${agoLabel(now, push.derivedAt)}`,
  };
}

/** The strip, in pipeline order. `id` matches the help map's key. */
export function stageStates(snapshot) {
  const solverDown = snapshot?.solver?.state !== "reachable";
  const stages = [
    { id: "stage-kernel", index: 1, group: "kernel", label: "Kernel sync", ...kernelStage(snapshot) },
    { id: "stage-cache", index: 2, group: "mirror", label: "Book cache", ...cacheStage(snapshot) },
    { id: "stage-inventory", index: 3, group: "wallet", label: "Inventory", ...inventoryStage(snapshot) },
    { id: "stage-journal", index: 4, group: "journal", label: "Journal & DUST", ...journalStage(snapshot) },
    { id: "stage-relay", index: 5, group: "relay", label: "Relay socket", ...relayStage(snapshot) },
    { id: "stage-ladder", index: 6, group: "wire", label: "Published ladder", ...ladderStage(snapshot) },
  ];
  if (!solverDown) return stages;
  // The kernel read is ours, not the solver's, so it stays live while every
  // solver-owned stage goes to "unknown" rather than to red — an unreachable
  // solver is one alarm, not five.
  return stages.map((stage) =>
    stage.id === "stage-kernel"
      ? stage
      : { ...stage, tone: "muted", summary: "unknown", since: UNKNOWN_SINCE(snapshot) },
  );
}

// ── alarms (FR-012) ──────────────────────────────────────────────────────────

/** Only present when something is wrong; the page hides the block otherwise. */
export function alarms(snapshot) {
  const out = [];
  const solver = snapshot?.solver;
  if (!solver) return out;
  const now = snapshot.now;

  if (solver.state === "never-reached") {
    out.push({
      tone: "bad",
      key: "solver",
      message:
        `The solver's status listener at ${solver.host} has never answered ` +
        `(${durationLabel(now - solver.since)}). Is SOLVER_STATUS_PORT set on the solver, and ` +
        `does its SOLVER_STATUS_AUTH_TOKEN match this service's bearer? ` +
        `Last error: ${solver.lastError ?? "none recorded"}.`,
    });
  } else if (solver.state === "unreachable") {
    out.push({
      tone: "bad",
      key: "solver",
      message:
        `The solver's status listener at ${solver.host} has not answered since ` +
        `${clockLabel(solver.lastSeenAt)} (${durationLabel(now - solver.since)}). ` +
        `Showing the last snapshot it sent, greyed. The kernel and relay reads below are live.`,
    });
  }

  if (
    solver.contractVersion !== null &&
    solver.contractVersion !== solver.expectedContractVersion
  ) {
    out.push({
      tone: "warn",
      key: "contract",
      message:
        `The solver reports status contract v${solver.contractVersion} and this page renders ` +
        `v${solver.expectedContractVersion}. Some panels may be blank until both sides are redeployed.`,
    });
  }

  const relay = solverSection(snapshot, "relay");
  if (relay && relay.state === "running" && relay.stats && !relay.stats.connected) {
    const last =
      relay.lastEventByKind?.["disconnected"] ??
      relay.lastEventByKind?.["connect-failed"] ??
      relay.lastEventByKind?.["connect-timeout"];
    out.push({
      tone: "bad",
      key: "relay",
      message:
        `No socket to the relay${last ? ` since ${clockLabel(last.at)}` : ""}` +
        `${last ? ` (last: ${last.kind} — ${last.message})` : ""}. ` +
        `The relay drops every per-solver frame with the socket; the ladder below is what will be ` +
        `re-pushed on reconnect, not what is live.`,
    });
  }

  const backend = solverSection(snapshot, "backend");
  if (backend && backend.currentness.kind === "blocked") {
    out.push({
      tone: "warn",
      key: "cache",
      message:
        `The solver's book cache is blocked (${backend.currentness.reason}), so it is pushing the ` +
        `EMPTY capabilities + levels pair — its fail-closed withdrawal. Nothing is quotable until ` +
        `the kernel projection is back inside the lag window.`,
    });
  }

  const ladder = solverSection(snapshot, "ladder");
  if (ladder && ladder.last && ladder.last.withheld === "withdrawn") {
    out.push({
      tone: "warn",
      key: "withdrawn",
      message:
        "The solver withdrew its quotes DELIBERATELY (a graceful stop or an explicit withdrawal), " +
        "not because its cache went stale. The relay is holding an empty ladder for it.",
    });
  }

  const executor = solverSection(snapshot, "executor");
  if (executor && executor.dustAvailable === false) {
    out.push({
      tone: "warn",
      key: "dust",
      message:
        "The rolling DUST admission window is blocked, so every ladder is withdrawn until the " +
        "window rolls forward. See DUST admission.",
    });
  }
  if (executor && executor.stats && executor.stats.quarantined > 0) {
    out.push({
      tone: "bad",
      key: "quarantine",
      message:
        `${executor.stats.quarantined} job(s) are QUARANTINED and need an operator. ` +
        `They are in the Jobs table below.`,
    });
  }
  if (executor && executor.stats && executor.stats.revertFailures > 0) {
    out.push({
      tone: "bad",
      key: "revert",
      message:
        `${executor.stats.revertFailures} revert(s) failed — reserved inventory may still be held. ` +
        `Check the journal rows below.`,
    });
  }
  if (relay && relay.stats && relay.stats.pushFailures > 0) {
    out.push({
      tone: "warn",
      key: "push",
      message: `${relay.stats.pushFailures} push(es) failed to reach the relay since start.`,
    });
  }

  const relayTokens = snapshot?.relay?.tokens;
  if (
    Array.isArray(relayTokens) &&
    relayTokens.length === 0 &&
    solver.state === "reachable" &&
    relay &&
    relay.state === "running"
  ) {
    out.push({
      tone: "warn",
      key: "relay",
      message: "Relay /tokens is empty — no solver is advertising anything.",
    });
  }

  if (isError(snapshot?.kernel?.sync)) {
    out.push({
      tone: "bad",
      key: "kernel",
      message: `The kernel at ${snapshot.kernel.api} is not answering: ${snapshot.kernel.sync.error}`,
    });
  }

  const failed = failedSections(snapshot);
  if (failed.length > 0) {
    out.push({
      tone: "warn",
      key: "status",
      message: `The solver could not collect ${failed.length} status section(s): ${failed.join(", ")}.`,
    });
  }
  return out;
}

/** Solver snapshot sections that degraded to `{ error }` (FR-005). */
export function failedSections(snapshot) {
  const status = snapshot?.solver?.snapshot;
  if (!status) return [];
  const names = [
    "process",
    "backend",
    "book",
    "inventory",
    "relay",
    "ladder",
    "executor",
    "journal",
    "admission",
    "listener",
  ];
  return names.filter((name) => isError(status[name]));
}

// ── stat tiles (FR-012) ──────────────────────────────────────────────────────

const DASH = "—";

/** id → `{ value, unit, detail }`, keyed to the help map and to the markup. */
export function tileValues(snapshot) {
  const ladder = solverSection(snapshot, "ladder");
  const push = ladder && ladder.last ? ladder.last : null;
  const book = solverSection(snapshot, "book");
  const relay = solverSection(snapshot, "relay");
  const executor = solverSection(snapshot, "executor");
  const journal = solverSection(snapshot, "journal");
  const kernelBook = snapshot?.kernel?.book;
  const kernelOffers = kernelBook && !isError(kernelBook) ? kernelBook.count : null;
  const relayTokens = snapshot?.relay?.tokens;
  const monitor = snapshot?.monitor;

  const advertised = push ? push.tokenIds.length : null;
  const relayAgrees =
    Array.isArray(relayTokens) && push
      ? relayTokens.length === push.tokenIds.length &&
        push.tokenIds.every((token) => relayTokens.includes(token))
      : null;

  const whole = push ? countWholeRungs(push) : null;

  return {
    "tile-pairs": {
      value: push ? String(push.pairs) : DASH,
      detail: book ? `of ${book.pairs.length} in book` : "book unknown",
    },
    "tile-rungs": {
      value: push ? String(push.rungs) : DASH,
      detail:
        whole === null
          ? "no push yet"
          : `${whole} whole · ${Math.max(0, (push?.rungs ?? 0) - whole)} interior`,
    },
    "tile-tokens": {
      value: advertised === null ? DASH : String(advertised),
      detail:
        relayAgrees === null
          ? "relay not read"
          : relayAgrees
            ? "relay /tokens agrees"
            : `relay lists ${Array.isArray(relayTokens) ? relayTokens.length : 0}`,
    },
    "tile-pushes": {
      value: relay && relay.stats ? groupDigits(String(relay.stats.pushes)) : DASH,
      detail: relay && relay.stats
        ? `${relay.stats.coalesced} coalesced · ${relay.stats.pushFailures} failed`
        : "relay client not started",
    },
    "tile-book": {
      value: kernelOffers === null ? DASH : groupDigits(String(kernelOffers)),
      detail: book
        ? `kernel ${kernelOffers ?? "?"} · cache ${book.size}`
        : "solver cache unknown",
    },
    "tile-jobs": {
      value: executor && executor.stats ? String(executor.stats.building) : DASH,
      detail: executor && executor.stats
        ? `${executor.stats.awaitingRelay} awaiting relay`
        : "executor not started",
    },
    "tile-completed": {
      value: executor && executor.stats ? groupDigits(String(executor.stats.completed)) : DASH,
      detail: executor && executor.stats
        ? `${executor.stats.refused} refused · ${executor.stats.reverted} reverted`
        : "executor not started",
    },
    "tile-quarantined": {
      value: executor && executor.stats ? String(executor.stats.quarantined) : DASH,
      detail: executor && executor.stats
        ? `${executor.stats.revertFailures} revert failures`
        : "executor not started",
    },
    "tile-withdrawals": {
      value: monitor ? String(monitor.withdrawals) : DASH,
      detail:
        monitor && monitor.lastWithdrawalAt !== null
          ? `last ${clockLabel(monitor.lastWithdrawalAt)}` +
            (monitor.lastWithdrawalMs !== null ? ` · ${durationLabel(monitor.lastWithdrawalMs)}` : "")
          : "none observed",
    },
    "tile-dust": {
      value:
        journal && journal.dust && journal.dust.maxPerJob
          ? exponential(journal.dust.maxPerJob)
          : DASH,
      detail: journal && journal.dust && journal.dust.configured
        ? "SPECKs · per job"
        : "DUST admission OPEN",
    },
  };
}

/** A rung closed by consuming a WHOLE maker offer carries that offer's hash;
 *  an interior rung is served from solver inventory and names none. */
export function countWholeRungs(push) {
  if (!push || !Array.isArray(push.provenance)) return 0;
  let whole = 0;
  for (const pair of push.provenance) {
    for (const rung of pair.rungs ?? []) if (rung.offerHash) whole += 1;
  }
  return whole;
}

/** `2780000000000000` → `2.78e15`, so a DUST figure fits a tile. */
export function exponential(value) {
  const text = String(value ?? "");
  if (!/^[0-9]+$/.test(text)) return text;
  if (text.length <= 6) return groupDigits(text);
  const mantissa = `${text[0]}.${text.slice(1, 3)}`;
  return `${mantissa}e${text.length - 1}`;
}

// ── ladders, exclusions, book, jobs, inventory (FR-012) ──────────────────────

/**
 * One entry per published directed pair: the wire levels joined to the
 * derivation's provenance, so each rung says whether it closes a maker offer
 * (whole) or is served from solver inventory (interior).
 */
export function ladderPairs(snapshot, registry) {
  const ladder = solverSection(snapshot, "ladder");
  if (!ladder || !ladder.last) return [];
  const push = ladder.last;
  const provenanceFor = new Map();
  for (const pair of push.provenance ?? []) {
    provenanceFor.set(`${pair.tokenIn}|${pair.tokenOut}`, pair);
  }
  return (push.levels ?? []).map((pair) => {
    const provenance = provenanceFor.get(`${pair.tokenIn}|${pair.tokenOut}`) ?? null;
    const rungs = (pair.levels ?? []).map((level, index) => {
      const source = provenance?.rungs?.[index] ?? null;
      // A level that matches a provenance rung's cumulative input is that
      // rung; anything else is interpolated interior liquidity.
      const whole = source !== null && source.input === level.input;
      return {
        index: index + 1,
        input: level.input,
        output: level.output,
        inputView: amountView(level.input, pair.tokenIn, registry),
        outputView: amountView(level.output, pair.tokenOut, registry),
        rate: impliedRate(level.input, level.output),
        kind: whole ? "whole" : "interior",
        offerHash: whole ? source.offerHash : null,
      };
    });
    return {
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      labelIn: tokenLabel(pair.tokenIn, registry),
      labelOut: tokenLabel(pair.tokenOut, registry),
      residualBound: provenance ? provenance.residualBound : null,
      rungs,
    };
  });
}

/**
 * The admission view (User Story 2): the solver's OWN exclusion reasons, joined
 * to the book row so the operator sees which offer each one is about. The
 * reference sink could only INFER admission
 * ("in the book but not in the ladder"); here the reason string is the solver's own.
 */
export function admissionRows(snapshot, registry) {
  const ladder = solverSection(snapshot, "ladder");
  const book = solverSection(snapshot, "book");
  const executor = solverSection(snapshot, "executor");
  if (!ladder || !ladder.last) return [];
  const byHash = new Map();
  for (const offer of book?.offers ?? []) byHash.set(offer.offerHash, offer);
  const unavailable = new Set(executor?.unavailableOfferHashes ?? []);
  return (ladder.last.excluded ?? []).map((exclusion) => {
    const offer = byHash.get(exclusion.offerHash) ?? null;
    const pair =
      offer && offer.gives.length > 0 && offer.wants.length > 0
        ? `${offer.gives.map((leg) => tokenLabel(leg.token, registry)).join(" + ")} → ` +
          `${offer.wants.map((leg) => tokenLabel(leg.token, registry)).join(" + ")}`
        : "unknown pair";
    return {
      offerHash: exclusion.offerHash,
      pair,
      reason: exclusion.reason,
      tone: exclusion.reason === "unavailable" ? "acc" : "warn",
      detail: exclusion.detail ?? exclusionDetail(exclusion.reason, unavailable.has(exclusion.offerHash)),
    };
  });
}

/** One sentence per reason the solver can report, so the page never shows a
 *  bare enum value to an operator who has not read the source. */
export function exclusionDetail(reason, claimed) {
  switch (reason) {
    case "multi-leg":
      return "more than one token on a side — no single directed price describes it";
    case "non-shielded-leg":
      return "an UNSHIELDED leg — outside this solver's settlement scope";
    case "unavailable":
      return claimed
        ? "claimed by an in-flight job; it returns when the job reaches a terminal state"
        : "claimed by an in-flight job";
    case "rung-cap":
      return "beyond the configured rungs-per-pair cap";
    case "residual-budget":
      return "an interior rung above it would need more tokenOut than the solver holds";
    case "invalid-pair":
      return "refused by the pair schema";
    case "no-expiry":
      return "no expiry, or one inside the configured margin";
    case "expired":
      return "past its expiry";
    case "unsupported-pair":
      return "outside SOLVER_SUPPORTED_PAIRS";
    default:
      return "the solver's own exclusion reason";
  }
}

/** The kernel's book beside the solver's mirror (FR-012). */
export function bookRows(snapshot, registry) {
  const kernelBook = snapshot?.kernel?.book;
  if (!kernelBook || isError(kernelBook)) return [];
  const cache = solverSection(snapshot, "book");
  const cached = new Set((cache?.offers ?? []).map((offer) => offer.offerHash));
  const ladder = solverSection(snapshot, "ladder");
  const rungOf = new Map();
  for (const pair of ladder?.last?.provenance ?? []) {
    (pair.rungs ?? []).forEach((rung, index) => {
      if (rung.offerHash) rungOf.set(rung.offerHash, index + 1);
    });
  }
  const excludedBy = new Map();
  for (const exclusion of ladder?.last?.excluded ?? []) {
    excludedBy.set(exclusion.offerHash, exclusion.reason);
  }
  return kernelBook.offers.map((offer) => ({
    offerId: offer.offerId,
    status: offer.status,
    gives: offer.gives.map((leg) => ({ ...leg, label: tokenLabel(leg.token, registry), view: amountView(leg.amount, leg.token, registry) })),
    wants: offer.wants.map((leg) => ({ ...leg, label: tokenLabel(leg.token, registry), view: amountView(leg.amount, leg.token, registry) })),
    blockHeight: offer.blockHeight,
    expiresAt: offer.expiresAt,
    // `cache` is null while the solver is unreachable — "unknown", never "out".
    inCache: cache === null ? null : cached.has(offer.offerId),
    rung: rungOf.get(offer.offerId) ?? null,
    excludedReason: excludedBy.get(offer.offerId) ?? null,
  }));
}

/** The journal tail (User Story 3). Newest first, as the solver serves it. */
export function jobRows(snapshot, registry) {
  const journal = solverSection(snapshot, "journal");
  if (!journal || journal.state !== "open") return [];
  const now = snapshot.now;
  return journal.rows.map((row) => ({
    jobId: row.jobId,
    kind: row.operationKind,
    state: row.lifecycleState,
    tone: journalTone(row.lifecycleState),
    offerHashes: row.offerHashes,
    payouts: Object.entries(row.payouts ?? {}).map(([token, amount]) => ({
      token,
      label: tokenLabel(token, registry),
      view: amountView(amount, token, registry),
    })),
    receipt: receiptLabel(row.receipt, row.errorCode),
    ageMs: now - row.createdAtMs,
    age: durationLabel(now - row.createdAtMs),
    errorCode: row.errorCode,
  }));
}

export function journalTone(state) {
  const upper = String(state ?? "").toUpperCase();
  if (upper === "COMPLETED") return "ok";
  if (upper === "QUARANTINED" || upper === "REVERT_FAILED") return "bad";
  if (upper === "REFUSED" || upper === "REVERTED" || upper === "FAILED") return "warn";
  return "acc";
}

export function receiptLabel(receipt, errorCode) {
  if (errorCode) return errorCode;
  if (!receipt) return DASH;
  if (receipt.ledgerTxHash) {
    return `ledger ${shortHex(receipt.ledgerTxHash)}` +
      (receipt.ledgerHeight ? ` @ ${groupDigits(String(receipt.ledgerHeight))}` : "");
  }
  if (receipt.relayExtrinsicHash) return `relay ${shortHex(receipt.relayExtrinsicHash)}`;
  if (receipt.relayState) return `relay ${receipt.relayState}`;
  return DASH;
}

export function inventoryRows(snapshot, registry) {
  const inventory = solverSection(snapshot, "inventory");
  if (!inventory) return [];
  return inventory.tokens.map((row) => ({
    token: row.token,
    label: tokenLabel(row.token, registry),
    balance: amountView(row.balance, row.token, registry),
    reserved: amountView(row.reserved, row.token, registry),
    available: amountView(row.available, row.token, registry),
    price: registry?.get?.(row.token) ?? null,
  }));
}

export function dustView(snapshot) {
  const journal = solverSection(snapshot, "journal");
  const executor = solverSection(snapshot, "executor");
  if (!journal || !journal.dust) return null;
  const dust = journal.dust;
  return {
    configured: dust.configured,
    percent: dustPercent(dust),
    usage: dust.usage,
    maxPerWindow: dust.maxPerWindow,
    maxPerJob: dust.maxPerJob,
    windowMs: dust.windowMs,
    reservations: dust.reservations,
    blocked: executor ? executor.dustAvailable === false : null,
  };
}

export function relayView(snapshot, registry) {
  const relay = snapshot?.relay;
  if (!relay) return null;
  if (!relay.configured) {
    return { configured: false, tokens: [], error: null, agrees: null, latencyMs: null };
  }
  if (isError(relay.tokens)) {
    return { configured: true, tokens: [], error: relay.tokens.error, agrees: null, latencyMs: relay.latencyMs };
  }
  const tokens = relay.tokens ?? [];
  const ladder = solverSection(snapshot, "ladder");
  const advertised = ladder?.last?.tokenIds ?? null;
  const agrees =
    advertised === null
      ? null
      : advertised.length === tokens.length && advertised.every((token) => tokens.includes(token));
  return {
    configured: true,
    tokens: tokens.map((token) => ({ token, label: tokenLabel(token, registry) })),
    error: null,
    agrees,
    latencyMs: relay.latencyMs,
  };
}

/** The configuration panel: what the solver resolved, no secrets (FR-006). */
export function configRows(snapshot) {
  const process = solverSection(snapshot, "process");
  const admission = solverSection(snapshot, "admission");
  const listener = solverSection(snapshot, "listener");
  const journal = solverSection(snapshot, "journal");
  const rows = [];
  if (admission) {
    rows.push(["push interval", `${groupDigits(String(admission.pushIntervalMs))} ms`]);
    rows.push(["max parallel", `${admission.maxParallelSwaps} swaps`]);
    rows.push([
      "supported pairs",
      admission.supportedPairs === null ? "OPEN" : `${admission.supportedPairs.length} pair(s)`,
    ]);
    rows.push([
      "min job output",
      admission.minJobOutput === null
        ? "OPEN"
        : `${Object.keys(admission.minJobOutput).length} token(s)`,
    ]);
    rows.push([
      "fee sizing",
      `models ${admission.feeSizingTakerInputs} taker input(s) ` +
        `(funds up to ${admission.feeSizingTakerInputs + 2})`,
    ]);
    rows.push(["expiry margin", `${admission.expiryMarginSeconds} s`]);
    if (admission.settleTtlMinutes !== null && admission.settleTtlMinutes !== undefined) {
      rows.push(["settle TTL", `${admission.settleTtlMinutes} min`]);
    }
    if (admission.maxRungsPerPair !== null && admission.maxRungsPerPair !== undefined) {
      rows.push(["max rungs / pair", String(admission.maxRungsPerPair)]);
    }
  }
  if (process) {
    rows.push(["relay token", `${process.relayAuthTokenLength} chars (never shown)`]);
    rows.push(["relay ws", process.relayWsUrl ?? "not started (dry-run)"]);
    rows.push(["relay http", process.relayHttpUrl ?? "not started (dry-run)"]);
    rows.push(["kernel api", process.api]);
    rows.push(["network", process.network]);
    rows.push(["runtime", process.runtime ?? "unknown"]);
    rows.push([
      "build",
      `${process.gitCommit ?? "unknown commit"} · status contract v${
        snapshot?.solver?.snapshot?.contractVersion ?? "?"
      }`,
    ]);
  }
  if (journal && journal.path) rows.push(["journal", journal.path]);
  if (listener) rows.push(["status listener", `${listener.host}:${listener.port}`]);
  return rows;
}

/** The event log: the solver's relay diagnostics and the console's own
 *  transitions, merged and newest first (FR-012). */
export function eventRows(snapshot, limit = 200) {
  const rows = [];
  const relay = solverSection(snapshot, "relay");
  for (const event of relay?.events ?? []) {
    // A folded entry (consecutive repeats, see the contract) is shown once,
    // at its LATEST occurrence, with how many times it repeated since when.
    const count = Number(event.count ?? 1);
    const at = event.lastAt ?? event.at;
    rows.push({
      at,
      kind: event.kind,
      source: "solver",
      tone: event.severity === "error" ? "bad" : event.severity === "warn" ? "warn" : "ok",
      message:
        count > 1
          ? `${event.message} — ×${count} since ${clockLabel(event.at)}`
          : event.message,
      count,
    });
  }
  for (const transition of snapshot?.history ?? []) {
    rows.push({
      at: transition.at,
      kind: transition.kind,
      source: "console",
      tone: transitionTone(transition),
      message: `${transition.from} → ${transition.to} — ${transition.detail}`,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

export function transitionTone(transition) {
  const to = String(transition?.to ?? "");
  if (to === "reachable" || to === "connected" || to === "quoting" || to === "ok") return "ok";
  if (to === "unreachable" || to === "disconnected" || to === "error") return "bad";
  if (to === "unknown" || to === "not-started" || to === "never-reached") return "muted";
  return "warn";
}

/** The identity line in the header. */
export function identity(snapshot) {
  const process = solverSection(snapshot, "process");
  const solver = snapshot?.solver;
  return {
    network: process?.network ?? "unknown",
    kernel: hostOf(snapshot?.kernel?.api),
    relay: process?.relayWsUrl ? hostOf(process.relayWsUrl) : hostOf(snapshot?.relay?.url),
    mode: process?.mode ?? (solver?.state === "reachable" ? "unknown" : "unreachable"),
    uptime: process ? durationLabel(process.uptimeMs) : DASH,
  };
}

export function hostOf(url) {
  if (typeof url !== "string" || url === "") return DASH;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
