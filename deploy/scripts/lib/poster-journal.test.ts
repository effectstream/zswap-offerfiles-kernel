import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOURNAL_VERSION, JournalError, mapKernelStatus, openJournal } from "./poster-journal.ts";

const GIVE = "12".repeat(32);
const WANT = "34".repeat(32);
let dir = "";
let file = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poster-inventory-journal-"));
  file = join(dir, "journal.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (networkId = "preprod", reset = false) =>
  openJournal({ file, networkId, giveColour: GIVE, reset });
const offer = (id: string, status: "live" | "expired" | "rejected" = "live") => ({
  offerId: id,
  blobSha256: `blob-${id}`,
  ttlSec: 3600,
  wantColour: WANT,
  wantAmount: 10n,
  status,
});

describe("prefunded inventory journal", () => {
  test("creates a network/token keyed durable journal", () => {
    const journal = open();
    expect(existsSync(file)).toBe(true);
    expect(journal.toJSON()).toMatchObject({
      version: JOURNAL_VERSION,
      networkId: "preprod",
      giveColour: GIVE,
      coins: {},
    });
  });

  test("records inventory before its offer and survives reopen", () => {
    const journal = open();
    journal.recordInventory("ABCD", GIVE, 1_000_000_000_000_000_000n, "NULLIFIER");
    journal.recordOffer("abcd", offer("offer-1"));
    const coin = open().getCoin("ABCD")!;
    expect(coin.state).toBe("offered");
    expect(coin.value).toBe("1000000000000000000");
    expect(coin.nullifier).toBe("nullifier");
    expect(coin.offers[0]?.offerId).toBe("offer-1");
  });

  test("selects only wallet-proven released coins and closes consumed coins", () => {
    const journal = open();
    journal.recordInventory("a", GIVE, 10n, "na");
    journal.recordOffer("a", offer("oa", "expired"));
    journal.recordInventory("b", GIVE, 10n, "nb");
    journal.recordOffer("b", offer("ob"));
    expect(journal.candidates(["a", "b"]).map((coin) => coin.nonce)).toEqual(["a"]);
    journal.setOfferStatus("b", "ob", "consumed");
    journal.markSpent("b");
    expect(journal.candidates(["b"])).toHaveLength(0);
  });

  test("refuses a journal from another network or token unless reset", () => {
    open().recordInventory("a", GIVE, 1n, "na");
    expect(() => open("preview")).toThrow(/another network|belongs to network/);
    const replaced = open("preview", true);
    expect(replaced.networkId).toBe("preview");
    expect(replaced.coins()).toHaveLength(0);
    expect(readdirSync(dir).some((name) => name.includes(".superseded-"))).toBe(true);
  });

  test("preserves corrupt input before refusing or resetting", () => {
    writeFileSync(file, "not json");
    let error: JournalError | undefined;
    try { open(); } catch (caught) { error = caught as JournalError; }
    expect(error?.code).toBe("CORRUPT");
    expect(readFileSync(error!.movedAside!, "utf8")).toBe("not json");
  });

  test("reset after corruption creates a clean journal and preserves the bad bytes", () => {
    writeFileSync(file, "{bad-json");
    const journal = open("preprod", true);
    expect(journal.coins()).toHaveLength(0);
    const preserved = readdirSync(dir).find((name) => name.includes(".corrupt-"));
    expect(preserved).toBeDefined();
    expect(readFileSync(join(dir, preserved!), "utf8")).toBe("{bad-json");
  });

  test("token mismatch is refused without changing the old journal, or preserved on reset", () => {
    open().recordInventory("a", GIVE, 1n, "na");
    const original = readFileSync(file, "utf8");
    expect(() => openJournal({ file, networkId: "preprod", giveColour: WANT })).toThrow(/give token|give colour/);
    expect(readFileSync(file, "utf8")).toBe(original);
    const replacement = openJournal({ file, networkId: "preprod", giveColour: WANT, reset: true });
    expect(replacement.giveColour).toBe(WANT);
    expect(replacement.coins()).toHaveLength(0);
    expect(readdirSync(dir).some((name) => name.includes(".superseded-"))).toBe(true);
  });

  test("does not duplicate an adopted coin or offer", () => {
    const journal = open();
    journal.recordInventory("a", GIVE, 1n, "na");
    expect(() => journal.recordInventory("A", GIVE, 1n, "na")).toThrow(/already journaled/);
    journal.recordOffer("a", offer("o"));
    expect(() => journal.recordOffer("a", offer("o"))).toThrow(/already recorded/);
  });

  test("only the latest offer controls candidacy", () => {
    const journal = open();
    journal.recordInventory("a", GIVE, 1n, "na");
    journal.recordOffer("a", offer("old", "expired"));
    journal.recordOffer("a", offer("new", "live"));
    expect(journal.candidates(["a"])).toHaveLength(0);
    journal.setOfferStatus("a", "new", "cancelled");
    expect(journal.candidates(["A"]).map((entry) => entry.nonce)).toEqual(["a"]);
  });

  test("spent and lost coins stay closed even when the wallet reports them free", () => {
    const journal = open();
    journal.recordInventory("spent", GIVE, 1n, "ns");
    journal.recordOffer("spent", offer("os", "expired"));
    journal.markSpent("spent");
    journal.recordInventory("lost", GIVE, 1n, "nl");
    journal.markLost("lost", "operator reconciliation");
    expect(journal.candidates(["spent", "lost"])).toHaveLength(0);
    expect(journal.summary().coins).toMatchObject({ spent: 1, lost: 1 });
  });

  test("live and unknown latest offers are returned for kernel reconciliation", () => {
    const journal = open();
    for (const [nonce, id, status] of [
      ["a", "oa", "live"],
      ["b", "ob", "unknown"],
      ["c", "oc", "expired"],
    ] as const) {
      journal.recordInventory(nonce, GIVE, 1n, `n${nonce}`);
      journal.recordOffer(nonce, offer(id, status as "live" | "expired"));
      if (status === "unknown") journal.setOfferStatus(nonce, id, "unknown");
    }
    expect(journal.nonTerminalOffers().map(({ offer: row }) => row.offerId).sort()).toEqual(["oa", "ob"]);
  });
});

describe("kernel status mapping", () => {
  test("maps terminal/live states and treats unknown data safely", () => {
    expect(mapKernelStatus("live")).toBe("live");
    expect(mapKernelStatus("consumed")).toBe("consumed");
    expect(mapKernelStatus("cancelled")).toBe("cancelled");
    expect(mapKernelStatus("expired")).toBe("expired");
    expect(mapKernelStatus("not_found")).toBe("unknown");
    expect(mapKernelStatus("invented")).toBe("unknown");
  });
});
