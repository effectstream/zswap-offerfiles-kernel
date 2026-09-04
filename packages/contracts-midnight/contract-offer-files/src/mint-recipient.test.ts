import { describe, expect, test } from "bun:test";
import {
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeUserAddress,
  sampleCoinPublicKey,
  sampleContractAddress,
  sampleUserAddress,
} from "@midnightntwrk/ledger-v9";
import {
  shieldedContractRecipient,
  shieldedUserRecipient,
  unshieldedContractRecipient,
  unshieldedUserRecipient,
} from "./mint-recipient.ts";

const zeros = new Uint8Array(32);

describe("mint recipient encoding", () => {
  test("shielded user is left with a valid inactive contract arm", () => {
    const key = sampleCoinPublicKey();
    const recipient = shieldedUserRecipient(key);
    expect(recipient.is_left).toBe(true);
    expect(recipient.left.bytes).toEqual(encodeCoinPublicKey(key));
    expect(recipient.right.bytes).toEqual(zeros);
    expect(recipient.left.bytes).toHaveLength(32);
    expect(recipient.right.bytes).toHaveLength(32);
  });

  test("shielded contract is right with a valid inactive coin-key arm", () => {
    const address = sampleContractAddress();
    const recipient = shieldedContractRecipient(address);
    expect(recipient.is_left).toBe(false);
    expect(recipient.left.bytes).toEqual(zeros);
    expect(recipient.right.bytes).toEqual(encodeContractAddress(address));
    expect(recipient.left.bytes).toHaveLength(32);
    expect(recipient.right.bytes).toHaveLength(32);
  });

  test("unshielded contract is left with a valid inactive user arm", () => {
    const address = sampleContractAddress();
    const recipient = unshieldedContractRecipient(address);
    expect(recipient.is_left).toBe(true);
    expect(recipient.left.bytes).toEqual(encodeContractAddress(address));
    expect(recipient.right.bytes).toEqual(zeros);
    expect(recipient.left.bytes).toHaveLength(32);
    expect(recipient.right.bytes).toHaveLength(32);
  });

  test("unshielded user is right with a valid inactive contract arm", () => {
    const address = sampleUserAddress();
    const recipient = unshieldedUserRecipient(address);
    expect(recipient.is_left).toBe(false);
    expect(recipient.left.bytes).toEqual(zeros);
    expect(recipient.right.bytes).toEqual(encodeUserAddress(address));
    expect(recipient.left.bytes).toHaveLength(32);
    expect(recipient.right.bytes).toHaveLength(32);
  });
});
