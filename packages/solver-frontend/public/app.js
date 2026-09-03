// The console's DOM layer (00007 FR-012 … FR-015b).
//
// Everything that JUDGES lives in `derive.js` and is unit-tested; this file
// only writes what those functions return into the page, keeps the SSE feed
// alive, and owns the two pieces of chrome that are not data: the theme toggle
// and the help tooltip.
//
// THREE DELIBERATE CHOICES:
//
//  1. **No `innerHTML` for anything derived from data.** Token names come from
//     the kernel's registry, which the API documents as UNVERIFIED — any
//     operator can register any name against any colour. Every value below is
//     written through `textContent`, so a name of `<img onerror=…>` is a funny
//     label and not script execution.
//  2. **"N s ago" advances between snapshots.** The age ticker estimates the
//     server's current clock as `snapshot.now + (Date.now() - receivedAt)`, so
//     the header counts up on a still page without ever trusting the browser's
//     absolute clock (FR-013).
//  3. **An ended stream is not an outage.** The aggregator, like the solver,
//     closes a `/api/stream` connection after five minutes so its client cap
//     can self-heal on a runtime that never reports disconnects (Q-A-1). A
//     stream that delivered frames and then ended is reconnected at once and
//     the feed chip never leaves "live".

import { HELP } from "./help.js";
import {
  admissionRows,
  agoLabel,
  alarms,
  bookRows,
  clockLabel,
  configRows,
  dustView,
  eventRows,
  exponential,
  groupDigits,
  identity,
  inventoryRows,
  isError,
  jobRows,
  ladderPairs,
  pillState,
  relayView,
  shortHex,
  stageStates,
  swatch,
  tileValues,
  tokenRegistry,
} from "./derive.js";

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

const $ = (selector) => document.querySelector(selector);

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) node.textContent = String(textContent);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A shortened identifier: full value in the title, click to copy (FR-013). */
function hexNode(value, head = 8, tail = 4) {
  const node = el("span", "hex", shortHex(value, head, tail));
  node.title = String(value ?? "");
  node.addEventListener("click", () => {
    try {
      void navigator.clipboard?.writeText(String(value ?? ""));
      const previous = node.textContent;
      node.textContent = "copied";
      setTimeout(() => {
        node.textContent = previous;
      }, 700);
    } catch {
      // Clipboard access is a nicety; the title attribute is the guarantee.
    }
  });
  return node;
}

function tagNode(tone, label) {
  return el("span", tone ? `tag ${tone}` : "tag", label);
}

/** A token with its stable swatch. */
function symbolNode(colour, label) {
  const node = el("span", "sym");
  const swatchNode = el("i");
  swatchNode.style.background = swatch(colour);
  node.append(swatchNode, document.createTextNode(label));
  node.title = String(colour ?? "");
  return node;
}

/** Base units, with the coin value beside it when the registry has decimals
 *  (FR-013b) — always marked, never substituted for the base units. */
function amountCell(view, label) {
  const cell = el("td", "num");
  cell.append(document.createTextNode(label ? `${view.base} ${label}` : view.base));
  if (view.coins !== null) {
    cell.append(el("div", "coins", `= ${view.coins} coin${view.coins === "1" ? "" : "s"}`));
  }
  return cell;
}

function table(headers, rows) {
  const node = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const header of headers) {
    const th = el("th", header.numeric ? "num" : null, header.label);
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = el("tbody");
  for (const row of rows) tbody.append(row);
  node.append(thead, tbody);
  return node;
}

function emptyNode(message) {
  return el("div", "empty", message);
}

// ── theme (FR-014) ───────────────────────────────────────────────────────────

const root = document.documentElement;
const applyTheme = (theme) => {
  if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
};
try {
  applyTheme(localStorage.getItem("cow-console-theme") ?? "");
} catch {
  // A browser with storage disabled simply follows prefers-color-scheme.
}
$("#theme").addEventListener("click", () => {
  const dark =
    root.getAttribute("data-theme") === "dark" ||
    (!root.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("cow-console-theme", next);
  } catch {
    // Not persisting is acceptable; the toggle still works for this page view.
  }
});

// ── help tooltips (FR-015b) ──────────────────────────────────────────────────

// One floating element for the whole page, positioned per target and clamped
// inside the viewport, shown on hover AND on keyboard focus, dismissed with
// Escape. Texts come from `help.js`, never from the markup.
const tip = $("#tip");
let tipFor = null;

for (const node of document.querySelectorAll(".help")) {
  const entry = HELP[node.dataset.help];
  if (entry === undefined) continue;
  node.dataset.tip = entry.text;
  node.dataset.src = entry.source;
}

function showTip(node) {
  tipFor = node;
  clear(tip);
  tip.append(document.createTextNode(node.dataset.tip ?? ""));
  if (node.dataset.src) {
    const source = el("span", "src");
    source.append(el("b", null, "source"), document.createTextNode(node.dataset.src));
    tip.append(source);
  }
  tip.setAttribute("data-show", "");
  const rect = node.getBoundingClientRect();
  const pad = 8;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const x = Math.min(Math.max(pad, rect.left + rect.width / 2 - width / 2), innerWidth - width - pad);
  let y = rect.bottom + 8;
  if (y + height > innerHeight - pad) y = rect.top - height - 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(pad, y)}px`;
}

const hideTip = () => {
  tipFor = null;
  tip.removeAttribute("data-show");
};

document.addEventListener("mouseover", (event) => {
  const node = event.target.closest?.(".help");
  if (node) showTip(node);
});
document.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".help") && !event.relatedTarget?.closest?.(".help")) hideTip();
});
document.addEventListener("focusin", (event) => {
  const node = event.target.closest?.(".help");
  if (node) showTip(node);
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".help")) hideTip();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideTip();
});
addEventListener("scroll", () => {
  if (tipFor) showTip(tipFor);
}, { passive: true });
addEventListener("resize", () => {
  if (tipFor) showTip(tipFor);
});

// ── rendering ────────────────────────────────────────────────────────────────

let latest = null;
let receivedAt = 0;

/** The server's clock as it is right now, extrapolated from the last snapshot
 *  (FR-013 — never the browser's absolute clock). */
const serverNow = () => (latest === null ? 0 : latest.now + (Date.now() - receivedAt));

function renderHeader(snapshot) {
  const id = identity(snapshot);
  $("#id-net").textContent = id.network;
  $("#id-kernel").textContent = id.kernel;
  $("#id-relay").textContent = id.relay;
  $("#id-mode").textContent = id.mode;
  $("#id-up").textContent = id.uptime;

  const pill = pillState(snapshot);
  const pillNode = $("#pill");
  pillNode.className = `pill ${pill.tone}`;
  pillNode.textContent = pill.text;

  document.body.classList.toggle("solver-down", snapshot.solver.state !== "reachable");
}

function renderStrip(snapshot) {
  for (const stage of stageStates(snapshot)) {
    const node = document.querySelector(`.stage[data-stage="${stage.id}"]`);
    if (node === null) continue;
    node.className = `stage ${stage.tone}`;
    node.querySelector(".s").textContent = stage.summary;
    node.querySelector(".since").textContent = stage.since;
  }
}

function renderAlarms(snapshot) {
  const host = $("#alarms");
  clear(host);
  const list = alarms(snapshot);
  host.hidden = list.length === 0;
  for (const alarm of list) {
    const node = el("div", `alarm ${alarm.tone}`);
    node.append(el("span", "k", alarm.key), el("span", "m", alarm.message));
    host.append(node);
  }
}

function renderTiles(snapshot) {
  const values = tileValues(snapshot);
  for (const [id, value] of Object.entries(values)) {
    const node = document.querySelector(`.tile[data-tile="${id}"]`);
    if (node === null) continue;
    node.querySelector(".v").textContent = value.value;
    node.querySelector(".d").textContent = value.detail;
  }
}

function renderLadders(snapshot, registry) {
  const host = $("#ladders");
  clear(host);
  const ladder = snapshot.solver.snapshot?.ladder;
  const pairs = ladderPairs(snapshot, registry);
  const count = $("#ladders-count");

  if (snapshot.solver.state !== "reachable") {
    count.textContent = "solver unreachable";
    host.append(emptyNode("The solver is not answering — the last ladder it published is below only if it was seen before it went away."));
    if (pairs.length === 0) return;
  } else if (ladder === undefined || isError(ladder)) {
    count.textContent = "unavailable";
    host.append(emptyNode(isError(ladder) ? `The solver could not collect this section: ${ladder.error}` : "No solver snapshot yet."));
    return;
  } else if (ladder.state === "not-started") {
    count.textContent = "dry-run";
    host.append(emptyNode("Dry-run: no relay client is running, so nothing is published."));
    return;
  } else if (ladder.last === null) {
    count.textContent = "no push yet";
    host.append(emptyNode("The solver has not derived a push yet."));
    return;
  } else {
    const push = ladder.last;
    count.textContent =
      `contract v${snapshot.solver.snapshot.contractVersion} · pushed ${clockLabel(push.derivedAt)} (${push.cause})`;
    if (push.withheld !== null) {
      // The empty push IS the withdrawal — say so, rather than letting an empty
      // table read as "no liquidity" (User Story 1, acceptance 3).
      host.append(
        emptyNode(
          push.withheld === "withdrawn"
            ? "EMPTY BY DESIGN — the solver withdrew its quotes deliberately (graceful stop or explicit withdrawal). The relay is holding an empty ladder."
            : `EMPTY BY DESIGN — this push is the fail-closed withdrawal (${push.withheld}). It is not an absence of liquidity; the solver refuses to quote from a cache it cannot trust.`,
        ),
      );
      return;
    }
  }

  if (pairs.length === 0) {
    host.append(emptyNode("The last push carried no directed pair."));
    return;
  }

  for (const pair of pairs) {
    const block = el("div", "ladder");
    const head = el("div", "pair");
    head.append(
      symbolNode(pair.tokenIn, pair.labelIn),
      el("span", "arrow", "→"),
      symbolNode(pair.tokenOut, pair.labelOut),
      hexNode(`${pair.tokenIn} → ${pair.tokenOut}`, 8, 8),
    );
    head.append(
      el(
        "span",
        "meta",
        `${pair.rungs.length} rung(s)` +
          (pair.residualBound === null
            ? ""
            : ` · residual budget ${groupDigits(pair.residualBound)} ${pair.labelOut}`),
      ),
    );
    block.append(head);

    const rows = pair.rungs.map((rung) => {
      const row = el("tr", "rung");
      row.append(el("td", "mono", String(rung.index)));
      row.append(amountCell(rung.inputView));
      row.append(amountCell(rung.outputView));
      row.append(el("td", "num", rung.rate ?? "—"));
      const kind = el("td");
      kind.append(tagNode(rung.kind === "whole" ? "ok" : "acc", rung.kind));
      row.append(kind);
      const closes = el("td");
      if (rung.offerHash) closes.append(hexNode(rung.offerHash));
      else closes.append(el("span", "muted", "solver inventory"));
      row.append(closes);
      return row;
    });
    const scroll = el("div", "scroll");
    scroll.append(
      table(
        [
          { label: "#" },
          { label: "Taker gives (cumulative)", numeric: true },
          { label: "Taker gets", numeric: true },
          { label: "Rate", numeric: true },
          { label: "Kind" },
          { label: "Closes maker offer" },
        ],
        rows,
      ),
    );
    block.append(scroll);
    host.append(block);
  }
}

function renderExclusions(snapshot, registry) {
  const host = $("#exclusions");
  clear(host);
  const rows = admissionRows(snapshot, registry);
  $("#exclusions-count").textContent = rows.length === 0 ? "" : `${rows.length} excluded`;
  if (rows.length === 0) {
    host.append(
      emptyNode(
        snapshot.solver.state === "reachable"
          ? "Nothing was excluded from the last push."
          : "Unknown while the solver is unreachable.",
      ),
    );
    return;
  }
  host.append(
    table(
      [{ label: "Offer" }, { label: "Pair" }, { label: "Reason" }, { label: "Detail" }],
      rows.map((row) => {
        const tr = el("tr");
        const offer = el("td");
        offer.append(hexNode(row.offerHash));
        tr.append(offer);
        tr.append(el("td", "mono", row.pair));
        const reason = el("td");
        reason.append(tagNode(row.tone, row.reason));
        tr.append(reason);
        tr.append(el("td", "muted", row.detail));
        return tr;
      }),
    ),
  );
}

function renderBook(snapshot, registry) {
  const host = $("#book");
  clear(host);
  const kernelBook = snapshot.kernel.book;
  const cache = snapshot.solver.snapshot?.book;
  const count = $("#book-count");
  if (kernelBook === null) {
    count.textContent = "not read yet";
    host.append(emptyNode("The kernel has not been read yet."));
    return;
  }
  if (isError(kernelBook)) {
    count.textContent = "kernel unreachable";
    host.append(emptyNode(`The kernel book could not be read: ${kernelBook.error}`));
    return;
  }
  const cacheSize = cache !== undefined && !isError(cache) ? cache.size : null;
  count.textContent =
    `kernel ${kernelBook.count}` +
    (cacheSize === null ? " · cache unknown" : ` · cache ${cacheSize}`) +
    (snapshot.kernel.fetchedAt === null ? "" : ` · read ${agoLabel(snapshot.now, snapshot.kernel.fetchedAt)}`) +
    (kernelBook.nextCursor === null ? "" : ` · first ${kernelBook.limit} only`);

  const rows = bookRows(snapshot, registry);
  if (rows.length === 0) {
    host.append(emptyNode("The kernel book is empty — there is nothing to quote against."));
    return;
  }
  host.append(
    table(
      [
        { label: "Offer" },
        { label: "Status" },
        { label: "Maker gives" },
        { label: "Maker wants" },
        { label: "Height", numeric: true },
        { label: "Expires" },
        { label: "Cache" },
        { label: "Wire" },
      ],
      rows.map((row) => {
        const tr = el("tr", row.status === "live" ? null : "dim");
        const offer = el("td");
        offer.append(hexNode(row.offerId));
        tr.append(offer);
        const status = el("td");
        status.append(tagNode(row.status === "live" ? "ok" : null, row.status));
        tr.append(status);
        const legCell = (legs) => {
          const cell = el("td", "mono");
          legs.forEach((leg, index) => {
            if (index > 0) cell.append(document.createTextNode(" + "));
            cell.append(document.createTextNode(`${leg.view.base} ${leg.label}`));
          });
          return cell;
        };
        tr.append(legCell(row.gives), legCell(row.wants));
        tr.append(el("td", "num", row.blockHeight === null ? "—" : groupDigits(row.blockHeight)));
        tr.append(
          el(
            "td",
            "mono",
            row.expiresAt === null ? "—" : new Date(row.expiresAt).toLocaleTimeString(),
          ),
        );
        const cacheCell = el("td");
        cacheCell.append(
          row.inCache === null
            ? tagNode(null, "unknown")
            : tagNode(row.inCache ? "ok" : "warn", row.inCache ? "in" : "out"),
        );
        tr.append(cacheCell);
        const wire = el("td");
        if (row.rung !== null) wire.append(tagNode("ok", `rung ${row.rung}`));
        else if (row.excludedReason !== null) wire.append(tagNode("warn", row.excludedReason));
        else wire.append(el("span", "muted", "—"));
        tr.append(wire);
        return tr;
      }),
    ),
  );
}

function renderJobs(snapshot, registry) {
  const host = $("#jobs");
  clear(host);
  const journal = snapshot.solver.snapshot?.journal;
  const count = $("#jobs-count");
  if (journal === undefined || isError(journal)) {
    count.textContent = "unavailable";
    host.append(
      emptyNode(
        isError(journal)
          ? `The solver could not collect this section: ${journal.error}`
          : "Unknown while the solver is unreachable.",
      ),
    );
    return;
  }
  if (journal.state === "not-opened") {
    count.textContent = "dry-run";
    host.append(emptyNode("Dry-run: a dry-run solver owns no journal."));
    return;
  }
  count.textContent = `${journal.rows.length} of ${journal.total} rows`;
  const rows = jobRows(snapshot, registry);
  if (rows.length === 0) {
    host.append(emptyNode("No operation has been journalled yet."));
    return;
  }
  host.append(
    table(
      [
        { label: "Job" },
        { label: "Kind" },
        { label: "State" },
        { label: "Offers" },
        { label: "Payout", numeric: true },
        { label: "Receipt" },
        { label: "Age", numeric: true },
      ],
      rows.map((row) => {
        const tr = el("tr", row.tone === "bad" ? "hot" : null);
        const job = el("td");
        job.append(hexNode(row.jobId, 8, 2));
        tr.append(job);
        tr.append(el("td", "mono", row.kind));
        const state = el("td");
        state.append(tagNode(row.tone, row.state));
        tr.append(state);
        const offers = el("td");
        if (row.offerHashes.length === 0) offers.append(el("span", "muted", "—"));
        row.offerHashes.forEach((hash, index) => {
          if (index > 0) offers.append(document.createTextNode(" "));
          offers.append(hexNode(hash));
        });
        tr.append(offers);
        const payout = el("td", "num");
        if (row.payouts.length === 0) payout.append(document.createTextNode("—"));
        for (const entry of row.payouts) {
          payout.append(el("div", null, `${entry.view.base} ${entry.label}`));
        }
        tr.append(payout);
        tr.append(el("td", "mono", row.receipt));
        tr.append(el("td", "num", row.age));
        return tr;
      }),
    ),
  );
}

function renderInventory(snapshot, registry) {
  const host = $("#inventory");
  clear(host);
  const inventory = snapshot.solver.snapshot?.inventory;
  const count = $("#inventory-count");
  if (inventory === undefined || isError(inventory)) {
    count.textContent = "unavailable";
    host.append(emptyNode("Unknown while the solver is unreachable."));
    return;
  }
  count.textContent = inventory.ready ? "authoritative" : "not authoritative";
  const rows = inventoryRows(snapshot, registry);
  if (rows.length === 0) {
    host.append(
      emptyNode(
        inventory.ready
          ? "The solver holds no token balance."
          : "Balances are withdrawn — the solver does not trust them right now.",
      ),
    );
    return;
  }
  host.append(
    table(
      [
        { label: "Token" },
        { label: "Balance", numeric: true },
        { label: "Reserved", numeric: true },
        { label: "Available", numeric: true },
      ],
      rows.map((row) => {
        const tr = el("tr");
        const token = el("td");
        token.append(symbolNode(row.token, row.label));
        if (row.price && row.price.priceUsd) {
          const price = el(
            "div",
            "coins",
            `$${row.price.priceUsd}/unit · ${row.price.priceSource}` +
              (row.price.priceSource === "fallback" ? " (NOT a market price)" : ""),
          );
          token.append(price);
        }
        tr.append(token);
        tr.append(amountCell(row.balance), amountCell(row.reserved), amountCell(row.available));
        return tr;
      }),
    ),
  );
}

function renderDust(snapshot) {
  const host = $("#dust");
  clear(host);
  const dust = dustView(snapshot);
  if (dust === null) {
    host.append(emptyNode("Unknown while the solver is unreachable."));
    return;
  }
  if (!dust.configured) {
    host.append(
      emptyNode("DUST admission is OPEN — no per-job or per-window fee limit is configured."),
    );
    return;
  }
  const meter = el("div", dust.blocked ? "meter blocked" : "meter");
  const fill = el("i");
  fill.style.width = `${Math.min(100, Math.max(0, dust.percent))}%`;
  meter.append(fill);
  meter.title = `${dust.usage} of ${dust.maxPerWindow} SPECKs`;
  host.append(meter);

  const kv = el("dl", "kv");
  kv.style.marginTop = "10px";
  const row = (key, value, tone) => {
    kv.append(el("dt", null, key));
    kv.append(el("dd", tone ?? null, value));
  };
  // SPECK figures are 16 digits; the exponent form is what an operator reads.
  row(
    "used / window",
    `${exponential(dust.usage)} / ${exponential(dust.maxPerWindow)} SPECKs · ` +
      `${Math.round((dust.windowMs ?? 0) / 60000)} min`,
  );
  row("per job max", `${exponential(dust.maxPerJob)} SPECKs`);
  row(
    "reservations",
    `${dust.reservations.reserved} reserved · ${dust.reservations.spent} spent · ${dust.reservations.released} released`,
  );
  row("window blocked", dust.blocked === null ? "unknown" : dust.blocked ? "YES" : "no", dust.blocked ? "bad" : "ok");
  host.append(kv);
}

function renderRelay(snapshot, registry) {
  const host = $("#relay");
  clear(host);
  const view = relayView(snapshot, registry);
  if (view === null || !view.configured) {
    host.append(
      emptyNode("No relay HTTP base configured (SOLVER_FRONTEND_RELAY_HTTP_URL) — the relay's public token list is not read."),
    );
    return;
  }
  if (view.error !== null) {
    host.append(emptyNode(`The relay did not answer: ${view.error}`));
    return;
  }
  const kv = el("dl", "kv");
  kv.append(el("dt", null, "tokens advertised"));
  const tokens = el("dd");
  if (view.tokens.length === 0) {
    tokens.append(el("span", "muted", "none — no solver is advertising anything"));
  } else {
    view.tokens.forEach((entry, index) => {
      if (index > 0) tokens.append(document.createTextNode(", "));
      tokens.append(document.createTextNode(entry.label));
    });
    if (view.agrees !== null) {
      tokens.append(document.createTextNode(" "));
      tokens.append(
        tagNode(view.agrees ? "ok" : "warn", view.agrees ? "matches ladder" : "differs from ladder"),
      );
    }
  }
  kv.append(tokens);
  kv.append(el("dt", null, "http"));
  kv.append(
    el(
      "dd",
      null,
      `${snapshot.relay.url ?? "—"}` +
        (view.latencyMs === null ? "" : ` · 200 in ${view.latencyMs} ms`),
    ),
  );
  host.append(kv);
}

function renderConfig(snapshot) {
  const host = $("#config");
  clear(host);
  const rows = configRows(snapshot);
  if (rows.length === 0) {
    host.append(emptyNode("Unknown while the solver is unreachable."));
    return;
  }
  const kv = el("dl", "kv");
  for (const [key, value] of rows) {
    kv.append(el("dt", null, key));
    kv.append(el("dd", null, value));
  }
  host.append(kv);
}

function renderEvents(snapshot) {
  const host = $("#events");
  clear(host);
  const rows = eventRows(snapshot);
  $("#events-count").textContent = rows.length === 0 ? "" : `newest ${rows.length}`;
  if (rows.length === 0) {
    host.append(emptyNode("Nothing has happened yet."));
    return;
  }
  const list = el("ul", "events");
  for (const row of rows) {
    const item = el("li");
    item.append(el("span", "t", clockLabel(row.at)));
    item.append(el("span", `dot ${row.tone}`));
    const kind = el("span", "k", row.kind);
    kind.append(el("span", "src", row.source));
    item.append(kind);
    item.append(el("span", "m", row.message));
    list.append(item);
  }
  host.append(list);
}

function render(snapshot) {
  latest = snapshot;
  receivedAt = Date.now();
  const registry = tokenRegistry(snapshot);
  renderHeader(snapshot);
  renderStrip(snapshot);
  renderAlarms(snapshot);
  renderTiles(snapshot);
  renderLadders(snapshot, registry);
  renderExclusions(snapshot, registry);
  renderBook(snapshot, registry);
  renderJobs(snapshot, registry);
  renderInventory(snapshot, registry);
  renderDust(snapshot);
  renderRelay(snapshot, registry);
  renderConfig(snapshot);
  renderEvents(snapshot);
  tickAge();
}

function tickAge() {
  if (latest === null) return;
  $("#updated").textContent = `updated ${agoLabel(serverNow(), latest.now)}`;
}
setInterval(tickAge, 1000);

// ── the feed (FR-015) ────────────────────────────────────────────────────────

const feedChip = $("#feed");
let source = null;
let pollTimer = null;
let backoff = 500;

function setFeed(state, label) {
  feedChip.className = state === "live" ? "chip live" : state === "down" ? "chip down" : "chip";
  feedChip.textContent = label;
}

async function pollSnapshot() {
  try {
    const response = await fetch("/api/snapshot", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    setFeed("down", `feed down (${error instanceof Error ? error.message : "error"})`);
  }
}

/** While the stream is down, poll every 10 s so the page keeps moving. */
function startPolling() {
  if (pollTimer !== null) return;
  void pollSnapshot();
  pollTimer = setInterval(() => void pollSnapshot(), 10000);
}

function stopPolling() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function connect() {
  let received = 0;
  setFeed(latest === null ? "connecting" : "live", latest === null ? "feed connecting" : "feed live");
  try {
    source = new EventSource("/api/stream");
  } catch {
    startPolling();
    return;
  }
  source.addEventListener("message", (event) => {
    received += 1;
    stopPolling();
    backoff = 500;
    setFeed("live", "feed live");
    try {
      render(JSON.parse(event.data));
    } catch {
      // A malformed frame is not a reason to tear down a working feed.
    }
  });
  source.addEventListener("error", () => {
    // EventSource retries on its own on a fixed schedule; take the connection
    // back so the backoff below is the one that applies.
    try {
      source?.close();
    } catch {
      /* already closed */
    }
    source = null;
    if (received > 0) {
      // The server's five-minute stream lifetime, or a redeploy. Reconnect at
      // once: this is the NORMAL end of a healthy stream (Q-A-1).
      setFeed("live", "feed live");
      setTimeout(connect, 250);
      return;
    }
    setFeed("down", "feed reconnecting");
    startPolling();
    const wait = backoff;
    backoff = Math.min(backoff * 2, 10000);
    setTimeout(connect, wait);
  });
}

void pollSnapshot().then(connect);
