// The offer poster's durable coin → offers record (spec FR-008, FR-009, US2).
//
// One JSON file on the poster's own volume, keyed by the coin NONCE, holding
// every coin the poster minted and every offer it built from that coin. It is
// what turns "killed between mint and post" from a leaked coin into a deferred
// re-offer, and what makes "which ZSwap was built from which coin" answerable
// after the fact.
//
// Three properties this module exists to guarantee:
//
//   1. **Nothing is silently lost.** A file that does not parse, or that parses
//      into something that is not this schema, is MOVED ASIDE (never
//      overwritten) and the open is REFUSED unless the operator explicitly asks
//      for a reset. Same for a journal that belongs to a different contract
//      deployment: its coins do not exist on this chain, so adopting it would
//      make every candidate a lie.
//   2. **Every mutation is on disk before the call returns.** The mint intent is
//      journaled BEFORE the mint is submitted; if the process dies between the
//      two, the nonce is still on disk. A buffered write would defeat the whole
//      point, so every op writes synchronously (temp file + fsync + rename), and
//      a crash mid-write leaves either the old file or the new one, never half.
//   3. **`bigint` never reaches JSON.** Coin values and want amounts are u64/u256
//      base units; they are stored as canonical decimal STRINGS and validated as
//      such on load. `JSON.stringify` throws on a bigint, and a value that went
//      through `Number` would be silently wrong above 2^53.
//
// This module is pure: no network, no wallet, no clock beyond `Date.now()`. The
// kernel's status vocabulary enters through `mapKernelStatus` only.
//
// Deliberately NOT here: `setOfferStatus` does not flip the coin's state. FR-009
// says a `consumed` offer closes its coin, but the caller owns that decision
// (`markSpent`) because `cancelled` does NOT imply the coin came back — a
// partial/split settlement is classified `cancelled` by the kernel — so the coin
// state has to follow `availableCoins`, not the status. The safety net is that
// `candidates()` only ever proposes a coin whose latest offer is
// `expired | cancelled | rejected`, so forgetting `markSpent` cannot cause a
// double-offer of a consumed coin.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const JOURNAL_VERSION = 1 as const;

/** Lifecycle of a coin the poster minted. `lost` is operator-visible only: the
 *  poster never re-offers it and never deletes it. */
export const COIN_STATES = ["minted", "offered", "spent", "lost"] as const;
export type CoinState = (typeof COIN_STATES)[number];

/** What the journal may record for an offer. Five of these come from the kernel
 *  (see `mapKernelStatus`); `rejected` is POSTER-LOCAL — it records a post the
 *  kernel refused with a 4xx, which never became an offer and can therefore
 *  never be read back from a status route. */
export const OFFER_STATUSES = [
  "live",
  "consumed",
  "expired",
  "cancelled",
  "rejected",
  "unknown",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** The subset `mapKernelStatus` can return — `rejected` is not reachable from a
 *  kernel read. */
export type KernelOfferStatus = Exclude<OfferStatus, "rejected">;

/** Offer statuses that mean "this offer is over, and the coin MAY be free
 *  again". Never proof on their own: `candidates()` also requires the nonce to
 *  be in the wallet's `availableCoins` (FR-009). */
export const RELEASABLE_STATUSES: readonly OfferStatus[] = ["expired", "cancelled", "rejected"];

/** Offer statuses that still need reconciling against the kernel. */
export const NON_TERMINAL_STATUSES: readonly OfferStatus[] = ["live", "unknown"];

/** The `GET /v1/quote` fields worth keeping per offer (spec FR-005). All
 *  optional: a poster that quoted against a node without the price service, or
 *  a forced `WANT_AMOUNT`, may not have all of them. */
export interface QuoteSnapshot {
  /** `market_rate` — `to` units per 1 `from`, approximate double. */
  marketRate?: number;
  /** `sponsor_discount` — the threshold as a fraction (SPONSOR_DISCOUNT_BPS/10000). */
  sponsorDiscount?: number;
  /** `from_source` — `feed | seed | fixed | manual | fallback | demo-fallback`. */
  fromSource?: string;
  /** `to_source` — same domain. */
  toSource?: string;
  /** `prices_updated_at` — the OLDER leg's timestamp; `null` when either leg is
   *  a demo fallback. */
  pricesUpdatedAt?: string | null;
  /** The quote's own `sponsored` verdict at post time. */
  sponsored?: boolean;
}

export interface JournalOffer {
  /** The kernel's offer id = sha256 of the raw offer bytes, 64 lowercase hex. */
  offerId: string;
  /** sha256 of the posted bech32m blob, for tracing a blob back to its coin. */
  blobSha256: string;
  postedAt: string;
  ttlSec: number;
  wantColour: string;
  /** Base units, canonical decimal string. */
  wantAmount: string;
  quote: QuoteSnapshot;
  status: OfferStatus;
  statusAt: string;
}

export interface JournalCoin {
  /** Token colour (`RawTokenType`, 64 hex). */
  type: string;
  /** Base units, canonical decimal string. */
  value: string;
  /** `coinNullifier(coin, coinSecretKey)`, once known. */
  nullifier?: string;
  /** Mint transaction hash, once submitted. */
  mintTx?: string;
  mintedAt: string;
  state: CoinState;
  /** Only set alongside `state: "lost"`. */
  lostReason?: string;
  offers: JournalOffer[];
}

export interface JournalData {
  version: typeof JOURNAL_VERSION;
  contractAddress: string;
  giveColour: string;
  createdAt: string;
  updatedAt: string;
  /** Keyed by coin nonce (lowercased). */
  coins: Record<string, JournalCoin>;
}

/** A coin plus its key, as handed to callers. Always a deep copy — mutating it
 *  does not touch the journal. */
export interface CoinRecord extends JournalCoin {
  nonce: string;
}

export interface OfferRecord {
  nonce: string;
  offer: JournalOffer;
}

export type JournalErrorCode =
  /** The file exists but is not parseable, or not this schema. Moved aside. */
  | "CORRUPT"
  /** The file is a valid journal for a DIFFERENT contract deployment. */
  | "CONTRACT_MISMATCH"
  /** The file is a valid journal for a different give colour. */
  | "GIVE_COLOUR_MISMATCH"
  | "UNKNOWN_COIN"
  | "UNKNOWN_OFFER"
  | "DUPLICATE_COIN"
  | "DUPLICATE_OFFER"
  | "INVALID_ARGUMENT";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  /** Where the offending file was moved, when it was moved. */
  readonly movedAside?: string;
  readonly file?: string;

  constructor(
    code: JournalErrorCode,
    message: string,
    opts?: { movedAside?: string; file?: string; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "JournalError";
    this.code = code;
    if (opts?.movedAside !== undefined) this.movedAside = opts.movedAside;
    if (opts?.file !== undefined) this.file = opts.file;
  }
}

// ── kernel status vocabulary ────────────────────────────────────────────────
//
// The kernel emits EXACTLY five strings and `rejected` is not one of them
// (P0 note 1):
//
//   GET  /v1/offers/:hash/status  → live | consumed | cancelled | expired | not_found
//   POST /v1/offers/status        → the same five
//   GET  /v1/offers/:hash         → computed.status, the first four (404 otherwise)
//
// `GET /v1/offers/:hash/status` returns `rows[0]?.status ?? "not_found"` — the
// RAW database value, without the whitelist the blob route applies — so this
// mapping is deliberately defensive: anything unrecognised is `unknown`, never
// an exception and never a silent "expired".

const KERNEL_STATUS_MAP: Readonly<Record<string, KernelOfferStatus>> = Object.freeze({
  live: "live",
  consumed: "consumed",
  cancelled: "cancelled",
  expired: "expired",
  not_found: "unknown",
});

/** Map one kernel status string onto the journal's vocabulary.
 *
 *  `not_found` → `unknown` (reachable in normal operation: an archived row
 *  pruned, or a post that never indexed), and so is every unrecognised value,
 *  every non-string, `null` and `undefined`. `unknown` is NOT terminal — it
 *  stays in `nonTerminalOffers()` and never makes its coin a candidate on its
 *  own. */
export function mapKernelStatus(raw: unknown): KernelOfferStatus {
  if (typeof raw !== "string") return "unknown";
  return KERNEL_STATUS_MAP[raw.trim().toLowerCase()] ?? "unknown";
}

// ── helpers ─────────────────────────────────────────────────────────────────

const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;

const nowIso = (): string => new Date().toISOString();

/** Nonces are `Nonce = string` hex from the ledger; lowercase them everywhere so
 *  a case difference between the mint result and `availableCoins` can never
 *  silently hide a coin. */
function normaliseNonce(nonce: string): string {
  if (typeof nonce !== "string" || nonce.trim() === "") {
    throw new JournalError("INVALID_ARGUMENT", "coin nonce must be a non-empty string");
  }
  return nonce.trim().toLowerCase();
}

/** Base-unit amounts are u64/u256; they live in JSON as canonical decimal
 *  strings, never as numbers and never as bigints. */
function amountToString(value: bigint | string, what: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) throw new JournalError("INVALID_ARGUMENT", `${what} must not be negative`);
    return value.toString();
  }
  if (typeof value === "string" && CANONICAL_UINT.test(value)) return value;
  throw new JournalError(
    "INVALID_ARGUMENT",
    `${what} must be a bigint or a canonical decimal string, got ${JSON.stringify(value)}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A filesystem-safe stamp. An ISO string contains `:`, which is legal on POSIX
 *  but a trap on SMB/Windows-backed volumes, so the colons become dashes. */
function fileStamp(): string {
  return new Date().toISOString().replace(/:/g, "-");
}

/** Move `file` to `<file>.<suffix>-<stamp>`, never overwriting: a collision (two
 *  moves in the same millisecond) gets a counter. Returns the new path. */
function moveAside(file: string, suffix: string): string {
  const base = `${file}.${suffix}-${fileStamp()}`;
  let target = base;
  for (let n = 1; existsSync(target); n++) target = `${base}-${n}`;
  renameSync(file, target);
  return target;
}

/** Write atomically: temp file → fsync → rename. `rename(2)` within a directory
 *  is atomic, so a reader sees the whole old file or the whole new one; the
 *  fsync is what makes the new bytes survive a power loss, not just a crash. The
 *  temp file is removed on any failure, so no `.tmp` is ever left behind. */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed; the close error would mask it */
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort — the throw below is the news */
    }
    throw err;
  }
}

// ── load-time validation ────────────────────────────────────────────────────
//
// Structure is checked BEFORE identity, deliberately: a journal that is valid
// but belongs to another deployment must produce CONTRACT_MISMATCH (file left
// intact), not CORRUPT (file moved aside).

function validationFailure(data: unknown): string | null {
  if (!isPlainObject(data)) return "top level is not an object";
  if (data["version"] !== JOURNAL_VERSION) {
    return `unsupported version ${JSON.stringify(data["version"])} (expected ${JOURNAL_VERSION})`;
  }
  for (const key of ["contractAddress", "giveColour", "createdAt", "updatedAt"]) {
    if (typeof data[key] !== "string" || data[key] === "") return `"${key}" must be a non-empty string`;
  }
  const coins = data["coins"];
  if (!isPlainObject(coins)) return '"coins" must be an object';
  for (const [nonce, raw] of Object.entries(coins)) {
    const where = `coin ${nonce}`;
    if (nonce === "") return "a coin key is empty";
    if (!isPlainObject(raw)) return `${where} is not an object`;
    if (typeof raw["type"] !== "string" || raw["type"] === "") return `${where}: "type" must be a non-empty string`;
    if (typeof raw["value"] !== "string" || !CANONICAL_UINT.test(raw["value"])) {
      return `${where}: "value" must be a canonical decimal string`;
    }
    if (typeof raw["mintedAt"] !== "string") return `${where}: "mintedAt" must be a string`;
    if (!(COIN_STATES as readonly string[]).includes(raw["state"] as string)) {
      return `${where}: unknown state ${JSON.stringify(raw["state"])}`;
    }
    for (const key of ["nullifier", "mintTx", "lostReason"]) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") return `${where}: "${key}" must be a string`;
    }
    const offers = raw["offers"];
    if (!Array.isArray(offers)) return `${where}: "offers" must be an array`;
    for (const [index, offer] of offers.entries()) {
      const at = `${where} offer[${index}]`;
      if (!isPlainObject(offer)) return `${at} is not an object`;
      for (const key of ["offerId", "blobSha256", "postedAt", "wantColour", "statusAt"]) {
        if (typeof offer[key] !== "string") return `${at}: "${key}" must be a string`;
      }
      if (typeof offer["wantAmount"] !== "string" || !CANONICAL_UINT.test(offer["wantAmount"])) {
        return `${at}: "wantAmount" must be a canonical decimal string`;
      }
      if (typeof offer["ttlSec"] !== "number" || !Number.isFinite(offer["ttlSec"])) {
        return `${at}: "ttlSec" must be a number`;
      }
      if (!(OFFER_STATUSES as readonly string[]).includes(offer["status"] as string)) {
        return `${at}: unknown status ${JSON.stringify(offer["status"])}`;
      }
      if (!isPlainObject(offer["quote"])) return `${at}: "quote" must be an object`;
    }
  }
  return null;
}

export interface JournalSummary {
  version: number;
  contractAddress: string;
  giveColour: string;
  createdAt: string;
  updatedAt: string;
  coins: Record<CoinState, number> & { total: number };
  offers: Record<OfferStatus, number> & { total: number };
  /** Most recently posted offer, by `postedAt`, or `null` when none exists. */
  lastOffer:
    | { nonce: string; offerId: string; status: OfferStatus; postedAt: string; statusAt: string }
    | null;
  /** Coins that would be re-offered if their nonce were free — the ceiling on
   *  `candidates()`, before the `availableCoins` gate. */
  releasableCoins: number;
}

export interface OpenJournalOptions {
  /** Absolute path to the journal file (`POSTER_JOURNAL_FILE`). */
  file: string;
  /** The deployed offer-files contract address the coins belong to. */
  contractAddress: string;
  /** The give-leg token colour the poster mints. */
  giveColour: string;
  /** `POSTER_JOURNAL_RESET=true`: move an unusable or foreign journal aside and
   *  start a fresh one instead of refusing to start. */
  reset?: boolean;
}

export interface RecordOfferInput {
  offerId: string;
  blobSha256: string;
  ttlSec: number;
  wantColour: string;
  wantAmount: bigint | string;
  quote?: QuoteSnapshot;
  /** Defaults to `live` — the status a just-posted offer has. Pass `rejected`
   *  to record a post the kernel refused. */
  status?: OfferStatus;
  postedAt?: string;
}

/** The durable coin → offers record. Construct with `openJournal`. */
export class Journal {
  readonly file: string;
  #data: JournalData;

  private constructor(file: string, data: JournalData) {
    this.file = file;
    this.#data = data;
  }

  /** @internal — `openJournal` is the public constructor. */
  static _create(file: string, data: JournalData): Journal {
    return new Journal(file, data);
  }

  get contractAddress(): string {
    return this.#data.contractAddress;
  }

  get giveColour(): string {
    return this.#data.giveColour;
  }

  /** Deep copy of the whole journal — safe to serialise or hand to `GET /journal`. */
  toJSON(): JournalData {
    return structuredClone(this.#data);
  }

  /** One coin by nonce, or `undefined`. Deep copy. */
  getCoin(nonce: string): CoinRecord | undefined {
    const key = normaliseNonce(nonce);
    const coin = this.#data.coins[key];
    return coin === undefined ? undefined : { nonce: key, ...structuredClone(coin) };
  }

  /** Every coin, deep-copied, in insertion order. */
  coins(): CoinRecord[] {
    return Object.entries(this.#data.coins).map(([nonce, coin]) => ({
      nonce,
      ...structuredClone(coin),
    }));
  }

  // ── mutations (each persists before returning) ────────────────────────────

  /** Journal a coin BEFORE its mint is submitted (FR-003). If the process dies
   *  between this call and the mint landing, the nonce survives and
   *  reconciliation can find the orphan. */
  recordMintIntent(nonce: string, type: string, value: bigint | string): CoinRecord {
    const key = normaliseNonce(nonce);
    if (this.#data.coins[key] !== undefined) {
      throw new JournalError("DUPLICATE_COIN", `coin ${key} is already journaled`);
    }
    if (typeof type !== "string" || type === "") {
      throw new JournalError("INVALID_ARGUMENT", "coin type must be a non-empty string");
    }
    const coin: JournalCoin = {
      type: type.toLowerCase(),
      value: amountToString(value, "coin value"),
      mintedAt: nowIso(),
      state: "minted",
      offers: [],
    };
    this.#data.coins[key] = coin;
    this.#persist();
    return { nonce: key, ...structuredClone(coin) };
  }

  /** Attach the mint's outcome: transaction hash and the coin's nullifier. The
   *  state stays `minted` — the coin is not offered yet. */
  recordMinted(nonce: string, result: { txHash?: string; nullifier?: string }): CoinRecord {
    const key = normaliseNonce(nonce);
    const coin = this.#requireCoin(key);
    if (result.txHash !== undefined) coin.mintTx = result.txHash;
    if (result.nullifier !== undefined) coin.nullifier = result.nullifier.toLowerCase();
    this.#persist();
    return { nonce: key, ...structuredClone(coin) };
  }

  /** Append an offer built from this coin and move the coin to `offered`. */
  recordOffer(nonce: string, input: RecordOfferInput): JournalOffer {
    const key = normaliseNonce(nonce);
    const coin = this.#requireCoin(key);
    const offerId = String(input.offerId ?? "").toLowerCase();
    if (offerId === "") {
      throw new JournalError("INVALID_ARGUMENT", "offerId must be a non-empty string");
    }
    if (coin.offers.some((o) => o.offerId === offerId)) {
      throw new JournalError("DUPLICATE_OFFER", `offer ${offerId} is already recorded on coin ${key}`);
    }
    const at = nowIso();
    const offer: JournalOffer = {
      offerId,
      blobSha256: String(input.blobSha256 ?? "").toLowerCase(),
      postedAt: input.postedAt ?? at,
      ttlSec: input.ttlSec,
      wantColour: String(input.wantColour ?? "").toLowerCase(),
      wantAmount: amountToString(input.wantAmount, "want amount"),
      quote: { ...(input.quote ?? {}) },
      status: input.status ?? "live",
      statusAt: at,
    };
    coin.offers.push(offer);
    // A rejected post never became an offer, so it must not claim the coin: the
    // coin is still exactly as free as it was, and the next tick should re-offer
    // it rather than mint. `candidates()` would allow it either way (rejected is
    // releasable), but leaving the state honest keeps `summary()` readable.
    if (offer.status !== "rejected") coin.state = "offered";
    this.#persist();
    return structuredClone(offer);
  }

  /** Update one offer's status from a reconciliation read. Does not change the
   *  coin's state — see the module header. */
  setOfferStatus(nonce: string, offerId: string, status: OfferStatus): JournalOffer {
    const key = normaliseNonce(nonce);
    const coin = this.#requireCoin(key);
    if (!(OFFER_STATUSES as readonly string[]).includes(status)) {
      throw new JournalError("INVALID_ARGUMENT", `unknown offer status ${JSON.stringify(status)}`);
    }
    const wanted = String(offerId ?? "").toLowerCase();
    const offer = coin.offers.find((o) => o.offerId === wanted);
    if (offer === undefined) {
      throw new JournalError("UNKNOWN_OFFER", `coin ${key} has no offer ${wanted}`);
    }
    offer.status = status;
    offer.statusAt = nowIso();
    this.#persist();
    return structuredClone(offer);
  }

  /** Close a coin: its offer settled, or it was otherwise spent. Terminal. */
  markSpent(nonce: string): CoinRecord {
    const key = normaliseNonce(nonce);
    const coin = this.#requireCoin(key);
    coin.state = "spent";
    this.#persist();
    return { nonce: key, ...structuredClone(coin) };
  }

  /** Give up on a coin without claiming it was spent (e.g. it never became
   *  visible). Terminal for the poster; the record stays for the operator. */
  markLost(nonce: string, reason: string): CoinRecord {
    const key = normaliseNonce(nonce);
    const coin = this.#requireCoin(key);
    coin.state = "lost";
    coin.lostReason = reason;
    this.#persist();
    return { nonce: key, ...structuredClone(coin) };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** Coins that can be re-offered right now (FR-009, FR-010), oldest mint first.
   *
   *  A coin qualifies when its state is `minted` or `offered`, its latest offer
   *  is absent or `expired | cancelled | rejected`, AND its nonce is in
   *  `availableNonces` — the wallet's `availableCoins`, which is the only proof
   *  the SDK has released it. `live` and `unknown` never qualify: a `live` offer
   *  still claims the coin, and `unknown` means we do not know. */
  candidates(availableNonces: Iterable<string>): CoinRecord[] {
    const available = new Set<string>();
    for (const nonce of availableNonces) {
      if (typeof nonce === "string" && nonce.trim() !== "") available.add(nonce.trim().toLowerCase());
    }
    const out: CoinRecord[] = [];
    for (const [nonce, coin] of Object.entries(this.#data.coins)) {
      if (coin.state !== "minted" && coin.state !== "offered") continue;
      if (!available.has(nonce)) continue;
      const latest = coin.offers[coin.offers.length - 1];
      if (latest !== undefined && !RELEASABLE_STATUSES.includes(latest.status)) continue;
      out.push({ nonce, ...structuredClone(coin) });
    }
    // Oldest mint first, so a coin does not starve behind newer ones. `mintedAt`
    // is an ISO string, which sorts lexicographically in time order; the nonce
    // breaks ties so the order is total and stable.
    out.sort((a, b) =>
      a.mintedAt === b.mintedAt ? (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0)
      : a.mintedAt < b.mintedAt ? -1
      : 1,
    );
    return out;
  }

  /** Offers whose status still has to be refreshed against the kernel: `live`
   *  and `unknown`, on coins that are not already closed. */
  nonTerminalOffers(): OfferRecord[] {
    const out: OfferRecord[] = [];
    for (const [nonce, coin] of Object.entries(this.#data.coins)) {
      if (coin.state === "spent" || coin.state === "lost") continue;
      for (const offer of coin.offers) {
        if (NON_TERMINAL_STATUSES.includes(offer.status)) out.push({ nonce, offer: structuredClone(offer) });
      }
    }
    return out;
  }

  /** Counts for `/health` and `/journal`. */
  summary(): JournalSummary {
    const coinCounts = { total: 0, minted: 0, offered: 0, spent: 0, lost: 0 };
    const offerCounts = {
      total: 0, live: 0, consumed: 0, expired: 0, cancelled: 0, rejected: 0, unknown: 0,
    };
    let lastOffer: JournalSummary["lastOffer"] = null;
    let releasableCoins = 0;
    for (const [nonce, coin] of Object.entries(this.#data.coins)) {
      coinCounts.total += 1;
      coinCounts[coin.state] += 1;
      const latest = coin.offers[coin.offers.length - 1];
      if (
        (coin.state === "minted" || coin.state === "offered") &&
        (latest === undefined || RELEASABLE_STATUSES.includes(latest.status))
      ) {
        releasableCoins += 1;
      }
      for (const offer of coin.offers) {
        offerCounts.total += 1;
        offerCounts[offer.status] += 1;
        if (lastOffer === null || offer.postedAt >= lastOffer.postedAt) {
          lastOffer = {
            nonce,
            offerId: offer.offerId,
            status: offer.status,
            postedAt: offer.postedAt,
            statusAt: offer.statusAt,
          };
        }
      }
    }
    return {
      version: this.#data.version,
      contractAddress: this.#data.contractAddress,
      giveColour: this.#data.giveColour,
      createdAt: this.#data.createdAt,
      updatedAt: this.#data.updatedAt,
      coins: coinCounts,
      offers: offerCounts,
      lastOffer,
      releasableCoins,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #requireCoin(key: string): JournalCoin {
    const coin = this.#data.coins[key];
    if (coin === undefined) {
      throw new JournalError("UNKNOWN_COIN", `no journaled coin with nonce ${key}`);
    }
    return coin;
  }

  #persist(): void {
    this.#data.updatedAt = nowIso();
    writeAtomic(this.file, `${JSON.stringify(this.#data, null, 2)}\n`);
  }

  /** Force a write without a logical change — used by `openJournal` to put a
   *  freshly created journal on disk before the first tick runs. */
  flush(): void {
    this.#persist();
  }
}

function freshData(contractAddress: string, giveColour: string): JournalData {
  const at = nowIso();
  return {
    version: JOURNAL_VERSION,
    contractAddress,
    giveColour,
    createdAt: at,
    updatedAt: at,
    coins: {},
  };
}

/** Open (or create) the poster's journal.
 *
 *  - missing file        → a fresh journal, written to disk immediately
 *  - unparseable/invalid → moved to `<file>.corrupt-<stamp>`, then `CORRUPT`
 *                          unless `reset`, in which case a fresh journal
 *  - other contract      → `CONTRACT_MISMATCH` with the file left untouched,
 *                          unless `reset`, which moves it to
 *                          `<file>.superseded-<stamp>` and starts fresh
 *  - other give colour   → `GIVE_COLOUR_MISMATCH`, same treatment
 *
 *  Nothing is ever overwritten in place, which is the point: silently losing the
 *  record would defeat the journal (US2 scenario 5). */
export function openJournal(opts: OpenJournalOptions): Journal {
  const { file, reset = false } = opts;
  if (typeof file !== "string" || file === "") {
    throw new JournalError("INVALID_ARGUMENT", "journal file path is required");
  }
  const contractAddress = String(opts.contractAddress ?? "").trim().toLowerCase();
  const giveColour = String(opts.giveColour ?? "").trim().toLowerCase();
  if (contractAddress === "") {
    throw new JournalError("INVALID_ARGUMENT", "contractAddress is required");
  }
  if (giveColour === "") {
    throw new JournalError("INVALID_ARGUMENT", "giveColour is required");
  }

  mkdirSync(dirname(file), { recursive: true });

  if (!existsSync(file)) {
    const journal = Journal._create(file, freshData(contractAddress, giveColour));
    journal.flush();
    return journal;
  }

  let parsed: unknown;
  let problem: string | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    problem = `not valid JSON: ${(err as Error).message}`;
  }
  if (problem === null) problem = validationFailure(parsed);

  if (problem !== null) {
    const movedAside = moveAside(file, "corrupt");
    if (!reset) {
      throw new JournalError(
        "CORRUPT",
        `journal ${file} is unusable (${problem}); moved to ${movedAside}. ` +
          "Set POSTER_JOURNAL_RESET=true to start a new journal, or restore the file.",
        { movedAside, file },
      );
    }
    const journal = Journal._create(file, freshData(contractAddress, giveColour));
    journal.flush();
    return journal;
  }

  const data = parsed as JournalData;
  const mismatch =
    data.contractAddress.toLowerCase() !== contractAddress
      ? ({
          code: "CONTRACT_MISMATCH" as const,
          detail: `journal belongs to contract ${data.contractAddress}, this poster is on ${contractAddress}`,
        })
      : data.giveColour.toLowerCase() !== giveColour
        ? ({
            code: "GIVE_COLOUR_MISMATCH" as const,
            detail: `journal records give colour ${data.giveColour}, this poster gives ${giveColour}`,
          })
        : null;

  if (mismatch !== null) {
    if (!reset) {
      // NOT moved aside: the file is a perfectly good journal, just not for this
      // deployment. Moving it would punish an operator who pointed the poster at
      // the wrong contract address by mangling the record of the right one.
      throw new JournalError(
        mismatch.code,
        `${mismatch.detail}. Coins from another deployment do not exist here; ` +
          "point POSTER_JOURNAL_FILE elsewhere or set POSTER_JOURNAL_RESET=true.",
        { file },
      );
    }
    moveAside(file, "superseded");
    const journal = Journal._create(file, freshData(contractAddress, giveColour));
    journal.flush();
    return journal;
  }

  // Adopt the identity spellings the caller gave (both are already lowercased).
  data.contractAddress = contractAddress;
  data.giveColour = giveColour;
  return Journal._create(file, data);
}
