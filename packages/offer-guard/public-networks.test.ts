import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  CELESTIA_NETWORK_FOR,
  isPublicMidnightNetwork,
  isSupportedMidnightNetwork,
  midnightEndpointProblems,
  probeMidnightIndexerAuth,
  PUBLIC_MIDNIGHT_NETWORKS,
  publicDevSeedProblem,
  referenceParametersProblem,
  retiredMidnightHost,
  SUPPORTED_MIDNIGHT_NETWORKS,
  unsupportedNetworkProblem,
} from "./public-networks.ts";
import { REFERENCE_PARAMETERS, UNPINNED_REFERENCE_PARAMETERS } from "@zswap-da/validator/reference-parameters";

const TOKEN = "preprodTestProjectId0000000000000";
// A test double standing in for midnight-env's redactBlockfrostProjectId (this
// package does not depend on midnight-contracts): it proves the probe passes
// every URL-bearing text through the redactor it is handed.
const redactBlockfrostProjectId = (text: string): string => text.replaceAll(TOKEN, "<redacted>");
const BLOCKFROST = {
  MIDNIGHT_INDEXER_HTTP: `https://midnight-preprod.blockfrost.io/api/v0?project_id=${TOKEN}`,
  MIDNIGHT_INDEXER_WS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${TOKEN}`,
  MIDNIGHT_NODE_HTTP: `https://rpc.midnight-preprod.blockfrost.io?project_id=${TOKEN}`,
};

describe("supported networks", () => {
  test("exactly undeployed, preview, preprod and mainnet; the public ones are the hosted three", () => {
    expect([...SUPPORTED_MIDNIGHT_NETWORKS]).toEqual(["undeployed", "preview", "preprod", "mainnet"]);
    expect([...PUBLIC_MIDNIGHT_NETWORKS]).toEqual(["preview", "preprod", "mainnet"]);
    for (const id of ["stagenet", "devnet", "qanet", "", "Preprod"]) {
      expect(isSupportedMidnightNetwork(id)).toBe(false);
      expect(isPublicMidnightNetwork(id)).toBe(false);
    }
    expect(isPublicMidnightNetwork("undeployed")).toBe(false);
  });

  test("an unsupported id is refused naming the four supported networks", () => {
    expect(unsupportedNetworkProblem("stagenet")).toBe(
      'MIDNIGHT_NETWORK_ID="stagenet" is not supported (supported: undeployed, preview, preprod, mainnet)',
    );
    expect(unsupportedNetworkProblem("")).toContain('"(unset)"');
  });

  test("Celestia: mocha for preview and preprod, mainnet for mainnet", () => {
    expect(CELESTIA_NETWORK_FOR).toEqual({ preview: "mocha", preprod: "mocha", mainnet: "mainnet" });
  });
});

describe("reference parameters per supported network", () => {
  test("every supported network is either pinned or listed as not pinned yet, with a reason", () => {
    for (const id of SUPPORTED_MIDNIGHT_NETWORKS) {
      const pinned = Object.hasOwn(REFERENCE_PARAMETERS, id);
      const unpinned = Object.hasOwn(UNPINNED_REFERENCE_PARAMETERS, id);
      expect({ id, pinnedXorUnpinned: pinned !== unpinned }).toEqual({ id, pinnedXorUnpinned: true });
    }
  });

  test("undeployed, preview and preprod are pinned: no problem", () => {
    for (const id of ["undeployed", "preview", "preprod"] as const) expect(referenceParametersProblem(id)).toBeUndefined();
  });

  test("mainnet is refused as not pinned yet, with the reason and the pinned list", () => {
    const problem = referenceParametersProblem("mainnet");
    expect(problem).toStartWith(
      'MIDNIGHT_NETWORK_ID="mainnet" is supported, but its ledger-9 reference parameters are not pinned yet, ' +
        "so the kernel does not start on it (pinned: undeployed, preview, preprod): ",
    );
    expect(problem).toContain("MidnightRuntimeApi_get_ledger_parameters");
    expect(problem).not.toContain("is not supported");
  });
});

describe("retired Midnight-hosted endpoints", () => {
  test.each([
    "https://indexer.preprod.midnight.network/api/v4/graphql",
    "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
    "https://rpc.preprod.midnight.network",
    "https://indexer.mainnet.midnight.network/api/v4/graphql",
    "https://RPC.MAINNET.MIDNIGHT.NETWORK:443/",
  ])("%s is retired", (url) => {
    expect(retiredMidnightHost(url)).toMatch(/^(indexer|rpc)\.(preprod|mainnet)\.midnight\.network$/);
  });

  test.each([
    "https://indexer.preview.midnight.network/api/v4/graphql",
    "https://rpc.preview.midnight.network",
    "https://midnight-preprod.blockfrost.io/api/v0?project_id=x",
    "https://rpc.midnight-mainnet.blockfrost.io",
    "https://preprod.midnight.network.example.com",
    "not a url",
  ])("%s is not", (url) => {
    expect(retiredMidnightHost(url)).toBeUndefined();
  });
});

describe("midnightEndpointProblems", () => {
  test("the Blockfrost defaults need the token; with it there is no problem", () => {
    for (const net of PUBLIC_MIDNIGHT_NETWORKS) {
      const problems = midnightEndpointProblems(net, {});
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith(`MIDNIGHT_BLOCKFROST_PROJECT_ID is required on ${net}`);
      expect(midnightEndpointProblems(net, { MIDNIGHT_BLOCKFROST_PROJECT_ID: TOKEN })).toEqual([]);
      expect(midnightEndpointProblems(net, { MIDNIGHT_BLOCKFROST_PROJECT_ID: "   " })).toHaveLength(1);
    }
  });

  test("all three overrides need no token; a partial override still does, naming what is defaulted", () => {
    expect(midnightEndpointProblems("preprod", BLOCKFROST)).toEqual([]);
    const { MIDNIGHT_INDEXER_WS: _ws, ...partial } = BLOCKFROST;
    const problems = midnightEndpointProblems("preprod", partial);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("(MIDNIGHT_INDEXER_WS not set)");
  });

  test.each([
    ["MIDNIGHT_INDEXER_HTTP", "https://indexer.preprod.midnight.network/api/v4/graphql"],
    ["MIDNIGHT_INDEXER_WS", "wss://indexer.mainnet.midnight.network/api/v4/graphql/ws"],
    ["MIDNIGHT_NODE_HTTP", "https://rpc.mainnet.midnight.network"],
  ])("an override %s on a retired host is refused naming MIDNIGHT_BLOCKFROST_PROJECT_ID", (name, url) => {
    for (const net of ["preprod", "mainnet"] as const) {
      const problems = midnightEndpointProblems(net, { ...BLOCKFROST, [name]: url });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toStartWith(`${name} points at `);
      expect(problems[0]).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID");
      expect(problems[0]).toContain("retired on 2026-10-09");
    }
  });

  test("preview's own Midnight-hosted endpoints are accepted as overrides", () => {
    expect(
      midnightEndpointProblems("preview", {
        MIDNIGHT_INDEXER_HTTP: "https://indexer.preview.midnight.network/api/v4/graphql",
        MIDNIGHT_INDEXER_WS: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
        MIDNIGHT_NODE_HTTP: "https://rpc.preview.midnight.network",
      }),
    ).toEqual([]);
  });

  test("an override of the wrong scheme is refused by name", () => {
    const problems = midnightEndpointProblems("mainnet", {
      ...BLOCKFROST,
      MIDNIGHT_INDEXER_WS: BLOCKFROST.MIDNIGHT_INDEXER_HTTP,
      MIDNIGHT_NODE_HTTP: "rpc.example",
    });
    expect(problems).toEqual([
      "MIDNIGHT_INDEXER_WS must be an absolute ws/wss URL",
      "MIDNIGHT_NODE_HTTP must be an absolute http/https URL",
    ]);
  });

  test("no problem quotes a URL or the token", () => {
    const problems = midnightEndpointProblems("preprod", {
      MIDNIGHT_INDEXER_HTTP: `https://indexer.preprod.midnight.network/api/v4/graphql?project_id=${TOKEN}`,
    });
    const text = problems.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("https://");
  });
});

describe("publicDevSeedProblem", () => {
  const DEV_SEEDS = [
    "0".repeat(63) + "1",
    "0".repeat(63) + "3",
    "0x" + "0".repeat(62) + "21",
    "0".repeat(62) + "ff", // any 31-zero-byte seed
  ];

  test("every repository dev seed is refused on preview, preprod and mainnet, naming the variable", () => {
    for (const net of PUBLIC_MIDNIGHT_NETWORKS) {
      for (const seed of DEV_SEEDS) {
        const problem = publicDevSeedProblem(net, "BATCHER_WALLET_SEED", seed);
        expect(problem).toStartWith("BATCHER_WALLET_SEED is a public dev seed");
        expect(problem).toContain(net);
        expect(problem).not.toContain(seed.replace(/^0x/, ""));
      }
    }
  });

  test("and on any other non-undeployed id", () => {
    expect(publicDevSeedProblem("stagenet", "POSTER_SEED", DEV_SEEDS[0])).toStartWith("POSTER_SEED is a public dev seed");
  });

  test("undeployed accepts them; a real or absent seed is never a problem", () => {
    for (const seed of DEV_SEEDS) expect(publicDevSeedProblem("undeployed", "BATCHER_WALLET_SEED", seed)).toBeUndefined();
    expect(publicDevSeedProblem("mainnet", "BATCHER_WALLET_SEED", "7f".repeat(32))).toBeUndefined();
    expect(publicDevSeedProblem("mainnet", "BATCHER_WALLET_SEED", undefined)).toBeUndefined();
  });
});

describe("probeMidnightIndexerAuth", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/mismatch") {
          return Response.json(
            { status_code: 403, error: "Forbidden", message: "Network token mismatch" },
            { status: 403 },
          );
        }
        if (path === "/missing") return Response.json({ message: "Missing project token" }, { status: 401 });
        if (path === "/down") return new Response("bad gateway", { status: 502 });
        return Response.json({ data: { block: { height: 7 } } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("a 403 (wrong-network token) is fatal, names the variable, and never shows the token", async () => {
    const result = await probeMidnightIndexerAuth("mainnet", `${base}/mismatch?project_id=${TOKEN}`, redactBlockfrostProjectId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fatal).toBe(true);
    expect(result.message).toContain("HTTP 403: Network token mismatch");
    expect(result.message).toContain("MIDNIGHT_BLOCKFROST_PROJECT_ID");
    expect(result.message).toContain("mainnet");
    expect(result.message).not.toContain(TOKEN);
  });

  test("a 401 is fatal too", async () => {
    const result = await probeMidnightIndexerAuth("preprod", `${base}/missing`, redactBlockfrostProjectId);
    expect(result).toMatchObject({ ok: false, fatal: true });
  });

  test("a working indexer, or any other status, passes (the sync handles it)", async () => {
    expect(await probeMidnightIndexerAuth("preprod", `${base}/ok?project_id=${TOKEN}`, redactBlockfrostProjectId)).toEqual({ ok: true });
    expect(await probeMidnightIndexerAuth("preprod", `${base}/down`, redactBlockfrostProjectId)).toEqual({ ok: true });
  });

  test("an unreachable indexer is a non-fatal warning that never shows the token", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    const result = await probeMidnightIndexerAuth(
      "preprod",
      `http://127.0.0.1:${port}/api/v0?project_id=${TOKEN}`,
      redactBlockfrostProjectId,
      { timeoutMs: 2_000 },
    );
    expect(result).toMatchObject({ ok: false, fatal: false });
    if (!result.ok) expect(result.message).not.toContain(TOKEN);
  });
});
