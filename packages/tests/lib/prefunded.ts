const TOKEN_COLOR = /^[0-9a-f]{64}$/;

/** Resolve an externally issued token color without deriving or minting it. */
export function requireTokenColor(name: string): string {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  if (!TOKEN_COLOR.test(value)) {
    throw new Error(
      `${name} must be a lowercase 64-hex token color. Prefund the named test wallets ` +
      "with same-chain externally issued inventory before running this chain test; no local mint fallback exists.",
    );
  }
  return value;
}

export function requireDistinctTokenColors(names: readonly string[]): string[] {
  const colors = names.map(requireTokenColor);
  if (new Set(colors).size !== colors.length) {
    throw new Error(`${names.join(", ")} must identify distinct externally issued tokens`);
  }
  return colors;
}

export function requireBalance(
  owner: string,
  token: string,
  available: bigint,
  needed: bigint,
): void {
  if (available < needed) {
    throw new Error(
      `${owner} lacks externally prefunded token ${token}: have ${available}, need ${needed}. ` +
      "Provision same-chain token inventory before running the chain test.",
    );
  }
}
