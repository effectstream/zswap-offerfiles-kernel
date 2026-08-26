import { expect, test } from "bun:test";

import { closeTestPglite, type TestPgliteHandle } from "./test-pglite.ts";

test("PGlite teardown is ordered and idempotent", async () => {
  const events: string[] = [];
  const handle: TestPgliteHandle = {
    server: {
      listening: true,
      close(callback) {
        events.push("server");
        callback();
      },
    },
    db: {
      async close() { events.push("db"); },
    },
  };
  const client = {
    async end() { events.push("client"); },
  };

  const first = closeTestPglite(handle, client);
  const repeated = closeTestPglite(handle, client);
  expect(repeated).toBe(first);
  await Promise.all([first, repeated]);
  expect(events).toEqual(["client", "server", "db"]);
});

test("PGlite teardown attempts every stage before surfacing cleanup errors", async () => {
  const events: string[] = [];
  const handle: TestPgliteHandle = {
    server: {
      listening: true,
      close(callback) {
        events.push("server");
        callback(Object.assign(new Error("server close failed"), { code: "EIO" }));
      },
    },
    db: {
      async close() {
        events.push("db");
        throw new Error("database close failed");
      },
    },
  };
  const client = {
    async end() {
      events.push("client");
      throw new Error("client close failed");
    },
  };

  await expect(closeTestPglite(handle, client)).rejects.toBeInstanceOf(AggregateError);
  expect(events).toEqual(["client", "server", "db"]);
});
