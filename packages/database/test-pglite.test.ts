import { expect, test } from "bun:test";

import { closeTestPglite, type TestPgliteHandle } from "./test-pglite.ts";

test("PGlite teardown delegates protocol draining to the owning handle", async () => {
  const events: string[] = [];
  let releaseDrain!: () => void;
  const drained = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const handle: TestPgliteHandle = {
    async close(options) {
      events.push(`handle:${options?.force === true ? "force" : "default"}`);
      await drained;
      events.push("drained");
    },
  };
  const client = {
    async end() { events.push("client"); },
  };

  const first = closeTestPglite(handle, client);
  const repeated = closeTestPglite(handle, client);
  let completed = false;
  void first.then(() => { completed = true; });
  expect(repeated).toBe(first);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["client", "handle:force"]);
  expect(completed).toBe(false);
  releaseDrain();
  await Promise.all([first, repeated]);
  expect(completed).toBe(true);
  expect(events).toEqual(["client", "handle:force", "drained"]);
});

test("PGlite teardown attempts every stage before surfacing cleanup errors", async () => {
  const events: string[] = [];
  const clientError = new Error("client close failed");
  const handleError = new Error("handle close failed");
  const handle: TestPgliteHandle = {
    async close(options) {
      events.push(`handle:${options?.force === true ? "force" : "default"}`);
      throw handleError;
    },
  };
  const client = {
    async end() {
      events.push("client");
      throw clientError;
    },
  };

  let caught: unknown;
  try {
    await closeTestPglite(handle, client);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([clientError, handleError]);
  expect(events).toEqual(["client", "handle:force"]);
});
