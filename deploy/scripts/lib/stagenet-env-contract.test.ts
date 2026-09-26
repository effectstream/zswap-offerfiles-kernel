// stagenet-env-contract.test.ts — `.env.stagenet.example` must list every
// variable the stagenet services read (00050 FR-008 / SC-003).
//
// The services are the kernel image's four stagenet entries: the node
// (main.stagenet.ts), the batcher (batcher.stagenet.ts), the offer poster and
// the token-registry one-shot. For each, the FIRST-PARTY modules it loads that
// read the environment are scanned for literal variable names — the TS
// readers this repository uses (getEnv, ENV.get*, optionalString/Number,
// positiveMs, process.env, readEnv/readString/readInt/…, the stagenet
// profiles' read()) and the entrypoints' `${VAR…}` / `require_env` — and every
// name found must appear in the example (commented optional knobs count), or
// be in NOT_IN_CONTRACT with a reason. Variables read only inside
// dependencies (the Midnight endpoints, DB_*, PGLITE, the runtime's own knobs)
// are pinned by THIRD_PARTY_REQUIRED instead.
//
// A new env read in one of these modules therefore fails this test until the
// operator-facing contract says what it is.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const SERVICES: Record<string, string[]> = {
  kernel: [
    "packages/node/main.stagenet.ts",
    "packages/node/stagenet-profile.ts",
    "packages/node/env.ts",
    "packages/node/config.preview.ts",
    "packages/node/batcher-client.ts",
    "packages/node/sync-health.ts",
    "deploy/images/kernel/entrypoint-kernel.sh",
  ],
  batcher: [
    "packages/batcher/batcher.stagenet.ts",
    "packages/batcher/stagenet.ts",
    "packages/batcher/config.ts",
    "packages/batcher/midnight-balancing.ts",
    "packages/batcher/celestia.ts",
    "deploy/images/kernel/entrypoint-batcher.sh",
  ],
  poster: [
    "deploy/scripts/offer-poster.ts",
    "deploy/scripts/lib/poster-config.ts",
    "deploy/images/kernel/entrypoint-offer-poster.sh",
  ],
  registry: [
    "packages/database/import-token-registry.ts",
    "deploy/images/kernel/entrypoint-token-registry.sh",
  ],
};

/** Read by a scanned module, deliberately NOT part of the operator contract. */
const NOT_IN_CONTRACT: Record<string, string> = {
  EVENT_GATE_POLL_ENABLED: "test-only switch (env.ts); a deployed node must keep the post-commit poll on",
  MIDNIGHT_WALLET_MNEMONIC: "poster reads it only to refuse sharing another service's wallet",
  REPO_ROOT: "image-internal path (/app), set by entrypoint-common.sh",
  KERNEL_ENTRY: "entrypoint-kernel.sh local",
  BATCHER_ENTRY: "entrypoint-batcher.sh local",
  POSTER_JOURNAL_DIR: "entrypoint-offer-poster.sh local",
  ATTEMPTS: "entrypoint-token-registry.sh local",
  DELAY: "entrypoint-token-registry.sh local",
};

/** Read inside dependencies; the example must carry each as a real line. */
const THIRD_PARTY_REQUIRED = [
  "MIDNIGHT_NETWORK_ID", // @effectstream/midnight-contracts
  "MIDNIGHT_NODE_HTTP",
  "MIDNIGHT_INDEXER_HTTP",
  "MIDNIGHT_INDEXER_WS",
  "MIDNIGHT_PROOF_SERVER_URL",
  "PGLITE", // @effectstream/db — defaults to true, external Postgres needs false
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PW",
  "DB_NAME",
];

/** Third-party knobs the runbook relies on; the example must mention them. */
const THIRD_PARTY_MENTIONED = ["EFFECTSTREAM_API_PORT", "EFFECTSTREAM_TRUST_PROXY", "USE_DB_STARTHEIGHT"];

/** Required by the stagenet profiles / entrypoints: uncommented in the example. */
const REQUIRED_LINES = [
  "CELESTIA_RPC_URL",
  "CELESTIA_AUTH_TOKEN",
  "CELESTIA_START_HEIGHT",
  "BATCHER_WALLET_SEED",
  "BATCHER_STORAGE_DIR",
  "ZSWAP_API",
  "POSTER_SEED",
  "GIVE_TOKEN",
  "WANT_TOKEN",
  "TOKEN_REGISTRY_NETWORK",
];

/** Secrets: present, and EMPTY in the committed example. */
const SECRETS = ["CELESTIA_AUTH_TOKEN", "DB_PW", "BATCHER_WALLET_SEED", "POSTER_SEED"];

const TS_READERS = [
  /\bgetEnv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /\bENV\.get[A-Za-z]+\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /\b(?:optionalString|optionalNumber|positiveMs)\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bprocess\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g,
  /\b(?:readEnv|readString|readInt|readBool|readBigint|readOptionalBigint|resolveLeg|read)\(\s*env,\s*"([A-Z][A-Z0-9_]*)"/g,
  /\benv\.([A-Z][A-Z0-9_]*)\b/g, // import-token-registry.ts: env.TOKEN_REGISTRY_*
];
const SH_READERS = [/\$\{([A-Z][A-Z0-9_]*)/g];

function namesIn(rel: string): Set<string> {
  // Whole-line comments are prose, not reads (e.g. an entrypoint explaining
  // why it does NOT use `${VAR:?message}`).
  const commentLine = rel.endsWith(".sh") ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  const src = read(rel)
    .split("\n")
    .filter((line) => !commentLine.test(line))
    .join("\n");
  const found = new Set<string>();
  const readers = rel.endsWith(".sh") ? SH_READERS : TS_READERS;
  for (const re of readers) for (const m of src.matchAll(re)) found.add(m[1]!);
  if (rel.endsWith(".sh")) {
    // `require_env A B \` possibly continued over several lines.
    for (const m of src.matchAll(/^\s*require_env\s+((?:[A-Z0-9_ ]|\\\n)+)/gm)) {
      for (const name of m[1]!.replace(/\\\n/g, " ").split(/\s+/)) if (/^[A-Z][A-Z0-9_]*$/.test(name)) found.add(name);
    }
  }
  return found;
}

function exampleEntries(): { all: Set<string>; lines: Map<string, string> } {
  const all = new Set<string>();
  const lines = new Map<string, string>();
  for (const raw of read(".env.stagenet.example").split("\n")) {
    const m = raw.match(/^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    all.add(m[2]!);
    if (!m[1]) lines.set(m[2]!, m[3]!);
  }
  return { all, lines };
}

describe(".env.stagenet.example is the complete stagenet env contract (SC-003)", () => {
  const example = exampleEntries();

  test.each(Object.entries(SERVICES))("[%s] every variable its modules read is listed", (_service, files) => {
    const missing: string[] = [];
    for (const file of files) {
      for (const name of namesIn(file)) {
        if (!example.all.has(name) && !(name in NOT_IN_CONTRACT)) missing.push(`${name} (read in ${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the scanner really finds names (guards against a silently broken regex)", () => {
    expect(namesIn("packages/node/env.ts").has("CELESTIA_START_HEIGHT")).toBe(true);
    expect(namesIn("packages/batcher/config.ts").has("BATCHER_WALLET_SEED")).toBe(true);
    expect(namesIn("deploy/scripts/lib/poster-config.ts").has("GIVE_TOKEN")).toBe(true);
    expect(namesIn("packages/database/import-token-registry.ts").has("TOKEN_REGISTRY_BASE_URL")).toBe(true);
    expect(namesIn("deploy/images/kernel/entrypoint-kernel.sh").has("DB_WAIT_TIMEOUT_S")).toBe(true);
    expect(namesIn("deploy/images/kernel/entrypoint-token-registry.sh").has("TOKEN_REGISTRY_NETWORK")).toBe(true);
    expect(namesIn("packages/node/stagenet-profile.ts").has("CELESTIA_AUTH_IN_URL")).toBe(true);
  });

  test("dependency-read variables the services need are real lines", () => {
    for (const name of THIRD_PARTY_REQUIRED) expect(example.lines.has(name), name).toBe(true);
    for (const name of THIRD_PARTY_MENTIONED) expect(example.all.has(name), name).toBe(true);
    expect(example.lines.get("MIDNIGHT_NETWORK_ID")).toBe("stagenet");
    expect(example.lines.get("PGLITE")).toBe("false");
    expect(example.lines.get("MIDNIGHT_NODE_HTTP")).toBe("https://rpc.stagenet.shielded.tools");
    expect(example.lines.get("MIDNIGHT_INDEXER_HTTP")).toBe("https://indexer.stagenet.shielded.tools/api/v4/graphql");
    expect(example.lines.get("TOKEN_REGISTRY_NETWORK")).toBe("stagenet");
  });

  test("every required variable is an uncommented line", () => {
    for (const name of REQUIRED_LINES) expect(example.lines.has(name), name).toBe(true);
  });

  test("secrets are present and empty; the namespace is not overridden", () => {
    for (const name of SECRETS) expect(example.lines.get(name), name).toBe("");
    expect(example.lines.has("CELESTIA_NAMESPACE")).toBe(false);
    expect(example.lines.has("POSTER_MNEMONIC")).toBe(false);
  });

  test("the example carries the stagenet constants", () => {
    const text = read(".env.stagenet.example");
    expect(text).toContain("1786638294000");
    expect(text).toContain("6d6e2d737761702d7631");
    expect(text).toContain("1209600");
  });

  test("packages/node modules that read env are either scanned or excluded on purpose", () => {
    const scanned = new Set(SERVICES.kernel!.map((f) => f.replace("packages/node/", "")));
    const excluded: Record<string, string> = {
      "main.dev.ts": "undeployed entry",
      "config.dev.ts": "undeployed config",
      "main.mainnet.ts": "Celestia-mainnet entry",
      "config.mainnet.ts": "Celestia-mainnet config",
      "main.grand-b.ts": "test-only entry",
      "preflight-external.ts": "start.external.ts orchestrator path",
    };
    const readers = readdirSync(join(REPO_ROOT, "packages/node"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => namesIn(`packages/node/${f}`).size > 0);
    const unaccounted = readers.filter((f) => !scanned.has(f) && !(f in excluded));
    expect(unaccounted).toEqual([]);
  });

  test("the README documents the contract", () => {
    const readme = read("README.md");
    expect(readme).toContain("## Running against stagenet");
    expect(readme).toContain(".env.stagenet.example");
  });
});
