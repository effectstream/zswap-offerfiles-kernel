// Help texts for every block on the page (00007 FR-015b).
//
// ONE SENTENCE, then the SOURCE. That shape is a user decision (2026-09-02:
// "no verbose explanations"): an operator hovering a tile wants to know what
// the number means and where it came from, not a paragraph. Every text below
// is VERBATIM from the approved mockup
// (`spec/00007-cow-solver-frontend-design-mock.html`) — this file is the
// mockup's `data-tip` / `data-src` attributes lifted into data.
//
// The page never hard-codes a tooltip. `index.html` marks each help affordance
// with `data-help="<id>"`, `app.js` fills in the text from this map at boot,
// and `derive.test.ts` asserts that the set of ids in the HTML and the set of
// keys here are EXACTLY equal — so a new block without help, and a help entry
// for a block that no longer exists, are both test failures rather than
// something a reviewer has to notice.

/** @typedef {{ text: string, source: string }} HelpEntry */

/** @type {Record<string, HelpEntry>} */
export const HELP = {
  // ── header ────────────────────────────────────────────────────────────────
  pill: {
    text: "Overall verdict: quoting, withdrawn (empty push), disconnected, starting, dry-run, or unreachable.",
    source: "console, from the solver snapshot",
  },
  updated: {
    text: "Age of the latest snapshot, by the server's clock.",
    source: "console /api/stream",
  },

  // ── the six-stage health strip ────────────────────────────────────────────
  "stage-kernel": {
    text: "The kernel's sync status and how far it lags Midnight and Celestia.",
    source: "kernel /v1/health/sync",
  },
  "stage-cache": {
    text: "Whether the solver's copy of the book is current, or blocked and why.",
    source: "solver book-sync",
  },
  "stage-inventory": {
    text: "Whether wallet balances are trusted right now; emptied while the cache is blocked.",
    source: "solver inventory",
  },
  "stage-journal": {
    text: "Journal reconciled and fee budget available; open = unfinished rows.",
    source: "solver journal + executor",
  },
  "stage-relay": {
    text: "Connection to the Midnight Intents relay, and reconnect count.",
    source: "solver relay client",
  },
  "stage-ladder": {
    text: "What the last push put on the wire; EMPTY means withdrawn.",
    source: "solver last push",
  },

  // ── stat tiles ────────────────────────────────────────────────────────────
  "tile-pairs": {
    text: "Pairs in the last price-levels frame vs pairs in the book.",
    source: "solver last push + book",
  },
  "tile-rungs": {
    text: "Price levels on the wire. Whole = closes a maker offer; interior = needs solver tokenOut.",
    source: "solver last push",
  },
  "tile-tokens": {
    text: "Tokens in the last capabilities frame; should match the relay's list.",
    source: "solver last push + relay /tokens",
  },
  "tile-pushes": {
    text: "Pushes sent; coalesced = merged into one in flight; failed = not sent.",
    source: "solver relay client",
  },
  "tile-book": {
    text: "Live offers in the kernel vs offers in the solver's cache.",
    source: "kernel /v1/offers + solver book",
  },
  "tile-jobs": {
    text: "Swap jobs being built or awaiting the relay's result.",
    source: "solver executor",
  },
  "tile-completed": {
    text: "Settled, refused, and reverted jobs since start.",
    source: "solver executor",
  },
  "tile-quarantined": {
    text: "Jobs needing an operator, plus failed reverts. Non-zero is an alarm.",
    source: "solver executor",
  },
  "tile-withdrawals": {
    text: "Times the solver pulled all quotes, and the last window.",
    source: "console, from push events",
  },
  "tile-dust": {
    text: "Fee reserved for the latest job, in SPECKs.",
    source: "solver journal",
  },

  // ── sections ──────────────────────────────────────────────────────────────
  "section-ladders": {
    text: "Per pair: cumulative input → output, rate, whole or interior, and the maker offer each rung closes.",
    source: "solver last push",
  },
  "section-exclusions": {
    text: "Book offers the ladder left out, with the solver's own reason.",
    source: "solver last push exclusions",
  },
  "section-book": {
    text: "The kernel's offers, with whether each is cached and on the wire.",
    source: "kernel /v1/offers + solver",
  },
  "section-jobs": {
    text: "Newest journal rows: state, offers, payout, receipt. No transaction bytes.",
    source: "solver journal",
  },
  "section-inventory": {
    text: "Wallet balance per token: total, reserved by jobs, available.",
    source: "solver stock; names from kernel /v1/known-tokens",
  },
  "section-dust": {
    text: "Fee spent in the rolling window vs its limit, and the per-job cap.",
    source: "solver journal",
  },
  "section-relay": {
    text: "Tokens the relay says connected solvers advertise.",
    source: "relay /tokens",
  },
  "section-config": {
    text: "Launch settings as resolved at startup. No secrets.",
    source: "solver snapshot",
  },
  "section-events": {
    text: "Solver diagnostics and console-observed state changes, newest first.",
    source: "solver + console",
  },
};

/** Every block id that must carry a help affordance. */
export const HELP_IDS = Object.keys(HELP);
