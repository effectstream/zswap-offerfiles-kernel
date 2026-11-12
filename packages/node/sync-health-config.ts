// Thresholds of the node's sync verdict (`/v1/health`, `/v1/health/sync` and
// the currentness check of offer validation), read from the environment.
//
// Pure: nothing here reads the environment at load time, so the public-network
// profile can validate these values before env.ts, config.preview.ts or
// midnight-env are evaluated, and exit 78 naming the variable.
//
//   SYNC_HEALTH_MAX_NTP_LAG_BLOCKS            2   NTP blocks (BLOCK_TIME_MS
//                                                 each) the node may trail
//                                                 wall-clock
//   SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS 180  age of the indexer tip's
//                                                 block timestamp before the
//                                                 Midnight source is stale
//   SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS 180  age of the Celestia head's
//                                                 header time before the
//                                                 Celestia source is stale
//   SYNC_HEALTH_HYSTERESIS_SAMPLES            3   consecutive samples that must
//                                                 disagree with the published
//                                                 `/v1/health` verdict before
//                                                 it changes
//
// The tip-age defaults cover the 60 s tip cache, a ~6 s block, an upstream
// that serves a head up to a minute old (a light node stalls about 60 s), and
// tens of seconds of clock skew. A sample is one read of the chain tips; tips
// are cached 60 s, so the hysteresis counts tip reads, not HTTP polls. One
// light-node stall spans at most two consecutive tip reads (the read that
// times out, then the read while the node catches up), so three are required.
//
// There is no block-count limit per chain: see the verdict rules in
// sync-health.ts. Any other SYNC_HEALTH_* variable is not read.

export interface SyncHealthConfig {
  readonly maxNtpLagBlocks: number;
  readonly maxMidnightTipAgeSeconds: number;
  readonly maxCelestiaTipAgeSeconds: number;
  readonly hysteresisSamples: number;
}

interface Setting {
  readonly name: string;
  readonly key: keyof SyncHealthConfig;
  readonly defaultValue: number;
  /** Inclusive upper bound; it catches a unit mix-up such as milliseconds. */
  readonly max: number;
}

export const SYNC_HEALTH_SETTINGS: readonly Setting[] = Object.freeze([
  { name: "SYNC_HEALTH_MAX_NTP_LAG_BLOCKS", key: "maxNtpLagBlocks", defaultValue: 2, max: 10_000 },
  { name: "SYNC_HEALTH_MAX_MIDNIGHT_TIP_AGE_SECONDS", key: "maxMidnightTipAgeSeconds", defaultValue: 180, max: 86_400 },
  { name: "SYNC_HEALTH_MAX_CELESTIA_TIP_AGE_SECONDS", key: "maxCelestiaTipAgeSeconds", defaultValue: 180, max: 86_400 },
  { name: "SYNC_HEALTH_HYSTERESIS_SAMPLES", key: "hysteresisSamples", defaultValue: 3, max: 100 },
] as const);

export const DEFAULT_SYNC_HEALTH_CONFIG: SyncHealthConfig = Object.freeze(
  Object.fromEntries(SYNC_HEALTH_SETTINGS.map((s) => [s.key, s.defaultValue])) as unknown as SyncHealthConfig,
);

export interface ResolvedSyncHealthConfig {
  readonly config: SyncHealthConfig;
  /** One message per invalid variable, each starting with the variable name. */
  readonly problems: readonly string[];
}

/** Pure: resolve the thresholds from an environment snapshot. Unset or blank
 * variables take their default; anything else must be a positive integer in
 * range. */
export function resolveSyncHealthConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedSyncHealthConfig {
  const values: Record<string, number> = {};
  const problems: string[] = [];
  for (const setting of SYNC_HEALTH_SETTINGS) {
    const raw = env[setting.name];
    const trimmed = raw === undefined || raw === null ? "" : String(raw).trim();
    if (trimmed === "") {
      values[setting.key] = setting.defaultValue;
      continue;
    }
    const value = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > setting.max) {
      problems.push(
        `${setting.name} must be an integer from 1 to ${setting.max} (default ${setting.defaultValue}), got "${trimmed}"`,
      );
      values[setting.key] = setting.defaultValue;
      continue;
    }
    values[setting.key] = value;
  }
  return { config: Object.freeze(values as unknown as SyncHealthConfig), problems };
}

/** One line for the startup log. */
export function describeSyncHealthConfig(config: SyncHealthConfig): string {
  return (
    `max ntp lag ${config.maxNtpLagBlocks} blocks; max tip age midnight ${config.maxMidnightTipAgeSeconds} s / ` +
    `celestia ${config.maxCelestiaTipAgeSeconds} s; hysteresis ${config.hysteresisSamples} samples`
  );
}

export class SyncHealthConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`sync-health configuration is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SyncHealthConfigError";
    this.problems = problems;
  }
}

/** For the node's own load: throws {@link SyncHealthConfigError} naming every
 * invalid variable. The public entries refuse the same values earlier, with
 * exit 78, through the public-network profile. */
export function syncHealthConfigOrThrow(
  env: Readonly<Record<string, string | undefined>>,
): SyncHealthConfig {
  const { config, problems } = resolveSyncHealthConfig(env);
  if (problems.length > 0) throw new SyncHealthConfigError(problems);
  return config;
}
