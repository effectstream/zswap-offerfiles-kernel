// Serve every ZK asset the BROWSER prover needs, straight from disk.
//
// midnight-js's FetchZkConfigProvider (pointed at this API's origin) fetches:
//   1. CONTRACT circuit assets — `keys/<circuit>.{prover,verifier}` and
//      `zkir/<circuit>.bzkir`, compiled by `compact` into
//      contracts-midnight/contract-offer-files/src/managed/{keys,zkir}.
//   2. zswap + dust PRIMITIVE keys — `keys/midnight/<family>/<circuit>.*` and
//      `zkir/midnight/<family>/<circuit>.bzkir`. These are NOT emitted by
//      `compact`; they live in the Midnight ZK-params cache the proof server
//      populates (`~/.cache/midnight/zk-params/<family>/<version>/`, flat).
//      Without them the browser mint dies with `GET keys/midnight/zswap/
//      output.prover 404` — FetchZkConfigProvider throws on a non-200 and has
//      no proof-server fallback for primitive keys.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const MANAGED = resolve(
  import.meta.dirname!,
  "../contracts-midnight/contract-offer-files/src/managed",
);

const cacheRoot =
  process.env["MIDNIGHT_ZK_PARAMS_DIR"] ||
  process.env["MIDNIGHT_PARAMS_DIR"] ||
  join(homedir(), ".cache", "midnight", "zk-params");

// Highest numeric version dir under <cacheRoot>/<family>/.
function latestVersion(family: string): string | null {
  const dir = join(cacheRoot, family);
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .sort((a, b) => b - a);
  return versions.length ? String(versions[0]) : null;
}

export function resolveAsset(kind: "keys" | "zkir", rest: string): string | null {
  // Primitive keys: midnight/<family>/<file> → cache <family>/<latest>/<file>.
  const primitive = rest.match(/^midnight\/([a-z]+)\/([A-Za-z0-9_.-]+)$/);
  if (primitive) {
    const [, family, file] = primitive;
    const version = latestVersion(family!);
    return version ? join(cacheRoot, family!, version, file!) : null;
  }
  // Contract circuit assets: <file> under managed/{keys,zkir}/.
  const base = resolve(MANAGED, kind);
  const full = resolve(base, rest);
  return full.startsWith(base + sep) ? full : null;
}

export function registerZkAssetRoutes(server: any): void {
  for (const kind of ["keys", "zkir"] as const) {
    server.get(
      `/${kind}/*`,
      // The provider fetches a burst of key files per proof — keep these
      // static reads out of the 60/min API rate limit.
      { config: { rateLimit: false } },
      async (request: any, reply: any) => {
        const rest = String((request.params as any)["*"] ?? "");
        if (!rest || rest.includes("..")) {
          return reply.code(404).send({ error: "unknown zk asset" });
        }
        const file = resolveAsset(kind, rest);
        if (!file || !existsSync(file) || !statSync(file).isFile()) {
          return reply.code(404).send({ error: "unknown zk asset" });
        }
        return reply
          .type("application/octet-stream")
          .send(createReadStream(file));
      },
    );
  }
}
