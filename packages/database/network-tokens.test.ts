import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeTestPglite } from "./test-pglite.ts";

// The network-specific half of the known-token registry: the sNight colours
// and the idempotent startup seed that writes the running network's row.
//
// Two things are asserted here that nothing else can assert. First, that each
// hard-coded colour really IS the contract's token type — derived live from
// the committed shielded-night address, so a redeploy that changes the address
// without changing the colour constant fails loudly instead of registering a
// token nobody holds. Second, that the seed is safe to run on every start: on
// a fresh database, on a seeded one, and on one where a human already took the
// name.
process.env["DB_USER"] ??= "postgres";
process.env["DB_NAME"] ??= "postgres";
process.env["PGLITE_DATA_DIR"] ??= "memory://";

const { startPglite } = await import("@effectstream/db/start-pglite");
const pg = (await import("pg")).default;
const ledger = await import("@midnight-ntwrk/ledger-v8");
const {
  migrationTable,
  SHIELDED_NIGHT_BY_NETWORK,
  SHIELDED_NIGHT_NAME,
  NIGHT_COLOR,
  seedNetworkKnownTokens,
  resolveAssetId,
} = await import("@zswap-da/database");

const PORT = 54357;
let handle: Awaited<ReturnType<typeof startPglite>>;
let client: InstanceType<typeof pg.Client>;

const PREVIEW_COLOR = "793c29c94f72972bfbd861e8e84e55480ccc8e57a7b74067f35a5672c816f99c";
const PREPROD_COLOR = "8fac382b0d91ad68cf3e2479bf4d21a127f187b83151a11773a8b04bd4576819";

/** A pristine registry — the three SQL seeds and nothing else. */
const resetRegistry = async () => {
  await client.query("DELETE FROM known_tokens WHERE token_color <> ALL($1)", [
    [
      NIGHT_COLOR,
      "1".repeat(64),
      "003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73",
    ],
  ]);
};

const registryRows = async () =>
  (await client.query(
    "SELECT token_color, name, kind, decimals, asset_id FROM known_tokens ORDER BY name",
  )).rows;

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

// ── derivation ─────────────────────────────────────────────────────────────

/** The contract's `tokenType(pad(32,"shielded-night:wrapper"), self())`. */
const deriveWrapperColor = (contractAddress: string): string => {
  const domain = new Uint8Array(32);
  domain.set(new TextEncoder().encode("shielded-night:wrapper"));
  return String(
    (ledger as unknown as {
      rawTokenType: (d: Uint8Array, c: string) => string;
    }).rawTokenType(domain, contractAddress),
  ).toLowerCase();
};

test("every seeded sNight colour is derived from its contract address", () => {
  expect(SHIELDED_NIGHT_BY_NETWORK.size).toBeGreaterThan(0);
  for (const [network, entry] of SHIELDED_NIGHT_BY_NETWORK) {
    expect(entry.contractAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.color).toMatch(/^[0-9a-f]{64}$/);
    expect({ network, color: deriveWrapperColor(entry.contractAddress) }).toEqual({
      network,
      color: entry.color,
    });
  }
});

test("the table holds the two deployed networks, with the addresses committed in shielded-night", () => {
  expect([...SHIELDED_NIGHT_BY_NETWORK.keys()].sort()).toEqual(["preprod", "preview"]);
  expect(SHIELDED_NIGHT_BY_NETWORK.get("preview")).toEqual({
    contractAddress: "80b89b9a4213c61da84f54b2ea02e2809f9c4dedbdafacd04b38d4667bee1396",
    color: PREVIEW_COLOR,
  });
  expect(SHIELDED_NIGHT_BY_NETWORK.get("preprod")).toEqual({
    contractAddress: "e354e6725893397e6a2dfa44522a017fabb5d9c92efed50288711f5f865c8950",
    color: PREPROD_COLOR,
  });
  // Not deployed: no colour to register, so the seed must be a no-op there.
  expect(SHIELDED_NIGHT_BY_NETWORK.has("mainnet")).toBe(false);
  expect(SHIELDED_NIGHT_BY_NETWORK.has("undeployed")).toBe(false);
});

// ── the seed ───────────────────────────────────────────────────────────────

test("preprod seeds exactly one row — the preprod colour, priced and shaped like NIGHT", async () => {
  await resetRegistry();
  const result = await seedNetworkKnownTokens(client, "preprod");
  expect(result).toEqual({ inserted: [PREPROD_COLOR], skipped: [] });

  const rows = await registryRows();
  expect(rows.map((r: any) => r.name)).toEqual(["NIGHT", "SNIGHT", "USDC", "USDM"]);
  const night = rows.find((r: any) => r.name === "NIGHT");
  expect(rows.find((r: any) => r.name === SHIELDED_NIGHT_NAME)).toEqual({
    token_color: PREPROD_COLOR,
    name: "SNIGHT",
    kind: "shielded",
    // Q3: copied from NIGHT's row, not the contract's 6, so a NIGHT ↔ sNight
    // offer of equal base units stays at par under the sponsorship gate.
    decimals: night.decimals,
    asset_id: "midnight-3",
  });
  // The preview colour must not appear on a preprod node.
  expect(rows.some((r: any) => r.token_color === PREVIEW_COLOR)).toBe(false);
});

test("a second start changes nothing and does not throw", async () => {
  const before = await registryRows();
  const result = await seedNetworkKnownTokens(client, "preprod");
  expect(result.inserted).toEqual([]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]!.code).toBe("already-registered");
  expect(result.skipped[0]!.reason).toContain("already registered");
  expect(await registryRows()).toEqual(before);
});

test("preview seeds the preview colour, and only that", async () => {
  await resetRegistry();
  const result = await seedNetworkKnownTokens(client, "preview");
  expect(result).toEqual({ inserted: [PREVIEW_COLOR], skipped: [] });

  const rows = await registryRows();
  expect(rows.find((r: any) => r.name === SHIELDED_NIGHT_NAME).token_color).toBe(
    PREVIEW_COLOR,
  );
  expect(rows.some((r: any) => r.token_color === PREPROD_COLOR)).toBe(false);
});

test("networks without a deployed contract are left alone", async () => {
  for (const network of ["undeployed", "mainnet", "", "qanet"]) {
    await resetRegistry();
    const before = await registryRows();
    expect(await seedNetworkKnownTokens(client, network)).toEqual({
      inserted: [],
      skipped: [],
    });
    expect(await registryRows()).toEqual(before);
    expect(before.map((r: any) => r.name)).toEqual(["NIGHT", "USDC", "USDM"]);
  }
});

test("a name already taken by another colour is skipped with a reason, not a UNIQUE violation", async () => {
  await resetRegistry();
  const squatter = "9".repeat(64);
  await client.query(
    "INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id) VALUES ($1,'SNIGHT','shielded',0,NULL)",
    [squatter],
  );

  const result = await seedNetworkKnownTokens(client, "preprod");
  expect(result.inserted).toEqual([]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]!.name).toBe("SNIGHT");
  expect(result.skipped[0]!.code).toBe("name-taken");
  expect(result.skipped[0]!.reason).toContain(squatter);

  const rows = await registryRows();
  expect(rows.some((r: any) => r.token_color === PREPROD_COLOR)).toBe(false);
  expect(rows.filter((r: any) => r.name === "SNIGHT")).toHaveLength(1);
  await resetRegistry();
});

test("without NIGHT there are no decimals to copy, so the seed declines", async () => {
  await resetRegistry();
  await client.query("DELETE FROM known_tokens WHERE token_color = $1", [NIGHT_COLOR]);
  try {
    const result = await seedNetworkKnownTokens(client, "preprod");
    expect(result.inserted).toEqual([]);
    expect(result.skipped[0]!.code).toBe("missing-night");
    expect(result.skipped[0]!.reason).toContain("NIGHT row");
    const rows = await registryRows();
    expect(rows.some((r: any) => r.token_color === PREPROD_COLOR)).toBe(false);
  } finally {
    await client.query(
      `INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id)
       VALUES ($1, 'NIGHT', 'unshielded', 0, 'midnight-3')`,
      [NIGHT_COLOR],
    );
  }
});

test("sNight's decimals follow NIGHT's, whatever NIGHT's happen to be", async () => {
  await resetRegistry();
  await client.query("UPDATE known_tokens SET decimals = 6 WHERE token_color = $1", [
    NIGHT_COLOR,
  ]);
  try {
    await seedNetworkKnownTokens(client, "preprod");
    const rows = await registryRows();
    expect(rows.find((r: any) => r.name === SHIELDED_NIGHT_NAME).decimals).toBe(6);
  } finally {
    await client.query("UPDATE known_tokens SET decimals = 0 WHERE token_color = $1", [
      NIGHT_COLOR,
    ]);
    await resetRegistry();
  }
});

// ── pricing ────────────────────────────────────────────────────────────────

test("SNIGHT prices as NIGHT through the NAME map, even with no asset_id", () => {
  expect(resolveAssetId({ name: "SNIGHT", decimals: 0 })).toEqual({
    assetId: "midnight-3",
    decimals: 0,
  });
  // The registry stores the name upper-cased; the map is compared upper-cased,
  // so the branded spelling resolves too.
  expect(resolveAssetId({ name: "sNight", decimals: 0 })).toEqual({
    assetId: "midnight-3",
    decimals: 0,
  });
});
