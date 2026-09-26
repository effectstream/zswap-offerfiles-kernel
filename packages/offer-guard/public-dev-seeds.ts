// Public dev seeds — wallet seeds that are written into this repository (and
// its sibling stacks) and are therefore drainable by anyone who reads it.
//
// They are fine on `undeployed`, where the chain is a throwaway devnet and the
// genesis wallet is public by design. On any network with real users (stagenet
// today) a service holding one of these is a service whose funds and fee
// capacity belong to whoever notices first, and whose wallet facade fights
// every other process that booted on the same seed. Entries that must never
// run on one call `isPublicDevSeed` and refuse, naming the variable.
//
// The list mirrors the seed block in `deploy/.env.example` and the defaults in
// the code (genesis …01, API-example taker …02, batcher fallback …03 in
// `packages/batcher/config.ts`, solver `DEV_SEED` …21, E1 maker/taker …31 and
// …32). The rule below is deliberately wider than the list: every dev seed in
// this repository is a 32-byte value whose first 31 bytes are zero, and so is
// any seed a human types while testing ("…05", "…ff"), so ANY such small-integer
// seed counts as public. A real seed has 256 bits of entropy; the chance of one
// landing in that range is 2^-248.

/** The dev seeds this repository ships, for documentation and tests. */
export const KNOWN_PUBLIC_DEV_SEEDS: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000001", // genesis / local fee wallet
  "0000000000000000000000000000000000000000000000000000000000000002", // api-examples taker
  "0000000000000000000000000000000000000000000000000000000000000003", // batcher fallback (config.ts)
  "0000000000000000000000000000000000000000000000000000000000000021", // solver DEV_SEED
  "0000000000000000000000000000000000000000000000000000000000000031", // E1 maker
  "0000000000000000000000000000000000000000000000000000000000000032", // E1 taker
];

/** Lowercased, trimmed, `0x`-stripped — so `0xAB…` and `ab…` compare equal. */
export function normalizeSeedHex(seed: string): string {
  const trimmed = seed.trim();
  const bare = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  return bare.toLowerCase();
}

/**
 * True for a repository dev seed, or any 32-byte seed whose first 31 bytes are
 * zero (see the header). Anything that is not 64 hex characters is NOT a dev
 * seed here — malformed input is the caller's own, separately named, refusal.
 */
export function isPublicDevSeed(seed: string): boolean {
  const s = normalizeSeedHex(seed);
  if (!/^[0-9a-f]{64}$/.test(s)) return false;
  return KNOWN_PUBLIC_DEV_SEEDS.includes(s) || /^0{62}[0-9a-f]{2}$/.test(s);
}
