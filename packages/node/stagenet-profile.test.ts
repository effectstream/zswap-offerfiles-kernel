import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";

import { ROOT_WINDOW_STAGENET_S } from "./network-windows.ts";
import {
  applyStagenetNodeProfile,
  describeStagenetNodeProfile,
  redactedOrigin,
  resolveStagenetNodeProfile,
  STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX,
  STAGENET_NTP_START_TIME_MS,
  StagenetConfigError,
} from "./stagenet-profile.ts";

// `fileURLToPath`, not `new URL(...).pathname`: one working tree of this repo
// lives under a path with a space in it.
const HERE = dirname(fileURLToPath(import.meta.url));

const complete = (): Record<string, string | undefined> => ({
  MIDNIGHT_NETWORK_ID: "stagenet",
  CELESTIA_START_HEIGHT: "9000000",
  CELESTIA_RPC_URL: "https://mocha.example.invalid:26658",
  CELESTIA_AUTH_TOKEN: "bearer-for-tests",
  PGLITE: "false",
});

describe("stagenet node profile — constants (00050 FR-001)", () => {
  test("NTP anchor is stagenet block 1 (2026-08-13T16:24:54Z)", () => {
    expect(STAGENET_NTP_START_TIME_MS).toBe(1786638294000);
    expect(new Date(STAGENET_NTP_START_TIME_MS).toISOString()).toBe("2026-08-13T16:24:54.000Z");
  });

  test("the local namespace copy IS the MIP-0006 shared namespace", () => {
    expect(STAGENET_CELESTIA_NAMESPACE_SUFFIX_HEX).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
  });
});

describe("stagenet node profile — resolution", () => {
  test("a complete env resolves with the stagenet defaults and no problems", () => {
    const profile = resolveStagenetNodeProfile(complete());
    expect(profile.problems).toEqual([]);
    expect(profile.warnings).toEqual([]);
    expect(profile.defaults).toEqual({
      NTP_START_TIME: "1786638294000",
      CELESTIA_NETWORK: "mocha",
    });
    expect(profile.resolved).toEqual({
      networkId: "stagenet",
      ntpStartTimeMs: 1786638294000,
      celestiaNetwork: "mocha",
      celestiaNamespace: MIP6_NAMESPACE_ID_SUFFIX_HEX,
      celestiaStartHeight: 9000000,
      celestiaAuth: "bearer-token",
      celestiaRpcOrigin: "https://mocha.example.invalid:26658",
      rootWindowSeconds: ROOT_WINDOW_STAGENET_S,
    });
  });

  test("the root window is stagenet's 14-day global_ttl unless ROOT_WINDOW_SECONDS overrides it", () => {
    expect(resolveStagenetNodeProfile(complete()).resolved.rootWindowSeconds).toBe(1_209_600);
    expect(
      resolveStagenetNodeProfile({ ...complete(), ROOT_WINDOW_SECONDS: "7200" }).resolved.rootWindowSeconds,
    ).toBe(7200);
  });

  test("every missing required variable is named, in one pass", () => {
    const profile = resolveStagenetNodeProfile({ MIDNIGHT_NETWORK_ID: "stagenet" });
    const text = profile.problems.join("\n");
    expect(profile.problems).toHaveLength(3);
    expect(text).toContain("CELESTIA_START_HEIGHT is required on stagenet");
    expect(text).toContain("CELESTIA_RPC_URL is required on stagenet");
    expect(text).toContain("CELESTIA_AUTH_TOKEN is required on stagenet");
  });

  test.each([
    ["CELESTIA_START_HEIGHT", "CELESTIA_START_HEIGHT is required"],
    ["CELESTIA_RPC_URL", "CELESTIA_RPC_URL is required"],
    ["CELESTIA_AUTH_TOKEN", "CELESTIA_AUTH_TOKEN is required"],
  ])("unset %s is refused by name", (name, message) => {
    const env = complete();
    delete env[name];
    const profile = resolveStagenetNodeProfile(env);
    expect(profile.problems).toHaveLength(1);
    expect(profile.problems[0]).toContain(message);
  });

  test.each(["", "   "])("a blank CELESTIA_START_HEIGHT (%j) counts as missing — no fallback to 1", (blank) => {
    const profile = resolveStagenetNodeProfile({ ...complete(), CELESTIA_START_HEIGHT: blank });
    expect(profile.problems[0]).toContain("CELESTIA_START_HEIGHT is required");
  });

  test.each(["0", "-5", "12abc", "1.5"])("CELESTIA_START_HEIGHT=%s is malformed", (value) => {
    const profile = resolveStagenetNodeProfile({ ...complete(), CELESTIA_START_HEIGHT: value });
    expect(profile.problems).toEqual([`CELESTIA_START_HEIGHT must be a positive integer, got "${value}"`]);
  });

  test("CELESTIA_AUTH_IN_URL=true satisfies the auth requirement for a credential-in-URL endpoint", () => {
    const env = { ...complete(), CELESTIA_AUTH_IN_URL: "true" };
    delete env["CELESTIA_AUTH_TOKEN"];
    const profile = resolveStagenetNodeProfile(env);
    expect(profile.problems).toEqual([]);
    expect(profile.resolved.celestiaAuth).toBe("in-url");
  });

  test("CELESTIA_AUTH_IN_URL=false does not", () => {
    const env = { ...complete(), CELESTIA_AUTH_IN_URL: "false" };
    delete env["CELESTIA_AUTH_TOKEN"];
    expect(resolveStagenetNodeProfile(env).problems[0]).toContain("CELESTIA_AUTH_TOKEN is required");
  });

  test("a network other than stagenet is refused", () => {
    const profile = resolveStagenetNodeProfile({ ...complete(), MIDNIGHT_NETWORK_ID: "preview" });
    expect(profile.problems).toEqual([
      'MIDNIGHT_NETWORK_ID must be "stagenet" for the stagenet profile, got "preview"',
    ]);
  });

  test("CELESTIA_NETWORK other than mocha is refused; mocha is accepted as is", () => {
    expect(resolveStagenetNodeProfile({ ...complete(), CELESTIA_NETWORK: "mainnet" }).problems[0]).toContain(
      'CELESTIA_NETWORK must be "mocha" on stagenet',
    );
    const mocha = resolveStagenetNodeProfile({ ...complete(), CELESTIA_NETWORK: "mocha" });
    expect(mocha.problems).toEqual([]);
    expect(mocha.defaults).not.toHaveProperty("CELESTIA_NETWORK");
  });

  test("an explicit NTP_START_TIME wins but is flagged; a malformed one is refused", () => {
    const override = resolveStagenetNodeProfile({ ...complete(), NTP_START_TIME: "1786638300000" });
    expect(override.problems).toEqual([]);
    expect(override.defaults).not.toHaveProperty("NTP_START_TIME");
    expect(override.resolved.ntpStartTimeMs).toBe(1786638300000);
    expect(override.warnings[0]).toContain("overrides the stagenet block-1 anchor");
    expect(resolveStagenetNodeProfile({ ...complete(), NTP_START_TIME: "soon" }).problems[0]).toContain(
      "NTP_START_TIME must be a millisecond timestamp",
    );
  });

  test("a blank CELESTIA_NAMESPACE is removed (so env.ts's MIP-0006 default applies), not kept as empty", () => {
    const profile = resolveStagenetNodeProfile({ ...complete(), CELESTIA_NAMESPACE: " " });
    expect(profile.unset).toEqual(["CELESTIA_NAMESPACE"]);
    expect(profile.resolved.celestiaNamespace).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
  });

  test("a namespace override is allowed but warned about", () => {
    const profile = resolveStagenetNodeProfile({ ...complete(), CELESTIA_NAMESPACE: "000000000000deadbeef" });
    expect(profile.problems).toEqual([]);
    expect(profile.resolved.celestiaNamespace).toBe("000000000000deadbeef");
    expect(profile.warnings[0]).toContain("overrides the MIP-0006 shared namespace");
  });

  test("the RPC credential never reaches the resolved profile or its description", () => {
    const env = {
      ...complete(),
      CELESTIA_RPC_URL: "https://user:pa55@abc.celestia-mocha.quiknode.pro/SECRET-TOKEN/?k=SECRET2",
    };
    const profile = resolveStagenetNodeProfile(env);
    const text = describeStagenetNodeProfile(profile).join("\n") + JSON.stringify(profile);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("pa55");
    expect(text).not.toContain("bearer-for-tests");
    expect(profile.resolved.celestiaRpcOrigin).toBe("https://abc.celestia-mocha.quiknode.pro");
  });

  test("PGLITE unset or true is a warning (external Postgres needs PGLITE=false), never a refusal", () => {
    for (const value of [undefined, "true", "1"]) {
      const profile = resolveStagenetNodeProfile({ ...complete(), PGLITE: value });
      expect(profile.problems).toEqual([]);
      expect(profile.warnings.join("\n")).toContain("set PGLITE=false for an external Postgres");
    }
    expect(resolveStagenetNodeProfile({ ...complete(), PGLITE: "false" }).warnings).toEqual([]);
  });

  test("redactedOrigin keeps only protocol, host and port", () => {
    expect(redactedOrigin("http://127.0.0.1:26658/x?y=1")).toBe("http://127.0.0.1:26658");
    expect(redactedOrigin(undefined)).toBeUndefined();
    expect(redactedOrigin("not a url")).toBe("<unparseable URL>");
  });
});

describe("stagenet node profile — application", () => {
  test("apply writes only the defaults and removes a blank namespace", () => {
    const env = { ...complete(), CELESTIA_NAMESPACE: "", BLOCK_TIME_MS: undefined };
    applyStagenetNodeProfile(env);
    expect(env["NTP_START_TIME"]).toBe("1786638294000");
    expect(env["CELESTIA_NETWORK"]).toBe("mocha");
    expect("CELESTIA_NAMESPACE" in env).toBe(false);
    // preview's NTP block time is env.ts's default; the profile does not set it.
    expect(env["BLOCK_TIME_MS"]).toBeUndefined();
  });

  test("apply refuses before changing anything", () => {
    const env: Record<string, string | undefined> = { MIDNIGHT_NETWORK_ID: "stagenet" };
    expect(() => applyStagenetNodeProfile(env)).toThrow(StagenetConfigError);
    expect(env).toEqual({ MIDNIGHT_NETWORK_ID: "stagenet" });
    try {
      applyStagenetNodeProfile(env);
    } catch (error) {
      expect((error as Error).message).toContain("node stagenet configuration is invalid (3 problems)");
    }
  });
});

describe("stagenet node profile — load order", () => {
  test("env.ts, loaded after the profile module, sees the stagenet values", () => {
    // A child process: env.ts evaluates its constants once per process, and this
    // test process may already have loaded it with other values. The script
    // imports the side-effect module first, exactly like main.stagenet.ts.
    const script = [
      `await import(${JSON.stringify(join(HERE, "stagenet-node-env.ts"))});`,
      `const env = await import(${JSON.stringify(join(HERE, "env.ts"))});`,
      "console.log('RESULT ' + JSON.stringify({",
      "  ntp: env.NTP_START_TIME, block: env.BLOCK_TIME_MS, celestia: env.CELESTIA_NETWORK,",
      "  ns: env.CELESTIA_NAMESPACE, root: env.ROOT_WINDOW_SECONDS, ttl: env.OFFER_TTL_SECONDS,",
      "  poll: env.CELESTIA_POLLING_INTERVAL_MS, net: env.MIDNIGHT_NETWORK_ID }));",
    ].join("\n");
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !/^(CELESTIA_|NTP_|BLOCK_TIME_MS|ROOT_WINDOW|OFFER_TTL|MIDNIGHT_)/.test(key)) {
        childEnv[key] = value;
      }
    }
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: HERE,
      env: { ...childEnv, ...(complete() as Record<string, string>), CELESTIA_NAMESPACE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = result.stdout.toString();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, out).toBeDefined();
    expect(JSON.parse(line!.slice("RESULT ".length))).toEqual({
      ntp: 1786638294000,
      block: 600000,
      celestia: "mocha",
      ns: MIP6_NAMESPACE_ID_SUFFIX_HEX,
      root: 1_209_600,
      ttl: 1_209_600,
      poll: 3000,
      net: "stagenet",
    });
    // The profile's own startup lines carry the "[stagenet]" label.
    expect(out).toContain("[stagenet] NTP anchor         : 1786638294000");
  });

  test("a missing required variable exits 78 naming it, before env.ts is read", () => {
    const script = `await import(${JSON.stringify(join(HERE, "stagenet-node-env.ts"))}); console.log("UNREACHABLE");`;
    const env = { ...(complete() as Record<string, string>) };
    delete env["CELESTIA_START_HEIGHT"];
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: HERE,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(78);
    expect(result.stderr.toString()).toContain("CELESTIA_START_HEIGHT is required on stagenet");
    expect(result.stdout.toString()).not.toContain("UNREACHABLE");
  });

  test("main.stagenet.ts imports the profile right after the onchain-runtime import", () => {
    const src = readFileSync(join(HERE, "main.stagenet.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s[^;]*?["']([^"']+)["'];?$/gms)].map((m) => m[1]);
    expect(imports[0]).toBe("@midnightntwrk/onchain-runtime-v4");
    expect(imports[1]).toBe("./stagenet-node-env.ts");
    expect(imports).toContain("./config.preview.ts");
    expect(imports.indexOf("./env.ts")).toBeGreaterThan(1);
  });
});
