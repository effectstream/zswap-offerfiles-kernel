// Network-SPECIFIC known-token seeds — the half of the registry that
// 000-init.sql cannot own.
//
// WHY THIS FILE EXISTS. 000-init.sql seeds the three tokens whose colour is
// the same on every network (NIGHT, the USDC placeholder, USDM) and it runs
// against an empty database exactly once. sNight is neither: its colour is
// `tokenType(pad(32,"shielded-night:wrapper"), self())`, so it changes with
// the shielded-night contract address, i.e. with the network — and
// `known_tokens.name` is UNIQUE, so preview's and preprod's colours cannot
// both be seeded under the name SNIGHT in one SQL file. On top of that, the
// preprod database already exists; a row added to 000-init.sql would never
// reach it (the runtime applies `migrationTable` by BLOCK HEIGHT — see
// migration-order.ts — so an entry only ever runs while a database syncs
// through block 1, never on a live one).
//
// Hence: the colours live here, keyed by network, and `seedNetworkKnownTokens`
// inserts the running network's row idempotently at node start. A deployed
// kernel picks sNight up at its next restart with no SQL.
//
// DERIVATION. Each colour below is
//
//   rawTokenType(pad32("shielded-night:wrapper"), <contract address>)
//
// from @midnight-ntwrk/ledger-v8 (8.1.0, the version this repo pins), which
// mirrors the contract's `tokenType(pad(32, "shielded-night:wrapper"),
// kernel.self())` — see the shielded-night repo,
// `src/shielded-night.compact:79-98` and `frontend/src/lib/tokens.ts`
// (`deriveWrapperColorHex`). The addresses are the ones committed in that
// repo's `frontend/.env`. network-tokens.test.ts re-derives both colours from
// the addresses, so a contract redeploy is a one-line, testable change here.

/**
 * Registry name for the shielded-night wrapper token.
 *
 * Upper case because the registry is: `POST /v1/known-tokens` upper-cases
 * every name it stores and the seeded names are all upper-case, so a
 * mixed-case `sNight` would be the one row a later POST of the same name
 * could not match. Branding ("Shielded Night" / `sNight`) belongs in the
 * frontend's token table.
 */
export const SHIELDED_NIGHT_NAME = "SNIGHT";

/** `known_tokens.kind` for sNight — a shielded (Zswap) token type. */
export const SHIELDED_NIGHT_KIND = "shielded";

/**
 * sNight is NIGHT in a shielded wrapper, locked 1:1 (1 base unit = 1 Star), so
 * it prices off the same CoinGecko asset as NIGHT. No new asset id, so
 * SEEDED_ASSET_IDS in price-map.ts is unchanged.
 */
export const SHIELDED_NIGHT_ASSET_ID = "midnight-3";

/** The NIGHT colour, whose row supplies the decimals sNight is seeded with. */
export const NIGHT_COLOR = "0".repeat(64);

export interface NetworkTokenEntry {
  /** shielded-night contract address on this network (hex, no 0x). */
  readonly contractAddress: string;
  /** rawTokenType(pad32("shielded-night:wrapper"), contractAddress). */
  readonly color: string;
}

/**
 * sNight per Midnight network id (`midnightNetworkConfig.id`:
 * `undeployed | preview | preprod | mainnet`).
 *
 * `mainnet` is absent on purpose: shielded-night is not deployed there
 * (`MAINNET_ADDRESS` is empty in the shielded-night repo's `frontend/.env`).
 * `undeployed` is absent too — the local docker stack does not deploy the
 * contract, so there is no colour to register. Add a row here (address +
 * re-derived colour) when either is deployed; the test will check the
 * derivation.
 */
export const SHIELDED_NIGHT_BY_NETWORK: ReadonlyMap<string, NetworkTokenEntry> =
  new Map<string, NetworkTokenEntry>([
    [
      "preview",
      {
        contractAddress:
          "80b89b9a4213c61da84f54b2ea02e2809f9c4dedbdafacd04b38d4667bee1396",
        color: "793c29c94f72972bfbd861e8e84e55480ccc8e57a7b74067f35a5672c816f99c",
      },
    ],
    [
      "preprod",
      {
        contractAddress:
          "e354e6725893397e6a2dfa44522a017fabb5d9c92efed50288711f5f865c8950",
        color: "8fac382b0d91ad68cf3e2479bf4d21a127f187b83151a11773a8b04bd4576819",
      },
    ],
  ]);

/** The minimum this module needs of a `pg` Client/Pool. */
export interface QueryableConnection {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * Why an entry was not inserted. `already-registered` is the normal steady
 * state (every restart after the first); the rest deserve an operator's
 * attention, which is why the caller can tell them apart without parsing
 * `reason`.
 */
export type NetworkSeedSkipCode =
  | "already-registered"
  | "name-taken"
  | "missing-night"
  | "race";

export interface NetworkSeedSkip {
  name: string;
  code: NetworkSeedSkipCode;
  reason: string;
}

export interface NetworkSeedResult {
  /** Colours inserted by this call (empty on every run after the first). */
  inserted: string[];
  /** Entries deliberately not inserted, each with a human-readable reason. */
  skipped: NetworkSeedSkip[];
}

/**
 * Register the running network's sNight row in `known_tokens`, idempotently.
 *
 * Decimals are copied from the seeded NIGHT row rather than taken from the
 * contract's 6: the sponsorship gate compares PER BASE UNIT USD values, so a
 * NIGHT ↔ sNight offer is only at par when both rows carry the same decimals.
 * Copying keeps that true after any future correction of NIGHT's own value
 * (which is a separate decision — NIGHT is seeded with 0 today).
 *
 * Never throws for the two expected collisions:
 *   * the colour is already registered → no-op (a restart, or an operator's
 *     own POST /v1/known-tokens);
 *   * the name is held by a different colour → skipped with the reason, so the
 *     caller can log one line instead of the node dying on a UNIQUE violation.
 * The INSERT itself is guarded with NOT EXISTS on BOTH unique columns, so a
 * concurrent writer cannot turn this into a unique violation either.
 *
 * A genuine database failure (missing table, dead connection) still throws —
 * the caller decides whether to retry.
 */
export async function seedNetworkKnownTokens(
  conn: QueryableConnection,
  networkId: string,
): Promise<NetworkSeedResult> {
  const result: NetworkSeedResult = { inserted: [], skipped: [] };
  const entry = SHIELDED_NIGHT_BY_NETWORK.get(networkId);
  if (entry === undefined) return result;

  // One read for everything the decision needs: NIGHT's decimals, whether the
  // colour is already there, and who holds the name.
  const { rows } = await conn.query(
    `SELECT token_color, name, decimals
       FROM known_tokens
      WHERE token_color = $1 OR token_color = $2 OR name = $3`,
    [NIGHT_COLOR, entry.color, SHIELDED_NIGHT_NAME],
  );
  const night = rows.find((r) => r.token_color === NIGHT_COLOR);
  const byColor = rows.find((r) => r.token_color === entry.color);
  const byName = rows.find((r) => r.name === SHIELDED_NIGHT_NAME);

  if (byColor !== undefined) {
    result.skipped.push({
      name: SHIELDED_NIGHT_NAME,
      code: "already-registered",
      reason: `colour ${entry.color} is already registered as ${byColor.name}`,
    });
    return result;
  }
  if (byName !== undefined) {
    result.skipped.push({
      name: SHIELDED_NIGHT_NAME,
      code: "name-taken",
      reason:
        `name ${SHIELDED_NIGHT_NAME} is already held by colour ${byName.token_color}`,
    });
    return result;
  }
  if (night === undefined) {
    result.skipped.push({
      name: SHIELDED_NIGHT_NAME,
      code: "missing-night",
      reason:
        `the NIGHT row (colour ${NIGHT_COLOR}) is missing, so its decimals cannot be copied`,
    });
    return result;
  }

  const inserted = await conn.query(
    `INSERT INTO known_tokens (token_color, name, kind, decimals, asset_id)
     SELECT $1, $2, $3, $4::integer, $5
      WHERE NOT EXISTS (SELECT 1 FROM known_tokens WHERE token_color = $1)
        AND NOT EXISTS (SELECT 1 FROM known_tokens WHERE name = $2)
     RETURNING token_color`,
    [
      entry.color,
      SHIELDED_NIGHT_NAME,
      SHIELDED_NIGHT_KIND,
      night.decimals,
      SHIELDED_NIGHT_ASSET_ID,
    ],
  );
  if (inserted.rows.length > 0) {
    result.inserted.push(entry.color);
  } else {
    // Lost a race with a concurrent writer between the read and the insert.
    result.skipped.push({
      name: SHIELDED_NIGHT_NAME,
      code: "race",
      reason: `colour ${entry.color} or name ${SHIELDED_NIGHT_NAME} was registered concurrently`,
    });
  }
  return result;
}
