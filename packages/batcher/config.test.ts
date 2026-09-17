import { expect, test } from "bun:test";
import { MIP6_NAMESPACE_ID_SUFFIX_HEX } from "@zswap-da/offer-guard";

import { loadBatcherConfig } from "./config.ts";

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const optionalBatcherStrings = (value: string | undefined) => ({
  BATCHER_NODE_API_URL: value,
  BATCHER_STORAGE_DIR: value,
  CELESTIA_NETWORK: value,
  CELESTIA_RPC_URL: value,
  CELESTIA_NAMESPACE: value,
});

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["whitespace", " \t "],
])("batcher optional strings treat %s as unset", (_label, value) => {
  const config = withEnv(optionalBatcherStrings(value), loadBatcherConfig);
  expect(config.sponsorship.nodeApiUrl).toBe("http://127.0.0.1:9999");
  expect(config.storageDir).toEndWith("/packages/batcher/batcher-data");
  expect(config.celestia.network).toBe("devnet");
  expect(config.celestia.rpcUrl).toBe("http://127.0.0.1:26658");
  expect(config.celestia.namespace).toBe(MIP6_NAMESPACE_ID_SUFFIX_HEX);
});

test("batcher optional strings preserve trimmed custom values", () => {
  const config = withEnv(
    {
      BATCHER_NODE_API_URL: " http://kernel:9999/ ",
      BATCHER_STORAGE_DIR: " /tmp/custom-batcher ",
      CELESTIA_NETWORK: " mocha ",
      CELESTIA_RPC_URL: " http://celestia:26658/ ",
      CELESTIA_NAMESPACE: " abcdef ",
    },
    loadBatcherConfig,
  );
  expect(config.sponsorship.nodeApiUrl).toBe("http://kernel:9999/");
  expect(config.storageDir).toBe("/tmp/custom-batcher");
  expect(config.celestia.network).toBe("mocha");
  expect(config.celestia.rpcUrl).toBe("http://celestia:26658/");
  expect(config.celestia.namespace).toBe("abcdef");
});
