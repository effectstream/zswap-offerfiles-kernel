// Tick and reconciliation unit tests.
//
// The wallet, the minter, the offer builder, the kernel and the clock are all
// fakes; the JOURNAL is real, on a temp directory, because the interesting
// assertions are about what the journal ends up holding — "the coin is still a
// re-offer candidate afterwards" is only meaningful against the real
// `candidates()` implementation.
//
// Nothing here touches the network, the SDK or the ledger, and no real time
// passes: `clock.sleep` advances a counter.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Journal, openJournal } from "./poster-journal.ts";
import { NotSponsoredError, type QuoteResponse, type SizedWant } from "./poster-quote.ts";
import type { TickOutcome } from "./poster-scheduler.ts";
import {
  FAILURES,
  formatLogFields,
  isRetryablePostError,
  mintCoin,
  offerCoin,
  reconcile,
  refusalCode,
  runTick,
  type BuildOfferArgs,
  type BuiltOffer,
  type LogFields,
  type MintedCoinRef,
  type PostResult,
  type SpendableCoin,
  type TickApi,
  type TickBuilder,
  type TickClock,
  type TickConfig,
  type TickDeps,
  type TickMinter,
  type TickWallet,
} from "./poster-tick.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT = "6fc44c272d866574cefc14e25474fdfa144e6427f299a8222a8ad8a7b374bb7c";
const GIVE = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const WANT = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";

const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const NONCE_A = hex("a1");
const NONCE_B = hex("b2");
const NULL_A = hex("c3");
const NULL_B = hex("d4");
const OFFER_1 = hex("e5");
const OFFER_2 = hex("f6");

const coinA: SpendableCoin = { nonce: NONCE_A, type: GIVE, value: 1000n, nullifier: NULL_A };
const coinB: SpendableCoin = { nonce: NONCE_B, type: GIVE, value: 1000n, nullifier: NULL_B };

const quoteBody = (over: Partial<QuoteResponse> = {}): QuoteResponse => ({
  from_token: GIVE,
  to_token: WANT,
  from_amount: "1000",
  market_rate: 32.3,
  suggested_to_amount: "31500",
  to_amount: "31500",
  implied_rate: 31.5,
  discount: 0.025,
  sponsored: true,
  from_usd: 0.077,
  to_usd: 0.075,
  source: "token-prices",
  sponsor_discount: 0.025,
  from_source: "seed",
  to_source: "seed",
  prices_updated_at: "2026-09-03T00:00:00.000Z",
  ...over,
});

const sized = (over: Partial<SizedWant> = {}): SizedWant => ({
  wantAmount: 31_500n,
  sponsored: true,
  forced: false,
  suggestedWantAmount: 31_500n,
  marketRate: 32.3,
  sponsorDiscount: 0.025,
  fromSource: "seed",
  toSource: "seed",
  pricesUpdatedAt: "2026-09-03T00:00:00.000Z",
  warnings: [],
  raw: quoteBody(),
  ...over,
});

const baseConfig: TickConfig = {
  giveColour: GIVE,
  giveTokenName: "WBTC",
  giveAmount: 1000n,
  wantColour: WANT,
  offerTtlMinutes: 60,
  coinVisibleTimeoutMs: 10_000,
  coinVisiblePollMs: 1_000,
  minDust: 1n,
  maxReoffersPerTick: 1,
  postRetries: 3,
  postRetryMs: 100,
  liveTries: 3,
  liveIntervalMs: 100,
};

// ── recording fakes ────────────────────────────────────────────────────────

interface Harness {
  deps: TickDeps;
  journal: Journal;
  calls: {
    mint: { name: string; amount: bigint; nonce: bigint }[];
    build: BuildOfferArgs[];
    revert: unknown[];
    post: string[];
    quote: number;
  };
  logs: LogFields[];
  /** Coins the fake wallet reports as spendable. */
  free: Map<string, SpendableCoin>;
  dust: bigint;
  /** Statuses `GET /v1/offers/:hash/status` answers, by offer id. */
  statuses: Map<string, string>;
  /** Queued `POST /v1/offers` answers; the last one repeats. */
  postAnswers: PostResult[];
  /** Queued `offerStatusByBlob` answers; the last one repeats. `null` means
   *  "echo the offer id the builder just produced, status live" — the normal
   *  case, and the one that keeps offer ids unique across re-offers the way a
   *  fresh TTL and a fresh quote make them unique in reality. */
  liveAnswers: { offerId?: string; status: string }[] | null;
  /** The offer id the last `build()` produced. */
  lastOfferId: string;
  kernelNullifiers: string[] | null;
  buildNullifiers: string[] | null;
  buildFallibleInputs: number;
  quoteError: unknown | null;
  quoteResult: SizedWant;
  mintResult: MintedCoinRef | null;
  mintError: unknown | null;
  /** When true, a mint does NOT make the coin visible. */
  mintInvisible: boolean;
}

/** Temp directories to remove after each test. */
const tmpDirs: string[] = [];

function harness(cfg: Partial<TickConfig> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "poster-tick-"));
  tmpDirs.push(dir);
  const journal = openJournal({
    file: join(dir, "journal.json"),
    contractAddress: CONTRACT,
    giveColour: GIVE,
  });

  const h: Harness = {
    deps: null as unknown as TickDeps,
    journal,
    calls: { mint: [], build: [], revert: [], post: [], quote: 0 },
    logs: [],
    free: new Map(),
    dust: 1_000_000n,
    statuses: new Map(),
    postAnswers: [{ status: 200, body: { ok: true } }],
    liveAnswers: null,
    lastOfferId: "",
    kernelNullifiers: null,
    buildNullifiers: null,
    buildFallibleInputs: 0,
    quoteError: null,
    quoteResult: sized(),
    mintResult: null,
    mintError: null,
    mintInvisible: false,
  };

  const take = <T,>(queue: T[]): T => (queue.length > 1 ? queue.shift()! : queue[0]!);

  const wallet: TickWallet = {
    availableNonces: async () => [...h.free.keys()],
    findCoin: async (nonce) => h.free.get(nonce.toLowerCase()),
    dustBalance: async () => h.dust,
  };

  const minter: TickMinter = {
    freshNonce: () => 123n,
    mint: async (name, amount, nonce) => {
      h.calls.mint.push({ name, amount, nonce });
      if (h.mintError !== null) throw h.mintError;
      const minted: MintedCoinRef = h.mintResult ?? {
        coin: { nonce: NONCE_B, type: GIVE, value: amount },
        nullifier: NULL_B,
        txHash: hex("11"),
        mintNonce: nonce,
      };
      if (!h.mintInvisible) {
        h.free.set(minted.coin.nonce, {
          nonce: minted.coin.nonce,
          type: minted.coin.type,
          value: minted.coin.value,
          nullifier: minted.nullifier,
        });
      }
      return minted;
    },
  };

  let builds = 0;
  const builder: TickBuilder = {
    build: async (args) => {
      h.calls.build.push(args);
      const coin = h.free.get(args.nonce.toLowerCase());
      // A real re-offer is a FRESH build (fresh TTL, fresh quote), so its
      // content address differs from the previous offer on the same coin.
      h.lastOfferId = hex(`${builds++ % 10}a`);
      const built: BuiltOffer = {
        recipe: { recipeFor: args.nonce },
        nullifiers: h.buildNullifiers ?? [coin?.nullifier ?? "??"],
        fallibleInputCount: h.buildFallibleInputs,
        blob: `swapoffer1${args.nonce.slice(0, 8)}${h.lastOfferId.slice(0, 4)}`,
        offerId: h.lastOfferId,
        blobSha256: hex("99"),
      };
      return built;
    },
    revert: async (recipe) => {
      h.calls.revert.push(recipe);
    },
  };

  const api: TickApi = {
    sizeWant: async () => {
      h.calls.quote += 1;
      if (h.quoteError !== null) throw h.quoteError;
      return h.quoteResult;
    },
    postOffer: async (blob) => {
      h.calls.post.push(blob);
      return take(h.postAnswers);
    },
    offerStatusByBlob: async () =>
      h.liveAnswers === null ? { offerId: h.lastOfferId, status: "live" } : take(h.liveAnswers),
    offerStatusByHash: async (hash) => ({
      offerId: hash,
      status: h.statuses.get(hash) ?? "not_found",
    }),
    getOffer: async (hash) => ({
      offerId: hash,
      computed: {
        inputNullifiers:
          h.kernelNullifiers ?? [h.free.get(h.calls.build.at(-1)?.nonce ?? "")?.nullifier ?? NULL_A],
        status: "live",
      },
    }),
  };

  let time = 0;
  const clock: TickClock = {
    now: () => (time += 1),
    sleep: async (ms) => {
      time += ms;
    },
  };

  h.deps = {
    cfg: { ...baseConfig, ...cfg },
    journal,
    wallet,
    minter,
    builder,
    api,
    clock,
    log: (fields) => h.logs.push(fields),
  };
  return h;
}

/** Put a journaled coin whose last offer is terminal-but-unspent into the
 *  journal AND into the wallet's free set — i.e. a genuine re-offer candidate. */
function seedReleasedCoin(h: Harness, coin: SpendableCoin, offerId = OFFER_1): void {
  h.journal.recordMintIntent(coin.nonce, coin.type, coin.value);
  h.journal.recordMinted(coin.nonce, { txHash: hex("11"), nullifier: coin.nullifier });
  h.journal.recordOffer(coin.nonce, {
    offerId,
    blobSha256: hex("98"),
    ttlSec: 120,
    wantColour: WANT,
    wantAmount: 31_500n,
    status: "expired",
  });
  h.free.set(coin.nonce, coin);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

describe("formatLogFields (FR-015)", () => {
  test("fixed field order, extras appended, nothing undefined printed", () => {
    expect(
      formatLogFields({
        phase: "post",
        tick: 3,
        mode: "mint",
        ms: 812,
        nonce: "ab…",
        offerId: "cd…",
        result: "accepted",
      }),
    ).toBe("tick=3 mode=mint phase=post ms=812 nonce=ab… offerId=cd… result=accepted");
    expect(formatLogFields({ phase: "start", tick: 1 })).toBe("tick=1 phase=start");
    expect(formatLogFields({ phase: "x", nonce: undefined, extra: null })).toBe("phase=x");
  });

  test("bigints render as decimals and spaces are quoted", () => {
    expect(formatLogFields({ phase: "quote", give: 1000n })).toBe("phase=quote give=1000");
    expect(formatLogFields({ phase: "post", detail: "two words" })).toBe(
      'phase=post detail="two words"',
    );
  });
});

describe("refusalCode / isRetryablePostError", () => {
  test("the kernel's SCREAMING_CASE code is extracted from either body shape", () => {
    expect(refusalCode(422, { error: "NOT_SPONSORED", give_usd: 1 })).toBe("NOT_SPONSORED");
    expect(refusalCode(409, "DUPLICATE_OFFER")).toBe("DUPLICATE_OFFER");
    expect(refusalCode(500, { error: "boom" })).toBe("500");
    expect(refusalCode(503, null)).toBe("503");
  });

  test("only ROOT_UNKNOWN and UTXO_NOT_LIVE are retryable", () => {
    expect(isRetryablePostError({ error: "ROOT_UNKNOWN" })).toBe(true);
    expect(isRetryablePostError("UTXO_NOT_LIVE: not yet")).toBe(true);
    expect(isRetryablePostError({ error: "NOT_SPONSORED" })).toBe(false);
    expect(isRetryablePostError({ error: "DUPLICATE_OFFER" })).toBe(false);
  });
});

describe("reconcile (FR-009)", () => {
  test("consumed closes the COIN, not just the offer", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.journal.setOfferStatus(coinA.nonce, OFFER_1, "live");
    h.statuses.set(OFFER_1, "consumed");

    const result = await reconcile(h.deps);
    expect(result.spent).toEqual([coinA.nonce]);
    expect(h.journal.getCoin(coinA.nonce)?.state).toBe("spent");
    expect(result.candidates).toHaveLength(0);
  });

  test("cancelled does NOT close the coin, and candidacy still needs availableCoins", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.journal.setOfferStatus(coinA.nonce, OFFER_1, "live");
    h.statuses.set(OFFER_1, "cancelled");

    const withCoin = await reconcile(h.deps);
    expect(h.journal.getCoin(coinA.nonce)?.state).not.toBe("spent");
    expect(withCoin.candidates.map((c) => c.nonce)).toEqual([coinA.nonce]);

    // The very same journal state, but the coin is NOT free: no candidate.
    h.free.delete(coinA.nonce);
    const withoutCoin = await reconcile(h.deps);
    expect(withoutCoin.candidates).toHaveLength(0);
  });

  test("an unreachable kernel leaves everything as it is and records the reason", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.journal.setOfferStatus(coinA.nonce, OFFER_1, "live");
    h.deps.api.offerStatusByHash = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await reconcile(h.deps);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("ECONNREFUSED");
    expect(h.journal.getCoin(coinA.nonce)?.offers.at(-1)?.status).toBe("live");
    expect(result.candidates).toHaveLength(0); // a live offer still claims it
  });

  test("not_found maps to unknown and does not by itself create a candidate", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.journal.setOfferStatus(coinA.nonce, OFFER_1, "live");
    h.statuses.set(OFFER_1, "not_found");

    const result = await reconcile(h.deps);
    expect(h.journal.getCoin(coinA.nonce)?.offers.at(-1)?.status).toBe("unknown");
    expect(result.candidates).toHaveLength(0);
  });
});

describe("tick mode selection (FR-010)", () => {
  test("a candidate WINS over a mint, even with plenty of DUST", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.dust = 10n ** 20n;

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(true);
    expect(outcome.mode).toBe("reoffer");
    expect(outcome.nonce).toBe(coinA.nonce);
    expect(h.calls.mint).toHaveLength(0);
    expect(h.calls.build[0]?.nonce).toBe(coinA.nonce);
    expect(h.calls.post).toHaveLength(1);
    // A second offer now hangs off the SAME coin (US2 independent test).
    expect(h.journal.getCoin(coinA.nonce)?.offers).toHaveLength(2);
  });

  test("insufficient DUST still services a re-offer (US1 scenario 6)", async () => {
    const h = harness({ minDust: 10n ** 18n });
    seedReleasedCoin(h, coinA);
    h.dust = 0n;

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(true);
    expect(outcome.mode).toBe("reoffer");
    expect(h.calls.mint).toHaveLength(0);
    expect(h.calls.post).toHaveLength(1);
  });

  test("no candidate and insufficient DUST degrades with insufficient_dust", async () => {
    const h = harness({ minDust: 10n ** 18n });
    h.dust = 5n;

    const outcome = await runTick(h.deps, 1);
    expect(outcome.mode).toBe("degraded");
    expect(outcome.failure).toBe(FAILURES.insufficientDust);
    // Degraded is not a FAILURE — a poster waiting for NIGHT is working.
    expect(outcome.ok).toBe(true);
    expect(h.calls.mint).toHaveLength(0);
    expect(h.calls.post).toHaveLength(0);
    expect(outcome.error).toContain("5");
  });

  test("no candidate and enough DUST mints, journals, and offers the minted coin", async () => {
    const h = harness();
    h.kernelNullifiers = [NULL_B];
    h.dust = 10n ** 20n;

    const outcome = await runTick(h.deps, 1);
    expect(outcome.mode).toBe("mint");
    expect(outcome.ok).toBe(true);
    expect(outcome.minted).toBe(true);
    expect(h.calls.mint).toEqual([{ name: "WBTC", amount: 1000n, nonce: 123n }]);
    // The journal knows the coin BEFORE the offer is built.
    const coin = h.journal.getCoin(NONCE_B);
    expect(coin?.state).toBe("offered");
    expect(coin?.nullifier).toBe(NULL_B);
    expect(coin?.value).toBe("1000");
    expect(coin?.offers).toHaveLength(1);
    expect(coin?.offers[0]?.status).toBe("live");
    expect(coin?.offers[0]?.quote.sponsored).toBe(true);
    // The offer was built with the coin just minted, not with any other.
    expect(h.calls.build[0]?.nonce).toBe(NONCE_B);
    expect(h.calls.build[0]?.giveValue).toBe(1000n);
    expect(h.calls.build[0]?.wantAmount).toBe(31_500n);
  });

  test("a coin the poster did NOT mint is never offered (SC-001 control coins)", async () => {
    const h = harness();
    // Three free WBTC coins that the journal has never heard of.
    for (const n of ["01", "02", "03"]) {
      const nonce = hex(n);
      h.free.set(nonce, { nonce, type: GIVE, value: 400n, nullifier: hex(`f${n}`) });
    }
    h.dust = 10n ** 20n;
    h.kernelNullifiers = [NULL_B];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.mode).toBe("mint"); // it minted rather than adopting one
    expect(h.calls.build.map((b) => b.nonce)).toEqual([NONCE_B]);
  });

  test("a candidate that is no longer free is skipped, not offered", async () => {
    const h = harness({ minDust: 10n ** 18n });
    seedReleasedCoin(h, coinA);
    h.dust = 0n;
    // `reconcile` sees it, then it gets reserved before the tick can use it.
    const realFind = h.deps.wallet.findCoin.bind(h.deps.wallet);
    let calls = 0;
    h.deps.wallet.findCoin = async (nonce) => (++calls === 1 ? undefined : realFind(nonce));

    const outcome = await runTick(h.deps, 1);
    expect(h.calls.build).toHaveLength(0);
    expect(outcome.mode).toBe("degraded"); // no DUST to mint with either
  });

  test("POSTER_MAX_REOFFERS_PER_TICK bounds how many offers one tick posts", async () => {
    const h = harness({ maxReoffersPerTick: 2 });
    seedReleasedCoin(h, coinA, OFFER_1);
    seedReleasedCoin(h, coinB, OFFER_2);
    h.kernelNullifiers = null; // getOffer echoes NULL_A; override per build below
    h.deps.api.getOffer = async (hash) => ({
      offerId: hash,
      computed: { inputNullifiers: [h.calls.build.at(-1)?.nonce === NONCE_A ? NULL_A : NULL_B] },
    });

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(true);
    expect(h.calls.build).toHaveLength(2);
    expect(h.calls.post).toHaveLength(2);
  });
});

describe("the exact-coin assertion (FR-006 / US1 scenario 4)", () => {
  test("wrong input nullifier: revert is called and NOTHING is posted", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.buildNullifiers = [hex("de")]; // some other coin's nullifier

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe(FAILURES.wrongInputNullifier);
    expect(h.calls.post).toHaveLength(0);
    expect(h.calls.revert).toEqual([{ recipeFor: coinA.nonce }]);
    // The coin never got a second offer, so it is still a candidate.
    expect(h.journal.getCoin(coinA.nonce)?.offers).toHaveLength(1);
    expect(h.journal.candidates([coinA.nonce]).map((c) => c.nonce)).toEqual([coinA.nonce]);
  });

  test("TWO inputs is refused just as loudly as the wrong one", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.buildNullifiers = [NULL_A, hex("de")];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe(FAILURES.wrongInputNullifier);
    expect(h.calls.post).toHaveLength(0);
    expect(h.calls.revert).toHaveLength(1);
  });

  test("a FALLIBLE input is refused even when the nullifier is right", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.buildFallibleInputs = 1;

    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe(FAILURES.wrongInputNullifier);
    expect(outcome.error).toContain("fallible");
    expect(h.calls.post).toHaveLength(0);
  });

  test("case differences between the wallet and the builder are not a mismatch", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.buildNullifiers = [NULL_A.toUpperCase()];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(true);
    expect(h.calls.revert).toHaveLength(0);
  });

  test("the kernel's own inputNullifiers are cross-checked after the offer is live", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.kernelNullifiers = [hex("de")];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe(FAILURES.wrongInputNullifier);
    // The offer IS live and IS recorded — the failure is a loud disagreement,
    // not a reason to rewrite history.
    expect(h.journal.getCoin(coinA.nonce)?.offers.at(-1)?.status).toBe("live");
  });
});

describe("quote refusals (US1 scenario 7)", () => {
  test("not sponsored: the tick fails, nothing is built or posted, the coin stays a candidate", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.quoteError = new NotSponsoredError({
      giveColour: GIVE,
      wantColour: WANT,
      giveValue: 1000n,
      wantAmount: 40_000n,
      raw: quoteBody({ sponsored: false, discount: 0.5 }),
    });

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe(FAILURES.notSponsored);
    expect(h.calls.build).toHaveLength(0);
    expect(h.calls.post).toHaveLength(0);
    // The whole point: the coin is untouched (still one offer, still the
    // expired one) and will be tried again on the next tick.
    expect(h.journal.getCoin(coinA.nonce)?.offers).toHaveLength(1);
    expect(h.journal.getCoin(coinA.nonce)?.offers[0]?.status).toBe("expired");
    expect(h.journal.getCoin(coinA.nonce)?.state).not.toBe("spent");
    expect(h.journal.candidates([coinA.nonce]).map((c) => c.nonce)).toEqual([coinA.nonce]);
    // …and the numbers an operator needs are in the log.
    const line = h.logs.find((l) => l.phase === "quote" && l["result"] === "not_sponsored");
    expect(line).toBeDefined();
    expect(line?.["give_usd"]).toBe(0.077);
    expect(line?.["sponsor_discount"]).toBe(0.025);
  });

  test("quote warnings are logged, one line each", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.quoteResult = sized({ warnings: ["give leg priced from demo-fallback", "prices_updated_at is null"] });

    await runTick(h.deps, 1);
    const warnings = h.logs.filter((l) => l["warning"] !== undefined).map((l) => l["warning"]);
    expect(warnings).toEqual([
      "give leg priced from demo-fallback",
      "prices_updated_at is null",
    ]);
  });
});

describe("posting (FR-007)", () => {
  test("ROOT_UNKNOWN is retried with the SAME blob and never re-mints", async () => {
    const h = harness();
    h.dust = 10n ** 20n;
    h.kernelNullifiers = [NULL_B];
    h.postAnswers = [
      { status: 400, body: { error: "ROOT_UNKNOWN" } },
      { status: 400, body: { error: "ROOT_UNKNOWN" } },
      { status: 200, body: { ok: true } },
    ];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(true);
    expect(h.calls.mint).toHaveLength(1);
    expect(h.calls.build).toHaveLength(1);
    expect(h.calls.post).toHaveLength(3);
    expect(new Set(h.calls.post).size).toBe(1); // identical blob every time
  });

  test("a 422 is a tick failure, recorded as a rejected offer, and the coin stays a candidate", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.postAnswers = [
      { status: 422, body: { error: "NOT_SPONSORED", give_usd: 1, want_usd: 2 } },
    ];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe("post_rejected:NOT_SPONSORED");
    expect(h.calls.post).toHaveLength(1); // not retried
    expect(h.calls.revert).toHaveLength(1);
    const coin = h.journal.getCoin(coinA.nonce);
    expect(coin?.offers.at(-1)?.status).toBe("rejected");
    // `rejected` is a releasable status, so the coin can be tried again.
    expect(h.journal.candidates([coinA.nonce]).map((c) => c.nonce)).toEqual([coinA.nonce]);
  });

  test("422 UNPRICED_TOKEN gets its own taxonomy label", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.postAnswers = [{ status: 422, body: { error: "UNPRICED_TOKEN" } }];
    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe(FAILURES.unpriced);
  });

  test("409 DUPLICATE_OFFER is a failure with the server's code", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.postAnswers = [{ status: 409, body: { error: "DUPLICATE_OFFER" } }];
    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe("post_rejected:DUPLICATE_OFFER");
    expect(h.calls.post).toHaveLength(1);
  });

  test("exhausted retries report post_timeout and revert the recipe", async () => {
    const h = harness({ postRetries: 2 });
    seedReleasedCoin(h, coinA);
    h.postAnswers = [{ status: 400, body: { error: "ROOT_UNKNOWN" } }];
    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe(FAILURES.postTimeout);
    expect(h.calls.post).toHaveLength(2);
    expect(h.calls.revert).toHaveLength(1);
  });

  test("an offer that never goes live is marked unknown so reconcile revisits it", async () => {
    const h = harness({ liveTries: 2 });
    seedReleasedCoin(h, coinA);
    h.liveAnswers = [{ offerId: OFFER_1, status: "pending" }];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.failure).toBe(FAILURES.postTimeout);
    expect(h.journal.getCoin(coinA.nonce)?.offers.at(-1)?.status).toBe("unknown");
  });

  test("a kernel offerId that disagrees with the locally computed one fails loudly", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    h.liveAnswers = [{ offerId: hex("ab"), status: "live" }];

    const outcome = await runTick(h.deps, 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("locally computed");
  });
});

describe("minting (FR-003 / FR-004)", () => {
  test("a coin that never becomes visible is journaled as minted, not lost", async () => {
    const h = harness({ coinVisibleTimeoutMs: 3_000, coinVisiblePollMs: 1_000 });
    h.mintInvisible = true;

    const result = await mintCoin(h.deps, { tick: 1 });
    expect(result.ok).toBe(false);
    expect(result.minted).toBe(true);
    expect(result.failure).toBe(FAILURES.coinNotVisible);
    const coin = h.journal.getCoin(NONCE_B);
    expect(coin?.state).toBe("minted");
    expect(coin?.nullifier).toBe(NULL_B);
    // …so the next tick, once the wallet catches up, re-offers it.
    expect(h.journal.candidates([NONCE_B]).map((c) => c.nonce)).toEqual([NONCE_B]);
  });

  test("a mint that fails on dust is classified insufficient_dust, and nothing is journaled", async () => {
    const h = harness();
    h.mintError = new Error("balancing failed: insufficient dust to pay the fee");

    const result = await mintCoin(h.deps, { tick: 1 });
    expect(result.ok).toBe(false);
    expect(result.minted).toBe(false);
    expect(result.failure).toBe(FAILURES.insufficientDust);
    expect(h.journal.coins()).toHaveLength(0);
  });

  test("any other mint failure is mint_failed", async () => {
    const h = harness();
    h.mintError = new Error("proof server unreachable");
    const result = await mintCoin(h.deps, { tick: 1 });
    expect(result.failure).toBe(FAILURES.mintFailed);
  });

  test("the journal write happens BEFORE the quote, the build or the post", async () => {
    const h = harness();
    h.dust = 10n ** 20n;
    h.kernelNullifiers = [NULL_B];
    // Fail at the very first step after the mint; the coin must still be there.
    h.quoteError = new Error("kernel down");

    const outcome = await runTick(h.deps, 1);
    expect(outcome.mode).toBe("mint");
    expect(outcome.minted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(h.journal.getCoin(NONCE_B)?.state).toBe("minted");
    expect(h.journal.getCoin(NONCE_B)?.mintTx).toBe(hex("11"));
  });
});

describe("offerCoin in isolation", () => {
  test("returns the offer id and the want amount it used", async () => {
    const h = harness();
    h.free.set(coinA.nonce, coinA);
    h.journal.recordMintIntent(coinA.nonce, coinA.type, coinA.value);
    h.journal.recordMinted(coinA.nonce, { nullifier: coinA.nullifier });

    const result = await offerCoin(h.deps, coinA, { tick: 7, mode: "reoffer" });
    expect(result.ok).toBe(true);
    expect(result.offerId).toBe(h.lastOfferId);
    expect(result.wantAmount).toBe(31_500n);
    expect(h.logs.some((l) => l.tick === 7 && l.phase === "verify" && l["result"] === "ok")).toBe(true);
  });

  test("a forced WANT_AMOUNT that the kernel would not sponsor is still posted, with a warning", async () => {
    const h = harness();
    h.free.set(coinA.nonce, coinA);
    h.journal.recordMintIntent(coinA.nonce, coinA.type, coinA.value);
    h.journal.recordMinted(coinA.nonce, { nullifier: coinA.nullifier });
    h.quoteResult = sized({
      wantAmount: 99_999n,
      sponsored: false,
      forced: true,
      warnings: ["WANT_AMOUNT=99999 is above the sponsored threshold 31500"],
    });

    const result = await offerCoin(h.deps, coinA, { tick: 1, mode: "reoffer" });
    expect(result.ok).toBe(true);
    expect(h.calls.build[0]?.wantAmount).toBe(99_999n);
    expect(h.journal.getCoin(coinA.nonce)?.offers.at(-1)?.quote.sponsored).toBe(false);
  });
});

describe("outcome shape", () => {
  test("every outcome is a valid TickOutcome the scheduler can count", async () => {
    const h = harness();
    seedReleasedCoin(h, coinA);
    const outcome: TickOutcome = await runTick(h.deps, 1);
    expect(["mint", "reoffer", "degraded", "idle"]).toContain(outcome.mode);
    expect(typeof outcome.ok).toBe("boolean");
  });
});
