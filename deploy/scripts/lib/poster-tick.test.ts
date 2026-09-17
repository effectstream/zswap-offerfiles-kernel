import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "./poster-journal.ts";
import { NotSponsoredError } from "./poster-quote.ts";
import {
  FAILURES,
  isRetryablePostError,
  offerCoin,
  postRejected,
  reconcile,
  refusalCode,
  runTick,
  selectInventoryCoin,
  type SpendableCoin,
  type TickDeps,
} from "./poster-tick.ts";

const GIVE = "12".repeat(32);
const WANT = "34".repeat(32);
const NONCE = "56".repeat(32);
const NULLIFIER = "78".repeat(32);
const OFFER = "9a".repeat(32);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function setup(over: Partial<TickDeps["cfg"]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "poster-inventory-tick-"));
  dirs.push(dir);
  const journal = openJournal({ file: join(dir, "journal.json"), networkId: "preprod", giveColour: GIVE });
  const free = new Map<string, SpendableCoin>();
  const posts: string[] = [];
  const builds: string[] = [];
  const reverts: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: TickDeps = {
    cfg: {
      giveColour: GIVE,
      giveAmount: 1000n,
      wantColour: WANT,
      offerTtlMinutes: 60,
      maxReoffersPerTick: 1,
      postRetries: 3,
      postRetryMs: 1,
      liveTries: 2,
      liveIntervalMs: 1,
      ...over,
    },
    journal,
    wallet: {
      availableNonces: async () => [...free.keys()],
      availableCoins: async () => [...free.values()],
      findCoin: async (nonce) => free.get(nonce),
    },
    builder: {
      build: async (args) => {
        builds.push(args.nonce);
        return {
          recipe: {},
          nullifiers: [free.get(args.nonce)?.nullifier ?? NULLIFIER],
          fallibleInputCount: 0,
          blob: `swapoffer1${args.nonce.slice(0, 8)}`,
          offerId: OFFER,
          blobSha256: "ab".repeat(32),
        };
      },
      revert: async (recipe) => { reverts.push(recipe); },
    },
    api: {
      sizeWant: async () => ({
        wantAmount: 900n,
        sponsored: true,
        forced: false,
        suggestedWantAmount: 900n,
        marketRate: 1,
        sponsorDiscount: 0.025,
        fromSource: "seed",
        toSource: "seed",
        pricesUpdatedAt: null,
        warnings: [],
        raw: {} as never,
      }),
      postOffer: async (blob) => { posts.push(blob); return { status: 200, body: {} }; },
      offerStatusByBlob: async () => ({ offerId: OFFER, status: "live" }),
      offerStatusByHash: async (offerId) => ({ offerId, status: "expired" }),
      getOffer: async () => ({ offerId: OFFER, computed: { inputNullifiers: [NULLIFIER] } }),
    },
    clock: { now: () => 1, sleep: async () => undefined },
    log: (entry) => logs.push(entry),
  };
  return { deps, journal, free, posts, builds, reverts, logs };
}

const coin = (value = 1000n, type = GIVE): SpendableCoin => ({
  nonce: NONCE,
  type,
  value,
  nullifier: NULLIFIER,
});

describe("external inventory selection", () => {
  test("adopts and posts one matching prefunded coin", async () => {
    const h = setup();
    h.free.set(NONCE, coin());
    const outcome = await runTick(h.deps, 1);
    expect(outcome).toMatchObject({ ok: true, mode: "inventory", inventoryAdopted: true, nonce: NONCE });
    expect(h.journal.getCoin(NONCE)?.state).toBe("offered");
    expect(h.posts).toHaveLength(1);
  });

  test("reports the external prefunding prerequisite when inventory is empty", async () => {
    const h = setup();
    const outcome = await runTick(h.deps, 1);
    expect(outcome).toMatchObject({ ok: true, mode: "degraded", failure: FAILURES.insufficientInventory });
    expect(outcome.error).toContain("Prefund POSTER_SEED");
    expect(h.posts).toHaveLength(0);
  });

  test("filters by explicit token and exact or ranged base-unit size", () => {
    const h = setup();
    expect(selectInventoryCoin([coin(999n), coin(1000n, WANT)], h.journal, h.deps.cfg)).toBeUndefined();
    expect(selectInventoryCoin([coin()], h.journal, h.deps.cfg)?.nonce).toBe(NONCE);
    const ranged = setup({ giveRange: { minBase: 900n, maxBase: 1100n } });
    expect(selectInventoryCoin([coin(950n)], ranged.journal, ranged.deps.cfg)?.value).toBe(950n);
  });

  test("never adopts the same coin twice and reuses it only after release", async () => {
    const h = setup();
    h.free.set(NONCE, coin());
    expect((await runTick(h.deps, 1)).mode).toBe("inventory");
    h.journal.setOfferStatus(NONCE, OFFER, "expired");
    expect((await runTick(h.deps, 2)).mode).toBe("reoffer");
    expect(h.journal.coins()).toHaveLength(1);
  });
});

describe("offer safety and retries", () => {
  test("refuses a build that spends the wrong nullifier", async () => {
    const h = setup();
    h.free.set(NONCE, coin());
    h.deps.builder.build = async () => ({
      recipe: {}, nullifiers: ["ff".repeat(32)], fallibleInputCount: 0,
      blob: "swapoffer1bad", offerId: OFFER, blobSha256: "aa".repeat(32),
    });
    h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    const result = await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" });
    expect(result).toMatchObject({ ok: false, failure: FAILURES.wrongInputNullifier });
    expect(h.posts).toHaveLength(0);
    expect(h.reverts).toHaveLength(1);
  });

  test("refuses two inputs and fallible inputs even when the selected nullifier is present", async () => {
    for (const built of [
      { nullifiers: [NULLIFIER, "ff".repeat(32)], fallibleInputCount: 0 },
      { nullifiers: [NULLIFIER], fallibleInputCount: 1 },
    ]) {
      const h = setup();
      h.free.set(NONCE, coin());
      h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
      h.deps.builder.build = async () => ({
        recipe: {}, blob: "swapoffer1bad", offerId: OFFER, blobSha256: "aa".repeat(32), ...built,
      });
      expect(await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
        ok: false,
        failure: FAILURES.wrongInputNullifier,
      });
      expect(h.posts).toHaveLength(0);
      expect(h.reverts).toHaveLength(1);
    }
  });

  test("retries ROOT_UNKNOWN with the same blob", async () => {
    const h = setup();
    h.free.set(NONCE, coin());
    h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    let attempts = 0;
    h.deps.api.postOffer = async (blob) => {
      h.posts.push(blob);
      attempts += 1;
      return attempts === 1 ? { status: 422, body: { error: "ROOT_UNKNOWN" } } : { status: 200, body: {} };
    };
    const result = await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" });
    expect(result.ok).toBe(true);
    expect(h.posts).toEqual([h.posts[0], h.posts[0]]);
  });

  test("retry classification is narrow and exhaustion reverts the recipe", async () => {
    expect(isRetryablePostError({ error: "ROOT_UNKNOWN" })).toBe(true);
    expect(isRetryablePostError("UTXO_NOT_LIVE")).toBe(true);
    expect(isRetryablePostError({ error: "NOT_SPONSORED" })).toBe(false);
    const h = setup({ postRetries: 2 });
    h.free.set(NONCE, coin());
    h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    h.deps.api.postOffer = async (blob) => {
      h.posts.push(blob);
      return { status: 422, body: { error: "ROOT_UNKNOWN" } };
    };
    const result = await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" });
    expect(result).toMatchObject({ ok: false, failure: FAILURES.postTimeout });
    expect(h.posts).toEqual([h.posts[0], h.posts[0]]);
    expect(h.reverts).toHaveLength(1);
  });

  test("nonretryable refusals retain server taxonomy and journal a rejected attempt", async () => {
    expect(refusalCode(422, { error: "UNPRICED_TOKEN: no price" })).toBe("UNPRICED_TOKEN");
    expect(postRejected("DUPLICATE_OFFER")).toBe("post_rejected:DUPLICATE_OFFER");
    for (const [status, code, failure] of [
      [422, "UNPRICED_TOKEN", FAILURES.unpriced],
      [409, "DUPLICATE_OFFER", "post_rejected:DUPLICATE_OFFER"],
      [422, "NOT_SPONSORED", "post_rejected:NOT_SPONSORED"],
    ] as const) {
      const h = setup();
      h.free.set(NONCE, coin());
      h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
      h.deps.api.postOffer = async (blob) => {
        h.posts.push(blob);
        return { status, body: { error: code } };
      };
      expect(await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
        ok: false,
        failure,
      });
      expect(h.posts).toHaveLength(1);
      expect(h.journal.getCoin(NONCE)?.offers.at(-1)?.status).toBe("rejected");
      expect(h.reverts).toHaveLength(1);
    }
  });

  test("quote errors stop before build, while warnings are logged and do not block a valid offer", async () => {
    const failed = setup();
    failed.free.set(NONCE, coin());
    failed.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    failed.deps.api.sizeWant = async () => { throw new Error("quote offline"); };
    expect(await offerCoin(failed.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
      ok: false,
      failure: FAILURES.quoteFailed,
    });
    expect(failed.builds).toHaveLength(0);

    const warned = setup();
    warned.free.set(NONCE, coin());
    warned.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    const original = warned.deps.api.sizeWant;
    warned.deps.api.sizeWant = async (args) => ({ ...(await original(args)), warnings: ["stale price"] });
    expect((await offerCoin(warned.deps, coin(), { tick: 1, mode: "inventory" })).ok).toBe(true);
    expect(warned.logs.some((entry) => entry.warning === "stale price")).toBe(true);
  });

  test("an unforced not-sponsored quote is classified without building", async () => {
    const h = setup();
    h.free.set(NONCE, coin());
    h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    h.deps.api.sizeWant = async () => {
      throw new NotSponsoredError({
        giveColour: GIVE,
        wantColour: WANT,
        giveValue: 1000n,
        wantAmount: 900n,
        raw: {
          from: GIVE, to: WANT, from_amount: "1000", suggested_to_amount: "900",
          market_rate: 1, sponsor_discount: 0.025, discount: 0, from_usd: 1, to_usd: 1,
          from_source: "seed", to_source: "seed", prices_updated_at: null, sponsored: false,
        },
      });
    };
    expect(await offerCoin(h.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
      ok: false,
      failure: FAILURES.notSponsored,
    });
    expect(h.builds).toHaveLength(0);
  });

  test("kernel nullifier or offer-id disagreement fails after the accepted offer is journaled", async () => {
    const wrongInput = setup();
    wrongInput.free.set(NONCE, coin());
    wrongInput.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    wrongInput.deps.api.getOffer = async () => ({ offerId: OFFER, computed: { inputNullifiers: ["ff".repeat(32)] } });
    expect(await offerCoin(wrongInput.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
      ok: false,
      failure: FAILURES.wrongInputNullifier,
    });
    expect(wrongInput.journal.getCoin(NONCE)?.offers[0]?.status).toBe("live");

    const wrongId = setup();
    wrongId.free.set(NONCE, coin());
    wrongId.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    wrongId.deps.api.offerStatusByBlob = async () => ({ offerId: "ff".repeat(32), status: "live" });
    expect(await offerCoin(wrongId.deps, coin(), { tick: 1, mode: "inventory" })).toMatchObject({
      ok: false,
      failure: FAILURES.postTimeout,
    });
    expect(wrongId.journal.getCoin(NONCE)?.offers[0]?.status).toBe("unknown");
  });
});

describe("reconciliation", () => {
  test("consumed closes the coin; cancelled becomes a candidate only with wallet proof", async () => {
    const consumed = setup();
    consumed.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    consumed.journal.recordOffer(NONCE, { offerId: OFFER, blobSha256: "aa", ttlSec: 1, wantColour: WANT, wantAmount: 1n, status: "live" });
    consumed.deps.api.offerStatusByHash = async (offerId) => ({ offerId, status: "consumed" });
    expect((await reconcile(consumed.deps)).spent).toEqual([NONCE]);
    expect(consumed.journal.getCoin(NONCE)?.state).toBe("spent");

    const cancelled = setup();
    cancelled.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    cancelled.journal.recordOffer(NONCE, { offerId: OFFER, blobSha256: "aa", ttlSec: 1, wantColour: WANT, wantAmount: 1n, status: "live" });
    cancelled.deps.api.offerStatusByHash = async (offerId) => ({ offerId, status: "cancelled" });
    expect((await reconcile(cancelled.deps)).candidates).toHaveLength(0);
    cancelled.free.set(NONCE, coin());
    expect((await reconcile(cancelled.deps)).candidates.map((entry) => entry.nonce)).toEqual([NONCE]);
  });

  test("an unreachable kernel preserves status and records the reason", async () => {
    const h = setup();
    h.journal.recordInventory(NONCE, GIVE, 1000n, NULLIFIER);
    h.journal.recordOffer(NONCE, { offerId: OFFER, blobSha256: "aa", ttlSec: 1, wantColour: WANT, wantAmount: 1n, status: "live" });
    h.deps.api.offerStatusByHash = async () => { throw new Error("kernel offline"); };
    const result = await reconcile(h.deps);
    expect(result.errors).toEqual([{ offerId: OFFER, message: "kernel offline" }]);
    expect(h.journal.getCoin(NONCE)?.offers[0]?.status).toBe("live");
    expect(h.logs.some((entry) => entry.result === "unreachable")).toBe(true);
  });
});
