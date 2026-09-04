import { DEFAULT_TOKEN_DECIMALS } from "../solver-core/amount.ts";

export interface MintedTestTokens {
  shieldedA: string;
  shieldedB: string;
  unshielded: string;
}

export interface KnownTokenRegistrationLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface RegisterMintedTokenNamesOptions {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  log: KnownTokenRegistrationLog;
  timeoutMs?: number;
}

export const LOCAL_ZSWAP_API = "http://127.0.0.1:9999";

/** Resolve the registration API without importing or initializing the contract. */
export function resolveMintApiBase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env["ZSWAP_API"]?.trim();
  return configured ? configured : LOCAL_ZSWAP_API;
}

const REGISTRATIONS = [
  { key: "shieldedA", name: "TestTokenA", kind: "shielded" },
  { key: "shieldedB", name: "TestTokenB", kind: "shielded" },
  { key: "unshielded", name: "TestTokenU", kind: "unshielded" },
] as const satisfies ReadonlyArray<{
  key: keyof MintedTestTokens;
  name: string;
  kind: "shielded" | "unshielded";
}>;

/**
 * Best-effort token-name registration, kept pure so it can be tested without
 * loading the compiled Midnight contract or constructing a wallet.
 */
export async function registerMintedTokenNames(
  minted: MintedTestTokens,
  options: RegisterMintedTokenNamesOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const url = `${options.apiBaseUrl.replace(/\/+$/, "")}/v1/known-tokens`;

  for (const registration of REGISTRATIONS) {
    const { name, kind } = registration;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          color: minted[registration.key],
          name,
          kind,
          decimals: DEFAULT_TOKEN_DECIMALS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        options.log.info(`known-token registered for ${name}`);
      } else if (response.status === 409) {
        options.log.info(`known-token already registered for ${name}`);
      } else if (response.status === 404) {
        options.log.warn(`known-token registry disabled; skipped ${name}`);
      } else {
        options.log.warn(`known-token registration for ${name} returned HTTP ${response.status}; continuing`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      options.log.warn(`known-token registration skipped for ${name} (${reason}); continuing`);
    }
  }
}
