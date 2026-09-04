import {
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeUserAddress,
  type CoinPublicKey,
  type ContractAddress,
  type UserAddress,
} from "@midnightntwrk/ledger-v9";

export interface CompactBytes32 {
  readonly bytes: Uint8Array;
}

export interface CompactEither<Left, Right> {
  readonly is_left: boolean;
  readonly left: Left;
  readonly right: Right;
}

export type ShieldedMintRecipient = CompactEither<
  CompactBytes32,
  CompactBytes32
>;
export type UnshieldedMintRecipient = CompactEither<
  CompactBytes32,
  CompactBytes32
>;

const inactiveArm = (): CompactBytes32 => ({ bytes: new Uint8Array(32) });

function activeArm(bytes: Uint8Array, label: string): CompactBytes32 {
  if (bytes.length !== 32) {
    throw new Error(`${label} must encode to exactly 32 bytes, got ${bytes.length}`);
  }
  return { bytes };
}

/** Shielded `left`: mint to a user's Zswap coin public key. */
export function shieldedUserRecipient(
  coinPublicKey: CoinPublicKey,
): ShieldedMintRecipient {
  return {
    is_left: true,
    left: activeArm(encodeCoinPublicKey(coinPublicKey), "coin public key"),
    right: inactiveArm(),
  };
}

/** Shielded `right`: mint to a contract that receives in the same transaction. */
export function shieldedContractRecipient(
  contractAddress: ContractAddress,
): ShieldedMintRecipient {
  return {
    is_left: false,
    left: inactiveArm(),
    right: activeArm(
      encodeContractAddress(contractAddress),
      "contract address",
    ),
  };
}

/** Unshielded `left`: mint to a contract address. */
export function unshieldedContractRecipient(
  contractAddress: ContractAddress,
): UnshieldedMintRecipient {
  return {
    is_left: true,
    left: activeArm(
      encodeContractAddress(contractAddress),
      "contract address",
    ),
    right: inactiveArm(),
  };
}

/** Unshielded `right`: mint to a user's unshielded ledger address. */
export function unshieldedUserRecipient(
  userAddress: UserAddress,
): UnshieldedMintRecipient {
  return {
    is_left: false,
    left: inactiveArm(),
    right: activeArm(encodeUserAddress(userAddress), "user address"),
  };
}
