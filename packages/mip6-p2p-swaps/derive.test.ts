import { describe, expect, test } from "bun:test";

import { deriveTokenLegs, UnknownTokenTagError } from "./derive.ts";
import {
  assertTwoSided,
  isTwoSidedSwap,
  NotASwapError,
} from "./two-sided.ts";
import {
  buildOnchainOfferPayload,
  earliestIntentTtl,
  toOffchainOfferPayload,
} from "./payload.ts";
import { OFFER_HRP } from "@zswap-da/mip5-offer-files";

const shielded = (raw: string) => ({ tag: "shielded" as const, raw });
const unshielded = (raw: string) => ({ tag: "unshielded" as const, raw });
const dust = () => ({ tag: "dust" as const });

function mockTx(opts: {
  fallible?: Map<number, any>;
  intents?: Map<number, any>;
  imbalances?: Map<number, Map<any, bigint>>;
}) {
  return {
    guaranteedOffer: undefined,
    fallibleOffer: opts.fallible,
    intents: opts.intents,
    imbalances(seg: number) {
      return opts.imbalances?.get(seg) ?? new Map();
    },
  } as any;
}

describe("deriveTokenLegs", () => {
  test("tags legs SHIELDED / UNSHIELDED; dust ignored", () => {
    const tx = mockTx({
      imbalances: new Map([
        [
          0,
          new Map<any, bigint>([
            [unshielded("aabb"), 100n],
            [shielded("ccdd"), -50n],
            [dust(), 999n],
          ]),
        ],
      ]),
    });
    const { gives, wants } = deriveTokenLegs(tx);
    expect(gives).toEqual([
      { token: "aabb", amount: "100", type: "UNSHIELDED" },
    ]);
    expect(wants).toEqual([
      { token: "ccdd", amount: "50", type: "SHIELDED" },
    ]);
  });

  test("keeps same color on different layers separate", () => {
    const tx = mockTx({
      imbalances: new Map([
        [
          0,
          new Map<any, bigint>([
            [shielded("aa"), 10n],
            [unshielded("aa"), -5n],
          ]),
        ],
      ]),
    });
    const { gives, wants } = deriveTokenLegs(tx);
    expect(gives).toEqual([{ token: "aa", amount: "10", type: "SHIELDED" }]);
    expect(wants).toEqual([{ token: "aa", amount: "5", type: "UNSHIELDED" }]);
  });

  test("throws UnknownTokenTagError on unexpected tag", () => {
    const tx = mockTx({
      imbalances: new Map([
        [0, new Map<any, bigint>([[{ tag: "weird", raw: "00" }, 1n]])],
      ]),
    });
    expect(() => deriveTokenLegs(tx)).toThrow(UnknownTokenTagError);
  });
});

describe("two-sided rule", () => {
  test("isTwoSidedSwap requires both sides", () => {
    expect(isTwoSidedSwap([{ token: "a", amount: "1", type: "SHIELDED" }], [])).toBe(
      false,
    );
    expect(
      isTwoSidedSwap(
        [{ token: "a", amount: "1", type: "SHIELDED" }],
        [{ token: "b", amount: "1", type: "SHIELDED" }],
      ),
    ).toBe(true);
  });

  test("assertTwoSided throws NotASwapError for give-only", () => {
    expect(() =>
      assertTwoSided([{ token: "a", amount: "1", type: "SHIELDED" }], []),
    ).toThrow(NotASwapError);
  });
});

describe("payload builders", () => {
  test("buildOnchainOfferPayload wraps raw bytes", () => {
    const offer = new Uint8Array([1, 2, 3]);
    const p = buildOnchainOfferPayload(offer, "hi");
    expect(p).toEqual({ version: 1, offer, unverifiedMessage: "hi" });
  });

  test("toOffchainOfferPayload derives legs and encodes bech32", () => {
    const offerBytes = new Uint8Array([7, 7, 7]);
    const tx = mockTx({
      imbalances: new Map([
        [
          0,
          new Map<any, bigint>([
            [shielded("aa"), 10n],
            [shielded("bb"), -5n],
          ]),
        ],
      ]),
    });
    const off = toOffchainOfferPayload({
      offerBytes,
      tx,
      inputNullifiers: ["dead"],
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      status: "live",
    });
    expect(off.version).toBe(1);
    expect(off.offerBech32.startsWith(`${OFFER_HRP}1`)).toBe(true);
    expect(off.computed.gives[0]!.type).toBe("SHIELDED");
    expect(off.computed.wants[0]!.token).toBe("bb");
    expect(off.computed.inputNullifiers).toEqual(["dead"]);
  });

  test("earliestIntentTtl picks the soonest ttl", () => {
    const tx = mockTx({
      intents: new Map([
        [1, { ttl: new Date("2026-06-30T12:00:00Z") }],
        [2, { ttl: new Date("2026-06-01T00:00:00Z") }],
      ]),
    });
    expect(earliestIntentTtl(tx)).toBe("2026-06-01T00:00:00.000Z");
  });
});
