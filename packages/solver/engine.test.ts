import { expect, test } from "bun:test";

import { Book, type BookOffer } from "./src/book.ts";
import {
  evaluatePathA,
  evaluateSet,
  findCandidates,
  findCycleCrossings,
  findExactCrossings,
  netOf,
  nullifiersDisjoint,
  payoutsFor,
  residualValue,
  type EngineConfig,
} from "./src/engine.ts";
import { LadderBook } from "./src/ladder.ts";
import { Stock, type Claim } from "./src/stock.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NOW = 1_000_000_000;
const USD = 10n ** 9n;

const LEVELS = [
  { input: "1000", output: "1000" },
  { input: "100000", output: "99000" },
];

const offer = (
  hash: string,
  give: [string, bigint],
  want: [string, bigint],
  extra: Partial<BookOffer> = {},
): BookOffer => ({
  offerHash: hash,
  gives: [{ token: give[0], amount: give[1], kind: "SHIELDED" }],
  wants: [{ token: want[0], amount: want[1], kind: "SHIELDED" }],
  expiresAt: null,
  firstSeenAt: null,
  inputNullifiers: [`n-${hash}`],
  ...extra,
});

function config(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const stock = new Stock();
  stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n, [C]: 1_000_000n });
  return {
    ladders: LadderBook.fromPairs([
      { tokenIn: A, tokenOut: B, levels: LEVELS },
      { tokenIn: B, tokenOut: A, levels: LEVELS },
    ]),
    refPricesUsd: new Map([[A, USD], [B, USD], [C, USD]]),
    stock,
    expiryMarginSeconds: 120,
    maxCycleLen: 3,
    enablePathB: true,
    enableCycles: true,
    enableResidualTopUps: true,
    ...overrides,
  };
}

const claim = (hashes: string[], nullifiers: string[]): Claim => ({
  offerHashes: hashes,
  nullifiers,
  payouts: new Map(),
});

// ── net / residual arithmetic ────────────────────────────────────────────────

test("netOf sums from the solver's side and drops exact cancellations", () => {
  const net = netOf([offer("h1", [A, 100n], [B, 90n]), offer("h2", [B, 90n], [A, 100n])]);
  expect(net.size).toBe(0);
});

test("netOf reports a surplus positive and a top-up negative", () => {
  const net = netOf([offer("h1", [A, 100n], [B, 90n])]);
  expect(net.get(A)).toBe(100n);
  expect(net.get(B)).toBe(-90n);
  expect(payoutsFor(net)).toEqual(new Map([[B, 90n]]));
});

test("an unpriced token makes the residual unjudgeable rather than zero", () => {
  const net = new Map([[C, 100n]]);
  expect(residualValue(net, new Map([[A, USD]]))).toBeNull();
  // Scaled by 10^9; only the sign is load-bearing.
  expect(residualValue(net, new Map([[C, 2n * USD]]))).toBe(200n * USD);
});

test("a loss stays a loss above 2^53, where Number arithmetic collapsed it", () => {
  const big = 9007199254740992n; // 2^53
  const prices = new Map([[A, USD], [B, USD]]);
  // Exactly one unit short: Number(big) === Number(big + 1n), so this used to
  // evaluate to 0 and pass a `< 0` rejection.
  const losing = new Map([[A, big], [B, -(big + 1n)]]);
  expect(residualValue(losing, prices)).toBe(-(10n ** 9n));
  const winning = new Map([[A, big + 1n], [B, -big]]);
  expect(residualValue(winning, prices)).toBe(10n ** 9n);
});

test("a set that loses one unit at huge amounts is now refused", () => {
  const big = 9007199254740992n;
  const cfg = config();
  cfg.stock.setBalances({ [A]: big * 4n, [B]: big * 4n });
  const verdict = evaluateSet(
    [offer("h1", [A, big], [B, big + 1n]), offer("h2", [B, big + 1n], [A, big])],
    cfg,
    NOW,
  );
  // Nets cancel exactly here, so it is an exact crossing and legitimately fine.
  expect(verdict.ok).toBe(true);

  const losing = evaluateSet(
    [offer("h3", [A, big], [B, 0n]), offer("h4", [B, 0n], [A, big + 1n])],
    cfg,
    NOW,
  );
  expect(losing.ok).toBe(false);
  expect((losing as { reason: string }).reason).toContain("negative");
});

test("a non-positive or type-confused scaled price makes the residual unjudgeable", () => {
  const net = new Map([[A, 1n]]);
  expect(residualValue(net, new Map([[A, 0n]]))).toBeNull();
  expect(residualValue(net, new Map([[A, -1n]]))).toBeNull();
  expect(residualValue(net, new Map([[A, Number.POSITIVE_INFINITY]]) as any)).toBeNull();
});

test("nullifiersDisjoint catches two offers spending the same coin", () => {
  const shared = { inputNullifiers: ["same"] };
  expect(nullifiersDisjoint([offer("h1", [A, 1n], [B, 1n], shared), offer("h2", [B, 1n], [A, 1n], shared)])).toBe(false);
  expect(nullifiersDisjoint([offer("h1", [A, 1n], [B, 1n]), offer("h2", [B, 1n], [A, 1n])])).toBe(true);
});

// ── Path A ───────────────────────────────────────────────────────────────────

test("Path A fills at exactly the posted price", () => {
  const verdict = evaluatePathA(offer("h1", [A, 1000n], [B, 1000n]), config(), NOW);
  expect(verdict.ok).toBe(true);
});

test("Path A refuses one unit worse than posted and accepts one unit better", () => {
  expect(evaluatePathA(offer("h1", [A, 1000n], [B, 1001n]), config(), NOW).ok).toBe(false);
  expect(evaluatePathA(offer("h2", [A, 1000n], [B, 999n]), config(), NOW).ok).toBe(true);
});

test("Path A refuses a pair it posts no ladder for", () => {
  const verdict = evaluatePathA(offer("h1", [A, 1000n], [C, 900n]), config(), NOW);
  expect(verdict.ok).toBe(false);
  expect((verdict as { reason: string }).reason).toContain("no ladder");
});

test("Path A refuses a size outside the published range", () => {
  // Below the first rung and above the last are both refusals, not
  // extrapolations.
  expect(evaluatePathA(offer("h1", [A, 999n], [B, 1n]), config(), NOW).ok).toBe(false);
  expect(evaluatePathA(offer("h2", [A, 100001n], [B, 1n]), config(), NOW).ok).toBe(false);
});

test("Path A refuses when stock cannot cover the payout", () => {
  const cfg = config();
  cfg.stock.setBalances({ [B]: 500n });
  const verdict = evaluatePathA(offer("h1", [A, 1000n], [B, 1000n]), cfg, NOW);
  expect(verdict.ok).toBe(false);
  expect((verdict as { reason: string }).reason).toContain("stock");
});

test("Path A counts an in-flight reservation against available stock", () => {
  const cfg = config();
  cfg.stock.setBalances({ [B]: 1000n });
  cfg.stock.reserve({ offerHashes: ["other"], nullifiers: ["n-other"], payouts: new Map([[B, 600n]]) });
  expect(evaluatePathA(offer("h1", [A, 1000n], [B, 1000n]), cfg, NOW).ok).toBe(false);
});

test("Path A skips multi-leg offers, which have no single posted price", () => {
  const multi = offer("h1", [A, 1000n], [B, 1000n], {
    gives: [
      { token: A, amount: 500n, kind: "SHIELDED" },
      { token: C, amount: 500n, kind: "SHIELDED" },
    ],
  });
  expect(evaluatePathA(multi, config(), NOW).ok).toBe(false);
});

test("Path A refuses an offer inside the expiry margin", () => {
  const expiring = offer("h1", [A, 1000n], [B, 1000n], { expiresAt: NOW + 60_000 });
  expect(evaluatePathA(expiring, config(), NOW).ok).toBe(false);
  const roomy = offer("h2", [A, 1000n], [B, 1000n], { expiresAt: NOW + 600_000 });
  expect(evaluatePathA(roomy, config(), NOW).ok).toBe(true);
});

// ── Path B ───────────────────────────────────────────────────────────────────

test("an exact crossing qualifies with no reference prices at all", () => {
  const cfg = config({ refPricesUsd: new Map() });
  const verdict = evaluateSet(
    [offer("h1", [A, 1000n], [B, 1000n]), offer("h2", [B, 1000n], [A, 1000n])],
    cfg,
    NOW,
  );
  expect(verdict.ok).toBe(true);
  // Self-funding: nothing to supply, so nothing to reserve.
  expect((verdict as { payouts: Map<string, bigint> }).payouts.size).toBe(0);
});

test("a set leaving the solver in surplus qualifies", () => {
  const verdict = evaluateSet(
    [offer("h1", [A, 1000n], [B, 900n]), offer("h2", [B, 900n], [A, 950n])],
    config(),
    NOW,
  );
  expect(verdict.ok).toBe(true);
  expect((verdict as { residual: bigint }).residual).toBeGreaterThan(0n);
});

test("a set that would cost the solver value is refused", () => {
  const verdict = evaluateSet(
    [offer("h1", [A, 900n], [B, 1000n]), offer("h2", [B, 1000n], [A, 1000n])],
    config(),
    NOW,
  );
  expect(verdict.ok).toBe(false);
  expect((verdict as { reason: string }).reason).toContain("negative");
});

test("a residual-positive set still needs stock for the top-up leg", () => {
  const cfg = config();
  cfg.stock.setBalances({ [A]: 0n, [B]: 0n });
  const verdict = evaluateSet(
    [offer("h1", [A, 1000n], [B, 900n]), offer("h2", [B, 900n], [A, 950n])],
    cfg,
    NOW,
  );
  // Nets: A +50, B 0 — no top-up needed, so this one is fine even at zero stock.
  expect(verdict.ok).toBe(true);

  const needsTopUp = evaluateSet(
    [offer("h3", [A, 1000n], [B, 900n]), offer("h4", [B, 800n], [A, 1000n])],
    cfg,
    NOW,
  );
  expect(needsTopUp.ok).toBe(false);
  expect((needsTopUp as { reason: string }).reason).toContain("stock");
});

test("a set with an unpriced residual is refused rather than assumed harmless", () => {
  const cfg = config({ refPricesUsd: new Map([[A, USD], [B, USD]]) });
  const verdict = evaluateSet(
    [offer("h1", [A, 1000n], [B, 900n]), offer("h2", [B, 900n], [C, 1n])],
    cfg,
    NOW,
  );
  expect(verdict.ok).toBe(false);
  expect((verdict as { reason: string }).reason).toContain("unpriced");
});

test("a set sharing an input coin is never merged", () => {
  const verdict = evaluateSet(
    [
      offer("h1", [A, 1000n], [B, 1000n], { inputNullifiers: ["shared"] }),
      offer("h2", [B, 1000n], [A, 1000n], { inputNullifiers: ["shared"] }),
    ],
    config(),
    NOW,
  );
  expect(verdict.ok).toBe(false);
  expect((verdict as { reason: string }).reason).toContain("share an input coin");
});

test("a set containing a claimed offer is refused whole", () => {
  const cfg = config();
  cfg.stock.reserve(claim(["h1"], ["n-h1"]));
  const verdict = evaluateSet(
    [offer("h1", [A, 1000n], [B, 1000n]), offer("h2", [B, 1000n], [A, 1000n])],
    cfg,
    NOW,
  );
  expect(verdict.ok).toBe(false);
});

test("the same offer twice is not a crossing", () => {
  const o = offer("h1", [A, 1000n], [B, 1000n]);
  expect(evaluateSet([o, o], config(), NOW).ok).toBe(false);
});

// ── enumeration ──────────────────────────────────────────────────────────────

const bookOf = (...offers: BookOffer[]): Book => {
  const book = new Book();
  for (const o of offers) book.upsert(o);
  return book;
};

test("findExactCrossings pairs a mirrored offer once", () => {
  const book = bookOf(offer("h1", [A, 1000n], [B, 1000n]), offer("h2", [B, 1000n], [A, 1000n]));
  const found = findExactCrossings(book, config(), NOW);
  expect(found.length).toBe(1);
  expect(found[0].offers.map((o) => o.offerHash).sort()).toEqual(["h1", "h2"]);
});

test("findExactCrossings ignores a near miss", () => {
  // Mirrors on one token but not the other — merging would leave an imbalance.
  const book = bookOf(offer("h1", [A, 1000n], [B, 1000n]), offer("h2", [B, 1000n], [A, 999n]));
  expect(findExactCrossings(book, config(), NOW)).toEqual([]);
});

test("findExactCrossings never puts one offer in two pairs", () => {
  const book = bookOf(
    offer("h1", [A, 1000n], [B, 1000n]),
    offer("h2", [B, 1000n], [A, 1000n]),
    offer("h3", [B, 1000n], [A, 1000n]),
  );
  const found = findExactCrossings(book, config(), NOW);
  expect(found.length).toBe(1);
  const used = found.flatMap((c) => c.offers.map((o) => o.offerHash));
  expect(new Set(used).size).toBe(used.length);
});

test("crossings are preferred over filling the same offers from inventory", () => {
  // Both offers are individually fillable at the posted price, but matching
  // them costs no inventory, so Path A must not claim either.
  const book = bookOf(offer("h1", [A, 1000n], [B, 1000n]), offer("h2", [B, 1000n], [A, 1000n]));
  const candidates = findCandidates(book, config(), NOW);
  expect(candidates.length).toBe(1);
  expect(candidates[0].kind).toBe("pathB");
});

test("an unmatched offer still falls through to Path A", () => {
  const book = bookOf(offer("h1", [A, 1000n], [B, 1000n]));
  const candidates = findCandidates(book, config(), NOW);
  expect(candidates.length).toBe(1);
  expect(candidates[0].kind).toBe("pathA");
});

test("findCandidates returns nothing on an empty book", () => {
  expect(findCandidates(new Book(), config(), NOW)).toEqual([]);
});

test("safe defaults keep Path A while all Path B execution is disabled", () => {
  const exact = bookOf(
    offer("h1", [A, 1000n], [B, 1000n]),
    offer("h2", [B, 1000n], [A, 1000n]),
  );
  const disabled = config({ enablePathB: false, enableCycles: false, enableResidualTopUps: false });
  const candidates = findCandidates(exact, disabled, NOW);
  expect(candidates.every((candidate) => candidate.kind === "pathA")).toBe(true);
  expect(candidates.length).toBe(2);

  const enabled = config({ enablePathB: true, enableCycles: false, enableResidualTopUps: false });
  expect(findCandidates(exact, enabled, NOW).map((candidate) => candidate.kind)).toEqual(["pathB"]);
});

test("cycles and residual top-ups remain independently disabled", () => {
  const ring = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n]),
  );
  expect(findCycleCrossings(ring, config({ enableCycles: false }), NOW)).toEqual([]);

  const residual = evaluateSet(
    [offer("x1", [A, 1000n], [B, 900n]), offer("x2", [B, 800n], [A, 900n])],
    config({ enableResidualTopUps: false }),
    NOW,
  );
  expect(residual).toEqual({ ok: false, reason: "residual top-ups are disabled" });
});

test("engine rejects unshielded legs even when their amounts mirror exactly", () => {
  const left = offer("h1", [A, 1000n], [B, 1000n]);
  left.gives[0].kind = "UNSHIELDED";
  const right = offer("h2", [B, 1000n], [A, 1000n]);
  expect(evaluatePathA(left, config(), NOW)).toEqual({ ok: false, reason: "unsupported non-shielded leg" });
  expect(evaluateSet([left, right], config(), NOW)).toEqual({
    ok: false,
    reason: "unsupported non-shielded leg",
  });
});

// ── N-cycles ─────────────────────────────────────────────────────────────────

const RING_CFG = () => {
  const cfg = config();
  cfg.stock.setBalances({ [A]: 1_000_000n, [B]: 1_000_000n, [C]: 1_000_000n });
  return cfg;
};

test("a three-leg ring that cancels exactly is found", () => {
  // a→b→c→a, every leg 1000 for 1000: nets to nothing on all three tokens.
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n]),
  );
  const found = findCycleCrossings(book, RING_CFG(), NOW);
  expect(found.length).toBe(1);
  expect(found[0].offers.map((o) => o.offerHash).sort()).toEqual(["r1", "r2", "r3"]);
  expect(found[0].payouts.size).toBe(0);
});

test("a ring leaving the solver short is taken when stock covers the top-up", () => {
  // r3 gives less C than r2 wants, so the solver funds 100 C.
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 900n], [A, 800n]),
  );
  const found = findCycleCrossings(book, RING_CFG(), NOW);
  expect(found.length).toBe(1);
  expect(found[0].payouts.get(C)).toBe(100n);
  // A surplus of 200 A against a 100 C shortfall, both priced at 1.
  expect(found[0].net.get(A)).toBe(200n);
});

test("a ring the solver cannot fund is left alone", () => {
  const cfg = RING_CFG();
  cfg.stock.setBalances({ [A]: 0n, [B]: 0n, [C]: 0n });
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 900n], [A, 800n]),
  );
  expect(findCycleCrossings(book, cfg, NOW)).toEqual([]);
});

test("a ring that would cost the solver value is refused", () => {
  // r3 returns far less A than r1 gave up.
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 500n], [A, 1000n]),
  );
  expect(findCycleCrossings(book, RING_CFG(), NOW)).toEqual([]);
});

test("maxCycleLen bounds the search", () => {
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n]),
  );
  const cfg = RING_CFG();
  cfg.maxCycleLen = 2;
  expect(findCycleCrossings(book, cfg, NOW)).toEqual([]);
  cfg.maxCycleLen = 3;
  expect(findCycleCrossings(book, cfg, NOW).length).toBe(1);
});

test("the most generous offer on an edge is the one used", () => {
  const book = bookOf(
    offer("stingy", [A, 1000n], [B, 1000n]),
    offer("generous", [A, 1200n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1200n]),
  );
  const found = findCycleCrossings(book, RING_CFG(), NOW);
  expect(found.length).toBe(1);
  expect(found[0].offers.map((o) => o.offerHash)).toContain("generous");
  expect(found[0].offers.map((o) => o.offerHash)).not.toContain("stingy");
});

test("a ring sharing an input coin is never merged", () => {
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n], { inputNullifiers: ["shared"] }),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n], { inputNullifiers: ["shared"] }),
  );
  expect(findCycleCrossings(book, RING_CFG(), NOW)).toEqual([]);
});

test("one offer is never placed in two cycles", () => {
  const book = bookOf(
    offer("r1", [A, 1000n], [B, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n]),
    offer("r4", [B, 1000n], [C, 1000n]),
  );
  const found = findCycleCrossings(book, RING_CFG(), NOW);
  const used = found.flatMap((c) => c.offers.map((o) => o.offerHash));
  expect(new Set(used).size).toBe(used.length);
});

test("exact 2-cycles are preferred over the ring that could absorb them", () => {
  // h1/h2 mirror exactly and cost nothing; the ring would need a top-up.
  const book = bookOf(
    offer("h1", [A, 1000n], [B, 1000n]),
    offer("h2", [B, 1000n], [A, 1000n]),
    offer("r2", [B, 900n], [C, 900n]),
    offer("r3", [C, 900n], [A, 800n]),
  );
  const candidates = findCandidates(book, RING_CFG(), NOW);
  expect(candidates[0].kind).toBe("pathB");
  expect(candidates[0].offers.map((o) => o.offerHash).sort()).toEqual(["h1", "h2"]);
  expect(candidates[0].payouts.size).toBe(0);
});

test("a cycle candidate excludes offers an exact crossing already claimed", () => {
  const book = bookOf(
    offer("h1", [A, 1000n], [B, 1000n]),
    offer("h2", [B, 1000n], [A, 1000n]),
    offer("r2", [B, 1000n], [C, 1000n]),
    offer("r3", [C, 1000n], [A, 1000n]),
  );
  const candidates = findCandidates(book, RING_CFG(), NOW);
  const all = candidates.flatMap((c) => c.offers.map((o) => o.offerHash));
  expect(new Set(all).size).toBe(all.length);
});
