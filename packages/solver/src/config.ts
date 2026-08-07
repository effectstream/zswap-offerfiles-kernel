// Ladder configuration: what the solver posts, and what it values residuals at.
//
// Token colors are deployment-specific (they derive from the deployed
// offer-files contract), so pairs may name an alias from the file's own
// `tokens` map instead of a raw 64-hex color. Aliases resolve from that map
// only — never from the node's known-tokens registry, which is an unverified
// demo table any operator can write. `scripts/bootstrap-dev.ts` regenerates the
// `tokens` map after minting.

import { readFile } from "node:fs/promises";

import { LadderBook, type PriceLevel, type PriceLevels } from "./ladder.ts";

export interface SolverLadderConfig {
  /** Alias → 64-hex color. Optional; pairs may use raw colors throughout. */
  tokens?: Record<string, string>;
  /** Color or alias → reference price, used only to value a crossing set's
   *  residual. Exact-zero crossings never consult it. */
  refPricesUsd?: Record<string, number>;
  pairs: Array<{ tokenIn: string; tokenOut: string; levels: PriceLevel[] }>;
}

export interface LoadedLadders {
  ladders: LadderBook;
  refPricesUsd: Map<string, number>;
}

const isColor = (v: string): boolean => /^[0-9a-f]{64}$/i.test(v);

function resolveToken(name: string, aliases: Record<string, string>, where: string): string {
  if (isColor(name)) return name.toLowerCase();
  const color = aliases[name];
  if (!color) {
    const known = Object.keys(aliases).join(", ") || "none";
    throw new Error(`${where}: "${name}" is neither a 64-hex color nor a known alias (${known})`);
  }
  if (!isColor(color)) {
    throw new Error(`${where}: alias "${name}" maps to "${color}", which is not a 64-hex color`);
  }
  return color.toLowerCase();
}

export function buildLadders(config: SolverLadderConfig): LoadedLadders {
  const aliases = config.tokens ?? {};
  if (!Array.isArray(config.pairs)) {
    throw new Error("ladder config: `pairs` must be an array");
  }

  const pairs: PriceLevels[] = config.pairs.map((pair, i) => ({
    tokenIn: resolveToken(pair.tokenIn, aliases, `pairs[${i}].tokenIn`),
    tokenOut: resolveToken(pair.tokenOut, aliases, `pairs[${i}].tokenOut`),
    levels: pair.levels,
  }));

  const refPricesUsd = new Map<string, number>();
  for (const [name, price] of Object.entries(config.refPricesUsd ?? {})) {
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw new Error(`refPricesUsd["${name}"]: must be a non-negative finite number`);
    }
    refPricesUsd.set(resolveToken(name, aliases, `refPricesUsd["${name}"]`), price);
  }

  return { ladders: LadderBook.fromPairs(pairs), refPricesUsd };
}

export async function loadLadderConfig(path: string): Promise<LoadedLadders> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `ladder config not readable at ${path} — run scripts/bootstrap-dev.ts to generate one ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return buildLadders(JSON.parse(raw) as SolverLadderConfig);
}
