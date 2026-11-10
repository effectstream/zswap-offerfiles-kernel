import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactBlockfrostProjectId } from "@effectstream/midnight-contracts/midnight-env";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";
import { UNPINNED_REFERENCE_PARAMETERS } from "@zswap-da/validator/reference-parameters";

import { ROOT_WINDOW_DEFAULT_S } from "./network-windows.ts";
import {
  applyPublicNodeProfile,
  describeMidnightEndpoints,
  describePublicNodeProfile,
  MIP6_NAMESPACE_SUFFIX_HEX,
  NTP_ANCHOR_MS,
  PublicNetworkConfigError,
  redactedOrigin,
  resolvePublicNodeProfile,
} from "./public-network-profile.ts";

// `fileURLToPath`, not `new URL(...).pathname`: a working tree of this repo
// may live under a path with a space in it.
const HERE = dirname(fileURLToPath(import.meta.url));

const TOKEN = "preprodTestProjectId0000000000000";
const NETWORKS = ["preview", "preprod", "mainnet"] as const;

/** The refusal every service gives a supported network whose reference
 *  ledger parameters are not pinned yet (today: mainnet). */
const NOT_PINNED = "ledger-9 reference parameters are not pinned yet";
const unpinned = (network: string) => Object.hasOwn(UNPINNED_REFERENCE_PARAMETERS, network);
/** The profile's problems apart from the not-pinned refusal: what the env itself gets wrong. */
const envProblems = (problems: readonly string[]) => problems.filter((p) => !p.includes(NOT_PINNED));

const complete = (network: string = "preprod"): Record<string, string | undefined> => ({
  MIDNIGHT_NETWORK_ID: network,
  MIDNIGHT_BLOCKFROST_PROJECT_ID: TOKEN,
  CELESTIA_START_HEIGHT: "9000000",
  CELESTIA_RPC_URL: "https://celestia.example.invalid:26658",
  CELESTIA_AUTH_TOKEN: "bearer-for-tests",
  PGLITE: "false",
});

describe("public-network node profile — constants", () => {
  test("NTP anchors are each network's block 1", () => {
    expect(NTP_ANCHOR_MS).toEqual({
      preview: 1_784_214_468_491,
      preprod: 1_774_031_004_000,
      mainnet: 1_773_843_582_000,
    });
    expect(new Date(NTP_ANCHOR_MS.preview).toISOString()).toBe("2026-07-16T15:07:48.491Z");
    expect(new Date(NTP_ANCHOR_MS.preprod).toISOString()).toBe("2026-03-20T18:23:24.000Z");
    expect(new Date(NTP_ANCHOR_MS.mainnet).toISOString()).toBe("2026-03-18T14:19:42.000Z");
  });

  test("the local namespace copy IS the MIP-0006 shared namespace (mn-swap-v1)", () => {
    expect(MIP6_NAMESPACE_SUFFIX_HEX).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
    expect(Buffer.from(MIP6_NAMESPACE_SUFFIX_HEX, "hex").toString("ascii")).toBe("mn-swap-v1");
  });
});

describe("public-network node profile — resolution", () => {
  test.each([
    ["preview", "mocha"],
    ["preprod", "mocha"],
    ["mainnet", "mainnet"],
  ] as const)("%s resolves Celestia %s on the MIP-0006 namespace, anchored at its block 1", (network, celestia) => {
    const profile = resolvePublicNodeProfile(complete(network));
    // A network that is not pinned yet is refused for that alone; its profile
    // still resolves completely.
    expect(profile.problems).toEqual(unpinned(network) ? [expect.stringContaining(NOT_PINNED)] : []);
    expect(profile.warnings).toEqual([]);
    expect(profile.defaults).toEqual({
      NTP_START_TIME: String(NTP_ANCHOR_MS[network]),
      CELESTIA_NETWORK: celestia,
    });
    expect(profile.resolved).toEqual({
      networkId: network,
      ntpStartTimeMs: NTP_ANCHOR_MS[network],
      celestiaNetwork: celestia,
      celestiaNamespace: "6d6e2d737761702d7631",
      celestiaStartHeight: 9000000,
      celestiaAuth: "bearer-token",
      celestiaRpcOrigin: "https://celestia.example.invalid:26658",
      midnightEndpoints: "blockfrost-defaults",
      rootWindowSeconds: ROOT_WINDOW_DEFAULT_S,
    });
  });

  test.each(["stagenet", "devnet", "", "PREPROD"])(
    "MIDNIGHT_NETWORK_ID=%j is refused, naming the four supported networks",
    (network) => {
      const profile = resolvePublicNodeProfile(complete(network));
      expect(profile.problems[0]).toContain("is not supported (supported: undeployed, preview, preprod, mainnet)");
    },
  );

  test("undeployed is pointed at the dev entry", () => {
    const profile = resolvePublicNodeProfile(complete("undeployed"));
    expect(profile.problems).toHaveLength(1);
    expect(profile.problems[0]).toContain("run packages/node/main.dev.ts");
  });

  test("every missing required variable is named, in one pass", () => {
    const profile = resolvePublicNodeProfile({ MIDNIGHT_NETWORK_ID: "mainnet" });
    expect(profile.problems.map((p) => p.split(" ")[0])).toEqual([
      "CELESTIA_START_HEIGHT",
      "CELESTIA_RPC_URL",
      "CELESTIA_AUTH_TOKEN",
      "MIDNIGHT_BLOCKFROST_PROJECT_ID",
      'MIDNIGHT_NETWORK_ID="mainnet"',
    ]);
    expect(profile.problems[3]).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID is required on mainnet");
    expect(profile.problems[4]).toContain(NOT_PINNED);
  });

  test("mainnet: a complete env is refused only because its reference parameters are not pinned yet", () => {
    const profile = resolvePublicNodeProfile(complete("mainnet"));
    expect(profile.problems).toHaveLength(1);
    expect(profile.problems[0]).toStartWith(`MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ${NOT_PINNED}`);
    expect(profile.problems[0]).toContain("(pinned: undeployed, preview, preprod)");
    expect(() => applyPublicNodeProfile(complete("mainnet"))).toThrow(PublicNetworkConfigError);
  });

  test.each(NETWORKS)("%s without MIDNIGHT_BLOCKFROST_PROJECT_ID fails naming it", (network) => {
    const env = complete(network);
    delete env["MIDNIGHT_BLOCKFROST_PROJECT_ID"];
    const problems = envProblems(resolvePublicNodeProfile(env).problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`MIDNIGHT_BLOCKFROST_PROJECT_ID is required on ${network}`);
  });

  test.each([
    ["preprod", "MIDNIGHT_INDEXER_HTTP", "https://indexer.preprod.midnight.network/api/v4/graphql"],
    ["preprod", "MIDNIGHT_NODE_HTTP", "https://rpc.preprod.midnight.network"],
    ["mainnet", "MIDNIGHT_INDEXER_WS", "wss://indexer.mainnet.midnight.network/api/v4/graphql/ws"],
    ["mainnet", "MIDNIGHT_NODE_HTTP", "https://rpc.mainnet.midnight.network"],
  ] as const)("%s with %s on a retired host is refused naming MIDNIGHT_BLOCKFROST_PROJECT_ID", (network, name, url) => {
    const problems = envProblems(resolvePublicNodeProfile({ ...complete(network), [name]: url }).problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`${name} points at `);
    expect(problems[0]).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID");
  });

  test("Blockfrost URL overrides pass, with or without the token variable", () => {
    const overrides = {
      MIDNIGHT_INDEXER_HTTP: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${TOKEN}`,
      MIDNIGHT_INDEXER_WS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${TOKEN}`,
      MIDNIGHT_NODE_HTTP: `https://rpc.midnight-preprod.blockfrost.io?project_id=${TOKEN}`,
    };
    const env = { ...complete("preprod"), ...overrides };
    expect(resolvePublicNodeProfile(env).problems).toEqual([]);
    expect(resolvePublicNodeProfile(env).resolved.midnightEndpoints).toBe("overrides");
    delete env["MIDNIGHT_BLOCKFROST_PROJECT_ID"];
    expect(resolvePublicNodeProfile(env).problems).toEqual([]);
  });

  test.each(["", "   "])("a blank CELESTIA_START_HEIGHT (%j) counts as missing — no fallback to 1", (blank) => {
    const profile = resolvePublicNodeProfile({ ...complete(), CELESTIA_START_HEIGHT: blank });
    expect(profile.problems[0]).toContain("CELESTIA_START_HEIGHT is required on preprod");
  });

  test.each(["0", "-5", "12abc", "1.5"])("CELESTIA_START_HEIGHT=%s is malformed", (value) => {
    const profile = resolvePublicNodeProfile({ ...complete(), CELESTIA_START_HEIGHT: value });
    expect(profile.problems).toEqual([`CELESTIA_START_HEIGHT must be a positive integer, got "${value}"`]);
  });

  test("CELESTIA_AUTH_IN_URL=true satisfies the auth requirement; false does not", () => {
    const env = { ...complete(), CELESTIA_AUTH_IN_URL: "true" };
    delete env["CELESTIA_AUTH_TOKEN"];
    expect(resolvePublicNodeProfile(env).problems).toEqual([]);
    expect(resolvePublicNodeProfile(env).resolved.celestiaAuth).toBe("in-url");
    expect(resolvePublicNodeProfile({ ...env, CELESTIA_AUTH_IN_URL: "false" }).problems[0]).toContain(
      "CELESTIA_AUTH_TOKEN is required on preprod",
    );
  });

  test("the wrong Celestia network is refused; the right one explicit is accepted as is", () => {
    expect(resolvePublicNodeProfile({ ...complete("preprod"), CELESTIA_NETWORK: "mainnet" }).problems[0]).toContain(
      'CELESTIA_NETWORK must be "mocha" on preprod',
    );
    expect(resolvePublicNodeProfile({ ...complete("mainnet"), CELESTIA_NETWORK: "mocha" }).problems[0]).toContain(
      'CELESTIA_NETWORK must be "mainnet" on mainnet',
    );
    const explicit = resolvePublicNodeProfile({ ...complete("mainnet"), CELESTIA_NETWORK: "mainnet" });
    expect(envProblems(explicit.problems)).toEqual([]);
    expect(explicit.defaults).not.toHaveProperty("CELESTIA_NETWORK");
  });

  test("an explicit NTP_START_TIME wins but is flagged; a malformed one is refused", () => {
    const override = resolvePublicNodeProfile({ ...complete("preview"), NTP_START_TIME: "1784214500000" });
    expect(override.problems).toEqual([]);
    expect(override.defaults).not.toHaveProperty("NTP_START_TIME");
    expect(override.resolved.ntpStartTimeMs).toBe(1784214500000);
    expect(override.warnings[0]).toContain("overrides the preview block-1 anchor 1784214468491");
    expect(resolvePublicNodeProfile({ ...complete(), NTP_START_TIME: "soon" }).problems[0]).toContain(
      "NTP_START_TIME must be a millisecond timestamp",
    );
  });

  test("a blank CELESTIA_NAMESPACE is removed (env.ts's MIP-0006 default applies); an override warns", () => {
    const blank = resolvePublicNodeProfile({ ...complete(), CELESTIA_NAMESPACE: " " });
    expect(blank.unset).toEqual(["CELESTIA_NAMESPACE"]);
    expect(blank.resolved.celestiaNamespace).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
    const override = resolvePublicNodeProfile({ ...complete(), CELESTIA_NAMESPACE: "0102030405060708090a" });
    expect(override.problems).toEqual([]);
    expect(override.warnings[0]).toContain("overrides the MIP-0006 shared namespace");
  });

  test("the Celestia credential and the Blockfrost token never reach the profile or its description", () => {
    const env = {
      ...complete(),
      CELESTIA_RPC_URL: "https://user:pa55@abc.celestia-mocha.quiknode.pro/SECRET-PATH/?k=SECRET2",
    };
    const profile = resolvePublicNodeProfile(env);
    const text = describePublicNodeProfile(profile).join("\n") + JSON.stringify(profile);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("pa55");
    expect(text).not.toContain("bearer-for-tests");
    expect(text).not.toContain(TOKEN);
    expect(profile.resolved.celestiaRpcOrigin).toBe("https://abc.celestia-mocha.quiknode.pro");
  });

  test("PGLITE unset or true is a warning, never a refusal", () => {
    for (const value of [undefined, "true", "1"]) {
      const profile = resolvePublicNodeProfile({ ...complete(), PGLITE: value });
      expect(profile.problems).toEqual([]);
      expect(profile.warnings.join("\n")).toContain("set PGLITE=false for an external Postgres");
    }
  });

  test("redactedOrigin keeps only protocol, host and port", () => {
    expect(redactedOrigin("http://127.0.0.1:26658/x?y=1")).toBe("http://127.0.0.1:26658");
    expect(redactedOrigin(undefined)).toBeUndefined();
    expect(redactedOrigin("not a url")).toBe("<unparseable URL>");
  });
});

describe("public-network node profile — application", () => {
  test("apply writes only the defaults and removes a blank namespace", () => {
    const env = { ...complete("preview"), CELESTIA_NAMESPACE: "", BLOCK_TIME_MS: undefined };
    applyPublicNodeProfile(env);
    expect(env["NTP_START_TIME"]).toBe("1784214468491");
    expect(env["CELESTIA_NETWORK"]).toBe("mocha");
    expect("CELESTIA_NAMESPACE" in env).toBe(false);
    expect(env["BLOCK_TIME_MS"]).toBeUndefined();
  });

  test("apply refuses before changing anything", () => {
    const env: Record<string, string | undefined> = { MIDNIGHT_NETWORK_ID: "preview" };
    expect(() => applyPublicNodeProfile(env)).toThrow(PublicNetworkConfigError);
    expect(env).toEqual({ MIDNIGHT_NETWORK_ID: "preview" });
    try {
      applyPublicNodeProfile(env);
    } catch (error) {
      expect((error as Error).message).toContain('node configuration for MIDNIGHT_NETWORK_ID="preview" is invalid (4 problems)');
    }
  });
});

describe("endpoint lines are redacted with midnight-env's redactBlockfrostProjectId", () => {
  test("plain, with other query parameters, and WS URLs show project_id=<redacted>", () => {
    const lines = describeMidnightEndpoints(
      {
        node: `https://rpc.midnight-preprod.blockfrost.io?project_id=${TOKEN}`,
        indexer: `https://midnight-preprod.blockfrost.io/api/v0?foo=1&project_id=${TOKEN}&bar=2`,
        indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${TOKEN}`,
        proofServer: "http://proof-server:6300",
      },
      redactBlockfrostProjectId,
    );
    const text = lines.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(lines).toEqual([
      "Midnight node      : https://rpc.midnight-preprod.blockfrost.io?project_id=<redacted>",
      "Midnight indexer   : https://midnight-preprod.blockfrost.io/api/v0?foo=1&project_id=<redacted>&bar=2",
      "Midnight indexer ws: wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=<redacted>",
      "proof server       : http://proof-server:6300",
    ]);
  });
});

// A fresh process per case: the entries read the environment at load time.
const spawnEnv = (vars: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) out[key] = value;
  return out;
};
const run = (file: string, vars: Record<string, string | undefined>) =>
  Bun.spawnSync([process.execPath, "run", join(HERE, file)], {
    cwd: HERE,
    env: spawnEnv(vars),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });

describe("public-network-profile.ts — the preflight, in a child process", () => {
  test.each(NETWORKS.filter((n) => !unpinned(n)))("%s: prints the resolved profile and the REDACTED Blockfrost endpoints, exits 0", (network) => {
    const result = run("public-network-profile.ts", complete(network));
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(0);
    expect(out).toContain(`[${network}] network            : ${network}`);
    expect(out).toContain(`[${network}] NTP anchor         : ${NTP_ANCHOR_MS[network]}`);
    expect(out).toContain(`[${network}] Celestia namespace : 6d6e2d737761702d7631 (MIP-0006 mn-swap-v1)`);
    expect(out).toContain(
      `[${network}] Midnight indexer   : https://midnight-${network}.blockfrost.io/api/v0?project_id=<redacted>`,
    );
    expect(out).toContain(
      `[${network}] Midnight indexer ws: wss://midnight-${network}.blockfrost.io/api/v0/ws?project_id=<redacted>`,
    );
    expect(out).toContain(`[${network}] Midnight node      : https://rpc.midnight-${network}.blockfrost.io?project_id=<redacted>`);
    expect(out).toContain(`[${network}] node configuration OK`);
    expect(out + err).not.toContain(TOKEN);
  });

  test("mainnet exits 78: supported, but its reference parameters are not pinned yet", () => {
    const result = run("public-network-profile.ts", complete("mainnet"));
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain('node configuration for MIDNIGHT_NETWORK_ID="mainnet" is invalid (1 problem)');
    expect(err).toContain(`MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ${NOT_PINNED}`);
    expect(result.stdout.toString()).not.toContain("node configuration OK");
    expect(result.stdout.toString() + err).not.toContain(TOKEN);
  });

  test("explicit token-bearing overrides with other parameters are redacted too", () => {
    const result = run("public-network-profile.ts", {
      ...complete("preprod"),
      MIDNIGHT_INDEXER_HTTP: `https://midnight-preprod.blockfrost.io/api/v0?x=1&project_id=${TOKEN}`,
      MIDNIGHT_INDEXER_WS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${TOKEN}&y=2`,
      MIDNIGHT_NODE_HTTP: `https://rpc.midnight-preprod.blockfrost.io/?project_id=${TOKEN}`,
    });
    const text = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, text).toBe(0);
    expect(text).toContain("api/v0?x=1&project_id=<redacted>");
    expect(text).toContain("api/v0/ws?project_id=<redacted>&y=2");
    expect(text).not.toContain(TOKEN);
  });

  test("a missing variable exits 78 naming it", () => {
    const env = complete("preprod");
    delete env["CELESTIA_START_HEIGHT"];
    const result = run("public-network-profile.ts", env);
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("CELESTIA_START_HEIGHT is required on preprod");
  });
});

describe("main.public.ts — the profile runs before env.ts and midnight-env", () => {
  test("stagenet exits 78 naming the four supported networks, before anything else loads", () => {
    const result = run("main.public.ts", complete("stagenet"));
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain('MIDNIGHT_NETWORK_ID="stagenet" is not supported (supported: undeployed, preview, preprod, mainnet)');
    expect(result.stdout.toString()).not.toContain("Starting ZSwap DA Node");
  });

  test("mainnet exits 78 before anything else loads: its reference parameters are not pinned yet", () => {
    const result = run("main.public.ts", complete("mainnet"));
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain(`MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ${NOT_PINNED}`);
    expect(err).not.toContain("is not supported");
    expect(result.stdout.toString()).not.toContain("Starting ZSwap DA Node");
    expect(result.stdout.toString() + err).not.toContain(TOKEN);
  });

  test("a public network with no token and no Celestia config exits 78 listing every problem", () => {
    // Had env.ts or midnight-env loaded first, midnight-env would have thrown
    // on the missing token alone (exit 1), naming nothing else.
    const result = run("main.public.ts", { MIDNIGHT_NETWORK_ID: "preprod" });
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain('node configuration for MIDNIGHT_NETWORK_ID="preprod" is invalid (4 problems)');
    for (const name of [
      "CELESTIA_START_HEIGHT is required on preprod",
      "CELESTIA_RPC_URL is required on preprod",
      "CELESTIA_AUTH_TOKEN is required on preprod",
      "MIDNIGHT_BLOCKFROST_PROJECT_ID is required on preprod",
    ]) {
      expect(err).toContain(name);
    }
  });

  test("a retired endpoint host exits 78 naming MIDNIGHT_BLOCKFROST_PROJECT_ID", () => {
    const result = run("main.public.ts", {
      ...complete("mainnet"),
      MIDNIGHT_INDEXER_HTTP: "https://indexer.mainnet.midnight.network/api/v4/graphql",
    });
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(78);
    expect(err).toContain("MIDNIGHT_INDEXER_HTTP points at indexer.mainnet.midnight.network");
    expect(err).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID");
  });
});

describe("installLogRedaction — every printed line goes through redactBlockfrostProjectId", () => {
  test("console methods, Error objects, nested objects and raw stream writes are redacted", () => {
    const script = [
      'const { installLogRedaction } = await import("@zswap-da/offer-guard/public-networks");',
      'const { redactBlockfrostProjectId } = await import("@effectstream/midnight-contracts/midnight-env");',
      "installLogRedaction(redactBlockfrostProjectId);",
      "installLogRedaction(redactBlockfrostProjectId); // twice: a no-op",
      `const T = ${JSON.stringify(TOKEN)};`,
      'console.log("plain https://midnight-preprod.blockfrost.io/api/v0?project_id=" + T);',
      'console.info("node", "https://rpc.midnight-mainnet.blockfrost.io?project_id=" + T);',
      'console.error(new Error("disconnected from wss://rpc.midnight-preprod.blockfrost.io?project_id=" + T));',
      'console.warn({ url: "https://midnight-preview.blockfrost.io/api/v0?a=1&project_id=" + T + "&b=2" });',
      'process.stdout.write("raw wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=" + T + "\\n");',
      'process.stderr.write(Buffer.from("buffer https://x.example?project_id=" + T + "\\n"));',
      'console.log("untouched line");',
    ].join("\n");
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: HERE,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = result.stdout.toString();
    const err = result.stderr.toString();
    expect(result.exitCode, err).toBe(0);
    expect(out + err).not.toContain(TOKEN);
    expect((out + err).match(/project_id=<redacted>/g)?.length).toBe(6);
    expect(out).toContain("plain https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>");
    expect(err).toContain("disconnected from wss://rpc.midnight-preprod.blockfrost.io?project_id=<redacted>");
    expect(err).toContain("a=1&project_id=<redacted>&b=2");
    expect(out).toContain("untouched line");
  });

  /** Runs `body` in a child process after installing the guard; the token is `T`. */
  const runGuarded = (body: string[], before: string[] = []) => {
    const script = [
      ...before,
      'const { installLogRedaction } = await import("@zswap-da/offer-guard/public-networks");',
      'const { redactBlockfrostProjectId } = await import("@effectstream/midnight-contracts/midnight-env");',
      "installLogRedaction(redactBlockfrostProjectId);",
      `const T = ${JSON.stringify(TOKEN)};`,
      ...body,
    ].join("\n");
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: HERE,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };

  test("an uncaught exception naming a token URL is reported redacted and ends the process with exit code 1", () => {
    const run = runGuarded([
      'setTimeout(() => { throw new Error("lost wss://rpc.midnight-preprod.blockfrost.io/?project_id=" + T); }, 0);',
      'await new Promise((resolve) => setTimeout(resolve, 200));',
      'console.log("still running");',
    ]);
    expect(run.exitCode, run.err).toBe(1);
    expect(run.out + run.err).not.toContain(TOKEN);
    expect(run.err).toContain("lost wss://rpc.midnight-preprod.blockfrost.io/?project_id=<redacted>");
    expect(run.out).not.toContain("still running");
  });

  test("an uncaught error whose stack lacks its message line is reported with the message, redacted", () => {
    // Bun sometimes builds `stack` as "Error\n    at …"; the report must still name the error.
    const run = runGuarded([
      'const error = new Error("lost wss://rpc.midnight-preprod.blockfrost.io/?project_id=" + T);',
      'error.stack = "Error\\n    at somewhere (file.ts:1:1)";',
      "throw error;",
    ]);
    expect(run.exitCode, run.err).toBe(1);
    expect(run.out + run.err).not.toContain(TOKEN);
    expect(run.err).toContain("Error: lost wss://rpc.midnight-preprod.blockfrost.io/?project_id=<redacted>");
  });

  test("a refused request at top level (Bun's fetch error holds the URL in `path`) is reported redacted, exit code 1", () => {
    // Port 1 is closed in every test environment: the request is refused at once.
    const run = runGuarded(['await fetch("http://127.0.0.1:1/api/v0?project_id=" + T);']);
    expect(run.exitCode, run.err).toBe(1);
    expect(run.out + run.err).not.toContain(TOKEN);
    expect(run.err).toContain("http://127.0.0.1:1/api/v0?project_id=<redacted>");
  });

  test("an unhandled rejection is reported redacted; the process keeps running and its exit code becomes 1", () => {
    const run = runGuarded([
      'Promise.reject(new Error("rejected https://midnight-preprod.blockfrost.io/api/v0?project_id=" + T));',
      'await new Promise((resolve) => setTimeout(resolve, 100));',
      'console.log("still running");',
    ]);
    expect(run.exitCode, run.err).toBe(1);
    expect(run.out + run.err).not.toContain(TOKEN);
    expect(run.err).toContain("rejected https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>");
    expect(run.out).toContain("still running");
  });

  test("a listener other code registered keeps its own behaviour, and what it prints is redacted", () => {
    // Registered before the guard, the way a dependency does at import time:
    // this one ignores rejections and lets uncaught exceptions pass.
    const run = runGuarded(
      [
        'Promise.reject(new Error("closed wss://rpc.midnight-preprod.blockfrost.io/?project_id=" + T));',
        'setTimeout(() => { throw new Error("thrown https://midnight-preprod.blockfrost.io/api/v0?project_id=" + T); }, 0);',
        'await new Promise((resolve) => setTimeout(resolve, 200));',
        'console.log("still running");',
      ],
      [
        'process.on("unhandledRejection", (reason) => console.log("ignored:", String(reason)));',
        'process.on("uncaughtException", (error) => console.log("passed:", String(error)));',
      ],
    );
    expect(run.exitCode, run.err).toBe(0);
    expect(run.out + run.err).not.toContain(TOKEN);
    expect(run.out).toContain("ignored: Error: closed wss://rpc.midnight-preprod.blockfrost.io/?project_id=<redacted>");
    expect(run.out).toContain("passed: Error: thrown https://midnight-preprod.blockfrost.io/api/v0?project_id=<redacted>");
    expect(run.out).toContain("still running");
  });
});
