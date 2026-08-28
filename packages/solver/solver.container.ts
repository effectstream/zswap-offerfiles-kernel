import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type ContainerNetwork = "preview" | "mainnet";
export type ContainerEnvReader = (name: string) => string | undefined;

export interface ContainerPreflight {
  network: ContainerNetwork;
  solverEnabled: boolean;
  dryRun: boolean;
  ladderPath: string;
}

export interface ContainerDispatcherDependencies {
  read?: ContainerEnvReader;
  ensureReadableFile?: (path: string) => void;
  importPreview?: () => Promise<unknown>;
  importMainnet?: () => Promise<unknown>;
}

export const COMMON_CONTAINER_FIELDS = [
  "SOLVER_SEED",
  "ZSWAP_API",
  "SOLVER_LADDER_CONFIG",
  "MIDNIGHT_INDEXER_HTTP",
  "MIDNIGHT_INDEXER_WS",
  "MIDNIGHT_NODE_HTTP",
  "MIDNIGHT_PROOF_SERVER_URL",
] as const;

export const LIVE_CONTAINER_FIELDS = [
  "SOLVER_RELAY_WS_URL",
  "SOLVER_RELAY_HTTP_URL",
  "SOLVER_RELAY_AUTH_TOKEN",
  "SOLVER_JOURNAL_PATH",
] as const;

const readProcessEnv: ContainerEnvReader = (name) => process.env[name];

function required(read: ContainerEnvReader, name: string): string {
  const value = read(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function explicitBoolean(read: ContainerEnvReader, name: string): boolean {
  const value = required(read, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function readableFile(path: string): void {
  try {
    accessSync(path, constants.R_OK);
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("SOLVER_LADDER_CONFIG must reference a readable file");
  }
}

export function validateContainerEnvironment(
  read: ContainerEnvReader = readProcessEnv,
  ensureReadableFile: (path: string) => void = readableFile,
): ContainerPreflight {
  const networkValue = required(read, "MIDNIGHT_NETWORK_ID");
  if (networkValue !== "preview" && networkValue !== "mainnet") {
    throw new Error("MIDNIGHT_NETWORK_ID must be preview or mainnet");
  }

  const solverEnabled = explicitBoolean(read, "SOLVER_ENABLED");
  const dryRun = explicitBoolean(read, "SOLVER_DRY_RUN");

  for (const name of COMMON_CONTAINER_FIELDS) required(read, name);

  const ladderPath = required(read, "SOLVER_LADDER_CONFIG");
  try {
    ensureReadableFile(ladderPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("SOLVER_LADDER_CONFIG")) {
      throw error;
    }
    throw new Error("SOLVER_LADDER_CONFIG must reference a readable file");
  }

  if (!dryRun) {
    for (const name of LIVE_CONTAINER_FIELDS) required(read, name);
    const journalPath = required(read, "SOLVER_JOURNAL_PATH");
    if (!isAbsolute(journalPath)) {
      throw new Error("SOLVER_JOURNAL_PATH must be absolute");
    }
    if (networkValue === "mainnet" && required(read, "SOLVER_MAINNET_LIVE_TRADING_ACK") !== "true") {
      throw new Error("SOLVER_MAINNET_LIVE_TRADING_ACK must be exactly true for mainnet live mode");
    }
  }

  return { network: networkValue, solverEnabled, dryRun, ladderPath };
}

export async function runContainerDispatcher(
  dependencies: ContainerDispatcherDependencies = {},
): Promise<void> {
  const config = validateContainerEnvironment(
    dependencies.read ?? readProcessEnv,
    dependencies.ensureReadableFile ?? readableFile,
  );

  if (config.network === "preview") {
    await (dependencies.importPreview ?? (() => import("./solver.preview.ts")))();
    return;
  }
  await (dependencies.importMainnet ?? (() => import("./solver.mainnet.ts")))();
}

if (import.meta.main) {
  try {
    await runContainerDispatcher();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown startup error";
    console.error(`[solver-container] ${message}`);
    process.exitCode = 1;
  }
}
