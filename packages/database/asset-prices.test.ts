import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "./test-pglite.ts";

// The schema half of the price model: the seeds shipped in 000-init.sql, the
// rule that protects a `manual` override from the feed, and the per-base-unit
// conversion applied to the real seeded numbers.
//
// These seeds are not decoration. They are what makes a fresh stack quote real
// ratios with the price-feed service switched off (D2), so "the seed values are
// exactly the ones captured on 2026-09-02" is a product assertion, not a
// fixture detail — hard-coded here so an accidental edit to the SQL fails.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const ledger = await import("@midnightntwrk/ledger-v9");
const {
  migrationTable,
  getAssetPrices,
  upsertAssetPriceFeed,
  getPriceFeedStatus,
  upsertPriceFeedStatus,
  getKnownTokensWithAssets,
  getTokenPriceRow,
  getTokenPriceRows,
  upsertTokenPrice,
  insertKnownToken,
  resolveAssetId,
  tokenPriceFromAsset,
} = await import("@zswap-da/database");

const PORT = 54353;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const COLOR_NIGHT = "0".repeat(64);
const COLOR_USDC = "1".repeat(64);
const COLOR_USDM = "003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73";
const COLOR_SNIGHT = "793c29c94f72972bfbd861e8e84e55480ccc8e57a7b74067f35a5672c816f99c";
const COLOR_TEST = "a".repeat(64);

// The shielded-night contract addresses, as committed in that repo's
// `frontend/.env`. They are the INPUT to the colour derivation below, so they
// are written here and nowhere else in the test.
const SNIGHT_CONTRACT = {
  preview: "80b89b9a4213c61da84f54b2ea02e2809f9c4dedbdafacd04b38d4667bee1396",
  preprod: "e354e6725893397e6a2dfa44522a017fabb5d9c92efed50288711f5f865c8950",
} as const;

beforeAll(async () => {
  handle = await startPglite(PORT);
  client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: "postgres",
    database: "postgres",
  });
  await client.connect();
  for (const migration of migrationTable) {
    await client.query(migration.sql);
  }
});

afterAll(async () => {
  await closeTestPglite(handle, client);
});

const assetsByIdRaw = async () =>
  new Map((await getAssetPrices.run(undefined, client)).map((r) => [r.asset_id, r]));

// ── seeds ──────────────────────────────────────────────────────────────────

test("a fresh database ships the 2026-09-02 reference prices", async () => {
  const assets = await assetsByIdRaw();
  expect([...assets.keys()].sort()).toEqual([
    "bitcoin",
    "ethereum",
    "midnight-3",
    "usd-coin",
    "usdm-2",
  ]);
  // Exact NUMERIC spellings — the API serves these as strings.
  expect(assets.get("bitcoin")!.price_usd).toBe("77387");
  expect(assets.get("ethereum")!.price_usd).toBe("2393.28");
  expect(assets.get("usd-coin")!.price_usd).toBe("0.999818");
  expect(assets.get("midnight-3")!.price_usd).toBe("0.01918181");
  // USDM is Moneta's Cardano USDM, observed like everything else — NOT pinned
  // to 1. It was 1.001 when the seed was captured, and that drift is the point.
  expect(assets.get("usdm-2")!.price_usd).toBe("1.001");

  // Every asset is a fetched, provider-sourced price. There is no other kind.
  for (const id of ["bitcoin", "ethereum", "usd-coin", "midnight-3", "usdm-2"]) {
    expect(assets.get(id)!.source).toBe("seed");
    expect(assets.get(id)!.provider_updated_at).not.toBeNull();
  }

  // CoinGecko's own last_updated_at, as unix seconds in the plan.
  expect(new Date(assets.get("bitcoin")!.provider_updated_at as any).getTime()).toBe(
    1788380750 * 1000,
  );
  expect(new Date(assets.get("midnight-3")!.provider_updated_at as any).getTime()).toBe(
    1788380780 * 1000,
  );
  expect(new Date(assets.get("usdm-2")!.provider_updated_at as any).getTime()).toBe(
    1788388850 * 1000,
  );
});

test("SC-001 basis: WBTC→WETH from the seeds alone is the BTC/ETH rate", async () => {
  const assets = await assetsByIdRaw();
  const rate =
    Number(assets.get("bitcoin")!.price_usd) / Number(assets.get("ethereum")!.price_usd);
  expect(rate).toBeCloseTo(77387 / 2393.28, 12);
  // The number preprod served before this project was 0.2153 (hash prices).
  expect(rate).toBeGreaterThan(32);
  expect(rate).toBeLessThan(33);
});

test("the four redeploy-stable tokens are seeded, and only those", async () => {
  const tokens = await getKnownTokensWithAssets.run(undefined, client);
  expect(tokens.map((t) => t.name)).toEqual(["NIGHT", "SNIGHT", "USDC", "USDM"]);

  const byName = new Map(tokens.map((t) => [t.name, t]));
  // 6 decimals: 1 NIGHT = 10^6 Stars (base units) — STARS_PER_NIGHT in
  // midnight-ledger/ledger/src/structure.rs. Was seeded at 0 (a bug: it
  // priced one Star, the base unit, at NIGHT's whole-coin price).
  expect(byName.get("NIGHT")).toMatchObject({
    token_color: COLOR_NIGHT,
    kind: "unshielded",
    decimals: 6,
    asset_id: "midnight-3",
  });
  // The shielded-night wrapper, seeded with the PREVIEW colour (000-init.sql
  // says how to patch it for another network). Same asset and same decimals as
  // NIGHT — one sNight base unit is one Star — so equal base units are at par
  // under the sponsorship gate. Asserted against NIGHT's ROW rather than
  // against the literal 6, so the two can only ever move together.
  expect(byName.get("SNIGHT")).toMatchObject({
    token_color: COLOR_SNIGHT,
    kind: "shielded",
    decimals: byName.get("NIGHT")!.decimals,
    asset_id: "midnight-3",
  });
  // 6 decimals: a placeholder colour (no USDC on preprod), kept at USDC's
  // real shape — 6 decimals on every chain it exists on — same reasoning as
  // USDM below.
  expect(byName.get("USDC")).toMatchObject({
    token_color: COLOR_USDC,
    kind: "shielded",
    decimals: 6,
    asset_id: "usd-coin",
  });
  // The VIA Labs bridge's Midnight-preview token type: unshielded, 6 decimals.
  expect(byName.get("USDM")).toMatchObject({
    token_color: COLOR_USDM,
    kind: "unshielded",
    decimals: 6,
    asset_id: "usdm-2",
  });
});

test("USDM's per-base-unit price is the seeded usdm-2 price / 1e6", async () => {
  const assets = await assetsByIdRaw();
  const tokens = await getKnownTokensWithAssets.run(undefined, client);
  const usdm = tokens.find((t) => t.name === "USDM")!;
  const mapped = resolveAssetId(usdm)!;
  expect(mapped).toEqual({ assetId: "usdm-2", decimals: 6 });
  // 1.001 / 10^6 — exactly, with no float noise and no assumed peg.
  expect(tokenPriceFromAsset(assets.get(mapped.assetId)!.price_usd, mapped.decimals)).toBe(
    "0.000001001",
  );
});

test("NIGHT's per-base-unit price is the seeded midnight-3 price / 1e6 (1 NIGHT = 10^6 Stars)", async () => {
  const assets = await assetsByIdRaw();
  const tokens = await getKnownTokensWithAssets.run(undefined, client);
  const night = tokens.find((t) => t.name === "NIGHT")!;
  const mapped = resolveAssetId(night)!;
  expect(mapped).toEqual({ assetId: "midnight-3", decimals: 6 });
  // 0.01918181 / 10^6 — exact decimal-string arithmetic, no float noise.
  // Before this fix the row was `decimals: 0`, which priced one Star (the
  // base unit) at NIGHT's whole-coin price — off by 10^6.
  expect(tokenPriceFromAsset(assets.get(mapped.assetId)!.price_usd, mapped.decimals)).toBe(
    "0.00000001918181",
  );
});

test("every seeded known token resolves to a seeded asset", async () => {
  const assets = await assetsByIdRaw();
  for (const token of await getKnownTokensWithAssets.run(undefined, client)) {
    const mapped = resolveAssetId(token);
    expect(mapped).not.toBeNull();
    expect(assets.has(mapped!.assetId)).toBe(true);
  }
});

// ── sNight: the one seeded colour that moves with a contract (00021) ───────
//
// SNIGHT's colour is tokenType(pad(32, "shielded-night:wrapper"), self()), so
// unlike the other three seeds it changes with the shielded-night contract
// ADDRESS, i.e. with the network. 000-init.sql seeds *preview* and carries the
// preprod address/colour in a comment for whoever patches the row. Both are
// re-derived here from the addresses committed in the shielded-night repo, so
// a redeploy — or a mistyped patch — fails here instead of registering a
// colour nobody holds, and the comment cannot rot away from the row.

/** The contract's `tokenType(pad(32, "shielded-night:wrapper"), self())`. */
const deriveWrapperColor = (contractAddress: string): string => {
  const domain = new Uint8Array(32);
  domain.set(new TextEncoder().encode("shielded-night:wrapper"));
  return String(
    (ledger as unknown as {
      rawTokenType: (domain: Uint8Array, contract: string) => string;
    }).rawTokenType(domain, contractAddress),
  ).toLowerCase();
};

test("the seeded SNIGHT colour is derived from the preview shielded-night address", async () => {
  expect(deriveWrapperColor(SNIGHT_CONTRACT.preview)).toBe(COLOR_SNIGHT);

  const row = (await getKnownTokensWithAssets.run(undefined, client)).find(
    (t) => t.name === "SNIGHT",
  )!;
  expect(row.token_color).toBe(deriveWrapperColor(SNIGHT_CONTRACT.preview));
});

test("the other networks commented in 000-init.sql carry their derived colours", () => {
  const sql = migrationTable.find((m) => m.name === "000-init.sql")!.sql;
  // Both networks are documented as `<network>  address <hex>` / `colour <hex>`
  // in the SNIGHT note; the pair must still derive from one another.
  for (const network of ["preview", "preprod"] as const) {
    const documented = new RegExp(
      `${network}\\s+address\\s+([0-9a-f]{64})[^]*?colour\\s+([0-9a-f]{64})`,
    ).exec(sql);
    expect({ network, documented: documented !== null }).toEqual({
      network,
      documented: true,
    });
    const [, address, color] = documented!;
    expect({ network, address }).toEqual({ network, address: SNIGHT_CONTRACT[network] });
    expect({ network, color }).toEqual({
      network,
      color: deriveWrapperColor(address!),
    });
  }
  // mainnet has no address yet, so it must NOT be documented with a colour.
  expect(/mainnet\s+address\s+[0-9a-f]{64}/.test(sql)).toBe(false);
});

test("SNIGHT prices as NIGHT through the NAME map even without an asset_id", () => {
  // The row above is seeded WITH midnight-3, but a hand-patched or POSTed
  // sNight on another network may not be — the name map is the backstop. Only
  // the asset comes from the map; the decimals stay the row's own, which is
  // why the seeded row must carry NIGHT's 6 (asserted above).
  expect(resolveAssetId({ name: "SNIGHT", decimals: 6, asset_id: null })).toEqual({
    assetId: "midnight-3",
    decimals: 6,
  });
});

// ── the registry's new columns ─────────────────────────────────────────────

test("a token registered without decimals/asset_id lands on 0 / NULL", async () => {
  await insertKnownToken.run(
    {
      token_color: COLOR_TEST,
      name: "TESTTOKENA",
      kind: "shielded",
      decimals: null,
      asset_id: null,
    },
    client,
  );
  const row = (await getKnownTokensWithAssets.run(undefined, client)).find(
    (t) => t.name === "TESTTOKENA",
  )!;
  expect(row.decimals).toBe(0);
  expect(row.asset_id).toBeNull();
  // …and nothing maps it, so it is unpriced.
  expect(resolveAssetId(row)).toBeNull();
});

test("decimals outside [0, 38] are refused by the schema", async () => {
  await expect(
    client.query("INSERT INTO known_tokens (token_color, name, kind, decimals) VALUES ($1,$2,$3,$4)", [
      "b".repeat(64),
      "TOOMANY",
      "shielded",
      39,
    ]),
  ).rejects.toThrow();
  await expect(
    client.query("INSERT INTO known_tokens (token_color, name, kind, decimals) VALUES ($1,$2,$3,$4)", [
      "c".repeat(64),
      "NEGATIVE",
      "shielded",
      -1,
    ]),
  ).rejects.toThrow();
});

test("asset_id must name a real asset (FK)", async () => {
  await expect(
    client.query("INSERT INTO known_tokens (token_color, name, kind, asset_id) VALUES ($1,$2,$3,$4)", [
      "d".repeat(64),
      "GHOST",
      "shielded",
      "not-an-asset",
    ]),
  ).rejects.toThrow();
});

// ── what the feed may and may not write ────────────────────────────────────

test("the feed overwrites a seed row and reports the id it wrote", async () => {
  const written = await upsertAssetPriceFeed.run(
    { asset_id: "bitcoin", price_usd: "80000.5", provider_updated_at: new Date().toISOString() },
    client,
  );
  expect(written.map((r) => r.asset_id)).toEqual(["bitcoin"]);

  const assets = await assetsByIdRaw();
  expect(assets.get("bitcoin")!.price_usd).toBe("80000.5");
  expect(assets.get("bitcoin")!.source).toBe("feed");
});

test("the feed overwrites its own row too", async () => {
  await upsertAssetPriceFeed.run(
    { asset_id: "bitcoin", price_usd: "81000", provider_updated_at: null },
    client,
  );
  const assets = await assetsByIdRaw();
  expect(assets.get("bitcoin")!.price_usd).toBe("81000");
  expect(assets.get("bitcoin")!.source).toBe("feed");
  expect(assets.get("bitcoin")!.provider_updated_at).toBeNull();
});

test("the stablecoin is a fetched row like any other — a depeg is written through", async () => {
  const written = await upsertAssetPriceFeed.run(
    { asset_id: "usdm-2", price_usd: "0.94", provider_updated_at: null },
    client,
  );
  expect(written.map((r) => r.asset_id)).toEqual(["usdm-2"]);
  const assets = await assetsByIdRaw();
  expect(assets.get("usdm-2")!.price_usd).toBe("0.94");
  expect(assets.get("usdm-2")!.source).toBe("feed");
});

test("the source CHECK admits only seed and feed", async () => {
  await expect(
    client.query(
      "INSERT INTO asset_prices (asset_id, price_usd, source) VALUES ($1, $2, $3)",
      ["some-peg", "1", "fixed"],
    ),
  ).rejects.toThrow();
});

test("a manual token price survives a fallback write; source defaults to fallback", async () => {
  await client.query(
    "INSERT INTO token_prices (token_color, price_usd, source) VALUES ($1, $2, 'manual')",
    [COLOR_TEST, "42.5"],
  );
  // The quote path's first-quote insert, verbatim.
  await upsertTokenPrice.run({ token_color: COLOR_TEST, price_usd: 13.02 }, client);

  const row = (await getTokenPriceRow.run({ token_color: COLOR_TEST }, client))[0]!;
  expect(row.price_usd).toBe("42.5");
  expect(row.source).toBe("manual");

  // A colour with no row gets the demo price, labelled `fallback`.
  await upsertTokenPrice.run({ token_color: "e".repeat(64), price_usd: 7.5 }, client);
  const fresh = (await getTokenPriceRow.run({ token_color: "e".repeat(64) }, client))[0]!;
  expect(fresh.price_usd).toBe("7.5");
  expect(fresh.source).toBe("fallback");

  // The bounded read (Q-11: there is no unfiltered form) returns exactly the
  // colours asked for, and silently omits one that has no row.
  const all = await getTokenPriceRows.run(
    { token_colors: [COLOR_TEST, "e".repeat(64), "f".repeat(64)] },
    client,
  );
  expect(new Set(all.map((r) => r.token_color))).toEqual(new Set([COLOR_TEST, "e".repeat(64)]));

  const none = await getTokenPriceRows.run({ token_colors: [] }, client);
  expect(none).toEqual([]);
});

test("token_prices.source accepts only manual and fallback", async () => {
  await expect(
    client.query("INSERT INTO token_prices (token_color, price_usd, source) VALUES ($1,$2,$3)", [
      "f".repeat(64),
      "1",
      "feed",
    ]),
  ).rejects.toThrow();
});

// ── feed status ────────────────────────────────────────────────────────────

test("feed status starts absent, then records runs without losing last_ok_at", async () => {
  expect(await getPriceFeedStatus.run(undefined, client)).toEqual([]);

  const firstOk = "2026-09-03T00:00:00.000Z";
  await upsertPriceFeedStatus.run(
    { provider: "coingecko", last_run_at: firstOk, last_ok_at: firstOk, last_error: null },
    client,
  );
  let status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(status.provider).toBe("coingecko");
  expect(new Date(status.last_ok_at as any).toISOString()).toBe(firstOk);
  expect(status.last_error).toBeNull();

  // A failed cycle records the error and moves last_run_at — but the operator
  // must still be able to see when prices were last actually good.
  const failedAt = "2026-09-04T00:00:00.000Z";
  await upsertPriceFeedStatus.run(
    {
      provider: "coingecko",
      last_run_at: failedAt,
      last_ok_at: null,
      last_error: "429 rate limited",
    },
    client,
  );
  status = (await getPriceFeedStatus.run(undefined, client))[0]!;
  expect(new Date(status.last_run_at as any).toISOString()).toBe(failedAt);
  expect(new Date(status.last_ok_at as any).toISOString()).toBe(firstOk);
  expect(status.last_error).toBe("429 rate limited");
});

test("price_feed_status can only ever hold one row", async () => {
  await expect(
    client.query(
      "INSERT INTO price_feed_status (id, provider) VALUES ($1, $2)",
      [2, "coingecko"],
    ),
  ).rejects.toThrow();
});
