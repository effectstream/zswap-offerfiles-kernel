import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeTestPglite } from "../database/test-pglite.ts";

// POST /v1/offers' fee-sponsorship pre-check, over HTTP, through the REAL
// apiRouter on a real fastify instance backed by PGlite with the real
// migrations — the same harness style as api.test.ts, in its own file because
// it has to mock the batcher client and drive the whole ingestion ladder.
//
// The offer is the real proven fixture:
//   gives 1_000_000 × 0000…0000 (NIGHT, seeded at 0.01918181/base unit)
//   wants 5_000_000 × ffff…ffff (priced per test, by a `manual` row)
// so give_usd is 19181.81 and the wanted colour's price is the only dial.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";
process.env["ENABLE_TOKEN_REGISTRY"] = "true";

// The batcher is stubbed at the TRANSPORT, by replacing `fetch` for its
// /send-input URL only — NOT with `mock.module`. Bun's module mocks are
// process-global and leak into every other test file in the run: an earlier
// version of this file replaced ./batcher-client.ts and silently broke
// validation-contexts.characterization.test.ts, which counts real batcher
// fetches. Intercepting fetch also means the REAL submitBlobViaBatcher runs,
// so the batcher-refusal cases below exercise its actual response parsing and
// the 422 mapping rather than a hand-rolled throw.
const { sponsorshipRefusalError } = await import("./batcher-client.ts");
const { BATCHER_SUBMIT_URL } = await import("./env.ts");

let submitted: string[] = [];
/** What the batcher "replies". Default: a well-formed wait-receipt. */
let batcherReply: () => Response = () =>
  new Response(
    JSON.stringify({
      success: true,
      inputsProcessed: 1,
      message: "ok",
      transactionHash: "stub-tx",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (url === `${BATCHER_SUBMIT_URL}/send-input`) {
    submitted.push(JSON.parse(String(init?.body ?? "{}")).data?.input ?? "");
    return batcherReply();
  }
  return originalFetch(input, init);
}) as typeof fetch;

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const { migrationTable } = await import("@zswap-da/database");
const fastify = (await import("fastify")).default;
const { apiRouter } = await import("./api.ts");

const PORT = 54373;
const GIVE_COLOR = "0".repeat(64);
const WANT_COLOR = "f".repeat(64);
const NIGHT_PRICE = 0.01918181;
const GIVE_USD = 1_000_000 * NIGHT_PRICE; // 19181.81
const FIXTURE_ROOT = "73b35bda8df702a240f2b7605bca3ea4f7bdb4110f5c6d35c58ed512faf7697303";

const blob = readFileSync(
  new URL("../validator/fixtures/valid-offer.bech32", import.meta.url),
  "utf-8",
).trim();

/** Per-unit price for the wanted leg that puts want_usd at `fraction` × give_usd. */
const wantPriceFor = (fraction: number) => (GIVE_USD * fraction) / 5_000_000;

let handle: any;
let client: any;
let server: any;

const post = async () => {
  const res = await server.inject({ method: "POST", url: "/v1/offers", payload: { offer: blob } });
  return { status: res.statusCode, body: res.json() as any };
};

const priceWanted = async (perUnit: number, source: "manual" | "fallback" = "manual") => {
  await client.query("DELETE FROM token_prices WHERE token_color = $1", [WANT_COLOR]);
  await client.query(
    "INSERT INTO token_prices (token_color, price_usd, source) VALUES ($1, $2, $3)",
    [WANT_COLOR, String(perUnit), source],
  );
};

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await client.connect();
  for (const migration of migrationTable) await client.query(migration.sql);

  // The root clock reads a FRAMEWORK-owned table the app migrations do not
  // create. Shimmed here (two columns, one row) so the ladder past the
  // sponsorship gate — liveness, crypto, marker dedup — really runs, rather
  // than the gate being the only thing this file can ever observe.
  await client.query("CREATE SCHEMA IF NOT EXISTS effectstream");
  await client.query(
    `CREATE TABLE effectstream.effectstream_blocks (
       block_height BIGINT PRIMARY KEY, ms_timestamp BIGINT,
       effectstream_block_hash TEXT, main_chain_block_hash TEXT)`,
  );
  await client.query("INSERT INTO effectstream.effectstream_blocks VALUES (1, $1, 'h', 'm')", [
    String(Date.now()),
  ]);
  await client.query(
    "INSERT INTO known_roots (root, height, last_seen_ms, first_seen_ms) VALUES ($1, 1, $2, $2)",
    [FIXTURE_ROOT, String(Date.now())],
  );
  await client.query(
    "INSERT INTO known_tokens (token_color, name, kind, decimals) VALUES ($1, 'WANTX', 'shielded', 0)",
    [WANT_COLOR],
  );

  process.env["BATCHER_SPONSOR_POLICY"] = "enforce";
  server = fastify();
  await apiRouter(server, client);
  await server.ready();
});

afterEach(async () => {
  submitted = [];
  batcherReply = () =>
    new Response(
      JSON.stringify({ success: true, inputsProcessed: 1, message: "ok", transactionHash: "stub-tx" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  process.env["BATCHER_SPONSOR_POLICY"] = "enforce";
  delete process.env["BATCHER_SPONSOR_UNPRICED"];
  // The handler's byte-identical dedup would answer 409 on the second post of
  // the same fixture, so nothing may be left indexed between tests.
  await client.query("DELETE FROM offer_file_tokens");
  await client.query("DELETE FROM offer_file");
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  try {
    await server?.close();
  } finally {
    delete process.env["BATCHER_SPONSOR_POLICY"];
    await closeTestPglite(handle, client);
  }
});

describe("POST /v1/offers — 422 NOT_SPONSORED (the RED probe's 500-after-forwarding, flipped)", () => {
  test("priced exactly at reference → 422 with the numbers, and NOTHING is forwarded", async () => {
    await priceWanted(wantPriceFor(1.0));
    const { status, body } = await post();

    expect(status).toBe(422);
    expect(body.error).toBe("NOT_SPONSORED");
    expect(body.reason).toContain("wants 0.0% below reference");
    expect(body.reason).toContain("needs ≥ 2.5%");
    expect(body.give_usd).toBe(19181.81);
    expect(body.want_usd).toBe(19181.81);
    expect(body.implied_discount).toBe(0);
    expect(body.sponsor_discount).toBe(0.025);
    // The point of a PRE-check: the batcher was never asked, so no fee was
    // ever at risk.
    expect(submitted).toHaveLength(0);
  });

  test("2.5% below reference → forwarded to the batcher, 200", async () => {
    await priceWanted(wantPriceFor(0.975));
    const { status, body } = await post();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(blob);
  });

  test("above reference → 422, and the reason says `above`", async () => {
    await priceWanted(wantPriceFor(1.05));
    const { body } = await post();
    expect(body.error).toBe("NOT_SPONSORED");
    expect(body.reason).toContain("wants 5.0% above reference");
    expect(body.implied_discount).toBeCloseTo(-0.05, 10);
  });

  test("the seeded NIGHT asset price is what prices the give leg — no manual row for it", async () => {
    // Nothing in token_prices for 0000…0000; its price comes from
    // asset_prices via known_tokens.asset_id ('midnight-3'). If that path were
    // broken the offer would read as unpriced, not as 19181.81.
    const rows = await client.query("SELECT * FROM token_prices WHERE token_color = $1", [
      GIVE_COLOR,
    ]);
    expect(rows.rows).toHaveLength(0);
    await priceWanted(wantPriceFor(1.0));
    const { body } = await post();
    expect(body.give_usd).toBe(19181.81);
  });

  test("the pre-check writes NO demo price rows — a refused offer leaves no trace", async () => {
    await client.query("DELETE FROM token_prices WHERE token_color = $1", [WANT_COLOR]);
    const before = await client.query("SELECT count(*)::int AS n FROM token_prices");
    await post();
    const after = await client.query("SELECT count(*)::int AS n FROM token_prices");
    // The quote path writes a fallback row when it has to answer. A submission
    // must not: the first post of an unmapped token would otherwise create the
    // row that makes the second one look priced.
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("policy — the node mirrors the batcher's knobs (Q-6)", () => {
  test("warn: the same offer is FORWARDED, not refused", async () => {
    await priceWanted(wantPriceFor(1.0));
    process.env["BATCHER_SPONSOR_POLICY"] = "warn";
    const { status } = await post();
    expect(status).toBe(200);
    expect(submitted).toHaveLength(1);
  });

  test("off: no price work at all, forwarded", async () => {
    await priceWanted(wantPriceFor(1.0));
    process.env["BATCHER_SPONSOR_POLICY"] = "off";
    const { status } = await post();
    expect(status).toBe(200);
  });

  test("the DEFAULT is warn — an offer at reference still flows (D7, SC-003)", async () => {
    await priceWanted(wantPriceFor(1.0));
    delete process.env["BATCHER_SPONSOR_POLICY"];
    const { status } = await post();
    expect(status).toBe(200);
  });

  test("a typo in the policy is refused at startup, not defaulted", async () => {
    const saved = process.env["BATCHER_SPONSOR_POLICY"];
    process.env["BATCHER_SPONSOR_POLICY"] = "enfroce";
    try {
      const bad = fastify();
      await expect(apiRouter(bad, client)).rejects.toThrow("enforce | warn | off");
      await bad.close();
    } finally {
      process.env["BATCHER_SPONSOR_POLICY"] = saved;
    }
  });
});

describe("unpriced tokens", () => {
  test("allow (default): forwarded, even though one leg has no market", async () => {
    await client.query("DELETE FROM token_prices WHERE token_color = $1", [WANT_COLOR]);
    const { status } = await post();
    expect(status).toBe(200);
    expect(submitted).toHaveLength(1);
  });

  test("reject: 422 UNPRICED_TOKEN naming the colour", async () => {
    await client.query("DELETE FROM token_prices WHERE token_color = $1", [WANT_COLOR]);
    process.env["BATCHER_SPONSOR_UNPRICED"] = "reject";
    const { status, body } = await post();
    expect(status).toBe(422);
    expect(body.error).toBe("UNPRICED_TOKEN");
    expect(body.unpriced).toEqual([WANT_COLOR]);
    expect(body.reason).toContain(WANT_COLOR);
    expect(submitted).toHaveLength(0);
  });

  test("a `fallback` demo row is unpriced, not a market price", async () => {
    // 13.02/unit would be a wildly bad trade if it counted; it must not.
    await priceWanted(13.02, "fallback");
    const { status } = await post();
    expect(status).toBe(200);
  });
});

describe("a batcher refusal is 422, not 500", () => {
  // Exactly what a REAL batcher answers when validateInput refuses — captured
  // from one on 2026-09-02 (Brief B, B4): the SDK wraps the adapter's error, so
  // the code is in `message` and `error` is the generic "Validation failed".
  // Reading only `error` produced a 500; this shape is why the mapping checks
  // both fields.
  const batcherSays = (message: string) => {
    batcherReply = () =>
      new Response(JSON.stringify({ success: false, error: "Validation failed", message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
  };

  test("NOT_SPONSORED from the batcher surfaces as 422 with the batcher's own words", async () => {
    await priceWanted(wantPriceFor(0.975)); // the node is happy; the batcher is not
    batcherSays("NOT_SPONSORED: wants 1.0% below reference, sponsorship needs ≥ 2.5% below");
    const { status, body } = await post();
    expect(status).toBe(422);
    expect(body.error).toBe("NOT_SPONSORED");
    expect(body.reason).toBe(
      "NOT_SPONSORED: wants 1.0% below reference, sponsorship needs ≥ 2.5% below",
    );
    // Not rewrapped as "Failed to submit blob to Celestia via batcher: …".
    expect(body.reason).not.toContain("Failed to submit");
  });

  test.each(["UNPRICED_TOKEN: no market price for ff…", "PRICE_UNAVAILABLE: node never answered"])(
    "%s → 422",
    async (message) => {
      await priceWanted(wantPriceFor(0.975));
      batcherSays(message);
      const { status, body } = await post();
      expect(status).toBe(422);
      expect(body.error).toBe(message.split(":")[0]);
    },
  );

  test("the code is also honoured when it arrives in `error` rather than `message`", async () => {
    // Older/other batcher builds put the adapter message straight in `error`.
    await priceWanted(wantPriceFor(0.975));
    batcherReply = () =>
      new Response(JSON.stringify({ error: "NOT_SPONSORED: wants 0.5% below reference" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const { status, body } = await post();
    expect(status).toBe(422);
    expect(body.error).toBe("NOT_SPONSORED");
  });

  test("any OTHER batcher failure stays a 500 — it is not the maker's fault", async () => {
    await priceWanted(wantPriceFor(0.975));
    batcherReply = () =>
      new Response(JSON.stringify({ error: "wallet has no dust" }), { status: 500 });
    const { status, body } = await post();
    expect(status).toBe(500);
    expect(body.error).toBe("INTERNAL");
  });
});

describe("ordering in the ladder", () => {
  test("a structurally invalid blob is still 400 — the gate never sees it", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/offers",
      payload: { offer: "definitely-not-an-offer" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_ENCODING");
  });

  test("a replay is 409 DUPLICATE_OFFER before the sponsorship gate runs", async () => {
    // Indexed as if it had already been published, then re-posted at a price
    // the gate would refuse: the 409 must win, because it is the cheaper and
    // more specific answer.
    await priceWanted(wantPriceFor(1.0));
    const { offerHashFromBlob } = await import("./offer-hash.ts");
    await client.query(
      `INSERT INTO offer_file (id, celestia_height, transaction_hex, offer_hash, ttl_seconds, created_at, first_seen_at)
       VALUES (9001, 1, $1, $2, 3600, NOW(), NOW())`,
      [blob, offerHashFromBlob(blob)],
    );
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body.error).toBe("DUPLICATE_OFFER");
  });
});

describe("sponsorshipRefusalError — the mapping itself", () => {
  test("matches the three codes at the start of the message only", () => {
    expect(sponsorshipRefusalError("NOT_SPONSORED: x")?.statusCode).toBe(422);
    expect(sponsorshipRefusalError("UNPRICED_TOKEN: x")?.error).toBe("UNPRICED_TOKEN");
    expect(sponsorshipRefusalError("PRICE_UNAVAILABLE: x")?.error).toBe("PRICE_UNAVAILABLE");
    expect(sponsorshipRefusalError("HTTP 500")).toBeNull();
    // Not a prefix match on a longer word, and not a match mid-message.
    expect(sponsorshipRefusalError("NOT_SPONSOREDISH: x")).toBeNull();
    expect(sponsorshipRefusalError("wrapped: NOT_SPONSORED: x")).toBeNull();
  });

  test("the error message is the batcher's, verbatim", () => {
    expect(sponsorshipRefusalError("NOT_SPONSORED: wants 1.0% below")?.message).toBe(
      "NOT_SPONSORED: wants 1.0% below",
    );
  });
});
