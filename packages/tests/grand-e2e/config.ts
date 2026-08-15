// Grand-e2e scale knobs. Every number here is deterministic — the offer plan,
// seeds, amounts and pair prices are pure functions of these values, so two
// runs with the same config produce byte-identical chain writes (the basis of
// the Phase-7 determinism check). NO Math.random anywhere in this suite.

export const API = process.env["ZSWAP_API"] ?? "http://127.0.0.1:9999";
export const BATCHER_URL = process.env["BATCHER_SUBMIT_URL"] ?? "http://127.0.0.1:3334";
export const CELESTIA_RPC_URL = process.env["CELESTIA_RPC_URL"] ?? "http://127.0.0.1:26658";
export const CELESTIA_AUTH_TOKEN = process.env["CELESTIA_AUTH_TOKEN"] ?? "";
export const ORCHESTRATOR_URL = "http://127.0.0.1:4747";

// The stack MUST be launched with these windows (see HANDOFF §2):
//   ROOT_WINDOW_SECONDS=600 OFFER_TTL_SECONDS=600 bun run dev
// Phase 0 verifies the running node actually has them.
export const ROOT_WINDOW_SECONDS = 600;
export const OFFER_TTL_SECONDS = 600;

// ── Real-offer scale (HANDOFF §2, §7) ────────────────────────────────────────
// Totals INCLUDE the offers made by the precision phases (p1 happy path, p3
// lifecycle); phase 5 tops the counts up to these targets.
export const TOTAL_OFFERS = Number(process.env["GRAND_OFFERS"] ?? 500);
export const FATE_SPLIT = {
  settled: 0.4,
  cancelled: 0.2,
  expired: 0.2,
  live: 0.2,
} as const;

// Offers the run may lose to environmental races (e.g. a root aging out of the
// 10-minute window between proving and Celestia ingestion). Casualties are
// logged in the ledger, mapped against offer_rejections in the audit, and the
// run stays green while the rate is below this.
export const MAX_CASUALTY_RATE = 0.02;

// ── Load storms (HANDOFF §7 phase 5a) ────────────────────────────────────────
export const STORM_API_INVALID_COUNT = Number(process.env["GRAND_STORM_API"] ?? 2000);
export const STORM_CELESTIA_GARBAGE_COUNT = Number(process.env["GRAND_STORM_CELESTIA"] ?? 300);
export const STORM_CELESTIA_RATE_MS = 1000; // ~1 blob/s
export const STORM_RSS_GROWTH_MAX = 0.30;   // node RSS must grow < 30% during 5a
export const STORM_API_P95_MS = 500;

// ── Wallets (HANDOFF §7 phase 5b) ────────────────────────────────────────────
// Deterministic 64-hex seeds, disjoint from the existing e2e suites (which use
// …30/…31/…50/…51 and the api-examples defaults).
const seed = (b: string): string => b.padStart(64, "0");
// 8 general makers (settled / expired / live fates)…
export const MAKER_SEEDS: string[] = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"].map(seed);
// …plus 2 cancel specialists (single-coin and two-coin renewable wallets — see
// actors/wallets.ts for why cancels need controlled coin pools).
export const CANCEL_SINGLE_SEED = seed("c0");
export const CANCEL_DOUBLE_SEED = seed("c1");
export const TAKER_SEEDS: string[] = ["b0", "b1", "b2", "b3", "b4", "b5"].map(seed);

// ── Tokens ───────────────────────────────────────────────────────────────────
// Three shielded + two unshielded colors minted by genesis at suite start.
// Domain separators are disjoint from the startup mint (0x70/0x63) and the
// other e2e suites (0xa0/0xa1/0xd0/0xd1).
//
// TC exists ONLY for the §2.5 basket fixture, and a third shielded colour is
// genuinely required for it: a basket needs two colours on one side, and
// merging two offers drawn from {TA, TB} always nets back to one colour per
// side (TA->TB merged with TB->TA cancels; TA->TB merged with TA->TB just
// sums). TA->TB merged with TC->TB is the smallest real basket.
//
// No maker or taker is funded in TC — only the basket specialist is (see
// setupActors) — so the funding plan's per-offer arithmetic is untouched.
export const TOKEN_SEPS = { TA: 0xe0, TB: 0xe1, UA: 0xe2, UB: 0xe3, TC: 0xe4 } as const;
export type TokenKey = keyof typeof TOKEN_SEPS;

// Fixed reference prices per (give → want) direction, used to derive want
// amounts. Purely a test-side convention; ±5% deterministic wiggle by index.
export const PAIR_PRICE: Record<string, number> = {
  "TA>TB": 1.25,
  "TB>TA": 0.8,
  "UA>UB": 1.5,
  "UB>UA": 0.66,
  "TA>UA": 2.0,
  "TB>UB": 0.5,
  "UA>TA": 0.5,
  "UB>TB": 2.0,
  // Basket fixture only (§2.5): TC is never offered on its own.
  "TC>TB": 1.1,
};

// Coin denominations created by the funding fan-out. Every offer gives less
// than one coin, so wallet coin-selection needs exactly one coin per offer.
export const SHIELDED_COIN = 2000n;
export const UNSHIELDED_COIN = 2000n;
export const TAKER_COIN = 3000n; // wants can reach ~2500
export const GIVE_MIN = 500n;
export const GIVE_SPAN = 1000n; // give ∈ [500, 1500]

export const MINT_AMOUNT = 1_000_000_000n; // genesis mint per color

// Publish every Nth valid offer via direct blob.Submit instead of the API
// (path-B positive coverage at scale; 1.4 does one explicitly too).
export const DIRECT_CELESTIA_EVERY = 20;

// Offer/settle transaction TTLs (Midnight tx validity — NOT the indexer TTL).
export const TX_TTL_MS = 30 * 60_000;

// ── Timing / polling ─────────────────────────────────────────────────────────
export const INDEX_WAIT_TRIES = 36;     // × 5 s — publish → offer_file row
export const ARCHIVE_WAIT_TRIES = 36;   // × 5 s — spend → history row
export const EXPIRY_SLACK_MS = 240_000; // sweep slack past the 600 s TTL

// A raw blob.Submit is the first leg of the same Celestia → STM → DB path.
// Give it the same 180-second budget as indexing: a fixed 90-second fetch
// timeout aborted the run-3 same-block pair while measured STM lag was still
// inside the valid-run envelope. This is one shared budget, not a second knob
// that can silently drift from INDEX_WAIT_TRIES.
export const CELESTIA_RPC_TIMEOUT_MS = INDEX_WAIT_TRIES * 5_000;

// Client-side API budget: the node rate-limits 60 req/min/IP, and this suite
// shares that budget across everything it does. Normal phases stay under it
// (DB polls are free); the 5a storm deliberately blows through it.
export const API_SOFT_LIMIT_PER_MIN = 45;

// ── Determinism / audit ──────────────────────────────────────────────────────
export const NODE_B_API_PORT = 9998;
export const NODE_B_DB_PORT = 5433;
/** Instance B runs a full runtime, which also starts an embedded MQTT broker on
 *  four FIXED ports (8883/9883 engine, 8884/9884 batcher). Those are not
 *  governed by EFFECTSTREAM_API_PORT, so without private values here B dies at
 *  boot with `Failed to listen at 127.0.0.1` — instance A already owns 8883. */
export const NODE_B_MQTT_PORTS = {
  MQTT_ENGINE_BROKER_PORT: "8893",
  MQTT_ENGINE_BROKER_WS_PORT: "9893",
  MQTT_BATCHER_BROKER_PORT: "8894",
  MQTT_BATCHER_BROKER_WS_PORT: "9894",
  MQTT_ENGINE_BROKER_URL: "mqtt://127.0.0.1:8893",
  MQTT_ENGINE_BROKER_WS_URL: "ws://127.0.0.1:9893",
  MQTT_BATCHER_BROKER_URL: "mqtt://127.0.0.1:8894",
  MQTT_BATCHER_BROKER_WS_URL: "ws://127.0.0.1:9894",
} as const;
export const NODE_B_SYNC_TIMEOUT_MS = 45 * 60_000;

// Tables excluded from the state diff, with reasons (documented in the
// scorecard). Everything else in `public` must be byte-identical.
export const DIFF_EXCLUDED_TABLES: Record<string, string> = {
  token_prices: "request-driven (first /v1/quote writes the row) — not chain-derived",
};
// Columns excluded from the determinism diff, per HANDOFF §9.
//
// The bar for an entry is MEANING, not mechanism: the column must record a
// fact about THIS NODE ("when I first saw / stored this"), which two correct
// replicas legitimately disagree on. "It's a timestamp that differs between
// nodes" is not sufficient — differing between nodes is precisely the symptom
// the diff exists to catch, and excluding by mechanism is how the wall-clock
// archived_at bug stayed invisible until pair_stats.last_traded_at (absent
// from this list only by oversight) exposed the class.
//
// archived_at is deliberately NOT here anymore: it is chain-derived (the L2
// block timestamp of the archiving event) and MUST match across replicas.
export const DIFF_EXCLUDED_COLUMNS = new Set([
  "created_at",  // when this node's row was inserted — local observation
  "recorded_at", // when this node recorded the liveness-set entry — local observation
]);

// Re-running the full validator (proofs included) over every stored blob is
// the audit's strongest assertion and also its most expensive: wellFormed
// dominates the whole pipeline. Exhaustive by default at suite scale; set
// GRAND_DEEP_AUDIT=0 to sample instead when running with GRAND_OFFERS in the
// hundreds. The sample is deterministic (detVar), never random — a flaky audit
// surface would be worse than a cheaper one.
export const DEEP_AUDIT = process.env["GRAND_DEEP_AUDIT"] !== "0";
export const DEEP_AUDIT_SAMPLE = 25;

export const OUT_DIR = new URL("./out/", import.meta.url).pathname;
