// Unit tests for the poster's journal. Pure: a temp directory, no network, no
// wallet. What is being pinned down here is the behaviour the service depends on
// when it restarts into a mess — a half-written file, a journal from another
// deployment, a coin the wallet has not released — because those paths are the
// ones a live run exercises exactly once, badly, at 3am.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JOURNAL_VERSION,
  Journal,
  JournalError,
  mapKernelStatus,
  openJournal,
  type JournalData,
  type OfferStatus,
} from "./poster-journal.ts";

// Preprod's real vectors (plan finding 1), so the fixtures look like the thing.
const CONTRACT = "6fc44c272d866574cefc14e25474fdfa144e6427f299a8222a8ad8a7b374bb7c";
const OTHER_CONTRACT = "1111111111111111111111111111111111111111111111111111111111111111";
const GIVE = "e7580bfcf04c05cbec44572d122f526ba35d5b6442fa6429e42e9b9fca22a912";
const WANT = "fda14e2e04b8389ab82891c761e1d36501a4c79baa7b87b30fbbdc4814c5a0a5";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poster-journal-"));
  file = join(dir, "journal.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = (opts: { reset?: boolean; contractAddress?: string; giveColour?: string } = {}) =>
  openJournal({
    file,
    contractAddress: opts.contractAddress ?? CONTRACT,
    giveColour: opts.giveColour ?? GIVE,
    ...(opts.reset === undefined ? {} : { reset: opts.reset }),
  });

const offerInput = (offerId: string, over: Partial<Parameters<Journal["recordOffer"]>[1]> = {}) => ({
  offerId,
  blobSha256: `b${offerId.slice(1)}`,
  ttlSec: 3600,
  wantColour: WANT,
  wantAmount: 31500n,
  quote: {
    marketRate: 32.33,
    sponsorDiscount: 0.025,
    fromSource: "seed",
    toSource: "seed",
    pricesUpdatedAt: "2026-09-03T00:00:00.000Z",
    sponsored: true,
  },
  ...over,
});

/** Rewrite `mintedAt` on disk so ordering tests do not race the millisecond
 *  clock, then reopen. Also exercises the load path on a hand-edited file. */
function withMintedAt(times: Record<string, string>): Journal {
  const data = JSON.parse(readFileSync(file, "utf8")) as JournalData;
  for (const [nonce, at] of Object.entries(times)) data.coins[nonce]!.mintedAt = at;
  writeFileSync(file, JSON.stringify(data, null, 2));
  return open();
}

describe("openJournal — creation", () => {
  test("a missing file becomes a fresh journal, on disk immediately", () => {
    const journal = open();
    expect(existsSync(file)).toBe(true);
    const data = journal.toJSON();
    expect(data.version).toBe(JOURNAL_VERSION);
    expect(data.contractAddress).toBe(CONTRACT);
    expect(data.giveColour).toBe(GIVE);
    expect(data.coins).toEqual({});
    // The file on disk is the same journal, not an empty placeholder.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(data);
  });

  test("creates the parent directory (the compose volume may be empty)", () => {
    file = join(dir, "nested", "deeper", "journal.json");
    open();
    expect(existsSync(file)).toBe(true);
  });

  test("identity is lower-cased and trimmed", () => {
    const journal = openJournal({
      file,
      contractAddress: `  ${CONTRACT.toUpperCase()} `,
      giveColour: GIVE.toUpperCase(),
    });
    expect(journal.contractAddress).toBe(CONTRACT);
    expect(journal.giveColour).toBe(GIVE);
  });

  test("refuses an empty path, contract or colour", () => {
    expect(() => openJournal({ file: "", contractAddress: CONTRACT, giveColour: GIVE })).toThrow(JournalError);
    expect(() => openJournal({ file, contractAddress: "", giveColour: GIVE })).toThrow(/contractAddress/);
    expect(() => openJournal({ file, contractAddress: CONTRACT, giveColour: "" })).toThrow(/giveColour/);
  });
});

describe("openJournal — round trip", () => {
  test("everything written survives a reopen", () => {
    const first = open();
    first.recordMintIntent("AB01", GIVE, 1000n);
    first.recordMinted("ab01", { txHash: "deadbeef", nullifier: "NULL01" });
    first.recordOffer("ab01", offerInput("aaaa"));
    first.setOfferStatus("ab01", "aaaa", "expired");
    first.recordOffer("ab01", offerInput("bbbb"));

    const second = open();
    const coin = second.getCoin("ab01");
    expect(coin).toBeDefined();
    expect(coin!.type).toBe(GIVE);
    expect(coin!.value).toBe("1000");
    expect(coin!.mintTx).toBe("deadbeef");
    expect(coin!.nullifier).toBe("null01"); // normalised
    expect(coin!.state).toBe("offered");
    expect(coin!.offers.map((o) => [o.offerId, o.status])).toEqual([
      ["aaaa", "expired"],
      ["bbbb", "live"],
    ]);
    expect(coin!.offers[0]!.quote.sponsorDiscount).toBe(0.025);
    expect(coin!.offers[1]!.wantAmount).toBe("31500");
  });

  test("bigints are stored as canonical decimal strings, not numbers", () => {
    const journal = open();
    const huge = 18446744073709551615n; // u64 max — 2^53 is long gone
    journal.recordMintIntent("n1", GIVE, huge);
    journal.recordOffer("n1", offerInput("o1", { wantAmount: huge - 1n }));

    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain('"value": "18446744073709551615"');
    expect(onDisk).toContain('"wantAmount": "18446744073709551614"');

    const coin = open().getCoin("n1")!;
    expect(BigInt(coin.value)).toBe(huge);
    expect(BigInt(coin.offers[0]!.wantAmount)).toBe(huge - 1n);
  });

  test("nonces are case-normalised on write and on read", () => {
    const journal = open();
    journal.recordMintIntent("DEADBEEF", GIVE, 1n);
    expect(journal.getCoin("deadbeef")).toBeDefined();
    expect(journal.getCoin("DeAdBeEf")).toBeDefined();
    expect(Object.keys(journal.toJSON().coins)).toEqual(["deadbeef"]);
  });

  test("returned records are copies — mutating one cannot corrupt the journal", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 5n);
    const coin = journal.getCoin("n1")!;
    coin.state = "spent";
    (coin.offers as unknown[]).push({});
    expect(journal.getCoin("n1")!.state).toBe("minted");
    expect(journal.getCoin("n1")!.offers).toHaveLength(0);
  });

  test("no .tmp file is left behind by any mutation", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1n);
    journal.recordMinted("n1", { txHash: "tx", nullifier: "nf" });
    journal.recordOffer("n1", offerInput("o1"));
    journal.setOfferStatus("n1", "o1", "consumed");
    journal.markSpent("n1");
    expect(readdirSync(dir)).toEqual(["journal.json"]);
  });

  test("a mutation is on disk BEFORE the call returns (mint intent survives a kill)", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1000n);
    // No flush, no close: read the file straight back.
    const raw = JSON.parse(readFileSync(file, "utf8")) as JournalData;
    expect(raw.coins["n1"]!.state).toBe("minted");
    expect(raw.coins["n1"]!.value).toBe("1000");
  });
});

describe("openJournal — refusals", () => {
  test("unparseable file is moved aside and the open is refused", () => {
    writeFileSync(file, "{ not json");
    let err: JournalError | undefined;
    try {
      open();
    } catch (e) {
      err = e as JournalError;
    }
    expect(err).toBeInstanceOf(JournalError);
    expect(err!.code).toBe("CORRUPT");
    expect(err!.movedAside).toBeDefined();
    expect(readFileSync(err!.movedAside!, "utf8")).toBe("{ not json");
    expect(existsSync(file)).toBe(false);
    expect(err!.message).toContain("POSTER_JOURNAL_RESET");
  });

  test("valid JSON that is not this schema is corrupt too", () => {
    for (const body of [
      "[]",
      '{"version":2,"contractAddress":"a","giveColour":"b","createdAt":"c","updatedAt":"d","coins":{}}',
      `{"version":1,"contractAddress":"${CONTRACT}","giveColour":"${GIVE}","createdAt":"c","updatedAt":"d","coins":{"n":{"type":"${GIVE}","value":"1","mintedAt":"x","state":"melted","offers":[]}}}`,
      `{"version":1,"contractAddress":"${CONTRACT}","giveColour":"${GIVE}","createdAt":"c","updatedAt":"d","coins":{"n":{"type":"${GIVE}","value":"01","mintedAt":"x","state":"minted","offers":[]}}}`,
      `{"version":1,"contractAddress":"${CONTRACT}","giveColour":"${GIVE}","createdAt":"c","updatedAt":"d","coins":{"n":{"type":"${GIVE}","value":"1","mintedAt":"x","state":"minted","offers":[{"offerId":"o","blobSha256":"b","postedAt":"p","ttlSec":1,"wantColour":"w","wantAmount":"1","quote":{},"status":"nope","statusAt":"s"}]}}}`,
    ]) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "poster-journal-"));
      file = join(dir, "journal.json");
      writeFileSync(file, body);
      expect(() => open()).toThrow(JournalError);
    }
  });

  test("reset accepts a corrupt file: fresh journal, original preserved", () => {
    writeFileSync(file, "garbage");
    const journal = open({ reset: true });
    expect(journal.toJSON().coins).toEqual({});
    const asideNames = readdirSync(dir).filter((n) => n.includes(".corrupt-"));
    expect(asideNames).toHaveLength(1);
    expect(readFileSync(join(dir, asideNames[0]!), "utf8")).toBe("garbage");
  });

  test("a journal from another contract is refused and left untouched", () => {
    openJournal({ file, contractAddress: OTHER_CONTRACT, giveColour: GIVE }).recordMintIntent("n1", GIVE, 1n);
    const before = readFileSync(file, "utf8");

    let err: JournalError | undefined;
    try {
      open();
    } catch (e) {
      err = e as JournalError;
    }
    expect(err!.code).toBe("CONTRACT_MISMATCH");
    expect(err!.movedAside).toBeUndefined();
    // Untouched: not moved, not rewritten, no sibling created.
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["journal.json"]);
  });

  test("a journal for another give colour is refused", () => {
    openJournal({ file, contractAddress: CONTRACT, giveColour: WANT }).recordMintIntent("n1", WANT, 1n);
    let err: JournalError | undefined;
    try {
      open();
    } catch (e) {
      err = e as JournalError;
    }
    expect(err!.code).toBe("GIVE_COLOUR_MISMATCH");
    expect(existsSync(file)).toBe(true);
  });

  test("reset on a mismatch moves the old journal aside as superseded", () => {
    openJournal({ file, contractAddress: OTHER_CONTRACT, giveColour: GIVE }).recordMintIntent("n1", GIVE, 1n);
    const before = readFileSync(file, "utf8");

    const journal = open({ reset: true });
    expect(journal.contractAddress).toBe(CONTRACT);
    expect(journal.toJSON().coins).toEqual({});
    const aside = readdirSync(dir).filter((n) => n.includes(".superseded-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(before);
  });
});

describe("mutations — argument errors", () => {
  test("a duplicate nonce is refused (a reused mint nonce is a bug)", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1n);
    expect(() => journal.recordMintIntent("N1", GIVE, 2n)).toThrow(/already journaled/);
  });

  test("unknown coin and unknown offer are typed errors", () => {
    const journal = open();
    expect(() => journal.recordMinted("nope", { txHash: "t" })).toThrow(JournalError);
    expect(() => journal.recordOffer("nope", offerInput("o1"))).toThrow(/no journaled coin/);
    journal.recordMintIntent("n1", GIVE, 1n);
    expect(() => journal.setOfferStatus("n1", "missing", "expired")).toThrow(/has no offer/);
    expect(() => journal.markSpent("nope")).toThrow(JournalError);
  });

  test("the same offerId cannot be recorded twice on one coin", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1n);
    journal.recordOffer("n1", offerInput("o1"));
    expect(() => journal.recordOffer("n1", offerInput("o1"))).toThrow(/already recorded/);
  });

  test("negative or non-canonical amounts are refused", () => {
    const journal = open();
    expect(() => journal.recordMintIntent("n1", GIVE, -1n)).toThrow(/negative/);
    expect(() => journal.recordMintIntent("n2", GIVE, "007")).toThrow(/canonical/);
    expect(() => journal.recordMintIntent("n3", "", 1n)).toThrow(/type/);
  });

  test("an unknown status string is refused", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1n);
    journal.recordOffer("n1", offerInput("o1"));
    expect(() => journal.setOfferStatus("n1", "o1", "settled" as OfferStatus)).toThrow(/unknown offer status/);
  });

  test("a rejected post does not claim the coin", () => {
    const journal = open();
    journal.recordMintIntent("n1", GIVE, 1n);
    journal.recordOffer("n1", offerInput("o1", { status: "rejected" }));
    expect(journal.getCoin("n1")!.state).toBe("minted");
  });
});

describe("candidates", () => {
  /** One coin per case, then a single `candidates()` call over all of them. */
  function seed(): Journal {
    const j = open();
    const mk = (nonce: string, status?: OfferStatus) => {
      j.recordMintIntent(nonce, GIVE, 1000n);
      j.recordMinted(nonce, { txHash: `tx-${nonce}`, nullifier: `nf-${nonce}` });
      if (status !== undefined) j.recordOffer(nonce, offerInput(`o-${nonce}`, { status }));
    };
    mk("c1"); // minted, never offered
    mk("c2", "live");
    mk("c3", "expired");
    mk("c4", "expired"); // nonce withheld from availableCoins
    mk("c5", "consumed");
    mk("c6", "expired");
    j.markSpent("c6");
    mk("c7", "unknown");
    mk("c8", "rejected");
    mk("c9", "cancelled");
    mk("c10", "expired");
    j.markLost("c10", "never became visible");
    return j;
  }

  const AVAILABLE = ["c1", "c2", "c3", "c5", "c6", "c7", "c8", "c9", "c10"]; // c4 withheld

  test("only provably-free, non-terminal coins qualify", () => {
    const nonces = seed().candidates(AVAILABLE).map((c) => c.nonce);
    expect(nonces.sort()).toEqual(["c1", "c3", "c8", "c9"]);
  });

  test("a live offer still claims its coin", () => {
    expect(seed().candidates(["c2"])).toHaveLength(0);
  });

  test("an expired offer whose coin the wallet has NOT released is excluded", () => {
    // c3 and c4 are identical — both hold one expired offer — and differ only
    // in whether the wallet handed the nonce back. Only c3 qualifies. That is
    // FR-009's whole point: the status is a hint, availableCoins is the proof
    // (a "cancelled"/"expired" offer may have spent the coin via a split fill).
    const j = seed();
    expect(j.candidates(AVAILABLE).map((c) => c.nonce)).not.toContain("c4");
    expect(j.candidates(["c3"]).map((c) => c.nonce)).toEqual(["c3"]);
    expect(j.candidates([])).toHaveLength(0);
  });

  test("consumed, spent and lost coins are never candidates", () => {
    expect(seed().candidates(["c5", "c6", "c10"])).toHaveLength(0);
  });

  test("an unknown status is not a release", () => {
    // `not_found` maps to unknown, and unknown must not on its own re-offer a
    // coin that may still be live somewhere.
    expect(seed().candidates(["c7"])).toHaveLength(0);
  });

  test("a minted coin with no offer is a candidate (the crash-between-mint-and-post orphan)", () => {
    expect(seed().candidates(["c1"]).map((c) => c.nonce)).toEqual(["c1"]);
  });

  test("candidates come back oldest mint first, ties broken by nonce", () => {
    const j = open();
    for (const n of ["c1", "c2", "c3"]) j.recordMintIntent(n, GIVE, 1n);
    j.recordMintIntent("c0", GIVE, 1n);
    const reopened = withMintedAt({
      c1: "2026-09-03T10:00:02.000Z",
      c2: "2026-09-03T10:00:01.000Z",
      c3: "2026-09-03T10:00:00.000Z",
      c0: "2026-09-03T10:00:00.000Z", // ties with c3 → nonce order
    });
    expect(reopened.candidates(["c1", "c2", "c3", "c0"]).map((c) => c.nonce)).toEqual([
      "c0",
      "c3",
      "c2",
      "c1",
    ]);
  });

  test("availableCoins entries are case- and whitespace-tolerant", () => {
    const j = open();
    j.recordMintIntent("ABCD", GIVE, 1n);
    expect(j.candidates([" AbCd "]).map((c) => c.nonce)).toEqual(["abcd"]);
    expect(j.candidates(new Set(["abcd"])).map((c) => c.nonce)).toEqual(["abcd"]);
  });

  test("only the LATEST offer decides (a re-offered coin is judged on its newest)", () => {
    const j = open();
    j.recordMintIntent("n1", GIVE, 1n);
    j.recordOffer("n1", offerInput("o1", { status: "expired" }));
    j.recordOffer("n1", offerInput("o2"));
    expect(j.candidates(["n1"])).toHaveLength(0); // newest is live
    j.setOfferStatus("n1", "o2", "expired");
    expect(j.candidates(["n1"]).map((c) => c.nonce)).toEqual(["n1"]);
  });
});

describe("nonTerminalOffers", () => {
  test("live and unknown offers on open coins need reconciling; nothing else does", () => {
    const j = open();
    const mk = (nonce: string, status: OfferStatus) => {
      j.recordMintIntent(nonce, GIVE, 1n);
      j.recordOffer(nonce, offerInput(`o-${nonce}`, { status }));
    };
    mk("a", "live");
    mk("b", "unknown");
    mk("c", "consumed");
    mk("d", "expired");
    mk("e", "cancelled");
    mk("f", "rejected");
    mk("g", "live");
    j.markSpent("g"); // closed coin: no point re-reading its offers

    expect(j.nonTerminalOffers().map((r) => r.nonce).sort()).toEqual(["a", "b"]);
    expect(j.nonTerminalOffers()[0]!.offer.offerId).toBe("o-a");
  });
});

describe("summary", () => {
  test("counts coins by state, offers by status, and the newest offer", () => {
    const j = open();
    j.recordMintIntent("n1", GIVE, 1000n);
    j.recordOffer("n1", offerInput("o1", { postedAt: "2026-09-03T10:00:00.000Z" }));
    j.setOfferStatus("n1", "o1", "expired");
    j.recordOffer("n1", offerInput("o2", { postedAt: "2026-09-03T11:00:00.000Z" }));
    j.recordMintIntent("n2", GIVE, 2000n);
    j.recordMintIntent("n3", GIVE, 3000n);
    j.markSpent("n3");

    const s = j.summary();
    expect(s.version).toBe(JOURNAL_VERSION);
    expect(s.contractAddress).toBe(CONTRACT);
    expect(s.coins).toEqual({ total: 3, minted: 1, offered: 1, spent: 1, lost: 0 });
    expect(s.offers).toEqual({
      total: 2, live: 1, consumed: 0, expired: 1, cancelled: 0, rejected: 0, unknown: 0,
    });
    expect(s.lastOffer).toMatchObject({ nonce: "n1", offerId: "o2", status: "live" });
    // n2 is minted-and-free; n1's newest offer is live, n3 is spent.
    expect(s.releasableCoins).toBe(1);
    expect(s.updatedAt >= s.createdAt).toBe(true);
  });

  test("an empty journal summarises without a last offer", () => {
    const s = open().summary();
    expect(s.coins.total).toBe(0);
    expect(s.offers.total).toBe(0);
    expect(s.lastOffer).toBeNull();
  });
});

describe("mapKernelStatus", () => {
  test("the five kernel strings", () => {
    // GET /v1/offers/:hash/status and POST /v1/offers/status emit exactly these.
    expect(mapKernelStatus("live")).toBe("live");
    expect(mapKernelStatus("consumed")).toBe("consumed");
    expect(mapKernelStatus("cancelled")).toBe("cancelled");
    expect(mapKernelStatus("expired")).toBe("expired");
    expect(mapKernelStatus("not_found")).toBe("unknown");
  });

  test("case and whitespace do not change the verdict", () => {
    expect(mapKernelStatus(" LIVE ")).toBe("live");
    expect(mapKernelStatus("Not_Found")).toBe("unknown");
  });

  test("anything unrecognised is unknown, never a throw and never a guess", () => {
    // The :hash route returns the RAW database value with no whitelist, so an
    // unexpected string must degrade, not crash and not be read as terminal.
    for (const raw of ["", "archived", "canceled", "CONSUMED_PARTIAL", "null"]) {
      expect(mapKernelStatus(raw)).toBe("unknown");
    }
    for (const raw of [undefined, null, 42, {}, [], true, Symbol("live")]) {
      expect(mapKernelStatus(raw)).toBe("unknown");
    }
  });

  test("`rejected` is poster-local — it is not a kernel status", () => {
    // A refused post never becomes an offer, so the kernel can never report it;
    // the journal writes it directly instead.
    expect(mapKernelStatus("rejected")).toBe("unknown");
  });
});
