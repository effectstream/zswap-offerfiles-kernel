import { describe, expect, test } from "bun:test";
import { bech32m } from "@scure/base";
import { OFFER_HRP, OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { offerHashFromBlob } from "@zswap-da/offer-guard";

import { ZswapCelestiaAdapter } from "./celestia.ts";

// The fee-drain fix (item #4): anyone could POST the same valid offer to
// /send-input repeatedly and the batcher paid a Celestia fee every time — the
// SDK has no input dedup (verified: its only checks are non-empty + max
// size). These tests drive the real adapter with the RPC boundary stubbed.
//
// `validateInput` is AWAITED here: it became async when the fee-sponsorship
// gate landed (it may have to consult the node's reference prices). The SDK
// core already awaited it (batcher-sdk core/batcher.ts:513), so nothing on the
// production path changed — only direct callers like these tests.

const adapter = () =>
  new ZswapCelestiaAdapter(
    {
      rpcUrl: "http://127.0.0.1:1", // never contacted — rpcCall is stubbed
      namespace: "000000000000deadbeef",
      authToken: "",
      network: "devnet",
      fee: 2000,
      gasLimit: 100000,
      syncProtocolName: "parallelCelestia",
    } as any,
    "undeployed",
  );

const craftBlob = (fill: number) =>
  bech32m.encode(OFFER_HRP, bech32m.toWords(new Uint8Array(64).fill(fill)), false);

const inputFor = (blob: string) => ({
  address: "tester",
  addressType: 0,
  input: blob,
  timestamp: "1",
});

// Drive the REAL submitBatch (which records the published hash) with the
// Celestia RPC stubbed out at the adapter's own boundary.
async function publishViaAdapter(a: ZswapCelestiaAdapter, blob: string) {
  (a as any).rpcCall = async () => ({ txhash: "stub-tx", height: 7 });
  await a.submitBatch(
    {
      blob: { namespace: "ns", data: "ignored", share_version: 0 },
      rawData: blob,
      inputKey: "tester:1",
    } as any,
    2000n,
  );
}

describe("batcher dedup (published-hash store)", () => {
  test("a published blob is rejected on resubmission BEFORE any validation work", async () => {
    const a = adapter();
    const blob = craftBlob(7);
    await publishViaAdapter(a, blob);

    const verdict = await a.validateInput(inputFor(blob) as any);
    expect(verdict.valid).toBe(false);
    // The dedup message, not a crypto/structure error: proves the replay was
    // caught by the store, before deserialize/wellFormed ever ran. (This blob
    // is junk bytes — full validation would say BAD_DESERIALIZE.)
    expect(verdict.error).toContain("DUPLICATE_OFFER");
    expect(verdict.error).toContain(offerHashFromBlob(blob));
  });

  test("unpublished blobs still fall through to full validation", async () => {
    const a = adapter();
    const verdict = await a.validateInput(inputFor(craftBlob(8)) as any);
    expect(verdict.valid).toBe(false);
    expect(verdict.error).toContain("BAD_DESERIALIZE"); // not DUPLICATE
  });

  test("failed publish does NOT mark the hash — a legitimate retry stays possible", async () => {
    const a = adapter();
    const blob = craftBlob(9);
    (a as any).rpcCall = async () => {
      throw new Error("celestia down");
    };
    await expect(
      a.submitBatch(
        { blob: { namespace: "n", data: "", share_version: 0 }, rawData: blob, inputKey: "k" } as any,
        2000n,
      ),
    ).rejects.toThrow("celestia down");

    const verdict = await a.validateInput(inputFor(blob) as any);
    expect(verdict.error ?? "").not.toContain("DUPLICATE_OFFER");
  });

  test("dedup is per-content, not per-sender: same bytes from another address still rejected", async () => {
    const a = adapter();
    const blob = craftBlob(11);
    await publishViaAdapter(a, blob);
    const verdict = await a.validateInput({ ...inputFor(blob), address: "someone-else" } as any);
    expect(verdict.error).toContain("DUPLICATE_OFFER");
  });
});

describe("raw-bytes DA wire format (MIP-0006)", () => {
  // Regression guard for the 0.101.1→0.103.0 SDK drift: buildBatchData's
  // return moved rawData under .data, the override read the old location,
  // OfferFiles.decode(undefined) threw, and a silent catch shipped the base
  // adapter's UTF-8 bech32m payload — every API-submitted offer then died
  // BAD_DESERIALIZE at STM ingestion. This drives the REAL base class, so a
  // future shape change fails here instead of on the wire.
  test("blob.data is base64 of the RAW offer bytes, not the bech32m string", async () => {
    const { OfferFiles } = await import("@effectstream/mip-zswap-offer/mip5");
    const a = adapter();
    const blob = craftBlob(5);
    const built = (a as any).buildBatchData([inputFor(blob)]);
    expect(built).not.toBeNull();
    const published = Uint8Array.from(Buffer.from(built.data.blob.data, "base64"));
    const expected = OfferFiles.decode(blob);
    expect(published.length).toBe(expected.length);
    expect(Buffer.from(published).equals(Buffer.from(expected))).toBe(true);
    // And explicitly NOT the UTF-8 string form the base adapter would emit.
    expect(new TextDecoder().decode(published.slice(0, 10))).not.toContain("swapoffer");
  });
});

describe("node/batcher parity on shared fixtures", () => {
  // Both gates must agree on what is even a candidate offer — drift here
  // means one side pays for blobs the other rejects. Codes come from the
  // shared validator, so parity is asserted on the code prefix.
  const cases: Array<[string, string]> = [
    ["definitely-not-an-offer", "BAD_ENCODING"],
    [`${OFFER_HRP}1qqqqqzzzz`, "BAD_ENCODING"],
    [craftBlob(3), "BAD_DESERIALIZE"],
  ];

  test.each(cases)("both reject %#: %s", async (blob, code) => {
    const { validateZswapOffer, getBlankRefState } = await import("@zswap-da/validator");
    const nodeVerdict = validateZswapOffer(blob, {
      refState: getBlankRefState("undeployed"),
      tblock: new Date(),
      maxBytes: 1024 * 1024,
    });
    expect(nodeVerdict.ok).toBe(false);
    expect(nodeVerdict.code).toBe(code as any);

    const batcherVerdict = await adapter().validateInput(inputFor(blob) as any);
    expect(batcherVerdict.valid).toBe(false);
    expect(batcherVerdict.error).toContain(code);
  });
});

describe("buildBatchData — raw bytes on the wire, regardless of SDK payload shape", () => {
  test("blob.data is base64 of the DECODED bytes when built via the REAL base adapter", () => {
    // Regression for the 0.103.0 shape drift: the SDK moved rawData from the
    // result's top level into `data`; the override read the old location,
    // its fail-safe catch swallowed the TypeError, and full bech32m STRINGS
    // shipped to Celestia (every one rejected BAD_DESERIALIZE at the STM).
    // Building through the real super.buildBatchData pins the CURRENT shape,
    // so the next drift fails HERE instead of live.
    const a = adapter();
    const blob = craftBlob(3);
    const built = (a as any).buildBatchData([inputFor(blob)]);
    expect(built).toBeTruthy();
    const wire = Buffer.from(built.data.blob.data, "base64");
    const expected = Buffer.from(OfferFiles.decode(blob));
    expect(wire.equals(expected)).toBe(true); // bytes, not the string
    expect(wire.toString("latin1").startsWith("swapoffer1")).toBe(false);
  });

  test("a wiring bug now THROWS instead of silently shipping the string", () => {
    const a = adapter();
    const base = Object.getPrototypeOf(Object.getPrototypeOf(a));
    const spy = base.buildBatchData;
    // Simulate a future SDK moving rawData somewhere new entirely.
    base.buildBatchData = () => ({
      selectedInputs: [],
      data: { blob: { namespace: "n", data: "utf8-of-string", share_version: 0 } },
    });
    try {
      expect(() => (a as any).buildBatchData([inputFor(craftBlob(4))])).toThrow();
    } finally {
      base.buildBatchData = spy;
    }
  });
});
